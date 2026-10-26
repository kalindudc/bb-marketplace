import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor, within } from "@testing-library/react";
import type { PluginSettingsSectionProps } from "@get-bb/plugin-sdk/app";
import type { ServerStatus, SyncHistory, SyncStep } from "../../src/contract";
import { clock } from "../../src/ui/format";
import { app, callsTo, config, find, handlers, HOUR, inbox, lastNavigation, mount, next, NOW, overview, page, pr, server, unmountAll } from "./helpers";

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), toasts) }));

afterEach(() => {
  unmountAll();
  toasts.error.mockReset();
  toasts.success.mockReset();
});

const RESTARTING = "Error: 503: walgit: the host serving this repository is restarting; retry in a few seconds";
const LAST_GOOD = NOW - 14 * 60_000;
const SINCE = NOW - 7 * 60_000;
const NEXT = NOW + 50_000;

const failure = (overrides: Partial<NonNullable<ServerStatus["failure"]>> = {}): NonNullable<ServerStatus["failure"]> => ({
  operation: "whoami", kind: "unavailable", summary: "Delta was restarting (HTTP 503)", message: `whoami exited 1: ${RESTARTING}`,
  output: RESTARTING, exit: 1, command: "sh delta.sh", fix: null, ...overrides,
});

const ALL_STEPS = ["whoami", "authored", "review_requested", "team_requested", "refresh"] as const;

const failingDelta = (overrides: Partial<ServerStatus> = {}) => server({
  id: "delta", name: "Delta", kind: "command", ok: false, state: "failed", error: "whoami: Delta was restarting (HTTP 503)",
  lastOkAt: LAST_GOOD, lastSyncAt: SINCE + 3 * 60_000, failures: 2, failingSince: SINCE, failure: failure(), failedSteps: [...ALL_STEPS],
  stepOkAt: { whoami: LAST_GOOD, authored: LAST_GOOD, review_requested: LAST_GOOD, team_requested: LAST_GOOD, refresh: LAST_GOOD },
  alert: true, nextSyncAt: NEXT, lastFailedAt: SINCE + 3 * 60_000, ...overrides,
});

const partialGithub = (overrides: Partial<ServerStatus> = {}) => server({
  ok: false, state: "partial", failures: 2, failingSince: SINCE, alert: true, nextSyncAt: NEXT, failedSteps: ["team_requested"], stepOkAt: { team_requested: LAST_GOOD },
  failure: failure({ operation: "team_requested", summary: "GitHub had a server error (HTTP 502)", output: "gh: HTTP 502", command: "gh api graphql" }), ...overrides,
});

const banner = (root: ParentNode, id: string) => find(root, `[data-sync-alert='${id}']`);

