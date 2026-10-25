import { experimental_PluginRpcRefusal, type BbPluginApi } from "@get-bb/plugin-sdk";
import { sleep } from "./adapters/exec";
import { ConfigError } from "./config";
import { rpcContract } from "./contract";
import { NotFoundError, ShuttleError } from "./ctx";
import { LookupError } from "./keys";
import type { Shuttle } from "./shuttle";

/** Expected failures reach the UI as typed refusals (not_found, invalid) rather than handler errors. */
async function refusing<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof NotFoundError) throw new experimental_PluginRpcRefusal({ code: "not_found", message: error.message });
    if (error instanceof ShuttleError || error instanceof LookupError || error instanceof ConfigError) throw new experimental_PluginRpcRefusal({ code: "invalid", message: error.message });
    throw error;
  }
}

const WATCHED_FRESH_MS = 60_000;

export function registerRpc(bb: BbPluginApi, shuttle: Shuttle): void {
  bb.rpc.register(rpcContract, {
    overview: () => refusing(() => shuttle.overview()),
    inbox: () => refusing(() => shuttle.inbox()),
    list: ({ area }) => refusing(() => ({ prs: shuttle.list(area) })),
    detail: ({ key }) => refusing(() => shuttle.detailOrLookup(key)),
    conversation: ({ key }) => refusing(() => shuttle.conversation(key)),
    search: ({ query }) => refusing(() => shuttle.search(query)),
    lookup: ({ query }) => refusing(async () => ({ pr: await shuttle.lookup(query) })),
    activity: ({ limit }) => refusing(() => ({ events: shuttle.activity(limit) })),
    insights: ({ range }) => refusing(() => shuttle.insights(range)),
    // A sync can take a minute on a slow server; the page follows it through overview.syncing.
    sync: () => {
      shuttle.sync().catch((error: unknown) => bb.log.warn(`sync: ${error instanceof Error ? error.message : String(error)}`));
      return { ok: true as const };
    },
    link: ({ key, threadId, role }) => refusing(async () => ({ pr: await shuttle.link(key, threadId, role ?? "owner") })),
    unlink: ({ key, threadId }) => refusing(async () => ({ pr: await shuttle.unlink(key, threadId) })),
    watch: ({ key, mode }) => refusing(() => ({ pr: shuttle.watch(key, mode) })),
    setAgent: ({ key, target, mode }) => refusing(() => shuttle.setAgent(key, target, mode)),
    setAgentMode: ({ key, mode }) => refusing(async () => ({ pr: await shuttle.setAgentMode(key, mode) })),
    askAgent: ({ key, text }) => refusing(async () => {
      await shuttle.askAgent(key, text);
      return { ok: true as const };
    }),
    setSettings: (patch) => refusing(async () => {
      await shuttle.setSettings(patch);
      return { ok: true as const };
    }),
    track: ({ key, on }) => refusing(() => ({ pr: shuttle.track(key, on) })),
    snooze: ({ key, until }) => refusing(() => ({ pr: shuttle.snooze(key, until) })),
    handle: ({ key, on }) => refusing(() => ({ pr: shuttle.handle(key, on) })),
    review: (input) => refusing(() => shuttle.review(input)),
    newThread: ({ key, start, projectId }) => refusing(async () => ({ threadId: await shuttle.newThread(key, start, projectId) })),
    threadPrs: ({ threadId }) => refusing(() => shuttle.threadPrs(threadId)),
    sendUnread: ({ threadId }) => refusing(async () => ({ sent: await shuttle.sendUnread(threadId) })),
    threads: ({ query }) => refusing(async () => ({ threads: await shuttle.threads(query) })),
    projects: ({ key }) => refusing(() => shuttle.projectOptions(key)),
    getConfig: () => refusing(() => ({ config: shuttle.config() })),
    saveConfig: ({ config }) => refusing(() => ({ config: shuttle.saveConfig(config) })),
    testServer: (input) => refusing(async () => ({ results: await shuttle.testServer(input) })),
    exportToml: () => refusing(() => ({ toml: shuttle.exportToml() })),
    importToml: ({ toml, apply }) => refusing(() => shuttle.importToml(toml, apply)),
    editPr: ({ key, change }) => refusing(async () => ({ pr: await shuttle.editPr(key, change) })),
    editOptions: ({ key }) => refusing(() => shuttle.editOptions(key)),
    mergeOptions: ({ key }) => refusing(() => shuttle.mergeOptions(key)),
    merge: ({ key, ...input }) => refusing(() => shuttle.merge(key, input)),
    cancelAutoMerge: ({ key }) => refusing(async () => ({ pr: await shuttle.cancelAutoMerge(key) })),
    comment: ({ key, body }) => refusing(async () => ({ pr: await shuttle.comment(key, body) })),
    submitReview: ({ key, ...input }) => refusing(() => shuttle.submitReview(key, input)),
    discardDraft: ({ key, draftId }) => refusing(async () => ({ pr: await shuttle.discardDraft(key, draftId) })),
    restoreDraft: ({ key, draftId }) => refusing(async () => ({ pr: await shuttle.restoreDraft(key, draftId) })),
    reply: ({ key, thread, body }) => refusing(async () => {
      await shuttle.reply(key, thread, body);
      return { ok: true as const };
    }),
    resolve: ({ key, thread, resolved }) => refusing(async () => {
      await shuttle.resolve(key, thread, resolved);
      return { ok: true as const };
    }),
    skills: ({ projectId }) => refusing(async () => ({ skills: await shuttle.skills(projectId) })),
  });

  // While a PR's drawer or a thread's PRs are on screen, keep those PRs fresh from their server.
  const keepFresh = (keys: (input: unknown) => string[]) => async (read: { input: unknown } | { key: string }, signal: AbortSignal) => {
    if (!("input" in read)) return;
    while (!signal.aborted) {
      await shuttle.refreshStale(keys(read.input), WATCHED_FRESH_MS, signal);
      await sleep(WATCHED_FRESH_MS, signal);
    }
  };
  bb.rpc.experimental_whileWatched("detail", keepFresh((input) => [(input as { key: string }).key]));
  bb.rpc.experimental_whileWatched("threadPrs", keepFresh((input) => shuttle.threadPrs((input as { threadId: string }).threadId).prs.map((pr) => pr.key)));
}
