// Loom in bb's thread view: the header button that opens the thread's ticket on the Loom page, the context segment above
// the composer that names the ticket, its role and state and opens to where it stands, and the Loom tab in the side panel
// with the ticket itself (or, for a planner, what its project needs from you). Each shows only on Loom's threads.
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { experimental_Icon as Icon, useBbNavigate, type ExperimentalThreadContextSegmentProps, type PluginThreadActionDataInput, type PluginThreadActionItemInput, type PluginThreadAction } from "@get-bb/plugin-sdk/app";
import type { ThreadInfo } from "../contract";
import { BUTTON, useLoom } from "./common";
import { Queue } from "./home";
import { TipProvider } from "./kit";
import { STATE_WORDS } from "./groups";
import { useQueue } from "./needs";
import { useLoomTheme } from "./theme";
import { TicketView } from "./ticket";
import { summaryOf } from "./ticket-header";
import { threadsOfCounts, TicketBar, ticketsLabel } from "./ticket-bar";

const ROLES: Record<ThreadInfo["role"], string> = { planner: "planner", worker: "worker", reviewer: "reviewer" };

/** Where a Loom thread opens on the Loom page: its ticket, its project, or, before a spec exists, its planning conversation. */
export const subPathOf = (info: ThreadInfo, threadId: string) => (info.slug === null ? `_plan/${threadId}` : info.key === null ? info.slug : `${info.slug}/${info.key}`);

const stateText = (info: ThreadInfo) => (info.key === null ? info.state : (STATE_WORDS[info.state as keyof typeof STATE_WORDS] ?? info.state.replace("_", " ")));

/** "CSV-11 · blocked", "CSV" for a planner, "Planning" before a spec exists. */
export function buttonLabel(info: ThreadInfo): string {
  if (info.slug === null) return "Planning";
  if (info.key === null) return info.project?.key ?? info.slug;
  return `${info.key} · ${stateText(info)}`;
}

/** The header button's data: what Loom knows of every thread whose header is on screen, in one read. */
export function useThreadInfos({ threadIds }: PluginThreadActionDataInput): Record<string, ThreadInfo> {
  return useLoom("threadInfos", { threadIds: [...threadIds] }, { enabled: threadIds.length > 0, keep: true }).data ?? {};
}

/** The header button for a Loom thread; null for any other thread. */
export function threadButton({ thread, data, navigate }: PluginThreadActionItemInput<Record<string, ThreadInfo>>): PluginThreadAction | null {
  const info = data[thread.id];
  if (info === undefined) return null;
  return { label: buttonLabel(info), detail: info.slug === null ? "Open this planning conversation in Loom" : `Open ${info.key ?? info.project?.key ?? info.slug} in Loom`, icon: "loom/loom", run: () => navigate.toPluginPanel("loom", { subPath: subPathOf(info, thread.id) }) };
}

/** Whether a thread is Loom's, for the segment and the tab. */
export function useLoomThread({ threadId }: { threadId: string }): boolean {
  return (useLoom("threadInfo", { threadId }).data ?? null) !== null;
}

