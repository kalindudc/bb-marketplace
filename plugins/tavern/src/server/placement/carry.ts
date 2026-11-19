import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CHUNK_BYTES, hostContract, type Authority, type HostInput, type HostMethod, type HostOutput } from "../../host-contract";
import type { HostPort } from "../../host/client";
import { carryReceiptSchema, type CarryReceipt } from "../../shared/placement";
import { contentHoldTokenSchema } from "../away/holds";
import type { AwayRuntime } from "../away/runtime";
import { requireSnapshotFetch } from "./capture";
import { readSourceIdentity, type SdkSource } from "./source-discovery";
import { PlacementStore } from "./store";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
type Holds = Pick<AwayRuntime, "requestContentHold" | "confirmHeld" | "inspectHeld" | "finishContentHold">;
type Result = { snapshotId: string; tree: string; head: string; objectFormat: "sha1" | "sha256" };
export interface ReadyTurn {
  threadId: string;
  toolName: "tavern_ready";
  assertActive(): void;
}

export class PlacementCarry {
  private readonly pending = new Map<string, { key: string; promise: Promise<Result> }>();
  private readonly lifetime = new AbortController();
  private readonly operations = new Set<{ hosts: Set<string>; controller: AbortController }>();

  constructor(
    private readonly bb: Pick<BbPluginApi, "sdk" | "onDispose">,
    private readonly host: HostPort,
    private readonly placements: PlacementStore,
    private readonly holds: Holds,
  ) {
    const unsubscribe = host.onWorkerExit(({ hostId }) => {
      for (const operation of this.operations) if (operation.hosts.has(hostId)) operation.controller.abort(new Error("The carry host worker exited; reconcile before retrying"));
    });
    bb.onDispose(() => { this.lifetime.abort(new Error("Placement carry disposed")); unsubscribe(); });
  }

  carryOut(placementId: string, generation: number, snapshotId: string, signal?: AbortSignal): Promise<Result> {
    const key = JSON.stringify([generation, snapshotId]), existing = this.pending.get(placementId);
    if (existing) {
      if (existing.key !== key) return Promise.reject(new Error("Another carry is in progress for this placement"));
      if (signal?.aborted) return Promise.reject(signal.reason);
      return existing.promise;
    }
    const promise = this.run(placementId, generation, snapshotId, signal).finally(() => {
      if (this.pending.get(placementId)?.promise === promise) this.pending.delete(placementId);
    });
    this.pending.set(placementId, { key, promise });
    return promise;
  }

  carryIntoOwnTurn(placementId: string, generation: number, snapshotId: string, turn: ReadyTurn, signal?: AbortSignal): Promise<Result> {
    if (this.pending.has(placementId)) return Promise.reject(new Error("Another carry is in progress for this placement"));
    const key = JSON.stringify([generation, snapshotId, turn.threadId, turn.toolName]);
    const promise = this.run(placementId, generation, snapshotId, signal, turn).finally(() => {
      if (this.pending.get(placementId)?.promise === promise) this.pending.delete(placementId);
    });
    this.pending.set(placementId, { key, promise });
    return promise;
  }

