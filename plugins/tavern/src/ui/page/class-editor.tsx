import { UrlLink, experimental_useAppPanel, experimental_usePluginId, experimental_useRpcMutation, experimental_useRpcQuery, useBbContext, type JsonValue, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { EXECUTION_KEYS, type ExecutionFacts, type ExecutionKey } from "../../shared/class-execution";
import { CLASS_BODY_LIMIT, classRules, type TavernRole } from "../../shared/class-rules";
import { rpcContract, type ClassEditInput } from "../../shared/contract";
import type { ClassDef } from "../../shared/schema";
import { Crest, IconButton, OpensMark, plural, useRegistry, useRemembered } from "../kit";
import { type Registry } from "./common";
import { settingsHref } from "./insights";
import { CLASS_EDIT_TAB } from "./panels";
import { PageGlyph } from "./glyphs";
import { FormSkeleton, PageLoad } from "./skeletons";
import { RulesFold } from "./class-facts";

const PRESETS = ["readonly", "checker", "worktree", "keeper", "open"] as const;
const PRESET_WORD: Record<typeof PRESETS[number], string> = { readonly: "read only", checker: "checker (runs checks, no edits)", worktree: "worktree (edits its own checkout)", keeper: "keeper (leads, no domain edits)", open: "open (no Tavern limits)" };
const FIELD_WORD: Record<string, string> = { label: "Name", plain: "Plain word", description: "Description", body: "Role prompt", characters: "Characters", startable: "Startable", hireable: "Hireable", scope: "Scope preset" };
const presetOf = (scope: ClassDef["scope"]) => scope === undefined ? null : typeof scope === "string" ? scope : scope.preset;
const editOf = (c: ClassDef): ClassEditInput => ({ label: c.label, plain: c.plain, description: c.description, body: c.body, characters: c.characters, startable: c.startable, hireable: c.hireable, ...(c.scope !== undefined ? { scope: c.scope } : {}) });
const isEdit = (v: unknown): v is ClassEditInput | null => v === null || (typeof v === "object" && !Array.isArray(v));
const isRev = (v: unknown): v is string | null => v === null || typeof v === "string";

/** An explicit open of a class's editor that is already in the panel: that tab takes focus, as a new one would. */
const focusRequests = new EventTarget();
export function requestClassEditorFocus(classId: string) { focusRequests.dispatchEvent(new CustomEvent("focus", { detail: classId })); }
/**
 * Opens a class's editor in bb's side panel, one tab per class: when that class's editor is already open it is brought forward,
 * keeping its draft, instead of a second tab (bb reuses a tab only for equal params, and each open stamps its own openedAt).
 * False when bb declines, so the caller shows the editor in place.
 */
export function useOpenClassEditor() {
  const panel = experimental_useAppPanel();
  return (classId: string, label: string) => {
    const open = (panel.getTabs?.().tabs ?? []).find((t) => t.detail.kind === "plugin" && t.detail.tab.id === CLASS_EDIT_TAB.id
      && !!t.detail.params && typeof t.detail.params === "object" && !Array.isArray(t.detail.params) && t.detail.params.classId === classId);
    if (open && panel.selectTab(open.key)) { requestClassEditorFocus(classId); return true; }
    return panel.openTab({ tab: CLASS_EDIT_TAB, params: { classId, openedAt: Date.now() }, title: `Edit ${label}` });
  };
}
const shown = (field: string, value: unknown) => field === "body" ? `${String(value ?? "").split("\n").length} lines` : field === "scope" ? String(presetOf(value as ClassDef["scope"]) ?? "none") : Array.isArray(value) ? value.join(", ") || "none" : typeof value === "boolean" ? (value ? "yes" : "no") : String(value ?? "none");
/** A preset with narrowing rules keeps them when only the preset changes. */
const withPreset = (scope: ClassDef["scope"], preset: typeof PRESETS[number]): ClassDef["scope"] => scope !== undefined && typeof scope === "object" ? { ...scope, preset } : preset;

const EXEC_WORD: Record<ExecutionKey, [string, string]> = { provider: ["Provider", "Project default"], model: ["Model", "Project default"], reasoning: ["Reasoning", "Provider default"] };

/** Provider, model and reasoning as the class runs with them, with where each comes from: drawn the same on the class page and in the editor. */
const utf8 = new TextEncoder();
/** The role prompt's size as the server counts it: UTF-8 bytes of the body alone. */
export const utf8Bytes = (text: string) => utf8.encode(text).length;

export function ExecutionFactRows({ facts, loading }: { facts: ExecutionFacts | null; loading?: Partial<Record<ExecutionKey, string | null>> }) {
  return <>{EXECUTION_KEYS.map((key) => {
    const f = facts?.[key], [word, fallback] = EXEC_WORD[key];
    const source = !f ? null : f.source === "settings" ? <>from Settings{f.file !== f.value && <> · class file: {f.file ?? fallback.toLowerCase()}</>}</> : f.value !== null ? "from the class file" : null;
    return <Fragment key={key}><dt>{word}</dt><dd>{(f ? f.value : loading?.[key]) ?? fallback}{source && <> <span className="m">{source}</span></>}</dd></Fragment>;
  })}</>;
}

function useDebounced<T>(value: T, ms = 300) {
  const [out, setOut] = useState(value);
  useEffect(() => { const t = setTimeout(() => setOut(value), ms); return () => clearTimeout(t); }, [JSON.stringify(value), ms]); // eslint-disable-line react-hooks/exhaustive-deps
  return out;
}

/**
 * Edits one class's override file (global, or this project's), never the shipped file. Saving is the client's alone (registry-rpc.ts).
 * Provider, model and reasoning live in Settings, which wins over the file; permission is moot under Scopes; the rest stays in the file.
 */
export function ClassEditForm({ classId, registry, focusOnOpen = false }: { classId: string; registry: Registry; focusOnOpen?: boolean }) {
  const { projectId } = useBbContext();
  const pluginId = experimental_usePluginId();
  const ids = useId();
  const info = experimental_useRpcQuery({ contract: rpcContract, method: "classEditor", input: { classId, projectId } });
  const save = experimental_useRpcMutation({ contract: rpcContract, method: "saveClass" });
  const remove = experimental_useRpcMutation({ contract: rpcContract, method: "removeClassOverride" });
  const [stored, setStored] = useRemembered<ClassEditInput | null>(`class-edit:${classId}`, null, isEdit);
  // The revision the draft began on: a save checks against it, so a change made elsewhere meanwhile is never overwritten unseen.
  const [draftRev, setDraftRev] = useRemembered<string | null>(`class-edit:${classId}:rev`, null, isRev);
  // The class as it was then, so a newer version can be told apart field by field from the draft's own edits.
  const [draftBase, setDraftBase] = useRemembered<ClassEditInput | null>(`class-edit:${classId}:base`, null, isEdit);
  const [chosen, setTarget] = useState<"global" | "project" | null>(null);
  const [outcome, setOutcome] = useState<null | { kind: "saved" | "removed" | "stale"; text: string }>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [follow, setFollow] = useState<null | { id: string; by: -1 | 1 }>(null);
  const orderRef = useRef<HTMLOListElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focused = useRef(false);
  /** A moved character keeps focus: on the same arrow, or on the other one once it reaches an end. */
  useEffect(() => {
    if (!follow) return;
    const row = [...(orderRef.current?.querySelectorAll<HTMLElement>("li[data-char]") ?? [])].find((li) => li.dataset.char === follow.id);
    const [up, down] = [...(row?.querySelectorAll<HTMLButtonElement>("button.ibtn") ?? [])];
    const want = follow.by < 0 ? up : down, other = follow.by < 0 ? down : up;
    (want && !want.disabled ? want : other)?.focus();
    setFollow(null);
  }, [follow]);
  /** An explicit open moves focus to the form once it is ready; later refetches never do. */
  const ready = !!info.data;
  useEffect(() => {
    if (!focusOnOpen || !ready || focused.current) return;
    focused.current = true;
    headingRef.current?.focus();
  }, [focusOnOpen, ready]);
  useEffect(() => {
    const onFocus = (e: Event) => { if ((e as CustomEvent<string>).detail === classId) headingRef.current?.focus(); };
    focusRequests.addEventListener("focus", onFocus);
    return () => focusRequests.removeEventListener("focus", onFocus);
  }, [classId]);
  const revision = info.data?.revision ?? null;
  useEffect(() => { if (stored && revision && draftRev === null && info.data) { setDraftRev(revision); setDraftBase(editOf(info.data.current)); } }, [!!stored, revision, draftRev]);
  const d = info.data;
  /** Until chosen: the override that already wins here, else this project (the narrower change), else every project. */
  const target = chosen ?? (!d ? "global" : d.layers.find((l) => l.source === "project")?.exists ? "project" : d.layers.find((l) => l.source === "global")?.exists || !d.projectPath ? "global" : "project");
  const base = d ? editOf(d.current) : null;
  const draft = stored ?? base;
  const debounced = useDebounced(draft);
  const dirty = !!draft && !!base && JSON.stringify(draft) !== JSON.stringify(base);
  const preview = experimental_useRpcQuery({ contract: rpcContract, method: "classPreview", input: { classId, projectId, target, edit: debounced ?? {} }, enabled: !!debounced && dirty });
  if (!d || !draft || !base) return <PageLoad error={info.error} retry={info.refetch} label="the class" skeleton={<FormSkeleton fields={6} />} />;
  const cls = d.current;
  const set = (patch: ClassEditInput) => { setStored({ ...draft, ...patch }); setOutcome(null); setProblems([]); };
  const forget = () => { setStored(null); setDraftRev(null); setDraftBase(null); };
  const discard = () => { forget(); setOutcome(null); setProblems([]); };
  const since = stored && draftRev ? draftRev : d.revision;
  const baseMoved = dirty && since !== d.revision;
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const fields = Object.keys(FIELD_WORD) as (keyof ClassEditInput)[];
  /** Fields changed elsewhere since the draft began, and which of them the draft also edited. Unknown for a draft saved before this was kept. */
  const elsewhere = baseMoved && draftBase ? fields.filter((k) => !same(draftBase[k], base[k])) : [];
  const overlap = draftBase ? elsewhere.filter((k) => !same(draft[k], draftBase[k])) : [];
  const words = (ks: (keyof ClassEditInput)[]) => ks.map((k) => FIELD_WORD[k]).join(", ");
  /** Moves the draft onto the newer class: its own edits stay, and every field it didn't touch takes the newer value. */
  const rebase = () => {
    setOutcome(null);
    if (!baseMoved) { void info.refetch(); return; }
    const merged = { ...draft };
    if (draftBase) for (const k of elsewhere) if (!overlap.includes(k)) (merged as Record<string, unknown>)[k] = base[k];
    setStored(merged); setDraftRev(d.revision); setDraftBase(base);
  };
  const p = dirty && preview.data?.code === "ok" ? preview.data : null;
  const widening = p?.widening ?? [];
  const targetLayer = d.layers.find((l) => l.source === target);
  const chosenIds = draft.characters ?? [];
  const picked = chosenIds.map((id) => registry.characters.find((c) => c.id === id)).filter((c): c is NonNullable<typeof c> => !!c);
  const unchosen = registry.characters.filter((c) => c.classes.includes(classId) && !chosenIds.includes(c.id));
  const move = (id: string, by: -1 | 1) => {
    const at = chosenIds.indexOf(id), next = [...chosenIds];
    next.splice(at, 1); next.splice(at + by, 0, id);
    set({ characters: next });
    setFollow({ id, by });
  };
  const chars = cls.characters.map((id) => registry.characters.find((c) => c.id === id)).filter((c): c is NonNullable<typeof c> => !!c);
  const persist = async () => {
    setOutcome(null); setProblems([]);
    const out = await save.mutate({ classId, projectId, target, edit: draft, revision: since }).catch((e: unknown) => { setProblems([e instanceof Error ? e.message : String(e)]); return null; });
    if (!out) return;
    if (out.code === "stale") { setOutcome({ kind: "stale", text: "This class changed since you opened it (another device, an editor or a restore). Nothing was saved; your draft is kept." }); return; }
    if (out.code === "invalid") { setProblems(out.problems); return; }
    forget(); setOutcome({ kind: "saved", text: `Saved to ${out.path.replace(/^\/(Users|home)\/[^/]+/, "~")}. It's in Settings' history.` }); void info.refetch();
  };
  const unoverride = async () => {
    setOutcome(null); setProblems([]); setConfirmRemove(false);
    const out = await remove.mutate({ classId, projectId, target, revision: d.revision }).catch((e: unknown) => { setProblems([e instanceof Error ? e.message : String(e)]); return null; });
    if (!out) return;
    if (out.code === "stale") { setOutcome({ kind: "stale", text: "This class changed since you opened it. Nothing was removed." }); return; }
    if (out.code === "invalid") { setProblems(out.problems); return; }
    forget(); setOutcome({ kind: "removed", text: `Removed the ${target === "global" ? "every-project" : "project"} override. ${cls.label} falls back to the file below it.` }); void info.refetch();
  };
  const busy = save.isPending || remove.isPending;
  const bodyBytes = utf8Bytes(draft.body ?? "");
  const bodyOver = bodyBytes > CLASS_BODY_LIMIT;
  /** The file that wins today. A save writes the whole class, so saving to another layer copies every field from this one. */
  const winner = [...d.layers].reverse().find((l) => l.exists) ?? null;
  const copies = !!winner && winner.source !== target;
  const preset = presetOf(draft.scope) as typeof PRESETS[number] | null;

  return <form className="tv-form tv-classedit" aria-label={`Edit the ${cls.label} class`} onSubmit={(e) => { e.preventDefault(); void persist(); }}>
    <header className="tv-form-h">{chars[0] && <Crest cls={cls} character={chars[0]} size={28} />}<h2 ref={headingRef} tabIndex={-1}>Edit the {cls.label} class</h2></header>

    <fieldset className="tv-grpbox tv-ce-target" disabled={busy}><legend>Save for</legend>
      <label className="tv-chk"><input type="radio" name={`${ids}-t`} checked={target === "global"} onChange={() => setTarget("global")} /><span>Every project <code>{d.layers.find((l) => l.source === "global")!.path.replace(/^\/(Users|home)\/[^/]+/, "~")}</code></span></label>
      {d.projectPath && <label className="tv-chk"><input type="radio" name={`${ids}-t`} checked={target === "project"} onChange={() => setTarget("project")} /><span>This project <code>.agents/tavern/classes/{classId}.md</code></span></label>}
      <p className="m small">The shipped file is never changed. A project file wins over the every-project one.</p>
    </fieldset>

    <fieldset className="tv-fields" disabled={busy}><legend className="sr">Class</legend>
      <label className="tv-field">Name<input className="tv-inp" maxLength={40} required value={draft.label ?? ""} onChange={(e) => set({ label: e.target.value })} /></label>
      <label className="tv-field">Plain word<input className="tv-inp" maxLength={40} required value={draft.plain ?? ""} onChange={(e) => set({ plain: e.target.value })} /></label>
      <label className="tv-field wide">Description<textarea className="tv-inp" maxLength={400} value={draft.description ?? ""} onChange={(e) => set({ description: e.target.value })} /></label>
      <div className="tv-field wide tv-ce-flags"><span>Starting and hiring</span>
        <label className="tv-chk"><input type="checkbox" checked={!!draft.startable} onChange={(e) => set({ startable: e.target.checked })} /><span>Startable: you can start a thread as {cls.label}</span></label>
        {classId !== "keeper" && <label className="tv-chk"><input type="checkbox" checked={!!draft.hireable} onChange={(e) => set({ hireable: e.target.checked })} /><span>Hireable: a Keeper can hire one</span></label>}
      </div>
      <fieldset className="tv-field wide tv-ce-pool"><legend>Characters, in the order they are picked</legend>
        {picked.length === 0 ? <p className="m small">None chosen: a {cls.label} gets no character name.</p> : <ol className="tv-ce-order" ref={orderRef}>{picked.map((c, i) =>
          <li key={c.id} data-char={c.id}>
            <label className="tv-chk"><input type="checkbox" checked onChange={() => set({ characters: chosenIds.filter((x) => x !== c.id) })} /><span className="tv-ce-n num">{i + 1}</span><Crest cls={cls} character={c} size={18} /><span>{c.name}</span></label>
            <IconButton glyph="up" label={`Move ${c.name} up`} disabled={i === 0} onClick={() => move(c.id, -1)} />
            <IconButton glyph="down" label={`Move ${c.name} down`} disabled={i === picked.length - 1} onClick={() => move(c.id, 1)} />
          </li>)}</ol>}
        {unchosen.length > 0 && <><div className="lbl tv-ce-out">Not in this class</div>{unchosen.map((c) =>
          <label key={c.id} className="tv-chk"><input type="checkbox" checked={false} onChange={() => set({ characters: [...chosenIds, c.id] })} /><Crest cls={cls} character={c} size={18} /><span>{c.name}</span></label>)}</>}
      </fieldset>
      <label className="tv-field wide">Scope preset: what members may touch
        <select className="tv-inp" value={preset ?? ""} onChange={(e) => set({ scope: withPreset(draft.scope, e.target.value as typeof PRESETS[number]) })}>{PRESETS.map((x) => <option key={x} value={x}>{PRESET_WORD[x]}</option>)}</select>
      </label>
      <div className="tv-field wide">
        <label htmlFor={`${ids}-body`}>Role prompt</label>
        <p className="tv-ce-note" id={`${ids}-bodynote`}><PageGlyph name="note" size={13} /><span>Changes how every {cls.label} works from its next turn, running ones included.</span></p>
        <textarea id={`${ids}-body`} aria-describedby={`${ids}-bodynote ${ids}-bytes`} aria-invalid={bodyOver || undefined} className="tv-inp tv-ce-body" spellCheck={false} value={draft.body ?? ""} onChange={(e) => set({ body: e.target.value })} />
        <p id={`${ids}-bytes`} className={`tv-ce-bytes small ${bodyOver ? "bad" : "m"}`} aria-live={bodyOver ? "polite" : undefined}>
          <span className="num">{bodyBytes.toLocaleString("en-GB")}</span> of <span className="num">{CLASS_BODY_LIMIT.toLocaleString("en-GB")}</span> bytes{bodyOver ? `: ${(bodyBytes - CLASS_BODY_LIMIT).toLocaleString("en-GB")} over. Shorten it to save; Tavern refuses a longer role prompt.` : ""}
        </p>
        <RulesFold className="tv-ce-rules" summary="Tavern's own rules, added after this prompt">
          {([...(classId !== "keeper" && cls.hireable ? ["member"] : []), ...(cls.startable ? [classId === "keeper" ? "keeper" : "solo"] : [])] as TavernRole[]).map((role) => <div key={role}><div className="lbl">{role === "member" ? "For a hired member" : role === "keeper" ? "For a Keeper" : "For a thread you start"}</div><p className="tv-ce-rulestext" data-content>{classRules(role)}</p></div>)}
          <p className="m small">Read-only: they keep reports, asks and blockers plain for every class, so editing the prompt can't remove them.</p>
        </RulesFold>
      </div>
    </fieldset>

    <section className="tv-grpbox tv-ce-ro" aria-label="Set elsewhere"><div className="lbl">Set elsewhere</div>
      <dl className="tv-dl">
        <ExecutionFactRows facts={d.models} />
        <dd className="tv-ce-wide"><UrlLink href={settingsHref(pluginId)} className="tv-ilink act"><span>Change in Settings, Classes and models</span><OpensMark /></UrlLink></dd>
        <dt>Permission</dt><dd>Full while Scopes are on; the scope preset above is what limits members.</dd>
        <dt>Tools</dt><dd>Chosen by Tavern for the role (a Keeper, a hired member or a thread you start), not by the class file.</dd>
        <dt>Hires, greenlight, budget, environment</dt><dd>In the class file only: they widen what a Keeper may do.</dd>
        <dt>Id and shape</dt><dd><code>{cls.id}</code> · {cls.shape}: they name the file and the crest.</dd>
      </dl>
    </section>

    <section className="tv-grpbox tv-ce-when" aria-label="When a change applies"><div className="lbl">When a change applies</div>
      <ul className="tv-ce-whenl">
        <li><b>Right away, everywhere:</b> name, plain word, description.</li>
        <li><b>From each member's next turn:</b> role prompt. {d.running > 0 ? `${plural(d.running, "running member")} get${d.running === 1 ? "s" : ""} it too.` : "No members are running."}</li>
        <li><b>New starts and hires only:</b> characters, startable, hireable, scope preset. {d.running > 0 ? `${plural(d.running, "running member")} keep${d.running === 1 ? "s" : ""} what ${d.running === 1 ? "it was" : "they were"} hired with.` : ""}</li>
      </ul>
    </section>

    {dirty && <section className="tv-grpbox tv-ce-preview" aria-label="What changes" aria-live="polite"><div className="lbl">What changes</div>
      {preview.data?.code === "invalid" ? <ul className="tv-problem" role="alert">{preview.data.problems.map((x) => <li key={x}>{x}</li>)}</ul>
        : !p ? <p className="m small" role="status">Checking the draft…</p>
        : <>
          <ul className="tv-changes">{p.changes.map((c) => <li key={c.field}><b>{FIELD_WORD[c.field] ?? c.field}</b> <span className="m">{shown(c.field, c.from)}</span> → {shown(c.field, c.to)}</li>)}</ul>
          {copies && <p className="tv-ce-copies small" data-copies><PageGlyph name="note" size={13} /><span>Saving writes the whole class to <code>{(targetLayer?.path ?? "").replace(/^\/(Users|home)\/[^/]+/, "~")}</code>, copying every field as it is now in <code>{winner!.path.replace(/^\/(Users|home)\/[^/]+/, "~")}</code>. Later changes to that file won't reach this one.</span></p>}
          {p.shadowedBy && <p className="tv-holdnote"><PageGlyph name="note" /><span>This project has its own {cls.label} file, which still wins here. Save for this project to change it.</span></p>}
        </>}
    </section>}

    {widening.length > 0 && <p className="tv-warn tv-ce-widen" role="status"><PageGlyph name="shield" size={13} /><span>Members hired as {cls.label} will be able to touch more: scope {widening[0]!.from ?? "none"} to {widening[0]!.to}{widening[0]!.to === "open" ? ", with no Tavern limits on files or commands" : ""}. Running members keep what they were hired with.</span></p>}

    <footer className="tv-formf">
      <button className="btn pri" type="submit" disabled={busy || !dirty || bodyOver || preview.data?.code === "invalid"}><span>{save.isPending ? "Saving…" : widening.length ? "Save and allow" : "Save"}</span></button>
      <button className="btn" type="button" disabled={busy || !dirty} onClick={discard}><span>Discard</span></button>
      {targetLayer?.exists && !confirmRemove && <button className="lnk-btn act" type="button" disabled={busy} onClick={() => setConfirmRemove(true)}><span>Remove this override</span></button>}
    </footer>
    {confirmRemove && <div className="tv-ce-confirm" role="group" aria-label="Remove this override?">
      <span>Delete <code>{targetLayer!.path.replace(/^\/(Users|home)\/[^/]+/, "~")}</code>? {cls.label} goes back to the file below it{target === "global" ? ", the shipped one unless a project file exists" : ""}.</span>
      <button className="btn sm danger" type="button" disabled={busy} onClick={() => void unoverride()}><span>Remove</span></button>
      <button className="btn sm" type="button" autoFocus onClick={() => setConfirmRemove(false)}><span>Cancel</span></button>
    </div>}
    {!outcome && baseMoved && <p className="tv-problem" role="alert">
      This class changed since you started this draft (another device, an editor or a restore).{elsewhere.length > 0 && <> Changed since: <b>{words(elsewhere)}</b>.</>}
      {overlap.length > 0 && <> You edited {words(overlap)} too: yours will replace the newer {overlap.length === 1 ? "one" : "ones"}.</>}
      {elsewhere.length > overlap.length && <> {elsewhere.length - overlap.length === 1 ? "The other field takes" : "The other fields take"} the newer version.</>}
      {" "}Your draft is kept; saving it now would be refused. <button type="button" className="lnk-btn act" onClick={rebase}><span>Use the newer class, keep my edits</span></button></p>}
    {outcome && <p className={outcome.kind === "stale" ? "tv-problem" : "tv-receipt"} role={outcome.kind === "stale" ? "alert" : "status"}>{outcome.text}{outcome.kind === "stale" && <> <button type="button" className="lnk-btn act" onClick={rebase}><span>Load the newer class, keep my draft</span></button></>}</p>}
    {problems.length > 0 && <ul className="tv-problem" role="alert">{problems.map((x) => <li key={x}>{x}</li>)}</ul>}
  </form>;
}

/** How recent an explicit open must be for the tab to take focus, so a panel restored later never steals it. */
const OPEN_FOCUS_MS = 5000;

export function ClassEditTab({ params }: PluginNavPanelProps & { params: JsonValue | null }) {
  const registry = useRegistry();
  const p = params && typeof params === "object" && !Array.isArray(params) ? params : null;
  const id = p && typeof p.classId === "string" ? p.classId : null;
  const openedAt = p && typeof p.openedAt === "number" ? p.openedAt : 0;
  const exists = registry.data?.classes.some((c) => c.id === id);
  // Decided when the tab first draws this open, not on each render, so a slow load can't let the window lapse before the form is ready.
  const fresh = useMemo(() => Date.now() - openedAt < OPEN_FOCUS_MS, [openedAt]);
  useReturnFocus(id);
  return <div className="tavern tv-page tv-paneltab">{registry.data ? exists && id ? <ClassEditForm key={`${id}:${openedAt}`} classId={id} registry={registry.data} focusOnOpen={fresh} /> : <p className="tv-empty" data-empty>Class not found{id ? `: ${id}` : ""}.</p> : <PageLoad error={registry.error} retry={registry.refetch} label="the class" skeleton={<FormSkeleton fields={6} />} />}</div>;
}

/** When the editor's panel tab closes, focus goes back to the Edit button that opened it, if focus was left nowhere. */
function useReturnFocus(classId: string | null) {
  useEffect(() => () => {
    if (!classId) return;
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected) return;
      [...document.querySelectorAll<HTMLElement>("[data-class-edit-opener]")].find((el) => el.dataset.classEditOpener === classId)?.focus();
    });
  }, [classId]);
}
