import { readFileSync, mkdirSync, existsSync, openSync, closeSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { parseDocument } from "yaml";
import { z } from "zod";
import { classScopeSchema, scopeOverrideSchema, type Scope, type ScopeOverride, type ClassScope } from "./schema";
import { scopeForClass } from "./presets";
import { normalizeRemote } from "./remote";
import { atomicWrite } from "./store";

const classPolicySchema = z.object({ defaults: scopeOverrideSchema.optional(), keeperMayAllow: z.array(z.string()).optional() }).strict();
export const policySchema = z.object({ v: z.literal(1), rules: z.array(z.object({ remote: z.string().optional(), classes: z.record(z.string(), classPolicySchema) }).strict()) }).strict();
export interface ProjectContext { projectRoot?: string; remotes?: string[]; pushRemote?: string }
export interface PolicyOptions { home?: string; shipped?: z.infer<typeof policySchema> }
export interface ScopeResolution { scope: Scope; widenings: string[]; problems: string[] }
const builtinRules: Record<string, string[]> = { "git-push-main": ["git", "push"], "git-push-force": ["git", "push"], "git-push-target": ["git", "push"] };
export function wideningIds(override: ScopeOverride): string[] {
  return [...override.allowRules ?? [], ...override.tools?.allow?.map(name => "tool:" + name) ?? [], ...override.tools?.removeDeny?.map(name => "tool-deny:" + name) ?? [], ...override.writes?.allow?.map(path => "write:" + path) ?? []];
}
export function mergeOverride(base: Scope, input: ScopeOverride, remote?: string): Scope {
  const override = scopeOverrideSchema.parse(input), scope = structuredClone(base);
  for (const id of override.allowRules ?? []) {
    const denied = scope.shell.deny.find(rule => rule.id === id), argv = denied?.argv ?? builtinRules[id];
    if (!denied && !argv) throw new Error("Unknown scope rule id: " + id);
    scope.shell.allow = scope.shell.allow.filter(rule => rule.id !== id || rule.remote !== remote);
    scope.shell.allow.push({ ...(denied ?? { id, argv, why: "Allowed by user-controlled scope policy or explicit user approval" }), ...(remote ? { remote: normalizeRemote(remote) } : {}) });
  }
  for (const rule of override.denyRules ?? []) {
    scope.shell.allow = scope.shell.allow.filter(existing => existing.id !== rule.id);
    scope.shell.deny.push(rule);
  }
  scope.tools.allow = [...new Set([...scope.tools.allow.filter(name => !override.tools?.removeAllow?.includes(name)), ...override.tools?.allow ?? []])];
  scope.tools.deny = [...new Set([...scope.tools.deny.filter(name => !override.tools?.removeDeny?.includes(name)), ...override.tools?.deny ?? []])];
  scope.writes.allow = [...new Set([...scope.writes.allow, ...override.writes?.allow ?? []])];
  scope.writes.deny = [...new Set([...scope.writes.deny, ...override.writes?.deny ?? []])];
  return scope;
}
const narrowing = (override: ScopeOverride): ScopeOverride => ({ denyRules: override.denyRules, tools: { deny: override.tools?.deny, removeAllow: override.tools?.removeAllow }, writes: { deny: override.writes?.deny } });

export class ScopePolicy {
  readonly home: string;
  constructor(private readonly options: PolicyOptions = {}) { this.home = options.home ?? homedir(); }
  policy(context: ProjectContext) {
    const sources = [{ path: "shipped", trusted: true, policy: policySchema.parse(this.options.shipped ?? { v: 1, rules: [] }) }];
    for (const [path, trusted] of [[join(this.home, ".agents/tavern/scopes.yml"), true], ...(context.projectRoot ? [[join(context.projectRoot, ".agents/tavern/scopes.yml"), false] as const] : [])] as const) {
      let source: string;
      try { source = readFileSync(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      const document = parseDocument(source);
      if (document.errors.length) throw new Error("Invalid scope policy " + path + ": " + document.errors[0].message);
      sources.push({ path, trusted, policy: policySchema.parse(document.toJS()) });
    }
    const problems: string[] = [];
    const entries = sources.flatMap(source => source.policy.rules.flatMap(rule => Object.entries(rule.classes).map(([classId, policy]) => {
      if (!source.trusted) {
        if (wideningIds(policy.defaults ?? {}).length || policy.keeperMayAllow?.length) problems.push(source.path + ": ignored widening for " + classId + "; project policies may only narrow");
        return { classId, path: source.path, remote: rule.remote, defaults: narrowing(policy.defaults ?? {}), keeperMayAllow: [] as string[] };
      }
      if (rule.remote && [...policy.defaults?.tools?.allow ?? [], ...policy.defaults?.tools?.removeDeny ?? [], ...policy.defaults?.writes?.allow ?? []].length) problems.push(source.path + ": remote-scoped tool and path widening ignored; only Git push rule grants can bind a destination");
      const remoteGrants = [...policy.defaults?.allowRules ?? [], ...policy.keeperMayAllow ?? []];
      if (rule.remote && remoteGrants.some(id => !id.startsWith("git-push"))) problems.push(source.path + ": remote-scoped non-push grants ignored; use an explicit global rule for other capabilities");
      return { classId, path: source.path, remote: rule.remote, defaults: rule.remote ? { ...narrowing(policy.defaults ?? {}), allowRules: policy.defaults?.allowRules?.filter(id => id.startsWith("git-push")) } : policy.defaults ?? {}, keeperMayAllow: (policy.keeperMayAllow ?? []).filter(id => !rule.remote || id.startsWith("git-push")) };
    })));
    const classes: Record<string, z.infer<typeof classPolicySchema>> = {};
    for (const entry of entries) {
      const previous = classes[entry.classId];
      classes[entry.classId] = { defaults: entry.defaults, keeperMayAllow: [...new Set([...previous?.keeperMayAllow ?? [], ...entry.keeperMayAllow])] };
    }
    return { sources, entries, classes, problems };
  }
  resolve(classId: string, context: ProjectContext, override: ScopeOverride = {}, definition?: ClassScope): ScopeResolution {
    const policy = this.policy(context), problems = [...policy.problems];
    let base = scopeForClass(classId);
    if (definition !== undefined) {
      const chosen = classScopeSchema.parse(definition), preset = typeof chosen === "string" ? chosen : chosen.preset;
      const safe = preset === base.preset || base.preset === "open" || (["worktree", "checker"].includes(base.preset) && preset === "readonly");
      if (!safe) problems.push("Ignored class scope preset " + preset + " for " + classId + "; class files may only narrow the shipped preset");
      try {
        const narrowed = scopeForClass(classId, undefined, typeof chosen === "string" ? safe ? chosen : base.preset : { ...chosen, preset: safe ? preset : base.preset });
        narrowed.tools.deny = [...new Set([...base.tools.deny, ...narrowed.tools.deny])];
        narrowed.writes.deny = [...new Set([...base.writes.deny, ...narrowed.writes.deny])];
        narrowed.shell.deny.push(...base.shell.deny.filter(rule => !narrowed.shell.deny.some(other => other.id === rule.id)));
        base = narrowed;
      } catch (error) { problems.push("Ignored widening class scope for " + classId + ": " + String(error)); }
    }
    for (const entry of policy.entries.filter(entry => entry.classId === classId)) base = mergeOverride(base, entry.defaults, entry.remote);
    const result = this.apply(base, context, override);
    return { ...result, problems: [...new Set([...problems, ...result.problems])] };
  }
  apply(scope: Scope, context: ProjectContext, input: ScopeOverride, approved: readonly string[] = []): ScopeResolution {
    const override = scopeOverrideSchema.parse(input), policy = this.policy(context);
    mergeOverride(scope, override);
    const permits = policy.entries.filter(entry => entry.classId === scope.role);
    const existing = new Set(scope.shell.allow.filter(rule => !rule.remote).map(rule => rule.id));
    const widenings = wideningIds(override).filter(id => !approved.includes(id) && !existing.has(id) && !permits.some(entry => entry.keeperMayAllow.includes(id)));
    if (widenings.length) return { scope: mergeOverride(scope, narrowing(override)), widenings: [...new Set(widenings)], problems: policy.problems };
    let candidate = mergeOverride(scope, { ...override, allowRules: [] });
    for (const id of override.allowRules ?? []) {
      const permission = permits.filter(entry => entry.keeperMayAllow.includes(id));
      if (approved.includes(id) || existing.has(id) || permission.some(entry => !entry.remote)) candidate = mergeOverride(candidate, { allowRules: [id] });
      else for (const entry of permission) candidate = mergeOverride(candidate, { allowRules: [id] }, entry.remote);
    }
    return { scope: candidate, widenings: [], problems: policy.problems };
  }
  rememberWidening(context: ProjectContext, classId: string, ruleIds: string[], _target?: "project" | "global"): string {
    if (ruleIds.some(id => !id.startsWith("git-push"))) throw new Error("Only Git push grants can be remembered by remote; edit the global policy explicitly for other capabilities");
    const remotes = [...new Set((context.remotes ?? []).map(normalizeRemote))];
    const remote = context.pushRemote ? normalizeRemote(context.pushRemote) : remotes.length === 1 ? remotes[0] : undefined;
    if (!remote || !remotes.includes(remote) || /[*?\[\]]/.test(remote)) throw new Error("Remembering a widening needs an unambiguous trusted push remote; choose the actual destination");
    const file = join(this.home, ".agents/tavern/scopes.yml");
    mkdirSync(dirname(file), { recursive: true });
    const lock = file + ".lock", fd = openSync(lock, "wx", 0o600);
    try {
      const document = parseDocument(existsSync(file) ? readFileSync(file, "utf8") : "v: 1\nrules: []\n");
      if (document.errors.length) throw new Error("Cannot edit invalid policy: " + file);
      policySchema.parse(document.toJS());
      const defaults = { allowRules: [...new Set(ruleIds)] };
      mergeOverride(scopeForClass(classId), defaults);
      document.addIn(["rules"], { remote, classes: { [classId]: { defaults } } });
      policySchema.parse(document.toJS()); atomicWrite(file, document.toString());
      return file;
    } finally { closeSync(fd); unlinkSync(lock); }
  }
}
