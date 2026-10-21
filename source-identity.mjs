import { createHash } from 'node:crypto';

export const SOURCE_IDENTITY_SCHEME = 'cursor-envelope-v1';

/** Cursor's JSONL export collapses runs of empty lines; input bytes stay intact. */
export const cursorExportUserText = text => String(text || '').replace(/\r\n/gu, '\n')
  .replace(/\n{3,}/gu, '\n\n').trim();

function withoutAttachedSkills(text) {
  const attachment = text.match(/^\s*<manually_attached_skills>([\s\S]*?)<\/manually_attached_skills>\s*([\s\S]*)$/u);
  if (!attachment) return text;
  const intro = /^\s*The user has manually attached the following skills to their message\.\r?\nThese skills contain specific instructions or workflows that the user wants you to follow for this request\.\r?\nOnly read the files if needed, the full skill content is inlined here\.\s*\r?\nSkill Name: [^\r\n]+\r?\nPath: [^\r\n]+SKILL\.md\r?\nSKILL\.md content:\r?\n\S[\s\S]*$/u;
  return intro.test(attachment[1]) ? attachment[2] : text;
}

/** Preserve literal tag text; only a whole CLI envelope has display wrappers. */
export function unwrapUserEnvelope(text) {
  if (typeof text !== 'string') return text;
  const query = withoutAttachedSkills(text).match(/^\s*(?:<timestamp>[^<>]*<\/timestamp>\s*)?<user_query>([\s\S]*)<\/user_query>\s*$/u);
  return query ? query[1].trim() : text;
}

/** Parse the complete CLI envelope before display text loses its timestamp. */
export function timestampedUserEnvelope(text, sessionId) {
  if (typeof text !== 'string' || typeof sessionId !== 'string' || !sessionId) return null;
  const match = withoutAttachedSkills(text).match(/^\s*<timestamp>([^<>\r\n]+)<\/timestamp>\s*<user_query>([\s\S]*)<\/user_query>\s*$/u);
  if (!match || match[1].length > 160) return null;
  const [, timestamp, query] = match;
  // V8 can treat '(UTC)' as a comment and interpret the remaining clock in the
  // machine's local timezone. Make the CLI's explicit UTC designation effective.
  const timestampMs = Date.parse(timestamp.trim().replace(/\s*\(UTC\)$/u, ' UTC'));
  if (!Number.isFinite(timestampMs)) return null;
  const sha256 = createHash('sha256').update(JSON.stringify([sessionId, timestamp, query])).digest('hex');
  return { timestamp, query, sha256, timestampMinute: Math.floor(timestampMs / 60_000) * 60_000 };
}

const outerTag = /<\/?(?:available_subagent_types|available_subagent_models|dynamic_tool_catalog)\b/u;
const humanTag = /<\/?(?:timestamp|user_query)\b/iu;

function completeNamespaces(text) {
  const entry = /<namespace((?:\s+[A-Za-z][A-Za-z0-9]*="[^"]*")+)\s*\/>/yu;
  const names = new Set();
  let offset = 0;
  let count = 0;
  while (offset < text.length) {
    offset += text.slice(offset).match(/^\s*/u)[0].length;
    if (offset === text.length) break;
    entry.lastIndex = offset;
    const match = entry.exec(text);
    if (!match) return false;
    const attributes = [...match[1].matchAll(/\s+([A-Za-z][A-Za-z0-9]*)="([^"]*)"/gu)];
    const values = Object.fromEntries(attributes.map(([, key, value]) => [key, value]));
    const keys = ['name', 'tools', 'namespaceUseInstructions', 'source'];
    if (attributes.length !== keys.length || Object.keys(values).length !== keys.length
      || !keys.every(key => typeof values[key] === 'string' && values[key].trim())
      || !/^[A-Za-z][\w.-]*$/u.test(values.name) || !/^[A-Za-z][\w.-]*$/u.test(values.source)
      || /[<>\r\n]/u.test(values.tools) || names.has(values.name)) return false;
    names.add(values.name);
    count++;
    offset = entry.lastIndex;
  }
  return count > 0;
}

/**
 * Recognize only the complete CLI runtime catalog, never a mention, an excerpt,
 * a human envelope containing the same text, or an unknown context format.
 * These bodies contain prose and pseudo-tags, so they are not XML documents.
 */
export function isRuntimeContext(text) {
  if (typeof text !== 'string' || humanTag.test(text)) return false;
  const match = text.match(/^\s*<available_subagent_types>([\s\S]*?)<\/available_subagent_types>\s*<available_subagent_models>([\s\S]*?)<\/available_subagent_models>\s*<dynamic_tool_catalog>([\s\S]*?)<\/dynamic_tool_catalog>\s*$/u);
  if (!match) return false;
  const [, types, models, tools] = match;
  if ([types, models, tools].some(body => !body.trim() || outerTag.test(body))) return false;
  const namespaces = tools.match(/^\s*These dynamic tool namespaces were available when this conversation started\. Availability may have changed, so use `GetDynamicTools` to check current state before calling `CallDynamicTool`\.\s*<dynamic_tool_namespaces>([\s\S]+)<\/dynamic_tool_namespaces>\s*$/u);
  return /^\s*Available subagent_types and a quick description of what they do:\s*\n- [A-Za-z][\w.-]*: \S/u.test(types)
    && /^\s*If the user explicitly asks for the model of a subagent\/task, you may ONLY use model slugs from this list:\s*\n- [A-Za-z][\w.-]*/u.test(models)
    && Boolean(namespaces) && completeNamespaces(namespaces[1]);
}
