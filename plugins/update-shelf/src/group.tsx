import { useEffect, useRef, useState, type ReactNode } from "react";
import { Markdown, UrlLink } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { Changelog, PendingUpdate, UpdateJob, UpdatePhase } from "./contract";
import { useDelayedOn } from "./delayed-on";

export interface UpdatesGroupProps {
  updates: readonly PendingUpdate[];
  /** The first read hasn't answered yet, so nothing here is known: draw placeholders instead. */
  loading?: boolean;
  /** A read is in flight now; the group says so once it takes a moment. */
  checking?: boolean;
  /** When the last read answered, on the `now` clock; null before the first answer. */
  checkedAt?: number | null;
  /** Ids whose update was asked for and not yet acknowledged by bb. */
  starting: ReadonlySet<string>;
  /** Finished jobs the person cleared from the group. */
  dismissed: ReadonlySet<string>;
  onUpdate(ids: string[]): void;
  onClear(jobIds: string[]): void;
  loadChangelog(id: string): Promise<Changelog>;
  /** Milliseconds now; injected so tests can move time. */
  now?: () => number;
}

/** bb keeps a new version only after watching it this long without an error (DEFAULT_STABILIZATION_WINDOW_MS). */
export const CHECK_SECONDS = 30;

/** A read this quick never says "Checking…", so the label doesn't flicker on every poll. */
export const CHECKING_DELAY_MS = 300;

/** A first read that answers inside this never shows a skeleton, so the page doesn't flash one. */
export const SKELETON_DELAY_MS = 200;

const PHASE_TEXT: Record<UpdatePhase, string> = {
  preparing: "Downloading and building",
  activating: "Starting the new version",
  checking: "Checking the new version",
  "rolling-back": "Rolling back",
};

const isActiveJob = (job: UpdateJob | null) => job?.state === "queued" || job?.state === "running";
const isFinishedJob = (job: UpdateJob | null) => job?.state === "completed" || job?.state === "failed";
const failureOf = (update: PendingUpdate) =>
  update.job?.error ?? (update.job === null || !isActiveJob(update.job) ? update.lastFailure : null);

export function ordinal(position: number): string {
  if (position === 1) return "next";
  const tens = position % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][position % 10] ?? "th");
  return `${position}${suffix} in line`;
}

