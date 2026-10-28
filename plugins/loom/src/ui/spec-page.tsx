import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ProjectView, SpecReviewRound, SpecVersionView } from "../contract";
import { sectionOf, specDiff, touches, type SpecChange, type SpecSection } from "../spec-diff";
import { WHOLE_SPEC, isUnder, pathNamesOf, specChanges } from "../spec-paths";
import type { SpecFinding, SpecReviewStatus } from "../spec-review";
import { SPEC_REVIEW_ROUNDS } from "../states";
import { BUTTON, HEADING, plural, useLoom } from "./common";
import { CommentBox, ReviewPanel } from "./spec-comments";
import { GuardrailsSection } from "./spec-guardrails";
import { MarksContext, type Marks } from "./spec-marks";
import { useNoteTray, type DraftNote } from "./spec-notes";
import { ReviewContext, changeText, formatValue, labelOf, type CommentTarget, type Review, type ReviewFinding } from "./spec-review-kit";
import { SettingsSection } from "./spec-settings";
import { REMOVED, TicketsSection, type TicketLayout } from "./spec-ticket-view";

const SECTIONS: ReadonlyArray<{ section: SpecSection; title: string; text: string }> = [
  { section: "settings", title: "How it runs", text: "The settings Loom follows for every ticket. Click a value to comment on it, or another option to suggest it." },
  { section: "tickets", title: "Tickets", text: "Pick a ticket to read it, and comment on its brief, a criterion, a file or a command." },
  { section: "guardrails", title: "Goal & guardrails", text: "What the project is for, what it leaves out, and what every reviewer checks." },
];
const domId = (section: SpecSection) => `spec-${section}`;
const changeKey = (change: SpecChange) => `${change.kind}:${change.path}`;
const editable = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** Which changes the human has seen and which sections they marked reviewed, per version and compared version, kept in this browser. */
function useReviewMarks(slug: string, key: string) {
  const storageKey = `loom.review.${slug}`;
  const read = (): Record<string, { seen: string[]; reviewed: string[] }> => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
      return saved !== null && typeof saved === "object" ? (saved as Record<string, { seen: string[]; reviewed: string[] }>) : {};
    } catch {
      return {};
    }
  };
  const [all, setAll] = useState(read);
  const mine = all[key] ?? { seen: [], reviewed: [] };
  const write = (next: { seen: string[]; reviewed: string[] }) => {
    const updated = { ...all, [key]: next };
    setAll(updated);
    try {
      localStorage.setItem(storageKey, JSON.stringify(updated));
    } catch {}
  };
  return {
    seen: new Set(mine.seen),
    reviewed: new Set(mine.reviewed),
    see: (ids: readonly string[]) => write({ ...mine, seen: [...new Set([...mine.seen, ...ids])] }),
    unsee: (id: string) => write({ ...mine, seen: mine.seen.filter((one) => one !== id) }),
    review: (section: string, on: boolean) => write({ ...mine, reviewed: on ? [...new Set([...mine.reviewed, section])] : mine.reviewed.filter((one) => one !== section) }),
  };
}

/** The element that shows `path` best: the part itself, else a part inside it, else the part it is in, else its card. */
function elementFor(root: HTMLElement, path: string): HTMLElement | null {
  const targets = [...root.querySelectorAll<HTMLElement>("[data-comment-target]")].map((element) => ({ element, paths: (element.dataset.commentPaths ?? element.dataset.commentTarget!).split(" ") }));
  const exact = targets.find(({ element }) => element.dataset.commentTarget === path) ?? targets.find(({ paths }) => paths.includes(path));
  if (exact !== undefined) return exact.element;
  const inside = targets.find(({ paths }) => paths.some((one) => isUnder(one, path)));
  if (inside !== undefined) return inside.element;
  const around = targets
    .flatMap(({ element, paths }) => paths.filter((one) => isUnder(path, one)).map((one) => ({ element, length: one.length })))
    .sort((a, b) => b.length - a.length)[0];
  if (around !== undefined) return around.element;
  return [...root.querySelectorAll<HTMLElement>("[data-anchor]")].find((element) => element.dataset.anchor!.split(" ").some((one) => touches({ path }, one))) ?? null;
}

