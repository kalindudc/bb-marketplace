import { readFileSync, writeFileSync } from "node:fs";
import { prGrantIdSchema } from "./schema";

export const pullRequestReceiptLine = (receipt: string) => `Tavern pull request receipt: ${receipt}`;
export function observedPullRequestReceipt(item: Record<string, unknown>) {
  for (const value of [item.aggregatedOutput, item.result, item.resultText]) {
    const encoded = typeof value === "string" ? value : JSON.stringify(value ?? "");
    const match = /Tavern pull request receipt: ([a-f0-9-]{36})\b/i.exec(encoded);
    if (match) return match[1];
  }
}
const marker = (file: string, id: string) => `${file}.${prGrantIdSchema.parse(id)}.used`;
export function pullRequestGrantAvailable(file: string, id: string, observedCallId?: string) {
  try { const claimed = readFileSync(marker(file, id), "utf8"); return observedCallId !== undefined && claimed === observedCallId; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
}
export function claimPullRequestGrant(file: string, id: string, callId: string) {
  try { writeFileSync(marker(file, id), callId, { flag: "wx", mode: 0o600 }); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
}
