import { experimental_useRpcQuery, experimental_useSidebarThreads, useBbContext } from "@get-bb/plugin-sdk/app";
import { Fragment, useId, useState, type ReactNode } from "react";
import { ExpandsMark } from "../kit";
import type { ClassModeFacts } from "../../shared/class-execution-contract";
import { rpcContract } from "../../shared/contract";
import { modelLabel } from "../thread/composer";
import { InlineLink, SegFilter, plural, type Registry } from "./common";
import { PageGlyph } from "./glyphs";
import { usePanelState } from "./panel-state";

type Field = ClassModeFacts["fields"][number];
export type ClassFactsEntry = { classId: string; start: ClassModeFacts; hire: ClassModeFacts };
export type ClassProject = { id: string | null; fromThread: boolean; projects: readonly { id: string; name: string }[]; pick: (id: string | null) => void };

/**
 * Every class's start and hire facts, as the server resolves them (Peter's classExecutions), for the page's project: the thread's,
 * else one the user picked here (remembered for this panel), else none, which gives the baseline with project-dependent fields marked.
 */
export function useClassExecutions() {
  const { projectId } = useBbContext();
  const [picked, pick] = usePanelState<string | null>("classes.project", null, (v) => v === null || typeof v === "string");
  const sidebar = experimental_useSidebarThreads();
  const projects = sidebar.projects ?? [];
  const chosen = projectId ?? (picked && projects.some((p) => p.id === picked) ? picked : null);
  const query = experimental_useRpcQuery({ contract: rpcContract, method: "classExecutions", input: chosen ? { projectId: chosen } : {} });
  const project: ClassProject = { id: chosen, fromThread: !!projectId, projects, pick };
  return Object.assign(query, { project });
}
const dependsOnProject = (facts: ClassModeFacts) => facts.fields.filter((f) => f.dependsOnProject);

const FIELD_WORD: Record<string, string> = { provider: "Provider", model: "Model", reasoning: "Reasoning", permission: "Permission", scope: "Scope", environment: "Environment", "role prompt": "Role prompt", tools: "Tools", characters: "Characters", "party cap": "Party cap", "Ranger minutes": "Ranger time box" };
export const SOURCE_WORD: Record<Field["source"], string> = {
  settings: "Tavern's settings", "project-file": "this project's class file", "user-file": "your class file", "shipped-file": "the shipped class",
  keeper: "the hiring Keeper", "catalog-default": "the provider's catalog", "provider-default": "the provider's default", forced: "Tavern, forced", role: "Tavern, by role", preset: "the scope preset",
};
const VARIES_WORD: Record<NonNullable<Field["varies"]>, string> = { keeper: "Depends on the Keeper that hires it.", maker: "Depends on the maker it checks." };
const KIND_WORD = { start: "thread you start as this class", hire: "hired member" } as const;

/** A model id by its readable name, "Claude Opus 5.5" for anthropic/claude-opus-5-5, with no catalog call: the server's valueLabel wins where it sends one. */
const modelName = (id: string) => modelLabel(id);
/** A start's provider with no class or settings value is whatever the composer picks; the server sends it as provider-default with that rule. */
const fromComposer = (f: Field) => f.field === "provider" && f.source === "provider-default" && !f.value;
/** A field's value in words: character ids become names, counts get their unit, and an unset value says what fills it. */
function valueOf(f: Field, registry: Registry, facts: ClassModeFacts): string {
  if (fromComposer(f)) return "Chosen in the composer";
  if (f.field === "role prompt") return `${facts.body.bytes.toLocaleString("en-GB")} of ${facts.body.limit.toLocaleString("en-GB")} bytes`;
  if (f.field === "characters") {
    if (!f.value || f.value === "None") return "None: no character name";
    return f.value.split(",").map((id) => registry.characters.find((c) => c.id === id.trim())?.name ?? id.trim()).join(", ");
  }
  if (f.field === "party cap" && f.value) return plural(Number(f.value), "member");
  if (f.valueLabel) return f.valueLabel;
  if (f.field === "model" && f.value) return modelName(f.value);
  if (f.field === "Ranger minutes" && f.value) return `${f.value} min`;
  if (f.value) return f.value;
  return f.varies ? "Set when it's hired" : f.source === "provider-default" ? "The provider's default" : "Not set";
}

