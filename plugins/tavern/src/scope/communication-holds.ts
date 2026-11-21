import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { communicationHoldSchema, type CommunicationHold, type CommunicationPreview } from "../shared/communication";
import { communicationCallDigest, sendRulesDigest } from "./communication";
import { atomicWrite } from "./store";
import type { ScopeCall } from "./engine";
import type { Scope } from "./schema";

const directory = (file: string) => file + ".messages";
const uuid = /^[a-f0-9-]{36}$/;
function missing(error: unknown) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function prepare(file: string) {
  const dir = directory(file);
  mkdirSync(dir, { mode: 0o700, recursive: true });
  if (!lstatSync(dir).isDirectory()) throw new Error("Communication holds need a private scope directory");
  return dir;
}
export function holdCommunication(file: string, scope: Scope, call: ScopeCall, preview: CommunicationPreview) {
  const hold = communicationHoldSchema.parse({
    ...preview, id: randomUUID(), threadId: scope.threadId, scopeIssuedAt: scope.issuedAt, at: Date.now(),
    rulesDigest: sendRulesDigest(scope.sendTools), callDigest: communicationCallDigest(call),
  });
  atomicWrite(join(prepare(file), hold.id + ".json"), JSON.stringify(hold));
  return hold;
}
export function readCommunicationHolds(file: string): CommunicationHold[] {
  const dir = directory(file);
  let names;
  try { if (!lstatSync(dir).isDirectory()) throw new Error("Not a scope directory"); names = readdirSync(dir); }
  catch (error) { if (missing(error)) return []; throw error; }
  const batch: CommunicationHold[] = [];
  let bytes = 0;
  for (const name of names) {
    if (!name.endsWith(".json") || !uuid.test(name.slice(0, -5))) continue;
    const path = join(dir, name);
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.size > 4 * 1024 * 1024) continue;
      if (bytes + info.size > 4 * 1024 * 1024 || batch.length >= 8) break;
      const parsed = communicationHoldSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (!parsed.success || name !== parsed.data.id + ".json") continue;
      bytes += info.size;
      batch.push(parsed.data);
    } catch (error) { if (!missing(error) && !(error instanceof SyntaxError)) throw error; }
  }
  return batch;

}
export function acknowledgeCommunicationHolds(file: string, ids: readonly string[]) {
  if (ids.some(id => !uuid.test(id))) throw new Error("Invalid held call id");
  const dir = directory(file);
  try { if (!lstatSync(dir).isDirectory()) throw new Error("Not a scope directory"); }
  catch (error) { if (missing(error)) return; throw error; }
  for (const id of ids) rmSync(join(dir, id + ".json"), { force: true });
}
export function claimCommunicationReceipt(file: string, askId: string, digest: string, observation: string) {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(askId)) return false;
  try { writeFileSync(join(prepare(file), askId + ".used"), JSON.stringify({ digest, observation }), { flag: "wx", mode: 0o600 }); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
}
export function revokeCommunicationReceipt(file: string, askId: string) {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(askId)) throw new Error("Invalid draft receipt id");
  try { writeFileSync(join(prepare(file), askId + ".used"), "{\"revoked\":true}", { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}
export function usedCommunicationReceipt(file: string, askId: string, replay?: { digest: string; observation: string }) {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(askId)) return false;
  const dir = directory(file);
  try {
    const path = join(dir, askId + ".used");
    if (!lstatSync(dir).isDirectory() || !lstatSync(path).isFile()) return false;
    if (!replay) return true;
    const claimed = JSON.parse(readFileSync(path, "utf8"));
    return claimed.digest === replay.digest && claimed.observation === replay.observation;
  }
  catch (error) { if (missing(error)) return false; throw error; }
}
export function observedDraftReceipt(texts: string[]) {
  for (const text of texts) {
    const match = /^Tavern draft receipt: ([A-Za-z0-9_-]{1,120}) ([a-f0-9-]{36})$/m.exec(text);
    if (match) return { askId: match[1], observation: match[2] };
  }
}
export function matchedDraftReceipt(file: string, call: ScopeCall, receipt: string | undefined) {
  if (!receipt) return false;
  const [askId, observation] = receipt.split(" ");
  const digest = communicationCallDigest(call);
  return !!digest && uuid.test(observation ?? "") && usedCommunicationReceipt(file, askId, { digest, observation });
}
