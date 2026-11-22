// Deterministic text helpers shared by extract, probes and score.
export const normalizePath = (p) =>
  String(p)
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();

export const normalizeCommand = (c) => String(c).trim().replace(/\s+/g, ' ');

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'when', 'at', 'by',
  'for', 'with', 'about', 'against', 'between', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'to', 'from', 'up', 'down', 'in', 'out',
  'on', 'off', 'over', 'under', 'again', 'further', 'once', 'here', 'there',
  'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
  'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  's', 't', 'can', 'will', 'just', 'don', 'should', 'now',
]);

export function significantWords(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s./_-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w));
}

function normalizeForMatch(text) {
  return significantWords(text).join(' ');
}

// A constraint counts as retained only if a run of >= 6 consecutive significant
// words from the sentence appears verbatim (in normalized form) in the candidate.
export function constraintRetained(expected, candidate) {
  const want = significantWords(expected);
  const have = normalizeForMatch(candidate);
  if (want.length < 6) {
    return have.includes(want.join(' '));
  }
  for (let i = 0; i + 6 <= want.length; i += 1) {
    const run = want.slice(i, i + 6).join(' ');
    if (have.includes(run)) return true;
  }
  return false;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Single-pass unescape of the escape forms JSON.stringify emits for string
// values. Any other backslash sequence stays untouched.
function unescapeJsonish(s) {
  return s.replace(/\\(.)/g, (m, c) => {
    if (c === 'n') return '\n';
    if (c === 't') return '\t';
    if (c === 'r') return '\r';
    if (c === '"') return '"';
    if (c === '\\') return '\\';
    return m;
  });
}

// Recurring-detail probe value matching, per kind. Evidential, not fuzzy:
//  - path: normalized path appears verbatim as a substring of the candidate
//  - command: exact command text after whitespace collapse appears in the candidate
//  - branch/head: expected value appears on a word boundary
//  - error/constraint: a normalised run of >= 6 consecutive significant words
export function probeRetained(probe, candidates) {
  const list = Array.isArray(candidates) ? candidates : [candidates];
  const texts = list.flatMap((c) => {
    const s = String(c);
    // a candidate may embed serialised tool-call args (JSON.stringify);
    // matching also tries the unescaped form so literal command text matches
    return [s, unescapeJsonish(s)];
  });
  const expected = String(probe.expected);
  switch (probe.kind) {
    case 'path':
      return texts.some((t) => normalizePath(t).includes(normalizePath(expected)));
    case 'command':
      return texts.some((t) => normalizeCommand(t).includes(normalizeCommand(expected)));
    case 'branch':
    case 'head': {
      const re = new RegExp(`(^|[^a-zA-Z0-9])${escapeRe(expected)}([^a-zA-Z0-9]|$)`);
      return texts.some((t) => re.test(t));
    }
    case 'error':
    case 'constraint':
      return texts.some((t) => constraintRetained(expected, t));
    default:
      return false;
  }
}