/** A value the hiring Keeper decides, with nothing set here: one line says so, instead of a value, a source and a rule that repeat it. */
const byKeeper = (f: Field) => f.varies === "keeper" && !f.value;
/** A value Tavern forces for a reason it states (the class's guard requires Pi): the reason is the source, said once. */
const forcedWhy = (f: Field) => f.source === "forced" && f.rule ? f.rule.charAt(0).toLowerCase() + f.rule.slice(1).replace(/\.$/, "") : null;
function FieldRow({ f, facts, registry, mode }: { f: Field; facts: ClassModeFacts; registry: Registry; mode: "start" | "hire" }) {
  const prompt = f.field === "role prompt";
  const over = prompt && facts.body.bytes > facts.body.limit;
  return <Fragment>
    <dt>{FIELD_WORD[f.field] ?? f.field}</dt>
    <dd data-field={f.field}>
      <span className={`tv-cf-v ${over ? "bad" : ""}`} data-content title={(f.valueLabel || f.field === "model") && f.value ? f.value : undefined}>{byKeeper(f) ? "Set by the Keeper that hires it." : valueOf(f, registry, facts)}</span>
      {!byKeeper(f) && <span className="tv-cf-src m small" title={f.path}>{forcedWhy(f) ?? <>from {fromComposer(f) ? "the composer, when you start it" : SOURCE_WORD[f.source]}</>}{f.path ? <> · <code>{f.path.replace(/^\/(Users|home)\/[^/]+/, "~")}</code></> : null}</span>}
      {f.substitution && <span className="tv-cf-sub small" data-sub><PageGlyph name="note" size={12} /><span>instead of <b data-content title={f.field === "model" && f.substitution.from.includes("-") ? f.substitution.from : undefined}>{f.field === "model" && f.substitution.from.includes("-") ? modelName(f.substitution.from) : f.substitution.from}</b>: <span data-content>{f.substitution.reason}</span></span></span>}
      {f.varies && !byKeeper(f) && <span className="tv-cf-rule m small">{VARIES_WORD[f.varies]}</span>}
      {f.dependsOnProject && <span className="tv-cf-rule m small" data-depends>{f.value ? "Without a project's own class file; one could change it." : "A project's class file could set it."}</span>}
      {f.rule && !prompt && !fromComposer(f) && !forcedWhy(f) && <span className="tv-cf-rule m small" data-content>{f.rule}</span>}
      {prompt && f.rule && <RulesFold className="tv-cf-rules" summary={`Tavern's own rules, added to every ${KIND_WORD[mode]}`}><p className="tv-cf-rulestext" data-content>{f.rule}</p></RulesFold>}
    </dd>
  </Fragment>;
}

