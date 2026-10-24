import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderSlotOptions, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ComponentType } from "react";
import { DEFAULT_CONFIG, type Config } from "../../src/config";
import { rpcContract, type EventView, type LinkView, type Overview, type PrView, type ServerStatus } from "../../src/contract";

export type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
/** GitHub PR Status's read, answered from the same map: the harness routes every plugin's RPC to it. */
export type PullRequests = (input: { keys: string[] }) => Record<string, unknown>;

export const NOW = Date.now();

// jsdom has no matchMedia. This one answers min- and max-width queries against a width the tests set.
const DESKTOP = 1440;
let width = DESKTOP;
const mediaListeners = new Set<() => void>();
function queryMatches(query: string): boolean {
  const max = /max-width:\s*(\d+)px/u.exec(query);
  const min = /min-width:\s*(\d+)px/u.exec(query);
  return (max === null || width <= Number(max[1])) && (min === null || width >= Number(min[1]));
}
window.matchMedia = (query: string) => ({
  get matches() { return queryMatches(query); },
  media: query,
  onchange: null,
  addEventListener: (_type: string, listener: () => void) => mediaListeners.add(listener),
  removeEventListener: (_type: string, listener: () => void) => mediaListeners.delete(listener),
  addListener: (listener: () => void) => mediaListeners.add(listener),
  removeListener: (listener: () => void) => mediaListeners.delete(listener),
  dispatchEvent: () => false,
}) as unknown as MediaQueryList;

/** 390 is a phone, 1000 a narrow window, 1440 a desktop. */
export function setViewport(next: number) {
  width = next;
  for (const listener of [...mediaListeners]) listener();
}

export function pr(overrides: Partial<PrView> = {}): PrView {
  const repo = overrides.repo ?? "get-bb/bb";
  const number = overrides.number ?? 4411;
  const server = overrides.server ?? "github";
  const sep = overrides.sep ?? "#";
  return {
    key: `${server}:${repo}${sep}${number}`,
    server,
    serverName: "GitHub",
    repo,
    number,
    sep,
    url: `https://github.com/${repo}/pull/${number}`,
    title: "Plugin SDK: a compact prop for thread header actions",
    author: "dana",
    mine: false,
    state: "open",
    checks: "passed",
    review: "required",
    head: "4be81d0aa",
    headRef: "dana/compact-header",
    base: "main",
    additions: 86,
    deletions: 12,
    files: 4,
    updatedAt: NOW - 25 * 60_000,
    reasons: [{ reason: "requested", teams: [] }],
    watch: null,
    links: [],
    lastReview: null,
    needs: null,
    stale: false,
    pendingItems: 0,
    labels: null,
    reviewers: null,
    actions: [],
    ...overrides,
  };
}

export const link = (overrides: Partial<LinkView> = {}): LinkView => ({ threadId: "thr_1", title: "Review get-bb/bb#4411", role: "review", archived: false, ...overrides });

export function server(overrides: Partial<ServerStatus> = {}): ServerStatus {
  return {
    id: "github", name: "GitHub", kind: "github", enabled: true, ok: true, login: "kalindudc", error: null,
    lastOkAt: NOW - 60_000, lastSyncAt: NOW - 60_000, durationMs: 1100,
    operations: ["whoami", "authored", "review_requested", "team_requested", "mentioned", "view", "activity"],
    ...overrides,
  };
}

export function overview(overrides: Partial<Overview> = {}): Overview {
  return {
    servers: [server(), server({ id: "delta", name: "Delta", kind: "command", login: "kalindu.decosta" })],
    counts: { needs: 1, requested: 2, team: 0, mentioned: 0, watching: 0, inflight: 3, done: 1 },
    syncedAt: NOW - 60_000,
    syncing: false,
    paused: false,
    ...overrides,
  };
}

export function config(overrides: Partial<Config> = {}): Config {
  const base = structuredClone(DEFAULT_CONFIG);
  return {
    ...base,
    presets: [
      { ...base.presets[0]!, skill: "pr-reviewer", providerId: "pi", model: "anthropic/claude-opus-4-7", reasoningLevel: "high" },
      { id: "quick", name: "Quick skim", default: false, skill: "", workspace: "project-default", prompt: "Skim {url}.{note}" },
    ],
    ...overrides,
  };
}

export const event = (overrides: Partial<EventView> = {}): EventView => ({ id: 1, at: NOW - 60_000, kind: "review_started", text: "Auto review started", key: null, threadId: null, ...overrides });

const unexpected = (method: string) => () => {
  throw new Error(`unexpected rpc ${method}`);
};

export function handlers(overrides: Partial<Handlers> = {}): Handlers {
  return {
    overview: () => overview(),
    list: () => ({ prs: [] }),
    detail: unexpected("detail"),
    lookup: unexpected("lookup"),
    activity: () => ({ events: [] }),
    sync: () => ({ ok: true }),
    link: unexpected("link"),
    unlink: unexpected("unlink"),
    watch: unexpected("watch"),
    review: unexpected("review"),
    newThread: unexpected("newThread"),
    dismiss: unexpected("dismiss"),
    threadPrs: () => ({ prs: [], sent: [] }),
    sendUnread: () => ({ sent: 0 }),
    threads: () => ({ threads: [] }),
    projects: () => ({ projects: [{ id: "prj_bb", name: "bb" }], suggested: "prj_bb" }),
    getConfig: () => ({ config: config() }),
    saveConfig: ({ config: next }) => ({ config: next as Config }),
    testServer: () => ({ results: [] }),
    exportToml: () => ({ toml: "" }),
    importToml: () => ({ changes: [], config: null }),
    skills: () => ({ skills: [{ id: "pr-reviewer", name: "pr-reviewer", description: "Multi-model critic consensus reviews" }] }),
    editPr: unexpected("editPr"),
    editOptions: () => ({ labels: [], people: [], teams: [] }),
    ...overrides,
  };
}

const mounted: RenderedSlot[] = [];

export async function app() {
  return loadPluginApp(() => import("../../app"));
}

export function mount<Props extends object>(component: ComponentType<Props>, props: Props, rpc: Handlers & { pullRequests?: PullRequests }, options: Omit<RenderSlotOptions<typeof rpcContract>, "rpc"> = {}): RenderedSlot {
  const slot = renderSlot<Props, typeof rpcContract>({ component }, props, {
    pluginId: "shuttle",
    openUrl: () => true,
    experimental_rpcContract: rpcContract,
    ...options,
    rpc,
  });
  mounted.push(slot);
  return slot;
}

export function unmountAll() {
  for (const slot of mounted.splice(0)) slot.lifecycle.unmount();
  document.body.replaceChildren();
  width = DESKTOP;
}

export const callsTo = (slot: RenderedSlot, method: string) => slot.inspection.rpcCalls.filter((call) => call.method === method).map((call) => call.input);
