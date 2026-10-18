import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createCli, type OverviewRequest } from "./src/cli";
import { buildOverview, type CollectDeps, type HostCall } from "./src/collect";
import { hostContract, rpcContract, type HostInput, type HostMethod, type HostOutput, type Overview } from "./src/contract";
import { createEditIndex, findRecordedEdits, type EventsSdk } from "./src/edits";
import { createRepoCache, isDeltaOnly } from "./src/repo-cache";
import { loadCommitFiles, loadPatch } from "./src/sources";

const HOST_TIMEOUT_MS = 25_000;
const MAX_RECORDED_EDITS = 50;
const SETTINGS_CHANNEL = "vantage:settings";
const FILE_ENVIRONMENT_CHANGES = ["work-status-changed", "git-refs-changed", "status-changed"];

export default function vantage(bb: BbPluginApi): void {
  const hostClient = bb.hosts.experimental_client({ contract: hostContract });
  // HostCall's generic method name is what the client's per-method return type cannot see through.
  const host: HostCall = <M extends HostMethod>(method: M, input: HostInput<M>, options: { hostId: string; signal?: AbortSignal }) =>
    hostClient.call(method, input, { ...options, timeoutMs: HOST_TIMEOUT_MS }) as Promise<HostOutput<M>>;
  // bb.sdk only works while the plugin is bound, so it is read inside calls, never at load.
  const events: EventsSdk = { threads: { events: { list: (args) => bb.sdk.threads.events.list(args) } } };
  const edits = createEditIndex(events);
  const deps = (): CollectDeps => ({ sdk: bb.sdk, host, edits });

  const settings = bb.settings.define({
    windowHours: {
      type: "number", default: 24, label: "Time window for the full-screen page (hours)",
      description: "The full-screen page shows threads active within this many hours, plus anything running and threads archived in that time.",
      experimental_schema: z.number().int().min(1).max(720),
    },
    maxThreads: {
      type: "number", default: 200, label: "Most threads on the full-screen page",
      description: "The page reads at most this many of the most recent threads. A higher limit makes the first load slower.",
      experimental_schema: z.number().int().min(10).max(500),
    },
  });
  const cache = createRepoCache();
  settings.onChange(() => {
    cache.clear();
    bb.realtime.publish(SETTINGS_CHANNEL, {});
  });

  const unsubscribers = [
    bb.sdk.subscribe({
      event: "thread:changed",
      callback(event) {
        if (event.id !== undefined && !isDeltaOnly(event.metadata?.eventTypes)) cache.invalidateThreads([event.id]);
      },
    }),
    bb.sdk.subscribe({
      event: "environment:changed",
      callback(event) {
        if (event.id !== undefined && event.changes.some((change) => FILE_ENVIRONMENT_CHANGES.includes(change))) cache.invalidateEnvironment(event.id);
      },
    }),
  ];
  bb.onDispose(() => { for (const unsubscribe of unsubscribers) unsubscribe(); });

  // Every open window asks for the same page at once, so they share one build; the cache makes the next one cheap.
  const building = new Map<string, Promise<Overview>>();
  async function overview(input: OverviewRequest & { refresh?: boolean }): Promise<Overview> {
    const { target, scope, refresh } = input;
    if (target.kind === "tree") return buildOverview(deps(), { target, scope, refresh });
    const { windowHours, maxThreads } = await settings.get();
    const allOptions = { windowHours: input.hours ?? windowHours, maxThreads };
    const key = [scope, allOptions.windowHours, maxThreads, refresh === true].join("\0");
    let pending = building.get(key);
    if (pending === undefined) {
      // No caller's abort signal: the build is shared, and finishing it warms the cache for the next one.
      pending = buildOverview({ ...deps(), allOptions, cache }, { target, scope, refresh });
      building.set(key, pending);
      const done = () => { building.delete(key); };
      pending.then(done, done);
    }
    return pending;
  }

  bb.rpc.register(rpcContract, {
    overview: (input) => overview(input),
    patch: (input) => loadPatch(deps(), input),
    commitFiles: (input) => loadCommitFiles(deps(), input),
    recordedEdits: async ({ threadIds, rawPaths }) => ({
      edits: await findRecordedEdits(events, threadIds, new Set(rawPaths), MAX_RECORDED_EDITS),
    }),
  });
  // `ancestorIds` runs from the parent up to the tree's root.
  const rootOf = async (threadId: string, signal: AbortSignal): Promise<string> => {
    const found = await bb.sdk.threads.experimental_listAncestors({ threadIds: [threadId], signal });
    return found.threads.find((entry) => entry.threadId === threadId)?.ancestorIds.at(-1) ?? threadId;
  };
  bb.cli.register(createCli((input, signal) => (
    input.target.kind === "tree" ? buildOverview(deps(), input, signal) : overview(input)
  ), rootOf));
  bb.log.info("loaded");
}
