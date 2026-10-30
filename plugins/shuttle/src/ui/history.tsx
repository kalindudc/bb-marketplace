import { useState, type ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { ConversationItem, EventView, PrDetails, PrView, TimelineEvent } from "../contract";
import { useActions } from "./actions";
import { lookOf, TONE_ICON } from "./activity";
import { Segmented, type Tone } from "./common";
import { checkName } from "./format";

interface Entry {
  key: string;
  at: number;
  from: "server" | "shuttle";
  icon: string;
  tone: Tone;
  text: ReactNode;
  threadId: string | null;
}

const b = (text: string) => <b className="font-semibold">{text}</b>;
const mono = (text: string) => <span className="font-mono text-[12px]">{text}</span>;

function serverEvent(event: TimelineEvent, who: ReactNode): { icon: string; tone: Tone; text: ReactNode } {
  const subject = event.subject ?? "";
  const detail = event.detail ?? "";
  switch (event.kind) {
    case "review_requested": return { icon: "UserRoundPlus", tone: "neutral", text: <>{who} asked {b(subject || "someone")} to review</> };
    case "review_request_removed": return { icon: "UserRound", tone: "neutral", text: <>{who} withdrew the review request to {b(subject || "someone")}</> };
    case "labeled": return { icon: "Tag", tone: "neutral", text: <>{who} added the label {b(subject)}</> };
    case "unlabeled": return { icon: "Tag", tone: "neutral", text: <>{who} removed the label {b(subject)}</> };
    case "ready_for_review": return { icon: "GitPullRequest", tone: "ok", text: <>{who} marked it ready for review</> };
    case "converted_to_draft": return { icon: "GitPullRequestDraft", tone: "neutral", text: <>{who} turned it back into a draft</> };
    case "force_pushed": return { icon: "GitCommit", tone: "warn", text: <>{who} force-pushed{detail && <> from {mono(detail)}</>}{subject && <> to {mono(subject)}</>}</> };
    case "merged": return { icon: "GitMerge", tone: "brand", text: <>{who} merged it{detail && <> into {mono(detail)}</>}{subject && <> as {mono(subject)}</>}</> };
    case "closed": return { icon: "GitPullRequestClosed", tone: "bad", text: <>{who} closed it</> };
    case "reopened": return { icon: "RotateCcw", tone: "ok", text: <>{who} reopened it</> };
    case "renamed": return { icon: "Edit", tone: "neutral", text: <>{who} renamed it from “{detail}” to “{subject}”</> };
    case "auto_merge_enabled": return { icon: "GitMerge", tone: "neutral", text: <>{who} turned on auto-merge</> };
    case "auto_merge_disabled": return { icon: "GitMerge", tone: "neutral", text: <>Auto-merge was turned off</> };
    case "review_dismissed": return { icon: "Minus", tone: "neutral", text: <>{who} dismissed {subject ? <>{b(subject)}’s</> : "a"} review</> };
    case "branch_deleted": return { icon: "GitBranch", tone: "neutral", text: <>{who} deleted the branch {mono(subject)}</> };
    case "base_changed": return { icon: "GitBranch", tone: "neutral", text: <>{who} changed the base from {mono(detail)} to {mono(subject)}</> };
  }
}

function itemEntry(item: ConversationItem): Omit<Entry, "key" | "at" | "from" | "threadId"> | null {
  const who = b(item.mine ? "You" : item.author ?? "Someone");
  if (item.kind === "check") return { icon: "CircleX", tone: "bad", text: <>{checkName(item.body)} failed</> };
  if (item.kind === "comment") return { icon: "MessageSquare", tone: "neutral", text: <>{who} commented</> };
  if (item.kind === "thread") {
    const where = item.path === null ? null : mono(`${item.path.split("/").at(-1)}${item.line === null ? "" : `:${item.line}`}`);
    return { icon: "MessageSquare", tone: "neutral", text: <>{who} commented{where && <> on {where}</>}</> };
  }
  const state = (item.state ?? "").toLowerCase();
  if (state.includes("approv")) return { icon: "Check", tone: "ok", text: <>{who} approved</> };
  if (state.includes("change")) return { icon: "X", tone: "bad", text: <>{who} requested changes</> };
  return { icon: "MessageSquare", tone: "neutral", text: <>{who} reviewed</> };
}

/** Everything that happened to the PR, on its server and in Shuttle, newest first. */
export function buildHistory(pr: PrView, items: readonly ConversationItem[], details: PrDetails | null, events: readonly EventView[]): Entry[] {
  const out: Entry[] = [];
  const whoIs = (login: string | null) => b(login === null ? "Someone" : pr.mine && login === pr.author ? "You" : login);
  if (pr.createdAt !== null) out.push({ key: "opened", at: pr.createdAt, from: "server", icon: "GitPullRequest", tone: "neutral", text: <>{whoIs(pr.author)} opened the PR</>, threadId: null });
  for (const commit of details?.commits?.items ?? []) {
    if (commit.at === null) continue;
    out.push({ key: `commit/${commit.sha}`, at: commit.at, from: "server", icon: "GitCommit", tone: "neutral", text: <>{whoIs(commit.author)} committed {mono(commit.sha.slice(0, 7))} {commit.message}</>, threadId: null });
  }
  for (const item of items) {
    const entry = item.at === null ? null : itemEntry(item);
    if (entry !== null) out.push({ key: `item/${item.id}`, at: item.at!, from: "server", threadId: null, ...entry });
  }
  const timeline = details?.timeline ?? [];
  timeline.forEach((event, index) => out.push({ key: `timeline/${index}`, at: event.at, from: "server", threadId: null, ...serverEvent(event, whoIs(event.actor)) }));
  // Without the server's timeline, the merge or close still shows.
  const ended = timeline.some((event) => event.kind === "merged" || event.kind === "closed");
  if (!ended && pr.closedAt !== null && (pr.state === "merged" || pr.state === "closed")) {
    out.push({ key: "ended", at: pr.closedAt, from: "server", icon: pr.state === "merged" ? "GitMerge" : "GitPullRequestClosed", tone: pr.state === "merged" ? "brand" : "bad", text: pr.state === "merged" ? "Merged" : "Closed without merging", threadId: null });
  }
  for (const event of events) {
    const look = lookOf(event.kind);
    out.push({ key: `shuttle/${event.id}`, at: event.at, from: "shuttle", icon: look.icon, tone: look.tone, text: event.text, threadId: event.threadId });
  }
  return out.sort((x, y) => y.at - x.at);
}

function dayOf(at: number, now = Date.now()): string {
  const day = new Date(at).toDateString();
  if (day === new Date(now).toDateString()) return "Today";
  if (day === new Date(now - 86_400_000).toDateString()) return "Yesterday";
  return new Date(at).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", ...(new Date(at).getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }) });
}

type Filter = "all" | "server" | "shuttle";

export function HistoryPane({ pr, items, details, events }: { pr: PrView; items: readonly ConversationItem[] | undefined; details: PrDetails | null; events: readonly EventView[] }) {
  const actions = useActions();
  const [filter, setFilter] = useState<Filter>("all");
  const entries = buildHistory(pr, items ?? [], details, events).filter((entry) => filter === "all" || entry.from === filter);
  const days: { day: string; entries: Entry[] }[] = [];
  for (const entry of entries) {
    const day = dayOf(entry.at);
    if (days.at(-1)?.day !== day) days.push({ day, entries: [] });
    days.at(-1)!.entries.push(entry);
  }
  return (
    <div data-history>
      <div className="mb-3.5 flex flex-wrap items-center gap-2">
        <div className="min-w-0"><Segmented label="Show" value={filter} onChange={setFilter}
          options={[{ value: "all", label: "Everything" }, { value: "server", label: `On ${pr.serverName}` }, { value: "shuttle", label: "Shuttle and agents" }]} /></div>
        <span className="flex-1" />
        <span className="text-xs text-muted-foreground">Newest first</span>
      </div>
      {items === undefined && <div className="mb-2 text-xs text-muted-foreground">Loading what happened on {pr.serverName}…</div>}
      {days.length === 0 && items !== undefined && <div className="text-sm text-muted-foreground">Nothing here yet.</div>}
      {days.map(({ day, entries: list }) => (
        <section key={day} aria-label={day} className="mb-3">
          <h4 className="mb-1.5 text-xs font-semibold text-muted-foreground">{day}</h4>
          <ol className="ml-2.5 border-l border-border pl-5">
            {list.map((entry) => (
              <li key={entry.key} data-history-entry={entry.from} className="relative flex items-start gap-2.5 py-1 text-[13px] leading-[1.45]">
                <span className="absolute -left-[31px] top-0.5 flex size-[21px] items-center justify-center rounded-full border border-border bg-background">
                  <Icon name={entry.icon} fallback="Circle" className={`size-3 ${TONE_ICON[entry.tone]}`} aria-hidden />
                </span>
                <span className="min-w-0 flex-1 break-words">
                  {entry.text}
                  <span className={`ml-1.5 whitespace-nowrap rounded border px-1 align-[1px] text-[10.5px] ${entry.from === "shuttle" ? "border-border bg-surface-raised text-foreground" : "border-border text-muted-foreground"}`}>
                    {entry.from === "shuttle" ? "Shuttle" : pr.serverName}
                  </span>
                  {entry.threadId !== null && (
                    <button type="button" className="ml-2 cursor-pointer text-xs text-muted-foreground hover:text-foreground hover:underline" onClick={() => actions.openThread(entry.threadId!)}>Open thread</button>
                  )}
                </span>
                <time dateTime={new Date(entry.at).toISOString()} title={new Date(entry.at).toLocaleString()} className="shrink-0 text-xs text-muted-foreground">
                  {new Date(entry.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                </time>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
