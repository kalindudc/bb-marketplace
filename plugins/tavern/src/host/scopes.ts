import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { hostContract, type Authority, type HostInput, type HostOutput } from "../host-contract";
import { envForScope } from "../scope/env";
import { evaluate, type ScopeCall } from "../scope/engine";
import { prepareCall as prepareFacts } from "../scope/prepare";
import { nativeScopeVariablesSchema } from "../scope/host-env";
import { piAgentDir } from "../scope/install";
import { bindPaths, realPath } from "../scope/paths";
import { scopeDeliveryFileSchema, scopeHostBindingSchema, scopeRenderedFileSchema, scopeSchema, type Scope, type ScopeDeliveryFile, type ScopeHostBinding } from "../scope/schema";
import { atomicWrite, scopeArmedSchema } from "../scope/store";
import { bindWorktree } from "../scope/worktree";
import { assertRepository, hostContext, onCheckout, type HostContext } from "./context";
import { abortError, runProcess } from "./process";
import { gitEnvironment, runGit } from "./git";
import { authorityOf, HostError, HostRegistry, type RegisteredEndpoint } from "./registry";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const bindingRecordSchema = z.object({
  state: z.enum(["binding", "bound"]), binding: scopeHostBindingSchema,
  deliveryJson: z.string().max(2 * 1024 * 1024), renderedJson: z.string().max(4 * 1024 * 1024), renderedDigest: z.string().regex(/^[a-f0-9]{64}$/),
  variables: nativeScopeVariablesSchema,
}).strict();
const scopeRecordSchema = z.union([bindingRecordSchema, z.object({ state: z.literal("released") }).strict()]);
type BindingRecord = z.infer<typeof bindingRecordSchema>;
export interface NativeScopePaths { home: string; tmp: string[]; piAgentDir: string }
export interface NativeScopeOptions { paths?: NativeScopePaths }

