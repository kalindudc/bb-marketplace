import type { BbPluginApi, JsonValue } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { SpawnUnavailableError, UsageUnavailableError, type BbPort, type SpawnArgs, type ThreadInfo, type UsageRead } from "./ports";

type ThreadSpawnArgs = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];

const THREAD_PAGE = 500;
/** A review's critics and helpers; a busy one among the first this many is enough to know the review is at work. */
const CHILD_LIMIT = 100;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** bb's own words, without the "HTTP 409: " BbHttpError puts first. */
const bbMessage = (error: unknown) => message(error).replace(/^HTTP \d{3}: /u, "");
const isNotFound = (error: unknown) => /\b404\b|not[ _]found/iu.test(message(error));

/**
 * bb's SDK throws BbHttpError, with the HTTP `status`, bb's error `code` and the parsed `body`. A machine provider that
 * cannot start a machine now, such as one whose pool is full, makes bb refuse with 409 machine_provider_rejected; an
 * environment provider whose availability check answers "unavailable" makes it refuse with 409
 * environment_provider_rejected and details.availabilityStatus. Those, and any error bb marks retryable, may pass soon.
 */
export function spawnErrorOf(error: unknown): unknown {
  const http = (error ?? {}) as { status?: unknown; code?: unknown; body?: unknown };
  const body = (http.body ?? {}) as { retryable?: unknown; details?: { availabilityStatus?: unknown } | null };
  const unavailable = http.status === 409 && (http.code === "machine_provider_rejected" || (http.code === "environment_provider_rejected" && body.details?.availabilityStatus === "unavailable"));
  return body.retryable === true || unavailable ? new SpawnUnavailableError(bbMessage(error)) : error;
}

/** The plugin that reads what every thread used: pi's session logs, OpenCode's and Claude Code's records, and bb's usage events. */
export const BURN = "burn";

const count = z.number().finite().nonnegative();
const tokens = z.object({ input: count, output: count, cacheRead: count, cacheWrite: count });
/** The part of Burn's `usage` answer Shuttle reads; other fields are dropped, so a newer Burn still parses. */
export const burnUsageSchema = z.object({
  report: z
    .object({
      startedAt: count,
      updatedAt: count,
      calls: count,
      tokens,
      cost: z.object({ total: count }),
      estimated: z.boolean(),
      byModel: z.array(z.object({ key: z.string(), cost: count })),
      turns: z.array(z.object({ n: count, at: count, calls: count, cost: count, tokens, models: z.array(z.string()) })),
    })
    .nullable(),
  family: z.object({ children: z.array(z.object({ threadId: z.string() })) }),
});

/** Burn's answer as Shuttle keeps it. */
export function usageOf(answer: z.infer<typeof burnUsageSchema>): UsageRead {
  const report = answer.report;
  const descendants = answer.family.children.map((child) => child.threadId);
  if (report === null) return { usage: null, descendants };
  const costliest = [...report.byModel].sort((a, b) => b.cost - a.cost)[0]?.key ?? null;
  return {
    usage: {
      startedAt: report.startedAt,
      updatedAt: report.updatedAt,
      calls: report.calls,
      tokens: report.tokens,
      cost: report.cost.total,
      estimated: report.estimated,
      model: costliest,
      turns: report.turns.map((turn) => ({ n: turn.n, at: turn.at, calls: turn.calls, cost: turn.cost, tokens: turn.tokens, model: turn.models[0] ?? costliest })),
    },
    descendants,
  };
}

/** bb answers 404 for a plugin it does not have, and for one that is installed but not running. */
const pluginMissing = (error: unknown) => (error as { status?: unknown } | null)?.status === 404 || /\bunknown plugin\b|\bnot running\b|\bdisabled\b/iu.test(message(error));

/** The environment's `hostLifecycle` once bb removes its machine; a suspended machine stays active, since a message resumes it. */
const MACHINE_GONE = new Set(["removed", "removing", "cleanup-failed"]);

type ThreadLike = {
  id: string;
  title: string | null;
  titleFallback?: string | null;
  archivedAt: number | null;
  projectId: string | null;
  status: string;
  hasPendingInteraction?: boolean;
  environmentBranchName?: string | null;
  updatedAt?: number | null;
  queuedMessageCount?: number;
  providerId?: string | null;
  canRestoreEnvironment?: boolean;
  environmentId?: string | null;
  /** Only with `include: "environment"`. */
  environment?: { hostLifecycle?: string } | null;
};

