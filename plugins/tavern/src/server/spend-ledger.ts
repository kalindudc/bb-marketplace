import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { spendReceiptSchema, type SpendReceipt } from "../shared/spend";
import type { KeeperStore } from "./keeper/store";

type Input = { file_id: string; offset: number; invalid: number };
const CHUNK = 256 * 1024;

export class SpendLedger {
  directory?: string;
  constructor(private readonly store: KeeperStore) {}

  ingest(threadId: string, rows: SpendReceipt[]) {
    if (!this.store.get("members", threadId)) throw new Error("Spend receipts need a bound Tavern thread");
    const insert = this.store.db.prepare(`INSERT OR IGNORE INTO tavern_spend_receipts
      (thread_id, source, session_id, entry_id, at, usd_nanos) VALUES (?,?,?,?,?,?)`);
    this.store.atomic(() => {
      for (const { source, session, entry, at, usdNanos } of rows) insert.run(threadId, source, session, entry, at, usdNanos);
    });
  }

  read(threadId: string, from: number, to: number) {
    const state = this.import(threadId);
    const rows = this.store.db.prepare(`SELECT source, at, usd_nanos AS usdNanos FROM tavern_spend_receipts
      WHERE thread_id=? AND at>=? AND at<=? ORDER BY at`).all(threadId, from, to) as Pick<SpendReceipt, "source" | "at" | "usdNanos">[];
    return { rows, partial: state !== "complete", absent: state === "absent" };
  }

  private import(threadId: string): "complete" | "partial" | "absent" {
    if (!this.directory) return "complete";
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(threadId)) return "partial";
    let fd: number | undefined;
    try {
      fd = openSync(join(this.directory, `${threadId}.json.spend`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile()) return "partial";
      const fileId = `${stat.dev}:${stat.ino}`;
      const cursor = this.store.db.prepare("SELECT file_id,offset,invalid FROM tavern_spend_inputs WHERE thread_id=?").get(threadId) as Input | undefined;
      const prior = cursor?.file_id === fileId && cursor.offset <= stat.size ? cursor : undefined;
      const offset = prior?.offset ?? 0;
      if (offset === stat.size) return prior?.invalid ? "partial" : "complete";
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK, stat.size - offset));
      const bytes = readSync(fd, buffer, 0, buffer.length, offset);
      const end = buffer.subarray(0, bytes).lastIndexOf(10);
      if (end < 0) return "partial";
      const rows: SpendReceipt[] = [];
      let invalid = prior?.invalid ?? 0;
      for (const line of buffer.toString("utf8", 0, end).split("\n")) {
        try {
          const result = spendReceiptSchema.safeParse({ ...JSON.parse(line), source: "Guarded local session" });
          if (result.success) rows.push(result.data);
          else invalid = 1;
        } catch { invalid = 1; }
      }
      this.store.atomic(() => {
        this.ingest(threadId, rows);
        this.store.db.prepare(`INSERT INTO tavern_spend_inputs(thread_id,file_id,offset,invalid) VALUES(?,?,?,?)
          ON CONFLICT(thread_id) DO UPDATE SET file_id=excluded.file_id,offset=excluded.offset,invalid=excluded.invalid`).run(threadId, fileId, offset + end + 1, invalid);
      });
      return invalid !== 0 || offset + end + 1 < stat.size ? "partial" : "complete";
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || !["ENOENT", "ELOOP", "EACCES", "EIO"].includes(String(error.code))) throw error;
      return error.code === "ENOENT" ? "absent" : "partial";
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}
