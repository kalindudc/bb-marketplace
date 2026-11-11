// The Needs you queue on the page: the server's items (home.ts) and the Loom threads bb shows waiting on the human, in one
// order. Home draws it, and the sidebar's Home count and the rail badge count it, so the three never disagree.
import { useEffect, useMemo, useRef, useState } from "react";
import { experimental_useSidebarThreads, useSdk } from "@get-bb/plugin-sdk/app";
import type { HomeView, NeedItem, NeedKind, WaitableThread } from "../contract";
import { formatDuration } from "../format";
import { queueOrder } from "../home-order";
import { projectViews, type View } from "./views";

export type QueueKind = NeedKind | "question";

/** One item of the queue. A question has no slug when its thread is a planning conversation without a project yet. */
export type QueueItem = Omit<NeedItem, "kind" | "slug"> & { kind: QueueKind; slug: string | null; threadId: string | null; role: WaitableThread["role"] | null };

// bb's own icon names: a name it does not ship falls back to its generic glyph.
export const QUEUE_ICON: Record<QueueKind, string> = {
  blocked: "AlertCircle",
  failed: "CircleX",
  approve: "FileText",
  pending: "FileText",
  ask: "MessageQuestion",
  land: "GitPullRequestArrow",
  paused: "Pause",
  merge: "GitMerge",
  draft: "GitPullRequestDraft",
  wrongBase: "GitBranch",
  rollout: "AlertTriangle",
  question: "MessageSquare",
};

/** The queue row's state word. */
export const QUEUE_WORD: Record<QueueKind, string> = {
  blocked: "Blocked",
  failed: "Failed",
  approve: "Draft",
  pending: "Pending",
  ask: "Planner asks",
  land: "Ready to land",
  paused: "Paused by Loom",
  merge: "Confirm merge",
  draft: "Held draft",
  wrongBase: "Wrong branch",
  rollout: "Warnings",
  question: "Questions",
};

/** The project view that answers an item which opens its project; null for one that opens a ticket, a thread or acts in place. */
const QUEUE_VIEW: Record<QueueKind, View | null> = { blocked: null, failed: "work", approve: "spec", pending: "spec", ask: "planner", land: "ship", paused: "work", merge: "ship", draft: "ship", wrongBase: "ship", rollout: "ship", question: "planner" };

/** Items the queue answers in place, in a reader under the row: the rest open the page that answers them. */
export const IN_PLACE: readonly QueueKind[] = ["paused", "ask", "merge", "draft", "wrongBase", "rollout"];

/** Where an item opens: a ticket's own page, a planning conversation, or its project on the view that answers it; null for a worker's or reviewer's thread, which opens in bb. */
export function needRoute(item: Pick<QueueItem, "kind" | "slug" | "key" | "threadId" | "role">): string | null {
  if (item.kind === "question" && item.slug === null) return item.threadId === null ? "_home" : `_plan/${item.threadId}`;
  if (item.kind === "question" && item.role !== "planner") return null;
  if (item.slug === null) return "_home";
  if ((item.kind === "blocked" || item.kind === "failed") && item.key !== null) return `${item.slug}/${item.key}`;
  const view = QUEUE_VIEW[item.kind];
  if (view !== null) projectViews.put(item.slug, view);
  return item.slug;
}

/** "4d 2h"; "age unknown" when Loom does not record when the need began. */
export const ageText = (startedAt: number | null, now: number) => (startedAt === null ? "age unknown" : formatDuration(Math.max(0, now - startedAt)));

const fromNeed = (need: NeedItem): QueueItem => ({ ...need, threadId: null, role: null });

