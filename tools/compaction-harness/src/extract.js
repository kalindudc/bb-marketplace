// extract: mechanical state block, contract-v1 ledger.json `state` shape.
// Deterministic rules only, no model. Unknown tool names / block types skipped.
import { createHash } from 'node:crypto';
import { rowText, rowToolCalls } from './session.js';

const FILE_ARG = ['path', 'file', 'filePath', 'filename', 'target'];
const CMD_ARG = ['command', 'cmd', 'script'];

const inList = (v, list) => typeof v === 'string' && list.includes(v);

// sha256 of content found in a tool result, when the result text embeds it.
function contentHashes(text) {
  const out = [];
  let m;
  // explicit sha256:<64 hex> anywhere in the result text
  const tagged = /sha256:([0-9a-f]{64})/g;
  while ((m = tagged.exec(text)) !== null) out.push(`sha256:${m[1]}`);
  // bare hex words of exactly 64 chars
  if (out.length === 0) {
    const bare = /(^|\s)([0-9a-f]{64})(\s|$)/g;
    while ((m = bare.exec(text)) !== null) out.push(`sha256:${m[2]}`);
  }
  return out;
}

function firstString(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

const lastOf = (arr, n) => arr.slice(-n);

export function extractState(session) {
  const rows = session.messages;
  const filesRead = [];
  const filesWritten = [];
  const commands = [];
  const failingTests = [];
  const branch = { branch: null, head: null };
  const toolCallsById = new Map();
  const commandsByResultId = new Map();

  for (const row of rows) {
    for (const call of rowToolCalls(row)) toolCallsById.set(call.id, call);
    if (row.role === 'toolResult' && row.toolName === 'bash' && row.toolCallId) {
      const call = toolCallsById.get(row.toolCallId);
      if (call) commandsByResultId.set(row.id, call.arguments?.command ?? null);
    }
  }

  for (const row of rows) {
    const text = rowText(row);

    if (row.role === 'user') {
      // constraint-looking statements captured verbatim later; here we only
      // keep the row index for the constraint pass (see extractFull).
      continue;
    }

    if (row.role === 'assistant') {
      for (const call of rowToolCalls(row)) {
        const args = call.arguments ?? {};
        const path = firstString(args, FILE_ARG);
        const cmd = firstString(args, CMD_ARG);
        if (path && inList(call.name, ['read', 'glob', 'grep', 'find', 'ast_query', 'web_fetch'])) {
          filesRead.push({ path, at: row.timestamp });
        } else if (path && inList(call.name, ['edit', 'write', 'multiedit'])) {
          filesWritten.push({ path, at: row.timestamp });
        } else if (cmd && call.name === 'bash') {
          commands.push({ cmd, exit: null, at: row.timestamp, resultRow: null });
        }
      }
    }

    if (row.role === 'toolResult') {
      // command exit codes: link bash result to its call
      if (row.toolName === 'bash') {
        const cmd = commandsByResultId.get(row.id);
        const pending = lastOf(commands.filter((c) => c.cmd === cmd && c.resultRow === null), 1)[0];
        if (pending) {
          pending.resultRow = row.id;
          pending.exit = row.isError ? 1 : exitFromText(text);
          if (pending.exit !== 0) pending.note = noteFromExit(pending.exit, text);
        }
      }
      if (row.toolName === 'read' || row.toolName === 'edit') {
        const hash = contentHashes(text)[0] ?? null;
        const call = toolCallsById.get(row.toolCallId);
        const path = firstString(call?.arguments ?? {}, FILE_ARG);
        if (path) {
          const list = row.toolName === 'read' ? filesRead : filesWritten;
          const hit = lastOf(list.filter((f) => f.path === path), 1)[0];
          if (hit) {
            hit.hash = hash;
            hit.at = hit.at ?? row.timestamp;
          } else {
            (row.toolName === 'read' ? filesRead : filesWritten).push({ path, hash, at: row.timestamp });
          }
        }
      }
      // branch / HEAD from git output
      if (row.toolName === 'bash') {
        const br = text.match(/^\* ([^\n]+)$/m) ?? text.match(/^On branch (\S+)/m) ?? text.match(/refs\/heads\/([^\s\n)]+)/m);
        if (br) branch.branch = branch.branch ?? br[1].trim();
        const head = text.match(/^\|?\*? ?([0-9a-f]{7,40})\b [^\n]/m) ?? text.match(/\bHEAD is at ([0-9a-f]{7,40})\b/) ?? text.match(/\bHEAD -> ([0-9a-f]{7,40})\b/);
        if (head) branch.head = branch.head ?? head[1];
      }
      // failing tests from test-runner output
      for (const t of scanFailingTests(text)) if (!failingTests.includes(t)) failingTests.push(t);
    }
  }

  return {
    goal: null,
    branch: branch.branch,
    head: branch.head,
    filesRead: dedupePaths(filesRead),
    filesWritten: dedupePaths(filesWritten),
    commands: commands.map(({ cmd, exit, at, note }) => ({ cmd, exit, at, note: note ?? undefined })),
    failingTests,
    openQuestions: [],
    nextSteps: [],
  };
}

