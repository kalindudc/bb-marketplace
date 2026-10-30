import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  experimental_Icon as Icon, experimental_useRpcKeyedQuery, useBbNavigate, useSdk,
  type ExperimentalThreadActionTabProps,
} from "@get-bb/plugin-sdk/app";
import type { PrView } from "../contract";
import { ActionsProvider } from "./actions";
import { BUTTON, BUTTON_GHOST, BUTTON_PRIMARY, CARD, ErrorNote, HEADING, ICON_GHOST, Pill, Segmented, ServerBadge } from "./common";
import { AGENT_MODE_META, PANEL_PATH, ROLE_LABELS } from "./constants";
import { messageOf, openExternal, threadsOf, useShuttleMutation, useShuttleQuery } from "./data";
import { PrDetail } from "./detail";
import { ago, plural, shortKey } from "./format";
import { LookupInput } from "./header";
import { AgentPill, ChecksPill, isLive, MyReviewPill, ReviewPill, StalePill, StatePill } from "./pills";
import { panelPrs, rememberPanelPr } from "./prefs";
import { useStored } from "./remember";
import { formatRoute } from "./route";
import { useSurface } from "./surface";
import { useScrollMemory } from "./scroll";
import { GITHUB_PR_STATUS, githubPrStatus } from "./tab";
import { useViewport } from "./viewport";
import type { PrWrites } from "./writes";

const MODES = (["fix", "notify", "off"] as const).map((value) => ({ value, label: AGENT_MODE_META[value].label }));

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
    <div data-branch-pr className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-raised p-3 text-sm">
      <Icon name="GitPullRequest" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
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

/** Who handles the PR's feedback, from this thread's side: it, another thread, or nobody. */
function AgentBlock({ pr, threadId, writes }: { pr: PrView; threadId: string; writes: PrWrites }) {
  const agent = pr.agent;
  if (!isLive(pr) || (!pr.mine && agent === null)) return null;
  const makeAgent = (
    <button type="button" className={BUTTON} onClick={() => void writes.giveAgent(pr, { kind: "existing", threadId })}>
      <Icon name="Bot" className="size-3.5" aria-hidden />Make this thread the agent
    </button>
  );
  return (
    <div data-agent-block className="mt-2.5 border-t border-border pt-2.5 text-sm">
      {agent?.threadId === threadId ? (
        <>
          <div className="mb-1.5 flex items-center gap-1.5 font-semibold"><Icon name="Bot" className="size-3.5" aria-hidden />This thread is the agent</div>
          <Segmented label={`What this thread does with ${shortKey(pr)}`} value={agent.mode} options={MODES} onChange={(mode) => void writes.changeMode(pr, mode)} />
          <div className="mt-1.5 text-xs text-muted-foreground">{AGENT_MODE_META[agent.mode].sentence}</div>
        </>
      ) : agent !== null ? (
        <>
          <div className="mb-1.5 truncate text-xs text-muted-foreground" title={agent.title}>Agent: <span className="text-foreground">{agent.title}</span></div>
          {makeAgent}
        </>
      ) : (
        <>
          <div className="mb-1.5 text-xs text-muted-foreground">No agent: new reviews and failed checks wait in the Inbox.</div>
          {makeAgent}
        </>
      )}
    </div>
  );
}

function PrCard({ pr, threadId, busy, writes, onView, onUnlink }: {
  pr: PrView;
  threadId: string;
  busy: boolean;
  writes: PrWrites;
  onView(pr: PrView): void;
  onUnlink(pr: PrView): void;
}) {
  const navigate = useBbNavigate();
  const role = pr.agent?.threadId === threadId ? "Agent" : (() => {
    const link = pr.links.find((entry) => entry.threadId === threadId);
    return link === undefined ? null : ROLE_LABELS[link.role].short;
  })();
  const others = pr.links.filter((link) => link.threadId !== threadId);
  return (
    <li data-pr={pr.key} className={`${CARD} p-3`}>
      <div className="flex items-center gap-2">
        <ServerBadge name={pr.serverName} />
        <span className="min-w-0 truncate font-mono text-xs">{shortKey(pr)}</span>
        {role !== null && <Pill>{role}</Pill>}
      </div>
      <button type="button" className="my-1.5 block w-full cursor-pointer text-left text-sm font-semibold leading-snug hover:underline" title="View the whole PR here" onClick={() => onView(pr)}>
        {pr.title}
      </button>
      <div className="flex flex-wrap gap-1">
        <StatePill state={pr.state} />
        <ChecksPill pr={pr} />
        {pr.mine ? <ReviewPill pr={pr} /> : <MyReviewPill pr={pr} />}
        {pr.mine && <AgentPill pr={pr} />}
        {pr.pendingItems > 0 && <Pill tone="info">{plural(pr.pendingItems, "new item")}</Pill>}
        <StalePill pr={pr} />
      </div>
      {others.length > 0 && (
        <div className="mt-1.5 text-xs text-muted-foreground" title={others.map((link) => link.title).join("\n")}>
          Also linked to {plural(others.length, "other thread")}
        </div>
      )}
      <AgentBlock pr={pr} threadId={threadId} writes={writes} />
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <button type="button" className={BUTTON_PRIMARY} title="Its description, conversation, checks and actions, here in the tab" onClick={() => onView(pr)}>
          <Icon name="PanelRightOpen" fallback="GitPullRequest" className="size-3.5" aria-hidden />
          View PR
        </button>
        <button type="button" className={BUTTON} title={`Open on ${pr.serverName}`} onClick={() => openExternal(navigate, pr.url)}>
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

/** One PR in full inside the tab, as the Shuttle page shows it, with a way back to the thread's list. */
function PanelPrView({ prKey, onBack }: { prKey: string; onBack(): void }) {
  const navigate = useBbNavigate();
  const scroller = useScrollMemory(`pr/${prKey}`, true);
  return (
    <section data-shuttle-panel data-panel-pr={prKey} aria-label="Shuttle" className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2">
        <button type="button" aria-label="Back to this thread's pull requests" onClick={onBack}
          className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs text-foreground hover:bg-state-hover">
          <Icon name="ChevronLeft" className="size-4" aria-hidden />Pull requests
        </button>
        <span className="flex-1" />
        <button type="button" aria-label="Show in Shuttle" title="Show in Shuttle" className={ICON_GHOST}
          onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: formatRoute({ view: "pr", key: prKey }) })}>
          <Icon name="shuttle/shuttle" fallback="GitPullRequest" className="size-4" aria-hidden />
        </button>
      </div>
      <div ref={scroller.ref} onScroll={scroller.onScroll} data-scroller className="min-h-0 flex-1 overflow-y-auto">
        <PrDetail key={prKey} prKey={prKey} />
      </div>
    </section>
  );
}

