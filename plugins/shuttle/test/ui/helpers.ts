import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderSlotOptions, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { createElement, type ComponentType } from "react";
import { DEFAULT_CONFIG, type Config } from "../../src/config";
import {
  rpcContract, type AgentView, type ConversationItem, type EventView, type InboxView, type InsightsView, type LinkView, type MergeOptions,
  type NextStep, type Overview, type PrView, type ReviewDraft, type ServerStatus,
} from "../../src/contract";
import { reloadPrefs } from "../../src/ui/prefs";
import { prStates } from "../../src/ui/pr-state";

export type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
/** GitHub PR Status's read, answered from the same map: the harness routes every plugin's RPC to it. */
export type PullRequests = (input: { keys: string[] }) => Record<string, unknown>;

export const NOW = Date.now();
export const HOUR = 60 * 60_000;
export const DAY = 24 * HOUR;

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

/** A quiet next step: waiting for review, nothing to press, not in the Inbox. */
export function next(overrides: Partial<NextStep> = {}): NextStep {
  return {
    kind: "waiting_review", tone: "neutral", label: "Waiting for review · 1d", why: "2 reviewers asked; nobody has approved yet.",
    clears: null, inbox: false, primary: null, more: [], ...overrides,
  };
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
    checkCounts: null,
    review: "required",
    head: "4be81d0aa",
    headRef: "dana/compact-header",
    base: "main",
    additions: 86,
    deletions: 12,
    files: 4,
    updatedAt: NOW - 25 * 60_000,
    createdAt: NOW - DAY,
    closedAt: null,
    reasons: [{ reason: "requested", teams: [] }],
    teams: [],
    requestedAt: NOW - 5 * HOUR,
    bot: false,
    quiet: false,
    tracked: false,
    links: [],
    agent: null,
    suggestedAgent: null,
    watch: null,
    lastReview: null,
    reviewThread: null,
    myReview: null,
    draft: null,
    next: next(),
    snoozedUntil: null,
    handled: false,
    autoMerge: false,
    stale: false,
    staleSince: null,
    pendingItems: 0,
    labels: null,
    reviewers: null,
    actions: [],
    can: { merge: false, comment: false, review: false, reply: false, resolve: false },
    ...overrides,
  };
}

/** One of the user's own PRs. */
export const mine = (overrides: Partial<PrView> = {}) => pr({ mine: true, author: "kalindudc", reasons: [{ reason: "authored", teams: [] }], requestedAt: null, ...overrides });

export const CAN_ALL: PrView["can"] = { merge: true, comment: true, review: true, reply: true, resolve: true };

export const agent = (overrides: Partial<AgentView> = {}): AgentView => ({
  threadId: "thr_agent", title: "CF token containment 2: retry WAF deletes", mode: "fix", status: "idle", auto: false, lastSent: null, ...overrides,
});

export const link = (overrides: Partial<LinkView> = {}): LinkView => ({ threadId: "thr_1", title: "Review get-bb/bb#4411", role: "review", archived: false, ...overrides });

export function draft(overrides: Partial<ReviewDraft> = {}): ReviewDraft {
  return {
    id: 7, threadId: "thr_review", threadTitle: "Review get-bb/bb#4411", preset: "Standard review", trigger: "auto", head: "4be81d0aa", at: NOW - 55 * 60_000,
    summary: "Thanks, this unblocks the header. One race and an ordering bug.", verdict: "changes",
    findings: [
      { id: "a", severity: "high", path: "src/header/actions.tsx", line: 88, body: "The compact prop never reaches the overflow menu." },
      { id: "b", severity: "medium", path: "src/header/menu.tsx", line: 31, body: "The menu closes before the action runs." },
      { id: "c", severity: "nit", path: "src/header/README.md", line: null, body: "The README still names the old prop." },
    ],
    ...overrides,
  };
}

export function item(overrides: Partial<ConversationItem> = {}): ConversationItem {
  return {
    id: "c1", kind: "thread", author: "alice-w", bot: false, mine: false, state: null, body: "The retry should back off.", path: "app/jobs/waf.rb", line: 42,
    url: "https://github.com/get-bb/bb/pull/4411#discussion_r1", at: NOW - 40 * 60_000, thread: "PRRT_1", resolved: false, delivery: null, outcome: null, ...overrides,
  };
}

export function server(overrides: Partial<ServerStatus> = {}): ServerStatus {
  return {
    id: "github", name: "GitHub", kind: "github", enabled: true, ok: true, login: "kalindudc", error: null,
    lastOkAt: NOW - 60_000, lastSyncAt: NOW - 60_000, durationMs: 1100,
    operations: ["whoami", "authored", "review_requested", "team_requested", "mentioned", "view", "activity"],
    state: "ok", failures: 0, failingSince: null, failure: null, failedSteps: [], stepOkAt: {}, alert: false, nextSyncAt: NOW + 120_000, lastFailedAt: null,
    ...overrides,
  };
}

