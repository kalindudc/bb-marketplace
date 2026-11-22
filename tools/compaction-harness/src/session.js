// Read a pi session JSONL into normalized rows. Read-only on the input file.
// Line shapes observed on this machine (session version 3):
//   {type:'session', version, id, timestamp, cwd}
//   {type:'model_change', id, parentId, timestamp, provider, modelId}
//   {type:'thinking_level_change', id, parentId, timestamp, thinkingLevel}
//   {type:'message', id, parentId, timestamp, message:{role, content:[...], ...}}
// Unknown row types, roles and content block types are skipped, never fatal.
import { readFile } from 'node:fs/promises';

export async function readSession(path) {
  const raw = await readFile(path, 'utf8');
  return parseSession(raw);
}

export function parseSession(raw) {
  const lines = raw.split('\n');
  const rows = [];
  let session = null;
  let index = 0;
  for (const line of lines) {
    index += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // tolerate trailing garbage / partial writes
    }
    if (obj?.type === 'session') {
      session = { id: obj.id ?? null, cwd: obj.cwd ?? null, timestamp: obj.timestamp ?? null };
    }
    if (obj?.type !== 'message') continue;
    const m = obj.message;
    if (!m || typeof m !== 'object') continue;
    const role = m.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'toolResult' && role !== 'system') continue;
    const content = Array.isArray(m.content) ? m.content : typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : [];
    rows.push({
      index,
      id: obj.id ?? null,
      timestamp: obj.timestamp ?? null,
      role,
      toolName: role === 'toolResult' ? (m.toolName ?? null) : null,
      isError: role === 'toolResult' ? m.isError === true : false,
      toolCallId: role === 'toolResult' ? (m.toolCallId ?? null) : null,
      content: content.filter((b) => b && typeof b === 'object'),
    });
  }
  return { session, messages: rows };
}

// Concatenate all text blocks of a row's content, skipping thinking/tool blocks.
export function rowText(row) {
  return (row.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

export function rowToolCalls(row) {
  return (row.content ?? []).filter((b) => b.type === 'toolCall');
}