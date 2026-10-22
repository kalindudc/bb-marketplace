import type { ReactNode } from "react";
import { ThreadChat, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { ControlAction, NextStep, ProjectView, rpcContract } from "../contract";
import { BUTTON, CARD, HEADING, RepoChip, StateBadge, mergeLabel, plural, useRemote, useRun } from "./common";
import { NextStepBar } from "./next-step-bar";
import { PlannerQuestions } from "./questions";
import { SpecDashboard, bbProjectNamesOf } from "./spec-dashboard";

const SHOWN_TICKETS = 5;
const PLANNING: NextStep = { stage: 0, tone: "normal", title: "Next: answer the planner.", text: "It asks about the goal in the chat, then proposes a draft here.", action: null };

/** bb's chat for the planner thread, below the questions it leaves out. It needs a bounded parent to scroll inside the page. */
export function PlannerChat({ threadId }: { threadId: string }) {
  return (
    <div className="space-y-3">
      <PlannerQuestions threadId={threadId} />
      <div className="h-[70vh] min-h-96">
        <ThreadChat threadId={threadId} variant="compact" layout="contained" />
      </div>
    </div>
  );
}

/** A planning conversation started from the page: the planner's chat beside its draft, once it proposed one. */
export function PlanningView({ threadId, go }: { threadId: string; go(subPath: string): void }) {
  const navigate = useBbNavigate();
  // Wrapped, so a thread that is not a planning thread (null) is told apart from one still loading.
  const remote = useRemote((rpc) => rpc.call("planningSession", { threadId }).then((session) => ({ session })), `planning:${threadId}`, null);
  if (remote.data === null) {
    return remote.error === null ? <p role="status" className="p-4 text-sm text-muted-foreground">Loading…</p> : <p role="alert" className="p-4 text-sm text-destructive-text">Could not load the conversation: {remote.error}</p>;
  }
  const { session } = remote.data;
  if (session === null) return <p className="p-4 text-sm text-muted-foreground">This thread is not a Loom planning thread.</p>;

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-sm font-semibold">{session.title}</h1>
        <button type="button" className={`${BUTTON} ml-auto`} onClick={() => navigate.toThread(threadId)}>
          Open as thread
        </button>
      </div>
      {session.slug === null ? (
        <>
          <NextStepBar next={PLANNING} busy={false} onAct={() => undefined} />
          <Columns threadId={threadId} side={<p className={`${CARD} text-sm text-muted-foreground`}>No draft yet: the planner proposes a spec here when your answers are in.</p>} />
        </>
      ) : (
        <Drafted slug={session.slug} threadId={threadId} go={go} />
      )}
    </div>
  );
}

function Columns({ threadId, side }: { threadId: string; side: ReactNode }) {
  return (
    <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
      <PlannerChat threadId={threadId} />
      <div className="content-start">{side}</div>
    </div>
  );
}

/** A conversation that proposed: the next-step bar carries Approve and then Start, over the chat and the draft card, then the spec's dashboard. */
function Drafted({ slug, threadId, go }: { slug: string; threadId: string; go(subPath: string): void }) {
  const rpc = useRpc<typeof rpcContract>();
  const remote = useRemote((client) => client.call("project", { slug }), `project:${slug}`, slug);
  const { busy, error, run } = useRun();
  const view = remote.data;
  const control = (action: ControlAction, version?: number) =>
    void run(async () => remote.set(await rpc.call("control", { slug, action, ...(version === undefined ? {} : { version }), confirm: true })));
  const side =
    view !== null ? (
      <DraftCard view={view} error={error} go={go} />
    ) : remote.error === null ? (
      <p role="status" className="text-sm text-muted-foreground">Loading the draft…</p>
    ) : (
      <p role="alert" className="text-sm text-destructive-text">Could not load {slug}: {remote.error}</p>
    );
  return (
    <>
      {view?.next != null && <NextStepBar next={view.next} busy={busy} repos={view.overview.repos} onAct={control} />}
      <Columns threadId={threadId} side={side} />
      <SpecDashboard slug={slug} bbProjectNames={bbProjectNamesOf(view)} />
    </>
  );
}

function DraftCard({ view, error, go }: { view: ProjectView; error: string | null; go(subPath: string): void }) {
  const { overview, spec } = view;
  const { summary } = spec;
  const facts = [plural(summary.tickets.length, "ticket"), ...(summary.repos.length === 0 ? [] : [plural(summary.repos.length, "repo")]), summary.checks.length === 0 ? "no checks" : `checks: ${summary.checks.join(", ")}`, ...(summary.reviewer === null ? [] : [`reviewer ${summary.reviewer}`])];

  return (
    <section data-draft-card className={`${CARD} space-y-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">{overview.name}</h2>
        <span className="text-xs text-muted-foreground">{overview.key}</span>
        <StateBadge state={overview.state} />
        <span className="text-xs text-muted-foreground">{mergeLabel(overview)}</span>
      </div>
      <p className="text-xs text-muted-foreground">{facts.join(" · ")}</p>
      {summary.repos.length > 0 && (
        <div data-draft-repos className="space-y-1">
          <h3 className={HEADING}>Repos</h3>
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {summary.repos.map((repo) => (
              <li key={repo.name} data-draft-repo={repo.name} className="inline-flex min-w-0 items-center gap-1">
                <RepoChip name={repo.name} />
                <span className={repo.bbProjectName === null ? "font-mono [overflow-wrap:anywhere]" : ""}>{repo.bbProjectName ?? repo.bbProjectId}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <table className="w-full text-sm">
        <tbody>
          {summary.tickets.slice(0, SHOWN_TICKETS).map((ticket) => (
            <tr key={ticket.ref} data-draft-ticket>
              <td className="py-0.5 pr-3 align-top text-xs text-muted-foreground">{ticket.ref}</td>
              <td className="py-0.5 pr-3">{ticket.title}</td>
              <td className="py-0.5 text-xs text-muted-foreground">{ticket.dependsOn.length === 0 ? "" : `after ${ticket.dependsOn.join(", ")}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {summary.tickets.length > SHOWN_TICKETS && <p className="text-xs text-muted-foreground">+{summary.tickets.length - SHOWN_TICKETS} more</p>}
      {error !== null && <p role="alert" className="text-xs text-destructive-text">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BUTTON} onClick={() => go(overview.slug)}>
          Open project
        </button>
      </div>
    </section>
  );
}
