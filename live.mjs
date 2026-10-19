import { EventEmitter } from 'node:events';
import wrapAnsi from 'wrap-ansi';
import { parseCursorScreen } from './screen.mjs';
import { createModelCatalog } from './model-labels.mjs';

const userText = turn => (turn?.items || []).filter(item => item.type === 'userMessage')
  .flatMap(item => item.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');
const displayText = text => String(text || '').replace(/\s/gu, '');
const canonicalPrompt = text => String(text || '').replace(/\r\n/g, '\n').trim();
const sourceTurnComplete = (history, turn) => Boolean(history.sourceComplete
  || turn !== history.turns.at(-1) || history.completedTurnIds?.includes(turn.id));
const screenUser = screen => {
  const prompt = screen?.userMessages.at(-1);
  const count = screen?.userMessages.length || 0;
  return prompt ? { prompt, count, text: displayText(prompt), key: `${count}:${displayText(prompt)}` } : null;
};

const pastedText = /\[Pasted text #(\d+)(?: \+\d+(?: lines)?)?\]/gu;
function renderDraft(text, width) {
  if (!Number.isInteger(width) || width < 1) return null;
  // This is Cursor's Ink wrap branch: preserve hard-newline indentation, strip
  // ASCII spaces only from soft continuations, and wrap the inverse end caret.
  const wrapped = `${text}\x1b[7m \x1b[27m`.normalize().split('\n').flatMap(line =>
    wrapAnsi(line, width, { trim: false, hard: true }).split('\n').map((row, index) => index
      ? row.replace(/^((?:\x1b\[[\d;]*m| )*)/u, prefix => prefix.replace(/ /gu, '')) : row));
  let inverse = false;
  let caret = null;
  const rows = wrapped.map((line, row) => {
    let text = '';
    for (const token of line.matchAll(/\x1b\[[\d;]*m|[^\x1b]/gu)) {
      const value = token[0];
      if (value.startsWith('\x1b')) {
        for (const code of value.slice(2, -1).split(';').map(Number)) {
          if (code === 7) inverse = true;
          else if (code === 0 || code === 27) inverse = false;
        }
      } else {
        if (inverse) {
          if (caret) return null;
          caret = { row, offset: [...text].length };
        }
        text += value;
      }
    }
    return text;
  });
  return rows.includes(null) || !caret ? null : { rows, caret };
}

function matchesRenderedDraft(screen, text) {
  const actual = screen.inputDraft;
  const expected = actual && renderDraft(text, actual.width);
  if (!expected || !actual.caret || actual.rows.length !== expected.rows.length
    || actual.caret.row !== expected.caret.row || actual.caret.offset !== expected.caret.offset) return false;
  return actual.rows.every((row, index) => row.startsWith(expected.rows[index])
    && /^ *$/u.test(row.slice(expected.rows[index].length)));
}

function minimumInputColumns(text, width) {
  // Cursor folds pastes longer than 800 UTF-16 code units into a saved token.
  // Smaller pastes stay inline, in a viewport capped at six visual rows.
  if (text.length > 800) return undefined;
  if (!Number.isSafeInteger(width) || width < 1) throw new Error('The Cursor input width could not be verified; no text was pasted');
  if (renderDraft(text, width)?.rows.length <= 6) return undefined;
  if (text.split('\n').length > 6) {
    throw new Error('This inline Cursor message cannot fit its six visible input rows because it has more than six hard lines; no text was pasted');
  }
  for (let candidate = width + 1; candidate <= 1000; candidate++) {
    if (renderDraft(text, candidate)?.rows.length <= 6) return candidate + 7;
  }
  throw new Error('This Cursor message cannot fit within six visible input rows at the supported terminal width; no text was pasted');
}

function visibleDraft(screen) {
  const { rows, caret } = screen.inputDraft || {};
  // A bracketed paste ends with its caret after the inserted text. Cursor's
  // inverse caret distinguishes a trailing LF/space from the frame's padding.
  if (!Array.isArray(rows) || !rows.length || !caret || caret.row !== rows.length - 1
    || !Number.isInteger(caret.offset) || caret.offset < 0) return null;
  const last = [...rows.at(-1)];
  if (caret.offset >= last.length || last.slice(caret.offset).some(value => value !== ' ')) return null;
  return rows.map((row, index) => index === caret.row
    ? last.slice(0, caret.offset).join('') : row.replace(/ +$/u, '')).join('\n');
}

const sameIds = (left, right) => Array.isArray(left) && left.length === right.length
  && left.every((id, index) => typeof id === 'string' && id === right[index]);

/** Observes and submits to one existing Cursor TUI; never starts/kills an Agent. */
export class TmuxSession extends EventEmitter {
  constructor({ client, binding, model, models, modelDefinitions, history, interval = 180, log = () => {} }) {
    super();
    this.kind = 'tmux';
    this.client = client;
    this.binding = binding;
    this.modelCatalog = Array.isArray(models) ? createModelCatalog({ models, modelDefinitions }) : null;
    this.model = this.modelCatalog ? null : model;
    this.modelError = this.modelCatalog ? new Error('The current Cursor model has not been observed') : null;
    this.sessionId = binding.sessionId;
    this.interval = interval;
    this.log = log;
    this.state = 'new';
    this.knownSourceIds = new Set();
    this.history = history;
    this.pending = null;
    this.screen = null;
    this.timer = null;
    this.polling = null;
    this.screenKey = null;
    this.userKey = null;
    this.verified = true;
    this.verificationEpoch = 0;
    this.committing = false;
  }

  setVerified(verified) {
    if (typeof verified !== 'boolean') throw new TypeError('Cursor tmux verification must be a boolean');
    if (this.verified !== verified) this.verificationEpoch++;
    this.verified = verified;
  }

  assertVerified(epoch = this.verificationEpoch) {
    if (this.state !== 'ready') throw new Error('The original Cursor tmux pane is no longer attached');
    if (!this.verified || epoch !== this.verificationEpoch) throw new Error('The original Cursor tmux pane identity or foreground state is not verified');
  }

  // The bridge acknowledges this only after merging/persisting the canonical
  // source turn. A following CLI turn must not race that mutation.
  turnCommitted() {
    this.committing = false;
  }

  async start() {
    this.state = 'ready';
    if (this.history) for (const turn of this.history.turns) if (sourceTurnComplete(this.history, turn)) this.knownSourceIds.add(turn.id);
    await this.poll(true);
    this.schedule();
    return { sessionId: this.sessionId, ...(this.model && !this.modelError ? { models: { currentModelId: this.model } } : {}) };
  }

  schedule() {
    if (this.state !== 'ready') return;
    this.timer = setTimeout(() => {
      this.polling = this.poll().catch(error => this.detach(error)).finally(() => { this.polling = null; this.schedule(); });
    }, this.interval);
    this.timer.unref();
  }

  async poll(initial = false) {
    if (this.state !== 'ready' || !this.verified) return;
    const epoch = this.verificationEpoch;
    let raw;
    try { raw = await this.client.capture(this.binding.paneId); }
    catch (error) {
      if (!this.verified || epoch !== this.verificationEpoch) return;
      throw error;
    }
    if (this.state !== 'ready' || !this.verified || epoch !== this.verificationEpoch) return;
    const screen = parseCursorScreen(raw, { knownCursor: true });
    this.screen = screen;
    this.observeModel(screen);
    const user = screenUser(screen);
    const latestSource = this.history?.turns.at(-1);
    // A busy terminal can redraw an already completed question, including after
    // an idle frame or observer restart. Only an unfinished canonical source ID
    // establishes a new CLI turn. Waiting for its transcript also disambiguates
    // genuine repeated prompts without relying on scrollback or frame counts.
    if (!this.pending && !this.committing && user && screen.busy && latestSource
      && !sourceTurnComplete(this.history, latestSource) && !this.knownSourceIds.has(latestSource.id)
      && displayText(userText(latestSource)) === user.text) {
      const pending = this.begin('external', user.prompt, latestSource.id);
      this.emit('externalTurn', { prompt: user.prompt, sourceTurnId: latestSource.id, promise: pending.promise });
    }
    if (this.pending && !this.pending.user && user && user.text === displayText(this.pending.prompt)
      && (this.pending.origin === 'external' || user.key !== this.pending.baselineUser?.key)) this.pending.user = user;
    this.userKey = user?.key ?? null;
    const text = screen.currentReplyBody;
    if (this.pending?.user && user?.key === this.pending.user.key && text && text !== this.screenKey) {
      this.emit('update', { sessionUpdate: 'terminal_snapshot', text });
      this.screenKey = text;
    }
    if (this.history) this.acceptHistory(this.history);
  }

  begin(origin, prompt, sourceTurnId) {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    // External turns can begin before their bridge listener has acquired its lock.
    promise.catch(() => {});
    const baseline = new Set([...this.knownSourceIds, ...(this.history?.turns || []).map(turn => turn.id)]);
    if (origin === 'external') {
      const source = this.history?.turns.find(turn => turn.id === sourceTurnId);
      if (!source || displayText(userText(source)) !== displayText(prompt)) throw new Error('The external Cursor turn has no matching canonical source identity');
      baseline.delete(source.id);
    }
    const user = screenUser(this.screen);
    this.pending = { origin, prompt, sourceTurnId, baseline, promise, resolve, reject, baselineUser: user, user: origin === 'external' ? user : null };
    this.screenKey = null;
    return this.pending;
  }

  /** Reattach a separately validated persisted observer; never submit input. */
  resumeObserver(sourceTurnId, prompt) {
    if (this.pending || this.committing || !this.verified || !['new', 'ready'].includes(this.state)) throw new Error('The Cursor observer cannot be recovered in its current state');
    return this.begin('external', prompt, sourceTurnId);
  }

  draftEvidence() {
    const { sessionId, paneId, agentPid, agentStartTime } = this.binding;
    return { sessionId, paneId, agentPid, agentStartTime, model: this.model,
      sourceTurnIds: (this.history?.turns || []).map(turn => turn.id) };
  }

  assertRetryProof(retryDraft) {
    const proof = retryDraft?.proof;
    const current = this.draftEvidence();
    if (typeof retryDraft?.text !== 'string' || !retryDraft.text.trim() || proof?.version !== 1
      || typeof proof.turnId !== 'string' || !proof.turnId
      || ['sessionId', 'paneId', 'agentPid', 'agentStartTime', 'model'].some(key => proof[key] !== current[key])
      || !this.history || this.history.id !== this.sessionId || !sameIds(proof.sourceTurnIds, current.sourceTurnIds)) {
      throw new Error('The failed Cursor draft no longer belongs to the same verified session, model and source history');
    }
  }

  async matchesDraft(screen, expected) {
    if (!screen.inputAvailable || screen.inputEmpty) return false;
    const draft = visibleDraft(screen);
    if (draft === null) return false;
    const references = [...draft.matchAll(pastedText)];
    if (!references.length && !draft.includes('[Pasted text')) return matchesRenderedDraft(screen, expected);
    if (typeof this.client.readPastedTexts !== 'function') return false;
    const epoch = this.verificationEpoch;
    const store = await this.client.readPastedTexts(this.binding);
    this.assertVerified(epoch);
    if (!store?.entries || references.some(match => typeof store.entries[String(Number(match[1]))] !== 'string')) return false;
    // Cursor expands markers once at submission, including markers a person
    // typed literally. Never expand inserted values recursively or authorize a
    // token solely because its displayed number/line count looks plausible.
    const expanded = draft.replace(pastedText, (match, id) => store.entries[String(Number(id))]);
    if (references.length && expanded === expected && matchesRenderedDraft(screen, draft)) return true;
    // A token itself can soft-wrap. Reconstruct only Cursor's canonical token
    // spelling, backed by an exact saved value, then verify its complete frame.
    return Object.entries(store.entries).some(([id, text]) => /^[1-9]\d*$/u.test(id) && text === expected
      && matchesRenderedDraft(screen, `[Pasted text #${id} +${(text.match(/\n/gu)?.length || 0) + 1} lines]`));
  }

  async assertDraft(screen, expectedModel, retryDraft) {
    const epoch = this.verificationEpoch;
    this.observeModel(screen, true);
    this.assertRetryProof(retryDraft);
    this.requireModel(expectedModel);
    const matched = await this.matchesDraft(screen, retryDraft.text);
    this.assertVerified(epoch);
    this.assertRetryProof(retryDraft);
    if (!matched) throw new Error('The failed Cursor draft changed or its exact contents could not be verified; no Enter was sent');
  }

  async captureInputWidth(minimumColumns) {
    let reason;
    for (let attempt = 0; attempt < 50; attempt++) {
      this.assertVerified();
      const epoch = this.verificationEpoch;
      const screen = parseCursorScreen(await this.client.capture(this.binding.paneId), { knownCursor: true });
      this.assertVerified(epoch);
      if (minimumColumns === undefined || screen.inputAvailable && screen.inputWidth >= minimumColumns - 7) return screen;
      // resize-window returns before Cursor has redrawn its input. Wait for the
      // actual complete frame rather than pasting into a stale or partially
      // redrawn viewport. An overlay never authorizes input while we wait.
      reason = screen.reason;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error(`Cursor input width did not become verifiable after terminal resize (${reason}); no Enter was sent`);
  }

  async assertReady({ retryDraft, deferDraftCheck = false } = {}) {
    this.assertVerified();
    if (this.pending) throw new Error('The original Cursor Agent is already running a turn');
    if (this.committing) throw new Error('The previous Cursor turn is still being committed to Codex');
    const epoch = this.verificationEpoch;
    const screen = parseCursorScreen(await this.client.capture(this.binding.paneId), { knownCursor: true });
    this.assertVerified(epoch);
    this.screen = screen;
    if (retryDraft) {
      if (deferDraftCheck) {
        // A proven failed draft may be clipped until the transport expands its
        // viewport. Full content verification still runs immediately before Enter.
        this.observeModel(screen, true);
        this.assertRetryProof(retryDraft);
        this.requireModel(retryDraft.proof.model);
        if (!screen.inputAvailable || screen.inputEmpty) throw new Error('The failed Cursor draft is no longer available; no Enter was sent');
      } else await this.assertDraft(screen, retryDraft.proof?.model, retryDraft);
      return screen;
    }
    if (!screen.ready) throw new Error(`Original Cursor tmux input is unavailable (${screen.reason}); keep its draft or finish the current action in Cursor CLI`);
    this.observeModel(screen, true);
    return screen;
  }

  observeModel(screen, required = false) {
    if (!this.modelCatalog) return this.model;
    let model;
    try {
      if (!screen.inputAvailable || !screen.modelName) throw new Error('A complete idle Cursor model footer is unavailable');
      model = this.modelCatalog.infer(screen.modelName);
    } catch (error) {
      this.modelError = new Error(`The current Cursor CLI model cannot be verified: ${error.message}`);
      if (required) throw this.modelError;
      return null;
    }
    this.modelError = null;
    if (model !== this.model) {
      this.model = model;
      this.emit('model', model);
    }
    return model;
  }

  requireModel(model) {
    const requested = this.modelCatalog ? this.modelCatalog.resolve(model) : model;
    if (requested !== this.model) throw new Error(`The original Cursor CLI currently uses ${this.model}; change its model in Cursor CLI before selecting ${requested}`);
    return this.model;
  }

  async setModel(model) {
    if (this.modelCatalog) {
      this.assertVerified();
      const epoch = this.verificationEpoch;
      const screen = parseCursorScreen(await this.client.capture(this.binding.paneId), { knownCursor: true });
      this.assertVerified(epoch);
      this.screen = screen;
      this.observeModel(screen, true);
    }
    this.requireModel(model);
    return { currentModelId: this.model };
  }

  async prompt(blocks, { model, retryDraft } = {}) {
    if (!Array.isArray(blocks) || !blocks.length || blocks.some(block => block.type !== 'text' || typeof block.text !== 'string')) {
      throw new Error('A shared Cursor tmux session currently accepts text messages only');
    }
    const prompt = blocks.map(block => block.text).join('\n');
    if (!prompt.trim()) throw new Error('Message is empty');
    if (retryDraft && retryDraft.text !== prompt) throw new Error('Only the exact failed Cursor message may submit its existing draft');
    try { await this.assertReady({ retryDraft, deferDraftCheck: Boolean(retryDraft) }); }
    catch (error) {
      if (retryDraft?.proof) {
        const { sessionId, paneId, agentPid, agentStartTime, model, sourceTurnIds } = retryDraft.proof;
        error.unsubmittedDraft = { sessionId, paneId, agentPid, agentStartTime, model, sourceTurnIds };
      }
      throw error;
    }
    if (model !== undefined) this.requireModel(model);
    const minimumColumns = minimumInputColumns(prompt, this.screen.inputWidth);
    const expectedModel = this.model;
    const evidence = this.draftEvidence();
    const pending = this.begin('native', prompt);
    try {
      let submitted;
      if (retryDraft) {
        submitted = await this.client.submitDraft(this.binding.paneId, {
          sessionId: this.sessionId,
          minimumColumns,
          beforeSubmit: async () => {
            try {
              const screen = await this.captureInputWidth(minimumColumns);
              await this.assertDraft(screen, expectedModel, retryDraft);
            } catch (error) {
              // This callback runs before transport's sole Enter operation.
              error.unsubmittedDraft = evidence;
              throw error;
            }
          },
        });
      } else submitted = await this.client.paste(this.binding.paneId, prompt, {
        sessionId: this.sessionId,
        minimumColumns,
        beforePaste: async () => {
          const screen = await this.captureInputWidth(minimumColumns);
          if (!screen.ready) throw new Error(`Cursor input changed before paste (${screen.reason}); no message was pasted`);
          this.observeModel(screen, true);
          this.requireModel(expectedModel);
        },
        afterPaste: async () => {
          // Give the TUI a render opportunity before deciding whether Enter can
          // submit exactly this text. Never clear a person's concurrent input.
          try {
            let lastError;
            for (let attempt = 0; attempt < 10; attempt++) {
              this.assertVerified();
              const epoch = this.verificationEpoch;
              const screen = parseCursorScreen(await this.client.capture(this.binding.paneId), { knownCursor: true });
              this.assertVerified(epoch);
              let matched = false;
              try { matched = await this.matchesDraft(screen, prompt); }
              catch (error) { lastError = error; }
              if (matched) {
                this.observeModel(screen, true);
                this.requireModel(expectedModel);
                return;
              }
              await new Promise(resolve => setTimeout(resolve, 40));
            }
            throw new Error('Cursor input changed or could not be verified after paste; text remains as an unsubmitted draft in tmux. Review it in Cursor CLI', lastError ? { cause: lastError } : undefined);
          } catch (error) {
            error.unsubmittedDraft = evidence;
            throw error;
          }
        },
      });
      if (submitted?.viewportRestoreError) {
        // Enter already succeeded. A restore conflict must not turn a delivered
        // message into a failed send that the caller might duplicate by retrying.
        try { this.log(`Cursor message submitted; terminal viewport restoration needs attention: ${submitted.viewportRestoreError}`); } catch { /* Logging cannot undo a send. */ }
      }
      return await pending.promise;
    } catch (error) {
      if (error.viewportRestoreError) {
        try { this.log(`Cursor message was not submitted; terminal viewport restoration needs attention: ${error.viewportRestoreError}`); } catch { /* Keep the original send error and retry evidence. */ }
      }
      if (this.pending === pending) { this.pending = null; pending.reject(error); }
      throw error;
    }
  }

  acceptHistory(history) {
    if (history.id !== this.sessionId) return;
    this.history = history;
    const pending = this.pending;
    if (pending) {
      const candidates = history.turns.filter(turn => !pending.baseline.has(turn.id));
      const sourceTurn = candidates.find(turn => pending.origin === 'external'
        ? turn.id === pending.sourceTurnId && displayText(userText(turn)) === displayText(pending.prompt)
        : canonicalPrompt(userText(turn)) === canonicalPrompt(pending.prompt));
      const completed = sourceTurn && sourceTurnComplete(history, sourceTurn);
      if (completed) {
        this.pending = null;
        this.committing = true;
        pending.resolve({ stopReason: sourceTurn.status === 'failed' ? 'failed' : sourceTurn.status === 'interrupted' ? 'cancelled' : 'end_turn', history, sourceTurn, origin: pending.origin });
      }
    }
    for (const turn of history.turns) if (sourceTurnComplete(history, turn)) this.knownSourceIds.add(turn.id);
  }

  async cancel() {
    if (!this.pending) return;
    this.assertVerified();
    const epoch = this.verificationEpoch;
    const screen = parseCursorScreen(await this.client.capture(this.binding.paneId), { knownCursor: true });
    this.assertVerified(epoch);
    if (!screen.busy || !['C-c', 'Escape'].includes(screen.stopKey)) throw new Error('Cursor is waiting for input or its stop key is unrecognized; handle its current prompt in the original tmux pane');
    await this.client.cancel(this.binding.paneId, { sessionId: this.sessionId, key: screen.stopKey });
  }

  detach(error = new Error('The original Cursor tmux pane closed or changed')) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    clearTimeout(this.timer);
    const pending = this.pending;
    this.pending = null;
    pending?.reject(error);
    this.emit('exit');
  }

  async close() {
    // Closing a UI connection or the bridge must leave the real TUI task alive.
    this.detach(new Error('Cursor tmux observer detached; the original Agent keeps running in tmux'));
    await this.polling;
  }
}
