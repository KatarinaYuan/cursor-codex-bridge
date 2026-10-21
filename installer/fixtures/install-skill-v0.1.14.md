---
name: install-cursor-codex-bridge
description: Install, diagnose, upgrade, or uninstall Cursor Codex Bridge over an existing SSH alias so Codex desktop chats use a remote Cursor Agent.
---

# Install Cursor Codex Bridge

Use the project's CLI to manage the bridge from the laptop. This is an experimental protocol bridge, not an official Codex or Cursor integration. It requires an existing working SSH alias and a Linux glibc x64/arm64 host with Python 3.8+, bash, and Cursor Agent already logged in. The installer reuses remote Node.js 22+ and genuine Codex CLI or downloads pinned, checksum-verified private runtimes when absent; it does not use sudo or install global npm packages. The laptop needs Node.js 22+ with npm, Git, OpenSSH, tar, and Codex desktop.

## Workflow

1. Reuse the user's specified checkout and SSH alias. If the alias is missing, inspect available SSH host names without exposing identities or credentials, and ask the user to choose when necessary. Do not guess a host from unrelated context.
2. Check laptop Node.js 22+ and npm. If unavailable, discover the native Codex `load_workspace_dependencies` tool and use its bundled Node/npm when provided. Add that runtime directory to `PATH` only for the current command; do not modify shell profiles. If neither a suitable system runtime nor a bundled Node/npm is available, report the specific prerequisite and ask the user to install Node.js 22+ with npm. Do not claim the bridge is dependency-free on arbitrary laptops.
3. Prefer the pinned GitHub Release package below when no checkout was requested. Use the same `npx` prefix for `install`, then `doctor`, replacing `ALIAS` with the user's SSH alias. Alternatively, clone `https://github.com/KatarinaYuan/cursor-codex-bridge.git`, check out `v0.1.14`, run `npm ci --ignore-scripts`, then use `node cli.mjs`. Read the README and CLI `--help` for version-specific options. Reuse an existing checkout only when its origin matches this project; do not discard local edits.
4. Add `--alias BRIDGE_ALIAS` only when the user specified a bridge name or a collision needs resolving; pass that same option to every later management command. Remote binary overrides (`--node-path`, `--agent-path`, `--codex-path`) must be remote absolute paths.
5. Report the actual diagnostic result and generated bridge alias. Direct the user to enable that alias in Codex App SSH settings if the CLI requires it. Do not claim an end-to-end chat works solely because installation passed.

```sh
npx --yes --package=https://github.com/KatarinaYuan/cursor-codex-bridge/releases/download/v0.1.14/cursor-codex-bridge-0.1.14.tgz cursor-codex install --ssh ALIAS
npx --yes --package=https://github.com/KatarinaYuan/cursor-codex-bridge/releases/download/v0.1.14/cursor-codex-bridge-0.1.14.tgz cursor-codex doctor --ssh ALIAS
```

An explicit installation request authorizes the installer changes described by the CLI; do not add another approval step for those routine changes. It tests `CODEX_HOME` forwarding, then `LC_CURSOR_CODEX_BRIDGE`; a server rejecting both may need the user's administrator. Report that concrete blocker instead of changing the server's SSH policy.

## Other operations

- Diagnose: use the same `npx` prefix with `cursor-codex doctor --ssh ALIAS` (`--json` for structured results), or `node cli.mjs doctor` in a checkout. This is read-only and does not send model messages.
- Upgrade: use the pinned `v0.1.14` commands below, or its clean checkout with `node cli.mjs`. The command deploys the calling version; it does not fetch the latest release itself. Reuse any custom `--alias BRIDGE_ALIAS` for both commands. Preserve local edits and existing user settings. This release can retire a narrowly proven stale observation after its source envelope became duplicated and a later stable request proves the completed prefix; see the ownership constraints below. It preserves the original Cursor process, model and draft, and sends no model request. An already open App chat may retain cached state or turn order after reconnecting; verify its refreshed display before claiming success. The installer still refuses busy upgrades.
- Update the laptop skill: run `cursor-codex install-skill` using the pinned release package. Matching content is unchanged. Unmodified official `v0.1.1`, `v0.1.2`, `v0.1.3`, `v0.1.4`, `v0.1.5`, `v0.1.6`, `v0.1.7`, `v0.1.8`, `v0.1.9`, `v0.1.10`, `v0.1.11`, or `v0.1.12` skills are recognized by both shipped file hashes, backed up, and atomically replaced; report the returned backup path. Custom content, extra files, or symlinks are rejected and preserved. Do not delete the old skill to bypass that check. `upgrade` alone does not update the laptop skill.
- Uninstall: run `cursor-codex uninstall --ssh ALIAS` with the same `npx` prefix, or `node cli.mjs uninstall` in a checkout. Preserve the retained bridge records, original Cursor history, and shared private runtimes. Deleting those data requires a separate explicit request. Existing manual bridge deployments are not adopted or migrated by this installer.

