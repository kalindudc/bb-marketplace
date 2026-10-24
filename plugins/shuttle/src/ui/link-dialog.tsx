import { useEffect, useState } from "react";
import { toast } from "sonner";
import { experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { WatchMode } from "../config";
import type { LinkRole, PrView } from "../contract";
import { BUTTON, BUTTON_PRIMARY, Dialog, ErrorNote, FIELD, ServerBadge } from "./common";
import { LINK_ROLES, ROLE_LABELS } from "./constants";
import { messageOf, useShuttleMutation, useShuttleQuery, type Output } from "./data";
import { ago, shortKey } from "./format";

export interface LinkRequest {
  pr: PrView;
  tab: "existing" | "new";
  /** Turn watching on in this mode once the PR has an owner thread. */
  watchAfter: WatchMode | null;
}

const SEARCH_DELAY_MS = 200;

function TabButton({ on, onClick, children }: { on: boolean; onClick(): void; children: string }) {
  return (
    <button type="button" role="tab" aria-selected={on} onClick={onClick}
      className={`-mb-px cursor-pointer border-b-2 px-2.5 py-1.5 text-sm ${on ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
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
  const { pr, watchAfter } = request;
  const navigate = useBbNavigate();
  const link = useShuttleMutation("link");
  const newThread = useShuttleMutation("newThread");
  const watch = useShuttleMutation("watch");
  const busy = link.isPending || newThread.isPending || watch.isPending;
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
  const [role, setRole] = useState<LinkRole>("owner");
  const [projectChoice, setProjectChoice] = useState<string | null>(null);
  const projectId = projectChoice ?? projects.data?.suggested ?? "";
  const [start, setStart] = useState<"own" | "review">(pr.mine ? "own" : "review");
  const projectName = (id: string | null) => (id === null ? null : projects.data?.projects.find((project) => project.id === id)?.name ?? null);
  const linkedRole = (threadId: string) => pr.links.find((link) => link.threadId === threadId)?.role ?? null;

  const watchIfAsked = async (owner: boolean) => {
    if (watchAfter === null || !owner) return;
    if (await watch.run({ key: pr.key, mode: watchAfter })) toast.success(`Watching ${shortKey(pr)}`);
  };

  const submit = async () => {
    if (tab === "existing") {
      const thread = threads?.find((item) => item.id === picked);
      if (!thread) return;
      const linked = await link.run({ key: pr.key, threadId: thread.id, role });
      if (linked === null) return;
      toast.success(`Linked ${shortKey(pr)} to “${thread.title}”`);
      await watchIfAsked(role === "owner");
      onClose();
      return;
    }
    const started = await newThread.run({ key: pr.key, start, ...(projectId === "" ? {} : { projectId }) });
    if (started === null) return;
    toast.success(start === "own" ? "Started a thread that owns this PR" : "Started a review thread", {
      action: { label: "Open", onClick: () => navigate.toThread(started.threadId) },
    });
    await watchIfAsked(start === "own");
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
      {watchAfter !== null && (
        <p className="mb-3 text-xs text-muted-foreground">Watching sends new reviews to an owner thread: pick or start one, and Shuttle turns watching on.</p>
      )}
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
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-sm ${on ? "border-primary bg-primary/5" : "border-border hover:bg-accent"}`}>
                  <span className={`size-4 shrink-0 rounded-full border ${on ? "border-[5px] border-primary" : "border-border"}`} aria-hidden />
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
          <label className="mt-3 grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2 text-sm">
            <span className="text-xs text-muted-foreground">Role</span>
            <select aria-label="Role" className={FIELD} value={role} onChange={(event) => setRole(event.target.value as LinkRole)}>
              {LINK_ROLES.map((item) => <option key={item} value={item}>{ROLE_LABELS[item].long}</option>)}
            </select>
          </label>
        </>
      ) : (
        <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-x-2 gap-y-3 text-sm">
          <span className="text-xs text-muted-foreground">Project</span>
          <ProjectSelect projects={projects.data} value={projectId} onChange={setProjectChoice} />
          <span className="text-xs text-muted-foreground">Start it to</span>
          <select aria-label="Start it to" className={FIELD} value={start} onChange={(event) => setStart(event.target.value as "own" | "review")}>
            <option value="own">Own it: address its reviews and checks</option>
            <option value="review">Review it</option>
          </select>
          {projects.error !== null && <div className="col-span-2"><ErrorNote>Could not list projects: {messageOf(projects.error)}</ErrorNote></div>}
        </div>
      )}
    </Dialog>
  );
}