describe("the sync banner", () => {
  it("says why a server keeps failing, what its PRs show, and what happens next", async () => {
    const { slot } = await page("inbox", { overview: () => overview({ servers: [server(), failingDelta()] }) });
    const alert = await banner(slot.container, "delta");
    expect(alert.textContent).toContain(`Delta has not synced since ${clock(SINCE)}`);
    expect(alert.textContent).toContain("Delta was restarting (HTTP 503) when Shuttle asked for who you are.");
    expect(alert.textContent).toContain(`Delta's PRs show what Shuttle had at ${clock(LAST_GOOD)}.`);
    expect(alert.textContent).toContain(`This usually passes by itself. Shuttle tries again around ${clock(NEXT)}.`);
    expect(alert.className).toContain("border-destructive");
    fireEvent.click(within(alert).getByRole("button", { name: "Sync Delta now" }));
    await waitFor(() => expect(callsTo(slot, "sync")).toEqual([{ server: "delta" }]));
    fireEvent.click(within(alert).getByRole("button", { name: "See why" }));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "insights/sync" } });
  });

  it("waits for a second failed sync, and leaves the Sync tab to say it", async () => {
    const once = await page("inbox", { overview: () => overview({ servers: [failingDelta({ failures: 1, alert: false })] }) });
    await waitFor(() => expect(callsTo(once.slot, "overview").length).toBeGreaterThan(0));
    await find(once.slot.container, "[data-scroller]");
    expect(once.slot.container.querySelector("[data-sync-alert]")).toBeNull();
    unmountAll();
    const tab = await page("insights/sync", { overview: () => overview({ servers: [failingDelta()] }) });
    await find(tab.slot.container, "[data-sync-server='delta']");
    expect(tab.slot.container.querySelector("[data-sync-alert]")).toBeNull();
  });

  it("asks for a sign-in at once, with the fix the command named", async () => {
    const signedOut = failingDelta({ failures: 1, failure: failure({ kind: "auth", summary: "Delta did not accept your sign-in (HTTP 401)", fix: "dt auth login" }) });
    const { slot } = await page("mine", { overview: () => overview({ servers: [signedOut] }) });
    const alert = await banner(slot.container, "delta");
    expect(alert.textContent).toContain("Delta needs you to sign in again");
    expect(alert.textContent).toContain("Run dt auth login, then sync again.");
    expect(within(alert).getByRole("button", { name: "Copy dt auth login" })).toBeTruthy();
  });

  it("is a warning when only some lists failed, and names them", async () => {
    const { slot } = await page("reviews", { overview: () => overview({ servers: [partialGithub()] }) });
    const alert = await banner(slot.container, "github");
    expect(alert.className).toContain("border-warning");
    expect(alert.textContent).toContain("GitHub synced, except team requests");
    expect(alert.textContent).toContain(`Its team requests show what Shuttle had at ${clock(LAST_GOOD)}.`);
  });

  it("dates a list that has not passed since the upgrade by the last good sync", async () => {
    const older = NOW - 40 * 60_000;
    const { slot } = await page("reviews", { overview: () => overview({ servers: [partialGithub({ lastOkAt: older, stepOkAt: { authored: LAST_GOOD }, failedSteps: ["whoami", "team_requested"] })] }) });
    expect((await banner(slot.container, "github")).textContent).toContain(`show what Shuttle had at ${clock(older)}.`);
  });
});

const step = (operation: SyncStep["operation"], status: SyncStep["status"], extra: Partial<SyncStep> = {}): SyncStep => ({ operation, status, ms: status === "skipped" ? 0 : 1200, attempts: 1, detail: null, failure: null, ...extra });

const history = (): SyncHistory => ({
  windowMs: 3 * HOUR,
  servers: [
    { id: "github", runs: [{ at: NOW - 40 * 60_000, state: "ok", durationMs: 76_000 }], lastFailure: null, failures: [], averageMs: 76_000 },
    {
      id: "delta",
      runs: [{ at: LAST_GOOD, state: "ok", durationMs: 6100 }, { at: SINCE, state: "failed", durationMs: 8400 }, { at: SINCE + 3 * 60_000, state: "failed", durationMs: 8400 }],
      lastFailure: {
        id: 9, at: SINCE + 3 * 60_000, durationMs: 8400, state: "failed",
        steps: [
          step("whoami", "failed", { attempts: 2, ms: 8400, failure: { ...failure(), operation: undefined } as unknown as SyncStep["failure"] }),
          step("authored", "skipped", { detail: "Not run: Shuttle could not tell who you are" }),
        ],
      },
      failures: [
        { at: SINCE + 3 * 60_000, state: "failed", operation: "whoami", summary: "Delta was restarting (HTTP 503)", output: RESTARTING },
        { at: SINCE, state: "failed", operation: "whoami", summary: "Delta was restarting (HTTP 503)", output: RESTARTING },
        { at: NOW - 20 * HOUR, state: "failed", operation: "authored", summary: "Delta cut its answer short", output: null },
        { at: NOW - 30 * HOUR, state: "partial", operation: "team_requested", summary: "Delta took too long to answer", output: null },
        { at: NOW - 50 * HOUR, state: "failed", operation: "authored", summary: "Shuttle could not reach Delta", output: "dns error" },
      ],
      averageMs: 6100,
    },
  ],
});

