import { useEffect, useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { AgentMode, AgentView, PrView } from "../contract";
import { useActions } from "./actions";
import { BUTTON, BUTTON_GHOST, BUTTON_PRIMARY, Choice, Dialog, ErrorNote, LABEL, Pill, Segmented } from "./common";
import { AGENT_MODE_META } from "./constants";
import { messageOf, useShuttleQuery } from "./data";
import { ago, tinyKey } from "./format";
import { isLive } from "./pills";

const MODES = (["fix", "notify", "off"] as const).map((value) => ({ value, label: AGENT_MODE_META[value].label, icon: AGENT_MODE_META[value].icon }));
const NEW_MODES = MODES.filter((mode): mode is (typeof MODES)[number] & { value: "fix" | "notify" } => mode.value !== "off");

function StatusPill({ agent }: { agent: AgentView }) {
  if (agent.mode === "off") return null;
  if (agent.status === "waiting") return <Pill tone="warn">Waiting on you</Pill>;
  if (agent.status === "working") return <Pill tone="info">Working</Pill>;
  if (agent.status === "idle") return <Pill>Idle</Pill>;
  if (agent.status === "archived") return <Pill tone="warn" icon="Archive">Archived</Pill>;
  return null;
}

/** Who handles new reviews and failed checks on a PR: a thread and what it is asked to do, or nobody. */
export function AgentCard({ pr }: { pr: PrView }) {
  const actions = useActions();
  if (!isLive(pr)) return null;
  const agent = pr.agent;
  return (
    <section aria-label="Agent" data-agent-card className="mx-4 mt-3 rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm font-semibold">
        <Icon name="Bot" className="size-4" aria-hidden />
        Agent
        <span className="truncate text-xs font-normal text-muted-foreground">who handles new reviews and failed checks</span>
      </div>
      <div className="px-3 py-2.5">
        {agent === null ? (
          <>
            <div className="mb-2 text-sm text-muted-foreground">No agent. New feedback on this PR waits in your Inbox.</div>
            {pr.suggestedAgent !== null && (
              <div data-suggested-agent className="mb-2 flex items-center gap-2.5 rounded-lg border border-primary/70 bg-primary/5 px-3 py-2">
                <span aria-hidden className="size-3.5 shrink-0 rounded-full border-4 border-primary" />
                <span className="min-w-0 flex-1">
                  <b className="block truncate text-sm">{pr.suggestedAgent.title}</b>
                  <span className="block text-xs text-muted-foreground">{pr.suggestedAgent.why}</span>
                </span>
                <button type="button" className={BUTTON_PRIMARY}
                  onClick={() => void actions.writes.giveAgent(pr, { kind: "existing", threadId: pr.suggestedAgent!.threadId })}>Use it</button>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <button type="button" className={BUTTON} onClick={() => actions.pickAgent(pr)}>
                <Icon name="MessageSquare" className="size-3.5" aria-hidden />Pick a thread…
              </button>
              <button type="button" className={BUTTON} onClick={() => actions.pickAgent(pr, "new")}>
                <Icon name="Plus" className="size-3.5" aria-hidden />New thread for this PR
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="mb-2 flex items-center gap-2">
              <Icon name="MessageSquare" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <b className="min-w-0 flex-1 truncate text-sm" title={agent.title}>{agent.title}</b>
              <StatusPill agent={agent} />
              <button type="button" className={BUTTON} onClick={() => actions.openThread(agent.threadId)}>Open</button>
              <button type="button" className={BUTTON_GHOST} onClick={() => actions.pickAgent(pr)}>Change</button>
            </div>
            <Segmented label="What the agent does" value={agent.mode} options={MODES} onChange={(mode) => void actions.writes.changeMode(pr, mode)} />
            <div className="mt-1.5 text-xs text-muted-foreground">{AGENT_MODE_META[agent.mode].sentence}</div>
            {(agent.lastSent !== null || agent.auto) && (
              <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                <Icon name="Sent" className="size-3 shrink-0" aria-hidden />
                <span>
                  {agent.lastSent !== null && `Last: ${agent.lastSent.text}, ${ago(agent.lastSent.at)}`}
                  {agent.lastSent !== null && agent.auto && " · "}
                  {agent.auto && "picked automatically"}
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

const NEW = "new";
const SEARCH_DELAY_MS = 200;

/** Pick the thread that handles a PR's feedback: the one that opened it, a recent one, or a new one. */
export function AgentDialog({ pr, start, onClose }: { pr: PrView; start?: "new"; onClose(): void }) {
  const { writes } = useActions();
  const [picked, setPicked] = useState<string | null>(start === NEW ? NEW : pr.suggestedAgent?.threadId ?? pr.agent?.threadId ?? null);
  const [mode, setMode] = useState<Exclude<AgentMode, "off">>(pr.agent !== null && pr.agent.mode !== "off" ? pr.agent.mode : "fix");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);
  const threads = useShuttleQuery("threads", search === "" ? {} : { query: search });
  const known = new Set([pr.suggestedAgent?.threadId, pr.agent?.threadId].filter((id): id is string => id !== undefined));
  const recent = (threads.data?.threads ?? []).filter((thread) => !known.has(thread.id)).slice(0, 6);

  const submit = async () => {
    if (picked === null) return;
    setBusy(true);
    const out = await writes.giveAgent(pr, picked === NEW ? { kind: "new" } : { kind: "existing", threadId: picked }, mode);
    setBusy(false);
    if (out !== null) onClose();
  };

  return (
    <Dialog title={`Who handles feedback on ${tinyKey(pr)}?`} leading={<Icon name="Bot" className="size-4" aria-hidden />} onClose={onClose}
      footer={(
        <>
          <span className="flex-1" />
          <button type="button" className={BUTTON_GHOST} onClick={onClose}>Cancel</button>
          <button type="button" className={BUTTON_PRIMARY} disabled={picked === null || busy} onClick={() => void submit()}>
            <Icon name="Bot" className="size-3.5" aria-hidden />Give it this agent
          </button>
        </>
      )}>
      <div className={`${LABEL} mt-0`}>Thread</div>
      <div role="radiogroup" aria-label="Thread">
        {pr.suggestedAgent !== null && (
          <Choice on={picked === pr.suggestedAgent.threadId} title={pr.suggestedAgent.title} hint={pr.suggestedAgent.why} onPick={() => setPicked(pr.suggestedAgent!.threadId)} />
        )}
        {pr.agent !== null && pr.agent.threadId !== pr.suggestedAgent?.threadId && (
          <Choice on={picked === pr.agent.threadId} title={pr.agent.title} hint="Its agent now" onPick={() => setPicked(pr.agent!.threadId)} />
        )}
        <label className="mb-1.5 flex items-center gap-2 rounded-md border border-border bg-background px-2">
          <Icon name="Search" className="size-3.5 text-muted-foreground" aria-hidden />
          <input aria-label="Search threads" placeholder="Search recent threads" value={query} onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none placeholder:text-muted-foreground" />
        </label>
        {threads.error !== null && <ErrorNote>Could not list threads: {messageOf(threads.error)}</ErrorNote>}
        {threads.data === undefined && threads.error === null && <div className="py-2 text-xs text-muted-foreground">Loading threads…</div>}
        {recent.map((thread) => (
          <Choice key={thread.id} on={picked === thread.id} title={thread.title} hint={thread.updatedAt === null ? "Recent thread" : `Recent thread · ${ago(thread.updatedAt)}`} onPick={() => setPicked(thread.id)} />
        ))}
        <Choice on={picked === NEW} title="A new thread for this PR" hint={`In the project whose remote matches ${pr.repo}, on the PR's branch`} onPick={() => setPicked(NEW)} />
      </div>
      <div className={LABEL}>What it does</div>
      <Segmented label="What it does" value={mode} options={NEW_MODES} onChange={setMode} />
      <div className="mt-1.5 text-xs text-muted-foreground">
        {mode === "fix"
          ? "The thread gets each new review, comment and failed check, and is asked to fix them. It asks you before it pushes or replies."
          : "The thread gets each new review, comment and failed check, and is not asked to act."}
      </div>
    </Dialog>
  );
}
