import { experimental_useRpcMutation, experimental_useRpcQuery, experimental_useSidebarThreads, useBbContext } from "@get-bb/plugin-sdk/app";
import { type MouseEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { rpcContract, type OverrideSelection } from "../../shared/contract";
import { PageButton } from "./common";
import { PageGlyph } from "./glyphs";
import { CharacterAvatar } from "../engine/avatar";
import "./overrides.css";

const words: Record<string, string> = { label: "Name", plain: "Plain word", body: "Role prompt", scope: "Scope preset", avatar: "Avatar", temper: "Temperament", style: "Voice style", lines: "Voice lines", says: "Bubble lines", look: "Appearance" };
const label = (field: string) => words[field] ?? field.charAt(0).toUpperCase() + field.slice(1);
const scopeName = (target: OverrideSelection["target"], projectName: string | null) => target === "global" ? "Every project" : projectName ?? "This project";
const fallback = (source: "shipped" | "global" | "project") => source === "shipped" ? "Tavern’s shipped default" : source === "global" ? "the every-project override" : "the project override";
const shown = (value: unknown): string => {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value === "") return "Empty";
  if (Array.isArray(value)) return value.length ? value.map(shown).join(", ") : "Empty list";
  if (typeof value === "object") return Object.entries(value).map(([key, item]) => `${label(key)}: ${shown(item)}`).join("\n") || "Empty";
  return String(value);
};

type ResetRequest = OverrideSelection & { field?: string; projectName: string | null };
export function useOverrideReset(reload: () => unknown, afterReset?: () => void) {
  const heading = useRef<HTMLElement>(null), opener = useRef<HTMLElement | null>(null);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [request, setRequest] = useState<ResetRequest | null>(null);
  const { projectName, ...input } = request ?? { kind: "class" as const, id: "", projectId: null, target: "global" as const, projectName: null };
  const preview = experimental_useRpcMutation({ contract: rpcContract, method: "previewOverrideReset" });
  const active = useRef<ResetRequest | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<typeof preview.mutate>> | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const reset = experimental_useRpcMutation({ contract: rpcContract, method: "resetOverride" });
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const title = useId(), detail = useId();
  useEffect(() => {
    if (!request) return;
    const node = dialog.current;
    if (node && !node.open) {
      if (typeof node.showModal === "function") node.showModal();
      else node.setAttribute("open", "");
    }
    cancel.current?.focus();
  }, [request]);
  const close = (success = false) => {
    if (reset.isPending && !success) return;
    dialog.current?.close?.();
    active.current = null;
    setRequest(null);
    requestAnimationFrame(() => (success ? heading.current : opener.current?.isConnected ? opener.current : heading.current)?.focus());
  };
  const open = (event: MouseEvent<HTMLButtonElement>, chosen: ResetRequest) => {
    opener.current = event.currentTarget;
    setMessage(null);
    setRequest(chosen); active.current = chosen;
    setResult(null); setPreviewError(null);
    const { projectName: _projectName, ...selection } = chosen;
    void preview.mutate(selection).then(data => { if (active.current === chosen) setResult(data); })
      .catch((error: unknown) => { if (active.current === chosen) setPreviewError(error instanceof Error ? error.message : String(error)); });
  };
  const plan = result?.code === "ok" ? result : null;
  const apply = async () => {
    if (!plan || !request) return;
    try {
      const out = await reset.mutate({ ...input, revision: plan.revision });
      if (out.code !== "ok") {
        setMessage({ error: true, text: out.code === "stale" ? "This definition changed. Nothing was reset. Reload the comparison before trying again." : `Nothing was reset. ${out.problems.join(" ")}` });
      } else {
        const item = request.field ? `${plan.name}’s ${label(request.field).toLowerCase()}` : `${plan.name}’s override`;
        setMessage({ error: false, text: `${item} reset in ${scopeName(input.target, projectName)}. Now follows ${fallback(plan.fallback)}.${plan.shadowed ? " The project override stays in place." : ""}` });
        afterReset?.();
        void reload();
      }
      close(out.code === "ok");
    } catch (error) {
      setMessage({ error: true, text: `Nothing was reset. ${error instanceof Error ? error.message : String(error)}` });
      close();
    }
  };
  const resetDialog = request && <dialog ref={dialog} aria-modal="true" aria-labelledby={title} aria-describedby={detail} className="tv-override-dialog" onCancel={(event) => { event.preventDefault(); close(); }}>
    <h2 id={title}>{plan ? `Reset ${plan.name}${input.field ? `’s ${label(input.field).toLowerCase()}` : " to default"}?` : "Review reset"}</h2>
    <div id={detail}>
      <p><b>{scopeName(input.target, projectName)}.</b>{plan && <> After reset, {fallback(plan.fallback)} takes over.{input.target === "global" && (plan.shadowed ? " The project override stays in place." : " Any project overrides remain in place.")}</>}</p>
      {plan && <><p><b>Changes removed:</b> {plan.fields.length ? plan.fields.map(label).join(", ") : "No visible difference today."}{plan.format === "full" && " Fields pinned by the whole-file copy will follow the layer below."}</p>
        {plan.widening && <p className="tv-problem">This can give future members wider scope. Tavern’s guard rules still apply.</p>}
        <p className="m">{input.kind === "class" ? "Running turns keep their instructions. Hired members keep their saved class; later turns using the live class may get the new prompt." : "Running turns and character assignments stay in place. The portrait and voice update when the view refreshes."}</p></>}
      {!result && !previewError && <p role="status">Checking what takes over…</p>}
      {(previewError || result?.code === "invalid") && <p className="tv-problem" role="alert">{previewError ?? (result?.code === "invalid" ? result.problems.join(" ") : "")}</p>}
    </div>
    <footer><button ref={cancel} type="button" className="btn" onClick={() => close()} disabled={reset.isPending}>Cancel</button>
      <button type="button" className="btn pri" disabled={!plan || reset.isPending} onClick={() => void apply()}>{reset.isPending ? "Resetting…" : "Reset to default"}</button></footer>
  </dialog>;
  const feedback = message && <div className={message.error ? "tv-problem tv-override-receipt" : "tv-override-receipt"} role={message.error ? "alert" : "status"}>
    {message.text}{message.error && <button type="button" className="btn sm" onClick={() => { setMessage(null); void reload(); }}>Reload comparison</button>}
  </div>;
  return { open, feedback, resetDialog, heading };
}

