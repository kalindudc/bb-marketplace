import { useEffect, useState } from "react";
import { toast } from "sonner";
import { experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { AgentMode, PrView } from "../contract";
import { useActions } from "./actions";
import { BUTTON, BUTTON_PRIMARY, Choice, Dialog, ErrorNote, FIELD, LABEL, Segmented, ServerBadge } from "./common";
import { AGENT_MODE_META, ROLE_LABELS } from "./constants";
import { messageOf, useShuttleMutation, useShuttleQuery, type Output } from "./data";
import { ago, shortKey } from "./format";

export interface LinkRequest {
  pr: PrView;
  tab: "existing" | "new";
}

const SEARCH_DELAY_MS = 200;

/**
 * What a linked thread is for. On your own PR it can be the agent, which gets the PR's feedback; on someone else's it
 * can be a review thread. Either way it can be linked only for reference.
 */
type Purpose = "agent" | "review" | "reference";
type AgentWork = Exclude<AgentMode, "off">;
const AGENT_WORK = (["fix", "notify"] as const).map((value) => ({ value, label: AGENT_MODE_META[value].label, icon: AGENT_MODE_META[value].icon }));
const PURPOSES: Record<Purpose, { title: string; hint: string }> = {
  agent: { title: "Agent", hint: "It gets the PR's new reviews, comments and failed checks." },
  review: { title: "Review", hint: "A thread reviewing this PR, such as an AI review. A review draft it hands back shows in Your review." },
  reference: { title: "Reference only", hint: "Linked so you can find it from the PR. It gets nothing sent." },
};

function TabButton({ on, onClick, children }: { on: boolean; onClick(): void; children: string }) {
  return (
    <button type="button" role="tab" aria-selected={on} onClick={onClick}
      className={`-mb-px cursor-pointer border-b-2 px-2.5 py-1.5 text-sm ${on ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
      {children}
    </button>
  );
}

export function ProjectSelect({ projects, value, onChange }: { projects: Output<"projects"> | undefined; value: string; onChange(id: string): void }) {
  return (
    <select aria-label="Project" className={`${FIELD} w-full`} value={value} onChange={(event) => onChange(event.target.value)} disabled={projects === undefined}>
      <option value="">Let Shuttle pick: the project whose remote matches, or its default</option>
      {projects?.projects.map((project) => (
        <option key={project.id} value={project.id}>
          {project.name}{project.id === projects.suggested ? " (its remote matches the repository)" : ""}
        </option>
      ))}
    </select>
  );
}

export function LinkDialog({ request, onClose }: { request: LinkRequest; onClose(): void }) {
  const { pr } = request;
  const navigate = useBbNavigate();
  const { writes } = useActions();
  const link = useShuttleMutation("link");
  const newThread = useShuttleMutation("newThread");
  const [giving, setGiving] = useState(false);
  const busy = link.isPending || newThread.isPending || giving;
  const [tab, setTab] = useState(request.tab);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);
  const threadsQuery = useShuttleQuery("threads", search === "" ? {} : { query: search }, tab === "existing");
  const threads = threadsQuery.data?.threads;
  const projects = useShuttleQuery("projects", { key: pr.key });
  const [picked, setPicked] = useState<string | null>(null);
  const purposes: readonly Purpose[] = pr.mine ? ["agent", "reference"] : ["review", "reference"];
  const [purpose, setPurpose] = useState<Purpose>(pr.mine && pr.agent === null ? "agent" : "reference");
  const [work, setWork] = useState<AgentWork>(pr.agent !== null && pr.agent.mode !== "off" ? pr.agent.mode : "fix");
  const [projectChoice, setProjectChoice] = useState<string | null>(null);
  const projectId = projectChoice ?? projects.data?.suggested ?? "";
  const [start, setStart] = useState<"own" | "review">(pr.mine ? "own" : "review");
  const projectName = (id: string | null) => (id === null ? null : projects.data?.projects.find((project) => project.id === id)?.name ?? null);
  const linkedRole = (threadId: string) => pr.links.find((link) => link.threadId === threadId)?.role ?? null;

  const submit = async () => {
    if (tab === "existing") {
      const thread = threads?.find((item) => item.id === picked);
      if (!thread) return;
      if (purpose === "agent") {
        // The agent picker's own write, so the feedback already on the PR goes to the thread now and Undo works.
        setGiving(true);
        const given = await writes.giveAgent(pr, { kind: "existing", threadId: thread.id }, work);
        setGiving(false);
        if (given !== null) onClose();
        return;
      }
      const linked = await link.run({ key: pr.key, threadId: thread.id, role: purpose });
      if (linked === null) return;
      toast.success(`Linked ${shortKey(pr)} to “${thread.title}”`);
      onClose();
      return;
    }
    const started = await newThread.run({ key: pr.key, start, ...(projectId === "" ? {} : { projectId }) });
    if (started === null) return;
    toast.success(start === "own" ? (pr.mine ? "Started a thread that is this PR's agent" : "Started a thread that works on this PR") : "Started a review thread", {
      action: { label: "Open", onClick: () => navigate.toThread(started.threadId) },
    });
    onClose();
  };

  const canSubmit = !busy && (tab === "new" || (picked !== null && threads?.some((item) => item.id === picked) === true));
  return (
    <Dialog
      title={`Link ${shortKey(pr)} to a thread`}
      leading={<ServerBadge name={pr.serverName} />}
      subtitle={pr.title}
      onClose={onClose}
      footer={(
        <>
          <span className="flex-1 text-xs text-muted-foreground">Linking writes nothing to the PR.</span>
          <button type="button" className={BUTTON} onClick={onClose}>Cancel</button>
          <button type="button" className={BUTTON_PRIMARY} disabled={!canSubmit} onClick={() => void submit()}>{tab === "existing" ? "Link" : "Start thread"}</button>
        </>
      )}
    >
      <div role="tablist" className="mb-3 flex gap-1 border-b border-border">
        <TabButton on={tab === "existing"} onClick={() => setTab("existing")}>An existing thread</TabButton>
        <TabButton on={tab === "new"} onClick={() => setTab("new")}>A new thread</TabButton>
      </div>
      {tab === "existing" ? (
        <>
          <label className="mb-2 flex items-center gap-2 rounded-md border border-border bg-background px-2">
            <Icon name="Search" className="size-4 text-muted-foreground" aria-hidden />
            <input aria-label="Search threads" placeholder="Search threads by title" value={query} onChange={(event) => setQuery(event.target.value)}
              className="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none" />
          </label>
          {threadsQuery.error !== null && <ErrorNote>Could not list threads: {messageOf(threadsQuery.error)}</ErrorNote>}
          {threads === undefined && threadsQuery.error === null && <div className="py-3 text-sm text-muted-foreground">Loading threads…</div>}
          {threads?.length === 0 && <div className="py-3 text-sm text-muted-foreground">No thread matches.</div>}
          <div role="radiogroup" aria-label="Thread" className="flex max-h-72 flex-col gap-1 overflow-y-auto">
            {threads?.map((thread) => {
              const on = picked === thread.id;
              const already = linkedRole(thread.id);
              return (
                <button key={thread.id} type="button" role="radio" aria-checked={on} onClick={() => setPicked(thread.id)}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-sm ${on ? "border-surface-selected-border bg-surface-selected" : "border-border hover:bg-state-hover"}`}>
                  <span className={`size-4 shrink-0 rounded-full border ${on ? "border-[5px] border-foreground" : "border-border"}`} aria-hidden />
                  <Icon name="MessageSquare" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {[projectName(thread.projectId), thread.updatedAt === null ? null : ago(thread.updatedAt)].filter(Boolean).join(" · ")}
                  </span>
                  {already !== null && <span className="shrink-0 rounded-full border border-border px-1.5 text-[10.5px] text-muted-foreground">linked: {ROLE_LABELS[already].short.toLowerCase()}</span>}
                  <span className="shrink-0 rounded-full border border-border px-1.5 text-[10.5px] text-muted-foreground">{thread.status}</span>
                </button>
              );
            })}
          </div>
          <div className={LABEL}>What it is for</div>
          <div role="radiogroup" aria-label="What it is for">
            {purposes.map((item) => (
              <Choice key={item} on={purpose === item} title={PURPOSES[item].title} onPick={() => setPurpose(item)}
                hint={item === "agent" && pr.agent !== null && picked !== null && picked !== pr.agent.threadId
                  ? `${PURPOSES.agent.hint} It takes over from “${pr.agent.title}”, which stays linked for reference.`
                  : PURPOSES[item].hint} />
            ))}
          </div>
          {purpose === "agent" && (
            <div className="mt-1">
              <Segmented label="What the agent does" value={work} options={AGENT_WORK} onChange={setWork} />
              <div className="mt-1.5 text-xs text-muted-foreground">{AGENT_MODE_META[work].sentence}</div>
            </div>
          )}
        </>
      ) : (
        <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-x-2 gap-y-3 text-sm">
          <span className="text-xs text-muted-foreground">Project</span>
          <ProjectSelect projects={projects.data} value={projectId} onChange={setProjectChoice} />
          <span className="text-xs text-muted-foreground">Start it to</span>
          <select aria-label="Start it to" className={FIELD} value={start} onChange={(event) => setStart(event.target.value as "own" | "review")}>
            <option value="own">{pr.mine ? "Be its agent: work on the PR and fix its feedback" : "Work on the PR"}</option>
            <option value="review">Start an AI review of it</option>
          </select>
          {projects.error !== null && <div className="col-span-2"><ErrorNote>Could not list projects: {messageOf(projects.error)}</ErrorNote></div>}
        </div>
      )}
    </Dialog>
  );
}