function toThread(thread: ThreadLike): ThreadInfo {
  return {
    id: thread.id,
    title: thread.title ?? thread.titleFallback ?? "Untitled thread",
    archived: thread.archivedAt !== null,
    projectId: thread.projectId,
    status: thread.status,
    waiting: thread.hasPendingInteraction === true,
    branch: thread.environmentBranchName ?? null,
    updatedAt: thread.updatedAt ?? null,
    queuedMessageCount: thread.queuedMessageCount ?? 0,
    providerId: thread.providerId ?? null,
    canRestoreEnvironment: thread.canRestoreEnvironment === true,
    machineRemoved: MACHINE_GONE.has(thread.environment?.hostLifecycle ?? ""),
    ...(thread.environmentId !== undefined ? { hasWorkspace: thread.environmentId !== null } : {}),
  };
}

export function createBbPort(bb: BbPluginApi, setSettings: BbPort["setSettings"] = async () => {}): BbPort {
  let publishTimer: ReturnType<typeof setTimeout> | null = null;
  let warm: (() => void) | null = null;
  let pendingInvalidations = new Set<string>();
  /** A managed worktree is made on a machine: the one with the project's default checkout, else bb's primary machine. */
  const hostFor = async (projectId: string): Promise<string> => {
    const project = await bb.sdk.projects.get({ projectId });
    const source = project.sources.find((s) => s.isDefault) ?? project.sources[0];
    if (source) return source.hostId;
    const primary = (await bb.sdk.system.config()).primaryHostId;
    if (primary) return primary;
    throw new Error(`no machine has a checkout of project ${project.name}, so a worktree cannot be made for it`);
  };
  const environmentFor = async (args: SpawnArgs): Promise<ThreadSpawnArgs["environment"]> => {
    const workspace = args.workspace;
    switch (workspace.kind) {
      case "project-default":
        return { type: "project-default" };
      case "worktree":
        return { type: "host", hostId: await hostFor(args.projectId), workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } };
      case "provider":
        return {
          type: "provider",
          environmentProviderId: workspace.providerId,
          inputs: workspace.inputs as JsonValue,
          machine: workspace.machine
            ? // bb refuses any inputs, {} included, from a machine provider that takes none, and reads null as {} for one that takes some.
              { type: "new", machineProviderId: workspace.machine.providerId, inputs: Object.keys(workspace.machine.inputs).length === 0 ? null : (workspace.machine.inputs as JsonValue) }
            : { type: "existing", hostId: await hostFor(args.projectId) },
        };
      case "path":
        return { type: "host", hostId: await hostFor(args.projectId), workspace: { type: "unmanaged", path: workspace.path } };
    }
  };
  return {
    async spawnThread(args) {
      const environment = await environmentFor(args);
      const thread = await bb.sdk.threads.spawn({
        projectId: args.projectId,
        environment,
        prompt: args.prompt,
        title: args.title,
        pluginMetadata: args.metadata,
        ...(args.providerId ? { providerId: args.providerId } : {}),
        ...(args.model ? { model: args.model } : {}),
        ...(args.reasoningLevel ? { reasoningLevel: args.reasoningLevel } : {}),
        ...(args.sectionId ? { sectionId: args.sectionId } : {}),
      }).catch((error: unknown) => {
        throw spawnErrorOf(error);
      });
      return thread.id;
    },
    async send(threadId, text, options = {}) {
      await bb.sdk.threads.send({
        threadId,
        mode: options.mode ?? "auto",
        input: [{ type: "text", text, mentions: [] }],
        ...(options.model ? { model: options.model } : {}),
        ...(options.reasoningLevel ? { reasoningLevel: options.reasoningLevel } : {}),
      });
    },
    async archive(threadId) {
      return (await bb.sdk.threads.archive({ threadId })).archivedThreadIds;
    },
    async unarchive(threadId) {
      await bb.sdk.threads.unarchive({ threadId });
    },
    async restoreEnvironment(threadId) {
      await bb.sdk.threads.restoreEnvironment({ threadId });
    },
    async ensureSection(name) {
      const find = async () => (await bb.sdk.threadSections.list()).find((section) => section.name.trim().toLowerCase() === name.toLowerCase())?.id;
      const existing = await find();
      if (existing) return existing;
      try {
        return (await bb.sdk.threadSections.create({ name })).id;
      } catch (error) {
        // Another spawn may have created it a moment ago.
        const raced = await find();
        if (raced) return raced;
        throw error;
      }
    },
    async getThread(threadId) {
      try {
        return toThread((await bb.sdk.threads.get({ threadId, include: "environment" })) as ThreadLike);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async threadOutput(threadId) {
      return (await bb.sdk.threads.output({ threadId })).output;
    },
    async listThreads(limit) {
      // Without `archived: false` bb mixes in archived threads. bb orders by project before date, so read every page:
      // a single page could leave out the most recent threads.
      const out: ThreadInfo[] = [];
      for (let offset = 0; out.length < limit; offset += THREAD_PAGE) {
        const size = Math.min(THREAD_PAGE, limit - out.length);
        const threads = (await bb.sdk.threads.list({ archived: false, limit: size, offset })) as ThreadLike[];
        out.push(...threads.map(toThread));
        if (threads.length < size) break;
      }
      return out;
    },
    async threadsById(threadIds) {
      if (threadIds.length === 0) return [];
      const threads = (await bb.sdk.threads.list({ threadIds, limit: threadIds.length })) as ThreadLike[];
      return threads.map(toThread);
    },
    async childThreads(threadId) {
      const threads = (await bb.sdk.threads.list({ parentThreadId: threadId, archived: false, limit: CHILD_LIMIT })) as ThreadLike[];
      return threads.map(toThread);
    },
    async listProjects() {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      return projects.map((project) => ({ id: project.id, name: project.name, gitRemoteUrl: project.gitRemoteUrl ?? null }));
    },
    async listSkills(projectId) {
      const result = await bb.sdk.skills.list({ projectId, environmentId: null });
      return result.skills.map((skill) => ({ id: skill.id, name: skill.name, description: skill.description ?? "" }));
    },
    async environmentProviders() {
      return (await bb.sdk.environments.listProviders()).map((provider) => ({
        id: provider.id,
        displayName: provider.displayName,
        description: provider.description,
        inputs: provider.inputs,
        machineProviderId: provider.machineProviderId ?? null,
      }));
    },
    async machineProviders() {
      return (await bb.sdk.hosts.experimental_listProviders()).map((provider) => ({
        id: provider.id,
        displayName: provider.displayName,
        description: provider.description,
        inputs: provider.inputs,
      }));
    },
    setSettings,
    publish(tags = ["prs", "servers", "conversation", "boards"]) {
      // Many changes land together during a sync; one signal is enough.
      for (const tag of tags) pendingInvalidations.add(tag);
      if (publishTimer) return;
      publishTimer = setTimeout(() => {
        publishTimer = null;
        const invalidate = [...pendingInvalidations];
        pendingInvalidations = new Set<string>();
        // The page reads again as soon as it hears; what it reads is built once here, not once for each read.
        if (invalidate.includes("prs")) {
          try {
            warm?.();
          } catch (error) {
            bb.log.warn(`index: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        bb.rpc.experimental_invalidate(invalidate);
      }, 150);
    },
    beforePublish(fn) {
      warm = fn;
    },
    log(level, text) {
      bb.log[level](text);
    },
    async notify(title, body) {
      try {
        await bb.sdk.plugins.callRpc({
          pluginId: "push-notifications", method: "notifications.send", input: { title: title.slice(0, 200), body: body.slice(0, 1000) },
          outputSchema: z.object({ ok: z.literal(true) }).passthrough(),
        });
      } catch (error) {
        bb.log.info(`no notification sent (${title}): ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async threadUsage(threadId) {
      try {
        return usageOf(await bb.sdk.plugins.callRpc({ pluginId: BURN, method: "usage", input: { threadId }, outputSchema: burnUsageSchema }));
      } catch (error) {
        if (pluginMissing(error)) throw new UsageUnavailableError(bbMessage(error));
        throw error;
      }
    },
  };
}
