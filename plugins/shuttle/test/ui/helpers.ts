import { loadPluginApp, renderSlot, type PluginRpcTestHandlers, type RenderSlotOptions, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import { createElement, type ComponentType } from "react";
import { afterEach, beforeEach, vi } from "vitest";
import { DEFAULT_CONFIG, type Config } from "../../src/config";
import {
  type AutoPostInsights,
  mutationTags, rpcContract, type AgentView, type ConversationItem, type EventView, type InboxView, type InsightsView, type LinkView, type MergeOptions, type UsageView,
  type MergeView, type NextStep, type Overview, type PostView, type PrView, type ReviewDraft, type ServerStatus,
} from "../../src/contract";
import { addDays, dayOf } from "../../src/period";
import { reloadPrefs } from "../../src/ui/prefs";
import { prStates } from "../../src/ui/pr-state";

export type Handlers = PluginRpcTestHandlers<typeof rpcContract>;
/** GitHub PR Status's read, answered from the same map: the harness routes every plugin's RPC to it. */
export type PullRequests = (input: { keys: string[] }) => Record<string, unknown>;

export const NOW = Date.now();
export const HOUR = 60 * 60_000;
export const DAY = 24 * HOUR;

// Fixtures are stamped when their file loads, and a busy machine can take a minute to reach a test, so "just now" would
// read "1m ago": each test starts the clock at NOW again, and it runs on from there.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

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

export function post(overrides: Partial<PostView> = {}): PostView {
  return {
    id: 3, key: "lab:acme/app#2311622", display: "acme/app#2311622", serverName: "Lab", verdict: "changes", comments: 2, draftId: null,
    state: "queued", error: null, placed: null, inBody: null, at: NOW - 30_000, startedAt: null, finishedAt: null, ...overrides,
  };
}

/** A merge of one of your PRs in Shuttle's queue; `own` in pr-view tests is its PR. */
export function mergeRun(overrides: Partial<MergeView> = {}): MergeView {
  return {
    id: 5, key: "github:acme/infra-portal#29278", display: "acme/infra-portal#29278", serverName: "GitHub", method: "squash", auto: false, deleteBranch: true,
    head: "4be81d0aa", state: "queued", outcome: null, error: null, at: NOW - 30_000, startedAt: null, finishedAt: null, ...overrides,
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
    post: null,
    merge: null,
    next: next(),
    snoozed: false,
    snoozedUntil: null,
    dismissed: null,
    keptOutBy: null,
    unseen: false,
    handled: false,
    autoMerge: false,
    inMergeQueue: false,
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
export const mine = (overrides: Partial<PrView> = {}) => pr({ mine: true, author: "robin-c", reasons: [{ reason: "authored", teams: [] }], requestedAt: null, ...overrides });

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
    notes: null,
    assessment: null,
    gate: null,
    autoPost: null,
    ...overrides,
  };
}

export function item(overrides: Partial<ConversationItem> = {}): ConversationItem {
  return {
    id: "c1", kind: "thread", author: "alice-w", bot: false, mine: false, state: null, body: "The retry should back off.", path: "app/jobs/waf.rb", line: 42,
    url: "https://github.com/get-bb/bb/pull/4411#discussion_r1", at: NOW - 40 * 60_000, thread: "PRRT_1", resolved: false, delivery: null, outcome: null, hunk: null, review: null, ...overrides,
  };
}

export function server(overrides: Partial<ServerStatus> = {}): ServerStatus {
  return {
    id: "github", name: "GitHub", kind: "github", enabled: true, ok: true, login: "robin-c", error: null,
    lastOkAt: NOW - 60_000, lastSyncAt: NOW - 60_000, durationMs: 1100,
    operations: ["whoami", "authored", "review_requested", "team_requested", "mentioned", "view", "activity"],
    state: "ok", failures: 0, failingSince: null, failure: null, failedSteps: [], stepOkAt: {}, alert: false, nextSyncAt: NOW + 120_000, lastFailedAt: null,
    ...overrides,
  };
}

export function overview(overrides: Partial<Overview> = {}): Overview {
  return {
    servers: [server(), server({ id: "lab", name: "Lab", kind: "command", login: "robin.c" })],
    counts: { inbox: 2, mine: 3, done: 1, reviews: 12, reviewed: 4 },
    syncedAt: NOW - 60_000,
    syncing: false,
    paused: false,
    pauseUntil: null,
    autoAgent: false,
    ...overrides,
  };
}

export function inbox(overrides: Partial<InboxView> = {}): InboxView {
  return { prs: [], snoozed: [], dismissed: [], reviewing: [], posting: [], merging: [], rules: [], olderRequests: 0, handled: 0, ...overrides };
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

/** No review used anything yet, and Burn answered. */
export function usage(overrides: Partial<UsageView> = {}): UsageView {
  return {
    range: "7d", today: dayOf(NOW), end: dayOf(NOW), latest: true, firstDay: addDays(dayOf(NOW), -60), from: NOW - 6 * DAY, to: NOW,
    source: { state: "ok", message: null, at: NOW, unread: 0 },
    totals: { tokens: 0, cost: 0, calls: 0, reviews: 0, mix: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, estimated: false },
    previous: { tokens: 0, cost: 0, reviews: 0 },
    perReview: { medianTokens: null, medianCost: null, p90Cost: null },
    critics: { tokens: 0, cost: 0, threads: 0 },
    bucket: "day", series: [], presets: [], models: [], triggers: [], repos: [], outcomes: [], reviews: [], unmeasured: 0,
    ...overrides,
  };
}

export function autoPostInsights(overrides: Partial<AutoPostInsights> = {}): AutoPostInsights {
  return { range: "30d", target: 0.9, approvalTarget: 0.98, repos: [], scheduled: [], reasons: [], points: [], verifier: { runs: 0, failures: 0, medianMs: null }, recent: [], ...overrides };
}

const RECORD = { agreed: 0, against: 0, pending: 0, missed: 0, held: 0, precision: null, lowerBound: null, needed: null };
type ShadowRepo = AutoPostInsights["repos"][number];
export function shadowRepo(overrides: {
  repo?: string; mode?: ShadowRepo["mode"]; approveMode?: ShadowRepo["approveMode"]; drafts?: number;
  findings?: Partial<ShadowRepo["findings"]>; policy?: Partial<ShadowRepo["policy"]>; approvals?: Partial<ShadowRepo["approvals"]>;
  posted?: Partial<ShadowRepo["posted"]>; trips?: ShadowRepo["trips"];
} = {}): ShadowRepo {
  return {
    repo: overrides.repo ?? "acme/app", mode: overrides.mode ?? "shadow", approveMode: overrides.approveMode ?? "shadow", drafts: overrides.drafts ?? 0,
    findings: { ...RECORD, edited: 0, judged: 0, ...overrides.findings },
    policy: { drafts: 0, findings: 0, agreed: 0, against: 0, ...overrides.policy },
    approvals: { ...RECORD, drafts: 0, wouldApprove: 0, ...overrides.approvals },
    posted: { reviews: 0, approvals: 0, findings: 0, marked: 0, mistakes: 0, ...overrides.posted },
    trips: overrides.trips ?? [],
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
    conversation: () => ({ items: [], details: null, error: null, fetchedAt: NOW }),
    resolveReferences: () => ({ rows: [] }),
    reference: unexpected("reference"),
    referenceLog: () => ({ rows: [], counts: {}, total: 0, filteredTotal: 0, events: [] }),
    referenceFeedback: unexpected("referenceFeedback"),
    linkCard: unexpected("linkCard"),
    linkStates: ({ urls }) => ({ links: urls.map((url) => ({ url, kind: null, state: null })) }),
    lookup: unexpected("lookup"),
    search: () => ({ prs: [], total: 0 }),
    descriptionMatches: () => ({ keys: [] }),
    activity: () => ({ events: [] }),
    insights: () => insights(),
    usage: ({ range, end }) => usage({ range, ...(end !== undefined && end < dayOf(NOW) ? { end, latest: false } : {}) }),
    autoPostInsights: () => autoPostInsights(),
    sync: () => ({ ok: true }),
    syncHistory: () => ({ windowMs: 3 * 3_600_000, servers: [] }),
    link: unexpected("link"),
    unlink: unexpected("unlink"),
    watch: unexpected("watch"),
    setAgent: unexpected("setAgent"),
    setAgentMode: unexpected("setAgentMode"),
    askAgent: unexpected("askAgent"),
    setSettings: unexpected("setSettings"),
    setAutomationPause: unexpected("setAutomationPause"),
    track: unexpected("track"),
    snooze: unexpected("snooze"),
    dismiss: unexpected("dismiss"),
    markSeen: () => ({ ok: true }),
    inboxRuleAdd: unexpected("inboxRuleAdd"),
    inboxRuleRemove: unexpected("inboxRuleRemove"),
    handle: unexpected("handle"),
    review: unexpected("review"),
    newThread: unexpected("newThread"),
    threadPrs: () => ({ prs: [], sent: [] }),
    sendUnread: () => ({ sent: 0 }),
    threads: () => ({ threads: [] }),
    projects: () => ({ projects: [{ id: "prj_bb", name: "bb" }], suggested: "prj_bb" }),
    refreshProjects: () => ({ count: 1, fetchedAt: NOW }),
    getConfig: () => ({ config: config() }),
    saveConfig: ({ config: next }) => ({ config: next as Config }),
    testServer: () => ({ results: [] }),
    exportToml: () => ({ toml: "" }),
    importToml: () => ({ changes: [], config: null }),
    skills: () => ({ skills: [{ id: "pr-reviewer", name: "pr-reviewer", description: "Multi-model critic consensus reviews" }] }),
    workspaceProviders: () => ({
      environments: [
        { id: "git-worktree", displayName: "Worktree", description: null, machineProviderId: null },
        { id: "my-trees", displayName: "My trees", description: "A tree in the repository's own place", machineProviderId: null },
        { id: "sandbox-checkout", displayName: "Sandbox checkout", description: "A checkout on a sandbox machine", machineProviderId: null },
        { id: "sandbox-full", displayName: "Sandbox with checkout", description: "A new sandbox and its checkout", machineProviderId: "sandbox" },
      ],
      machines: [{ id: "sandbox", displayName: "Sandbox", description: "A sandbox machine" }],
    }),
    editPr: unexpected("editPr"),
    editOptions: () => ({ labels: [], people: [], teams: [] }),
    mergeOptions: () => mergeOptions(),
    queueMerge: unexpected("queueMerge"),
    merges: () => ({ merges: [] }),
    cancelMerge: unexpected("cancelMerge"),
    retryMerge: unexpected("retryMerge"),
    clearMerge: unexpected("clearMerge"),
    cancelAutoMerge: unexpected("cancelAutoMerge"),
    comment: unexpected("comment"),
    queueReview: unexpected("queueReview"),
    posts: () => ({ posts: [] }),
    cancelPost: unexpected("cancelPost"),
    retryPost: unexpected("retryPost"),
    clearPost: unexpected("clearPost"),
    discardDraft: unexpected("discardDraft"),
    checkDraft: unexpected("checkDraft"),
    stopAutoPost: unexpected("stopAutoPost"),
    autoPostNow: unexpected("autoPostNow"),
    markAutoPost: unexpected("markAutoPost"),
    resumeAutoPost: unexpected("resumeAutoPost"),
    reviewHistory: () => ({ items: [] }),
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

export function mount<Props extends object>(component: ComponentType<Props>, props: Props, rpc: Handlers & { pullRequests?: PullRequests }, options: Omit<RenderSlotOptions<typeof rpcContract>, "rpc"> & { invalidateWrites?: boolean } = {}): RenderedSlot {
  const tags = mutationTags as Record<string, (input: { apply?: boolean }) => readonly string[]>;
  const serverRpc = Object.fromEntries(Object.entries(rpc).map(([method, handler]) => [method, !tags[method] ? handler : async (input: unknown) => {
    const result = await (handler as (input: unknown) => unknown)(input);
    setTimeout(() => {
      if (options.invalidateWrites !== false && mounted.includes(slot)) void slot.behavior.experimental_invalidateRpc(tags[method]!(input as { apply?: boolean }));
    }, 0);
    return result;
  }])) as unknown as typeof rpc;
  const slot = renderSlot<Props, typeof rpcContract>({ component }, props, {
    pluginId: "shuttle",
    openUrl: () => true,
    experimental_rpcContract: rpcContract,
    ...options,
    rpc: serverRpc,
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
export async function page(subPath: string, rpc: Partial<Handlers> = {}, options: Omit<RenderSlotOptions<typeof rpcContract>, "rpc"> & { invalidateWrites?: boolean } = {}) {
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