/** A closed fold of read-only text, with the mark that says it opens in place. */
export function RulesFold({ summary, className, children }: { summary: string; className: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <details className={className} open={open} onToggle={(e) => { const now = (e.currentTarget as HTMLDetailsElement).open; if (now !== open) setOpen(now); }}><summary><span>{summary}</span><ExpandsMark open={open} /></summary>{children}</details>;
}

/**
 * What a hire or a start of this class actually gets, field by field, with where each value comes from: the server's resolution
 * (classExecutions), not the class file's own words. Nothing here is editable; the editor and Settings change it.
 */
/** No project yet: say the answer depends on one, and let the user pick it here. */
export function ProjectPick({ project, fields }: { project: ClassProject; fields: readonly string[] }) {
  const id = useId();
  if (project.fromThread) return null;
  return <div className="tv-cf-note tv-cf-project" data-needs-project>
    <PageGlyph name="note" size={13} />
    <span><label htmlFor={id}>{project.id ? "Facts for the project:" : "This depends on the project. Open it from a thread in that project, or pick one:"}</label>
      {" "}<select id={id} className="tv-select" value={project.id ?? ""} onChange={(e) => project.pick(e.target.value || null)}>
        <option value="">{project.id ? "No project (shipped and your files only)" : "Pick a project"}</option>
        {project.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      {!project.id && fields.length > 0 && <span className="m small tv-cf-fields"> A project's class file could change: {fields.map((f) => FIELD_WORD[f]?.toLowerCase() ?? f).join(", ")}.</span>}
    </span>
  </div>;
}

/**
 * A tab for a mode the class can't run in, decided from the registry's flags rather than the server's error text: one line, and a
 * pointer to the tab that applies, instead of facts for something that never happens.
 */
function CannotRun({ label, mode, other, onOther }: { label: string; mode: "hire" | "start"; other: boolean; onOther: () => void }) {
  if (!other) return <div className="tv-cf-cannot" data-cannot><p>{label} can't be started or hired here.</p></div>;
  // The pointer is its own line and one link, so it never breaks after "See"; it switches the tab in this card, so it has no mark.
  return <div className="tv-cf-cannot" data-cannot>
    <p>{mode === "hire" ? `${label}s aren't hired; they're started.` : `${label}s aren't started; they're hired.`}</p>
    <p><InlineLink onClick={onOther} title={`Show what it gets ${mode === "hire" ? "when you start it" : "on hire"}`}>{mode === "hire" ? "See When you start it" : "See On hire"}</InlineLink></p>
  </div>;
}

export function ClassFacts({ entry, registry, label, hireable, startable, project }: { entry: ClassFactsEntry; registry: Registry; label: string; hireable: boolean; startable: boolean; project?: ClassProject }) {
  const [mode, setMode] = useState<"hire" | "start">(hireable || !startable ? "hire" : "start");
  const runs = mode === "hire" ? hireable : startable;
  const facts = entry[mode];
  const overrides = facts.projectOverrides;
  const overridePath = overrides[0]?.path.replace(/^\/(Users|home)\/[^/]+/, "~");
  return <section className="tv-card tv-cdsec tv-cfacts" aria-labelledby="tv-cf-h">
    <header className="tv-colh"><h2 id="tv-cf-h">What it gets</h2><span className="tv-sp" />
      <SegFilter label="What it gets when" value={mode} onChange={setMode} options={[{ id: "hire", label: "On hire" }, { id: "start", label: "When you start it" }]} />
    </header>
    {!runs ? <CannotRun label={label} mode={mode} other={mode === "hire" ? startable : hireable} onOther={() => setMode(mode === "hire" ? "start" : "hire")} /> : <>
    {project && (dependsOnProject(facts).length > 0 || (project.id && !project.fromThread)) && <ProjectPick project={project} fields={dependsOnProject(facts).map((f) => f.field)} />}
    {facts.errors.length > 0 && <ul className="tv-problem tv-cf-errs" aria-label={mode === "hire" ? "Why it can't be hired" : "Why it can't be started"}>{facts.errors.map((e) => <li key={e} data-content>{e}</li>)}</ul>}
    {facts.requiresPi && <p className="tv-cf-note tv-cf-pi"><PageGlyph name="shield" size={13} /><span>Needs Pi: only Pi lets Tavern block a command before it runs, so {mode === "hire" ? "a hire" : "a start"} on another provider is refused.</span></p>}
    {overrides.length > 0 && <p className="tv-cf-note tv-cf-over" data-override><PageGlyph name="note" size={13} /><span>This project's {label} file replaces the whole class, including {overrides.map((o) => o.field).join(", ")}. Review <code>{overridePath}</code> before starting or hiring.</span></p>}
    <dl className="tv-dl tv-cf-dl">{facts.fields.map((f) => <FieldRow key={f.field} f={f} facts={facts} registry={registry} mode={mode} />)}</dl>
    {facts.notes.length > 0 && <ul className="tv-cf-notes m small" aria-label="Notes from resolving it">{facts.notes.map((n) => <li key={n} data-content>{n}</li>)}</ul>}
    </>}
  </section>;
}

/**
 * The list's Model column for one class. Loaded facts give the resolved model, by its readable name with the raw id in the title,
 * and say where it comes from. Without facts (loading, a failed call, or a class whose facts have errors), it shows only what is
 * known, the class file's model marked "(class file)", else "unknown" with the reason in the title; never a guessed "provider default".
 */
export function modelCell(entry: ClassFactsEntry | undefined, classFile: string | null, failure: string | null, runs: { hireable: boolean; startable: boolean } = { hireable: true, startable: true }): { text: string; note: string | null; title: string | undefined } {
  const unknown = (why: string | null) => classFile ? { text: modelName(classFile), note: "(class file)", title: [classFile, why].filter(Boolean).join(". ") } : { text: "unknown", note: null, title: why ?? "Tavern hasn't answered yet" };
  if (!entry) return unknown(failure ? `Couldn't load what a hire gets: ${failure}` : null);
  // The mode the class runs in: a hire if it can be hired, else a start (the Keeper), decided by its flags, not by which facts carry errors.
  const facts = runs.hireable || !runs.startable ? entry.hire : entry.start;
  const fields = facts.fields;
  const model = fields.find((f) => f.field === "model");
  if (facts.errors.length && !model?.value) return unknown(facts.errors.join(" "));
  if (!model) return unknown(null);
  const reasoning = fields.find((f) => f.field === "reasoning")?.value;
  const name = model.valueLabel ?? (model.value ? modelName(model.value) : null);
  const text = name ?? (model.varies === "maker" ? "depends on the maker" : model.varies === "keeper" ? "depends on the Keeper" : model.dependsOnProject ? "depends on the project" : model.source === "provider-default" ? "the provider's default" : "unknown");
  const note = model.substitution ? `instead of ${model.substitution.from.includes("-") ? modelName(model.substitution.from) : model.substitution.from}` : model.dependsOnProject && name ? "depends on the project" : null;
  return { text: `${text}${reasoning ? ` · ${reasoning}` : ""}`, note, title: model.value ? `${model.value}, from ${SOURCE_WORD[model.source]}` : undefined };
}
