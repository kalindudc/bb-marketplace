import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { actsForCommand, pullRequestRoute } from "./acts";
import { shellGrantActSchema, type ShellGrantTarget } from "../shared/shell-grant";
import type { ScopeCall } from "./engine";
import { parseScript } from "./parser";
import { realPath } from "./paths";
import { prUrl } from "./pr-policy";
import { pushSpec } from "./remote";
import { prGrantIdSchema, type Scope } from "./schema";
import { shellCommands, type ShellCommand } from "./shell";
import { armedFile, atomicWrite, scopeArmedSchema } from "./store";

const sidecarGrant = z.object({ id: prGrantIdSchema, digest: z.string().regex(/^[a-f0-9]{64}$/), scope: z.enum(["once", "quest"]) }).strict();
const sidecar = z.object({ version: z.literal(1), threadId: z.string(), issuedAt: z.number(), grants: z.array(sidecarGrant).max(100) }).strict();
export type ShellGrantProjection = z.infer<typeof sidecarGrant>;
type Binding = Pick<Scope, "threadId" | "issuedAt">;
const receiptSchema = z.object({ token: prGrantIdSchema, commands: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(2) }).strict();
const commandDigest = (command: string) => createHash("sha256").update(command).digest("hex");
const grantFile = (file: string) => file + ".grants";
const usedFile = (file: string, id: string) => `${grantFile(file)}.${prGrantIdSchema.parse(id)}.used`;
const callFile = (file: string, id: string, receipt: string) => `${grantFile(file)}.${prGrantIdSchema.parse(id)}.${prGrantIdSchema.parse(receipt)}.call`;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const capabilityFile = (file: string) => grantFile(file) + ".capability";
const legacyEnvSchema = z.enum(["GH_TOKEN", "Git push block"]);
type LegacyEnv = z.infer<typeof legacyEnvSchema>;
const capabilitySchema = z.object({ version: z.literal(1), threadId: z.string(), issuedAt: z.number(), at: z.number(), pid: z.number().int().positive(), legacyEnv: z.array(legacyEnvSchema).max(2).optional() }).strict();

export function oldScopeEnvironment(env: Record<string, string | undefined>): LegacyEnv[] {
  const result: LegacyEnv[] = [];
  if (env.GH_TOKEN === "tavern-scope-denied") result.push("GH_TOKEN");
  if (Object.entries(env).some(([key, value]) => /^GIT_CONFIG_KEY_\d+$/.test(key) && /^url\.tavern-denied:\/\/\d+\/\.pushInsteadOf$/i.test(value ?? ""))) result.push("Git push block");
  return result;
}

export function armShellGrantCapability(file: string, binding: Binding, at: number, legacyEnv: LegacyEnv[] = []) {
  atomicWrite(capabilityFile(file), JSON.stringify(capabilitySchema.parse({ version: 1, threadId: binding.threadId, issuedAt: binding.issuedAt, at, pid: process.pid, legacyEnv })));
}

function sessionCapability(file: string, binding: Binding) {
  let active: z.infer<typeof scopeArmedSchema>;
  try {
    active = scopeArmedSchema.parse(JSON.parse(readFileSync(armedFile(file), "utf8")));
    if (active.hostBinding || binding.threadId !== active.threadId || binding.issuedAt !== active.issuedAt || active.at < binding.issuedAt) return null;
    process.kill(active.pid, 0);
  } catch { return null; }
  try {
    const meta = capabilitySchema.parse(JSON.parse(readFileSync(capabilityFile(file), "utf8")));
    if (active.threadId === meta.threadId && active.issuedAt === meta.issuedAt && active.at === meta.at && active.pid === meta.pid) return { legacyEnv: meta.legacyEnv };
  } catch (error) {
    if (!missing(error) && !(error instanceof SyntaxError) && !(error instanceof z.ZodError)) throw error;
  }
  return {};
}

export function hasShellGrantGuard(file: string, binding: Binding) {
  return sessionCapability(file, binding)?.legacyEnv !== undefined;
}

export function shellGrantCapable(file: string, binding: Binding) {
  return sessionCapability(file, binding)?.legacyEnv?.length === 0;
}

export function scopeRestartReason(file: string, binding: Binding) {
  const session = sessionCapability(file, binding);
  if (!session) return null;
  if (!session.legacyEnv) return "This session runs an older scope guard.";
  return session.legacyEnv.length ? `This session still has Tavern’s old ${session.legacyEnv.join(" and ")} environment settings.` : null;
}