/** How long ago the last read answered: "checked just now", "checked 8 s ago", "checked 2 min ago". */
export function checkedAgo(elapsedMs: number): string {
  const seconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  if (seconds < 2) return "checked just now";
  if (seconds < 60) return `checked ${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `checked ${minutes} min ago`;
  return `checked ${Math.floor(minutes / 60)} h ago`;
}

/** The plugins with a waiting update or an update in progress, grouped above the Installed page's cards. */
export function UpdatesGroup({
  updates,
  loading = false,
  checking = false,
  checkedAt = null,
  starting,
  dismissed,
  onUpdate,
  onClear,
  loadChangelog,
  now = Date.now,
}: UpdatesGroupProps) {
  const [confirming, setConfirming] = useState(false);
  const elapsed = usePhaseClock(updates, now);
  const skeleton = useDelayedOn(loading, SKELETON_DELAY_MS);

  const visible = updates.filter((update) => !(update.job !== null && !update.updateAvailable && dismissed.has(update.job.id)));
  const busy = (update: PendingUpdate) => starting.has(update.id) || isActiveJob(update.job);
  const active = visible.filter(busy);
  const finished = visible.filter((update) => !busy(update) && isFinishedJob(update.job));
  const clearable = finished.filter((update) => !update.updateAvailable);
  const ready = visible.filter((update) => update.updateAvailable && !busy(update));

  useEffect(() => {
    if (ready.length < 2) setConfirming(false);
  }, [ready.length]);
  // Every hook above runs before either early return, so the hook order holds when a read answers.
  // Nothing is drawn before the skeleton's delay: a quiet page beats one that claims nothing is waiting.
  if (loading) return skeleton ? <CheckingSkeleton /> : null;
  if (visible.length === 0) return <NothingWaiting checking={checking} checkedAt={checkedAt} now={now} />;

  const total = active.length + finished.length;
  const title =
    active.length > 0
      ? `Updating plugins · ${finished.length} of ${total} done`
      : ready.length > 0
        ? ready.length === 1
          ? "1 plugin has an update"
          : `${ready.length} plugins have updates`
        : "Recently updated";

  return (
    <section aria-label="Plugin updates" className="rounded-xl border border-border bg-card text-card-foreground">
      <header className="px-3 py-2">
        <div className="flex min-h-7 flex-wrap items-center gap-2">
          <Icon
            name={active.length > 0 ? "Spinner" : "Download"}
            className={cn("size-4 shrink-0 text-muted-foreground", active.length > 0 && "animate-spin")}
            aria-hidden
          />
          <h2 className="min-w-0 flex-1 text-sm font-medium">{title}</h2>
          <CheckState checking={checking} checkedAt={checkedAt} now={now} />
          {clearable.length > 0 && active.length === 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => onClear(clearable.map((update) => update.job!.id))}
            >
              Clear finished
            </Button>
          ) : null}
          {ready.length < 2 ? null : confirming ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Update {ready.length} plugins?</span>
              <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                className="h-7"
                onClick={() => {
                  setConfirming(false);
                  onUpdate(ready.map((update) => update.id));
                }}
              >
                Update all
              </Button>
            </div>
          ) : (
            <Button type="button" variant="outline" size="sm" className="h-7" onClick={() => setConfirming(true)}>
              <Icon name="Download" aria-hidden />
              Update all
            </Button>
          )}
        </div>
        {active.length > 0 ? (
          <div className="mt-2 space-y-1.5">
            <div
              role="progressbar"
              aria-label="Plugins updated"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={finished.length}
              className="h-1 overflow-hidden rounded-full bg-muted"
            >
              <div className="h-full rounded-full bg-foreground/60 transition-[width] duration-500" style={{ width: `${(finished.length / total) * 100}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">
              bb updates one plugin at a time. Each takes about a minute: it downloads and builds the new version, starts it,
              then watches it for {CHECK_SECONDS} seconds before keeping it.
            </p>
          </div>
        ) : null}
      </header>
      <ul className="divide-y divide-border/60 border-t border-border/60">
        {visible.map((update) => (
          <UpdateRow
            key={update.id}
            update={update}
            starting={starting.has(update.id)}
            elapsedSeconds={update.job === null ? 0 : elapsed(update.job)}
            onUpdate={() => onUpdate([update.id])}
            loadChangelog={loadChangelog}
          />
        ))}
      </ul>
    </section>
  );
}