```sh
npx --yes --package=https://github.com/KatarinaYuan/cursor-codex-bridge/releases/download/v0.1.14/cursor-codex-bridge-0.1.14.tgz cursor-codex upgrade --ssh ALIAS
npx --yes --package=https://github.com/KatarinaYuan/cursor-codex-bridge/releases/download/v0.1.14/cursor-codex-bridge-0.1.14.tgz cursor-codex doctor --ssh ALIAS
npx --yes --package=https://github.com/KatarinaYuan/cursor-codex-bridge/releases/download/v0.1.14/cursor-codex-bridge-0.1.14.tgz cursor-codex install-skill
```

Use the installer for owned SSH/profile blocks and remote files. Do not duplicate its work by manually appending shell snippets, replacing global Codex binaries, modifying `sshd_config`, or installing global hooks. Do not bundle or copy accounts and credentials.

Do not send test messages to existing chats or tmux sessions. Do not clear drafts or press Enter to resolve a failed paste. When busy or when input cannot be verified, stop the dependent mutation and report the CLI's concrete reason; inspect read-only diagnostics and `docs/troubleshooting.md`. A new isolated model test requires the user's authorization because it creates messages and may incur cost.

A paste verification failure does not itself prove an SSH disconnect. Short mixed-width messages can require more input rows than terminal display-width wrapping predicts; upgrade the bridge rather than merging lines or bypassing verification. Existing failed drafts must retain their original text and recovery evidence. Do not auto-submit or paste over them.

An App edit-and-resend may upload the same attachment under a new UUID path and therefore fail exact draft matching. With an existing strict failed-draft proof, the bridge may normalize only the official single-attachment wrapper back to its verified path after checking every other input byte and both regular, non-symlink files byte for byte. Business text and leading/trailing newlines must remain exact. Missing proof, multiple attachments, changed content or other text changes remain blocked. Do not manually replace paths, paste over drafts or auto-submit old messages to work around this refusal.

A recognized dim `No matches` slash popup may temporarily cover the model footer when the read-only multiline scan crosses an attachment path. Continue only through the bridge's exact scoped recognition; do not dismiss a menu with Escape or edit terminal bytes to bypass verification. Before marker removal or submission, the bridge must return to the end of the draft with the full original model footer visible. Unknown or persistent menus leave the draft unsubmitted. Diagnostics expose bounded verification metadata; keep the draft, source and recovery proof intact.

A delayed slash-menu render may still show the exact previous scan viewport after a cursor move. The bridge may wait using bounded captures only; it must observe the exact current expected position before proceeding. Do not add cursor tolerance, send extra movement keys, or bypass a mismatch. Other viewport changes or a timeout must preserve the draft and refuse submission.

Multiline verification temporarily locks the target pane input and restores it when finished, with a watchdog limit of 300 seconds. Existing input locks or `pipe-pane` are preserved and cause refusal. Failed verification leaves an unsubmitted draft; an uncertain submission acknowledgement must not trigger an automatic resend. Do not bypass these checks or restart the user's Agent to release a lock.

After a submitted request is matched to one fixed source turn, verification recovery permits retrying only that binding persistence in the current verification epoch and original session/process/model context. Keep retries single-flight with backoff. An uncertain acknowledgement must never become a new paste or model request.

Stable source identity does not rewrite Cursor transcripts or authorize a model request. Preserve native chat, turn, and message IDs through existing mappings. Legacy transcripts without complete envelopes cannot establish new stable submission recovery proofs; duplicated envelopes cannot prove native submission ownership.

For stuck thinking, `v0.1.14` retains the completed-source, fresh-idle-screen recovery for proven legacy `v1` external observers. It also permits valid `v1`/`v2` observations to retire when the old stable envelope became ambiguous, every affected prefix entry is explicitly completed, and a unique latest stable envelope has a strictly later timestamp. Require the original session/process/cwd binding and a fresh capture matching that latest request in supported busy state or the exact recognized `Clarifying Questions` overlay; an idle capture additionally requires a completed source. Native `v2` proofs must retain their original client ID, model, input digests and exact source-user mapping. Keep the old native preview interrupted with its receipt and import canonical completed replies separately; never import an unfinished successor as completed or reassign ambiguous ownership. Durable retirement receipts prevent later history scans and same-client retries from resubmitting the old request. Question recognition grants observation only, never typing, answering or dismissing it. The check retries periodically and after restart without input or model actions. Missing evidence remains blocked. Do not manually edit records or restart the Agent.

A temporary ASCII verification marker is removed before submission. A diagnostic draft may retain that marker if verification failed; never submit it manually. An explicit retry can recover only an acknowledged marker with matching process, model, source history and fully verified draft; the proven single-attachment path normalization above is the only permitted difference from the original retry text. Unknown marker delivery or deletion must not be retried automatically.

For a failed command, diagnose the actual output; do not loop installation or restart user Agent processes. Keep logs and issue reports free of chat contents, private keys, tokens, and personal host details.
