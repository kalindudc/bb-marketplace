import { appendFileSync } from "node:fs";
import { NANOS_PER_DOLLAR, type SpendReceipt } from "../../src/shared/spend";

export type SpendSession = {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getHeader?(): { timestamp: string; parentSession?: string } | null | undefined;
  getEntries(): unknown[];
  getBranch?(): unknown[];
  buildContextEntries?(): unknown[];
  getEntry(id: string): unknown;
};

type Entry = { id?: unknown; type?: unknown; timestamp?: unknown; message?: { role?: unknown; usage?: { cost?: { total?: unknown } } } };
export function receiveSpend(scopeFile: string) {
  let sessionId: string | undefined;
  const sent = new Set<string>();
  const write = (manager: SpendSession, entries: unknown[]) => {
    if (!manager.getSessionFile()) return;
    const session = manager.getSessionId();
    if (sessionId !== session) { sent.clear(); sessionId = session; }
    const header = manager.getHeader?.();
    const forkedAt = header?.parentSession ? Date.parse(header.timestamp) : -Infinity;
    const receipts: SpendReceipt[] = [];
    const writing = new Set<string>();
    for (const value of entries) {
      const row = value as Entry | undefined;
      if (row?.type !== "message" || row.message?.role !== "assistant" || typeof row.id !== "string" || typeof row.timestamp !== "string" || sent.has(row.id) || writing.has(row.id)) continue;
      const at = Date.parse(row.timestamp);
      if (!Number.isFinite(at) || at < 0 || at < forkedAt) continue;
      const total = row.message.usage?.cost?.total;
      const amount = typeof total === "number" && total >= 0 ? Math.round(total * NANOS_PER_DOLLAR) : NaN;
      receipts.push({ source: "Guarded local session", session, entry: row.id, at, usdNanos: Number.isSafeInteger(amount) ? amount : null });
      writing.add(row.id);
    }
    if (!receipts.length) return;
    try { appendFileSync(`${scopeFile}.spend`, receipts.map(row => `${JSON.stringify(row)}\n`).join(""), { mode: 0o600 }); }
    catch (error) { console.warn(`Tavern could not record session spend: ${String(error)}`); return; }
    for (const id of writing) sent.add(id);
  };
  return {
    backfill: (manager: SpendSession) => write(manager, manager.getEntries()),
    turn: (manager: SpendSession, id: string) => write(manager, [manager.getEntry(id)]),
  };
}