export function shellGrantTarget(call: ScopeCall, parsed?: ShellCommand): ShellGrantTarget | null {
  const source = call.input.command ?? call.input.cmd;
  if (!["bash", "Bash"].includes(call.toolName) || typeof source !== "string" || source.length > 8000 || /[\0\r\n`$]/.test(source) || !isAbsolute(call.cwd)) return null;
  try {
    const list = parseScript(source), row = list[0], chain = row?.andOr, simple = chain?.first.commands[0];
    if (list.length !== 1 || row.background || chain.rest.length || chain.first.negated || chain.first.commands.length !== 1 || simple?.type !== "simple" || simple.redirects.length || simple.words.some(word => word.subs.length) || source.trim() !== source.slice(simple.start, simple.end)) return null;
    const [command] = parsed ? [parsed] : shellCommands(source, call.cwd);
    if (!command || command.uncertain || command.cwdAlternative || command.repository || command.gitEnvironment || command.githubEnvironment || realPath(command.cwd) !== realPath(call.cwd)) return null;
    const [program, group, verb] = command.argv;
    if (simple.words[0]?.text !== program || ["kubectl", "terraform", "helm", "kapp"].includes(program) || simple.words.some(word => /(?:[?*\[\]{}]|^~)/.test(word.text.replace(/'[^']*'|"[^"]*"/g, "")))) return null;
    const route = pullRequestRoute(command, false);
    const acts = route ? [route] : actsForCommand(command);
    const act = acts[0];
    if (acts.length !== 1 || !act) return null;
    const kind = shellGrantActSchema.safeParse(act.kind);
    if (!kind.success) return null;
    if (["gh", "dt"].includes(program) && group === "pr" && verb !== "create") {
      if (!prUrl(command.argv[3]) || !/\/pull\/[1-9]\d*$/.test(command.argv[3]) || command.argv.slice(4).some(arg => /^(?:--(?:body-file|input|add-reviewer|reviewer|repo|hostname)(?:=|$)|-[FrR])/.test(arg))) return null;
    }
    if (act.kind === "merge" && program !== "git") {
      const head = command.argv.findIndex(word => word === "--match-head-commit");
      const equals = command.argv.find(word => word.startsWith("--match-head-commit="));
      if (program !== "gh" || !/^[a-f0-9]{40,64}$/.test(head >= 0 ? command.argv[head + 1] ?? "" : equals?.slice(20) ?? "") || command.argv.some(arg => arg === "--auto")) return null;
    }
    if (program === "curl" && command.argv.slice(1).some(arg => /^--(?:config|location(?:-trusted)?|resolve|connect-to|proxy|preproxy|next)(?:=|$)|^-[^-]*[KL]/.test(arg) || arg.startsWith("@"))) return null;
    const push = program === "git" && group === "push" ? pushSpec(command.argv) : null;
    const pushTargets = push ? call.pushTargets?.[command.cwd + "\0" + push.remote] : undefined;
    if (push && (!pushTargets?.length || !push.refs.length || ["git-push-force", "git-push-target"].includes(act.ruleId))) return null;
    if (push && act.kind === "merge" && !push.refs.every(ref => /^[a-f0-9]{40,64}:(?:refs\/heads\/)?(?:main|master)$/.test(ref))) return null;
    const cwd = realPath(call.cwd);
    const destinations = pushTargets && [...new Set(pushTargets)].sort();
    return { act: kind.data, command: source, cwd, ...(destinations ? { destinations } : {}), digest: createHash("sha256").update(JSON.stringify([act.kind, cwd, source, destinations])).digest("hex") };
  } catch { return null; }
}

export function publishShellGrants(file: string, binding: Binding, grants: readonly ShellGrantProjection[]) {
  const target = grantFile(file), text = JSON.stringify(sidecar.parse({ version: 1, threadId: binding.threadId, issuedAt: binding.issuedAt, grants }));
  try { if (readFileSync(target, "utf8") === text) return false; }
  catch (error) { if (!missing(error)) throw error; }
  atomicWrite(target, text);
  return true;
}
export const removeShellGrantProjection = (file: string) => rmSync(grantFile(file), { force: true });

function readReceipt(path: string) {
  try { return receiptSchema.parse(JSON.parse(readFileSync(path, "utf8"))); }
  catch (error) { if (missing(error)) return null; throw error; }
}
export function shellGrantUse(file: string, id: string) {
  return readReceipt(usedFile(file, id))?.token ?? null;
}

export function readShellGrants(file: string, binding: Binding, observationId?: string) {
  const source = (() => {
    try { return readFileSync(grantFile(file), "utf8"); }
    catch (error) { if (missing(error)) return null; throw error; }
  })();
  if (source === null) return [];
  const projection = sidecar.parse(JSON.parse(source));
  if (projection.threadId !== binding.threadId || projection.issuedAt !== binding.issuedAt) return [];
  return projection.grants.filter(grant => {
    if (grant.scope === "quest") return true;
    const use = shellGrantUse(file, grant.id);
    return use === null || use === observationId;
  });
}

export function claimShellGrant(file: string, binding: Binding, id: string, receipt: string, commands: readonly string[]) {
  const grant = readShellGrants(file, binding).find(grant => grant.id === id);
  if (!grant) return false;
  const claim = grant.scope === "once" ? usedFile(file, id) : callFile(file, id, receipt);
  const proof = receiptSchema.parse({ token: receipt, commands: [...new Set(commands.map(commandDigest))] });
  try { writeFileSync(claim, JSON.stringify(proof), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
  return readShellGrants(file, binding, receipt).some(active => active.id === id);
}

export const forgetShellGrantCall = (file: string, id: string, receipt: string) => rmSync(callFile(file, id, receipt), { force: true });

export function checkShellGrantReceipt(file: string, id: string, receipt: string, command: string) {
  const digest = commandDigest(command);
  const once = readReceipt(usedFile(file, id));
  if (once?.token === receipt && once.commands.includes(digest)) return "once" as const;
  const quest = readReceipt(callFile(file, id, receipt));
  return quest?.token === receipt && quest.commands.includes(digest) ? "quest" as const : null;
}
