// node:test suite for compaction-harness: parsers, normalisation, scorer,
// extract and baseline — all against the synthetic fixture, never real sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, 'fixtures', 'synthetic-session.jsonl');

const { parseSession, rowText, rowToolCalls } = await import('../src/session.js');
const { normalizePath, normalizeCommand, constraintRetained, probeRetained } = await import('../src/normalize.js');
const { extractFull, extractState, splitSentences, isConstraintSentence } = await import('../src/extract.js');
const { deriveProbes } = await import('../src/probes.js');
const { scoreProbes, markdownTable } = await import('../src/score.js');
const { serializeConversation, truncateForSummary, buildBaseline } = await import('../src/baseline.js');

const raw = readFileSync(fixturePath, 'utf8');
const session = parseSession(raw);

test('parser: skips non-message rows and keeps session header', () => {
  assert.equal(session.session.id, 'sess-1');
  assert.equal(session.session.cwd, '/tmp/proj');
  assert.equal(session.messages.length, 9); // 9 message rows; model/thinking/unknown skipped
});

test('parser: tolerates unknown line type and unknown content block without crashing', () => {
  const rows = raw.split('\n').filter(Boolean);
  const parsed = parseSession(rows.join('\n'));
  assert.equal(parsed.messages.length, 9);
  const assistant = parsed.messages.find((m) => m.id === 'r7');
  assert.ok(assistant.content.some((b) => b.type === 'unknown_block_type'));
});

test('parser: handles string content (not array) without crashing', () => {
  const parsed = parseSession(JSON.stringify({ type: 'message', id: 'x', message: { role: 'user', content: 'plain string' } }));
  assert.equal(parsed.messages[0].content[0].type, 'text');
  assert.equal(parsed.messages[0].content[0].text, 'plain string');
});

test('rowText: joins text blocks only', () => {
  const u = session.messages.find((m) => m.id === 'r1');
  assert.match(rowText(u), /never commit directly to main/);
  const a = session.messages.find((m) => m.id === 'r2');
  assert.doesNotMatch(rowText(a), /internal reasoning/);
  assert.equal(rowToolCalls(a).length, 3);
});

test('normalizePath: strips dots, trailing slashes, lowercases', () => {
  assert.equal(normalizePath('Src/App.TS/'), 'src/app.ts');
  assert.equal(normalizePath('src\\app.ts'), normalizePath('src/app.ts'));
});

test('normalizeCommand: collapses whitespace', () => {
  assert.equal(normalizeCommand('  npm   test  '), 'npm test');
});

test('constraintRetained: >= 6 significant words verbatim run required', () => {
  const s = 'You must never commit directly to main without review';
  assert.ok(constraintRetained(s, 'Reminder: you must never commit directly to main without review.'));
  assert.ok(!constraintRetained(s, 'Please avoid committing to the main branch in any circumstance.'));
});

test('constraintRetained: short (<6 words) sentences need full match', () => {
  assert.ok(constraintRetained('always run tests', 'Always run tests.'));
  assert.ok(!constraintRetained('always run tests', 'Run tests always maybe.'));
});

test('probeRetained: path is normalized substring, not fuzzy', () => {
  const p = { kind: 'path', expected: 'src/app.ts' };
  assert.ok(probeRetained(p, ['changed SRC/APP.TS today']));
  assert.ok(!probeRetained(p, ['changed src/app ts today']));
});

test('probeRetained: command matches after whitespace collapse and quote unescape', () => {
  const p = { kind: 'command', expected: 'npm test -- --grep "app"' };
  assert.ok(probeRetained(p, ['bash(command="npm test  -- --grep \\"app\\"")']));
  assert.ok(!probeRetained(p, ['bash(command="npm run test")']));
});

test('probeRetained: branch/head need word boundaries', () => {
  const p = { kind: 'branch', expected: 'main' };
  assert.ok(probeRetained(p, ['On branch main now']));
  assert.ok(!probeRetained(p, ['remained calm'])); // 'main' inside word must not match
});

test('extract: state files, commands with exit, branch/head, failing test', () => {
  const st = extractState(session);
  assert.equal(st.branch, 'feat/fix');
  assert.equal(st.head, 'abc1234');
  assert.ok(st.filesRead.some((f) => f.path === 'src/app.ts' && /^sha256:/.test(f.hash)));
  assert.ok(st.filesWritten.some((f) => f.path === 'src/app.ts'));
  const npm = st.commands.find((c) => c.cmd === 'npm test');
  assert.equal(npm.exit, 1);
  const git = st.commands.find((c) => c.cmd === 'git status && git log -1 --oneline');
  assert.equal(git.exit, 0);
});

