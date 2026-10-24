import type { BbPluginApi, JsonValue } from "@get-bb/plugin-sdk";
import type { BbPort, SpawnArgs, ThreadInfo } from "./ports";

type ThreadSpawnArgs = Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0];

const isNotFound = (error: unknown) => /\b404\b|not[ _]found/iu.test(error instanceof Error ? error.message : String(error));

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
  };
}

export function createBbPort(bb: BbPluginApi, setSettings: BbPort["setSettings"] = async () => {}): BbPort {
  let publishTimer: ReturnType<typeof setTimeout> | null = null;
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
        return { type: "provider", environmentProviderId: workspace.providerId, inputs: workspace.inputs as JsonValue, machine: { type: "existing", hostId: await hostFor(args.projectId) } };
      case "path":
        return { type: "host", hostId: await hostFor(args.projectId), workspace: { type: "unmanaged", path: workspace.path } };
    }
  };
  return {
    async spawnThread(args) {
      const thread = await bb.sdk.threads.spawn({
        projectId: args.projectId,
        environment: await environmentFor(args),
        prompt: args.prompt,
        title: args.title,
        pluginMetadata: args.metadata,
        ...(args.providerId ? { providerId: args.providerId } : {}),
        ...(args.model ? { model: args.model } : {}),
        ...(args.reasoningLevel ? { reasoningLevel: args.reasoningLevel } : {}),
        ...(args.sectionId ? { sectionId: args.sectionId } : {}),
      });
      return thread.id;
    },
    async send(threadId, text) {
      await bb.sdk.threads.send({ threadId, mode: "auto", input: [{ type: "text", text, mentions: [] }] });
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
        return toThread((await bb.sdk.threads.get({ threadId })) as ThreadLike);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async listThreads(limit) {
      const threads = (await bb.sdk.threads.list({ limit })) as ThreadLike[];
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
    setSettings,
    publish() {
      // Many changes land together during a sync; one signal is enough.
      if (publishTimer) return;
      publishTimer = setTimeout(() => {
        publishTimer = null;
        bb.rpc.experimental_invalidate(["prs", "servers", "conversation"]);
      }, 150);
    },
    log(level, text) {
      bb.log[level](text);
    },
  };
}