export function OverridesList() {
  const query = experimental_useRpcQuery({ contract: rpcContract, method: "registryOverrides", input: {} });
  const reset = useOverrideReset(query.refetch);
  const groups = new Map<string | null, NonNullable<typeof query.data>["rows"]>();
  for (const row of query.data?.rows ?? []) {
    const group = groups.get(row.projectId) ?? [];
    if (!groups.has(row.projectId)) groups.set(row.projectId, group);
    group.push(row);
  }
  return <div className="tv-overrides">
    <PageButton path="classes" className="ghost sm">Classes</PageButton>
    <header className="tv-override-title"><p className="lbl">Tavern / Registry</p><h1 ref={node => { reset.heading.current = node; }} tabIndex={-1}><PageGlyph name="layers" size={28} /> Overrides</h1>
      <p className="m">Find what overrides Tavern’s defaults, and reset one definition at a time.</p></header>
    {reset.feedback}
    {query.error && <p className="tv-problem" role="alert">Could not read overrides: {query.error.message} <button type="button" className="btn sm" onClick={() => void query.refetch()}>Try again</button></p>}
    {!query.error && !query.data && <p role="status">Loading overrides…</p>}
    {query.data?.problems.length ? <aside className="tv-problem" aria-label="Registry problems"><b>Some registry files could not be read or used.</b><ul>{query.data.problems.map((problem, i) => <li key={i}>{problem}</li>)}</ul></aside> : null}
    {!query.error && query.data && !groups.size && <section className="tv-card tv-override-summary"><h2>{query.data.problems.length ? "No readable overrides" : "No overrides"}</h2><p className="m">{query.data.problems.length ? "Check the projects listed above. Settings are unchanged." : "Classes and characters follow Tavern’s defaults. Settings are unchanged."}</p></section>}
    {[...groups].map(([projectId, rows]) => <section className="tv-override-group" key={projectId ?? "global"}>
      <h2><PageGlyph name={projectId ? "pin" : "layers"} />{projectId ? `Project · ${rows[0]!.projectName ?? projectId}` : "Every project"}</h2>
      <ul>{rows.map(row => <li className="tv-override-row" key={row.path}>
        <PageButton path={`${row.kind}/${encodeURIComponent(row.id)}${row.projectId ? `/${encodeURIComponent(row.projectId)}` : "/global"}`} className="ghost tv-override-entry" glyph={row.kind === "class" ? "shield" : "character"}>
          <span><b>{row.name}</b><small>{row.kind === "class" ? "Class" : "Character"} · {row.hasDefault === false ? "Custom definition · no Tavern default" : row.format === "patch" ? "Changed fields only" : "Whole-file copy"}</small></span>
        </PageButton>
        <div>{row.fields.map(label).join(", ") || "No visible difference today"}{row.projectId === null && query.data?.rows.some(other => other.projectId && other.kind === row.kind && other.id === row.id) && <small>Project overrides also exist.</small>}</div>
        {row.canReset && <button type="button" className="btn" aria-label={`Reset ${row.name} · ${row.projectName ?? "Every project"}`} onClick={event => reset.open(event, { kind: row.kind, id: row.id, target: row.projectId ? "project" : "global", projectId: row.projectId, projectName: row.projectName })}><PageGlyph name="undo" /> Reset</button>}
      </li>)}</ul>
    </section>)}
    {reset.resetDialog}
  </div>;
}

