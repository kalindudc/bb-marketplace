import { ThreadChat, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { ControlAction, rpcContract } from "../contract";
import { BUTTON, CARD, ConfirmButton, StateBadge, mergeLabel, plural, useRemote, useRun } from "./common";

const SHOWN_TICKETS = 5;

/** bb's chat for the planner thread. It needs a bounded parent to scroll inside the page. */
export function PlannerChat({ threadId }: { threadId: string }) {
  return (
    <div className="h-[70vh] min-h-96">
      <ThreadChat threadId={threadId} variant="compact" layout="contained" />
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
      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <PlannerChat threadId={threadId} />
        <div className="content-start">
          {session.slug === null ? <p className={`${CARD} text-sm text-muted-foreground`}>No draft yet: the planner proposes a spec here when your answers are in.</p> : <DraftCard slug={session.slug} go={go} />}
        </div>
      </div>
    </div>
  );
}

function DraftCard({ slug, go }: { slug: string; go(subPath: string): void }) {
  const rpc = useRpc<typeof rpcContract>();
  const remote = useRemote((client) => client.call("project", { slug }), `project:${slug}`, slug);
  const { busy, error, run } = useRun();
  const view = remote.data;
  if (view === null) {
    return remote.error === null ? <p role="status" className="text-sm text-muted-foreground">Loading the draft…</p> : <p role="alert" className="text-sm text-destructive-text">Could not load {slug}: {remote.error}</p>;
  }
  const { overview, spec } = view;
  const { summary } = spec;
  const control = (action: ControlAction) => void run(async () => remote.set(await rpc.call("control", { slug, action, confirm: true })));
  const facts = [plural(summary.tickets.length, "ticket"), summary.checks.length === 0 ? "no checks" : `checks: ${summary.checks.join(", ")}`, ...(summary.reviewer === null ? [] : [`reviewer ${summary.reviewer}`])];

  return (
    <section data-draft-card className={`${CARD} space-y-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">{overview.name}</h2>
        <span className="text-xs text-muted-foreground">{overview.key}</span>
        <StateBadge state={overview.state} />
        <span className="text-xs text-muted-foreground">{mergeLabel(overview)}</span>
      </div>
      <p className="text-xs text-muted-foreground">{facts.join(" · ")}</p>
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
      {summary.warnings.length > 0 && (
        <ul data-draft-warnings className="space-y-1 text-xs text-warning-text">
          {summary.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">Read the spec</summary>
        <pre className="mt-2 overflow-x-auto rounded-md border border-border-seam p-3 text-xs leading-relaxed">{spec.toml}</pre>
      </details>
      {error !== null && <p role="alert" className="text-xs text-destructive-text">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {overview.state === "draft" && <ConfirmButton label="Approve" disabled={busy} onConfirm={() => control("approve")} />}
        {overview.state === "ready" && <ConfirmButton label="Start" disabled={busy} onConfirm={() => control("start")} />}
        <button type="button" className={BUTTON} onClick={() => go(slug)}>
          Open project
        </button>
      </div>
    </section>
  );
}