  private async run(placementId: string, generation: number, snapshotId: string, caller?: AbortSignal, turn?: ReadyTurn): Promise<Result> {
    const record = this.placements.assertCurrent(placementId, generation), snapshot = this.placements.snapshot(snapshotId);
    if (turn && (turn.toolName !== "tavern_ready" || turn.threadId !== record.memberThreadId))
      throw new Error("Self-turn carry requires the placement member's own in-flight tavern_ready call");
    turn?.assertActive();
    if (!record.memberThreadId || !record.workspaceKind || !record.hostId || !record.environmentId || !record.root ||
        record.workspaceKind === "dedicated-machine" && !record.ownsNewMachine)
      throw new Error("Carry requires the actual Tavern-owned member workspace");
    if (!snapshot?.homeCommit || snapshot.keeperThreadId !== record.keeperThreadId || snapshot.projectId !== record.projectId ||
        snapshot.id !== (record.reviewTarget?.snapshotId ?? record.sourceSnapshotId))
      throw new Error("Carry requires this placement's pinned immutable home snapshot");
    if (record.reviewTarget && (record.reviewTarget.expectedTree !== snapshot.tree || record.reviewTarget.makerSubmissionId !== snapshot.makerSubmissionId ||
        !isDeepStrictEqual(record.reviewTarget.journal, snapshot.journalTarget))) throw new Error("The review assignment does not match the pinned snapshot");
    if (snapshot.purpose !== "initial" && !record.reviewTarget && snapshot.makerThreadId !== record.memberThreadId)
      throw new Error("The resume snapshot belongs to another maker");
    const fetch = requireSnapshotFetch(snapshot), memberId = record.memberThreadId;
    const operation = { hosts: new Set([snapshot.home.hostId, record.hostId]), controller: new AbortController() };
    this.operations.add(operation);
    const signal = AbortSignal.any([this.lifetime.signal, operation.controller.signal, ...(caller === undefined ? [] : [caller])]);
    const current = () => {
      signal.throwIfAborted();
      turn?.assertActive();
      const live = this.placements.assertCurrent(placementId, generation);
      for (const key of ["sourceSnapshotId", "memberThreadId", "hostId", "environmentId", "root", "reviewTarget", "workspaceKind", "ownsNewMachine"] as const)
        if (!isDeepStrictEqual(live[key], record[key])) throw new Error("The placement carry assignment changed");
      if (!isDeepStrictEqual(this.placements.snapshot(snapshotId), snapshot)) throw new Error("The pinned carry snapshot changed");
      return live;
    };
    let home: SdkSource, member: SdkSource, branch: string;
    let receipt: CarryReceipt | undefined;
    let held = false;
    const hold = () => {
      current();
      if (!receipt || !isDeepStrictEqual(current().carries?.find(item => item.id === receipt!.id), receipt)) throw new Error("The private carry operation changed");
      if (held && this.holds.inspectHeld(contentHoldTokenSchema.parse(receipt.holdToken)).state !== "confirmed") throw new Error("The carry content hold is stale or pending");
    };
    const identities = async () => {
      current();
      const from = await readSourceIdentity(this.bb, record.keeperThreadId, record.projectId, signal); current();
      const to = await readSourceIdentity(this.bb, memberId, record.projectId, signal); current();
      const thread = await this.bb.sdk.threads.get({ threadId: memberId, signal }); current();
      if (held && thread.status !== "idle" || thread.environmentId !== to.endpoint.environmentId || thread.projectId !== record.projectId || thread.archivedAt !== null || thread.deletedAt !== null)
        throw new Error("Background carry requires the held owner to be idle and active");
      const environment = await this.bb.sdk.environments.get({ environmentId: to.endpoint.environmentId!, signal }); current();
      if (!environment.branchName || environment.id !== to.endpoint.environmentId || environment.path !== to.endpoint.root || environment.hostId !== to.endpoint.hostId)
        throw new Error("The member checkout has no stable SDK branch identity");
      return { from, to, branch: environment.branchName };
    };
    const fence = async () => {
      hold();
      const next = await identities(); hold();
      if (!isDeepStrictEqual(next.from, home) || !isDeepStrictEqual(next.to, member) || next.branch !== branch)
        throw new Error("The SDK carry endpoint identity changed");
    };
    const call = async <M extends HostMethod>(hostId: string, method: M, input: HostInput<M>): Promise<HostOutput<M>> => {
      await fence(); hold();
      const reply = await this.host.call(hostId, method, input, { signal }); hold();
      await fence(); hold();
      return hostContract[method].output.parse(reply) as HostOutput<M>;
    };
    try {
      const sdk = await identities(); home = sdk.from; member = sdk.to; branch = sdk.branch;
      if (home.endpoint.hostId !== snapshot.home.hostId || home.endpoint.environmentId !== snapshot.home.environmentId ||
          member.endpoint.hostId !== record.hostId || member.endpoint.environmentId !== record.environmentId)
        throw new Error("The SDK carry endpoint does not match the private placement");
      const id = "carry-" + digest(JSON.stringify([placementId, generation, snapshotId]));
      const existing = current().carries?.find(item => item.id === id);
      const prior = current().carries?.filter(item => item.generation === generation && item.phase === "verified" && item.id !== id &&
        isDeepStrictEqual(item.memberSdk, member.endpoint) && item.branch === branch).at(-1);
      const deltaBase = prior ? this.placements.snapshot(prior.snapshotId)!.homeCommit : snapshot.base;
      if (!deltaBase) throw new Error("The previous carry has no home commit; preserve and reconcile before retrying.");
      const expectedHead = prior?.head ?? snapshot.base;
      const ownToken = "ready-" + digest(JSON.stringify([placementId, generation, snapshotId, memberId]));
      if (existing && turn && existing.holdToken !== ownToken) throw new Error("A background carry receipt cannot authorize this member's ready turn");
      if (existing && !turn && existing.holdToken === ownToken) throw new Error("A ready-turn carry receipt cannot authorize a background carry");
      const token = turn ? ownToken : existing && this.holds.inspectHeld(contentHoldTokenSchema.parse(existing.holdToken)).state !== "stale"
        ? contentHoldTokenSchema.parse(existing.holdToken)
        : !existing || existing.phase === "verified" ? this.holds.requestContentHold(memberId, { operationId: id }) : null;
      if (token === null) throw new Error("The persisted carry content hold is stale; reconcile it before retrying");
      const initial = carryReceiptSchema.parse({ id, generation, snapshotId,
        homeEndpointId: "carry-home-" + digest(JSON.stringify([home.endpoint, snapshot.objectFormat])), memberEndpointId: "carry-member",
        homeSdk: home.endpoint, memberSdk: member.endpoint, branch, holdToken: token,
        replacesTree: existing ? existing.replacesTree : prior ? this.placements.snapshot(prior.snapshotId)!.tree : null,
        phase: "holding", manifest: existing?.manifest ?? null, head: null });
      if (existing) for (const key of ["id", "generation", "snapshotId", "homeEndpointId", "memberEndpointId", "homeSdk", "memberSdk", "branch", "replacesTree"] as const)
        if (!isDeepStrictEqual(existing[key], initial[key])) throw new Error("Immutable carry operation identity changed");
      receipt = initial;
      this.placements.update(placementId, generation, value => ({ ...value, carries: existing
        ? value.carries!.map(item => item.id === id ? initial : item) : [...(value.carries ?? []), initial] }));
      if (!turn) {
        const confirmed = await this.holds.confirmHeld(contentHoldTokenSchema.parse(token)); hold();
        if (confirmed.state !== "confirmed") throw new Error(confirmed.error ?? "The content hold stop is pending or stale");
        held = true;
      }
      await fence();
      const update = (patch: Partial<CarryReceipt>) => {
        hold();
        const updated = this.placements.update(placementId, generation, value => ({ ...value, carries: value.carries!.map(item => item.id === id ? { ...item, ...patch } : item) }));
        receipt = updated.carries!.find(item => item.id === id)!;
      };
      const authority = (endpointId: string): Authority => ({ placementId, generation, endpointId, operationId: randomUUID() });
      const from = authority(receipt.homeEndpointId), to = authority(receipt.memberEndpointId);
      for (const [native, identity, root, access, refs] of [
        [from, home, snapshot.home.root, "source-read", []],
        [to, member, record.root, "member-write", ["refs/heads/" + branch]],
      ] as const) {
        if (!turn || access !== "member-write") {
          const ack = await call(identity.endpoint.hostId, "registerEndpoint", { placementId, generation, endpointId: native.endpointId, endpoint: { ...identity.endpoint, root }, ownerThreadId: identity.keeperThreadId,
            access, git: access === "member-write" ? "porcelain" : "full", workspaceKind: access === "member-write" ? record.workspaceKind : null, objectFormat: snapshot.objectFormat, allowedRefs: [...refs] });
          if (ack.generation !== generation) throw new Error("The host acknowledged a stale carry endpoint");
        }
        const inspected = await call(identity.endpoint.hostId, "inspect", native);
        if (inspected.objectFormat !== snapshot.objectFormat) throw new Error("object-format-mismatch");
        if (inspected.root !== root || !inspected.features.exportChanges) throw new Error("The native carry root or export capability changed");
      }
      update({ phase: "exporting" });
      for (const [native, hostId, refs] of [[from, snapshot.home.hostId, []], [to, record.hostId, ["refs/heads/" + branch]]] as const) {
        const ack = await call(hostId, "registerTransfer", { ...native, transferId: id, snapshotId, direction: "carry-out", objectFormat: snapshot.objectFormat,
          base: deltaBase, head: snapshot.homeCommit, tree: snapshot.tree, fromEndpointId: from.endpointId, toEndpointId: to.endpointId,
          allowedRefs: [...refs], uploads: [], artifacts: [] });
        if (ack.transferId !== id) throw new Error("The host acknowledged another carry transfer");
      }
      const exported = await call(snapshot.home.hostId, "exportChanges", { ...from, transferId: id });
      if (exported.base !== deltaBase || exported.head !== snapshot.homeCommit || exported.tree !== snapshot.tree)
        throw new Error("The home manifest does not match the immutable snapshot");
      const paths = new Set<string>();
      for (const file of exported.changes) {
        if (paths.has(file.path)) throw new Error("The carry manifest repeats a path"); paths.add(file.path);
        if (file.status === "D" ? file.blob !== undefined || file.mode !== undefined || file.size !== undefined
          : file.blob?.length !== snapshot.tree.length || file.mode === undefined || file.size === undefined)
          throw new Error("The carry manifest has incomplete or wrong-format blob metadata");
      }
      const json = JSON.stringify(exported), manifest = { json, digest: digest(json) };
      if (receipt.manifest !== null && !isDeepStrictEqual(receipt.manifest, manifest)) throw new Error("The immutable carry manifest changed on retry");
      update({ phase: "carrying", manifest });
      const start = await call(record.hostId, "carryStart", { ...to, transferId: id, remote: fetch.remoteUrl, baseBranch: fetch.fetchRef, expectedHead,
        ...(receipt.replacesTree === null ? {} : { replaces: receipt.replacesTree }), paths: [...paths], networkTimeoutMs: 120_000 });
      if (start.outcome !== "ok") throw new Error(`Carry blocked [${start.code}]: ${start.message}`);
      if (!start.present) {
        const deleted = exported.changes.filter(file => file.status === "D").map(file => file.path);
        for (let at = 0; at < deleted.length; at += 500) await call(record.hostId, "carryDelete", { ...to, transferId: id, paths: deleted.slice(at, at + 500) });
        for (const file of exported.changes.filter(file => file.status !== "D")) {
          const hash = createHash(snapshot.objectFormat).update(`blob ${file.size}\0`);
          for (let offset = 0; offset < file.size! || offset === 0; offset += CHUNK_BYTES) {
            const length = Math.min(CHUNK_BYTES, file.size! - offset);
            const chunk = await call(snapshot.home.hostId, "readBlob", { ...from, transferId: id, sha: file.blob!, offset, length });
            const bytes = Buffer.from(chunk.data, "base64");
            if (bytes.length !== length || bytes.toString("base64") !== chunk.data) throw new Error("The carry blob chunk is invalid or truncated");
            hash.update(bytes);
            const written = await call(record.hostId, "carryWrite", { ...to, transferId: id, path: file.path, mode: file.mode!, offset, data: chunk.data });
            if (written.size < offset + length || written.size > file.size!) throw new Error("The carry write byte count is invalid");
          }
          if (hash.digest("hex") !== file.blob) throw new Error("The carry blob bytes do not match the immutable Git hash");
        }
      }
      const finished = await call(record.hostId, "carryFinish", { ...to, transferId: id, message: exported.message, author: exported.author,
        paths: exported.changes.filter(file => file.status !== "D").map(file => file.path) });
      if (finished.outcome === "mismatch" || finished.outcome === "ok" && finished.tree !== snapshot.tree) throw new Error("The carried tree mismatched. Tavern kept the commit and files; preserve them and provision a fresh checkout before retrying. Tavern will not reset the member branch.");
      if (finished.outcome !== "ok") throw new Error("The carry contains foreign changes. Tavern kept the files; preserve and reconcile them before retrying.");
      const observed = await call(record.hostId, "worktreeState", { ...to, base: snapshot.base });
      if (observed.dirty || observed.unfinishedMerge || observed.head !== finished.head || observed.tree !== snapshot.tree)
        throw new Error("The carried checkout is not the exact clean pinned tree");
      await fence(); hold();
      this.placements.completeCarry(placementId, generation, id, observed.head, observed.tree, snapshot.objectFormat);
      receipt = this.placements.get(placementId)!.carries!.find(item => item.id === id)!;
      hold();
      if (!turn && this.holds.finishContentHold(contentHoldTokenSchema.parse(token)).state !== "finished") throw new Error("The verified carry hold changed before completion");
      return { snapshotId, tree: snapshot.tree, head: observed.head, objectFormat: snapshot.objectFormat };
    } finally { this.operations.delete(operation); }
  }
}
