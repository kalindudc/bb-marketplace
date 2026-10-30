// Why a server's sync failed: a banner while it keeps failing, and Insights › Sync with each server's
// recent syncs, the failed one step by step, what its command printed, and the week's failures.
import { useState } from "react";
import { toast } from "sonner";
import { experimental_copyToClipboard, experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { ServerStatus, SyncHistory, SyncRun, SyncState, SyncStep } from "../contract";
import { failureAdvice, primaryStep, STEP_LABELS } from "../failures";
import { BUTTON, BUTTON_GHOST, BUTTON_GHOST_SMALL, BUTTON_PRIMARY, CARD, ErrorNote, HEADING, Pill, ServerBadge, TONE_PANEL, TONE_TEXT, type Tone } from "./common";
import { messageOf, useShuttleMutation, useShuttleQuery } from "./data";
import { ago, clock, plural, seconds } from "./format";

type Failing = ServerStatus & { failure: NonNullable<ServerStatus["failure"]> };

const isFailing = (server: ServerStatus): server is Failing => server.enabled && server.state !== null && server.state !== "ok" && server.failure !== null;
const toneOf = (state: SyncState | null): "ok" | "warn" | "bad" | "neutral" => (state === "ok" ? "ok" : state === "partial" ? "warn" : state === "failed" ? "bad" : "neutral");
const listOf = (items: readonly string[]) => new Intl.ListFormat("en", { type: "conjunction" }).format(items);
const failedLabels = (server: ServerStatus) => listOf(server.failedSteps.map((step) => STEP_LABELS[step]));

/** "Delta's PRs show what Shuttle had at 11:28": the oldest data the failed steps left behind. */
function staleText(server: ServerStatus): string {
  // Who you are brings no PRs. A step that has not passed since Shuttle began keeping steps is as old as the last good sync.
  const times = server.failedSteps.filter((step) => step !== "whoami").map((step) => server.stepOkAt[step] ?? server.lastOkAt).filter((at): at is number => at !== null);
  const since = times.length > 0 ? Math.min(...times) : server.lastOkAt;
  const whose = server.state === "partial" ? `Its ${failedLabels(server)}` : `${server.name}'s PRs`;
  return since === null ? `${whose} show nothing yet.` : `${whose} show what Shuttle had at ${clock(since)}.`;
}

const nextText = (server: ServerStatus) => (server.nextSyncAt === null ? null : clock(Math.max(server.nextSyncAt, Date.now())));

function useCopy() {
  return async (text: string, what: string) => {
    if (await experimental_copyToClipboard({ text })) toast.success(`Copied ${what}`);
    else toast.error("Could not copy to the clipboard");
  };
}

function SyncNowButton({ server, primary = false }: { server: Pick<ServerStatus, "id" | "name">; primary?: boolean }) {
  const sync = useShuttleMutation("sync");
  const now = async () => {
    if (await sync.run({ server: server.id })) toast.success(`Syncing ${server.name}`);
  };
  return (
    <button type="button" className={primary ? BUTTON_PRIMARY : BUTTON} disabled={sync.isPending} onClick={() => void now()}>
      <Icon name="ArrowReloadHorizontal" className={`size-3.5 ${sync.isPending ? "animate-spin" : ""}`} aria-hidden />Sync {server.name} now
    </button>
  );
}

function FixButton({ fix }: { fix: string }) {
  const copy = useCopy();
  return (
    <button type="button" className={BUTTON_PRIMARY} onClick={() => void copy(fix, fix)}>
      <Icon name="Copy" className="size-3.5" aria-hidden />Copy {fix}
    </button>
  );
}

function bannerTitle(server: Failing): string {
  if (server.failure.kind === "auth") return `${server.name} needs you to sign in again`;
  if (server.state === "partial") return `${server.name} synced, except ${failedLabels(server)}`;
  return server.failingSince === null ? `${server.name} did not sync` : `${server.name} has not synced since ${clock(server.failingSince)}`;
}

/** Shown on every page while a server keeps failing: two syncs in a row, or a sign-in that waits for the user. */
export function SyncBanner({ servers, onSeeWhy }: { servers: readonly ServerStatus[]; onSeeWhy(): void }) {
  const alerts = servers.filter(isFailing).filter((server) => server.alert);
  if (alerts.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 px-4 pt-3 sm:px-5">
      {alerts.map((server) => {
        const tone = server.failure.kind === "auth" ? "bad" : toneOf(server.state);
        return (
          <div key={server.id} role="status" data-sync-alert={server.id} className={`rounded-md border border-l-[3px] px-3 py-2 text-xs ${TONE_PANEL[tone]}`}>
            <div className={`flex items-center gap-1.5 font-semibold ${TONE_TEXT[tone]}`}>
              <Icon name="AlertTriangle" className="size-3.5 shrink-0" aria-hidden />{bannerTitle(server)}
            </div>
            <p className="mb-2 mt-0.5 text-foreground">
              {server.failure.summary} when Shuttle asked for {STEP_LABELS[server.failure.operation]}. {staleText(server)} {failureAdvice(server.failure, nextText(server))}
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              {server.failure.fix !== null && <FixButton fix={server.failure.fix} />}
              <SyncNowButton server={server} />
              <button type="button" className={BUTTON_GHOST} onClick={onSeeWhy}>See why</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The one line the sidebar shows under a server that is failing, or that failed in the last hour. */
export function sidebarReason(server: ServerStatus, now = Date.now()): { text: string; tone: "warn" | "bad" | "neutral" } | null {
  if (isFailing(server)) return { text: server.failure.summary, tone: server.state === "partial" ? "warn" : "bad" };
  // A server that failed before Shuttle kept each step has only its stored error.
  if (server.enabled && (server.state === "failed" || server.state === "partial")) return { text: server.error ?? "The last sync failed", tone: server.state === "partial" ? "warn" : "bad" };
  if (server.lastFailedAt !== null && now - server.lastFailedAt < 3_600_000) return { text: `Last failed ${ago(server.lastFailedAt, now)}`, tone: "neutral" };
  return null;
}

export function SyncStatusPill({ server }: { server: ServerStatus }) {
  if (server.state === null) return <Pill>Not synced yet</Pill>;
  if (server.state === "ok") return <Pill tone="ok" icon="Check">{server.lastSyncAt === null ? "Synced" : `Synced ${ago(server.lastSyncAt)}`}</Pill>;
  if (server.state === "partial") return <Pill tone="warn" icon="AlertTriangle">Synced, except {failedLabels(server)}</Pill>;
  return <Pill tone="bad" icon="AlertTriangle">{server.failingSince === null ? "Failing" : `Failing since ${clock(server.failingSince)}`}</Pill>;
}

/** Settings' note under a failing server: what failed, what it printed, and a way to the history. */
export function SyncFailureNote({ server, onHistory }: { server: ServerStatus; onHistory(): void }) {
  if (!isFailing(server)) return null;
  const tone: Tone = server.state === "partial" ? "warn" : "bad";
  return (
    <div data-sync-failure className={`mt-2.5 rounded-md border px-3 py-2 text-xs ${TONE_PANEL[tone]}`}>
      <div className={`flex items-center gap-1.5 font-semibold ${TONE_TEXT[tone]}`}>
        <Icon name="AlertTriangle" className="size-3.5 shrink-0" aria-hidden />
        {server.failure.summary} when Shuttle asked for {STEP_LABELS[server.failure.operation]}
        {server.lastSyncAt !== null && <span className="font-normal text-muted-foreground">· {clock(server.lastSyncAt)}</span>}
      </div>
      <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-foreground">{server.failure.output ?? server.failure.message}</pre>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {server.failure.fix !== null && <FixButton fix={server.failure.fix} />}
        <button type="button" className={BUTTON_GHOST} onClick={onHistory}>See sync history</button>
      </div>
    </div>
  );
}

const MARK: Record<SyncState, string> = { ok: "h-2.5 bg-success/60", partial: "h-4 bg-warning", failed: "h-4 bg-destructive" };
const STATE_WORD: Record<SyncState, string> = { ok: "synced", partial: "partly synced", failed: "failed" };

function Marks({ runs, windowMs }: { runs: SyncHistory["servers"][number]["runs"]; windowMs: number }) {
  const now = Date.now();
  if (runs.length === 0) return <div className="text-xs text-muted-foreground">No syncs in the last {Math.round(windowMs / 3_600_000)} hours.</div>;
  return (
    <div>
      <div role="img" aria-label={`${plural(runs.length, "sync")}, ${runs.filter((run) => run.state !== "ok").length} of them not in full`} className="flex h-4 items-end gap-0.5">
        {runs.map((run, index) => (
          <span key={`${run.at}-${index}`} data-mark={run.state} title={`${clock(run.at)} · ${STATE_WORD[run.state]} in ${seconds(run.durationMs)}`} className={`min-w-[3px] max-w-3 flex-1 rounded-sm ${MARK[run.state]}`} />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10.5px] text-muted-foreground">
        <span>{clock(runs[0]!.at)}</span>
        <span>{ago(runs.at(-1)!.at, now)}</span>
      </div>
    </div>
  );
}

const STEP_ICON: Record<SyncStep["status"], { icon: string; tone: string }> = {
  ok: { icon: "Check", tone: "text-success" },
  failed: { icon: "X", tone: "text-destructive-text" },
  skipped: { icon: "Minus", tone: "text-muted-foreground" },
};

function Steps({ steps }: { steps: readonly SyncStep[] }) {
  return (
    <ul aria-label="Steps" className="flex flex-col">
      {steps.map((step) => (
        <li key={step.operation} data-step={step.operation} data-status={step.status} className="flex items-start gap-2 border-t border-border py-1.5 text-xs first:border-t-0">
          <Icon name={STEP_ICON[step.status].icon} fallback="Circle" className={`mt-0.5 size-3.5 shrink-0 ${STEP_ICON[step.status].tone}`} aria-hidden />
          <span className="w-36 shrink-0">
            <span className="block">{STEP_LABELS[step.operation]}</span>
            <span className="block font-mono text-[10.5px] text-muted-foreground">{step.operation}</span>
          </span>
          <span className={`min-w-0 flex-1 break-words ${step.status === "failed" ? "text-destructive-text" : "text-muted-foreground"}`}>
            {step.failure ? `${step.failure.summary}${step.detail ? `: ${step.detail}` : ""}` : step.detail}
            {step.attempts > 1 && <span className="text-muted-foreground"> · tried {step.attempts} times</span>}
          </span>
          {step.status !== "skipped" && <span className="shrink-0 text-muted-foreground">{seconds(step.ms)}</span>}
        </li>
      ))}
    </ul>
  );
}

function Printed({ run }: { run: SyncRun }) {
  const copy = useCopy();
  const failure = primaryStep(run.steps)?.failure;
  if (!failure) return null;
  const text = failure.output ?? failure.message;
  return (
    <div data-printed className="mt-2 overflow-hidden rounded-md border border-border bg-background">
      <div className="flex items-center gap-2 border-b border-border px-2.5 py-1 text-[11px] text-muted-foreground">
        <span className="flex-1">{failure.output === null ? "What Shuttle saw" : "What the command printed"}</span>
        {failure.exit !== null && <span className="font-mono">exit {failure.exit}</span>}
        <button type="button" className={BUTTON_GHOST_SMALL} onClick={() => void copy([text, failure.command].filter(Boolean).join("\n\n"), "the error")}>
          <Icon name="Copy" className="size-3" aria-hidden />Copy
        </button>
      </div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[11px] text-foreground">{text}</pre>
      {failure.command !== null && <div className="truncate border-t border-border px-2.5 py-1 font-mono text-[10.5px] text-muted-foreground" title={failure.command}>{failure.command}</div>}
    </div>
  );
}

function Failures({ failures }: { failures: SyncHistory["servers"][number]["failures"] }) {
  const [all, setAll] = useState(false);
  if (failures.length === 0) return <div className="text-xs text-muted-foreground">No failed syncs this week.</div>;
  const shown = all ? failures : failures.slice(0, 3);
  return (
    <>
      <ul aria-label="Earlier failures" className="flex flex-col">
        {shown.map((failure, index) => (
          <li key={`${failure.at}-${index}`} className="border-t border-border py-1.5 text-xs first:border-t-0">
            <details>
              <summary className="flex cursor-pointer list-none items-baseline gap-2">
                <span className="w-28 shrink-0 text-muted-foreground">{clock(failure.at)}</span>
                <span className="w-32 shrink-0 font-mono text-[10.5px] text-muted-foreground">{failure.operation}</span>
                <span className={`min-w-0 flex-1 ${failure.state === "partial" ? "text-warning-text" : "text-destructive-text"}`}>{failure.summary}</span>
              </summary>
              {failure.output !== null && <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-background px-2 py-1.5 font-mono text-[11px]">{failure.output}</pre>}
            </details>
          </li>
        ))}
      </ul>
      {failures.length > 3 && (
        <button type="button" className={`${BUTTON_GHOST} mt-1`} onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show ${failures.length - 3} more`}</button>
      )}
    </>
  );
}

function ServerSync({ server, history, windowMs }: { server: ServerStatus; history: SyncHistory["servers"][number] | undefined; windowMs: number }) {
  const failing = isFailing(server);
  const run = history?.lastFailure ?? null;
  const earlier = (history?.failures ?? []).filter((failure) => failure.at !== run?.at);
  const recovered = run === null ? null : primaryStep(run.steps)?.failure ?? null;
  const average = history?.averageMs ?? server.durationMs;
  return (
    <section data-sync-server={server.id} className={`${CARD} mb-2.5`}>
      <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-3.5 py-2.5">
        <ServerBadge name={server.name} large />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{server.name}</div>
          <div className="text-xs text-muted-foreground">
            {server.kind === "github" ? "Built-in GitHub adapter (gh)" : "Command adapter"}{average !== null && ` · about ${seconds(average)} a sync`}
          </div>
        </div>
        <SyncStatusPill server={server} />
        <SyncNowButton server={server} />
      </div>
      <div className="px-3.5 py-3">
        <h4 className={`${HEADING} mb-1.5`}>Last {Math.round(windowMs / 3_600_000)} hours, one mark a sync</h4>
        <Marks runs={history?.runs ?? []} windowMs={windowMs} />
        {failing && run !== null && (
          <>
            <h4 className={`${HEADING} mb-1.5 mt-4`}>Why the {clock(run.at)} sync {run.state === "partial" ? "was partial" : "failed"}</h4>
            <p className={`mb-2 border-l-2 pl-2.5 text-xs ${server.state === "partial" ? "border-warning" : "border-destructive"}`}>
              <span className={`font-semibold ${TONE_TEXT[toneOf(server.state)]}`}>{server.failure.summary}.</span> {failureAdvice(server.failure, nextText(server))}
            </p>
            <Steps steps={run.steps} />
            <Printed run={run} />
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-muted-foreground">
              <span>Last good sync <b className="font-medium text-foreground">{server.lastOkAt === null ? "never" : clock(server.lastOkAt)}</b></span>
              {server.nextSyncAt !== null && <span>Next try around <b className="font-medium text-foreground">{nextText(server)}</b></span>}
              <span>Took {seconds(run.durationMs)}</span>
              {server.failures > 1 && <span>{server.failures} syncs in a row</span>}
            </div>
          </>
        )}
        {!failing && run !== null && (
          <details data-last-failure className="mt-4">
            <summary className={`${HEADING} cursor-pointer`}>
              The last failed sync, {clock(run.at)}{recovered && <span className="font-normal normal-case tracking-normal">: {recovered.summary}</span>}
            </summary>
            <p className="mb-2 mt-1.5 text-xs text-muted-foreground">{server.name} has synced since.</p>
            <Steps steps={run.steps} />
            <Printed run={run} />
          </details>
        )}
        <h4 className={`${HEADING} mb-1.5 mt-4`}>{run === null ? "Failures this week" : "Earlier failures"}</h4>
        <Failures failures={earlier} />
      </div>
    </section>
  );
}

/** Insights › Sync: every enabled server, the ones failing first. */
export function SyncView() {
  const overview = useShuttleQuery("overview", {});
  const history = useShuttleQuery("syncHistory", {});
  const servers = (overview.data?.servers ?? []).filter((server) => server.enabled);
  const order = (server: ServerStatus) => (server.state === "failed" ? 0 : server.state === "partial" ? 1 : 2);
  const sorted = [...servers].sort((a, b) => order(a) - order(b));
  const error = overview.error ?? history.error;
  return (
    <>
      {error !== null && <ErrorNote>Could not load the sync history: {messageOf(error)}</ErrorNote>}
      {overview.data === undefined && error === null && <div className="py-6 text-sm text-muted-foreground">Loading…</div>}
      {overview.data !== undefined && servers.length === 0 && <div className="py-6 text-sm text-muted-foreground">No server is turned on. Add or turn one on in Settings.</div>}
      {sorted.map((server) => (
        <ServerSync key={server.id} server={server} history={history.data?.servers.find((entry) => entry.id === server.id)} windowMs={history.data?.windowMs ?? 3 * 3_600_000} />
      ))}
    </>
  );
}