export class NativeScopes {
  constructor(readonly registry: HostRegistry, private readonly options: NativeScopeOptions = {}) {}
  private paths(): NativeScopePaths {
    return this.options.paths ?? { home: realpathSync(homedir()), tmp: [...new Set([tmpdir(), realpathSync(tmpdir())])], piAgentDir: piAgentDir() };
  }
  private record(authority: Authority) {
    const record = this.registry.readScopeState(authority, scopeRecordSchema);
    if (record && record.state !== "released" && (record.binding.placementId !== authority.placementId || record.binding.generation !== authority.generation || record.binding.endpointId !== authority.endpointId))
      throw new HostError("scope-authority", "The private scope binding belongs to another placement, generation or endpoint.");
    return record;
  }
  private check(context: HostContext, binding: ScopeHostBinding): void {
    context.active();
    const current = this.record(context.authority);
    if (current?.state === "released") throw new HostError("scope-released", "This native scope was released; reconcile the placement before delivering again.");
    if (current && current.binding.revision > binding.revision) throw new HostError("scope-stale", "A newer scope revision is already bound.");
    if (current && current.binding.revision === binding.revision && current.binding.scopeDigest !== binding.scopeDigest) throw new HostError("scope-conflict", "The same scope revision cannot contain different delivery bytes.");
  }
  private writeRecord(authority: Authority, value: z.infer<typeof scopeRecordSchema>, check: () => void): void {
    const json = JSON.stringify(scopeRecordSchema.parse(value));
    atomicWrite(this.registry.scopeStatePath(authority, "binding.json"), json, check);
  }
  private workspace(delivery: ScopeDeliveryFile, authority: Authority, endpoint: RegisteredEndpoint): void {
    const trusted = delivery.workspaceBinding, registered = endpoint.registration;
    if (trusted.placementId !== authority.placementId || trusted.generation !== authority.generation || trusted.hostId !== registered.endpoint.hostId || trusted.environmentId !== registered.endpoint.environmentId || trusted.root !== endpoint.realRoot || trusted.kind !== registered.workspaceKind || delivery.threadId !== registered.ownerThreadId)
      throw new HostError("scope-workspace", "The scope's trusted workspace does not match this registered member endpoint; reconcile its host, owner, root and generation.");
    const metadata = lstatSync(join(endpoint.realRoot, ".git"));
    if (trusted.kind === "linked-worktree" ? !metadata.isFile() : !metadata.isFile() && !metadata.isDirectory())
      throw new HostError("scope-workspace", "The registered workspace mode does not match its native Git metadata.");
    if (trusted.expectedTree && trusted.expectedTree.length !== (endpoint.inspection?.objectFormat === "sha256" ? 64 : 40))
      throw new HostError("object-format-mismatch", "The scope's expected tree does not match the inspected repository object format.");
  }
  private render(delivery: ScopeDeliveryFile, authority: Authority, endpoint: RegisteredEndpoint): Scope {
    const template = structuredClone(delivery.bindingTemplate), native = this.paths();
    const storageId = delivery.bindingEndpoints?.threadStorage;
    let threadStorage: string | undefined;
    if (storageId) {
      const storage = this.registry.endpoint({ ...authority, endpointId: storageId }, ["artifact-read"]);
      if (storage.registration.ownerThreadId !== endpoint.registration.ownerThreadId || storage.registration.endpoint.hostId !== endpoint.registration.endpoint.hostId)
        throw new HostError("scope-storage", "The declared thread storage endpoint belongs to another member or host; reconcile core storage before binding.");
      threadStorage = storage.realRoot;
    }
    delete template.env.variables.BB_THREAD_STORAGE;
    const core = { ...template, workspaceKind: delivery.workspaceBinding.kind, expectedWorktree: endpoint.realRoot,
      ...(template.checks ? { checks: { ...template.checks, worktree: endpoint.realRoot } } : {}),
      writes: { ...template.writes, deny: [...template.writes.deny, join(native.piAgentDir, "extensions")] },
    };
    const scope = scopeSchema.parse(bindPaths(bindWorktree(core, endpoint.realRoot), { home: realpathSync(native.home), tmp: native.tmp, scopesDir: this.registry.dataDir, worktree: endpoint.realRoot, ...(threadStorage ? { threadStorage } : {}) }, realPath));
    nativeScopeVariablesSchema.parse(scope.env.variables);
    const entries = envForScope(new Map([[scope.threadId, { file: this.registry.scopeStatePath(authority, "scope.json"), scope }]]), scope.threadId);
    if (entries.length > 32 || new Set(entries.map(entry => entry.name)).size !== entries.length)
      throw new HostError("scope-env-budget", "The native scope environment exceeds the SDK's 32-entry budget or repeats a reserved speed-bump variable; narrow its configured variables.");
    return scope;
  }
  private rendered(record: BindingRecord): Scope {
    if (digest(record.renderedJson) !== record.renderedDigest || digest(record.deliveryJson) !== record.binding.scopeDigest)
      throw new HostError("scope-integrity", "The private rendered scope or exact delivery digest changed; reconcile its stored policy.");
    const { bindingTemplate: _template, hostBinding, ...scope } = scopeRenderedFileSchema.parse(JSON.parse(record.renderedJson));
    if (JSON.stringify(hostBinding) !== JSON.stringify(record.binding) || JSON.stringify(scope.env.variables) !== JSON.stringify(record.variables))
      throw new HostError("scope-integrity", "The rendered scope binding or native variables no longer match its acknowledgment.");
    return scope;
  }
  private intact(authority: Authority, record: BindingRecord): Scope {
    const file = this.registry.scopeStatePath(authority, "scope.json");
    let json: string;
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error("The native scope is not a regular private file");
      json = readFileSync(file, "utf8");
    } catch { throw new HostError("scope-integrity", "The acknowledged native scope is missing or not a regular private file; reconcile a new revision."); }
    if (digest(json) !== record.renderedDigest || json !== record.renderedJson || digest(record.deliveryJson) !== record.binding.scopeDigest)
      throw new HostError("scope-integrity", "The acknowledged native scope bytes or delivery digest changed; reconcile a new revision rather than retrying altered policy.");
    return this.rendered(record);
  }
  private acknowledged(authority: Authority, revision: number, scopeDigest?: string, signal?: AbortSignal): { record: BindingRecord; scope: Scope } {
    if (signal?.aborted) throw abortError();
    this.registry.endpoint(authority, ["member-write"]);
    const record = this.record(authority);
    if (!record || record.state !== "bound") throw new HostError("scope-unavailable", "No current acknowledged native scope is bound to this endpoint.");
    if (record.binding.revision !== revision || scopeDigest !== undefined && record.binding.scopeDigest !== scopeDigest)
      throw new HostError("scope-stale", "The requested scope revision or delivery digest is not the current native acknowledgment.");
    return { record, scope: this.intact(authority, record) };
  }
  async bindScope(raw: HostInput<"bindScope">, signal?: AbortSignal): Promise<HostOutput<"bindScope">> {
    const input = hostContract.bindScope.input.parse(raw), authority = authorityOf(input);
    if (digest(input.scopeFileJson) !== input.scopeDigest) throw new HostError("scope-digest", "The scope digest must hash the exact incoming UTF-8 bytes, without normalization.");
    const delivery = scopeDeliveryFileSchema.parse(JSON.parse(input.scopeFileJson));
    const binding = scopeHostBindingSchema.parse({ placementId: authority.placementId, generation: authority.generation, endpointId: authority.endpointId, revision: input.revision, scopeDigest: input.scopeDigest });
    const result = await this.registry.operation(authority, signal, combined => onCheckout(this.registry.scopeStatePath(authority, "binding.json"), combined, async () => {
      const context = hostContext(this.registry, authority, ["member-write"], combined), check = () => this.check(context, binding);
      check(); this.workspace(delivery, authority, context.endpoint);
      const previous = this.record(authority);
      if (previous && previous.state !== "released" && previous.binding.revision === input.revision && previous.deliveryJson !== input.scopeFileJson)
        throw new HostError("scope-conflict", "The same scope revision cannot contain different exact delivery bytes.");
      await assertRepository(context); check();
      if (previous?.state === "bound" && previous.binding.revision === input.revision) {
        this.intact(authority, previous); check();
        return hostContract.bindScope.output.parse({ revision: input.revision, scopeDigest: input.scopeDigest, scopeFile: this.registry.scopeStatePath(authority, "scope.json"), variables: previous.variables });
      }
      let record: BindingRecord;
      if (previous?.state === "binding" && previous.binding.revision === input.revision) {
        this.rendered(previous); record = previous;
      } else {
        const scope = this.render(delivery, authority, context.endpoint);
        const renderedJson = JSON.stringify(scopeRenderedFileSchema.parse({ ...scope, bindingTemplate: delivery.bindingTemplate, hostBinding: binding }), null, 2) + "\n";
        record = bindingRecordSchema.parse({ state: "binding", binding, deliveryJson: input.scopeFileJson, renderedJson, renderedDigest: digest(renderedJson), variables: scope.env.variables });
      }
      this.writeRecord(authority, record, check);
      atomicWrite(this.registry.scopeStatePath(authority, "scope.json"), record.renderedJson, check);
      check(); rmSync(this.registry.scopeStatePath(authority, "scope.armed"), { force: true });
      this.writeRecord(authority, { ...record, state: "bound" }, check); check();
      return hostContract.bindScope.output.parse({ revision: input.revision, scopeDigest: input.scopeDigest, scopeFile: this.registry.scopeStatePath(authority, "scope.json"), variables: record.variables });
    }));
    this.acknowledged(authority, input.revision, input.scopeDigest, signal);
    return result;
  }
  private async facts(context: HostContext, scope: Scope, call: ScopeCall, check: () => void): Promise<ScopeCall> {
    type Query = { program: string; args: string[]; cwd: string };
    const cached = new Map<string, { code: number | null; stdout: string }>(), deadline = Date.now() + 10_000;
    const timeout = AbortSignal.timeout(10_000), signal = AbortSignal.any([context.signal, timeout]);
    const active = () => { check(); if (timeout.aborted) throw new HostError("scope-facts-timeout", "Native scope facts exceeded their aggregate deadline; keep this observation pending.", true); };
    for (let pass = 0; pass < 8; pass++) {
      check(); const pending = new Map<string, Query>();
      const prepared = prepareFacts(call, { scope, readCommand: (program, args, cwd = call.cwd) => {
        const key = JSON.stringify([program, args, cwd]), result = cached.get(key);
        if (result?.code === 0) return result.stdout;
        if (!result) pending.set(key, { program, args, cwd });
        throw new Error("This native read has not established a scope fact");
      } });
      check();
      if (!pending.size) return prepared;
      if (cached.size + pending.size > 32) throw new HostError("scope-facts-limit", "This call requires too many native read facts; simplify it before retrying.");
      for (const [key, query] of pending) {
        check(); const timeoutMs = Math.min(3000, deadline - Date.now());
        if (timeoutMs <= 0) throw new HostError("scope-facts-timeout", "Native scope fact preparation exceeded its deadline; retry after the host is available.", true);
        const options = { dataDir: this.registry.dataDir, signal, check: active, timeoutMs, env: scope.env.variables };
        let result: Awaited<ReturnType<typeof runProcess>> | Awaited<ReturnType<typeof runGit>> | undefined;
        try {
          result = query.program === "git" ? await runGit(query.cwd, query.args, options)
            : query.program === "gh" ? await runProcess("gh", query.args, { cwd: query.cwd, env: gitEnvironment(query.cwd, this.registry.dataDir, scope.env.variables), signal, timeoutMs, maxBuffer: 1024 * 1024 })
            : undefined;
        } catch (error) { active(); throw error; }
        active();
        if (!result || "timedOut" in result && result.timedOut || result.code === null)
          throw new HostError("scope-facts-unavailable", "The native read could not establish scope facts before its deadline; keep this observation pending.", true);
        if (Buffer.byteLength(result.stdout) > 1024 * 1024) throw new HostError("scope-facts-limit", "The native scope fact output exceeds its safe limit.");
        cached.set(key, result);
      }
    }
    throw new HostError("scope-facts-limit", "Native scope facts did not settle within the bounded preparation passes; simplify the call.");
  }
  async prepareCall(raw: HostInput<"prepareCall">, signal?: AbortSignal): Promise<HostOutput<"prepareCall">> {
    const input = hostContract.prepareCall.input.parse(raw), authority = authorityOf(input);
    const result = await this.registry.operation(authority, signal, async combined => {
      const context = hostContext(this.registry, authority, ["member-write"], combined), { record, scope } = this.acknowledged(authority, input.scopeRevision);
      const check = () => {
        context.active(); const current = this.record(authority);
        if (!current || current.state !== "bound" || JSON.stringify(current.binding) !== JSON.stringify(record.binding) || current.renderedDigest !== record.renderedDigest)
          throw new HostError("scope-changed", "The native scope binding changed during inspection; retain and retry this observation.", true);
      };
      check(); this.workspace(scopeDeliveryFileSchema.parse(JSON.parse(record.deliveryJson)), authority, context.endpoint);
      await assertRepository(context); check();
      const { kind, toolName, input: toolInput, cwd } = input.call;
      const call = await this.facts(context, scope, { kind, toolName, input: toolInput, cwd }, check);
      check(); const decision = evaluate(this.intact(authority, record), call); check();
      return hostContract.prepareCall.output.parse({ call, scopeRevision: record.binding.revision, scopeDigest: record.binding.scopeDigest, decision });
    });
    this.acknowledged(authority, result.scopeRevision, result.scopeDigest, signal);
    return result;
  }
  async sessionStatus(raw: HostInput<"sessionStatus">, signal?: AbortSignal): Promise<HostOutput<"sessionStatus">> {
    const input = hostContract.sessionStatus.input.parse(raw), authority = authorityOf(input);
    await this.registry.operation(authority, signal, async combined => {
      const context = hostContext(this.registry, authority, ["member-write"], combined);
      await assertRepository(context); context.active();
    });
    if (signal?.aborted) throw abortError();
    const endpoint = this.registry.endpoint(authority, ["member-write"]), record = this.record(authority);
    if (!record || record.state !== "bound") return { state: "not-observed", revision: null, scopeDigest: null };
    const reply = (state: HostOutput<"sessionStatus">["state"]): HostOutput<"sessionStatus"> => ({ state, revision: record.binding.revision, scopeDigest: record.binding.scopeDigest });
    if (record.binding.revision !== input.revision || record.binding.scopeDigest !== input.scopeDigest) return reply("stale");
    let scope: Scope;
    try { scope = this.intact(authority, record); }
    catch (error) { if (error instanceof HostError && error.code === "scope-integrity") return reply("stale"); throw error; }
    this.workspace(scopeDeliveryFileSchema.parse(JSON.parse(record.deliveryJson)), authority, endpoint);
    if (scope.mode !== "enforce") return reply("not-observed");
    let marker: z.infer<typeof scopeArmedSchema>;
    try {
      const file = this.registry.scopeStatePath(authority, "scope.armed"), status = lstatSync(file);
      if (!status.isFile() || status.isSymbolicLink() || status.size > 16_384) return reply("stale");
      marker = scopeArmedSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch (error) { return reply((error as NodeJS.ErrnoException).code === "ENOENT" ? "not-observed" : "stale"); }
    if (!marker.hostBinding || marker.threadId !== scope.threadId || marker.issuedAt !== scope.issuedAt || JSON.stringify(marker.hostBinding) !== JSON.stringify(record.binding) || marker.renderedDigest !== record.renderedDigest) return reply("stale");
    try { process.kill(marker.pid, 0); } catch { return reply("stale"); }
    return reply("armed");
  }
  async releaseScope(raw: HostInput<"releaseScope">, signal?: AbortSignal): Promise<HostOutput<"releaseScope">> {
    const authority = hostContract.releaseScope.input.parse(raw);
    const check = () => { if (signal?.aborted) throw abortError(); this.registry.scopeStatePath(authority, "binding.json"); };
    check(); this.writeRecord(authority, { state: "released" }, check);
    for (const name of ["scope.json", "scope.armed"] as const) { check(); rmSync(this.registry.scopeStatePath(authority, name), { force: true }); }
    check(); return { released: true };
  }
}
