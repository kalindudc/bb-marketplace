import { appendFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { scopeForClass } from "./presets";
import { z } from "zod";
import { scopeControllerBindingSchema, scopeFileSchema, scopeHostBindingSchema, scopeSchema, type Scope, type ScopeControllerBinding, type ScopeHostBinding } from "./schema";
import type { ScopeCall } from "./engine";
import { communicationAuthoritySchema, sendToolsSchema, type SendTools } from "../shared/communication";
import type { ActKind } from "./acts";
export interface ActAudit { threadId: string; providerId: string; at: number; eventId: string; seq: number; kind: ActKind; call: ScopeCall; mode: "watch" | "enforce" }

export interface ScopeRecord { file: string; scope: Scope | null; template?: Scope; error?: string; mode?: Scope["mode"]; binding?: ScopeControllerBinding; presetProvenance?: { id: Scope["preset"]; version: string } }
export interface Violation { threadId: string; providerId: string; at: number; eventId: string; seq: number; ruleId: string; reason: string; call?: ScopeCall; latencyMs: number; stopped: boolean; prevented?: true; stopError?: string; mode?: "enforce" | "watch"; act?: ActKind }
export const scopeObservationBindingSchema = scopeHostBindingSchema.extend({ hostId: z.string().min(1).max(200), cwd: z.string().min(1).max(32768) }).strict();
export type ScopeObservationBinding = z.infer<typeof scopeObservationBindingSchema>;
const observationHoldSchema = z.object({
  threadId: scopeSchema.shape.threadId, providerId: z.string().min(1).max(200), eventId: z.string().min(1).max(200),
  seq: z.number().int().nonnegative(), at: z.number().int().nonnegative(), reason: z.string().min(1).max(16384), binding: scopeObservationBindingSchema.optional(),
}).strict();
export type ScopeObservationHold = z.infer<typeof observationHoldSchema>;
const progressSchema = z.object({ cursor: z.number().int().nonnegative(), pendingStop: z.boolean(), pendingBinding: scopeObservationBindingSchema.optional() }).strict();
export interface NativeScopeReceipt { hostBinding: ScopeHostBinding; renderedDigest: string }
export const scopeArmedSchema = z.object({
  threadId: scopeSchema.shape.threadId, issuedAt: scopeSchema.shape.issuedAt, pid: z.number().int().positive(), at: z.number().int().nonnegative(),
  clusterWrites: z.literal(1).optional(), mergeGuard: z.literal(1).optional(), sendGuard: z.literal(1).optional(), messagePolicyProblem: z.string().optional(), hostBinding: scopeHostBindingSchema.optional(), renderedDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().refine(value => (value.hostBinding === undefined) === (value.renderedDigest === undefined), "A native receipt requires its binding and rendered-byte digest together");
export const armedFile = (file: string) => file.replace(/\.json$/, "") + ".armed";
export function atomicWrite(file: string, value: string, check?: () => void): void {
  const temp = file + "." + randomUUID() + ".tmp";
  try { check?.(); writeFileSync(temp, value, { mode: 0o600, flag: "wx" }); check?.(); renameSync(temp, file); }
  finally { rmSync(temp, { force: true }); }
}
export function armScope(file: string, scope: Scope, native?: NativeScopeReceipt, at = Date.now(), messagePolicyProblem?: string, mergeGuard = false): void {
  atomicWrite(armedFile(file), JSON.stringify(scopeArmedSchema.parse({ threadId: scope.threadId, issuedAt: scope.issuedAt, pid: process.pid, at, clusterWrites: 1,
    ...(mergeGuard ? { mergeGuard: 1 } : {}), ...(messagePolicyProblem ? { messagePolicyProblem } : { sendGuard: 1 }), ...native })));
}
const messagePolicySchema = z.object({
  threadId: scopeSchema.shape.threadId, issuedAt: scopeSchema.shape.issuedAt, scopeDigest: z.string().optional(),
  sendTools: sendToolsSchema.optional(), communicationAuthority: communicationAuthoritySchema.optional(),
}).strict();
export function splitMessagePolicy({ sendTools, communicationAuthority, ...scope }: Scope) {
  return { scope, policy: { ...(sendTools?.length ? { sendTools } : {}), ...(communicationAuthority ? { communicationAuthority } : {}) } };
}
const messagePolicyFile = (file: string) => file + ".message-policy";
export function writeMessagePolicy(file: string, scope: Scope, scopeDigest?: string, check?: () => void) {
  const { threadId, issuedAt, sendTools, communicationAuthority } = scope;
  check?.();
  if (!sendTools?.length && !communicationAuthority) {
    rmSync(messagePolicyFile(file), { force: true });
    return;
  }
  atomicWrite(messagePolicyFile(file), JSON.stringify(messagePolicySchema.parse({ threadId, issuedAt, scopeDigest, sendTools, communicationAuthority })), check);
}
export class MessagePolicyError extends Error {
  constructor(readonly sendTools?: SendTools, cause?: unknown) {
    super("The private message policy is invalid or does not match this scope; ask the Keeper to repair it.", { cause });
  }
}
export function readMessagePolicy(file: string, scope: Scope, scopeDigest?: string): Scope {
  const path = messagePolicyFile(file);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 256 * 1024) throw new Error("Invalid private message policy");
    const { threadId, issuedAt, scopeDigest: recorded, ...policy } = messagePolicySchema.parse(JSON.parse(readFileSync(path, "utf8")));
    if (threadId !== scope.threadId || issuedAt !== scope.issuedAt || recorded !== scopeDigest) throw new MessagePolicyError(policy.sendTools);
    return { ...scope, ...policy };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return scope;
    throw error instanceof MessagePolicyError ? error : new MessagePolicyError(undefined, error);
  }
}

export class ScopeStore {
  readonly directory: string;
  readonly records = new Map<string, ScopeRecord>();
  private readonly revisions = new Map<string, number>();
  revision(threadId: string): number { return this.revisions.get(threadId) ?? 0; }
  constructor(readonly dataDir: string) {
    this.directory = join(dataDir, "scopes");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const ids = new Set(readdirSync(this.directory).flatMap(name => /^([a-zA-Z0-9_-]{1,100})\.json(?:\.host)?$/.exec(name)?.slice(1) ?? []));
    for (const id of ids) {
      const file = this.file(id);
      let binding: ScopeControllerBinding | undefined, markerError: string | undefined;
      try { binding = scopeControllerBindingSchema.parse(JSON.parse(readFileSync(file + ".host", "utf8"))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { binding = { kind: "host", placementId: null, generation: null }; markerError = "Invalid host-binding marker: " + String(error); } }
      try {
        const { bindingTemplate: template, bindingError, controllerBinding, presetProvenance, ...base } = scopeFileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
        let scope = base;
        try { scope = readMessagePolicy(file, base); }
        catch (error) { if (!(error instanceof MessagePolicyError)) throw error; }
        if (scope.threadId !== id) throw new Error("Scope identity does not match its filename");
        const incomplete = binding && JSON.stringify(binding) !== JSON.stringify(controllerBinding);
        binding ??= controllerBinding;
        this.records.set(id, { file, scope, template: template ? { ...template, ...splitMessagePolicy(scope).policy } : undefined, presetProvenance, error: markerError ?? (incomplete ? "Host-bound template update is incomplete" : bindingError), mode: scope.mode, ...(binding ? { binding } : {}) });
      } catch (error) { this.records.set(id, { file, scope: null, error: String(error), ...(binding ? { binding } : {}) }); }
    }
  }
  file(threadId: string): string {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(threadId)) throw new Error("Invalid scoped thread id");
    return join(this.directory, threadId + ".json");
  }
  markHostBinding(threadId: string, input: ScopeControllerBinding): ScopeControllerBinding {
    const parsed = scopeControllerBindingSchema.parse(input), current = this.records.get(threadId);
    const previous = current?.binding;
    if (previous?.placementId !== null && previous?.placementId !== undefined && parsed.placementId !== null) {
      if (previous.placementId !== parsed.placementId) throw new Error("Release the original placement scope before binding another placement");
      if (parsed.generation! < previous.generation!) throw new Error("Cannot replace a host scope with an older generation");
    }
    const binding = previous?.placementId && parsed.placementId === null ? previous : parsed;
    if (JSON.stringify(previous) === JSON.stringify(binding)) return binding;
    // Persist classification first so an interrupted template write cannot restore local binding.
    atomicWrite(this.file(threadId) + ".host", JSON.stringify(binding));
    this.revisions.set(threadId, this.revision(threadId) + 1);
    this.records.set(threadId, { file: this.file(threadId), scope: null, error: "Host-bound template is not yet written", ...current, binding });
    return binding;
  }
  refreshPresetTools(threadId: string): "updated" | "skipped" | "current" {
    const record = this.records.get(threadId);
    if (!record?.scope || record.error) return "skipped";
    const helpers = ["check_ui", "ui_examples"];
    const scopes = [record.scope, ...(record.template ? [record.template] : [])];
    if (scopes.every(scope => scope.tools.allow.includes("*") || helpers.every(name => scope.tools.allow.includes(name)))) return "current";
    const matches = (scope: Scope) => {
      const preset = scopeForClass(scope.role, undefined, scope.preset);
      return [helpers, [...helpers, "write", "Write", "edit", "Edit"]].some(removed => {
        const previous = preset.tools.allow.filter(name => !removed.includes(name));
        return previous.length === scope.tools.allow.length && previous.every((name, index) => scope.tools.allow[index] === name);
      }) && helpers.every(name => preset.tools.allow.includes(name));
    };
    if (!scopes.every(matches)) return "skipped";
    const refresh = (scope: Scope): Scope => ({ ...scope, tools: { ...scope.tools, allow: [...scope.tools.allow, ...helpers] } });
    this.write(threadId, refresh(record.scope), record.template ? refresh(record.template) : undefined);
    return "updated";
  }
  write(threadId: string, input: Scope, template = this.records.get(threadId)?.template, error?: string, preserveProvenance = false): Scope {
    const file = this.file(threadId);
    const scope = scopeSchema.parse({ ...input, threadId });
    const binding = this.records.get(threadId)?.binding;
    const preset = scopeForClass(scope.role, undefined, scope.preset);
    const presetProvenance = preserveProvenance ? this.records.get(threadId)?.presetProvenance : { id: scope.preset, version: createHash("sha256").update(JSON.stringify({ ...preset, role: "", threadId: "", issuedAt: 0 })).digest("hex") };
    const { scope: base } = splitMessagePolicy(scope);
    const original = template && splitMessagePolicy(template).scope;
    const value = scopeFileSchema.parse({ ...base, presetProvenance, ...(original ? { bindingTemplate: original } : {}), ...(error === undefined ? {} : { bindingError: error }), ...(binding ? { controllerBinding: binding } : {}) });
    writeMessagePolicy(file, scope);
    atomicWrite(file, JSON.stringify(value, null, 2) + "\n");
    this.records.set(threadId, { file, scope, template: value.bindingTemplate && { ...value.bindingTemplate, ...splitMessagePolicy(template!).policy }, presetProvenance, error, mode: scope.mode, ...(binding ? { binding } : {}) });
    return scope;
  }
  failBinding(threadId: string, error: unknown): void {
    const record = this.records.get(threadId);
    if (record?.scope) this.write(threadId, record.scope, record.template, "Scope binding failed: " + String(error), true);
  }
  setMode(threadId: string, mode: Scope["mode"]): void {
    const record = this.records.get(threadId);
    if (!record) return;
    if (record.scope) {
      const enforceFrom = mode === "enforce" && record.scope.mode !== "enforce" ? Date.now() : record.scope.enforceFrom;
      const scope = { ...record.scope, mode, ...(enforceFrom === undefined ? {} : { enforceFrom }) };
      this.write(threadId, scope, record.template ? { ...record.template, mode, ...(enforceFrom === undefined ? {} : { enforceFrom }) } : undefined, record.error, true); return;
    }
    let source: string;
    try { source = readFileSync(record.file, "utf8"); }
    catch (error) {
      if (record.binding && (error as NodeJS.ErrnoException).code === "ENOENT") { this.records.set(threadId, { ...record, mode }); return; }
      throw error;
    }
    let raw: unknown;
    try { raw = JSON.parse(source); } catch { raw = { invalidScope: source }; }
    const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : { invalidScope: raw };
    atomicWrite(record.file, JSON.stringify({ ...value, mode }));
    this.records.set(threadId, { ...record, mode });
  }
  clear(threadId: string): void {
    const file = this.file(threadId);
    rmSync(file, { force: true }); rmSync(armedFile(file), { force: true }); rmSync(file + ".cursor", { force: true }); rmSync(file + ".hold", { force: true }); rmSync(file + ".host", { force: true });
    rmSync(file + ".grants", { force: true, recursive: true });
    rmSync(file + ".act-grants", { force: true, recursive: true });
    rmSync(file + ".messages", { force: true, recursive: true });
    rmSync(messagePolicyFile(file), { force: true });
    this.records.delete(threadId);
    this.revisions.set(threadId, this.revision(threadId) + 1);
  }
  arm(scope: Scope): void { armScope(this.file(scope.threadId), scope); }
  private liveMarker(threadId: string) {
    try {
      const record = this.records.get(threadId);
      if (!record?.scope || record.binding) return;
      const marker = scopeArmedSchema.parse(JSON.parse(readFileSync(armedFile(record.file), "utf8")));
      if (marker.hostBinding || marker.threadId !== threadId || marker.issuedAt !== record.scope.issuedAt || marker.at < record.scope.issuedAt) return;
      process.kill(marker.pid, 0);
      return marker;
    } catch { return; }
  }
  messagePolicyProblem(threadId: string): string | undefined {
    const record = this.records.get(threadId);
    if (!record?.scope || record.binding) return;
    try {
      const base = scopeFileSchema.parse(JSON.parse(readFileSync(record.file, "utf8")));
      readMessagePolicy(record.file, base);
    } catch (error) { if (error instanceof MessagePolicyError) return error.message; }
    return this.liveMarker(threadId)?.messagePolicyProblem;
  }
  mergeGuardSession(threadId: string): string | undefined {
    const marker = this.records.get(threadId)?.scope?.mode === "enforce" && this.liveMarker(threadId);
    if (marker && marker.mergeGuard === 1) return `${marker.pid}:${marker.at}`;
  }
  isArmed(threadId: string, clusterWrites = false, sendGuard = false): boolean {
    const marker = this.liveMarker(threadId);
    return !!marker && (!clusterWrites || marker.clusterWrites === 1) && (!sendGuard || marker.sendGuard === 1 && !this.messagePolicyProblem(threadId));
  }
  observationHold(threadId: string): ScopeObservationHold | null {
    try { return observationHoldSchema.parse(JSON.parse(readFileSync(this.file(threadId) + ".hold", "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  saveObservationHold(value: ScopeObservationHold): void {
    const hold = observationHoldSchema.parse(value);
    atomicWrite(this.file(hold.threadId) + ".hold", JSON.stringify(hold));
  }
  clearObservationHold(threadId: string): void { rmSync(this.file(threadId) + ".hold", { force: true }); }
  progress(threadId: string): z.infer<typeof progressSchema> {
    try {
      return progressSchema.parse(JSON.parse(readFileSync(this.file(threadId) + ".cursor", "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { cursor: Math.max(0, ...this.violations(threadId).map(row => row.seq)), pendingStop: false };
    }
  }
  saveProgress(threadId: string, cursor: number, pendingStop = this.progress(threadId).pendingStop, pendingBinding?: ScopeObservationBinding): void {
    atomicWrite(this.file(threadId) + ".cursor", JSON.stringify(progressSchema.parse({ cursor, pendingStop, ...(pendingStop && pendingBinding ? { pendingBinding } : {}) })));
  }
  recordAct(act: ActAudit): void { appendFileSync(join(this.dataDir, "scope-acts.jsonl"), JSON.stringify(act) + "\n", { mode: 0o600 }); }
  acts(threadId?: string): ActAudit[] {
    let source: string;
    try { source = readFileSync(join(this.dataDir, "scope-acts.jsonl"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return source.split("\n").filter(Boolean).map(line => JSON.parse(line) as ActAudit).filter(row => !threadId || row.threadId === threadId);
  }
  record(violation: Violation): void { appendFileSync(join(this.dataDir, "scope-violations.jsonl"), JSON.stringify(violation) + "\n", { mode: 0o600 }); }
  violations(threadId?: string): Violation[] {
    let source: string;
    try { source = readFileSync(join(this.dataDir, "scope-violations.jsonl"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return source.split("\n").filter(Boolean).map(line => JSON.parse(line) as Violation).filter(row => !row.ruleId.startsWith("act:") && (!threadId || row.threadId === threadId));
  }
}
