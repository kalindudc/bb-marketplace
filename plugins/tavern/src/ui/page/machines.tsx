import { experimental_usePluginId, experimental_useRpcMutation, experimental_useRpcQuery, useEnvironmentProviders, UrlLink } from "@get-bb/plugin-sdk/app";
import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type ReactNode, type RefObject } from "react";
import { rpcContract, type Room } from "../../shared/contract";
import { memberName } from "../../shared/member-name";
import type { PlacementSettings, PlacementSettingsPatch } from "../../shared/placement-settings";
import { settingsContract } from "../../shared/settings";
import { ExpandsMark, Glyph, SkCard, IconButton, OpensMark, plural, useRegistry, useRemembered } from "../kit";
import { ReadState } from "./common";
import { settingsHref } from "./insights";
import { machinesContract, PLACEMENT_RPC_LIVE, type PlacementCatalog, type PlacementPreview } from "./machines-contract";
import * as M from "./machines-model";
import { usePanelState } from "./panel-state";
import { NumberField } from "./settings";
import "./machines.css";
import { FoldLoad } from "./skeletons";
import { PlacementFacts } from "../kit/placement";

import type { ClassDef } from "../../shared/schema";
import { RuleModels } from "./machines-models";
import { ForgeProfiles } from "./machines-forges";
const WHY = "Changed on the Where work runs page";
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
/** Brings a rule into view and gives it focus, so a jump from a link or a blocked hire lands where keyboard users can act on it. */
function focusRule(i: number) {
  const el = document.querySelector<HTMLElement>(`[data-rule="${i}"]`);
  el?.scrollIntoView?.({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
  el?.focus({ preventScroll: true });
}

// ---------- Reads and saves ----------
type Saved = { problems: M.Problem[]; sent: M.Rule[] | null };
/** The page's one reader and writer: saves send whole rule arrays (or one cap), keep a refused draft so problems line up with what was sent, and remember the decision a delete made for Undo. */
function usePlacementSettings() {
  const query = experimental_useRpcQuery({ contract: machinesContract, method: "settings", input: null });
  const update = experimental_useRpcMutation({ contract: machinesContract, method: "settingsUpdate" });
  const undo = experimental_useRpcMutation({ contract: settingsContract, method: "settingsUndo" });
  const [saved, setSaved] = useState<Saved>({ problems: [], sent: null });
  const [stale, setStale] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [undoable, setUndoable] = useState<{ id: string; revision: number; text: string } | null>(null);
  useEffect(() => { if (!undoable) return; const t = setTimeout(() => setUndoable(null), 10_000); return () => clearTimeout(t); }, [undoable]);
  const save = async (patch: PlacementSettingsPatch, words: string, opts: { undo?: boolean } = {}) => {
    if (!query.data) return false;
    setStale(false); setUndoable(null);
    const out = await update.mutate({ revision: query.data.revision, patch: { machines: patch }, why: WHY });
    if (out.code === "stale") { setStale(true); setSaved({ problems: [], sent: null }); void query.refetch(); return false; }
    if (out.code === "invalid") { setSaved({ problems: out.problems, sent: patch.rules ?? null }); setAnnounce(`Not saved: ${out.problems.length === 1 ? "1 problem" : `${out.problems.length} problems`}, shown at each rule.`); return false; }
    setSaved({ problems: [], sent: null });
    setAnnounce(words);
    if (opts.undo && out.decisionId) setUndoable({ id: out.decisionId, revision: out.revision, text: words });
    void query.refetch();
    return true;
  };
  const runUndo = async () => {
    if (!undoable) return;
    const out = await undo.mutate({ id: undoable.id, revision: undoable.revision, why: WHY });
    setUndoable(null);
    if (out.code === "stale") setStale(true);
    else setAnnounce(out.code === "ok" ? "Undone. The rule is back." : "Tavern couldn't undo that.");
    void query.refetch();
  };
  const discard = () => setSaved({ problems: [], sent: null });
  return { query, save, saved, stale, announce, undoable, runUndo, discard, pending: update.isPending };
}
type Api = ReturnType<typeof usePlacementSettings>;

// ---------- Rule rows ----------
function ProblemLine({ p, field }: { p: M.Problem; field?: string }) {
  return <p className="mx-prob" data-problem={p.key}><Glyph name="block" size={12} /><span>{field && <b>{field}: </b>}{p.message}{p.allowed ? ` Allowed: ${p.allowed}.` : ""}</span></p>;
}
function Catches({ n, rule }: { n: M.Names; rule: M.Rule }) {
  const parts = M.catches(n, rule);
  if (!parts.length) return <span className="mx-v"><b>Every hire</b> (a catch-all)</span>;
  return <span className="mx-v">{parts.map((p, i) => <Fragment key={p.field}>{i > 0 && <span className="mx-f"> and </span>}<span className="mx-f">{p.word} </span><b>{p.values.join(" or ")}</b></Fragment>)}</span>;
}
function SendsTo({ n, rule }: { n: M.Names; rule: M.Rule }) {
  const d = M.sendsTo(n, rule.target);
  return <span className="mx-v"><b>{d.place}</b>{d.detail && <span className="mx-f mx-sd"> · {d.detail}</span>}</span>;
}
type Step = PlacementPreview["steps"][number];
function stepWords(n: M.Names, s: Step, blocked: boolean) {
  if (s.outcome === "unreached") return "not reached";
  if (s.outcome === "off") return "off";
  if (s.outcome === "matched") return blocked ? "catches it, blocked" : "catches it";
  const miss = s.miss;
  if (!miss) return "doesn't catch it";
  const f = miss.field as M.MatchField;
  const word = M.MATCH_FIELDS.includes(f) ? M.fieldWord(f).toLowerCase() : miss.field;
  return miss.value === null ? `no ${word} yet` : `${word} isn't ${M.MATCH_FIELDS.includes(f) ? miss.pattern.split(" or ").map((v) => M.valueWord(n, f, v)).join(" or ") : miss.pattern}`;
}

function RuleList({ api, rules, n, preview, editing, onEdit, consentFor, setConsentFor, invalidTarget }: {
  api: Api; rules: M.Rule[]; n: M.Names; preview: PlacementPreview | null; editing: number | null; onEdit: (i: number) => void;
  consentFor: number | null; setConsentFor: (i: number | null) => void; invalidTarget: Set<number>;
}) {
  const failures = experimental_useRpcQuery({ contract: machinesContract, method: "placementModelFailures", input: {} });
  const clearFailure = experimental_useRpcMutation({ contract: machinesContract, method: "placementModelFailureClear" });
  const placed = M.placeProblems(api.saved.problems);
  const blockedId = preview?.verdict.state === "matched" && preview.verdict.blocked ? preview.verdict.ruleId : null;
  const saveRules = (next: M.Rule[], words: string, undo = false) => api.save({ rules: next }, words, { undo });
  // Focus follows the moved rule: the same arrow at its new number, or the other one once it reaches an end.
  const move = async (i: number, d: -1 | 1) => {
    const next = M.moveRule(rules, i, d); if (!next) return;
    const j = i + d;
    if (!await saveRules(next, `Rule moved to position ${j + 1} of ${next.length}. Saved.`)) return;
    requestAnimationFrame(() => setTimeout(() => {
      const arrow = (dir: -1 | 1) => document.querySelector<HTMLButtonElement>(`[aria-label="Move rule ${j + 1} ${dir < 0 ? "up" : "down"}"]`);
      const same = arrow(d); (same && !same.disabled ? same : arrow(d === 1 ? -1 : 1))?.focus();
    }, 0));
  };
  const toggle = (i: number, on: boolean) => {
    const r = rules[i]!;
    if (on && M.needsConsent(r) && !M.consented(r)) { setConsentFor(i); return; }
    const next = [...rules]; next[i] = { ...r, enabled: on };
    void saveRules(next, `Rule ${i + 1} turned ${on ? "on" : "off"}. Saved.`);
  };
  const accept = async (i: number) => {
    const next = [...rules]; next[i] = { ...rules[i]!, enabled: true, consent: { ...M.FULL_CONSENT } };
    if (await saveRules(next, `Consent accepted for rule ${i + 1}; it is on. Saved.`)) setConsentFor(null);
  };
  return <ol className="mx-rules" aria-label="Placement rules, first match wins">
    {rules.map((r, i) => {
      const probs = placed.filter((p) => p.rule === i);
      const d = M.sendsTo(n, r.target), sh = M.shadowedBy(rules, i);
      const needs = M.needsConsent(r) && !M.consented(r);
      const step = preview?.steps.find((s) => s.ruleId === r.id) ?? null;
      const blocked = blockedId === r.id || (step?.outcome === "matched" && !!d.unavailable);
      const mark = step ? (step.outcome === "matched" ? "✓" : step.outcome === "off" ? "–" : step.outcome === "unreached" ? "·" : "×") : null;
      return <li key={r.id} tabIndex={-1} data-rule={i} aria-current={editing === i ? "true" : undefined}
        className={`mx-rule ${r.enabled ? "" : "off"} ${probs.length ? "bad" : needs || d.unavailable ? "needs" : ""} ${step?.outcome === "matched" ? (blocked ? "hit blocked" : "hit") : ""}`}>
        <div className="mx-rh">
          <span className="mx-n num" aria-hidden="true">{i + 1}</span>
          <h3 className="mx-rt"><button type="button" className="mx-rt-b" onClick={() => onEdit(i)} title={`Edit rule ${i + 1}: ${r.label}`}><span className="sr">Rule {i + 1}: </span>{r.label}</button></h3>
        </div>
        <span className="mx-ra">
          <button type="button" role="switch" aria-checked={r.enabled} className={`tv-switch ${r.enabled ? "on" : ""}`} aria-label={`Rule ${i + 1} on`} onClick={() => toggle(i, !r.enabled)}><span className="tv-switch-k" /><span className="tv-switch-t">{r.enabled ? "On" : "Off"}</span></button>
          <IconButton glyph="up" label={`Move rule ${i + 1} up`} disabled={i === 0 || api.pending} onClick={() => void move(i, -1)} />
          <IconButton glyph="down" label={`Move rule ${i + 1} down`} disabled={i === rules.length - 1 || api.pending} onClick={() => void move(i, 1)} />
        </span>
        <dl className="mx-rd">
          <div><dt>Catches</dt><dd><Catches n={n} rule={r} /></dd></div>
          <div><dt>Sends to</dt><dd>{invalidTarget.has(i) ? <span className="mx-v"><b>Can't read the saved target.</b> <span className="mx-f">Choose it again in Edit.</span></span> : <SendsTo n={n} rule={r} />}</dd></div>
        </dl>
        {step && mark && <p className={`mx-mark ${step.outcome}`}><span className="mx-sm" aria-hidden="true">{mark}</span><span><span className="mx-ml">This hire: </span>{stepWords(n, step, blocked)}</span></p>}
        <div className="mx-flags">
          {d.remote && r.enabled && !needs && !d.unavailable && <span className="tag guard-detect mx-tag" title="Members this rule places are watched, not enforced: a rule break is recorded after the action and can stop the turn, but it is not prevented before it runs.">{M.POSTURE.remote}</span>}
          {needs && <span className="tag mx-tag mx-warn">Needs your consent to turn on</span>}
          {d.unavailable && <span className="tag mx-tag mx-bad">{d.unavailable} isn't installed in this bb: hires it catches wait</span>}
          {sh !== null && <span className="tag mx-tag mx-warn">Never reached: <button type="button" className="tv-ilink" onClick={() => focusRule(sh)}>rule {sh + 1}</button> catches all of it first</span>}
        </div>
        {failures.data?.filter(failure => r.target.kind === "provider" && r.target.machine.type === "new" && failure.target === `${r.target.machine.machineProviderId}/${r.target.environmentProviderId}`).map(failure => <p key={failure.id} className="mx-hint" role="status">This target can't run {failure.model}{failure.providerId ? ` through ${failure.providerId}` : ""}. Set this rule's model for the class, or <button type="button" className="lnk-btn act" disabled={clearFailure.isPending} onClick={() => void clearFailure.mutate({ id: failure.id }).then(() => failures.refetch())} aria-label={`Clear failed model ${failure.model} for rule ${i + 1}`}>clear this record</button>.</p>)}
        {clearFailure.error && <p role="alert">Couldn't clear the failed model: {clearFailure.error.message}</p>}
        {probs.map((p) => <ProblemLine key={p.problem.key} p={p.problem} field={M.problemField(p.field)} />)}
        <div className="mx-rf">
          {needs && <button type="button" className="btn sm" onClick={() => setConsentFor(i)}>Review consent</button>}
          <button type="button" className="lnk-btn act" onClick={() => onEdit(i)} aria-label={`Edit rule ${i + 1}`}>Edit<OpensMark /></button>
          <button type="button" className="lnk-btn act" disabled={rules.length >= M.MAX_RULES} onClick={() => void saveRules(M.copyRule(rules, i), `Rule ${i + 1} copied as rule ${i + 2}, off until you accept its consent. Saved.`)} aria-label={`Copy rule ${i + 1}`}>Copy</button>
          <button type="button" className="lnk-btn act mx-del" onClick={() => void saveRules(rules.filter((_, k) => k !== i), `Rule ${i + 1} deleted. Saved.`, true)} aria-label={`Delete rule ${i + 1}`}>Delete</button>
        </div>
        {consentFor === i && <Consent rule={r} index={i} n={n} onAccept={() => void accept(i)} onCancel={() => setConsentFor(null)} />}
      </li>;
    })}
  </ol>;
}

// ---------- Consent, once per rule ----------
function Consent({ rule, index, n, onAccept, onCancel }: { rule: M.Rule; index: number; n: M.Names; onAccept: () => void; onCancel: () => void }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus({ preventScroll: true }); ref.current?.scrollIntoView?.({ block: "nearest" }); }, []);
  const t = rule.target;
  const machine = t.kind === "provider" && t.machine.type === "new" ? (n.catalog?.machines.find((m) => m.id === (t.machine as { machineProviderId: string }).machineProviderId)?.displayName ?? t.machine.machineProviderId) : "machine";
  return <div className="mx-consent" role="group" aria-labelledby={id} tabIndex={-1} ref={ref}>
    <h4 id={id}>Allow rule {index + 1} to place members on new machines</h4>
    <p className="mx-c-lead">You accept this once for this rule. Tavern won't ask again for each hire.</p>
    <ol className="mx-c-list">
      <li><b>Tavern installs its marked guard</b> on each new {machine} it creates for this rule, and carries each member's work there as private snapshot commits.</li>
      <li><b>Members there are watched, not stopped beforehand.</b> A rule break is recorded after the action and can stop the turn. They show <span className="tag guard-detect mx-tag">{M.POSTURE.remote}</span></li>
      <li><b>Wardens (checkers) on Linux run without containment.</b> They show <span className="tag mx-tag">{M.POSTURE.linuxPi}</span> with Pi, or <span className="tag mx-tag">{M.POSTURE.linuxNoPi}</span> without it.</li>
    </ol>
    <p className="mx-c-not">This never allows a push, publish, merge or deploy, or a wider scope. Turning it off later blocks new hires by this rule; running members stay where they are.</p>
    <p className="mx-c-dest">Sends to: {M.sendsTo(n, rule.target).place}</p>
    <div className="mx-c-acts"><button type="button" className="btn pri" onClick={onAccept}>Accept for rule {index + 1}</button><button type="button" className="btn" onClick={onCancel}>Not now</button></div>
  </div>;
}

// ---------- The editor ----------
const blankRule = (): M.Rule => ({ id: "rule", label: "", enabled: true, match: {}, target: { kind: "current" }, consent: { ...M.NO_CONSENT } });
function Field({ id, label, hint, problem, children }: { id: string; label: ReactNode; hint?: ReactNode; problem?: M.Problem; children: ReactNode }) {
  return <div className={`mx-field ${problem ? "bad" : ""}`}><label htmlFor={id} className="mx-fl">{label}</label>{children}{hint && <p className="mx-hint">{hint}</p>}{problem && <ProblemLine p={problem} />}</div>;
}
/**
 * The open editor's draft and the field being edited, kept in the panel's state rather than the component: bb remounts the page when
 * its layout switches to the phone, and the editor moves between columns at 860 px. `key` is the rule's id, or "new".
 */
type KeptDraft = { key: string; rule: M.Rule; base: M.Rule | null; field: string | null; sel: [number, number] | null };
/** Key order doesn't matter: the saved rule may come back from the server with its keys in another order. */
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined), kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
};
/** The editor's key: the rule's id when it is a unique string, else its place ("#2"), as for raw rules in repair mode, which may lack ids. */
export function editKeyOf(rules: readonly M.Rule[], i: number): string {
  const id = (rules[i] as { id?: unknown } | undefined)?.id;
  return typeof id === "string" && id !== "" && rules.filter((r) => r.id === id).length === 1 ? id : `#${i}`;
}
function indexOfKey(rules: readonly M.Rule[], key: string): number {
  if (key === "new") return -1;
  if (key.startsWith("#")) { const i = Number(key.slice(1)); return Number.isInteger(i) && i < rules.length && editKeyOf(rules, i) === key ? i : -2; }
  const i = rules.findIndex((r) => r.id === key);
  return i >= 0 && editKeyOf(rules, i) === key ? i : -2;
}
const isKeptDraft = (v: unknown): boolean => {
  const d = v as KeptDraft | null;
  return d === null || (typeof d === "object" && typeof d.key === "string" && typeof d.rule === "object" && d.rule !== null && typeof d.rule.label === "string" && typeof d.rule.match === "object" && typeof d.rule.target === "object");
};
const DRAFT = "machines.draft", EDITING = "machines.editing";

function Editor({ api, rules, saved, index, keptKey, n, room, classes, onDone }: { api: Api; rules: M.Rule[]; saved: M.Rule[]; index: number; keptKey: string; n: M.Names; room: Room | undefined; classes: ClassDef[]; onDone: () => void }) {
  const [kept, keep] = usePanelState<KeptDraft | null>(DRAFT, null, isKeptDraft);
  // The rule as stored, not as last sent: after a failed save `rules` holds the draft itself, which is no change made elsewhere.
  const base = index < 0 ? null : saved[index] ?? rules[index]!;
  // A kept draft comes back only while the saved rule is still what it was when editing began; otherwise saving it would quietly revert a newer save.
  const stale = kept?.key === keptKey && !same(kept.base ?? null, base);
  const restore = useRef(kept?.key === keptKey && !stale ? kept : null);
  const [changed] = useState(stale);
  const [r, setR] = useState<M.Rule>(() => restore.current?.rule ?? structuredClone(index < 0 ? blankRule() : rules[index]!));
  const form = useRef<HTMLFormElement>(null);
  const latest = useRef<KeptDraft>({ key: keptKey, rule: r, base: restore.current?.base ?? (base && structuredClone(base)), field: restore.current?.field ?? null, sel: restore.current?.sel ?? null });
  const write = (next: Partial<KeptDraft>) => { latest.current = { ...latest.current, ...next }; keep(latest.current); };
  useEffect(() => { if (latest.current.rule !== r) write({ rule: r }); }); // eslint-disable-line react-hooks/exhaustive-deps
  const [adding, setAdding] = useState(false);
  const uid = useId();
  // Where focus was, as the field's id without this mount's prefix (or its accessible name), so a remount can put it back.
  const locate = (t: EventTarget | null) => { const el = t as HTMLElement | null; if (!el?.id && !el?.getAttribute?.("aria-label")) return null; return el.id.startsWith(uid) ? `#${el.id.slice(uid.length)}` : el.getAttribute("aria-label") ? `[aria-label="${el.getAttribute("aria-label")!.replace(/"/g, '\\"')}"]` : null; };
  const selOf = (t: EventTarget | null): [number, number] | null => { const el = t as HTMLInputElement; try { return typeof el.selectionStart === "number" ? [el.selectionStart, el.selectionEnd ?? el.selectionStart] : null; } catch { return null; } };
  const track = (e: FocusEvent | React.SyntheticEvent) => {
    const field = locate(e.target), sel = selOf(e.target), was = latest.current;
    if (field && (field !== was.field || sel?.[0] !== was.sel?.[0] || sel?.[1] !== was.sel?.[1])) write({ field, sel });
  };
  const untrack = (e: FocusEvent) => { const el = e.target as HTMLElement; queueMicrotask(() => { if (el.isConnected && !form.current?.contains(document.activeElement)) write({ field: null, sel: null }); }); };
  useLayoutEffect(() => {
    const at = restore.current;
    if (!at?.field || !form.current) return;
    const el = form.current.querySelector<HTMLInputElement>(at.field.startsWith("#") ? `[id="${uid}${at.field.slice(1)}"]` : at.field);
    if (!el) return;
    // The caret goes back first: focusing records where focus is, and a collapsed caret move fires no select event to correct it.
    if (at.sel) try { el.setSelectionRange(at.sel[0], at.sel[1]); } catch { /* A select has no caret. */ }
    el.focus({ preventScroll: true });
    write({ field: at.field, sel: at.sel });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const placed = M.placeProblems(api.saved.problems).filter((p) => p.rule === (index < 0 ? rules.length : index));
  const probAt = (key: string) => placed.find((p) => { const k = M.editorKey(p.field); return k === key || k.startsWith(`${key}.`); })?.problem;
  const setMatch = (f: M.MatchField, v: string[] | undefined) => setR((x) => { const m = { ...x.match }; if (v === undefined) delete m[f]; else m[f] = v; return { ...x, match: m }; });
  const cat = n.catalog;
  const prov = r.target.kind === "provider" ? r.target : null;
  const newMachine = prov?.machine.type === "new" ? prov.machine : null;
  const setProv = (p: Partial<M.ProviderTarget>) => setR((x) => ({ ...x, target: { ...(x.target.kind === "provider" ? x.target : { kind: "provider", environmentProviderId: cat?.environments.find((e) => e.machineProviderId === null && e.id === "project-checkout")?.id ?? cat?.environments[0]?.id ?? "project-checkout", machine: { type: "keeper" }, workspace: "linked-worktree" }), ...p } as M.ProviderTarget }));
  const compositions = cat?.environments.filter((e) => e.machineProviderId && e.environmentProviderId) ?? [];
  const hostEnvs = cat?.environments.filter((e) => e.machineProviderId === null) ?? [];
  // A machine provider with no input schema needs the user at the machine (manual setup), so a rule can't create one.
  const creatable = cat?.machines.filter((m) => m.inputs !== null) ?? [];
  const preset = prov && newMachine ? compositions.find((c) => c.environmentProviderId === prov.environmentProviderId && c.machineProviderId === newMachine.machineProviderId) : undefined;
  const save = async () => {
    const label = r.label.trim();
    const next = [...rules];
    const classModels = Object.fromEntries(Object.entries(r.classModels ?? {}).filter(([classId]) => !r.match.classes || r.match.classes.includes(classId)));
    const rule = { ...r, label, classModels, id: index < 0 ? M.ruleId(label, rules.map((x) => x.id)) : r.id };
    // A new rule that needs consent is saved off: turning it on asks for consent.
    if (M.needsConsent(rule) && !M.consented(rule)) rule.enabled = false;
    if (index < 0) next.push(rule); else next[index] = rule;
    if (await api.save({ rules: next }, index < 0 ? `Rule ${next.length} added. Saved.` : `Rule ${index + 1} saved.`)) onDone();
  };
  return <form ref={form} className="mx-editor" aria-label={index < 0 ? `New rule ${rules.length + 1}` : `Edit rule ${index + 1}`} onSubmit={(e) => { e.preventDefault(); void save(); }} onFocus={track} onSelect={track} onInput={track} onBlur={untrack}>
    <div className="mx-eh"><h3>{index < 0 ? `New rule ${rules.length + 1}` : `Rule ${index + 1}`}</h3><span className="mx-hint">First enabled match wins; a new rule goes last.</span></div>
    {changed && <p className="tv-problem mx-changed" role="status">This rule changed since you started editing, so the editor shows it as saved now.</p>}
    <Field id={`${uid}-l`} label="Name" problem={probAt("label")}><input id={`${uid}-l`} className="tv-text mx-wide" value={r.label} maxLength={200} placeholder="Project work on a separate machine" onChange={(e) => setR({ ...r, label: e.target.value })} required /></Field>
    <fieldset className="mx-fs">
      <legend>Catches</legend>
      <p className="mx-hint">A hire must meet every condition. Within one condition, any value is enough.</p>
      {M.MATCH_FIELDS.every((f) => !r.match[f]) && <p className="mx-all"><b>Every hire</b>, because there are no conditions. Put a catch-all last.</p>}
      {M.MATCH_FIELDS.filter((f) => r.match[f]).map((f) => <MatchField key={f} f={f} values={r.match[f]!} n={n} room={room} classes={classes} onChange={(v) => setMatch(f, v)} problem={probAt(`match.${f}`)} />)}
      <div className="mx-add">
        <button type="button" className="lnk-btn act" aria-expanded={adding} onClick={() => setAdding(!adding)}>Add a condition<ExpandsMark open={adding} /></button>
        {adding && <div className="segc" role="group" aria-label="Condition to add">{M.MATCH_FIELDS.filter((f) => !r.match[f]).map((f) => <button type="button" className="seg" key={f} aria-pressed={false} onClick={() => { setMatch(f, f === "classes" ? [classes[0]?.id ?? "smith"] : []); setAdding(false); }}>{M.fieldWord(f)}</button>)}</div>}
      </div>
    </fieldset>
    <fieldset className="mx-fs">
      <legend>Sends to</legend>
      <div className="segc" role="group" aria-label="Where members run">
        <button type="button" className="seg" aria-pressed={r.target.kind === "current"} onClick={() => setR({ ...r, target: { kind: "current" } })}>Where it runs today</button>
        <button type="button" className="seg" aria-pressed={r.target.kind === "provider"} disabled={!cat && r.target.kind !== "provider"} onClick={() => setProv({})}>Another machine</button>
      </div>
      {r.target.kind === "current" && <p className="mx-hint">{cat ? "Members run as they do without rules: on the Keeper's machine, a Smith in its own worktree. Use this to keep an exception above a broader rule." : "Members run as they do without rules. Other machines are not available here yet: Tavern can't list bb's machines and checkouts until its catalog is built."}</p>}
      {prov && !cat && <p className="mx-hint">Saved as written. Tavern can't list bb's machines and checkouts yet, so this target can't be changed here.</p>}
      {prov && cat && <>
        <Field id={`${uid}-p`} label="Machine and checkout" hint={preset ? preset.description : "Pick bb's pairing, or a checkout and a machine separately."} problem={probAt("target.environmentProviderId")}>
          <select id={`${uid}-p`} className="tv-select mx-wide" value={preset ? `c:${preset.id}` : "custom"} onChange={(e) => { const c = compositions.find((x) => `c:${x.id}` === e.target.value); if (c) setProv({ environmentProviderId: c.environmentProviderId!, inputs: undefined, machine: { type: "new", machineProviderId: c.machineProviderId! }, workspace: "dedicated-machine" }); else setProv({ machine: { type: "keeper" }, workspace: "linked-worktree" }); }}>
            {compositions.map((c) => <option key={c.id} value={`c:${c.id}`}>{c.displayName}: {n.envs.get(c.environmentProviderId!)?.displayName ?? c.environmentProviderId} on a new {cat.machines.find((m) => m.id === c.machineProviderId)?.displayName ?? c.machineProviderId}</option>)}
            <option value="custom">Choose a checkout and a machine</option>
          </select>
        </Field>
        {!preset && <div className="mx-two">
          <Field id={`${uid}-e`} label="Checkout (environment)" hint={n.envs.get(prov.environmentProviderId)?.description ?? "Not installed in this bb."} problem={probAt("target.environmentProviderId")}>
            <select id={`${uid}-e`} className="tv-select mx-wide" value={prov.environmentProviderId} onChange={(e) => setProv({ environmentProviderId: e.target.value, inputs: undefined })}>
              {hostEnvs.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
              {!hostEnvs.some((p) => p.id === prov.environmentProviderId) && <option value={prov.environmentProviderId}>{prov.environmentProviderId} (not installed)</option>}
            </select>
          </Field>
          <Field id={`${uid}-m`} label="Machine" hint={newMachine ? cat.machines.find((m) => m.id === newMachine.machineProviderId)?.description ?? "Not installed in this bb." : prov.machine.type === "existing" ? "A machine bb already has." : "No new machine."} problem={probAt("target.machine")}>
            <select id={`${uid}-m`} className="tv-select mx-wide" value={prov.machine.type === "new" ? `new:${prov.machine.machineProviderId}` : prov.machine.type === "existing" ? `existing:${prov.machine.hostId}` : prov.machine.type} onChange={(e) => { const v = e.target.value; const machine: M.Machine = v.startsWith("new:") ? { type: "new", machineProviderId: v.slice(4) } : v.startsWith("existing:") ? { type: "existing", hostId: v.slice(9) } : { type: v as "keeper" | "project-checkout" }; setProv({ machine, workspace: machine.type === "new" ? prov.workspace : "linked-worktree" }); }}>
              <option value="keeper">The Keeper's machine</option>
              <option value="project-checkout">The project checkout's machine</option>
              {cat.hosts.map((h) => <option key={h.id} value={`existing:${h.id}`}>{h.name} (existing)</option>)}
              {creatable.map((m) => <option key={m.id} value={`new:${m.id}`}>A new {m.displayName}</option>)}
              {newMachine && !creatable.some((m) => m.id === newMachine.machineProviderId) && <option value={`new:${newMachine.machineProviderId}`}>A new {newMachine.machineProviderId} (not installed)</option>}
            </select>
          </Field>
        </div>}
        <div className={`mx-field ${probAt("target.workspace") ? "bad" : ""}`}>
          <span className="mx-fl" id={`${uid}-w`}>Workspace</span>
          <div className="segc" role="group" aria-labelledby={`${uid}-w`}>
            <button type="button" className="seg" aria-pressed={prov.workspace === "dedicated-machine"} disabled={!newMachine} onClick={() => setProv({ workspace: "dedicated-machine" })}>One machine per member</button>
            <button type="button" className="seg" aria-pressed={prov.workspace === "linked-worktree"} onClick={() => setProv({ workspace: "linked-worktree" })}>A linked worktree</button>
          </div>
          {!newMachine && <p className="mx-hint">One machine per member needs a new machine.</p>}
          {probAt("target.workspace") && <ProblemLine p={probAt("target.workspace")!} />}
        </div>
        <Inputs title={`${n.envs.get(prov.environmentProviderId)?.displayName ?? prov.environmentProviderId} inputs`} schema={cat.environments.find((e) => e.id === prov.environmentProviderId)?.inputs ?? null} value={prov.inputs as M.Json | undefined} onChange={(v) => setProv({ inputs: v })} probAt={(k) => probAt(k ? `target.inputs.${k}` : "target.inputs")} templates />
        {newMachine && <Inputs title={`${cat.machines.find((m) => m.id === newMachine.machineProviderId)?.displayName ?? newMachine.machineProviderId} inputs`} schema={cat.machines.find((m) => m.id === newMachine.machineProviderId)?.inputs ?? null} value={newMachine.inputs as M.Json | undefined} onChange={(v) => setProv({ machine: { ...newMachine, inputs: v } })} probAt={(k) => probAt(k ? `target.machine.inputs.${k}` : "target.machine.inputs")} />}
      </>}
    </fieldset>
    <RuleModels classes={classes.filter(role => !r.match.classes || r.match.classes.includes(role.id))} models={r.classModels ?? {}} onChange={(classId, value) => setR(previous => {
      const classModels = { ...previous.classModels };
      if (value) classModels[classId] = value; else delete classModels[classId];
      return { ...previous, classModels };
    })} />
    <Field id={`${uid}-pr`} label="Pull requests open" problem={probAt("pullRequests")}><select id={`${uid}-pr`} className="tv-select" value={r.pullRequests?.at === "home" ? r.pullRequests.profile : ""} onChange={event => setR({ ...r, pullRequests: event.target.value ? { at: "home", profile: event.target.value } : { at: "member" } })}><option value="">On the member’s machine</option>{api.query.data?.effective.machines.forges.map(profile => <option key={profile.id} value={profile.id} disabled={!profile.enabled}>From home with {profile.name}</option>)}</select></Field>
    {M.needsConsent(r) && <div className={`mx-field ${probAt("consent") ? "bad" : ""}`}>
      <span className="mx-fl">Consent</span>
      <p className="mx-hint">{M.consented(r) ? "Accepted for this rule. Changing the machine or checkout keeps it; a copy of the rule asks again." : "After you save, the rule stays off until you accept its consent: one confirmation, never per hire."}</p>
      {probAt("consent") && <ProblemLine p={probAt("consent")!} />}
    </div>}
    <div className="mx-ef"><button type="submit" className="btn pri" disabled={api.pending}>Save rule</button><button type="button" className="btn" onClick={onDone}>Cancel</button><span className="mx-hint">Tavern checks the whole list when you save.</span></div>
  </form>;
}
function MatchField({ f, values, n, room, classes, onChange, problem }: { f: M.MatchField; values: string[]; n: M.Names; room: Room | undefined; classes: { id: string; label: string; plain: string }[]; onChange: (v: string[] | undefined) => void; problem?: M.Problem }) {
  const id = useId();
  const [text, setText] = useState("");
  const remove = <button type="button" className="lnk-btn act mx-rm" aria-label={`Remove the ${M.fieldWord(f).toLowerCase()} condition`} onClick={() => onChange(undefined)}>Remove</button>;
  if (f === "classes") return <div className={`mx-field ${problem ? "bad" : ""}`}><span className="mx-fl" id={id}>Class</span><div className="mx-row"><div className="segc" role="group" aria-labelledby={id}>{classes.map((c) => <button type="button" key={c.id} className="seg" aria-pressed={values.includes(c.id)} onClick={() => { const v = values.includes(c.id) ? values.filter((x) => x !== c.id) : [...values, c.id]; onChange(v); }}>{c.label} <span className="mx-f">({c.plain})</span></button>)}</div>{remove}</div>{problem && <ProblemLine p={problem} />}</div>;
  const options = f === "projectIds" ? (n.catalog?.projects ?? []).map((p) => ({ id: p.id, label: `${p.name} · ${p.remotes[0] ? p.remotes[0].replace(/^[a-z]+:\/\//, "").replace(/\.git$/, "") : "no remote"}` }))
    : f === "questIds" ? (room?.keepers ?? []).flatMap((k) => k.boardQuests).filter((q) => !q.archivedAt).map((q) => ({ id: q.id, label: n.quests.get(q.id) ?? q.title }))
    : f === "keeperEnvironmentProviders" ? [...n.envs.entries()].filter(([, e]) => e.machineProviderId === null).map(([eid, e]) => ({ id: eid, label: e.displayName })) : null;
  const hint = f === "repoRemotes" ? <>Without <code>https://</code> or <code>.git</code>. <code>*</code> matches inside one part, for example <code>forge.example/team/project</code>.</>
    : f === "keeperPathGlobs" ? <><code>~</code> is your home and <code>*</code> one folder: <code>~/projects/*/src</code> matches each project’s src folder and everything inside it.</>
    : f === "projectIds" && !n.catalog ? "Repo names arrive with Tavern's catalog; until then, type a bb project id." : undefined;
  const typed = !options || (f === "projectIds" && !n.catalog);
  return <div className={`mx-field ${problem ? "bad" : ""}`}>
    <label className="mx-fl" htmlFor={id}>{M.fieldWord(f, values.length || 1)}</label>
    {values.length > 0 && <ul className="mx-chips" aria-label={`${M.fieldWord(f, 2)} in this condition`}>{values.map((v) => <li key={v} className="mx-chip"><span>{M.valueWord(n, f, v)}</span><button type="button" className="mx-chip-x" aria-label={`Remove ${M.valueWord(n, f, v)}`} title={`Remove ${M.valueWord(n, f, v)}`} onClick={() => onChange(values.filter((x) => x !== v))}><Glyph name="close" size={11} /></button></li>)}</ul>}
    <div className="mx-row">
      {typed ? <input id={id} className="tv-text mx-wide" value={text} placeholder={f === "repoRemotes" ? "forge.example/team/*" : f === "keeperPathGlobs" ? "~/projects/*" : "Type and press Enter"} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && text.trim()) { e.preventDefault(); if (!values.includes(text.trim())) onChange([...values, text.trim()]); setText(""); } }} />
        : <select id={id} className="tv-select mx-wide" value="" onChange={(e) => e.target.value && onChange([...values, e.target.value])}><option value="">Add {M.fieldWord(f).toLowerCase()}…</option>{options!.filter((o) => !values.includes(o.id)).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select>}
      {remove}
    </div>
    {hint && <p className="mx-hint">{hint}</p>}
    {values.length === 0 && <p className="mx-hint">Add at least one, or remove the condition.</p>}
    {problem && <ProblemLine p={problem} />}
  </div>;
}
function Inputs({ title, schema, value, onChange, probAt, templates }: { title: string; schema: unknown; value: M.Json | undefined; onChange: (v: M.Json | undefined) => void; probAt: (k: string) => M.Problem | undefined; templates?: boolean }) {
  const uid = useId();
  const [focus, setFocus] = useState<string | null>(null);
  const [raw, setRaw] = useState(() => JSON.stringify(value ?? null, null, 1));
  const shape = M.fieldsOf(schema);
  if (!shape.fields.length && !shape.json) return null;
  if (shape.json) return <fieldset className="mx-inputs"><legend>{title}</legend>
    <textarea className="tv-text mx-wide mx-json" aria-label={`${title} as JSON`} value={raw} onChange={(e) => { setRaw(e.target.value); try { onChange(JSON.parse(e.target.value) as M.Json); } catch { /* kept as typed until it parses */ } }} />
    <p className="mx-hint">This provider's inputs have more than one shape, so they are edited as JSON.</p>
    {probAt("") && <ProblemLine p={probAt("")!} />}
  </fieldset>;
  return <fieldset className="mx-inputs">
    <legend>{title}{shape.optional && <span className="mx-f"> · all optional</span>}</legend>
    <div className="mx-igrid">{shape.fields.map((f) => { const id = `${uid}-${f.key}`; const p = probAt(f.key); const v = M.readInput(value, f.key);
      return <div key={f.key} className={`mx-field ${p ? "bad" : ""}`}>
        <label className="mx-fl" htmlFor={id}>{f.key}</label>
        {f.kind === "integer" ? <span className="mx-int"><input id={id} type="number" className="tv-text" min={f.min} max={f.max} value={v === undefined ? "" : String(v)} aria-invalid={!!p} onChange={(e) => onChange(M.writeInput(value, f.key, e.target.value === "" ? undefined : Number(e.target.value)))} />{f.min !== undefined && f.max !== undefined && <span className="mx-f">{f.min} to {f.max}</span>}</span>
          : f.kind === "strings" ? <input id={id} className="tv-text mx-wide" value={Array.isArray(v) ? v.join(", ") : ""} placeholder={f.maxItems ? `up to ${f.maxItems}, comma separated` : "comma separated"} onChange={(e) => onChange(M.writeInput(value, f.key, e.target.value ? e.target.value.split(/,\s*/) : undefined))} />
            : <input id={id} className="tv-text mx-wide" value={typeof v === "string" ? v : ""} aria-invalid={!!p} onFocus={() => setFocus(f.key)} onChange={(e) => onChange(M.writeInput(value, f.key, e.target.value))} />}
        {templates && f.kind === "string" && focus === f.key && <div className="mx-tpl" role="group" aria-label={`Insert into ${f.key}`}>{M.TEMPLATES.map((t) => <button type="button" key={t} className="btn sm" onClick={() => onChange(M.writeInput(value, f.key, `${typeof v === "string" ? v : ""}${t}`))}>{t}</button>)}</div>}
        {p && <ProblemLine p={p} />}
      </div>; })}</div>
    {templates && shape.fields.some((f) => f.kind === "string") && <p className="mx-hint">Text inputs may use <code>{"{keeper.branch}"}</code>, <code>{"{source.commit}"}</code>, <code>{"{source.base}"}</code>, <code>{"{member.branch}"}</code> and <code>{"{quest.id}"}</code>, filled in at each hire.</p>}
    {probAt("") && <ProblemLine p={probAt("")!} />}
  </fieldset>;
}

// ---------- Caps ----------
function Caps({ api, settings, partyMax }: { api: Api; settings: PlacementSettings; partyMax: number }) {
  const pluginId = experimental_usePluginId();
  const placed = M.placeProblems(api.saved.problems).filter((p) => p.rule === null);
  const row = (k: "maxMakers" | "maxCheckers", label: string, help: string) => {
    const p = placed.find((x) => x.field === k)?.problem;
    return <div className={`tv-set-row mx-cap ${p ? "bad" : ""}`}><div className="tv-set-l"><label htmlFor={`cap-${k}`}>{label}</label><p>{help}</p>{p && <ProblemLine p={p} />}</div>
      <div className="tv-set-c"><NumberField id={`cap-${k}`} value={settings[k]} min={1} max={1000} unit="at once" onSave={(v) => void api.save({ [k]: v }, `${label}: ${v}. Saved.`)} /></div></div>;
  };
  return <div className="mx-caps">
    {row("maxMakers", "Makers per Keeper", "Members a rule places that build or scout, across all of one Keeper's quests.")}
    {row("maxCheckers", "Checkers per Keeper", "Wardens a rule places. Members without a rule don't count.")}
    <p className="mx-ceiling">The party ceiling still applies: <b>{partyMax}</b> members per Keeper, set under <span className="mx-nowrap"><UrlLink href={`${settingsHref(pluginId)}`} className="tv-ilink">Keepers and decisions</UrlLink>.</span> Provider quotas apply too.</p>
  </div>;
}

// ---------- The preview ----------
function HirePicker({ hire, setHire, room, catalog, classes, keeperName }: { hire: M.Hire; setHire: (h: M.Hire) => void; room: Room | undefined; catalog: PlacementCatalog | null; classes: { id: string; label: string; plain: string }[]; keeperName: (id: string) => string }) {
  const uid = useId();
  const live = (room?.keepers ?? []).filter((k) => !k.archived);
  const keeperValue = hire.mode === "keeper" ? `${hire.keeperThreadId}|${hire.questId ?? ""}` : "";
  return <div className="mx-hire">
    <div className="segc" role="group" aria-label="Which hire">
      <button type="button" className="seg" aria-pressed={hire.mode === "keeper"} disabled={!live.length} onClick={() => live[0] && setHire({ mode: "keeper", keeperThreadId: live[0].member.threadId, questId: null, classId: hire.classId })}>A Keeper's quest</button>
      <button type="button" className="seg" aria-pressed={hire.mode === "project"} disabled={!catalog?.projects.length} onClick={() => catalog?.projects[0] && setHire({ mode: "project", projectId: [...catalog.projects].sort((a, b) => a.name.localeCompare(b.name))[0]!.id, keeperPath: "", classId: hire.classId })}>A repo</button>
    </div>
    {hire.mode === "keeper" ? <div className="mx-field"><label className="mx-fl" htmlFor={`${uid}-q`}>Quest</label>
      <select id={`${uid}-q`} className="tv-select mx-wide" value={keeperValue} onChange={(e) => { const [k, q] = e.target.value.split("|"); setHire({ mode: "keeper", keeperThreadId: k!, questId: q || null, classId: hire.classId }); }}>
        {live.map((k) => <optgroup key={k.member.threadId} label={keeperName(k.member.threadId)}>
          {k.boardQuests.filter((q) => !q.archivedAt).map((q) => <option key={q.id} value={`${k.member.threadId}|${q.id}`}>{q.short?.trim() || q.title} · {keeperName(k.member.threadId)}</option>)}
          <option value={`${k.member.threadId}|`}>A new quest · {keeperName(k.member.threadId)}</option>
        </optgroup>)}
      </select></div>
      : <>
        <div className="mx-field"><label className="mx-fl" htmlFor={`${uid}-pr`}>Repo</label>
          <select id={`${uid}-pr`} className="tv-select mx-wide" value={hire.projectId} onChange={(e) => setHire({ ...hire, projectId: e.target.value })}>{[...(catalog?.projects ?? [])].sort((a, b) => a.name.localeCompare(b.name)).map((p) => <option key={p.id} value={p.id}>{p.name} · {p.remotes[0]?.replace(/^[a-z]+:\/\//, "").replace(/\.git$/, "") ?? "no remote"}</option>)}</select>
          <p className="mx-hint">No Keeper needed: this asks before any work starts there.</p></div>
        <div className="mx-field"><label className="mx-fl" htmlFor={`${uid}-pa`}>Keeper path <span className="mx-f">optional</span></label>
          <input id={`${uid}-pa`} className="tv-text mx-wide" value={hire.keeperPath} placeholder={catalog?.projects.find((p) => p.id === hire.projectId)?.path ?? ""} onChange={(e) => setHire({ ...hire, keeperPath: e.target.value })} /></div>
      </>}
    <div className="mx-field"><span className="mx-fl" id={`${uid}-c`}>Class</span>
      <div className="segc" role="group" aria-labelledby={`${uid}-c`}>{classes.map((c) => <button type="button" key={c.id} className="seg" aria-pressed={hire.classId === c.id} onClick={() => setHire({ ...hire, classId: c.id })}>{c.label}<span className="mx-f mx-plain"> ({c.plain})</span></button>)}</div></div>
  </div>;
}
function Verdict({ p, rules, n, keeperPlace, hire }: { p: PlacementPreview; rules: M.Rule[]; n: M.Names; keeperPlace: (id: string) => string; hire: M.Hire }) {
  const v = p.verdict;
  const note = <>{M.warningLines(p).map((w, i) => <p key={i} className="mx-vn">{w.words}{w.detail && <> <span className="mx-f">{w.detail}</span></>}</p>)}<p className="mx-vn">Preview only: nothing is created.</p></>;
  if (v.state === "blocked") return <div className="mx-verdict blocked" role="status" data-verdict="blocked"><p className="mx-vl"><span className="mx-vk">Blocked.</span> Every hire waits until the saved rules can be read again; none falls back to the laptop.</p>{note}</div>;
  if (v.state === "compatibility") return <div className="mx-verdict" role="status" data-verdict="none">
    <p className="mx-vl"><span className="mx-vk">No rule catches it.</span> Runs where it runs today{hire.mode === "keeper" ? `: on ${keeperPlace(hire.keeperThreadId)}` : ", on the Keeper's machine"}.</p>
    <p className="mx-vr">{M.todayGuard(v.posture)} No machine slot is taken.</p>{note}</div>;
  const i = rules.findIndex((r) => r.id === v.ruleId), rule = rules[i];
  const d = rule ? M.sendsTo(n, rule.target) : null;
  const evidence = v.matchEvidence.map((e) => { const f = e.field as M.MatchField; return { field: f, value: M.MATCH_FIELDS.includes(f) && f !== "repoRemotes" && f !== "keeperPathGlobs" ? M.valueWord(n, f, e.value) : e.value }; });
  const current = rule?.target.kind === "current";
  const missing = d?.unavailable ? { code: "provider-unavailable", message: `${d.unavailable} is not installed in this bb. The rule is kept; members it catches wait here until you repair it.` } : null;
  const fault = v.blocked ?? missing;
  const where = d ? d.place.replace(/^.*? on /, "on ") : "elsewhere";
  const head = fault ? <><span className="mx-vk">Blocked.</span> It would wait here, not run anywhere else.</>
    : current ? <><span className="mx-vk">Runs where it runs today.</span> Rule {i + 1} keeps it there.</>
      : <><span className="mx-vk">Runs {where}.</span>{d && <> {d.place.replace(/ on .*$/, "")}{d.detail ? `, ${d.detail.split(" · ")[0]}` : ""}.</>}</>;
  return <div className={`mx-verdict ${fault ? "blocked" : ""}`} role="status" data-verdict={fault ? "blocked" : "caught"}>
    <p className="mx-vl">{head}</p>
    <p className="mx-vr">{evidence.length ? <>Because {evidence.map((e, k) => <Fragment key={e.field}>{k > 0 && " and "}{M.MATCH_FIELDS.includes(e.field) ? M.fieldWord(e.field).toLowerCase() : e.field} is <b>{e.value}</b></Fragment>)}.</> : <>Rule {i + 1} catches every hire.</>}</p>
    {i >= 0 && <button type="button" className="lnk-btn act mx-vlink" onClick={() => focusRule(i)}>Rule {i + 1} · {rule!.label}<OpensMark /></button>}
    {fault && <ProblemLine p={{ key: fault.code, message: fault.message }} />}
    {!fault && <div className="mx-vf">
      {v.remote === true && v.posture && <span className="tag guard-detect mx-tag">{v.posture}</span>}
      {current && <span className="mx-f">{M.todayGuard(v.posture)}</span>}
      {!current && v.remote === null && <span className="mx-f">Where it lands depends on the Keeper, so the guard can't be named yet.</span>}
      <span className="mx-f">{v.slot === null ? "No machine slot is taken; today's party and guard rules apply." : `Takes a ${v.slot} slot: ${v.slotsInUse === null ? `${v.slotCap} per Keeper` : `${v.slotsInUse} of ${v.slotCap} in use`}. Party ceiling ${v.partyCeiling}.`}</span>
    </div>}
    {note}
  </div>;
}

// ---------- The page ----------
/** Whether the grid is wide enough for two columns (the CSS switches at the same 900 px), so the editor renders once: beside the list, or under it. */
function useWide(ref: RefObject<HTMLElement | null>) {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const el = ref.current; if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWide(el.getBoundingClientRect().width > 860));
    ro.observe(el); return () => ro.disconnect();
  });
  return wide;
}
export function MachinesPage({ rule: ruleParam }: { rule?: string; hire?: string }) {
  const api = usePlacementSettings();
  const room = experimental_useRpcQuery({ contract: rpcContract, method: "room", input: {} });
  const registry = useRegistry();
  const envs = useEnvironmentProviders();
  const catalogQ = experimental_useRpcQuery({ contract: machinesContract, method: "placementCatalog", input: {}, enabled: PLACEMENT_RPC_LIVE });
  const catalog = PLACEMENT_RPC_LIVE ? catalogQ.data ?? null : null;
  const classes = useMemo(() => (registry.data?.classes ?? []).filter((c) => c.hireable && c.id !== "keeper"), [registry.data]);
  const n = useMemo(() => M.makeNames(catalog, envs.providers, registry.data?.classes ?? [], room.data, registry.data?.characters ?? []), [catalog, envs.providers, registry.data, room.data]);
  const [remembered, setRemembered] = useRemembered<M.Hire | null>("tavern.machines.hire", null, (v): v is M.Hire | null => v === null || M.isHire(v));
  const [chosen, setChosen] = useState<M.Hire | null>(null);
  const hire = chosen ?? M.defaultHire(room.data, remembered, catalog, classes.find((c) => c.id === "smith")?.id ?? classes[0]?.id);
  const setHire = (h: M.Hire) => { setChosen(h); setRemembered(h); };
  const data = api.query.data;
  const invalid = data?.placementPolicy?.state === "invalid";
  const previewQ = experimental_useRpcQuery({ contract: machinesContract, method: "placementPreview", input: hire ? M.previewInput(hire) : { projectId: null, keeperThreadId: null, keeperPath: null, classId: "smith", questId: null }, enabled: PLACEMENT_RPC_LIVE && !!hire && !!data });
  const preview = PLACEMENT_RPC_LIVE ? previewQ.data ?? null : null;
  useEffect(() => { if (PLACEMENT_RPC_LIVE && data) void previewQ.refetch(); }, [data?.revision]); // eslint-disable-line react-hooks/exhaustive-deps
  // The open editor survives a remount (the phone layout) and a move between columns: its rule id, or "new", is kept in the panel state.
  const [editKey, setEditKey] = usePanelState<string | null>(EDITING, null, (v) => v === null || typeof v === "string");
  const [, setDraft] = usePanelState<KeptDraft | null>(DRAFT, null, isKeptDraft);
  const gridRef = useRef<HTMLDivElement>(null);
  const [consentFor, setConsentFor] = useState<number | null>(null);
  const [from, setFrom] = useState(!!ruleParam);
  const rawRules = useMemo(() => { if (!invalid || !data?.placementRawJson) return null; try { const v = JSON.parse(data.placementRawJson) as { rules?: unknown }; return Array.isArray(v.rules) ? v.rules as M.Rule[] : null; } catch { return null; } }, [invalid, data?.placementRawJson]);
  const saved = data ? (invalid ? rawRules ?? [] : data.effective.machines.rules) : [];
  const rules = api.saved.sent ?? saved;
  const editIndex = editKey === null ? -2 : indexOfKey(rules, editKey);
  const editing = editIndex >= -1 ? editIndex : null;
  const opened = useRef(-1);
  const setEditing = (i: number | null) => { setDraft(null); opened.current = rules.length; setEditKey(i === null ? null : i < 0 ? "new" : editKeyOf(rules, i)); };
  // A deleted rule's editor closes and its draft goes, so Undo restores the rule without reopening a stale editor. A rule keyed by its
  // place (no unique id) closes on any change to the list's length, since its place may now hold another rule.
  useEffect(() => { if (data && opened.current < 0) opened.current = rules.length; if (data && editKey !== null && editKey !== "new" && (editIndex === -2 || (editKey.startsWith("#") && rules.length !== opened.current))) { setDraft(null); setEditKey(null); } }); // eslint-disable-line react-hooks/exhaustive-deps
  const ruleIndex = ruleParam ? rules.findIndex((r) => r.id === ruleParam) : -1;
  const jumped = useRef(false);
  useEffect(() => { if (!jumped.current && ruleIndex >= 0) { jumped.current = true; requestAnimationFrame(() => focusRule(ruleIndex)); } }, [ruleIndex]);
  const nameOf = (k: Room["keepers"][number]) => memberName(k.member, registry.data ?? { characters: [], classes: [] });
  const keeperName = (id: string) => room.data ? M.keeperWords(room.data, id, nameOf) : id;
  // "on Wren's machine", with what tells two Wrens apart after it, never "'s machine" glued to a thread title.
  const keeperPlace = (id: string) => { if (!room.data) return "the Keeper's machine"; const { name, detail } = M.keeperParts(room.data, id, nameOf); return `${name}'s machine${detail ? ` (${detail})` : ""}`; };
  const invalidTarget = new Set(invalid ? (data?.placementPolicy?.state === "invalid" ? data.placementPolicy.problems : []).map((p) => p.path.match(/^machines\.rules\.(\d+)\.target/)?.[1]).filter((x): x is string => !!x).map(Number) : []);
  const summaryRules = [...new Set(M.placeProblems(api.saved.problems).filter((p) => p.rule !== null).map((p) => p.rule!))].sort((a, b) => a - b);
  const loose = M.placeProblems(api.saved.problems).filter((p) => p.rule === null && p.field !== "maxMakers" && p.field !== "maxCheckers");

  const placedMembers = [...new Map([...(room.data?.keepers.flatMap(k => [k.member, ...k.boardQuests.flatMap(q => q.members), ...k.errands]) ?? []), ...(room.data?.solos ?? [])].filter(m => m.placement && m.placement.phase !== "released").map(m => [m.threadId, m])).values()];
  const wide = useWide(gridRef);
  const editor = editing !== null && data ? <div className="mx-edit-wrap"><Editor key={editKey!} api={api} rules={rules} saved={saved} index={editing} keptKey={editKey!} n={n} room={room.data} classes={classes} onDone={() => setEditing(null)} /></div> : null;
  return <div className="mx">
    <header className="mx-head">
      <h1 className="mx-t">Where work runs <span className="anc">machines</span></h1>
      <p className="mx-intro">Rules match the member's repo. The Keeper can pick a matching rule; its consent, inputs, models and forge apply unchanged. Otherwise the first enabled rule that catches the hire wins. With no rule or pick, only the Keeper's own repo can stay where the Keeper runs. Keepers stay where you run them. A lead runs where its hiring Keeper says.</p>
    </header>
    <p className="sr" role="status" aria-live="polite">{api.undoable || api.announce.endsWith("deleted. Saved.") ? "" : api.announce}</p>
    {from && ruleIndex >= 0 && <div className="tcard mx-from" role="status"><p><b>Opened from a placement rule.</b> Rule {ruleIndex + 1}, {rules[ruleIndex]!.label}, placed this member or caught the hire.</p><button type="button" className="lnk-btn act" onClick={() => setFrom(false)}>Hide</button></div>}
    {api.undoable && <div className="tcard mx-undo" role="status"><span>{api.undoable.text}</span><button type="button" className="btn sm" onClick={() => void api.runUndo()}><Glyph name="undo" size={12} />Undo</button></div>}
    {!api.undoable && api.announce.endsWith("deleted. Saved.") && <p className="mx-done" role="status">{api.announce}</p>}
    {data && !invalid && <ForgeProfiles profiles={data.effective.machines.forges} pending={api.pending} save={forges => api.save({ forges }, "Forge profiles saved.")} />}
    {api.stale && <p className="tv-problem" role="alert">Settings changed somewhere else, so nothing was saved. The latest values are shown; make the change again.</p>}
    {invalid && <div className="tv-problem mx-block" role="alert">
      <p><b>Placement is blocked.</b> Tavern can't read the saved rules, so new members wait instead of running anywhere. Members already running are untouched.</p>
      <ul>{(data?.placementPolicy?.state === "invalid" ? data.placementPolicy.problems : []).map((p) => <li key={p.path}>{p.path.replace(/^machines\.rules\.(\d+)\.?/, (_, i: string) => `Rule ${Number(i) + 1}, `)}{p.message}</li>)}</ul>
      <p>{rawRules ? "Fix the rule below and save, or delete it. Saving replaces the whole list." : "Tavern can't show the stored rules here yet. Start from no rules, or load a fixed settings.toml under Import and export."}</p>
      {!rawRules && <button type="button" className="btn sm" onClick={() => void api.save({ rules: [] }, "Rules replaced with none. Placement works again.")}>Start from no rules</button>}
    </div>}
    {!invalid && api.saved.problems.length > 0 && <div className="tv-problem mx-sum" role="alert">
      <span><b>Tavern didn't save.</b> {plural(api.saved.problems.length, "problem")}, shown at each rule:</span>
      <span className="mx-sum-l">{summaryRules.map((i) => <button key={i} type="button" className="tv-ilink" onClick={() => focusRule(i)}>rule {i + 1}</button>)}{M.placeProblems(api.saved.problems).filter((p) => p.field === "maxMakers" || p.field === "maxCheckers").map((p) => <a key={p.problem.key} className="tv-ilink" href={`#cap-${p.field}`}>{M.problemField(p.field).toLowerCase()}</a>)}</span>
      {loose.map((p) => <ProblemLine key={p.problem.key} p={p.problem} field={M.problemField(p.field)} />)}
      <button type="button" className="lnk-btn act" onClick={api.discard}>Discard these changes</button>
    </div>}
    {!data ? <FoldLoad error={api.query.error} retry={api.query.refetch} label="the placement rules"><div className="mx-grid"><div className="mx-main">{[0, 1, 2].map((i) => <SkCard key={i} lines={3} />)}</div></div></FoldLoad> : <div className="mx-grid" ref={gridRef}>
      <div className="mx-main">
        {placedMembers.length > 0 && <section className="mx-pv mx-members" aria-labelledby="mx-members-h"><h2 id="mx-members-h" className="mx-h">Where members run now</h2><ul>{placedMembers.map(member => <li key={member.threadId}><b>{memberName(member, registry.data ?? { classes: [], characters: [] })}</b><PlacementFacts placement={member.placement} memberName={memberName(member, registry.data ?? { classes: [], characters: [] })} variant="card" /></li>)}</ul></section>}
        <div className="mx-lh"><h2 className="mx-h">Rules <span className="num mx-f">{rules.length}</span></h2><span className="mx-f">checked top to bottom</span>
          <button type="button" className="btn sm mx-addr" onClick={() => setEditing(-1)} disabled={editing !== null || rules.length >= M.MAX_RULES} title={rules.length >= M.MAX_RULES ? "Tavern keeps at most 50 rules." : undefined}><Glyph name="plus" size={12} />Add a rule</button></div>
        {rules.length === 0 && editing === null && <div className="mx-empty"><p><b>Every hire runs where it runs today.</b> Add a rule to send some work elsewhere, for example project work to a new machine.</p></div>}
        {rules.length > 0 && <RuleList api={api} rules={rules} n={n} preview={invalid ? null : preview} editing={editing} onEdit={setEditing} consentFor={consentFor} setConsentFor={setConsentFor} invalidTarget={invalidTarget} />}
        {rules.length > 0 && preview && !invalid && <p className={`mx-fall ${preview.verdict.state === "compatibility" ? "hit" : ""}`}><span className="mx-sm" aria-hidden="true">{preview.verdict.state === "compatibility" ? "✓" : "·"}</span><span>No rule caught it: runs where it runs today</span></p>}
        {!wide && editor}
        <h2 className="mx-h mx-caps-h">How many at once</h2>
        <Caps api={api} settings={data.effective.machines} partyMax={data.effective.keepers.partyMax} />
      </div>
      <aside className="mx-side" aria-label={wide && editor ? "Rule editor" : "Preview"}>
        {wide && editor ? <div><button type="button" className="lnk-btn act mx-back" onClick={() => setEditing(null)}>Back to the preview</button>{editor}</div> : null}
        <section className="mx-pv" hidden={wide && !!editor} aria-labelledby="mx-pv-h">
          <h2 id="mx-pv-h" className="mx-h">Where would a hire run?</h2>
          {!PLACEMENT_RPC_LIVE ? <p className="mx-unavail" role="status"><b>Not available yet.</b> The preview needs a server call Tavern doesn't have yet. Rules you save here are kept.</p>
            : !hire ? <p className="mx-hint">Add a project or start a Keeper to preview a hire.</p>
              : <>
                <HirePicker hire={hire} setHire={setHire} room={room.data} catalog={catalog} classes={classes} keeperName={keeperName} />
                {invalid ? <div className="mx-verdict blocked" role="status" data-verdict="blocked"><p className="mx-vl"><span className="mx-vk">Blocked.</span> Every hire waits until the saved rules can be read again; none falls back to the laptop.</p><p className="mx-vn">Preview only: nothing is created.</p></div>
                  : preview ? <Verdict p={preview} rules={rules} n={n} keeperPlace={keeperPlace} hire={hire} /> : previewQ.error ? <ReadState error={previewQ.error} retry={previewQ.refetch} /> : <p className="mx-hint" role="status">Checking the rules…</p>}
                {preview && !invalid && <p className="mx-pv-n">Each rule in the list shows its answer.</p>}
              </>}
        </section>
      </aside>
    </div>}
  </div>;
}