export function DefinitionSheet({ kind, id, scope, render }: { kind: OverrideSelection["kind"]; id: string; scope?: string; render: (definition: NonNullable<ReturnType<typeof useDefinition>["data"]>["definition"] | undefined, panel: ReactNode, selection: OverrideSelection, revision?: string) => ReactNode }) {
  const context = useBbContext();
  const projects = experimental_useSidebarThreads().projects ?? [];
  const [picked, setProject] = useState<string | undefined>();
  const projectId = picked ?? (scope && scope !== "global" ? scope : context.projectId);
  const [chosen, setChosen] = useState<OverrideSelection["target"] | null>(null);
  const target = chosen ?? (scope && scope !== "global" ? "project" : "global");
  const selection = { kind, id, projectId: projectId || null, target };
  const query = useDefinition(selection);
  const reset = useOverrideReset(query.refetch);
  const data = query.data;
  const panel = <section className="tv-override-panel tv-card" aria-label="Definition">
    {reset.feedback}
    {!context.projectId && projects.length > 0 && <label className="tv-override-scope m small">Compare a project <select className="tv-select" value={projectId ?? ""} onChange={event => {
      setProject(event.target.value); setChosen(event.target.value ? "project" : "global");
    }}><option value="">No project</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>}
    {!!projectId && (data?.canViewProject || target === "project") && <div className="tv-override-scope" role="group" aria-label="Viewing definition for">
      <span className="m small">Viewing</span>
      <button type="button" className="btn sm" aria-pressed={target === "global"} onClick={() => setChosen("global")}>Every project</button>
      <button type="button" className="btn sm" aria-pressed={target === "project"} onClick={() => setChosen("project")}>{data?.projectName ?? "This project"}</button>
    </div>}
    {query.error ? <p className="m small">Could not load the definition comparison. <button type="button" className="btn sm" onClick={() => void query.refetch()}>Retry</button></p> : !data ? <p role="status" className="m small">Loading definition…</p> : <>
      <header className="tv-override-summary"><div><h2 ref={node => { reset.heading.current = node; }} tabIndex={-1}>Definition</h2>
        <b>{!data.hasDefault ? "Custom definition · no Tavern default" : data.fields.some(f => JSON.stringify(f.shipped) !== JSON.stringify(f.current)) ? "Differs from Tavern’s default" : data.format ? "Matches today · still overridden" : "Using Tavern’s default"}</b></div>
        {data.canReset && <button type="button" className="btn" onClick={event => reset.open(event, { ...selection, projectName: data.projectName })}><PageGlyph name="undo" /> Reset to default</button>}</header>
      <p className="tv-override-explain m">{data.problem ?? (data.format === "full" && data.hasDefault ? "This whole-file copy also pins fields that match today." : data.format === "patch" ? "Only fields saved here are overridden. Other fields follow the layer below." : target === "project" && data.fallback === "global" ? "No project override. This project follows the every-project file." : "No override in this scope.")}</p>
      {data.hasDefault && data.fields.length > 0 && <table className="tv-override-fields" role="table"><caption>Compared with Tavern’s shipped definition</caption>
        <thead role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Field</th><th role="columnheader" scope="col">Tavern default</th><th role="columnheader" scope="col">In this view</th></tr></thead>
        <tbody role="rowgroup">{data.fields.map(field => <tr role="row" key={field.field}><th role="rowheader" scope="row">{label(field.field)}</th>
          <td role="cell"><small aria-hidden="true">Tavern default</small>{field.field === "avatar" && "name" in data.definition ? <CharacterAvatar character={data.definition} seed={typeof field.shipped === "string" ? field.shipped : id} mode="off" /> : shown(field.shipped)}</td>
          <td role="cell"><small aria-hidden="true">In this view</small><b>{field.field === "avatar" && "name" in data.definition ? <><CharacterAvatar character={data.definition} seed={typeof field.current === "string" ? field.current : id} mode="off" /><span className="sr">{shown(field.current)}</span></> : shown(field.current)}</b>{data.canReset && field.saved && <button type="button" className="btn sm" aria-label={`Reset ${label(field.field)}`} onClick={event => reset.open(event, { ...selection, projectName: data.projectName, field: field.field })}><PageGlyph name="undo" /> Reset field</button>}</td>
        </tr>)}</tbody>
      </table>}
      {(data.shadowed || (target === "project" && data.fallback === "global")) && <aside className="tv-override-layer"><div><b>{data.shadowed ? `Project override${data.projectName ? ` in ${data.projectName}` : ""}` : "Every-project override"}</b>
        <p className="m">{data.shadowed ? "Its saved fields still take precedence in that project." : data.format ? "Removing the project override reveals the every-project version." : "The every-project override applies here."}</p></div>
        <button type="button" className="btn sm" onClick={() => setChosen(data.shadowed ? "project" : "global")}>{data.shadowed ? "View project override" : "View every-project override"}</button></aside>}
    </>}
    {reset.resetDialog}
  </section>;
  return render(data?.definition, panel, selection, data?.revision);
}

export function useDefinition(selection: OverrideSelection, enabled = true) {
  return experimental_useRpcQuery({ contract: rpcContract, method: "registryDefinition", input: selection, enabled });
}
