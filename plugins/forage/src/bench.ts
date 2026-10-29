import { performance } from "node:perf_hooks";
import { extractDeterministic } from "./web/extract.ts";

export const BENCH_CORPUS = [
 { name: "documentation", finalUrl: "https://fixture.invalid/docs", contentType: "text/html", body: '<html lang="en"><head><title>Fixture guide</title></head><body><main><h1>Guide</h1><p>Install the package.</p><pre><code>npm install example\nexample --help</code></pre><a href="/reference">Reference</a><table><tr><th>Flag</th><th>Meaning</th></tr><tr><td>--help</td><td>Usage</td></tr></table></main></body></html>' },
 { name: "markdown", finalUrl: "https://fixture.invalid/reference", contentType: "text/markdown", body: "# Reference\n\n## Configuration\n\nUse explicit scope.\n\n```ts\nconst enabled = true;\n```\n\n[Guide](/docs)\n" },
 { name: "json", finalUrl: "https://fixture.invalid/data", contentType: "application/json", body: '{"title":"Local fixture","items":[1,2,3]}' },
] as const;
export function bench() {
 const started = performance.now();
 const cases = BENCH_CORPUS.map(input => {
  const at = performance.now();
  const output = extractDeterministic(input);
  return { name: input.name, durationMs: performance.now() - at, chars: output.content.length, headings: output.structured.headings.length, links: output.structured.links.length, tables: output.structured.tables.length, warnings: output.warnings.map(w => w.code), truncated: output.truncated };
 });
 return { mode: "bundled-local-corpus", network: false, cases, durationMs: performance.now() - started };
}
