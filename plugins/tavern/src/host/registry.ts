import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { authoritySchema, endpointRegistrationSchema, gitRefSchema, hostContract, transferAuthoritySchema, transferRegistrationSchema, type Authority, type EndpointRegistration, type HostInput, type HostOutput, type TransferAuthority, type TransferRegistration } from "../host-contract";
import { objectFormatSchema } from "../shared/placement";
import { abortError, withNativeProcesses } from "./process";

export const authorityOf = (value: Authority): Authority => ({ placementId: value.placementId, generation: value.generation, endpointId: value.endpointId, operationId: value.operationId });
export const transferAuthorityOf = (value: TransferAuthority): TransferAuthority => ({ ...authorityOf(value), transferId: value.transferId });

export class HostError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(`Tavern host [${code}]: ${message}`);
    this.name = "TavernHostError";
  }
}
const inspectionSchema = z.object({ objectFormat: objectFormatSchema, branch: z.string().nullable(), gitDir: z.string(), commonDir: z.string() }).strict();
export const completedImportSchema = z.object({ digest: z.string(), sha: z.string(), tree: z.string(), refs: z.array(gitRefSchema).max(4).optional() }).strict();
const snapshotRefReleaseSchema = z.object({ transferId: z.string(), ref: gitRefSchema, sha: z.string(), phase: z.enum(["releasing", "released"]) }).strict();
const registeredEndpointSchema = z.object({
  registration: endpointRegistrationSchema, realRoot: z.string(), device: z.string(), inode: z.string(), inspection: inspectionSchema.nullable(), activeTransfer: z.string().optional(), released: z.literal(true).optional(), refRelease: snapshotRefReleaseSchema.optional(),
}).strict();
const stateSchema = z.object({
  version: z.literal(1), placementId: z.string(), generation: z.number().int().positive(), revoked: z.boolean(), endpoints: z.array(registeredEndpointSchema).max(100_000).refine(endpoints => endpoints.filter(endpoint => !endpoint.released).length <= 32, "Only 32 endpoint grants may be active."),
}).strict();
const refClaimsSchema = z.array(z.object({ root: z.string(), ref: z.string(), placementId: z.string() }).strict()).max(100_000);
const workspaceClaimsSchema = z.array(z.object({ root: z.string(), placementId: z.string(), generation: z.number().int().positive(), endpointId: z.string() }).strict()).max(100_000);
type State = z.infer<typeof stateSchema>;
export type RegisteredEndpoint = z.infer<typeof registeredEndpointSchema>;
const key = (value: string) => createHash("sha256").update(value).digest("hex");
const within = (child: string, parent: string) => { const rest = relative(parent, child); return !rest || rest !== ".." && !rest.startsWith(".." + sep) && !isAbsolute(rest); };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const privateRef = (value: string) => value.startsWith("refs/tavern/") || value.startsWith("refs/heads/tavern/");