test('extract: constraints verbatim with source index, questions separate', () => {
  const full = extractFull(session);
  const texts = full.constraints.map((c) => c.text);
  assert.ok(texts.includes('You must never commit directly to main.'));
  assert.ok(texts.includes('Always run tests before reporting.'));
  const c = full.constraints.find((x) => x.text === 'You must never commit directly to main.');
  assert.equal(c.source, 'user#5'); // JSONL line index of the user row
  assert.match(c.source, /^user#\d+$/);
  assert.ok(full.state.openQuestions.some((q) => q.includes('why the test fails')));
});

test('extract: goal is first user message first sentence', () => {
  const full = extractFull(session);
  assert.equal(full.state.goal, 'Fix the flaky build');
});

test('probes: kinds, ids, verbatim expected values', () => {
  const probes = deriveProbes(session);
  const kinds = new Set(probes.map((p) => p.kind));
  for (const k of ['path', 'command', 'constraint', 'error', 'branch', 'head']) assert.ok(kinds.has(k), `missing ${k}`);
  assert.ok(probes.every((p) => /^p\d+$/.test(p.id)));
  const npmCmd = probes.find((p) => p.kind === 'command' && p.expected === 'npm test');
  assert.ok(npmCmd, 'npm test command probe');
  const err = probes.find((p) => p.kind === 'error');
  assert.equal(err.expected, 'Error: something broke');
  assert.ok(probes.some((p) => p.kind === 'path' && p.expected === 'src/app.ts'));
  assert.ok(probes.some((p) => p.kind === 'constraint' && p.expected.includes('never commit directly to main')));
});

test('score: none baseline retains nothing, serialisation retains almost all', () => {
  const probes = deriveProbes(session);
  const none = scoreProbes({ probes }, '');
  assert.equal(none.retained, 0);
  const ser = buildBaseline('pi-native-serialisation', session).text;
  const scored = scoreProbes({ probes }, ser);
  assert.ok(scored.retained > 0);
  assert.ok(scored.percent > 50);
  // misses carry the probe text
  for (const m of scored.misses) assert.ok(typeof m.expected === 'string' && m.expected.length > 0);
});

test('baseline: serialisation omits thinking, truncates tool results at 2000 chars', () => {
  const long = 'x'.repeat(2500);
  const sess = parseSession(
    JSON.stringify({
      type: 'message', id: 'r2',
      message: { role: 'toolResult', content: [{ type: 'text', text: long }] },
    }),
  );
  const text = serializeConversation(sess.messages);
  assert.doesNotMatch(text, /internal reasoning/); // fixture thinking never appears
  assert.match(text, /\[Tool result\]: x{2000}/);
  assert.match(text, /\[\.\.\. 500 more characters truncated\]/);
  const full = serializeConversation(session.messages);
  assert.match(full, /^\[User\]: Fix the flaky build/m);
  assert.match(full, /^\[Assistant tool calls\]: read\(path="src\/app.ts"\); bash\(command="npm test", timeout=30\); edit\(path="src\/app\.ts", oldText="a", newText="b"\)/m);
  assert.match(full, /^\[Tool result\]: /m);
});

test('baseline: none is empty string, unknown kind throws', () => {
  assert.equal(buildBaseline('none', session).text, '');
  assert.throws(() => buildBaseline('nope', session), /unknown baseline kind/);
});

test('score: markdown table lists per-kind retained/total', () => {
  const probes = deriveProbes(session);
  const results = [
    { label: 'none', ...scoreProbes({ probes }, '') },
    { label: 'ser', ...scoreProbes({ probes }, serializeConversation(session.messages)) },
  ];
  const md = markdownTable(results);
  assert.match(md, /\| candidate \| retained\/total \| % \|/);
  assert.match(md, /none \| 0\/\d+ \| 0% \|/);
  assert.match(md, /ser \| \d+\/\d+ \| \d+(\.\d+)?% \|/);
});

test('score: rejects paraphrased constraint (not fuzzy-gamed)', () => {
  const probeSet = { probes: [{ id: 'p1', kind: 'constraint', expected: 'Always keep the palette hex values exactly as I gave them to you' }] };
  const paraphrase = scoreProbes(probeSet, 'Remember to use the color constants I provided earlier for the palette.');
  assert.equal(paraphrase.retained, 0);
  const verbatim = scoreProbes(probeSet, 'Note: always keep the palette hex values exactly as I gave them to you.');
  assert.equal(verbatim.retained, 1);
});