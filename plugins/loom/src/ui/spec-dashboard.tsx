import { useRef, useState } from "react";
import type { ProjectView, SpecVersionView } from "../contract";
import { wavesOf, type SpecChanges } from "../spec-paths";
import { BUTTON, plural, useRemote } from "./common";
import { MarksContext, modelLabel, type Marks, type NoteTarget } from "./spec-marks";
import { NoteComposer, NoteTray, useNoteTray } from "./spec-notes";
import { ChecksPane, FilesPane, ProjectPane } from "./spec-panes";
import { Inspector, TicketsPane } from "./spec-tickets";

type Tab = "tickets" | "files" | "checks" | "project";
const TABS: ReadonlyArray<{ tab: Tab; label: string }> = [
  { tab: "tickets", label: "Tickets" },
  { tab: "files", label: "Files" },
  { tab: "checks", label: "Checks & review" },
  { tab: "project", label: "Project & limits" },
];

/** bb's name for each bb project id a project view's repos name; the spec versions carry only the ids. */
export function bbProjectNamesOf(view: ProjectView | null): Record<string, string> {
  if (view === null) return {};
  const repos = [...view.overview.repos, ...view.spec.summary.repos];
  return Object.fromEntries(repos.flatMap((repo) => (repo.bbProjectName === null ? [] : [[repo.bbProjectId, repo.bbProjectName]])));
}

/** A spec as a dashboard: its versions, a summary strip, four views of it and notes for the planner. `readOnly` opens at `version` and takes no notes: the dashboard of a rewound page. */
export function SpecDashboard({ slug, version, readOnly = false, bbProjectNames = {} }: { slug: string; version?: number; readOnly?: boolean; bbProjectNames?: Readonly<Record<string, string>> }) {
  return <Dashboard key={`${slug} ${version ?? "latest"} ${readOnly}`} slug={slug} pinned={version ?? null} readOnly={readOnly} bbProjectNames={bbProjectNames} />;
}

function Dashboard({ slug, pinned, readOnly, bbProjectNames }: { slug: string; pinned: number | null; readOnly: boolean; bbProjectNames: Readonly<Record<string, string>> }) {
  // null follows the newest version as the planner proposes.
  const [version, setVersion] = useState<number | null>(pinned);
  const remote = useRemote((rpc) => rpc.call("specVersion", version === null ? { slug } : { slug, version }), `spec:${slug}:${version ?? "latest"}`, slug);
  const [tab, setTab] = useState<Tab>("tickets");
  const [raw, setRaw] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  // Whether the chosen ticket is highlighted: its dependency chain on Tickets, its paths on Files.
  const [lit, setLit] = useState(false);
  const [target, setTarget] = useState<NoteTarget | null>(null);
  const tray = useNoteTray(slug);
  const inspector = useRef<HTMLDivElement>(null);
  const view = remote.data;
  if (view === null) {
    return remote.error === null ? <p role="status" className="text-sm text-muted-foreground">Loading the spec…</p> : <p role="alert" className="text-sm text-destructive-text">Could not load the spec: {remote.error}</p>;
  }
  const newest = view.versions.at(-1)!.version;
  const known = view.spec.ticket.some((ticket) => ticket.ref === chosen);
  const selected = known ? chosen! : view.spec.ticket[0]!.ref;
  const highlighted = lit && known ? selected : null;
  const pick = (ref: string) => {
    if (ref === highlighted) return setLit(false);
    setChosen(ref);
    setLit(true);
  };
  const marks: Marks = { version: view.version, changes: view.changes, notePaths: tray.notes.map((note) => note.paths[0]!), onNote: readOnly ? undefined : setTarget };
  const sent = (next: SpecVersionView) => {
    tray.clear();
    if (version === null) remote.set(next);
    else setVersion(null);
  };

  return (
    <MarksContext.Provider value={marks}>
      <section data-spec-dashboard className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">Spec</h2>
          <div role="group" aria-label="Spec versions" className="inline-flex flex-wrap gap-0.5 rounded-md border border-border-seam p-0.5">
            {view.versions.map((entry) => (
              <button
                key={entry.version}
                type="button"
                aria-pressed={entry.version === view.version}
                onClick={() => setVersion(entry.version === newest ? null : entry.version)}
                className={`cursor-pointer rounded px-2 py-0.5 text-xs ${entry.version === view.version ? "bg-surface-selected font-semibold text-foreground" : "text-muted-foreground hover:bg-state-hover"}`}
              >
                v{entry.version} <span className="font-normal text-muted-foreground">{entry.status}</span>
              </button>
            ))}
          </div>
          <button type="button" className={`${BUTTON} ml-auto`} aria-expanded={raw} onClick={() => setRaw(!raw)}>
            Read the raw spec
          </button>
        </div>
        {raw && <pre data-spec-raw className="overflow-x-auto rounded-md border border-border-seam p-3 text-xs leading-relaxed">{view.toml}</pre>}
        <Banner view={view} newest={newest} onNewest={() => setVersion(null)} />
        <Strip view={view} />
        <div className={`grid gap-4 ${readOnly ? "" : "lg:grid-cols-[minmax(0,1fr)_22rem]"}`}>
          <div data-spec-main className="min-w-0 space-y-3">
            <div role="tablist" aria-label="Spec" className="flex gap-1 border-b border-border-seam">
              {TABS.map((entry) => (
                <button key={entry.tab} type="button" role="tab" aria-selected={tab === entry.tab} onClick={() => setTab(entry.tab)} className={`cursor-pointer rounded-t-md px-3 py-1.5 text-xs ${tab === entry.tab ? "bg-surface-selected text-foreground" : "text-muted-foreground hover:bg-state-hover"}`}>
                  {entry.label}
                </button>
              ))}
            </div>
            <div role="tabpanel" className="min-w-0">
              {tab === "tickets" && (
                <TicketsPane
                  view={view}
                  selected={selected}
                  highlighted={highlighted}
                  onPick={(ref) => {
                    // Selecting a card brings its details into view; the second click only clears the highlight.
                    if (ref !== highlighted) inspector.current!.scrollIntoView({ block: "nearest", behavior: "smooth" });
                    pick(ref);
                  }}
                  onClear={() => setLit(false)}
                />
              )}
              {tab === "files" && <FilesPane view={view} highlighted={highlighted} onPick={pick} onClear={() => setLit(false)} />}
              {tab === "checks" && <ChecksPane view={view} />}
              {tab === "project" && <ProjectPane view={view} bbProjectNames={bbProjectNames} />}
            </div>
            <div ref={inspector}>
              <Inspector view={view} selected={selected} onPick={pick} />
            </div>
          </div>
          {/* Sticky, so a note started far down the waves opens beside it instead of scrolling the page back up. */}
          {!readOnly && (
            <aside data-notes-column className="min-w-0 space-y-3 lg:sticky lg:top-3 lg:max-h-[calc(100dvh-8rem)] lg:self-start lg:overflow-y-auto">
              {target !== null && (
                <NoteComposer
                  key={`${target.paths[0]} ${target.label}`}
                  target={target}
                  onCancel={() => setTarget(null)}
                  onAdd={(body) => {
                    tray.add({ version: view.version, paths: target.paths, label: target.label, body });
                    setTarget(null);
                  }}
                />
              )}
              <NoteTray view={view} notes={tray.notes} onRemove={tray.remove} onSent={sent} />
            </aside>
          )}
        </div>
      </section>
    </MarksContext.Provider>
  );
}

