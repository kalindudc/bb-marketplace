import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { atomicWrite } from "./store";

export const actTargetDigest = (source: string) => createHash("sha256").update(source, "utf8").digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/);
export const actGrantSchema = z.object({
  threadId: id, act: z.string().min(1).max(60), targetDigest: digest, target: z.string().min(1).max(8000),
  scope: z.literal("once"), askId: id, issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(),
  usedAt: z.null(),
}).strict().refine(grant => grant.targetDigest === actTargetDigest(grant.target) && grant.expiresAt > grant.issuedAt);
export type ActGrant = z.infer<typeof actGrantSchema>;
const directory = (file: string) => file + ".act-grants";
const grantFile = (file: string, digest: string) => directory(file) + "/" + digest + ".json";
const usedFile = (file: string, askId: string) => directory(file) + "/" + askId + ".used";
const useSchema = z.object({ threadId: id, act: z.string(), targetDigest: digest, usedAt: z.number().int(), observation: z.uuid() }).strict();
function readSmall(path: string, limit: number) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > limit) return undefined;
    return readFileSync(path, "utf8");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function grantDirectory(file: string) {
  try { return lstatSync(directory(file)).isDirectory(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
export function issueActGrant(file: string, input: ActGrant, check?: () => void) {
  const grant = actGrantSchema.parse(input);
  mkdirSync(directory(file), { mode: 0o700, recursive: true });
  if (!grantDirectory(file)) throw new Error("The command grant directory is not an ordinary directory.");
  atomicWrite(grantFile(file, grant.targetDigest), JSON.stringify(grant), check);
}
export function availableActGrant(file: string, threadId: string, act: string, source: unknown, now = Date.now()) {
  if (typeof source !== "string" || source.length > 8000 || !grantDirectory(file)) return;
  const raw = readSmall(grantFile(file, actTargetDigest(source)), 64 * 1024);
  if (raw === undefined) return;
  const grant = actGrantSchema.parse(JSON.parse(raw));
  if (grant.threadId === threadId && grant.act === act && grant.target === source && grant.issuedAt <= now && grant.expiresAt > now && !existsSync(usedFile(file, grant.askId))) return grant;
}
export function claimActGrant(file: string, grant: ActGrant, observation: string, now = Date.now()) {
  if (availableActGrant(file, grant.threadId, grant.act, grant.target, now)?.askId !== grant.askId) return false;
  const used = useSchema.parse({ threadId: grant.threadId, act: grant.act, targetDigest: grant.targetDigest, usedAt: now, observation });
  try { writeFileSync(usedFile(file, grant.askId), JSON.stringify(used), { mode: 0o600, flag: "wx" }); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
}
export function revokeActGrant(file: string, askId: string) {
  if (!grantDirectory(file)) return;
  try { writeFileSync(usedFile(file, id.parse(askId)), JSON.stringify({ revoked: true }), { mode: 0o600, flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}
export const actReceiptLine = (askId: string, observation: string) => `Tavern command receipt: ${askId} ${observation}`;
export function observedActReceipt(item: Record<string, unknown>) {
  for (const value of [item.aggregatedOutput, item.result, item.resultText]) {
    const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
    const receipt = /Tavern command receipt: ([a-zA-Z0-9_-]{1,120}) ([a-f0-9-]{36})\b/i.exec(text);
    if (receipt) return receipt[1] + " " + receipt[2];
  }
}
export function matchesActReceipt(file: string, threadId: string, act: string, source: unknown, receipt: string | undefined) {
  if (typeof source !== "string" || !receipt || !grantDirectory(file)) return false;
  const [askId, observation] = receipt.split(" ");
  if (!id.safeParse(askId).success || !z.uuid().safeParse(observation).success) return false;
  const raw = readSmall(usedFile(file, askId), 4096);
  if (raw === undefined) return false;
  const used = useSchema.safeParse(JSON.parse(raw));
  return used.success && used.data.threadId === threadId && used.data.act === act && used.data.targetDigest === actTargetDigest(source) && used.data.observation === observation;
}
