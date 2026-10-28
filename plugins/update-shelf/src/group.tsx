import { useEffect, useState } from "react";
import { Markdown, UrlLink } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { Changelog, PendingUpdate } from "./contract";

export interface UpdatesGroupProps {
  updates: readonly PendingUpdate[];
  /** Ids whose update was asked for and not yet acknowledged by bb. */
  starting: ReadonlySet<string>;
  onUpdate(ids: string[]): void;
  loadChangelog(id: string): Promise<Changelog>;
}

const inProgress = (update: PendingUpdate, starting: ReadonlySet<string>) =>
  starting.has(update.id) || update.job?.state === "queued" || update.job?.state === "running";

/** The plugins with a waiting update, grouped above the Installed page's cards. */
export function UpdatesGroup({ updates, starting, onUpdate, loadChangelog }: UpdatesGroupProps) {
  const [confirming, setConfirming] = useState(false);
  const ready = updates.filter((update) => !inProgress(update, starting));
  useEffect(() => {
    if (ready.length < 2) setConfirming(false);
  }, [ready.length]);
  if (updates.length === 0) return null;

  const title = updates.length === 1 ? "1 plugin has an update" : `${updates.length} plugins have updates`;
  return (
    <section aria-label="Plugin updates" className="rounded-xl border border-border bg-card text-card-foreground">
      <header className="flex min-h-11 flex-wrap items-center gap-2 px-3 py-2">
        <Icon name="Download" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h2 className="min-w-0 flex-1 text-sm font-medium">{title}</h2>
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
      </header>
      <ul className="divide-y divide-border/60 border-t border-border/60">
        {updates.map((update) => (
          <UpdateRow
            key={update.id}
            update={update}
            busy={inProgress(update, starting)}
            onUpdate={() => onUpdate([update.id])}
            loadChangelog={loadChangelog}
          />
        ))}
      </ul>
    </section>
  );
}

function UpdateRow({
  update,
  busy,
  onUpdate,
  loadChangelog,
}: {
  update: PendingUpdate;
  busy: boolean;
  onUpdate(): void;
  loadChangelog(id: string): Promise<Changelog>;
}) {
  const [open, setOpen] = useState(false);
  const failure = update.job?.state === "failed" ? (update.job.detail ?? "The update failed.") : update.lastFailure;
  const status = update.job?.state === "running" ? (update.job.detail ?? "Updating") : "Queued";
  return (
    <li data-plugin-update={update.id} className="px-3 py-2">
      <div className="flex items-center gap-3">
        <PluginGlyph update={update} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{update.name}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {update.installed.label} → {update.candidate.label}
          </p>
        </div>
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
        {busy ? (
          <span role="status" className="flex h-7 items-center gap-1.5 px-2 text-xs text-muted-foreground">
            <Icon name="Spinner" className="size-3.5 animate-spin" aria-hidden />
            {status}
          </span>
        ) : (
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
        )}
      </div>
      {failure !== null && !busy ? (
        <p className="mt-1.5 flex items-start gap-1.5 text-xs text-muted-foreground">
          <Icon name="CircleX" className="mt-px size-3.5 shrink-0 text-destructive" aria-hidden />
          <span className="min-w-0 break-words">{failure}</span>
        </p>
      ) : null}
      {open ? <ChangelogView id={update.id} fromLabel={update.installed.label} load={loadChangelog} /> : null}
    </li>
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
  if (changelog.unavailable !== null) {
    return <div className={cn(frame, "text-muted-foreground")}>{changelog.unavailable}</div>;
  }
  const commitCount = changelog.commits.length + changelog.moreCommits;
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
        <p className="text-muted-foreground">
          {commitCount === 0
            ? `No changelog entry or commits since ${fromLabel}.`
            : `No changelog entry since ${fromLabel}. Commits that changed this plugin:`}
        </p>
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
      {changelog.compareUrl === null ? null : (
        <UrlLink
          href={changelog.compareUrl}
          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
        >
          {commitCount > 0 ? `View ${counted} on GitHub` : "View on GitHub"}
          <Icon name="ExternalLink" className="size-3" aria-hidden />
        </UrlLink>
      )}
    </div>
  );
}