/** The context segment above a Loom thread's composer: its ticket, its role, its phase and the ticket's state; it opens where the ticket stands. */
export function LoomSegment({ threadId, isExpanded, onToggle }: ExperimentalThreadContextSegmentProps) {
  const info = useLoom("threadInfo", { threadId }).data ?? null;
  if (info === null) return null;
  const what = info.slug === null ? "Planning" : (info.key ?? info.project?.key ?? info.slug);
  const facts = [ROLES[info.role], info.phase === null ? null : `phase ${info.phase.index + 1} of ${info.phase.count}`, info.attempt !== null && info.attempt > 1 ? `attempt ${info.attempt}` : null].filter((fact): fact is string => fact !== null);
  const attention = info.state === "blocked";
  return (
    <button
      type="button"
      data-loom-segment
      aria-expanded={isExpanded}
      aria-label={`${what}, ${facts.join(", ")}, ${stateText(info)}`}
      title={`${what} · ${facts.join(" · ")} · ${stateText(info)}`}
      onClick={onToggle}
      // bb's slot can be narrower than the key and state together (a 1000 px window with Loom's side panel open): the
      // facts give way first, then the key and the state truncate, and nothing paints outside the button.
      className="inline-flex h-6 max-w-full min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-md px-1.5 text-xs text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-[576px]:h-11 pointer-coarse:h-11"
    >
      <Icon name="loom/loom" aria-hidden className="size-3.5 shrink-0" />
      <b data-segment-key className="min-w-0 shrink truncate font-semibold">{what}</b>
      <span data-segment-facts className="min-w-0 shrink-[40] truncate text-muted-foreground">{facts.join(" · ")}</span>
      <span data-segment-state className={`min-w-0 shrink truncate rounded px-1 font-semibold ${attention ? "bg-[var(--attention)] text-[var(--attention-foreground)]" : "border border-border text-muted-foreground"}`}>{stateText(info)}</span>
    </button>
  );
}

/** Under the segment, while it is open: where the ticket stands in one sentence, and the way to it on the Loom page. */
export function LoomSegmentDetails({ threadId, isExpanded }: ExperimentalThreadContextSegmentProps) {
  const navigate = useBbNavigate();
  const info = useLoom("threadInfo", { threadId }).data ?? null;
  const key = info?.key ?? null;
  const ticket = useLoom("ticket", { key: key ?? "" }, { enabled: isExpanded && key !== null }).data;
  if (!isExpanded || info === null) return null;
  const sentence = key === null ? (info.slug === null ? "The planner has not proposed a spec yet." : `The planner of ${info.project?.name ?? info.slug}; the project is ${info.state}.`) : ticket === undefined ? `Loading ${key}…` : ticket.state === "blocked" ? `Blocked: ${ticket.blockedReason ?? "it waits for an answer"}` : (summaryOf(ticket, Date.now()) ?? stateText(info));
  return (
    <div data-loom-segment-details className="flex min-w-0 flex-wrap items-center gap-2 px-2 py-1.5 text-xs">
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere] text-muted-foreground">{sentence}</span>
      <button type="button" onClick={() => navigate.toPluginPanel("loom", { subPath: subPathOf(info, threadId) })} className={BUTTON}>
        Open in Loom
      </button>
    </div>
  );
}

/** bb's phone panel is a drawer that moves Tab focus itself: it focuses the next of a[href], button, input, select,
 * textarea and [tabindex] outside [inert] and [aria-hidden], with preventScroll. In the tab that took focus below the fold
 * out of sight, stuck Tab on a button inside a closed <details> (it cannot take focus), and skipped every <summary>.
 * So whatever takes focus here is brought into view (WCAG 2.4.11), each summary carries tabindex 0, and a closed
 * details' body is inert, kept in step as the content and each details' open state change. */
export function useDrawerKeyboard(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = root.current;
    if (element === null) return;
    const onFocus = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const box = target.getBoundingClientRect();
      const port = element.getBoundingClientRect();
      if (box.top < port.top || box.bottom > port.bottom) target.scrollIntoView?.({ block: "nearest" });
    };
    const sync = () => {
      for (const details of element.querySelectorAll("details")) {
        const summary = details.querySelector(":scope > summary");
        if (summary !== null && !summary.hasAttribute("tabindex")) summary.setAttribute("tabindex", "0");
        for (const child of details.children) {
          if (child === summary) continue;
          if (details.open) child.removeAttribute("inert");
          else if (!child.hasAttribute("inert")) child.setAttribute("inert", "");
        }
      }
    };
    sync();
    const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(sync);
    observer?.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] });
    element.addEventListener("focusin", onFocus);
    return () => {
      observer?.disconnect();
      element.removeEventListener("focusin", onFocus);
    };
  }, [root]);
}

