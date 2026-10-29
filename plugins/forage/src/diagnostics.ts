export type OperationName = "search" | "fetch" | "map" | "extract" | "crawl" | "diff";
export interface DiagnosticRecord {
 operation: OperationName;
 status: "success" | "partial" | "failure" | "cancelled";
 durationMs: number;
 provider?: "duckduckgo" | "exa" | "brave" | "searxng" | "tavily" | "direct" | "firecrawl" | "jina" | "local";
 warnings?: Array<"policy-blocked" | "storage-limit" | "partial" | "deadline" | "cancelled" | "failure">;
 stageMs: Partial<Record<"scope" | "policy" | "acquisition" | "capture" | "render" | "total", number>>;
 counts: Partial<Record<"items" | "successful" | "failed" | "persisted" | "bytes", number>>;
 cache: Partial<Record<"hit" | "miss" | "revalidated", number>>;
}
export interface DiagnosticEntry extends DiagnosticRecord { at: number }

export class DiagnosticRing {
 private records: DiagnosticEntry[] = [];
 constructor(private readonly now: () => number = Date.now) {}
 record(input: DiagnosticRecord): void {
  const numeric = (value: object, allowed: readonly string[]) => Object.fromEntries(Object.entries(value).filter(([key, count]) => allowed.includes(key) && typeof count === "number" && Number.isFinite(count) && count >= 0));
  const operations: OperationName[] = ["search", "fetch", "map", "extract", "crawl", "diff"];
  const statuses: DiagnosticRecord["status"][] = ["success", "partial", "failure", "cancelled"];
  if (!operations.includes(input.operation) || !statuses.includes(input.status)) throw new Error("Invalid diagnostic record");
  const providers = ["duckduckgo", "exa", "brave", "searxng", "tavily", "direct", "firecrawl", "jina", "local"];
  const warningCodes = ["policy-blocked", "storage-limit", "partial", "deadline", "cancelled", "failure"];
  this.records.push({ at: this.now(), operation: input.operation, status: input.status, ...(input.provider && providers.includes(input.provider) ? { provider: input.provider } : {}), warnings: (input.warnings ?? []).filter(code => warningCodes.includes(code)).slice(0, 10), durationMs: Math.max(0, Number.isFinite(input.durationMs) ? input.durationMs : 0), stageMs: numeric(input.stageMs, ["scope", "policy", "acquisition", "capture", "render", "total"]), counts: numeric(input.counts, ["items", "successful", "failed", "persisted", "bytes"]), cache: numeric(input.cache, ["hit", "miss", "revalidated"]) });
  this.trim();
 }
 private trim(): void { this.records = this.records.filter(record => record.at >= this.now() - 86_400_000).slice(-200); }
 snapshot(): DiagnosticEntry[] { this.trim(); return structuredClone(this.records); }
 clear(): void { this.records = []; }
}
