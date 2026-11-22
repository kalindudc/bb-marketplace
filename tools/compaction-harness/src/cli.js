#!/usr/bin/env node
// compaction-harness CLI
//   extract   <session.jsonl> [--out <file>] [--max <n>]   mechanical state block JSON
//   probes    <session.jsonl> [--out <file>]              probe set JSON
//   score     <probes.json> --candidate <file|->          score a candidate summary
//   baseline  <session.jsonl> [--out-dir <dir>]            build+score both baselines
// Offline. No model, no network, read-only on inputs.
import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readSession } from './session.js';
import { extractFull } from './extract.js';
import { deriveProbes } from './probes.js';
import { scoreProbes, markdownTable } from './score.js';
import { buildBaseline } from './baseline.js';

function parse(argv) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      strict: false,
      options: {
        out: { type: 'string' },
        'out-dir': { type: 'string' },
        max: { type: 'string' },
        candidate: { type: 'string' },
        misses: { type: 'string' },
      },
    });
  } catch (e) {
    fail(e.message);
  }
}

function fail(msg) {
  console.error(`compaction-harness: ${msg}`);
  process.exit(1);
}

async function maybeWrite(out, obj) {
  const json = JSON.stringify(obj, null, 2);
  if (out) await writeFile(out, json + '\n');
  else process.stdout.write(json + '\n');
}

async function readStdin() {
  let data = '';
  const stdin = process.stdin;
  stdin.setEncoding('utf8');
  for await (const chunk of stdin) data += chunk;
  return data;
}

async function main() {
  const { positionals, values } = parse(process.argv.slice(2));
  const [cmd, arg] = positionals;
  if (!cmd) fail('usage: compaction-harness <extract|probes|score|baseline> ...');

  if (cmd === 'extract' || cmd === 'probes' || cmd === 'baseline') {
    if (!arg) fail(`${cmd} needs a session JSONL path`);
    const session = await readSession(arg);
    if (cmd === 'extract') {
      await maybeWrite(values.out, extractFull(session));
    } else if (cmd === 'probes') {
      const probes = deriveProbes(session, { maxPerKind: values.max ? Number(values.max) : undefined });
      await maybeWrite(values.out, { schemaVersion: 1, source: arg, count: probes.length, probes });
    } else {
      const probes = deriveProbes(session, { maxPerKind: values.max ? Number(values.max) : undefined });
      const probeSet = { source: arg, count: probes.length, probes };
      const results = [];
      for (const kind of ['none', 'pi-native-serialisation']) {
        const b = buildBaseline(kind, session);
        if (values['out-dir']) {
          await mkdir(values['out-dir'], { recursive: true });
          await writeFile(`${values['out-dir']}/baseline-${kind}.txt`, b.text + '\n');
        }
        const r = scoreProbes(probeSet, b.text);
        results.push({ label: b.label, ...r });
      }
      const report = { source: arg, probes: probeSet.count, results: results.map(({ misses, ...r }) => r) };
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      process.stdout.write('\n' + markdownTable(results) + '\n');
    }
    return;
  }

  if (cmd === 'score') {
    if (!arg) fail('score needs a probes JSON path');
    const set = JSON.parse(await readFile(arg, 'utf8'));
    const candidate = values.candidate === '-' ? await readStdin() : await readFile(values.candidate, 'utf8');
    const r = scoreProbes(set, candidate);
    process.stdout.write(JSON.stringify({ ...r, misses: r.misses.slice(0, values.misses ? Number(values.misses) : 200) }, null, 2) + '\n');
    return;
  }

  fail(`unknown command: ${cmd}`);
}

main().catch((e) => fail(e?.stack ?? String(e)));