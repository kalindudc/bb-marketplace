import { useEffect, useState } from "react";
import { useBbContext, useSdk, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { sourceScopeKey, type SourceScope } from "../web/contracts.ts";
import { buttonClass, SourcesBrowser } from "./sources.tsx";

type ProjectChoice = { id: string; name: string };

export function ProjectSources({ subPath }: PluginNavPanelProps) {
 const sdk = useSdk();
 const context = useBbContext();
 const [projects, setProjects] = useState<ProjectChoice[]>([]);
 const [selected, setSelected] = useState(subPath || context.projectId || "");
 const [error, setError] = useState(false);
 useEffect(() => {
  let active = true;
  const abort = new AbortController();
  void sdk.projects.list({ signal: abort.signal }).then((rows) => { if (active) { setProjects(rows); setError(false); } }, () => { if (active) setError(true); });
  return () => { active = false; abort.abort(); };
 }, [sdk]);
 return <div className="flex h-full flex-col bg-background text-foreground">
  <div className="border-b border-border p-3"><label className="text-sm">Project sources for<select className="ml-2 rounded-md border border-input bg-background px-2 py-1" value={selected} onChange={(e) => setSelected(e.target.value)}><option value="">Select a project</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>{error && <p role="alert">Project list unavailable. Reopen Sources to retry.</p>}</div>
  {selected ? <div className="min-h-0 flex-1"><SourcesBrowser key={selected} scope={{ kind: "project", projectId: selected }} /></div> : <p className="p-4 text-muted-foreground">Choose a project to view explicitly shared public sources.</p>}
 </div>;
}

export function ThreadSources({ threadId }: { threadId: string }) {
 const sdk = useSdk();
 const [projectId, setProjectId] = useState<string | null>(null);
 const [error, setError] = useState(false);
 const [kind, setKind] = useState<"thread" | "project">("thread");
 useEffect(() => {
  let active = true;
  const abort = new AbortController();
  setProjectId(null); setError(false);
  void sdk.threads.get({ threadId, signal: abort.signal }).then((thread) => { if (active) setProjectId(thread.projectId); }, () => { if (active) setError(true); });
  return () => { active = false; abort.abort(); };
 }, [sdk, threadId]);
 if (error) return <p role="alert" className="p-4 text-destructive">Thread scope unavailable. Reopen Sources to retry.</p>;
 if (!projectId) return <p role="status" className="p-4">Loading thread scope…</p>;
 const scope: SourceScope = kind === "thread" ? { kind, projectId, threadId } : { kind, projectId };
 return <div className="flex h-full flex-col bg-background text-foreground"><nav aria-label="Source scope" className="flex gap-2 border-b border-border p-2"><button className={buttonClass} aria-pressed={kind === "thread"} onClick={() => setKind("thread")}>Thread sources</button><button className={buttonClass} aria-pressed={kind === "project"} onClick={() => setKind("project")}>Project sources (shared)</button></nav><div className="min-h-0 flex-1"><SourcesBrowser key={sourceScopeKey(scope)} scope={scope} /></div></div>;
}