/** A thread bb shows waiting on the human, as a queue item; `asked` is when its oldest open interaction was made, if read. */
export function questionItem(thread: WaitableThread, asked: { at: number; count: number } | null): QueueItem {
  const planner = thread.role === "planner" || thread.role === "planning";
  return {
    id: `question:${thread.threadId}`,
    kind: "question",
    slug: thread.slug,
    project: thread.project,
    projectKey: thread.projectKey ?? "Planning",
    key: thread.key,
    keys: thread.key === null ? [] : [thread.key],
    title: planner ? (thread.slug === null ? thread.project : "The planner asks") : `${thread.key ?? "A ticket"}'s ${thread.role} asks`,
    text: asked === null || asked.count <= 1 ? "waits for your answer" : `${asked.count} rounds wait for your answer`,
    startedAt: asked?.at ?? null,
    sources: ["thread waits on you in bb"],
    unblocks: null,
    meanwhile: "The thread waits; nothing else stops.",
    clears: "Clears when you answer it, or stop the thread's turn in bb.",
    version: null,
    ask: null,
    prUrl: null,
    sha: null,
    ackItems: [],
    budget: false,
    threadId: thread.threadId,
    role: thread.role,
  };
}

/** The server's items and the waiting threads in the queue's order: oldest first, then those of unknown age, newest project first. */
export function queueOf(home: HomeView, waiting: ReadonlySet<string>, asked: ReadonlyMap<string, { at: number; count: number }>): QueueItem[] {
  const questions = home.threads.filter((thread) => waiting.has(thread.threadId)).map((thread) => questionItem(thread, asked.get(thread.threadId) ?? null));
  const created = new Map(home.projects.map((project) => [project.slug, project.createdAt]));
  return queueOrder([...home.needsYou.map(fromNeed), ...questions], (slug) => created.get(slug) ?? 0);
}

/** The Loom threads bb's sidebar shows waiting on a question or an approval. */
export function useWaitingThreads(home: HomeView | undefined): Set<string> {
  const { threads } = experimental_useSidebarThreads();
  const ids = home?.threads.map((thread) => thread.threadId).join(" ") ?? "";
  return useMemo(() => {
    const ours = new Set(ids === "" ? [] : ids.split(" "));
    return new Set(threads.filter((thread) => thread.hasPendingInteraction && ours.has(thread.id)).map((thread) => thread.id));
  }, [threads, ids]);
}

/** When each waiting thread's oldest open interaction was made, read from bb once per change of the waiting set. */
function useAsked(waiting: ReadonlySet<string>): Map<string, { at: number; count: number }> {
  const sdk = useSdk();
  const latest = useRef(sdk);
  latest.current = sdk;
  const key = [...waiting].sort().join(" ");
  const [asked, setAsked] = useState(() => new Map<string, { at: number; count: number }>());
  useEffect(() => {
    if (key === "") return setAsked(new Map());
    let live = true;
    void Promise.all(
      key.split(" ").map((threadId) =>
        Promise.resolve()
          .then(() => latest.current.threads.interactions.list({ threadId }))
          .then((rows) => {
            const open = rows.filter((row) => row.status === "pending");
            return open.length === 0 ? null : ([threadId, { at: Math.min(...open.map((row) => row.createdAt)), count: open.length }] as const);
          })
          .catch(() => null),
      ),
    ).then((entries) => live && setAsked(new Map(entries.filter((entry) => entry !== null))));
    return () => {
      live = false;
    };
  }, [key]);
  return asked;
}

/** Home's queue: undefined until home has loaded. */
export function useQueue(home: HomeView | undefined): QueueItem[] | undefined {
  const waiting = useWaitingThreads(home);
  const asked = useAsked(waiting);
  return useMemo(() => (home === undefined ? undefined : queueOf(home, waiting, asked)), [home, waiting, asked]);
}

/** More than this many items shows the first ones and "N more". */
export const QUEUE_SHOWN = 6;
const FLOOD = { items: 10, ms: 10 * 60_000 };

/** "flood: 14 in 10 min" when more than ten items began in the last ten minutes; null otherwise. */
export function floodText(items: readonly QueueItem[], now: number): string | null {
  const recent = items.filter((item) => item.startedAt !== null && now - item.startedAt <= FLOOD.ms).length;
  return recent > FLOOD.items ? `flood: ${recent} in 10 min` : null;
}
