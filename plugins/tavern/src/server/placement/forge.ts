import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { hostContract, type HostInput, type HostMethod, type HostOutput } from "../../host-contract";
import { pullRequestLine } from "../../shared/pull-request";
import { forgeFailure } from "../../shared/forge-command";
import type { TavernRuntime } from "../runtime";
import { readSourceIdentity } from "./source-discovery";

export const MEMBER_PR_REFUSAL = "Your pull requests open on your own machine; use your own tools as your scope allows.";
export class PlacementForge {
  private readonly pending = new Set<string>();
  constructor(private readonly runtime: TavernRuntime) {}
  async forThread(threadId: string, input: { title: string; body?: string; base?: string; url?: string; forge?: string }, signal?: AbortSignal): Promise<string> {
    const runtime = this.runtime, services = runtime.placements(), record = services.store.byMember(threadId), member = runtime.keeper.member(threadId);
    if (member?.classId !== "smith") return MEMBER_PR_REFUSAL;
    if (record?.pullRequests?.at !== "home") return this.recordLocal(threadId, input, signal);
    let scope;
    try { scope = runtime.scopes?.api.hostTemplate(threadId).template; }
    catch { return "Tavern could not establish your scope; reconcile it before opening a draft pull request."; }
    if (!scope) return "Tavern could not establish your scope; reconcile it before opening a draft pull request.";
    if (scope.github !== "draft-pr-only") return `Your ${scope.preset} scope has GitHub access ${scope.github}; it does not allow opening draft pull requests.`;
    if (input.body === undefined) return "Opening a draft from home requires a body; use an empty string for no description.";
    if (this.pending.has(threadId)) return "A draft pull request call is already in progress for this member.";
    const profileId = record.pullRequests.profile;
    const policy = runtime.settings?.placementPolicy();
    const profile = policy?.state === "valid" ? policy.settings.forges.find(item => item.id === profileId && item.enabled) : undefined;
    if (!profile) return "The placement's forge profile is missing or disabled. Fix it in Where work runs.";
    this.pending.add(threadId);
    const current = () => {
      signal?.throwIfAborted();
      const live = services.store.assertCurrent(record.id, record.generation);
      if (live.memberThreadId !== threadId || live.hostId !== record.hostId || live.environmentId !== record.environmentId || live.root !== record.root || live.memberBranch !== record.memberBranch || !isDeepStrictEqual(runtime.scopes!.api.hostTemplate(threadId).template, scope) || !isDeepStrictEqual(live.pullRequests, record.pullRequests)) throw new Error("The member's placement changed during the draft call.");
    };
    const event = (type: string, text: string, data: Record<string, unknown>) => runtime.keeper.store.event(runtime.keeper.now(), record.keeperThreadId, member.boardQuestId, type, text, { memberThreadId: threadId, profile: profile.id, ...data });
    try {
      current();
      const source = await readSourceIdentity(runtime.bb, threadId, record.projectId, signal);
      const home = await readSourceIdentity(runtime.bb, record.keeperThreadId, record.projectId, signal);
      if (source.endpoint.hostId !== record.hostId || source.endpoint.environmentId !== record.environmentId || source.endpoint.root !== record.root) throw new Error("The SDK member endpoint differs from its placement.");
      const branch = record.memberBranch ?? record.carries?.find(carry => carry.phase === "verified")?.branch;
      if (!branch) throw new Error("Tavern has no recorded private branch for this placement; reconcile it before opening a draft.");
      if (runtime.keeper.store.all("pullRequests").some(pr => pr.projectId === record.projectId && pr.head === branch && pr.owner !== threadId)) throw new Error("Another owner already has this branch’s pull request.");
      const fence = async () => {
        current();
        if (!isDeepStrictEqual(source, await readSourceIdentity(runtime.bb, threadId, record.projectId, signal)) || !isDeepStrictEqual(home, await readSourceIdentity(runtime.bb, record.keeperThreadId, record.projectId, signal))) throw new Error("A draft source endpoint changed.");
        current();
      };
      const call = async <M extends HostMethod>(hostId: string, method: M, value: HostInput<M>): Promise<HostOutput<M>> => {
        await fence(); const result = await services.host.call(hostId, method, value, { signal }); await fence();
        return hostContract[method].output.parse(result) as HostOutput<M>;
      };
      const from = { placementId: record.id, generation: record.generation, endpointId: "draft-source", operationId: randomUUID() };
      await call(source.endpoint.hostId, "registerEndpoint", { placementId: from.placementId, generation: from.generation, endpointId: from.endpointId, endpoint: source.endpoint, ownerThreadId: threadId, access: "source-read", git: "porcelain", workspaceKind: null, objectFormat: null, allowedRefs: [] });
      const inspection = await call(source.endpoint.hostId, "inspect", from);
      if (inspection.branch !== branch) throw new Error("The member is not on its own SDK branch.");
      const original = record.sourceSnapshotId ? services.store.snapshot(record.sourceSnapshotId) : null;
      if (!original?.fetch) throw new Error("The member has no pinned source base and remote.");
      const sourceBase = original.fetch.fetchRef.replace(/^refs\/heads\//, "");
      const base = input.base ?? sourceBase;
      const existingRecord = runtime.keeper.store.all("pullRequests").find(pr => pr.projectId === record.projectId && pr.head === branch);
      if (existingRecord && existingRecord.base !== base) return `This branch's draft targets ${existingRecord.base}; moving it comes later`;
      if ([base, sourceBase].some(value => value === branch || value === `refs/heads/${branch}`)) throw new Error("Tavern never pushes to the base branch.");
      const worktree = await call(source.endpoint.hostId, "worktreeState", { ...from, base: inspection.head });
      const snapshot = services.store.captureSnapshot({ purpose: "draft-pr", keeperThreadId: record.keeperThreadId, projectId: record.projectId,
        sourceThreadId: threadId, makerThreadId: threadId, makerSubmissionId: null, journalTarget: null,
        objectFormat: inspection.objectFormat, base: original.base, sourceHead: inspection.head, tree: inspection.tree,
        fetch: original.fetch, source: source.endpoint, home: original.home, includesUncommitted: false, userHead: inspection.head });
      services.store.update(record.id, record.generation, value => ({ ...value, draftSnapshotId: snapshot.id }));
      const pinned = await services.transport.bringHome(record.id, record.generation, snapshot.id, signal);
      if (!pinned.homeCommit) throw new Error("Broken contract: the carried draft has no verified home commit.");
      const to = { ...from, endpointId: "draft-home", operationId: randomUUID() };
      await call(home.endpoint.hostId, "registerEndpoint", { placementId: to.placementId, generation: to.generation, endpointId: to.endpointId, endpoint: { ...home.endpoint, root: original.home.root }, ownerThreadId: record.keeperThreadId,
        access: "home-import", git: "full", workspaceKind: null, objectFormat: inspection.objectFormat, allowedRefs: [], draft: { branch, base, sourceBase, remote: original.fetch.remoteUrl } });
      await call(home.endpoint.hostId, "inspect", to);
      const previous = runtime.keeper.member(threadId)?.draftPush;
      if (previous && (previous.branch !== branch || previous.remote !== original.fetch.remoteUrl)) throw new Error("The member's draft push destination changed.");
      const push = await call(home.endpoint.hostId, "draftPush", { ...to, sha: pinned.homeCommit, tree: inspection.tree, previous: previous?.homeHead ?? null });
      if (!push.pushed) {
        const failure = forgeFailure(push);
        event("member.draft-pr-failed", "Tavern could not push the draft", { ...failure, source: "tavern" });
        return `Tavern could not push the draft (${failure.failureClass}).\n${failure.lines}`;
      }
      const draftPush = { branch, remote: original.fetch.remoteUrl, memberHead: inspection.head, homeHead: pinned.homeCommit, profile: profile.id };
      runtime.keeper.store.put("members", threadId, { ...runtime.keeper.member(threadId)!, draftPush });
      event("member.draft-pushed", "Draft branch pushed from home", draftPush);
      const existing = runtime.keeper.store.all("pullRequests").find(pr => pr.projectId === record.projectId && pr.head === branch);
      if (existing) runtime.keeper.store.recordPullRequest({ ...existing, memberHead: inspection.head, pushedHead: pinned.homeCommit, verifiedCommit: null }, runtime.keeper.now());
      const forgeEndpoint = { ...to, endpointId: "draft-forge", operationId: randomUUID() };
      await call(home.endpoint.hostId, "registerEndpoint", { placementId: forgeEndpoint.placementId, generation: forgeEndpoint.generation, endpointId: forgeEndpoint.endpointId, endpoint: home.endpoint, ownerThreadId: record.keeperThreadId,
        access: "source-read", git: "full", workspaceKind: null, objectFormat: inspection.objectFormat, allowedRefs: [], draft: { branch, base, sourceBase, remote: original.fetch.remoteUrl } });
      await call(home.endpoint.hostId, "inspect", forgeEndpoint);
      const opened = await call(home.endpoint.hostId, "draftOpen", { ...forgeEndpoint, profile, title: input.title, body: input.body });
      if (!opened.ok) {
        event("member.draft-pr-failed", `Draft PR: ${profile.name}, ${opened.failureClass}`, opened);
        return `Forge ${profile.name}: ${opened.failureClass}.\n${opened.lines}`;
      }
      const pr = runtime.keeper.store.recordPullRequest({ keeperThreadId: record.keeperThreadId, boardQuestId: member.boardQuestId, projectId: record.projectId,
        url: opened.url, forge: profile.kind === "github" ? "gh" : profile.id, head: branch, base, owner: threadId,
        memberHead: inspection.head, pushedHead: pinned.homeCommit, verifiedCommit: null, state: opened.state === "merged" || opened.state === "closed" ? opened.state : "draft" }, runtime.keeper.now());
      event("member.draft-pr-opened", pullRequestLine(pr), { ...draftPush, url: opened.url });
      runtime.keeper.changed(threadId);
      return `${pullRequestLine(pr)}\nMember head: ${inspection.head}\nPushed home commit: ${pinned.homeCommit}\n${worktree.changed.length ? `Uncommitted files not included:\n${worktree.changed.join("\n")}` : "No uncommitted files were included."}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      event("member.draft-pr-failed", "Tavern could not open the draft", { source: "tavern", lines: message.slice(-4000) });
      return `Tavern could not open the draft: ${message.slice(-4000)}`;
    } finally { this.pending.delete(threadId); }
  }
  private async recordLocal(threadId: string, input: { title: string; body?: string; base?: string; url?: string; forge?: string }, signal?: AbortSignal): Promise<string> {
    if (!input.url) return "Your pull requests open on your own machine; open a draft with your own tools as your scope allows, then call tavern_draft_pr with its URL, title and base to record it.";
    const runtime = this.runtime, member = runtime.keeper.member(threadId)!;
    if (input.forge && input.forge !== "gh") {
      const policy = runtime.settings?.placementPolicy();
      if (policy?.state !== "valid" || !policy.settings.forges.some(profile => profile.id === input.forge && profile.enabled)) throw new Error("Choose an enabled forge profile that exists, or gh.");
    }
    if (!member.keeperThreadId) throw new Error("A draft pull request needs its Smith's Keeper.");
    const projectId = runtime.keeper.store.runtime(threadId).projectId;
    if (!projectId) throw new Error("The member has no source project.");
    const source = await readSourceIdentity(runtime.bb, threadId, projectId, signal);
    const env = await runtime.bb.sdk.environments.get({ environmentId: source.endpoint.environmentId! });
    if (!env.branchName) throw new Error("The member has no private branch.");
    if (runtime.keeper.store.all("pullRequests").some(pr => pr.projectId === projectId && pr.head === env.branchName && pr.owner !== threadId)) throw new Error("Another owner already has this branch’s pull request.");
    const services = runtime.placements(), placement = services.store.byMember(threadId);
    const original = placement?.sourceSnapshotId ? services.store.snapshot(placement.sourceSnapshotId) : null;
    const host = services.host;
    const authority = { placementId: "draft-record-" + threadId, generation: 1, endpointId: "source", operationId: randomUUID() };
    await host.call(source.endpoint.hostId, "registerEndpoint", { placementId: authority.placementId, generation: 1, endpointId: authority.endpointId, endpoint: source.endpoint, ownerThreadId: threadId, access: "source-read", git: placement ? "porcelain" : "full", workspaceKind: null, objectFormat: null, allowedRefs: [] }, { signal });
    const inspection = hostContract.inspect.output.parse(await host.call(source.endpoint.hostId, "inspect", authority, { signal }));
    if (inspection.branch !== env.branchName) throw new Error("The member is not on its own SDK branch.");
    const sourceBase = original?.fetch?.fetchRef ?? (!placement && inspection.sourceBase?.outcome === "ok" ? inspection.sourceBase.fetchRef : undefined);
    const base = input.base ?? sourceBase?.replace(/^refs\/heads\//, "");
    if (!base || base === env.branchName) throw new Error("Name a base branch distinct from the member's own branch.");
    const existing = runtime.keeper.store.all("pullRequests").find(pr => pr.projectId === projectId && pr.head === env.branchName);
    if (existing && existing.base !== base) return `This branch's draft targets ${existing.base}; moving it comes later`;
    const pr = runtime.keeper.store.recordPullRequest({ keeperThreadId: member.keeperThreadId, boardQuestId: member.boardQuestId, projectId,
      url: input.url, forge: input.forge ?? null, head: env.branchName, base, owner: threadId, memberHead: inspection.head, pushedHead: null, verifiedCommit: null, state: "draft" }, runtime.keeper.now());
    runtime.keeper.changed(threadId);
    return pullRequestLine(pr);
  }
}