function Frame({ children }: { children: ReactNode }) {
  useLoomTheme();
  const root = useRef<HTMLDivElement>(null);
  useDrawerKeyboard(root);
  return (
    <TipProvider>
      <div ref={root} data-loom-root data-loom-thread-tab className="@container/loom h-full min-h-0 overflow-y-auto bg-background p-3 text-foreground">
        {children}
      </div>
    </TipProvider>
  );
}

/** The Loom tab beside a Loom thread: the worker's or reviewer's ticket as Work shows it, or the planner's project and what it needs from you. */
export function LoomThreadTab({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  const info = useLoom("threadInfo", { threadId });
  const go = (subPath: string) => navigate.toPluginPanel("loom", { subPath });
  if (info.data === undefined) {
    return <Frame>{info.error === null ? <p role="status" className="text-sm text-[var(--loom-muted)]">Loading…</p> : <p role="alert" className="text-sm text-[var(--loom-bad)]">Could not load Loom's view of this thread: {info.error}</p>}</Frame>;
  }
  if (info.data === null) return <Frame><p className="text-sm text-[var(--loom-muted)]">This thread is not one of Loom's.</p></Frame>;
  const data = info.data;
  const open = (
    <button type="button" className={`${BUTTON} @max-xl/loom:h-11 pointer-coarse:h-11`} onClick={() => go(subPathOf(data, threadId))}>
      Open in Loom
      <Icon name="ExternalLink" aria-hidden className="size-3.5" />
    </button>
  );
  return (
    <Frame>
      {/* One column that never grows past the panel: the name line truncates instead of widening the ticket below. */}
      <div className="grid grid-cols-1 gap-3">
        <p className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-[var(--loom-muted)]">
          <Icon name="loom/loom" aria-hidden className="size-3.5 shrink-0 text-foreground" />
          <span className="min-w-[min(100%,8rem)] flex-1 truncate" title={[data.project?.name ?? "Planning conversation", data.phase === null ? null : `phase ${data.phase.index + 1} of ${data.phase.count}, ${data.phase.title}`, ROLES[data.role]].filter((part) => part !== null).join(" · ")}>
            {data.project === null ? "Planning conversation" : <b className="text-foreground">{data.project.key}</b>} {data.project?.name}
            {data.phase !== null && ` · phase ${data.phase.index + 1} of ${data.phase.count}, ${data.phase.title}`}
            {` · ${ROLES[data.role]}`}
          </span>
          {open}
        </p>
        {data.key !== null ? <TicketView ticketKey={data.key} threads={false} /> : data.slug !== null ? <PlannerSide slug={data.slug} go={go} /> : <p className="text-sm text-[var(--loom-muted)]">The planner has not proposed a spec yet. Its questions show here in the chat, and on Home.</p>}
      </div>
    </Frame>
  );
}

/** A planner thread's tab: its project's ticket bar and what the project needs from you, answerable here. */
function PlannerSide({ slug, go }: { slug: string; go(subPath: string): void }) {
  const home = useLoom("home", null);
  const queue = useQueue(home.data);
  if (home.data === undefined || queue === undefined) return <p role="status" className="text-sm text-[var(--loom-muted)]">Loading {slug}…</p>;
  const project = home.data.projects.find((entry) => entry.slug === slug);
  if (project === undefined) return <p className="text-sm text-[var(--loom-muted)]">Loom has no project {slug}.</p>;
  const threads = threadsOfCounts(project.ticketCounts);
  const items = queue.filter((item) => item.slug === slug);
  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <TicketBar threads={threads} height={8} label={`${project.key}: ${ticketsLabel(threads)}`} className="flex-1" />
        <span className="loom-num text-xs font-semibold">
          {threads.filter((thread) => thread === "done").length}/{threads.length}
        </span>
      </div>
      <Queue items={items} now={home.data.now} projects={new Map([[project.slug, project]])} go={go} />
    </>
  );
}
