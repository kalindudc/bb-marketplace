// Adapts bb.sdk to Loom's BbPort. bb.sdk is read inside each call, never at load.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract, type HostInput, type HostMethod, type HostOutput } from "./host-contract";
import { SectionNameConflictError, SpawnRefusedError, type BbPort, type HostPort } from "./ports";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isNotFound = (error: unknown) => /\b404\b|not[ _]found/iu.test(message(error));
const isNameConflict = (error: unknown) => /\b409\b|section_name_conflict/iu.test(message(error));
/** bb's SDK throws BbHttpError, whose `status` is the HTTP status. */
const refusedOr = (error: unknown): unknown => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429 ? new SpawnRefusedError(status, message(error)) : error;
};

export function createBbPort(bb: BbPluginApi): BbPort {
  return {
    async threadHostId(threadId) {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.environmentId !== null) return (await bb.sdk.environments.get({ environmentId: thread.environmentId })).hostId;
      return (await bb.sdk.system.config()).primaryHostId ?? null;
    },
    async ensureSection(sectionId, name) {
      const sections = await bb.sdk.threadSections.list();
      if (sectionId !== null && sections.some((section) => section.id === sectionId)) return sectionId;
      try {
        return (await bb.sdk.threadSections.create({ name })).id;
      } catch (error) {
        if (isNameConflict(error)) throw new SectionNameConflictError(name);
        throw error;
      }
    },
    async renameSection(sectionId, name) {
      await bb.sdk.threadSections.update({ id: sectionId, name });
    },
    async deleteSection(sectionId) {
      try {
        await bb.sdk.threadSections.delete({ id: sectionId });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
    async moveThread(threadId, sectionId) {
      await bb.sdk.threads.update({ threadId, sectionId });
    },
    async setMetadata(threadId, set) {
      await bb.sdk.threads.updatePluginMetadata({ threadId, set });
    },
    log(level, text) {
      bb.log[level](text);
    },
    async projectCheckout(bbProjectId, hostId) {
      const project = await bb.sdk.projects.get({ projectId: bbProjectId });
      const sources = project.sources.filter((source) => source.hostId === hostId);
      return (sources.find((source) => source.isDefault) ?? sources[0])?.path ?? null;
    },
    async spawnThread(args) {
      const thread = await bb.sdk.threads.spawn({
        projectId: args.bbProjectId,
        environment: { type: "host", hostId: args.hostId, workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: args.baseBranch } } },
        prompt: args.prompt,
        title: args.title,
        ...(args.sectionId === null ? {} : { sectionId: args.sectionId }),
        pluginMetadata: { ...args.metadata },
        ...(args.providerId === undefined ? {} : { providerId: args.providerId }),
        ...(args.model === undefined ? {} : { model: args.model }),
        ...(args.reasoningLevel === undefined ? {} : { reasoningLevel: args.reasoningLevel }),
        ...(args.permissionMode === undefined ? {} : { permissionMode: args.permissionMode }),
      }).catch((error: unknown) => {
        throw refusedOr(error);
      });
      return { threadId: thread.id, environmentId: thread.environmentId };
    },
    async send(threadId, message) {
      const input =
        typeof message === "string"
          ? [{ type: "text" as const, text: message, mentions: [] }]
          : [
              { type: "text" as const, text: message.summary, mentions: [] },
              { type: "text" as const, text: message.detail, mentions: [], visibility: "agent-only" as const },
            ];
      await bb.sdk.threads.send({ threadId, mode: "auto", input });
    },
    async stop(threadId) {
      await bb.sdk.threads.stop({ threadId });
    },
    async archive(threadId) {
      await bb.sdk.threads.archive({ threadId });
    },
    async getThread(threadId) {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        return { id: thread.id, status: thread.status, archivedAt: thread.archivedAt, deletedAt: thread.deletedAt, environmentId: thread.environmentId };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async getEnvironment(environmentId) {
      try {
        const environment = await bb.sdk.environments.get({ environmentId });
        return { path: environment.path, branchName: environment.branchName, hostId: environment.hostId, status: environment.status };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async findSpawnedThread(spawnToken) {
      const threads = await bb.sdk.threads.list({ originPluginId: bb.pluginId, includeHidden: true, limit: 200 });
      for (const thread of threads) {
        const metadata = (await bb.sdk.threads.getPluginMetadata({ threadId: thread.id }).catch(() => ({}))) as Record<string, unknown>;
        if (metadata.spawnToken === spawnToken) return thread.id;
      }
      return null;
    },
    async threadTokens(threadId) {
      const rows = await bb.sdk.threads.events.list({ threadId, types: ["thread/tokenUsage/updated"], order: "desc", limit: "1" });
      const total = (rows[0] as { data?: { tokenUsage?: { total?: { totalTokens?: number } } } } | undefined)?.data?.tokenUsage?.total?.totalTokens;
      return typeof total === "number" && Number.isFinite(total) ? total : null;
    },
    async latestSystemError(threadId) {
      const rows = await bb.sdk.threads.events.list({ threadId, types: ["system/error"], order: "desc", limit: "1" });
      const data = (rows[0] as { data?: { code?: string; message?: string } } | undefined)?.data;
      return data === undefined ? null : { code: data.code ?? null, message: data.message ?? "" };
    },
    async retryTurn(threadId, turnRequestId, sendAt) {
      await bb.sdk.threads.retry({ threadId, turnRequestId, sendAt, reason: "Rate limited (Loom retry)" });
    },
    async projectKind(bbProjectId) {
      try {
        return (await bb.sdk.projects.get({ projectId: bbProjectId })).kind;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async listProjects() {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      return projects.map((project) => ({
        id: project.id,
        name: project.name,
        kind: project.kind,
        gitRemoteUrl: project.gitRemoteUrl,
        sources: project.sources.map((source) => ({ hostId: source.hostId, path: source.path, isDefault: source.isDefault })),
      }));
    },
    async spawnPlanner({ request, title, kickoff }) {
      const thread = await bb.sdk.threads.spawn({ ...request, title, input: [...request.input, { type: "text", text: kickoff, mentions: [], visibility: "agent-only" }] });
      return thread.id;
    },
    async providerIds() {
      return (await bb.sdk.providers.list()).map((provider) => provider.id);
    },
    async waitingOnUser(threadIds) {
      const waiting = await Promise.all(
        threadIds.map(async (threadId) => {
          try {
            return (await bb.sdk.threads.interactions.list({ threadId })).some((row) => row.status === "pending");
          } catch (error) {
            if (isNotFound(error)) return false;
            throw error;
          }
        }),
      );
      return threadIds.filter((_, index) => waiting[index]);
    },
  };
}

const HOST_CALL_MS = 30_000;
const NETWORK_CALL_MS = 150_000;
const NETWORK_METHODS: readonly HostMethod[] = ["fetchBranch", "push", "prCreate", "prState", "ensureWorktree"];

/** The host entry client. Git calls get 30 s; fetches, pushes, gh and ensureWorktree (a first checkout) get 150 s; exec gets its own timeout plus 30 s, under the 30-minute host call cap. */
export function createHostPort(bb: BbPluginApi): HostPort {
  const client = bb.hosts.experimental_client({ contract: hostContract });
  return {
    call: <M extends HostMethod>(hostId: string, method: M, input: HostInput<M>) => {
      const timeoutMs = method === "exec" ? (input as HostInput<"exec">).timeoutMs + HOST_CALL_MS : NETWORK_METHODS.includes(method) ? NETWORK_CALL_MS : HOST_CALL_MS;
      return client.call(method, input, { hostId, timeoutMs }) as Promise<HostOutput<M>>;
    },
  };
}