describe("Insights › Sync", () => {
  it("puts the failing server first, with its syncs, the failed one step by step, and what the command printed", async () => {
    const { slot } = await page("insights/sync", { overview: () => overview({ servers: [server(), failingDelta()] }), syncHistory: history });
    const card = await find(slot.container, "[data-sync-server='delta']");
    expect([...slot.container.querySelectorAll("[data-sync-server]")].map((node) => node.getAttribute("data-sync-server"))).toEqual(["delta", "github"]);
    expect(card.textContent).toContain(`Failing since ${clock(SINCE)}`);
    expect(card.textContent).toContain("about 6.1s a sync");
    expect([...card.querySelectorAll("[data-mark]")].map((node) => node.getAttribute("data-mark"))).toEqual(["ok", "failed", "failed"]);
    expect(card.textContent).toContain(`Why the ${clock(SINCE + 3 * 60_000)} sync failed`);
    expect([...card.querySelectorAll("[data-step]")].map((node) => [node.getAttribute("data-step"), node.getAttribute("data-status")])).toEqual([["whoami", "failed"], ["authored", "skipped"]]);
    expect(card.querySelector("[data-step='whoami']")!.textContent).toContain("tried 2 times");
    const printed = card.querySelector<HTMLElement>("[data-printed]")!;
    expect(printed.textContent).toContain(RESTARTING);
    expect(printed.textContent).toContain("exit 1");
    expect(printed.textContent).toContain("sh delta.sh");
    expect(card.textContent).toContain(`Last good sync ${clock(LAST_GOOD)}`);
    expect(card.textContent).toContain("2 syncs in a row");
    // The failure shown in full is left out of Earlier failures, which folds after three.
    const earlier = within(card).getByRole("list", { name: "Earlier failures" });
    expect(earlier.querySelectorAll("li")).toHaveLength(3);
    fireEvent.click(within(card).getByRole("button", { name: "Show 1 more" }));
    expect(earlier.querySelectorAll("li")).toHaveLength(4);
    fireEvent.click(within(card).getByRole("button", { name: "Sync Delta now" }));
    await waitFor(() => expect(callsTo(slot, "sync")).toEqual([{ server: "delta" }]));
  });

  it("keeps a recovered server's last failed sync, step by step, folded above its earlier failures", async () => {
    const { slot } = await page("insights/sync", { overview: () => overview({ servers: [failingDelta({ state: "ok", ok: true, failure: null, failedSteps: [], alert: false })] }), syncHistory: history });
    const card = await find(slot.container, "[data-sync-server='delta']");
    const last = card.querySelector<HTMLElement>("[data-last-failure]")!;
    expect(last.tagName).toBe("DETAILS");
    expect(last.querySelector("summary")!.textContent).toBe(`The last failed sync, ${clock(SINCE + 3 * 60_000)}: Delta was restarting (HTTP 503)`);
    expect(last.textContent).toContain("Delta has synced since.");
    expect(last.querySelector("[data-printed]")!.textContent).toContain(RESTARTING);
    expect(card.textContent).not.toContain("Next try around");
    expect(card.textContent).toContain("Earlier failures");
    expect(within(card).getByRole("list", { name: "Earlier failures" }).querySelectorAll("li")).toHaveLength(3);
  });
});

describe("old data", () => {
  it("marks an Inbox card whose lists failed with the time of its data", async () => {
    const stale = pr({ stale: true, staleSince: LAST_GOOD, serverName: "Delta", next: next({ kind: "new_request", label: "New review request", inbox: true }) });
    const { slot } = await page("inbox", { inbox: () => inbox({ prs: [stale] }) });
    const card = await find(slot.container, `[data-card='${stale.key}']`);
    expect(card.textContent).toContain(`Data from ${clock(LAST_GOOD)}`);
  });
});

describe("Settings › Servers", () => {
  it("shows why a server failed under its card, with a way to its sync history", async () => {
    const loaded = await app();
    const registration = loaded.settingsSections.find((item) => item.id === "servers")!;
    const slot = mount<PluginSettingsSectionProps>(registration.component, {}, handlers({
      overview: () => overview({ servers: [server(), failingDelta()] }),
      getConfig: () => ({ config: config({ servers: [...config().servers, { id: "delta", name: "Delta", kind: "command" as const, enabled: true, sep: "#" as const, pattern: "^https://d/(?<repo>[^/]+/[^/]+)/pull/(?<number>\\d+)", link: "https://d/{repo}/pull/{number}", commands: { whoami: "sh delta.sh", view: "sh delta.sh" } }] }) }),
    }));
    const note = await find(slot.container, "[data-sync-failure]");
    expect(note.textContent).toContain("Delta was restarting (HTTP 503) when Shuttle asked for who you are");
    expect(note.textContent).toContain(RESTARTING);
    fireEvent.click(within(note).getByRole("button", { name: "See sync history" }));
    expect(lastNavigation(slot)).toEqual({ method: "toPluginPanel", path: "shuttle", options: { subPath: "insights/sync" } });
  });
});