/** Placeholders for the group while the first read is still out, so the page shows it is being read. */
function CheckingSkeleton() {
  return (
    <section
      aria-label="Checking for plugin updates"
      aria-busy="true"
      className="rounded-xl border border-border bg-card text-card-foreground"
    >
      <header className="px-3 py-2">
        <div className="flex min-h-7 items-center gap-2">
          <Icon name="Spinner" className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
          <h2 className="min-w-0 flex-1 text-sm font-medium text-muted-foreground">Checking plugins for updates…</h2>
        </div>
      </header>
      <ul className="divide-y divide-border/60 border-t border-border/60">
        {[0, 1, 2].map((index) => (
          <li key={index} aria-hidden className="flex items-center gap-3 px-3 py-2">
            <span className="size-6 shrink-0 animate-pulse rounded border border-border bg-muted/40" />
            <span className="min-w-0 flex-1 space-y-1.5">
              <span className="block h-3 w-32 max-w-full animate-pulse rounded bg-muted" />
              <span className="block h-2.5 w-20 max-w-full animate-pulse rounded bg-muted/70" />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The group with nothing in it: says the page was read and when, rather than leaving the page silent. */
function NothingWaiting({ checking, checkedAt, now }: { checking: boolean; checkedAt: number | null; now: () => number }) {
  return (
    <section
      aria-label="Plugin updates"
      className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-xs text-card-foreground"
    >
      <Icon name="Download" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <p className="min-w-0 flex-1 truncate text-muted-foreground">No plugin has an update waiting</p>
      <CheckState checking={checking} checkedAt={checkedAt} now={now} />
    </section>
  );
}

/** "Checking…" while a read is out, otherwise how long ago the last one answered; ticks once a second. */
function CheckState({ checking, checkedAt, now }: { checking: boolean; checkedAt: number | null; now: () => number }) {
  const [, setTick] = useState(0);
  const slow = useDelayedOn(checking, CHECKING_DELAY_MS);
  useEffect(() => {
    if (slow) return;
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [slow]);
  if (slow) {
    return (
      <span role="status" className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
        <Icon name="Spinner" className="size-3.5 animate-spin" aria-hidden />
        Checking…
      </span>
    );
  }
  if (checkedAt === null) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
      <Icon name="Check" className="size-3.5" aria-hidden />
      {checkedAgo(now() - checkedAt)}
    </span>
  );
}

/** Seconds since each running job's current phase was first seen, ticking once a second while one runs. */
function usePhaseClock(updates: readonly PendingUpdate[], now: () => number): (job: UpdateJob) => number {
  const starts = useRef(new Map<string, number>());
  const [, setTick] = useState(0);
  const running = updates.some((update) => update.job?.state === "running");
  const key = (job: UpdateJob) => `${job.id}\u0000${job.phase}`;
  for (const update of updates) {
    if (update.job?.state === "running" && !starts.current.has(key(update.job))) starts.current.set(key(update.job), now());
  }
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return (job) => Math.max(0, Math.floor((now() - (starts.current.get(key(job)) ?? now())) / 1000));
}

function UpdateRow({
  update,
  starting,
  elapsedSeconds,
  onUpdate,
  loadChangelog,
}: {
  update: PendingUpdate;
  starting: boolean;
  elapsedSeconds: number;
  onUpdate(): void;
  loadChangelog(id: string): Promise<Changelog>;
}) {
  const [open, setOpen] = useState(false);
  const job = update.job;
  const failure = failureOf(update);
  const canUpdate = update.updateAvailable && !starting && !isActiveJob(job);
  return (
    <li data-plugin-update={update.id} data-state={starting ? "starting" : (job?.state ?? "waiting")} className="px-3 py-2">
      <div className="flex items-center gap-3">
        <PluginGlyph update={update} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{update.name}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {update.installed.label} → {update.candidate.label}
          </p>
        </div>
        {update.updateAvailable || open ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            What’s new
            <Icon name="ChevronDown" className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden />
          </Button>
        ) : null}
        <RowStatus update={update} starting={starting} elapsedSeconds={elapsedSeconds} />
        {canUpdate ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            aria-label={`${failure === null ? "Update" : "Retry updating"} ${update.name} to ${update.candidate.label}`}
            onClick={onUpdate}
          >
            <Icon name={failure === null ? "Download" : "RotateCcw"} className="size-3.5" aria-hidden />
            {failure === null ? "Update" : "Retry"}
          </Button>
        ) : null}
      </div>
      {failure !== null && !starting && !isActiveJob(job) ? (
        <p className="mt-1.5 flex items-start gap-1.5 text-xs text-muted-foreground">
          <Icon name="CircleX" className="mt-px size-3.5 shrink-0 text-destructive" aria-hidden />
          <span className="min-w-0 break-words">{failure}</span>
        </p>
      ) : null}
      {open ? (
        // Keyed by both versions: when bb offers a newer release while this is open, its changelog is read again.
        <ChangelogView
          key={`${update.installed.version}\u0000${update.candidate.version}`}
          id={update.id}
          fromLabel={update.installed.label}
          load={loadChangelog}
        />
      ) : null}
    </li>
  );
}

function RowStatus({ update, starting, elapsedSeconds }: { update: PendingUpdate; starting: boolean; elapsedSeconds: number }) {
  const job = update.job;
  if (starting) return <Status icon="Spinner" spin>Starting</Status>;
  if (job?.state === "queued") return <Status icon="Clock">Queued · {ordinal(job.queuePosition ?? 1)}</Status>;
  if (job?.state === "running") {
    const phase = job.phase === null ? "Updating" : PHASE_TEXT[job.phase];
    const time =
      job.phase === "checking" ? `${Math.min(elapsedSeconds, CHECK_SECONDS)} of ${CHECK_SECONDS} s` : `${elapsedSeconds} s`;
    return (
      <Status icon="Spinner" spin>
        {phase} · {time}
      </Status>
    );
  }
  if (job?.state === "completed" && job.outcome !== "rolled-back" && !update.updateAvailable) {
    return (
      <Status icon="Check" tone="success">
        {job.outcome === "current" ? "Already up to date" : "Updated"}
      </Status>
    );
  }
  if (isFinishedJob(job) && !update.updateAvailable) {
    return (
      <Status icon="CircleX" tone="error">
        {job?.outcome === "rolled-back" ? "Rolled back" : "Failed"}
      </Status>
    );
  }
  return null;
}

function Status({ icon, spin, tone, children }: { icon: string; spin?: boolean; tone?: "success" | "error"; children: ReactNode }) {
  return (
    <span role="status" className="flex h-7 shrink-0 items-center gap-1.5 px-2 text-xs text-muted-foreground tabular-nums">
      <Icon
        name={icon}
        className={cn("size-3.5", spin && "animate-spin", tone === "success" && "text-success", tone === "error" && "text-destructive")}
        aria-hidden
      />
      {children}
    </span>
  );
}

function PluginGlyph({ update }: { update: PendingUpdate }) {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded border border-border bg-muted/40 text-muted-foreground">
      {update.imageUrl !== null ? (
        <img src={update.imageUrl} alt="" className="size-4 object-contain" />
      ) : (
        <Icon name={update.icon ?? "Puzzle"} className="size-4" aria-hidden />
      )}
    </span>
  );
}

type Loaded = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; changelog: Changelog };

function ChangelogView({ id, fromLabel, load }: { id: string; fromLabel: string; load(id: string): Promise<Changelog> }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setLoaded({ state: "loading" });
    load(id).then(
      (changelog) => live && setLoaded({ state: "ready", changelog }),
      (error: unknown) => live && setLoaded({ state: "error", message: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      live = false;
    };
  }, [id, load, attempt]);

  const frame = "mt-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs";
  if (loaded.state === "loading") {
    return (
      <div className={cn(frame, "flex items-center gap-1.5 text-muted-foreground")}>
        <Icon name="Spinner" className="size-3.5 animate-spin" aria-hidden />
        Reading the changelog from the source…
      </div>
    );
  }
  if (loaded.state === "error") {
    return (
      <div className={cn(frame, "flex items-center gap-2 text-muted-foreground")}>
        <span className="min-w-0 flex-1 break-words">Couldn’t read the changelog: {loaded.message}</span>
        <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </Button>
      </div>
    );
  }

  const { changelog } = loaded;
  const partial = changelog.changelogError !== null || changelog.commitsError !== null;
  const retry = partial ? (
    <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setAttempt((n) => n + 1)}>
      Try again
    </Button>
  ) : null;
  if (changelog.unavailable !== null) {
    return (
      <div className={cn(frame, "flex items-center gap-2 text-muted-foreground")}>
        <span className="min-w-0 flex-1 break-words">{changelog.unavailable}</span>
        {retry}
      </div>
    );
  }
  const commitCount = changelog.commits.length + changelog.moreCommits;
  const lead =
    changelog.changelogError !== null
      ? `Couldn’t read the changelog: ${changelog.changelogError}`
      : `No changelog entry since ${fromLabel}.`;
  const counted = `${commitCount}${changelog.commitsCapped ? "+" : ""} commit${commitCount === 1 && !changelog.commitsCapped ? "" : "s"}`;
  return (
    <div className={cn(frame, "space-y-3")}>
      {changelog.notes.map((entry) => (
        <article key={entry.version} className="space-y-1">
          <h3 className="text-xs font-semibold text-foreground">{entry.title}</h3>
          {entry.body === "" ? null : <Markdown content={entry.body} className="text-xs" />}
        </article>
      ))}
      {changelog.notes.length === 0 ? (
        <p className="break-words text-muted-foreground">
          {commitCount === 0 ? `No changelog entry or commits since ${fromLabel}.` : `${lead} Commits that changed this plugin:`}
        </p>
      ) : null}
      {changelog.notes.length > 0 && changelog.commitsError !== null ? (
        <p className="break-words text-muted-foreground">Couldn’t read the commits: {changelog.commitsError}</p>
      ) : null}
      {changelog.notes.length === 0 && changelog.commits.length > 0 ? (
        <ul className="space-y-1">
          {changelog.commits.map((commit) => (
            <li key={commit.sha} className="flex min-w-0 gap-2">
              <UrlLink href={commit.url} className="shrink-0 font-mono text-muted-foreground hover:text-foreground hover:underline">
                {commit.sha.slice(0, 7)}
              </UrlLink>
              <span className="min-w-0 truncate text-foreground">{commit.title}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center gap-2">
        {changelog.compareUrl === null ? null : (
          <UrlLink
            href={changelog.compareUrl}
            className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
          >
            {commitCount > 0 ? `View ${counted} on GitHub` : "View on GitHub"}
            <Icon name="ExternalLink" className="size-3" aria-hidden />
          </UrlLink>
        )}
        {retry}
      </div>
    </div>
  );
}
