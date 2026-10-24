import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  experimental_Icon as Icon, experimental_useRpcKeyedQuery, useBbNavigate, useSdk,
  type ExperimentalThreadActionTabProps,
} from "@get-bb/plugin-sdk/app";
import type { WatchMode } from "../config";
import type { PrView } from "../contract";
import { BUTTON, BUTTON_GHOST, CARD, ErrorNote, FIELD, HEADING, Pill, ServerBadge, Toggle } from "./common";
import { PANEL_PATH, ROLE_LABELS, WATCH_MODES } from "./constants";
import { messageOf, openExternal, useShuttleMutation, useShuttleQuery, useWatchMutation } from "./data";
import { ago, plural, shortKey } from "./format";
import { LookupInput } from "./header";
import { ChecksPill, LastReviewPill, ReviewPill, StatePill } from "./pills";
import { formatRoute } from "./route";
import { isLive } from "./row";
import { GITHUB_PR_STATUS, githubPrStatus } from "./tab";

const PANEL_MODE_LABELS: Record<WatchMode, string> = {
  act: "Send them and ask this thread to act",
  forward: "Send them only",
};

const sameUrl = (a: string, b: string) => a.replace(/\/+$/u, "").toLowerCase() === b.replace(/\/+$/u, "").toLowerCase();

function useEnvironmentId(threadId: string): string | null {
  const sdk = useSdk();
  const [environment, setEnvironment] = useState<{ threadId: string; id: string | null } | null>(null);
  useEffect(() => {
    let current = true;
    sdk.threads.get({ threadId }).then(
      (thread) => current && setEnvironment({ threadId, id: thread.environmentId }),
      // The branch suggestion is a hint: without the thread there is simply nothing to suggest.
      () => current && setEnvironment({ threadId, id: null }),
    );
    return () => {
      current = false;
    };
  }, [sdk, threadId]);
  return environment?.threadId === threadId ? environment.id : null;
}

/** The PR GitHub PR Status found for this thread's branch, when Shuttle has not linked it yet. */
function BranchSuggestion({ threadId, linked, busy, onLink }: { threadId: string; linked: readonly PrView[]; busy: boolean; onLink(url: string): void }) {
  const environmentId = useEnvironmentId(threadId);
  const { data } = experimental_useRpcKeyedQuery({
    pluginId: GITHUB_PR_STATUS,
    contract: githubPrStatus,
    method: "pullRequests",
    keys: environmentId === null ? [] : [environmentId],
  });
  const row = environmentId === null ? undefined : data?.[environmentId];
  if (row?.outcome !== "available") return null;
  const { pullRequest } = row;
  if (linked.some((pr) => sameUrl(pr.url, pullRequest.url))) return null;
  return (
    <div data-branch-pr className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm">
      <Icon name="GitPullRequest" className="size-4 shrink-0 text-primary" aria-hidden />
      <span className="min-w-0 flex-1">
        This thread's branch has PR #{pullRequest.number}
        <span className="block truncate text-xs text-muted-foreground" title={pullRequest.title}>{pullRequest.title}</span>
      </span>
      <button type="button" className={BUTTON} disabled={busy} onClick={() => onLink(pullRequest.url)}>
        <Icon name="Link" className="size-3.5" aria-hidden />
        Link
      </button>
    </div>
  );
}

function PrCard({ pr, threadId, busy, onWatch, onMode, onUnlink }: {
  pr: PrView;
  threadId: string;
  busy: boolean;
  onWatch(pr: PrView, on: boolean): void;
  onMode(pr: PrView, mode: WatchMode): void;
  onUnlink(pr: PrView): void;
}) {
  const navigate = useBbNavigate();
  const role = pr.links.find((link) => link.threadId === threadId)?.role ?? null;
  const others = pr.links.filter((link) => link.threadId !== threadId);
  return (
    <li data-pr={pr.key} className={`${CARD} p-3`}>
      <div className="flex items-center gap-2">
        <ServerBadge name={pr.serverName} />
        <span className="min-w-0 truncate font-mono text-xs">{shortKey(pr)}</span>
        {role !== null && <Pill>{ROLE_LABELS[role].short}</Pill>}
      </div>
      <div className="my-1.5 text-sm font-semibold leading-snug">{pr.title}</div>
      <div className="flex flex-wrap gap-1">
        <StatePill state={pr.state} />
        <ChecksPill checks={pr.checks} />
        <ReviewPill review={pr.review} />
        <LastReviewPill run={pr.lastReview} />
        {pr.pendingItems > 0 && <Pill tone="info">{plural(pr.pendingItems, "new item")}</Pill>}
        {pr.stale && <Pill tone="warn" icon="AlertTriangle" title="This server's last sync failed">May be out of date</Pill>}
      </div>
      {others.length > 0 && (
        <div className="mt-1.5 text-xs text-muted-foreground" title={others.map((link) => link.title).join("\n")}>
          Also linked to {plural(others.length, "other thread")}
        </div>
      )}
      {isLive(pr) && (
        <div className="mt-2.5 border-t border-border pt-2.5">
          <div className="flex items-center gap-2 text-sm">
            <Toggle on={pr.watch !== null} label={`Watch ${shortKey(pr)}`} disabled={busy} onChange={(on) => onWatch(pr, on)} />
            <span className="flex-1">Watch: send new reviews here</span>
          </div>
          {pr.watch !== null && (
            <select aria-label={`When a review on ${shortKey(pr)} arrives`} className={`${FIELD} mt-2 w-full`} value={pr.watch} disabled={busy}
              onChange={(event) => onMode(pr, event.target.value as WatchMode)}>
              {WATCH_MODES.map((mode) => <option key={mode} value={mode}>{PANEL_MODE_LABELS[mode]}</option>)}
            </select>
          )}
        </div>
      )}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <button type="button" className={BUTTON} onClick={() => openExternal(navigate, pr.url)}>
          <Icon name="ExternalLink" className="size-3.5" aria-hidden />
          Open
        </button>
        <button type="button" className={BUTTON} onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: formatRoute({ view: "pr", key: pr.key }) })}>
          <Icon name="shuttle/shuttle" fallback="GitPullRequest" className="size-3.5" aria-hidden />
          Show in Shuttle
        </button>
        <button type="button" className={BUTTON_GHOST} disabled={busy} onClick={() => onUnlink(pr)}>Unlink</button>
      </div>
    </li>
  );
}