const AUX_RE = /\b(must|should|shall|never|always|only)\b/i;

export function splitSentences(text) {
  return String(text)
    .replace(/\r/g, '')
    .split(/(?<=[.!?])\s+(?=["A-Z0-9`*\-])/)
    .flatMap((s) => (s.length > 400 ? s.split('\n') : [s]))
    .map((s) => s.replace(/^\s*[>\-*\d.]+\s*/, '').trim())
    .filter(Boolean);
}

export function isConstraintSentence(s) {
  if (s.length < 12 || s.length > 400) return false;
  if (/^(what|how|why|when|where|who|which|is it|are you|can you|could you|did you|do you|please|thanks|thank you|ok|okay|hi|hey)\b/i.test(s)) return false;
  return AUX_RE.test(s) || /\b(do not|don't|make sure|be sure|ensure|avoid|no logging|without)\b/i.test(s);
}

export function isOpenQuestion(s) {
  return s.endsWith('?') && s.length <= 300 && !isConstraintSentence(s);
}

export function extractFull(session) {
  const state = extractState(session);
  const constraints = [];
  const seen = new Set();
  const openQuestions = [];
  let goal = null;
  let ci = 0;
  for (const row of session.messages) {
    if (row.role !== 'user') continue;
    const text = rowText(row).trim();
    if (!text) continue;
    if (!goal && text.length > 20) goal = text.split(/[.\n]/)[0].slice(0, 200).trim();
    for (const s of splitSentences(text)) {
      if (isConstraintSentence(s)) {
        const key = s.toLowerCase().replace(/\s+/g, ' ');
        if (seen.has(key)) continue;
        seen.add(key);
        ci += 1;
        constraints.push({ id: `c${ci}`, text: s, source: `user#${row.index}`, at: row.timestamp });
      } else if (isOpenQuestion(s)) {
        if (!openQuestions.includes(s) && openQuestions.length < 50) openQuestions.push(s);
      }
    }
  }
  return {
    schemaVersion: 1,
    session: session.session,
    state: { ...state, goal, openQuestions },
    constraints,
  };
}

function exitFromText(text) {
  const m = text.match(/\b(?:exit code|Exit Code|exitCode)\s*[::]?\s*(\d+)\b/i) ?? text.match(/\bexited with code (\d+)\b/i);
  return m ? Number(m[1]) : 0;
}

function noteFromExit(exit, text) {
  if (exit === 0) return undefined;
  const fail = text.match(/(?:✕|✗|FAIL(?:ED)?|not ok)\s+(.+)/i) ?? text.match(/(Error:.+)/);
  return fail ? String(fail[1]).trim().slice(0, 120) : 'non-zero exit';
}

function scanFailingTests(text) {
  const out = [];
  const patterns = [
    /^\s*(?:✕|✗|FAIL(?:ING)?)\s+([^\n]+?)\s*$/gm,
    /^\s*not ok\s+\d+\s+-\s+(.+)$/gm,
    /^\s*(\d+)\)\s+([^\n]+)$/gm,
    /^FAILED\s+(.+)$/gm,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const name = (m[2] ?? m[1] ?? '').trim().replace(/\s+/g, ' ');
      if (name && !out.includes(name) && name.length < 200) out.push(name);
    }
  }
  return out;
}

function dedupePaths(list) {
  // keep the FIRST occurrence; later rows update hash in place
  const map = new Map();
  for (const row of list) {
    const k = row.path;
    const prev = map.get(k);
    if (!prev) {
      map.set(k, { path: row.path, hash: row.hash ?? null, at: row.at ?? null });
    } else if (row.hash) {
      prev.hash = row.hash;
      prev.at = row.at ?? prev.at;
    }
  }
  return [...map.values()];
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}