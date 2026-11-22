// score: given a probe set and ANY candidate summary text, report retained/total
// per kind and list misses with the probe text. Matching is evidential:
//  - path/branch/head: exact equality after path normalisation
//  - command: exact equality after whitespace collapse
//  - error/constraint: a normalised run of >= 6 consecutive significant words
//    from the expected text appears verbatim in the candidate
import { probeRetained } from './normalize.js';

export function scoreProbes(probeSet, candidateText) {
  const probes = probeSet.probes ?? probeSet;
  const hay = [candidateText ?? ''];
  const perKind = {};
  const misses = [];
  let retained = 0;
  for (const p of probes) {
    const ok = probeRetained(p, hay);
    perKind[p.kind] ??= { total: 0, retained: 0 };
    perKind[p.kind].total += 1;
    if (ok) {
      perKind[p.kind].retained += 1;
      retained += 1;
    } else {
      misses.push({ id: p.id, kind: p.kind, expected: p.expected, source: p.source ?? null });
    }
  }
  const total = probes.length;
  const pct = total === 0 ? null : Math.round((retained / total) * 1000) / 10;
  return { total, retained, percent: pct, perKind, misses };
}

export function markdownTable(results) {
  const kinds = [...new Set(results.flatMap((r) => Object.keys(r.perKind)))];
  const head = `| candidate | retained/total | % | ${kinds.join(' | ')} |`;
  const sep = `|---|---|---|${kinds.map(() => '---').join('|')}|`;
  const rows = results.map((r) => {
    const cells = kinds.map((k) => {
      const c = r.perKind[k];
      return c ? `${c.retained}/${c.total}` : '-';
    });
    return `| ${r.label} | ${r.retained}/${r.total} | ${r.percent ?? '-'}% | ${cells.join(' | ')} |`;
  });
  return [head, sep, ...rows].join('\n');
}