/** The Shuttle tab beside a thread: every PR linked to it, its watch switch, what Shuttle sent here, and ways to link another. */
export function ShuttlePanel({ threadId }: ExperimentalThreadActionTabProps) {
  const data = useShuttleQuery("threadPrs", { threadId });
  const config = useShuttleQuery("getConfig", {});
  const watch = useWatchMutation([threadId]);
  const link = useShuttleMutation("link");
  const unlink = useShuttleMutation("unlink");
  const sendUnread = useShuttleMutation("sendUnread");
  const busy = link.isPending || unlink.isPending || sendUnread.isPending;
  const navigate = useBbNavigate();
  const prs = data.data?.prs;
  const pending = prs?.reduce((sum, pr) => sum + pr.pendingItems, 0) ?? 0;

  const setWatch = async (pr: PrView, mode: WatchMode | null) => {
    const role = pr.links.find((entry) => entry.threadId === threadId)?.role ?? null;
    // Watched reviews go to owner threads, and this switch promises to send them here.
    if (mode !== null && role !== "owner" && (await link.run({ key: pr.key, threadId, role: "owner" })) === null) return;
    await watch.run({ key: pr.key, mode });
  };
  const onWatch = (pr: PrView, on: boolean) => {
    if (!on) return void setWatch(pr, null);
    if (config.data === undefined) return void toast.error("Shuttle's settings have not loaded yet");
    void setWatch(pr, config.data.config.watch.mode);
  };
  const onUnlink = async (pr: PrView) => {
    if (await unlink.run({ key: pr.key, threadId })) toast.success(`Unlinked ${shortKey(pr)}`);
  };
  const onSendUnread = async () => {
    const out = await sendUnread.run({ threadId });
    if (out !== null) toast.success(out.sent === 0 ? "Nothing unread: everything is already here" : `Sent ${plural(out.sent, "item")} to this thread`);
  };
  const linkPr = async (key: string) => {
    const out = await link.run({ key, threadId, role: "owner" });
    if (out !== null) toast.success(`Linked ${shortKey(out.pr)} to this thread`);
  };

  return (
    <section data-shuttle-panel aria-label="Shuttle" className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {data.error !== null && <ErrorNote>Could not load this thread's pull requests: {messageOf(data.error)}</ErrorNote>}
        {prs === undefined && data.error === null && <div className="py-4 text-sm text-muted-foreground">Loading…</div>}
        {prs !== undefined && <BranchSuggestion threadId={threadId} linked={prs} busy={busy} onLink={(url) => void linkPr(url)} />}
        {prs?.length === 0 && (
          <p className="py-2 text-sm text-muted-foreground">No pull request is linked to this thread. Paste a link or key below to link one; this thread then owns it.</p>
        )}
        {prs !== undefined && prs.length > 0 && (
          <>
            <ul aria-label="Linked pull requests" className="flex flex-col gap-2.5">
              {prs.map((pr) => (
                <PrCard key={pr.key} pr={pr} threadId={threadId} busy={busy} onWatch={onWatch}
                  onMode={(item, mode) => void setWatch(item, mode)} onUnlink={(item) => void onUnlink(item)} />
              ))}
            </ul>
            <div className="mt-3 flex items-center gap-2">
              <button type="button" className={BUTTON} disabled={busy} title="Checks the watched PRs for new activity now, then sends what this thread has not seen" onClick={() => void onSendUnread()}>
                <Icon name="Sent" className="size-3.5" aria-hidden />
                {pending === 0 ? "Send unread now" : `Send ${plural(pending, "unread item")} now`}
              </button>
            </div>
          </>
        )}

        {data.data !== undefined && (
          <>
            <h3 className={`${HEADING} mb-2 mt-4`}>Sent to this thread</h3>
            {data.data.sent.length === 0 ? (
              <div className="text-sm text-muted-foreground">Nothing yet.</div>
            ) : (
              <ul aria-label="Sent to this thread" className="ml-1.5 border-l border-border">
                {data.data.sent.map((event) => (
                  <li key={event.id} className="relative pb-3 pl-4 before:absolute before:left-[-5px] before:top-1.5 before:size-2 before:rounded-full before:bg-success">
                    <div className="text-sm">{event.text}</div>
                    <div className="flex gap-2 text-xs text-muted-foreground">
                      <span>{ago(event.at)}</span>
                      {event.key !== null && (
                        <button type="button" className="cursor-pointer font-mono hover:underline"
                          onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: formatRoute({ view: "pr", key: event.key! }) })}>
                          {event.key}
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      <div className="shrink-0 border-t border-border p-3">
        <LookupInput icon="Link" label="Link a pull request" placeholder={prs?.length ? "Link another PR: paste a link or key" : "Link a PR: paste a link or key"} onFound={linkPr} />
      </div>
    </section>
  );
}