/**
 * Loom's spec review of the version on screen: each finding with the part it is about, pinned there as R1, R2…, and a
 * jump to it. It stays after approval, so a version keeps its review. `status` covers a version no review ran for.
 */
function LoomReview({ rounds, status, version, labelFor, onGo }: { rounds: readonly SpecReviewRound[]; status: SpecReviewStatus | null; version: number; labelFor(path: string): string; onGo(path: string): void }) {
  const latest = rounds.at(-1);
  const stopped = status?.kind === "limit" && status.version === version;
  const box = (tone: string, children: ReactNode) => (
    <section data-spec-review-status={latest?.state ?? status?.kind} aria-label="Loom's spec review" className={`space-y-1.5 rounded-md border px-3 py-2 text-xs ${tone}`}>
      {children}
    </section>
  );
  const list = (findings: readonly SpecFinding[]) => (
    <ol data-spec-findings className="space-y-1">
      {findings.map((finding, index) => (
        <li key={index} data-finding={index + 1} className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-baseline gap-2">
          <span className="inline-flex h-4 items-center justify-center rounded-full border border-attention bg-attention/15 text-[10px] font-semibold">R{index + 1}</span>
          <details className="min-w-0">
            <summary className="cursor-pointer text-sm [overflow-wrap:anywhere]">
              {finding.path !== undefined && <span className="mr-1 text-xs text-muted-foreground">{labelFor(finding.path)}:</span>}
              {finding.title}
            </summary>
            <p className="mt-1 text-xs whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{finding.detail}</p>
          </details>
          {finding.path !== undefined && (
            <button type="button" className={BUTTON} onClick={() => onGo(finding.path!)}>
              Go to it
            </button>
          )}
        </li>
      ))}
    </ol>
  );
  if (latest === undefined) {
    if (status?.kind === "failed" && status.version === version) return box("border-destructive-text/40 bg-destructive-text/5", <p className="[overflow-wrap:anywhere]"><b>Loom's spec review of v{version} did not finish:</b> {status.reason}.</p>);
    if (stopped) return box("border-warning/50 bg-warning/10", <><p><b>Loom stopped reviewing after {SPEC_REVIEW_ROUNDS} rounds</b>; these findings of the last round are still open.</p>{list(status.findings)}</>);
    return null;
  }
  const earlier = rounds.length > 1 ? <p className="text-subtle-foreground">Earlier rounds of v{version}: {rounds.slice(0, -1).map((round) => (round.state === "skipped" ? "skipped" : `round ${round.round} ${round.state === "approved" ? "passed" : round.state === "changes_requested" ? `found ${plural(round.findings.length, "problem")}` : "did not finish"}`)).join(", ")}.</p> : null;
  const summary = latest.summary !== null && latest.summary !== "" ? (
    <details>
      <summary className="cursor-pointer text-muted-foreground">The reviewer's summary</summary>
      <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{latest.summary}</p>
    </details>
  ) : null;
  switch (latest.state) {
    case "reviewing":
      return box("border-primary/40 bg-primary/5", <p><b>Loom is reviewing v{version}</b> (round {latest.round} of {SPEC_REVIEW_ROUNDS}). The planner revises it for each finding before it asks you.</p>);
    case "approved":
      return box("border-border-seam bg-card", <><p><b className="text-success">✓ Loom's spec review passed v{version}</b> · round {latest.round} of {SPEC_REVIEW_ROUNDS}</p>{summary}{earlier}</>);
    case "changes_requested":
      return box(
        "border-attention/50 bg-attention/5",
        <>
          <p>
            <b>Loom's spec review found {plural(latest.findings.length, "problem")} in v{version}</b> · round {latest.round} of {SPEC_REVIEW_ROUNDS}.{" "}
            {stopped ? "It stopped reviewing after this round, so they stay open; the planner's chat says which it left open and why." : "The planner revises the spec for them; each is pinned on its part."}
          </p>
          {list(latest.findings)}
          {summary}
          {earlier}
        </>,
      );
    case "failed":
      return box("border-destructive-text/40 bg-destructive-text/5", <><p className="[overflow-wrap:anywhere]"><b>Loom's spec review of v{version} did not finish:</b> {latest.reason ?? "no reason recorded"}.</p>{earlier}</>);
    case "skipped":
      return box(
        "border-border-seam bg-card",
        <>
          <p>
            <b>Loom skipped the spec review of v{version}</b>: against v{latest.skip?.against ?? version - 1}, it changes only operational settings, which say how Loom runs the project and not what it builds. You still approve it.
          </p>
          {latest.skip !== null && <p data-skipped-paths className="font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{latest.skip.paths.map(labelFor).join(" · ")}</p>}
          {earlier}
        </>,
      );
  }
}

/** The change's old and new value, or what it did, for its row in "What changed". */
function ChangeLine({ change }: { change: SpecChange }) {
  if (change.kind === "value") {
    return (
      <>
        <s className="text-destructive-text">{formatValue(change.before)}</s> <span aria-hidden>→</span> <b className="font-semibold text-success">{formatValue(change.after)}</b>
      </>
    );
  }
  return <>{changeText(change)}</>;
}

/** bb's name for each bb project id a project view's repos name; the spec versions carry only the ids. */
export function bbProjectNamesOf(view: ProjectView | null): Record<string, string> {
  if (view === null) return {};
  const repos = [...view.overview.repos, ...view.spec.summary.repos];
  return Object.fromEntries(repos.flatMap((repo) => (repo.bbProjectName === null ? [] : [[repo.bbProjectId, repo.bbProjectName]])));
}

/** The Approve the review panel offers, for one version. */
export interface SpecApprove {
  version: number;
  label: string;
  busy: boolean;
  onApprove(): void;
}

/**
 * A version of the spec for the human to review: how the project runs, its tickets, and its goal and guardrails, with
 * what changed from the version it is compared with, a comment on any part, and one message to the planner. `readOnly`
 * opens at `version` and takes no comments: the page of a rewound project.
 */
export function SpecPage(props: { slug: string; version?: number; readOnly?: boolean; bbProjectNames?: Readonly<Record<string, string>>; specReview?: SpecReviewStatus | null; approve?: SpecApprove | null }) {
  return <Page key={`${props.slug} ${props.version ?? "latest"} ${props.readOnly === true}`} {...props} />;
}

function Page({ slug, version: pinned, readOnly = false, bbProjectNames = {}, specReview = null, approve = null }: Parameters<typeof SpecPage>[0]) {
  const [version, setVersion] = useState<number | null>(pinned ?? null);
  const [base, setBase] = useState<number | null>(null);
  const input = { slug, ...(version === null ? {} : { version }), ...(base === null ? {} : { base }) };
  const remote = useLoom("specVersion", input);
  // Here, above the version on screen, so notes kept only in memory survive a switch of version or compared version.
  const tray = useNoteTray(slug);
  const view = remote.data;
  return view === undefined ? (
    remote.error === null ? (
      <p role="status" className="text-sm text-muted-foreground">Loading the spec…</p>
    ) : (
      <p role="alert" className="text-sm text-destructive-text">Could not load the spec: {remote.error}</p>
    )
  ) : (
    <Loaded
      key={`${view.version}<${view.compared?.version ?? "none"}`}
      view={view}
      tray={tray}
      readOnly={readOnly}
      bbProjectNames={bbProjectNames}
      specReview={specReview}
      approve={approve}
      onVersion={(next) => {
        setBase(null);
        setVersion(next === view.versions.at(-1)!.version ? null : next);
      }}
      onBase={(next) => setBase(next)}
      // The newest version refreshes when the server takes the notes; a page on another version goes back to the newest.
      onSent={() => {
        setVersion(null);
        setBase(null);
      }}
    />
  );
}

function Loaded({
  view,
  tray,
  readOnly,
  bbProjectNames,
  specReview,
  approve,
  onVersion,
  onBase,
  onSent,
}: {
  view: SpecVersionView;
  tray: ReturnType<typeof useNoteTray>;
  readOnly: boolean;
  bbProjectNames: Readonly<Record<string, string>>;
  specReview: SpecReviewStatus | null;
  approve: SpecApprove | null;
  onVersion(version: number): void;
  onBase(base: number): void;
  onSent(view: SpecVersionView): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  // Where the last press landed: the Files view's "+ note" buttons say what to comment on, not where they are, and Safari does not focus a clicked button.
  const pressed = useRef<HTMLElement | null>(null);
  const changes = useMemo(() => (view.compared === null ? [] : specDiff(view.compared.spec, view.spec)), [view]);
  const comparedChanges = useMemo(() => (view.compared === null ? null : specChanges(view.compared.spec, view.spec)), [view]);
  const marks = useReviewMarks(view.slug, view.compared === null ? `v${view.version}` : `v${view.version}<v${view.compared.version}`);
  const newest = view.versions.at(-1)!;
  const waitsForYou = view.status === "draft" || view.status === "pending";
  const [filter, setFilter] = useState<"changes" | "all">(view.compared !== null && !readOnly && waitsForYou ? "changes" : "all");
  const only = filter === "changes" && view.compared !== null;
  const [shown, setShown] = useState<ReadonlySet<SpecSection>>(new Set());
  const [layout, setLayout] = useState<TicketLayout>("list");
  const [selected, setSelected] = useState<string | null>(null);
  const [cursor, setCursor] = useState(-1);
  const [listOpen, setListOpen] = useState(true);
  const [box, setBox] = useState<{ target: CommentTarget; index: number | null; top: number; left: number; anchor: HTMLElement | null } | null>(null);
  const boxNow = useRef(box);
  boxNow.current = box;
  const [jump, setJump] = useState<{ path: string; nonce: number } | null>(null);
  const [edit, setEdit] = useState<{ index: number; anchor: HTMLElement } | null>(null);
  const names = pathNamesOf(view.spec);
  const labelFor = (path: string) => labelOf(path, names);
  const ownRounds = view.reviews.filter((round) => round.version === view.version);
  const lastRound = ownRounds.at(-1);
  const findings: ReviewFinding[] = lastRound?.state === "changes_requested" ? lastRound.findings.map((finding, index) => ({ n: index + 1, path: finding.path ?? null, title: finding.title, detail: finding.detail })) : [];

  // Set by the panel's Edit just before it opens the box on the note's part.
  const editing = useRef<number | null>(null);
  const openComment = useCallback(
    (target: CommentTarget, anchor: HTMLElement | null) => {
      const frame = root.current!.getBoundingClientRect();
      const at = anchor?.getBoundingClientRect() ?? { left: frame.left + 12, bottom: frame.top + 12 };
      const existing = editing.current ?? tray.notes.findIndex((note) => note.paths[0] === target.paths[0]);
      editing.current = null;
      setBox({ target, index: existing === -1 ? null : existing, top: at.bottom - frame.top + 6, left: Math.max(8, Math.min(at.left - frame.left, frame.width - 368)), anchor });
    },
    [tray.notes],
  );
  const closeBox = useCallback(() => {
    const anchor = boxNow.current?.anchor;
    setBox(null);
    if (anchor?.isConnected === true) anchor.focus({ preventScroll: true });
  }, []);
  const sectionReview = (section: SpecSection): Review => ({ version: view.version, changes, only: only && !shown.has(section), notes: tray.notes, findings, onComment: readOnly ? undefined : openComment });
  const filesMarks: Marks = {
    version: view.version,
    changes: comparedChanges,
    notePaths: tray.notes.map((note) => note.paths[0]!),
    onNote: readOnly
      ? undefined
      : (target) => {
          const focused = document.activeElement;
          openComment({ paths: target.paths, label: target.label, kind: "file" }, focused instanceof HTMLElement && focused !== root.current && root.current?.contains(focused) ? focused : pressed.current);
        },
  };
  const filesView = { ...view, changes: comparedChanges };

  // Scroll to a part once the render that shows it is done.
  useEffect(() => {
    if (jump === null || root.current === null) return;
    const element = elementFor(root.current, jump.path);
    element?.scrollIntoView({ behavior: "smooth", block: "center" });
    element?.animate?.([{ boxShadow: "0 0 0 3px var(--primary)" }, { boxShadow: "0 0 0 0 transparent" }], { duration: 1600, easing: "ease-out" });
  }, [jump]);

  // Once the render that shows the note's part is done, open the box there; a part the page does not draw gets a plain box.
  useEffect(() => {
    if (edit === null || root.current === null) return;
    setEdit(null);
    const note = tray.notes[edit.index];
    if (note === undefined) return;
    const element = [...root.current.querySelectorAll<HTMLElement>("[data-comment-target]")].find((one) => one.dataset.commentTarget === note.paths[0]);
    editing.current = edit.index;
    if (element !== undefined) element.click();
    else openComment({ paths: note.paths, label: note.label, kind: "text" }, edit.anchor);
  }, [edit, tray.notes, openComment]);

  const show = (path: string) => {
    const ticket = /^ticket\[([^\]]+)\]/.exec(path)?.[1];
    if (ticket !== undefined) {
      setSelected(view.spec.ticket.some((one) => one.ref === ticket) ? ticket : `${REMOVED}${ticket}`);
      if (layout === "files") setLayout("list");
    }
    setJump({ path, nonce: Date.now() });
  };
  const goChange = (index: number) => {
    const change = changes[index];
    if (change === undefined) return;
    setCursor(index);
    marks.see([changeKey(change)]);
    show(change.path);
  };
  const step = (by: number) => {
    if (changes.length === 0) return;
    goChange(cursor < 0 ? (by > 0 ? 0 : changes.length - 1) : (cursor + by + changes.length) % changes.length);
  };
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || editable(event.target) || boxNow.current !== null) return;
      if (!(event.target === document.body || (event.target instanceof Node && root.current?.contains(event.target)))) return;
      if (event.key === "j") stepRef.current(1);
      if (event.key === "k") stepRef.current(-1);
    };
    document.addEventListener("keydown", keys);
    return () => document.removeEventListener("keydown", keys);
  }, []);

  const setGeneral = (text: string) => {
    const index = tray.notes.findIndex((note) => note.paths[0] === WHOLE_SPEC);
    if (text.trim() === "") return index === -1 ? undefined : tray.remove(index);
    const note: DraftNote = { version: view.version, paths: [WHOLE_SPEC], body: text, label: "The whole spec", section: "guardrails" };
    return index === -1 ? tray.add(note) : tray.replace(index, note);
  };
  const answered = view.notes.filter((note) => note.answeredIn === view.version && note.changed);
  // Findings the versions since the compared one had: a change on their part most likely answers them.
  const earlierFindings = view.reviews.filter((round) => round.state === "changes_requested" && view.compared !== null && round.version >= view.compared.version && round.version < view.version).flatMap((round) => round.findings);
  const answersFinding = (change: SpecChange) => earlierFindings.filter((finding) => finding.path !== undefined && touches(change, finding.path));
  const answers = (change: SpecChange) => answered.filter((note) => note.paths.some((path) => touches(change, path)) || (change.kind === "ticket-added" && change.from.some((ref) => note.paths.some((path) => touches({ path: `ticket[${ref}]` }, path)))));
  const waiting = view.notes.filter((note) => note.answeredIn === null && note.version === newest.version);
  const seenCount = changes.filter((change) => marks.seen.has(changeKey(change))).length;
  const unseen = changes.length - seenCount;
  const countIn = (section: SpecSection) => ({ changes: changes.filter((change) => change.section === section).length, notes: tray.notes.filter((note) => note.paths[0] !== WHOLE_SPEC && (note.section ?? sectionOf(note.paths[0]!)) === section).length });
  const toggleFilter = (next: "changes" | "all") => {
    setFilter(next);
    setShown(new Set());
  };

  return (
    <div ref={root} data-spec-page className="@container relative space-y-3" onMouseDownCapture={(event) => (pressed.current = event.target instanceof HTMLElement ? event.target : null)}>
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">Spec</h2>
          <div role="group" aria-label="Spec versions" className="inline-flex flex-wrap gap-0.5 rounded-md border border-border-seam bg-card p-0.5">
            {view.versions.map((entry) => (
              <button key={entry.version} type="button" aria-pressed={entry.version === view.version} onClick={() => onVersion(entry.version)} className={`cursor-pointer rounded px-2 py-0.5 text-xs ${entry.version === view.version ? "bg-surface-selected font-semibold text-foreground" : "text-muted-foreground hover:bg-state-hover"}`}>
                v{entry.version} <span className="font-normal text-muted-foreground">{entry.status}</span>
              </button>
            ))}
          </div>
          {view.compared !== null && (
            <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              compared with
              <select aria-label="Compare with" className="rounded-md border border-border-seam bg-card px-1.5 py-0.5 text-xs text-foreground" value={view.compared.version} onChange={(event) => onBase(Number(event.target.value))}>
                {view.versions
                  .filter((entry) => entry.version < view.version)
                  .map((entry) => (
                    <option key={entry.version} value={entry.version}>
                      v{entry.version} ({entry.status})
                    </option>
                  ))}
              </select>
            </label>
          )}
        </div>
        {view.version !== newest.version && (
          <p data-spec-older className="flex flex-wrap items-center gap-2 rounded-md border border-border-seam bg-card px-3 py-2 text-xs">
            You are reading v{view.version} ({view.status}).
            <button type="button" className={`${BUTTON} ml-auto`} onClick={() => onVersion(newest.version)}>
              Back to v{newest.version}
            </button>
          </p>
        )}
        <LoomReview rounds={ownRounds} status={specReview} version={view.version} labelFor={labelFor} onGo={show} />
        {waiting.length > 0 && (
          <p data-spec-waiting className="rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-xs">
            <b>You sent {plural(waiting.length, "comment")} on v{newest.version}.</b> The planner is drafting v{newest.version + 1}; this page shows what changed when it arrives.
          </p>
        )}
        {view.compared === null ? (
          !readOnly && waitsForYou && <p className="text-xs text-muted-foreground">v{view.version} is the first version, so the entire spec is shown.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <div role="group" aria-label="What to show" className="inline-flex gap-0.5 rounded-md border border-border-seam bg-card p-0.5">
              <button type="button" aria-pressed={only} onClick={() => toggleFilter("changes")} className={`inline-flex cursor-pointer items-center gap-1.5 rounded px-2.5 py-1 text-xs ${only ? "bg-surface-selected font-semibold text-foreground" : "text-muted-foreground hover:bg-state-hover"}`}>
                Only what changed since v{view.compared.version}
                <span className="rounded-full bg-primary px-1.5 text-[10px] leading-4 font-semibold text-primary-foreground">{changes.length}</span>
              </button>
              <button type="button" aria-pressed={!only} onClick={() => toggleFilter("all")} className={`cursor-pointer rounded px-2.5 py-1 text-xs ${!only ? "bg-surface-selected font-semibold text-foreground" : "text-muted-foreground hover:bg-state-hover"}`}>
                The entire spec
              </button>
            </div>
            <span className="text-xs text-muted-foreground">
              {only ? (
                <>
                  Parts that did not change are hidden, or faded on the map. {unseen > 0 ? `${plural(unseen, "change")} not seen yet.` : changes.length > 0 ? "You have seen every change." : ""}{" "}
                  <button type="button" className="cursor-pointer font-semibold text-primary underline-offset-2 hover:underline" onClick={() => toggleFilter("all")}>
                    View the entire spec →
                  </button>
                </>
              ) : (
                "Every part is shown; what changed carries a blue mark."
              )}
            </span>
          </div>
        )}
      </header>

      {/* On a narrow page the project's tab bar sticks at the top too, so this bar stops under it. */}
      <nav aria-label="Spec sections" data-spec-sections className="sticky top-0 z-20 @max-xl/loom:top-[var(--loom-tabs,0px)] -mx-4 flex flex-wrap items-center gap-1 border-b border-border-seam bg-surface-recessed/95 px-4 py-1.5 backdrop-blur">
        {SECTIONS.map(({ section, title }, index) => {
          const count = countIn(section);
          const done = marks.reviewed.has(section);
          return (
            <button key={section} type="button" onClick={() => document.getElementById(domId(section))?.scrollIntoView({ behavior: "smooth", block: "start" })} className="inline-flex cursor-pointer items-center gap-1.5 rounded-full px-2 py-0.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground">
              <span className={`inline-flex size-5 items-center justify-center rounded-full border text-[10.5px] font-bold ${done ? "border-success bg-success text-success-foreground" : "border-border-seam bg-card"}`}>{done ? "✓" : index + 1}</span>
              {title}
              {count.changes > 0 && <span className="text-[11px] text-primary">· {count.changes} changed</span>}
              {count.notes > 0 && <span className="text-[11px] text-warning-text">· {plural(count.notes, "comment")}</span>}
            </button>
          );
        })}
        {view.compared !== null && (
          <span className="ml-auto flex items-center gap-1">
            <button type="button" className={BUTTON} onClick={() => toggleFilter(only ? "all" : "changes")}>
              {only ? "View the entire spec" : `Only what changed · ${changes.length}`}
            </button>
            {changes.length > 0 && (
              <>
                <span className="ml-1 text-xs font-semibold text-primary tabular-nums">
                  Change {cursor < 0 ? "–" : cursor + 1} of {changes.length}
                </span>
                <button type="button" aria-label="Previous change (k)" title="Previous change (k)" className={BUTTON} onClick={() => step(-1)}>
                  ↑
                </button>
                <button type="button" aria-label="Next change (j)" title="Next change (j)" className={BUTTON} onClick={() => step(1)}>
                  ↓
                </button>
              </>
            )}
          </span>
        )}
      </nav>

      <div className={`grid gap-4 ${readOnly ? "" : "@5xl:grid-cols-[minmax(0,1fr)_20rem]"}`}>
        <div className="min-w-0 space-y-6">
          {view.compared !== null && changes.length > 0 && (
            <section data-what-changed aria-label="What changed" className="rounded-lg border border-primary bg-card p-3">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold">
                  What changed in v{view.version} <span className="font-normal text-muted-foreground">since v{view.compared.version}</span>
                </h3>
                <span className="ml-auto text-xs text-muted-foreground">
                  {seenCount} of {changes.length} seen
                </span>
                <button type="button" className={BUTTON} onClick={() => marks.see(changes.map(changeKey))}>
                  Mark all seen
                </button>
                <button type="button" className={BUTTON} aria-expanded={listOpen} onClick={() => setListOpen(!listOpen)}>
                  {listOpen ? "Hide" : "Show"}
                </button>
              </div>
              {listOpen && (
                <div className="mt-1">
                  {SECTIONS.map(({ section, title }) => {
                    const mine = changes.map((change, index) => ({ change, index })).filter(({ change }) => change.section === section);
                    if (mine.length === 0) return null;
                    return (
                      <div key={section}>
                        <h4 className={`${HEADING} mt-2 mb-0.5 px-2`}>
                          {title} · {mine.length}
                        </h4>
                        {mine.map(({ change, index }) => {
                          const seen = marks.seen.has(changeKey(change));
                          const why = answers(change);
                          return (
                            <div key={changeKey(change)} data-change={change.path} data-seen={seen || undefined} className={`flex items-start gap-2 rounded-md px-2 py-1 text-sm hover:bg-state-hover ${seen ? "opacity-60" : ""} ${index === cursor ? "bg-surface-selected" : ""}`}>
                              <span aria-hidden className={`mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded text-[11px] font-bold text-white ${change.kind === "ticket-added" ? "bg-success" : change.kind === "ticket-removed" ? "bg-destructive-text" : "bg-primary"}`}>
                                {change.kind === "ticket-added" ? "+" : change.kind === "ticket-removed" ? "−" : "~"}
                              </span>
                              {/* The tags go under the change when the row is too narrow for both, never over it. */}
                              <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
                                <button type="button" className="flex min-w-[min(100%,12rem)] flex-1 cursor-pointer flex-wrap items-baseline gap-x-3 text-left" onClick={() => goChange(index)}>
                                  <span className={`min-w-0 font-medium [overflow-wrap:anywhere] ${change.ref === null ? "" : "font-mono text-xs"}`}>{labelFor(change.path)}</span>
                                  <span data-change-line className="min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere] @3xl:truncate">
                                    <ChangeLine change={change} />
                                  </span>
                                </button>
                                {why.length > 0 && (
                                  <span className="ml-auto shrink-0 text-[11px] text-warning-text" title={why.map((note) => note.body).join("\n")}>
                                    answers your comment
                                  </span>
                                )}
                                {why.length === 0 && answered.length > 0 && <span data-change-tag className="ml-auto shrink-0 text-[11px] text-subtle-foreground">not from your comments</span>}
                                {answersFinding(change).length > 0 && (
                                  <span className="ml-auto shrink-0 text-[11px] text-foreground" title={answersFinding(change).map((finding) => finding.title).join("\n")}>
                                    answers Loom's review
                                  </span>
                                )}
                              </div>
                              <button type="button" aria-label={seen ? `Mark ${labelFor(change.path)} not seen` : `Mark ${labelFor(change.path)} seen`} aria-pressed={seen} className={`mt-px inline-flex size-4.5 shrink-0 cursor-pointer items-center justify-center rounded-full border text-[10px] ${seen ? "border-success bg-success text-success-foreground" : "border-border-seam text-transparent hover:text-muted-foreground"}`} onClick={() => (seen ? marks.unsee(changeKey(change)) : marks.see([changeKey(change)]))}>
                                ✓
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                  <p className="mt-1 px-2 text-[11px] text-subtle-foreground">Click a change to go to it; it then counts as seen. j and k step through them.</p>
                </div>
              )}
            </section>
          )}

          {SECTIONS.map(({ section, title, text }, index) => {
            const count = countIn(section);
            const done = marks.reviewed.has(section);
            const showAll = () => setShown(new Set([...shown, section]));
            return (
              <section key={section} id={domId(section)} data-spec-section={section} aria-label={title} className="scroll-mt-14 space-y-3 @max-xl/loom:scroll-mt-40">
                <div className="flex items-start gap-2.5">
                  <span className={`inline-flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${done ? "bg-success text-success-foreground" : "bg-foreground text-background"}`}>{done ? "✓" : index + 1}</span>
                  <div className="min-w-0 flex-1">
                    <h2 className="flex flex-wrap items-center gap-2 text-base font-semibold">
                      {title}
                      {count.changes > 0 && <span className="rounded-full bg-primary px-1.5 text-[10.5px] leading-4 font-semibold text-primary-foreground">{count.changes} changed</span>}
                    </h2>
                    <p className="text-xs text-muted-foreground">{text}</p>
                  </div>
                  {!readOnly && (
                    <button type="button" aria-pressed={done} className={`${BUTTON} ${done ? "border-success text-success" : ""}`} onClick={() => marks.review(section, !done)}>
                      {done ? "✓ Reviewed" : "Mark reviewed"}
                    </button>
                  )}
                </div>
                <ReviewContext.Provider value={sectionReview(section)}>
                  {section === "settings" && <SettingsSection spec={view.spec} bbProjectNames={bbProjectNames} onShowAll={showAll} onJump={(to) => document.getElementById(domId(to))?.scrollIntoView({ behavior: "smooth", block: "start" })} />}
                  {section === "tickets" && (
                    <MarksContext.Provider value={filesMarks}>
                      <TicketsSection view={view} compared={view.compared?.spec ?? null} layout={layout} onLayout={setLayout} selected={selected} onSelect={setSelected} filesView={filesView} onShowAll={showAll} />
                    </MarksContext.Provider>
                  )}
                  {section === "guardrails" && <GuardrailsSection spec={view.spec} toml={view.toml} onShowAll={showAll} />}
                </ReviewContext.Provider>
              </section>
            );
          })}
        </div>
        {!readOnly && (
          <div className="sticky bottom-0 z-30 max-h-[60dvh] min-w-0 overflow-y-auto @5xl:top-14 @5xl:bottom-auto @5xl:max-h-[calc(100dvh-10rem)] @5xl:self-start">
            <ReviewPanel
              view={view}
              notes={tray.notes}
              labelFor={labelFor}
              onEdit={(index, anchor) => {
                show(tray.notes[index]!.paths[0]!);
                setEdit({ index, anchor });
              }}
              onRemove={(index) => {
                setBox(null);
                tray.remove(index);
              }}
              onJump={(note) => show(note.paths[0]!)}
              onGeneral={setGeneral}
              onSent={(next) => {
                tray.clear();
                onSent(next);
              }}
              approve={approve !== null && approve.version === view.version ? approve : null}
            />
          </div>
        )}
      </div>

      {box !== null && (
        <CommentBox
          key={`${box.target.paths[0]} ${box.index ?? "new"} ${String(box.target.preset)}`}
          target={box.target}
          existing={box.index === null ? null : tray.notes[box.index]!}
          position={{ top: box.top, left: box.left }}
          onCancel={closeBox}
          onDelete={box.index === null ? undefined : () => (tray.remove(box.index!), closeBox())}
          onSave={(body, suggest) => {
            const note: DraftNote = { version: view.version, paths: box.target.paths, body, label: box.target.label, section: sectionOf(box.target.paths[0]!), ...(suggest === undefined ? {} : { suggest }) };
            if (box.index === null) tray.add(note);
            else tray.replace(box.index, note);
            closeBox();
          }}
        />
      )}
    </div>
  );
}