export function overview(overrides: Partial<Overview> = {}): Overview {
  return {
    servers: [server(), server({ id: "delta", name: "Delta", kind: "command", login: "kalindu.decosta" })],
    counts: { inbox: 2, mine: 3, done: 1, reviews: 12 },
    syncedAt: NOW - 60_000,
    syncing: false,
    paused: false,
    autoAgent: false,
    ...overrides,
  };
}

export function inbox(overrides: Partial<InboxView> = {}): InboxView {
  return { prs: [], agents: { open: 0, withAgent: 0, working: 0, waiting: 0, none: 0 }, olderRequests: 0, handled: [], ...overrides };
}

export function insights(overrides: Partial<InsightsView> = {}): InsightsView {
  return {
    range: "30d", collectingSince: null,
    kpis: { merged: 0, opened: 0, timeToMerge: null, firstReviewWait: null, reviewResponse: null },
    phases: null,
    feedback: { total: 0, fixed: 0, replied: 0, declined: 0, you: 0, open: 0, agentMedianMs: null },
    requests: [], openRequests: [], ai: [], reviewers: [], ideas: [],
    ...overrides,
  };
}

export const mergeOptions = (overrides: Partial<MergeOptions> = {}): MergeOptions => ({
  methods: ["squash", "merge"], default: "squash", deleteBranch: true, canAuto: true, state: "clean", detail: null, ...overrides,
});

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

export const event = (overrides: Partial<EventView> = {}): EventView => ({ id: 1, at: NOW - 60_000, kind: "review", text: "Auto review started", key: null, threadId: null, ...overrides });

const unexpected = (method: string) => () => {
  throw new Error(`unexpected rpc ${method}`);
};

export function handlers(overrides: Partial<Handlers> = {}): Handlers {
  return {
    overview: () => overview(),
    inbox: () => inbox(),
    list: () => ({ prs: [] }),
    detail: unexpected("detail"),
    conversation: () => ({ items: [], error: null, fetchedAt: NOW }),
    lookup: unexpected("lookup"),
    search: () => ({ prs: [], total: 0 }),
    activity: () => ({ events: [] }),
    insights: () => insights(),
    sync: () => ({ ok: true }),
    syncHistory: () => ({ windowMs: 3 * 3_600_000, servers: [] }),
    link: unexpected("link"),
    unlink: unexpected("unlink"),
    watch: unexpected("watch"),
    setAgent: unexpected("setAgent"),
    setAgentMode: unexpected("setAgentMode"),
    askAgent: unexpected("askAgent"),
    setSettings: unexpected("setSettings"),
    track: unexpected("track"),
    snooze: unexpected("snooze"),
    handle: unexpected("handle"),
    review: unexpected("review"),
    newThread: unexpected("newThread"),
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
    mergeOptions: () => mergeOptions(),
    merge: unexpected("merge"),
    cancelAutoMerge: unexpected("cancelAutoMerge"),
    comment: unexpected("comment"),
    submitReview: unexpected("submitReview"),
    discardDraft: unexpected("discardDraft"),
    restoreDraft: unexpected("restoreDraft"),
    reply: unexpected("reply"),
    resolve: unexpected("resolve"),
    boards: () => ({ boards: [] }),
    board: unexpected("board"),
    boardCreate: unexpected("boardCreate"),
    boardUpdate: unexpected("boardUpdate"),
    boardAdd: unexpected("boardAdd"),
    boardRemove: unexpected("boardRemove"),
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
  // What the page remembers on this device must not leak from one test into the next.
  window.localStorage.clear();
  window.sessionStorage.clear();
  reloadPrefs();
  prStates.reload();
}

export const callsTo = (slot: RenderedSlot, method: string) => slot.inspection.rpcCalls.filter((call) => call.method === method).map((call) => call.input);

/** The page at a subPath, and what bb's router does after a navigation: the same page with the new subPath. */
export async function page(subPath: string, rpc: Partial<Handlers> = {}, options: Omit<RenderSlotOptions<typeof rpcContract>, "rpc"> = {}) {
  const loaded = await app();
  const panel = loaded.navPanels[0]!;
  const slot = mount(panel.component, { subPath }, handlers(rpc), options);
  const route = (nextPath: string) => slot.lifecycle.rerender(createElement(panel.component, { subPath: nextPath }));
  return { slot, route };
}

/** Waits for an element by selector, under the slot's container or the whole document. */
export async function find(root: ParentNode, selector: string): Promise<HTMLElement> {
  const { waitFor } = await import("@testing-library/react");
  return waitFor(() => {
    const found = root.querySelector<HTMLElement>(selector);
    if (found === null) throw new Error(`no ${selector}`);
    return found;
  });
}

export const lastNavigation = (slot: RenderedSlot) => slot.inspection.navigateCalls.at(-1);