/** "v2 changes 1 ticket and 2 settings from v1, and removes csv-docs." */
function changeSummary(version: number, { changed, removed }: SpecChanges): string {
  const refs = new Set(changed.map((path) => /^ticket\[([^\]]+)\]/.exec(path)?.[1]).filter((ref) => ref !== undefined));
  const settings = changed.filter((path) => !path.startsWith("ticket[")).length;
  const counted = [...(refs.size > 0 ? [plural(refs.size, "ticket")] : []), ...(settings > 0 ? [plural(settings, "setting")] : [])].join(" and ");
  const before = `v${version - 1}`;
  if (counted === "" && removed.length === 0) return `v${version} changes only the order of the tickets from ${before}.`;
  if (counted === "") return `v${version} removes ${removed.join(", ")} from ${before}.`;
  return `v${version} changes ${counted} from ${before}${removed.length === 0 ? "" : `, and removes ${removed.join(", ")}`}.`;
}

function Banner({ view, newest, onNewest }: { view: SpecVersionView; newest: number; onNewest(): void }) {
  if (view.version === newest && view.changes === null) return null;
  return (
    <div data-spec-banner className="space-y-1 rounded-md border border-border-seam px-3 py-2 text-xs">
      {view.version !== newest && (
        <p className="flex flex-wrap items-center gap-2">
          You are reading v{view.version} ({view.status}).
          <button type="button" className={`${BUTTON} ml-auto`} onClick={onNewest}>
            Back to v{newest}
          </button>
        </p>
      )}
      {view.changes !== null && (
        <p>
          {changeSummary(view.version, view.changes)} Each changed part is marked <span className="text-primary">changed</span>.
        </p>
      )}
    </div>
  );
}

function Strip({ view }: { view: SpecVersionView }) {
  const { spec } = view;
  const tickets = spec.ticket.length;
  const waves = Math.max(...Object.values(wavesOf(spec.ticket))) + 1;
  const ownVerify = spec.ticket.filter((ticket) => ticket.verify.length > 0).length;
  const tiles: Array<{ label: string; value: string; note: string; warn?: boolean }> = [
    { label: "Tickets", value: String(tickets), note: `${spec.ticket.filter((ticket) => ticket.priority <= 1).length} high priority` },
    { label: "Waves", value: String(waves), note: `up to ${plural(spec.agents.max_workers, "worker")} at a time` },
    { label: "Checks", value: String(spec.checks.commands.length), note: spec.checks.after_merge.length === 0 ? "on every ticket" : `+${spec.checks.after_merge.length} after merge` },
    { label: "Own verify", value: `${ownVerify}/${tickets}`, note: ownVerify === tickets ? "every ticket" : `${tickets - ownVerify} ${tickets - ownVerify === 1 ? "relies" : "rely"} on the checks only` },
    { label: "Review", value: modelLabel(spec.agents.reviewer), note: `${plural(spec.review.approvals, "approval")}, up to ${plural(spec.review.max_rounds, "round")}` },
    { label: "Warnings", value: String(view.warnings.length), note: view.warnings.length === 0 ? "none" : "see Tickets", warn: view.warnings.length > 0 },
  ];
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {tiles.map((tile) => (
        <div key={tile.label} data-spec-tile className="rounded-md border border-border-seam px-3 py-2">
          <dt className="text-[10.5px] font-semibold tracking-wider text-subtle-foreground uppercase">{tile.label}</dt>
          <dd className={`truncate text-base font-semibold tabular-nums ${tile.warn === true ? "text-warning-text" : ""}`}>{tile.value}</dd>
          <dd className="truncate text-[11px] text-muted-foreground">{tile.note}</dd>
        </div>
      ))}
    </dl>
  );
}