/** Every PR linked to the thread, its agent, what Shuttle sent here, and ways to link another. */
function PanelList({ threadId, prs, data, writes, onView }: {
  threadId: string;
  prs: readonly PrView[] | undefined;
  data: ReturnType<typeof useShuttleQuery<"threadPrs">>;
  writes: PrWrites;
  onView(key: string): void;
}) {
  const link = useShuttleMutation("link");
  const unlink = useShuttleMutation("unlink");
  const sendUnread = useShuttleMutation("sendUnread");
  const busy = link.isPending || unlink.isPending || sendUnread.isPending;
  const navigate = useBbNavigate();
  const pending = prs?.reduce((sum, pr) => sum + pr.pendingItems, 0) ?? 0;
  const linked = new Set(prs?.map((pr) => pr.key));

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
  // A PR this thread no longer links to is shown on the Shuttle page instead.
  const showEvent = (key: string) => (linked.has(key) ? onView(key) : navigate.toPluginPanel(PANEL_PATH, { subPath: formatRoute({ view: "pr", key }) }));

  return (
    <section data-shuttle-panel aria-label="Shuttle" className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {data.error !== null && <ErrorNote>Could not load this thread's pull requests: {messageOf(data.error)}</ErrorNote>}
        {prs === undefined && data.error === null && <div className="py-4 text-sm text-muted-foreground">Loading…</div>}
        {prs !== undefined && <BranchSuggestion threadId={threadId} linked={prs} busy={busy} onLink={(url) => void linkPr(url)} />}
        {prs?.length === 0 && (
          <p className="py-2 text-sm text-muted-foreground">No pull request is linked to this thread. Paste a link or key below to link one.</p>
        )}
        {prs !== undefined && prs.length > 0 && (
          <>
            <ul aria-label="Linked pull requests" className="flex flex-col gap-2.5">
              {prs.map((pr) => (
                <PrCard key={pr.key} pr={pr} threadId={threadId} busy={busy} writes={writes} onView={(item) => onView(item.key)} onUnlink={(item) => void onUnlink(item)} />
              ))}
            </ul>
            <div className="mt-3 flex items-center gap-2">
              <button type="button" className={BUTTON} disabled={busy} title="Checks this thread's PRs for new activity now, then sends what this thread has not seen" onClick={() => void onSendUnread()}>
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
                        <button type="button" className="cursor-pointer font-mono hover:underline" onClick={() => showEvent(event.key!)}>
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

/**
 * The Shuttle tab beside a thread: its PRs as cards, or one of them in full with everything the
 * Shuttle page offers. The tab remembers, per thread, which PR it shows in full.
 */
export function ShuttlePanel({ threadId }: ExperimentalThreadActionTabProps) {
  const phone = useViewport() === "phone";
  const data = useShuttleQuery("threadPrs", { threadId });
  const prs = data.data?.prs;
  const remembered = useStored(panelPrs)[threadId] ?? null;
  // Only a PR still linked here opens in full; an unlinked one leaves the tab on its list.
  const openKey = remembered !== null && prs?.some((pr) => pr.key === remembered) === true ? remembered : null;
  const select = (key: string) => rememberPanelPr(threadId, key);
  const threadIds = [...new Set([threadId, ...threadsOf(prs ?? [])])];
  const { actions, dialogs } = useSurface({ phone, sheetComposer: false, selected: openKey, select, threadIds });

  return (
    <ActionsProvider value={actions}>
      {openKey !== null ? (
        <PanelPrView prKey={openKey} onBack={() => rememberPanelPr(threadId, null)} />
      ) : (
        <PanelList threadId={threadId} prs={prs} data={data} writes={actions.writes} onView={select} />
      )}
      {dialogs}
    </ActionsProvider>
  );
}
