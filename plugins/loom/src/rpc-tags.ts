// Which page reads each change refreshes, through bb's tagged query cache. The server contract and the page's zod-free
// copy of it (ui/contract-client.ts) both spread these, so the two cannot disagree.
import type { PlannerView } from "./planner-view";
import type { ThreadInfo, TicketDetail } from "./contract";

/** Every read that is not of one project: home, planning, the badge, bb's projects. */
export const ANY = "loom";
export const projectTag = (slug: string) => `project:${slug}`;
/** What a change to one project refreshes, or, with null, a change outside any project. Project reads stay as they are when another project changes. */
export const changedTags = (slug: string | null): string[] => (slug === null ? [ANY] : [projectTag(slug), ANY]);

const anything = () => [ANY];
// A rewound read is of a moment that has passed, so no change refreshes it.
const live = ({ slug, at }: { slug: string; at?: number }) => (at === undefined ? [projectTag(slug)] : []);
const ofProject = ({ slug }: { slug: string }) => [projectTag(slug)];
const changesProject = ({ slug }: { slug: string }) => changedTags(slug);
// Before its planner proposes, a thread belongs to no project, and the project it proposes is a change of ANY's.
const ofThread = (slug: string | null | undefined) => (slug === null || slug === undefined ? [ANY] : [projectTag(slug)]);

export const RPC_TAGS = {
  projects: { tags: anything },
  home: { tags: anything },
  badge: { tags: anything },
  project: { tags: live },
  ticket: { tags: ({ at }: { at?: number }, view: TicketDetail) => (at === undefined ? [projectTag(view.slug)] : []) },
  runOutput: {},
  insights: { tags: live },
  timeline: { tags: ofProject },
  threadInfo: { tags: (_: unknown, info: ThreadInfo | null) => ofThread(info?.slug) },
  reply: { invalidates: (_: unknown, view: TicketDetail) => changedTags(view.slug) },
  ticketAction: { invalidates: (_: unknown, view: TicketDetail) => changedTags(view.slug) },
  control: { invalidates: changesProject },
  sendNotes: { invalidates: changesProject },
  planning: { tags: anything },
  planningSession: { tags: anything },
  plannerView: { tags: (_: unknown, view: PlannerView | null) => ofThread(view?.slug) },
  messagePlanner: { invalidates: (_: unknown, view: PlannerView | null) => changedTags(view?.slug ?? null) },
  dismissAsk: { invalidates: changesProject },
  bbProjects: { tags: anything },
  startPlanning: { invalidates: anything },
  specVersion: { tags: ofProject },
  changes: { tags: ofProject },
  changePatch: {},
} as const;