export class HostRegistry {
  readonly dataDir: string;
  private readonly directory: string;
  private readonly realDataDir: string;
  private readonly operations = new Set<{ placementId: string; generation: number; endpointId: string; controller: AbortController; done: Promise<unknown> }>();
  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
    this.realDataDir = realpathSync(this.dataDir);
    this.directory = join(this.realDataDir, "authority");
    if (existsSync(this.directory)) {
      if (lstatSync(this.directory).isSymbolicLink() || !statSync(this.directory).isDirectory())
        throw new HostError("authority-state-invalid", "The authority directory is not a private directory.");
    } else mkdirSync(this.directory, { mode: 0o700 });
  }
  private assertDataRoot(): void {
    if (realpathSync(this.dataDir) !== this.realDataDir || lstatSync(this.directory).isSymbolicLink())
      throw new HostError("authority-state-invalid", "The host data directory changed after initialization.");
  }
  get artifactDirectory(): string { this.assertDataRoot(); return join(this.realDataDir, "artifacts"); }
  private ownedDirectory(parts: string[]): string {
    this.assertDataRoot();
    let directory = this.realDataDir;
    for (const part of parts) {
      directory = join(directory, part);
      try {
        const status = lstatSync(directory);
        if (!status.isDirectory() || status.isSymbolicLink()) throw new HostError("authority-state-invalid", "A private host storage directory was replaced.");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; mkdirSync(directory, { mode: 0o700 }); }
    }
    return directory;
  }
  private file(placementId: string): string { return join(this.directory, key(placementId) + ".json"); }
  private read<T>(file: string, schema: z.ZodType<T>): T | null {
    this.assertDataRoot();
    const status = (() => {
      try { return lstatSync(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    })();
    if (status === null) return null;
    if (!status.isFile() || status.isSymbolicLink() || status.size > 64 * 1024 * 1024)
      throw new HostError("authority-state-invalid", "An authority record is not a regular private file.");
    let value: unknown;
    try { value = JSON.parse(readFileSync(file, "utf8")); }
    catch { throw new HostError("authority-state-invalid", "A persisted authority record cannot be read; reconcile placement before retrying."); }
    const result = schema.safeParse(value);
    if (!result.success) throw new HostError("authority-state-invalid", "A persisted authority record is invalid; reconcile placement before retrying.");
    return result.data;
  }
  private write(file: string, value: unknown, check?: () => void): void {
    this.assertDataRoot();
    const temporary = join(dirname(file), "." + randomBytes(12).toString("hex") + ".tmp");
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > 64 * 1024 * 1024) throw new HostError("authority-limit", "This host authority record exceeds its safe size; reconcile retained transfers before retrying.");
    try { check?.(); writeFileSync(temporary, json, { mode: 0o600, flag: "wx" }); check?.(); renameSync(temporary, file); }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  private state(placementId: string): State | null {
    const state = this.read(this.file(placementId), stateSchema);
    if (state && state.placementId !== placementId) throw new HostError("authority-state-invalid", "The placement identity does not match its authority record.");
    return state;
  }
  private live(authority: Pick<Authority, "placementId" | "generation">): State {
    const state = this.state(authority.placementId);
    if (!state) throw new HostError("placement-missing", "This placement is not registered on this host.");
    if (state.generation !== authority.generation) throw new HostError("stale-generation", "The placement was replaced; reconcile its current generation before retrying.");
    if (state.revoked) throw new HostError("placement-revoked", "This placement was cancelled or released.");
    return state;
  }
  registerEndpoint(raw: HostInput<"registerEndpoint">, signal?: AbortSignal): HostOutput<"registerEndpoint"> {
    const registration = endpointRegistrationSchema.parse(raw);
    const result = this.registerEndpoints({ placementId: registration.placementId, generation: registration.generation, operationId: "register", endpoints: [registration] }, signal);
    if (result.outcome === "waiting") throw new HostError("endpoint-limit", "Waiting for a transfer slot: this placement and generation has 32 active endpoints. Release an idle owned grant, then retry; no endpoint was registered.", true);
    return { registered: true, generation: result.generation };
  }
  registerEndpoints(raw: HostInput<"registerEndpoints">, signal?: AbortSignal): HostOutput<"registerEndpoints"> {
    const input = hostContract.registerEndpoints.input.parse(raw), previous = this.state(input.placementId);
    const active = () => { if (signal?.aborted) throw abortError(); };
    active();
    if (previous && previous.generation > input.generation) throw new HostError("stale-generation", "A newer placement generation is already registered.");
    if (previous?.generation === input.generation && previous.revoked) throw new HostError("placement-revoked", "This placement generation is revoked.");
    const next: State = previous?.generation === input.generation ? structuredClone(previous)
      : { version: 1, placementId: input.placementId, generation: input.generation, revoked: false, endpoints: [] };
    const fresh: EndpointRegistration[] = [];
    for (const registration of input.endpoints) {
      const existing = next.endpoints.find(endpoint => endpoint.registration.endpointId === registration.endpointId);
      if (!existing) fresh.push(registration);
      else {
        if (existing.released) throw new HostError("endpoint-released", "This endpoint ID was released and cannot be reused within its generation.");
        if (!same(existing.registration, registration)) throw new HostError("endpoint-conflict", "An endpoint's identity/access cannot change within its generation.");
        this.endpoint({ ...authorityOf({ ...input, endpointId: registration.endpointId }), operationId: input.operationId });
      }
    }
    const count = next.endpoints.filter(endpoint => !endpoint.released).length;
    if (count + fresh.length > 32) return { outcome: "waiting", generation: input.generation, active: count, required: fresh.length, limit: 32 };
    const result = { outcome: "registered" as const, generation: input.generation, endpointIds: input.endpoints.map(endpoint => endpoint.endpointId) };
    if (!fresh.length) return result;
    const workspaceFile = join(this.directory, "workspaces.json"), refFile = join(this.directory, "refs.json");
    let expectedWorkspaces = this.read(workspaceFile, workspaceClaimsSchema) ?? [], expectedRefs = this.read(refFile, refClaimsSchema) ?? [];
    let workspaces = [...expectedWorkspaces], refs = [...expectedRefs];
    const prepared: RegisteredEndpoint[] = [];
    for (const registration of fresh) {
      if (!isAbsolute(registration.endpoint.root)) throw new HostError("unsafe-root", "The endpoint must be an absolute path on its owning host.");
      if (registration.access === "artifact-store") {
        if (resolve(registration.endpoint.root) !== this.artifactDirectory) throw new HostError("artifact-root", "Artifact storage must use the destination reported by this host, not a caller-selected directory.");
        active(); this.ownedDirectory(["artifacts"]);
      }
      const realRoot = realpathSync(registration.endpoint.root), stat = statSync(realRoot, { bigint: true });
      if (!stat.isDirectory()) throw new HostError("unsafe-root", "The endpoint must be an existing directory.");
      if (registration.access === "member-write") {
        if (realRoot === parse(realRoot).root || realRoot === realpathSync(homedir()) || within(this.realDataDir, realRoot) || within(realRoot, this.realDataDir))
          throw new HostError("unsafe-root", "A member workspace cannot be the filesystem root, home or Tavern's host data directory.");
        if (!registration.ownerThreadId || !registration.endpoint.environmentId || !registration.workspaceKind)
          throw new HostError("endpoint-ownership", "Writable member endpoints require an owning thread, environment and workspace mode.");
        if (registration.allowedRefs.length !== 1 || !registration.allowedRefs[0]!.startsWith("refs/heads/"))
          throw new HostError("ref-ownership", "A member workspace must pin its one trusted branch ref.");
      } else if (registration.access === "home-import") {
        if (next.endpoints.some(endpoint => endpoint.refRelease && endpoint.realRoot === realRoot && registration.allowedRefs.includes(endpoint.refRelease.ref)))
          throw new HostError("snapshot-ref-released", "A private ref released in this generation cannot be granted again; advance only after terminal reconciliation.");
        if (registration.allowedRefs.some(ref => !privateRef(ref))) throw new HostError("ref-ownership", "Home imports may change only Tavern-owned refs.");
      } else if (registration.allowedRefs.length) throw new HostError("ref-ownership", "Read and artifact endpoints cannot authorize Git ref writes.");
      if (new Set(registration.allowedRefs).size !== registration.allowedRefs.length) throw new HostError("ref-ownership", "Ref grants must be unique.");
      if (registration.access === "member-write") {
        const claimed = workspaces.find(claim => claim.root === realRoot);
        if (claimed && (claimed.placementId !== registration.placementId || claimed.generation === registration.generation && claimed.endpointId !== registration.endpointId)) {
          const owner = this.state(claimed.placementId);
          if (!owner || owner.generation < claimed.generation || owner.generation === claimed.generation && !owner.revoked)
            throw new HostError("workspace-ownership", "Another live or unreconciled placement owns this writable workspace.");
        }
        workspaces = [...workspaces.filter(claim => claim.root !== realRoot), { root: realRoot, placementId: registration.placementId, generation: registration.generation, endpointId: registration.endpointId }];
      }
      if (registration.access === "home-import") for (const ref of registration.allowedRefs) {
        const claimed = refs.find(claim => claim.root === realRoot && claim.ref === ref);
        if (claimed && claimed.placementId !== registration.placementId) throw new HostError("ref-ownership", "Another placement owns this home ref.");
        if (!claimed) refs.push({ root: realRoot, ref, placementId: registration.placementId });
      }
      prepared.push({ registration, realRoot, device: String(stat.dev), inode: String(stat.ino), inspection: null });
    }
    const check = () => {
      active();
      if (!same(this.state(input.placementId), previous) || !same(this.read(workspaceFile, workspaceClaimsSchema) ?? [], expectedWorkspaces) || !same(this.read(refFile, refClaimsSchema) ?? [], expectedRefs))
        throw new HostError("authority-changed", "Native endpoint authority or claims changed during batch preparation; reconcile and retry.", true);
      for (const endpoint of prepared) {
        const root = realpathSync(endpoint.registration.endpoint.root), stat = statSync(root, { bigint: true });
        if (root !== endpoint.realRoot || String(stat.dev) !== endpoint.device || String(stat.ino) !== endpoint.inode)
          throw new HostError("endpoint-replaced", "A batch endpoint changed before registration could be committed.");
      }
    };
    check();
    if (!same(workspaces, expectedWorkspaces)) { this.write(workspaceFile, workspaceClaimsSchema.parse(workspaces), check); expectedWorkspaces = workspaces; }
    if (!same(refs, expectedRefs)) { this.write(refFile, refClaimsSchema.parse(refs), check); expectedRefs = refs; }
    next.endpoints.push(...prepared);
    this.write(this.file(input.placementId), stateSchema.parse(next), check);
    active();
    if (!same(this.state(input.placementId), next)) throw new HostError("authority-changed", "The registered batch changed before acknowledgment; reconcile its current generation.", true);
    return result;
  }
  releaseEndpoint(raw: HostInput<"releaseEndpoint">, signal?: AbortSignal): HostOutput<"releaseEndpoint"> {
    const authority = hostContract.releaseEndpoint.input.parse(raw);
    const current = () => {
      if (signal?.aborted) throw abortError();
      const state = this.state(authority.placementId);
      if (!state) throw new HostError("placement-missing", "This placement is not registered on this host.");
      if (state.generation !== authority.generation) throw new HostError("stale-generation", "A released grant cannot affect a different placement generation.");
      const endpoint = state.endpoints.find(endpoint => endpoint.registration.endpointId === authority.endpointId);
      if (!endpoint) throw new HostError("endpoint-missing", "This endpoint is not registered to the placement generation.");
      if (endpoint.activeTransfer || endpoint.refRelease?.phase === "releasing" || [...this.operations].some(operation => operation.placementId === authority.placementId && operation.generation === authority.generation && operation.endpointId === authority.endpointId))
        throw new HostError("endpoint-busy", "This grant has an active carry or native operation; reconcile and drain it before release.", true);
      return { state, endpoint };
    };
    const previous = current();
    if (previous.endpoint.released) return { released: true };
    const next = structuredClone(previous.state); next.endpoints.find(endpoint => endpoint.registration.endpointId === authority.endpointId)!.released = true;
    this.write(this.file(authority.placementId), next, () => {
      if (!same(current().state, previous.state)) throw new HostError("authority-changed", "The endpoint changed during release; reconcile its current authority.", true);
    });
    if (!current().endpoint.released) throw new HostError("authority-changed", "The endpoint release changed before acknowledgment.", true);
    return { released: true };
  }
  endpoint(raw: Authority, access?: EndpointRegistration["access"][]): RegisteredEndpoint {
    const authority = authoritySchema.parse(raw);
    const state = this.live(authority), bound = state.endpoints.find(endpoint => endpoint.registration.endpointId === authority.endpointId);
    if (!bound) throw new HostError("endpoint-missing", "This endpoint is not registered to the placement generation.");
    if (bound.released) throw new HostError("endpoint-released", "This endpoint grant was released; use only a new authorized endpoint, never revive this ID.");
    if (bound.refRelease) throw new HostError("snapshot-ref-released", "Snapshot cleanup closed ordinary access to this home-import grant; reconcile its exact release, then release the endpoint.");
    if (access && !access.includes(bound.registration.access)) throw new HostError("endpoint-access", "The endpoint does not permit this operation.");
    let realRoot: string, device: string, inode: string;
    try {
      realRoot = realpathSync(bound.registration.endpoint.root);
      const stat = statSync(realRoot, { bigint: true }); device = String(stat.dev); inode = String(stat.ino);
    } catch { throw new HostError("endpoint-replaced", "The registered endpoint disappeared or changed; reconcile it before retrying."); }
    if (realRoot !== bound.realRoot || device !== bound.device || inode !== bound.inode)
      throw new HostError("endpoint-replaced", "The registered root was replaced or its symlink target changed.");
    return structuredClone(bound);
  }
  recordInspection(authority: Authority, inspection: z.infer<typeof inspectionSchema>): void {
    const bound = this.endpoint(authority), value = inspectionSchema.parse(inspection);
    if (bound.registration.objectFormat !== null && bound.registration.objectFormat !== value.objectFormat)
      throw new HostError("object-format-mismatch", "The repository object format does not match the registered endpoint.");
    if (bound.registration.access === "member-write" && (value.branch === null || !bound.registration.allowedRefs.includes("refs/heads/" + value.branch)))
      throw new HostError("branch-mismatch", "The member checkout is not on its registered private branch.");
    if (bound.registration.access === "home-import") {
      if (this.live(authority).endpoints.some(endpoint => endpoint.refRelease && endpoint.inspection?.commonDir === value.commonDir && bound.registration.allowedRefs.includes(endpoint.refRelease.ref)))
        throw new HostError("snapshot-ref-released", "This repository ref already entered terminal cleanup; do not introduce another grant in this generation.");
      const file = join(this.directory, "refs.json"), claims = this.read(file, refClaimsSchema) ?? [];
      for (const ref of bound.registration.allowedRefs) {
        const claimed = claims.find(claim => claim.root === value.commonDir && claim.ref === ref);
        if (claimed && claimed.placementId !== authority.placementId) throw new HostError("ref-ownership", "Another placement owns this ref in the shared Git repository.");
        if (!claimed) claims.push({ root: value.commonDir, ref, placementId: authority.placementId });
      }
      this.write(file, claims);
    }
    const state = this.live(authority), current = state.endpoints.find(endpoint => endpoint.registration.endpointId === authority.endpointId)!;
    current.inspection = value;
    this.write(this.file(authority.placementId), state);
  }
  revokePlacement(raw: HostInput<"revokePlacement">): HostOutput<"revokePlacement"> {
    const input = hostContract.revokePlacement.input.parse(raw), state = this.state(input.placementId);
    if (state && state.generation > input.generation) throw new HostError("stale-generation", "A late cancellation cannot revoke a newer generation.");
    const next = state?.generation === input.generation ? state : { version: 1 as const, placementId: input.placementId, generation: input.generation, revoked: false, endpoints: [] };
    next.revoked = true;
    this.write(this.file(input.placementId), next);
    for (const operation of this.operations) if (operation.placementId === input.placementId && operation.generation <= input.generation) operation.controller.abort();
    return { revoked: true, generation: input.generation };
  }
  private transferFile(authority: TransferAuthority): string {
    return join(this.directory, key(authority.placementId + "\0" + authority.generation + "\0" + authority.endpointId + "\0" + authority.transferId) + ".transfer.json");
  }
  registerTransfer(raw: HostInput<"registerTransfer">): HostOutput<"registerTransfer"> {
    const registration = transferRegistrationSchema.parse(raw);
    const { transferId: _transferId, ...authority } = registration;
    const bound = this.endpoint({ placementId: authority.placementId, generation: authority.generation, endpointId: authority.endpointId, operationId: authority.operationId });
    const access = bound.registration.access;
    const destination = registration.direction === "carry-out" ? access === "member-write"
      : registration.direction === "bring-home" ? access === "home-import" : access === "artifact-store";
    const validAccess = registration.direction === "carry-out" ? ["source-read", "home-import", "member-write"]
      : registration.direction === "bring-home" ? ["source-read", "member-write", "home-import"] : ["artifact-read", "member-write", "artifact-store"];
    if (!validAccess.includes(access) || (destination ? registration.toEndpointId : registration.fromEndpointId) !== authority.endpointId)
      throw new HostError("transfer-endpoint", "This endpoint is not the registered source/destination of the transfer.");
    if (registration.allowedRefs.some(ref => !bound.registration.allowedRefs.includes(ref)))
      throw new HostError("ref-ownership", "The transfer cannot acquire another endpoint's ref grants.");
    if (registration.direction !== "artifacts") {
      if (!bound.inspection) throw new HostError("endpoint-uninspected", "Inspect the actual repository before registering a source transfer.");
      if (bound.inspection.objectFormat !== registration.objectFormat)
        throw new HostError("object-format-mismatch", "Source, home and checker repositories must use the same object format.");
    }
    const file = this.transferFile(registration), previous = this.read(file, transferRegistrationSchema);
    const identity = ({ operationId: _operationId, ...value }: TransferRegistration) => value;
    if (previous && !same(identity(previous), identity(registration))) throw new HostError("transfer-conflict", "A transfer's source, snapshot, handles and grants are immutable.");
    if (!previous) this.write(file, registration);
    return { registered: true, transferId: registration.transferId };
  }
  transfer(raw: TransferAuthority): { endpoint: RegisteredEndpoint; registration: TransferRegistration } {
    const authority = transferAuthoritySchema.parse(raw), endpoint = this.endpoint({ placementId: authority.placementId, generation: authority.generation, endpointId: authority.endpointId, operationId: authority.operationId });
    const registration = this.read(this.transferFile(authority), transferRegistrationSchema);
    if (!registration || registration.placementId !== authority.placementId || registration.generation !== authority.generation || registration.endpointId !== authority.endpointId)
      throw new HostError("transfer-missing", "This transfer is not registered to the endpoint and current placement generation.");
    return { endpoint, registration };
  }
  carryLease(authority: TransferAuthority, action: "claim" | "check" | "release"): void {
    this.transfer(authority);
    this.endpoint(authorityOf(authority), ["member-write"]);
    const state = this.live(authority), endpoint = state.endpoints.find(value => value.registration.endpointId === authority.endpointId)!;
    if (endpoint.activeTransfer && endpoint.activeTransfer !== authority.transferId) throw new HostError("carry-in-progress", "Another transfer owns this member checkout; reconcile it before starting another.");
    if (action === "check") {
      if (!endpoint.activeTransfer) throw new HostError("carry-not-started", "This transfer has not acquired the member checkout.");
      return;
    }
    if (action === "release") delete endpoint.activeTransfer;
    else endpoint.activeTransfer = authority.transferId;
    this.write(this.file(authority.placementId), state);
  }
  transferPath(authority: TransferAuthority, name: string): string {
    this.transfer(authority);
    if (!/^[a-z][a-z0-9.-]{0,150}$/.test(name)) throw new HostError("invalid-storage-name", "Use a private host storage name.");
    return join(this.ownedDirectory(["transfers", key(authority.placementId + "\0" + authority.generation + "\0" + authority.endpointId + "\0" + authority.transferId)]), name);
  }
  snapshotImport(raw: TransferAuthority): { endpoint: RegisteredEndpoint; registration: TransferRegistration } {
    const authority = transferAuthoritySchema.parse(raw), state = this.state(authority.placementId);
    if (!state) throw new HostError("placement-missing", "This placement is not registered on this host.");
    if (state.generation !== authority.generation) throw new HostError("stale-generation", "Snapshot cleanup cannot affect a different placement generation.");
    const endpoint = state.endpoints.find(endpoint => endpoint.registration.endpointId === authority.endpointId);
    if (!endpoint) throw new HostError("endpoint-missing", "The snapshot endpoint is not registered to this placement generation.");
    if (endpoint.registration.access !== "home-import" || endpoint.registration.allowedRefs.length !== 1 || !privateRef(endpoint.registration.allowedRefs[0]!))
      throw new HostError("snapshot-release-authority", "Snapshot cleanup requires a single private-ref home-import grant.");
    const registration = this.read(this.transferFile(authority), transferRegistrationSchema);
    if (!registration || registration.placementId !== authority.placementId || registration.generation !== authority.generation || registration.endpointId !== authority.endpointId)
      throw new HostError("transfer-missing", "The snapshot transfer is not owned by this current endpoint generation.");
    if (registration.direction !== "bring-home" || registration.toEndpointId !== authority.endpointId || registration.allowedRefs.length !== 1 || registration.allowedRefs[0] !== endpoint.registration.allowedRefs[0])
      throw new HostError("snapshot-release-authority", "Snapshot cleanup requires this endpoint's exact registered single-ref import transfer.");
    return { endpoint, registration };
  }
  private snapshotImportPath(authority: TransferAuthority): string {
    this.snapshotImport(authority);
    return join(this.ownedDirectory(["transfers", key(authority.placementId + "\0" + authority.generation + "\0" + authority.endpointId + "\0" + authority.transferId)]), "import.json");
  }
  private snapshotProof(authority: TransferAuthority) {
    const snapshot = this.snapshotImport(authority), receipt = this.read(this.snapshotImportPath(authority), completedImportSchema), ref = snapshot.registration.allowedRefs[0]!;
    const oid = snapshot.registration.objectFormat === "sha1" ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/;
    if (!receipt || !/^[a-f0-9]{64}$/.test(receipt.digest) || !oid.test(receipt.sha) || receipt.tree !== snapshot.registration.tree || receipt.refs?.length !== 1 || receipt.refs[0] !== ref)
      throw new HostError("snapshot-release-proof", "There is no completed native import proving this exact single ref and SHA; preserve it and reconcile rather than guessing.");
    const intent = snapshot.endpoint.refRelease;
    if (intent && (intent.transferId !== authority.transferId || intent.ref !== ref || intent.sha !== receipt.sha))
      throw new HostError("snapshot-release-conflict", "This grant already pins another immutable snapshot cleanup; resume that exact authority.");
    return { ...snapshot, ref, sha: receipt.sha };
  }
  assertSnapshotRefClaim(authority: TransferAuthority): RegisteredEndpoint {
    const { endpoint, ref } = this.snapshotProof(authority), state = this.state(authority.placementId)!;
    if (state.endpoints.some(other => !other.released && other.registration.endpointId !== authority.endpointId && other.registration.access === "home-import" && other.registration.allowedRefs.includes(ref) && (other.realRoot === endpoint.realRoot || !!endpoint.inspection && other.inspection?.commonDir === endpoint.inspection.commonDir)))
      throw new HostError("ref-ownership", "Another active home-import grant shares this private ref; reconcile its authority before cleanup.");
    const roots = new Set([endpoint.realRoot, ...(endpoint.inspection ? [endpoint.inspection.commonDir] : [])]);
    const claims = (this.read(join(this.directory, "refs.json"), refClaimsSchema) ?? []).filter(claim => roots.has(claim.root) && claim.ref === ref);
    if (!claims.length || claims.some(claim => claim.placementId !== authority.placementId)) throw new HostError("ref-ownership", "This private ref is no longer exclusively owned by the snapshot authority.");
    return endpoint;
  }
  beginSnapshotRefRelease(authority: TransferAuthority, signal: AbortSignal) {
    if (signal.aborted) throw abortError();
    const proof = this.snapshotProof(authority);
    if (proof.endpoint.refRelease) return proof.endpoint.refRelease;
    this.assertSnapshotRefClaim(authority);
    const previous = this.state(authority.placementId)!, next = structuredClone(previous), intent = snapshotRefReleaseSchema.parse({ transferId: authority.transferId, ref: proof.ref, sha: proof.sha, phase: "releasing" });
    next.endpoints.find(endpoint => endpoint.registration.endpointId === authority.endpointId)!.refRelease = intent;
    this.write(this.file(authority.placementId), next, () => {
      if (signal.aborted) throw abortError(); this.snapshotProof(authority); this.assertSnapshotRefClaim(authority);
      if (!same(this.state(authority.placementId), previous)) throw new HostError("authority-changed", "Snapshot authority changed before cleanup intent could be committed.", true);
    });
    return this.snapshotProof(authority).endpoint.refRelease!;
  }
  finishSnapshotRefRelease(authority: TransferAuthority, signal: AbortSignal): void {
    const check = () => { if (signal.aborted) throw abortError(); const proof = this.snapshotProof(authority); if (!proof.endpoint.refRelease) throw new HostError("snapshot-release-proof", "Begin exact snapshot cleanup before recording completion."); return proof; };
    const proof = check();
    if (proof.endpoint.refRelease!.phase !== "released") {
      const previous = this.state(authority.placementId)!, next = structuredClone(previous); next.endpoints.find(endpoint => endpoint.registration.endpointId === authority.endpointId)!.refRelease!.phase = "released";
      this.write(this.file(authority.placementId), next, () => { check(); if (!same(this.state(authority.placementId), previous)) throw new HostError("authority-changed", "Snapshot authority changed before cleanup completion could be committed.", true); });
    }
    const file = join(this.directory, "refs.json"), previous = this.read(file, refClaimsSchema) ?? [], roots = new Set([proof.endpoint.realRoot, ...(proof.endpoint.inspection ? [proof.endpoint.inspection.commonDir] : [])]);
    const next = previous.filter(claim => claim.placementId !== authority.placementId || claim.ref !== proof.ref || !roots.has(claim.root));
    if (!same(previous, next)) this.write(file, next, () => { check(); if (!same(this.read(file, refClaimsSchema) ?? [], previous)) throw new HostError("authority-changed", "Private ref claims changed before terminal cleanup.", true); });
    check();
  }
  async snapshotRefOperation<T>(authority: TransferAuthority, signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.snapshotImport(authority);
    if ([...this.operations].some(operation => operation.placementId === authority.placementId && operation.generation === authority.generation && operation.endpointId === authority.endpointId))
      throw new HostError("endpoint-busy", "Drain this endpoint's native operations before releasing its snapshot ref.", true);
    const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let complete!: () => void;
    const operation = { placementId: authority.placementId, generation: authority.generation, endpointId: authority.endpointId, controller, done: new Promise<void>(resolve => { complete = resolve; }) }; this.operations.add(operation);
    try {
      if (combined.aborted) throw abortError();
      const result = await withNativeProcesses(combined, scoped => work(scoped));
      if (combined.aborted) throw abortError(); this.snapshotImport(authority); return result;
    } finally { this.operations.delete(operation); complete(); }
  }
  scopeStatePath(raw: Authority, name: "binding.json" | "scope.json" | "scope.armed"): string {
    const authority = authoritySchema.parse(raw), state = this.state(authority.placementId);
    if (!state) throw new HostError("placement-missing", "This placement is not registered on this host.");
    if (state.generation !== authority.generation) throw new HostError("stale-generation", "A scope cleanup cannot affect a different placement generation.");
    const endpoint = state.endpoints.find(endpoint => endpoint.registration.endpointId === authority.endpointId);
    if (!endpoint) throw new HostError("endpoint-missing", "This scope endpoint is not registered to the placement generation.");
    if (endpoint.registration.access !== "member-write") throw new HostError("endpoint-access", "Native scope state belongs only to a member workspace endpoint.");
    if (!["binding.json", "scope.json", "scope.armed"].includes(name)) throw new HostError("invalid-storage-name", "Use a private native scope storage name.");
    // Revoked endpoints may remove private scope files even after the workspace disappeared.
    return join(this.ownedDirectory(["scopes", key(authority.placementId + "\0" + authority.generation + "\0" + authority.endpointId)]), name);
  }
  readScopeState<T>(authority: Authority, schema: z.ZodType<T>): T | null {
    return this.read(this.scopeStatePath(authority, "binding.json"), schema);
  }
  private endpointStatePath(authority: Authority, name: string): string {
    this.endpoint(authorityOf(authority));
    if (!/^[a-z][a-z0-9.-]{0,150}$/.test(name)) throw new HostError("invalid-storage-name", "Use a private host storage name.");
    return join(this.ownedDirectory(["endpoint-state", key(authority.placementId + "\0" + authority.generation + "\0" + authority.endpointId)]), name);
  }
  readEndpointState<T>(authority: Authority, name: string, schema: z.ZodType<T>): T | null {
    return this.read(this.endpointStatePath(authority, name), schema);
  }
  writeEndpointState<T>(authority: Authority, name: string, schema: z.ZodType<T>, value: T): void {
    this.write(this.endpointStatePath(authority, name), schema.parse(value));
  }
  artifactPath(authority: TransferAuthority, artifactId: string): { file: string; storageKey: string } {
    this.transfer(authority);
    const endpoint = this.endpoint(authorityOf(authority), ["artifact-store"]);
    if (endpoint.realRoot !== this.artifactDirectory) throw new HostError("artifact-root", "The artifact destination is no longer this host\u0027s private storage.");
    const parts = ["artifacts", key(authority.placementId), key(authority.generation + "\0" + authority.endpointId + "\0" + authority.transferId)];
    const name = key(artifactId) + ".artifact";
    return { file: join(this.ownedDirectory(parts), name), storageKey: [...parts, name].join("/") };
  }
  readTransferState<T>(authority: TransferAuthority, name: string, schema: z.ZodType<T>): T | null {
    return this.read(this.transferPath(authority, name), schema);
  }
  writeTransferState<T>(authority: TransferAuthority, name: string, schema: z.ZodType<T>, value: T): void {
    this.write(this.transferPath(authority, name), schema.parse(value));
  }
  guardArtifactPath(authority: Authority, digest: string): string {
    this.endpoint(authorityOf(authority), ["member-write"]);
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new HostError("guard-artifact", "Use a SHA256 digest for the owned native guard artifact.");
    return join(this.ownedDirectory(["guard-artifacts"]), digest + ".mjs");
  }
  async operation<T>(authority: Authority, signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.endpoint(authorityOf(authority));
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let complete!: () => void;
    const operation = { placementId: authority.placementId, generation: authority.generation, endpointId: authority.endpointId, controller, done: new Promise<void>(resolve => { complete = resolve; }) };
    this.operations.add(operation);
    try {
      if (combined.aborted) throw abortError();
      const result = await withNativeProcesses(combined, scoped => work(scoped));
      if (combined.aborted) throw abortError();
      this.endpoint(authorityOf(authority));
      return result;
    } finally { this.operations.delete(operation); complete(); }
  }
  async settlePlacement(placementId: string, generation: number): Promise<void> {
    await Promise.all([...this.operations].filter(operation => operation.placementId === placementId && operation.generation <= generation).map(operation => operation.done));
  }
}
