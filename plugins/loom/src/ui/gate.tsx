// The phase gate: what the finished phase recorded under the version in force, beside what the pending version proposes
// for the next one, with one footer that approves the version on screen or sends the comments written on it. The two
// columns scroll between the version line and the footer, so the footer never covers what it asks the person to judge.
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { experimental_copyToClipboard, experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { BoardCard, GateRecordedTicket, GateView, ProjectView } from "../contract";
import { formatDuration, specReviewBlocks } from "../format";
import { sectionOf, type SpecChange } from "../spec-diff";
import { BUTTON, BUTTON_CTA, ConfirmButton, FIELD, HEADING, TAP, listText, plural, useLoomWrite, useRun } from "./common";
import { PhaseMap } from "./dep-map";
import { depIndex } from "./deps";
import { prNumber } from "./groups";
import { Disclosure, Tip } from "./kit";
import { PhaseMark } from "./phase-rail";
import { changeText, labelOf } from "./spec-review-kit";
import { sentForm, useNoteTray, type DraftNote } from "./spec-notes";
import { PHONE_TEXT } from "./narrow";
import { TicketBar, type Thread } from "./ticket-bar";

type Side = "finished" | "proposed" | "changes";

const LINK = `inline-flex min-h-6 items-center gap-1 rounded-sm @max-xl/loom:min-w-11 max-[576px]:min-w-11 pointer-coarse:min-w-11 text-foreground underline decoration-[var(--loom-line)] underline-offset-2 hover:decoration-current ${TAP}`;
const CHIP_BASE = "inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-[11px] leading-none";
// An armed Yes says everything the approval does, so it grows in height instead of spilling: on a phone it takes the
// row beside Back, which keeps its own width, while it has 12rem there; with enlarged text Back wraps under it instead
// of squeezing Yes to a word a line.
const CONFIRM_GROWS = [
  "[&_[data-confirm-armed]]:max-w-full [&_[data-confirm-armed]]:flex-wrap [&_[data-confirming]]:@max-xl/loom:basis-48",
  "[&_[data-confirming]]:h-auto [&_[data-confirming]]:min-h-8 [&_[data-confirming]]:min-w-0 [&_[data-confirming]]:shrink [&_[data-confirming]]:py-1.5 [&_[data-confirming]]:text-left [&_[data-confirming]]:leading-snug",
  "[&_[data-confirming]]:@max-xl/loom:flex-1 [&_[data-confirming]]:@max-xl/loom:py-2.5",
].join(" ");
const COLUMN = "loom-card loom-selvedge flex min-h-0 min-w-0 flex-col gap-3 py-3 pl-[18px] pr-3.5";

/** A phase's name for a person: "Phase 2", or the phase's title when known. */
const phaseName = (index: number) => `Phase ${index + 1}`;

/** A change of the version in a few words, for its list and the footer's facts: "Phase 4 outline", "max workers 3 to 4". */
export function changeName(change: Pick<SpecChange, "path">): string {
  const phase = /^phase\[(\d+)\](?:\.(\w+))?/.exec(change.path);
  if (phase !== null) return `${phaseName(Number(phase[1]))}${phase[2] === undefined ? "" : ` ${phase[2].replace(/_/g, " ")}`}`;
  if (change.path === "agents.max_workers") return "max workers";
  return labelOf(change.path);
}

/** One fact per change the footer names beside Approve; the finished phase's report is on the left already. */
export function changeFact(change: SpecChange, finishedIndex: number | null): string | null {
  if (finishedIndex !== null && change.path === `phase[${finishedIndex}].report`) return null;
  if (change.kind === "value" && (typeof change.after === "number" || typeof change.after === "string") && (typeof change.before === "number" || typeof change.before === "string")) return `${changeName(change)} ${change.before} to ${change.after}`;
  return changeName(change).replace(/^Phase/, "phase");
}

/**
 * What Approve says on the gate, from the version on screen alone: the button, the facts beside it and the armed text.
 * Running, it names how many tickets start and how many wait; paused, that none start. Every other change is named.
 */
export function approveWords(gate: GateView, paused: boolean): { label: string; facts: string[]; yes: string } {
  const count = gate.proposed.tickets.length;
  const others = gate.changes.map((change) => changeFact(change, gate.finished?.index ?? null)).filter((fact): fact is string => fact !== null);
  const held = !paused && gate.holdUntil !== null;
  const facts = [
    ...(paused
      ? ["paused", `${plural(count, "ticket")} created`, "none start"]
      : held
        ? [`rate limit until about ${holdClock(gate.holdUntil!)}`, `${plural(count, "ticket")} created`, "none start until then"]
        : [startsText(gate.startNow, "now"), `${gate.wait} ${gate.wait === 1 ? "waits" : "wait"}`]),
    ...others,
  ];
  const named = others.length <= 3 ? others : [...others.slice(0, 2), plural(others.length - 2, "other change")];
  return {
    label: `Approve v${gate.version} · create ${plural(count, "ticket")}`,
    facts,
    yes: `Yes, approve v${gate.version}: ${listText([plural(count, "ticket"), ...named.map((fact) => fact.replace(/^phase (\d+) (\w+)$/, "phase $1's $2"))])}${paused ? " · stays paused" : held ? " · starts after the rate limit" : ""}`,
  };
}

/** The time a rate-limit hold ends, as "2:15 PM": the engine starts nothing before it. */
export const holdClock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** "1 starts now", "2 start now". */
export const startsText = (count: number, when: string) => `${count} ${count === 1 ? "starts" : "start"} ${when}`;

/** The link to a GitHub pull request's merge commit or checks; null on a forge whose pages Loom does not know. */
const githubRepo = (prUrl: string | null) => (prUrl === null ? null : (/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/pull\/\d+/.exec(prUrl)?.[1] ?? null));

/** The proposed tickets as queued cards with their provisional keys, so the dependency map draws them as it draws a draft. */
export function proposedCards(gate: GateView, board: readonly BoardCard[]): BoardCard[] {
  const known = new Set([...board.map((card) => card.key), ...gate.proposed.tickets.map((ticket) => ticket.key)]);
  return gate.proposed.tickets.map((ticket) => ({
    phase: gate.proposed.ref,
    key: ticket.key,
    title: ticket.title,
    state: "queued",
    stateAt: 0,
    repo: ticket.repo,
    priority: 1,
    attempt: 0,
    reviewRound: 0,
    deps: ticket.dependsOn,
    ready: ticket.ready,
    waitingOn: [],
    threadId: null,
    prUrl: null,
    blockedReason: null,
    hasChanges: false,
    stackedOn: [],
    holding: null,
    startWait: null,
    reviewerLookup: null,
    retry: null,
    waitsForSlot: false,
    ci: null,
    mergeConfirm: null,
    draft: null,
    publishWait: null,
    releaseRequested: null,
    // A live prerequisite may be a milestone rather than a ticket; the map draws tickets only.
    prereqs: [...ticket.dependsOn.map((key) => ({ key, kind: "work" as const })), ...ticket.mergeAfter.map((key) => ({ key, kind: "merge" as const })), ...ticket.requiresLive.map((key) => ({ key, kind: "live" as const }))].filter((prereq) => known.has(prereq.key)),
    ask: null,
  }));
}

/** A proposed ticket's prerequisites in words, by kind: "after EDGE-16 · merges after EDGE-15 · needs EDGE-13 live". */
export function waitWords(ticket: GateView["proposed"]["tickets"][number]): string | null {
  const parts = [ticket.dependsOn.length > 0 ? `after ${ticket.dependsOn.join(", ")}` : "", ticket.mergeAfter.length > 0 ? `merges after ${ticket.mergeAfter.join(", ")}` : "", ticket.requiresLive.length > 0 ? `needs ${ticket.requiresLive.join(", ")} live` : ""].filter((part) => part !== "");
  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * When a proposed ticket starts, in words that agree with the footer: only the scheduler's starters "start now"; a ready
 * ticket waits for Resume while paused, or for a free slot while running; the rest wait on what they name.
 */
export function startWords(ticket: GateView["proposed"]["tickets"][number], paused: boolean, holdUntil: number | null): { kind: "starts" | "resume" | "hold" | "slot" | "waits"; words: string } {
  if (ticket.starts) return { kind: "starts", words: "starts now" };
  if (ticket.ready && paused) return { kind: "resume", words: "ready when resumed" };
  if (ticket.ready && holdUntil !== null) return { kind: "hold", words: `waits for the rate limit, about ${holdClock(holdUntil)}` };
  if (ticket.ready) return { kind: "slot", words: "waits for a free slot" };
  return { kind: "waits", words: waitWords(ticket) ?? "waits for work on the same files" };
}

/**
 * The height the gate takes so its footer docks at the bottom of the page: the page's own height less what sits above
 * the gate. Null on a phone, where the gate flows and its footer sticks to the bottom instead, and where no
 * ResizeObserver runs (jsdom).
 */
function useFitHeight(root: RefObject<HTMLElement | null>, footer: RefObject<HTMLElement | null>): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = root.current;
    const scroller = element?.closest<HTMLElement>("[data-loom-scroll]");
    if (element == null || scroller == null || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      // The same break as the @max-xl/loom container query: 36rem of bb's root size, not a fixed 576 px.
      const narrow = scroller.clientWidth < 36 * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
      // On a phone the footer sticks to the bottom: focus and scrolled-to parts keep clear of it.
      scroller.style.scrollPaddingBottom = narrow ? `${(footer.current?.offsetHeight ?? 0) + 8}px` : "";
      if (narrow) return setHeight(null);
      const top = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      setHeight(Math.max(440, Math.floor(scroller.clientHeight - top - 20)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    const shell = element.closest("[data-project-shell]");
    if (shell !== null) observer.observe(shell);
    if (footer.current !== null) observer.observe(footer.current);
    return () => {
      observer.disconnect();
      scroller.style.scrollPaddingBottom = "";
    };
  }, [root, footer]);
  return height;
}

type Tray = ReturnType<typeof useNoteTray>;

/** A line the planner wrote, which a click, Enter or Space opens a comment on; the comment waits in the tray until sent. */
function Part({ path, label, tray, version, children, className = "" }: { path: string; label: string; tray: Tray; version: number; children: ReactNode; className?: string }) {
  const index = tray.notes.findIndex((note) => note.paths[0] === path);
  const note = index === -1 ? null : tray.notes[index]!;
  const [text, setText] = useState(note?.body ?? "");
  const [open, setOpen] = useState(false);
  const save = (close: () => void) => {
    const body = text.trim();
    if (body === "") return;
    const next: DraftNote = { version, paths: [path], body, label, section: sectionOf(path) };
    if (index === -1) tray.add(next);
    else tray.replace(index, next);
    close();
  };
  const trigger = (
    <button type="button" data-gate-part={path} aria-description={note === null ? "Comment on it" : "Your unsent comment is on it"} className={`group relative block w-full min-w-0 cursor-pointer rounded-sm text-left hover:bg-state-hover ${TAP} ${note !== null ? "bg-[var(--loom-att-tint)]" : ""} ${className}`}>
      {children}
      <span aria-hidden className={`absolute right-0 top-0.5 inline-flex items-center gap-0.5 text-[11px] ${note === null ? "text-[var(--loom-muted)] opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" : "text-foreground"}`}>
        <Icon name="MessageSquare" className="size-3" />
        {note !== null && "1"}
      </span>
    </button>
  );
  return (
    <Disclosure
      trigger={trigger}
      label={`Comment on ${label}`}
      className="w-[min(24rem,calc(100vw-24px))]"
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setText(note?.body ?? "");
      }}
    >
      {(close) => (
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            save(close);
          }}
        >
          <label className={HEADING} htmlFor={`gate-note-${path}`}>
            {label}
          </label>
          <textarea
            id={`gate-note-${path}`}
            rows={3}
            maxLength={4000}
            className={`${FIELD} ${PHONE_TEXT}`}
            placeholder="Comment for the planner"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                save(close);
              }
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            {note !== null && (
              <button
                type="button"
                className={BUTTON}
                onClick={() => {
                  tray.remove(index);
                  close();
                }}
              >
                Delete
              </button>
            )}
            <span className="ml-auto" />
            <button type="button" className={BUTTON} onClick={close}>
              Cancel
            </button>
            <button type="submit" className={BUTTON_CTA} disabled={text.trim() === ""}>
              Save
            </button>
          </div>
        </form>
      )}
    </Disclosure>
  );
}

function Chip({ state }: { state: "closed" | "proposed" }) {
  return (
    <span data-gate-chip={state} className={`${CHIP_BASE} ${state === "closed" ? "border-[var(--loom-line)] text-[var(--loom-muted)]" : "border-dashed border-[var(--attention)] text-foreground"}`}>
      <PhaseMark state={state} />
      {state === "closed" ? "Closed" : "Proposed"}
    </span>
  );
}

function PhaseHead({ index, title, chip, bar, count }: { index: number; title: string; chip: ReactNode; bar: ReactNode; count: ReactNode }) {
  return (
    <header className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
      <h3 className="flex min-w-[12rem] flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold leading-snug">
        <span className="loom-num inline-flex size-5 shrink-0 items-center justify-center rounded-sm border border-[var(--loom-line)] text-xs">{index + 1}</span>
        <span className="min-w-0 [overflow-wrap:anywhere]" data-content>
          {title}
        </span>
        {chip}
      </h3>
      <span className="flex shrink-0 items-center gap-3">
        {bar}
        {count}
      </span>
    </header>
  );
}

function Section({ title, count, aside, children }: { title: string; count?: number; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="grid gap-1.5 border-t border-[var(--loom-line)] pt-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className={HEADING}>{title}</h4>
        {count !== undefined && <span className="loom-num text-[11px] text-[var(--loom-muted)]">{count}</span>}
        {aside !== undefined && <span className="ml-auto flex items-center gap-2">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

/** A done-when list. Each line keeps a status cell, empty until Loom computes per-check verdicts, so adding them later does not move the lines. */
function DoneWhen({ lines, phase, tray, version }: { lines: readonly string[]; phase: number; tray: Tray; version: number }) {
  return (
    <ol data-done-when className="grid gap-0.5 text-[13px] leading-snug [--loom-verdict:0px]">
      {lines.map((line, index) => (
        <li key={index} className="grid grid-cols-[var(--loom-verdict)_1.25rem_minmax(0,1fr)] items-start">
          <span data-verdict-cell aria-hidden />
          <span aria-hidden className="loom-num pt-0.5 text-[11px] text-[var(--loom-muted)]">
            {index + 1}.
          </span>
          <Part path={`phase[${phase}].done_when[${index}]`} label={`${phaseName(phase)} › done when ${index + 1}`} tray={tray} version={version} className="min-h-6 py-0.5 pr-5">
            <span data-content className="[overflow-wrap:anywhere]">
              {line}
            </span>
          </Part>
        </li>
      ))}
    </ol>
  );
}

/** A recorded ticket's evidence, each a way to its record: the pull request, the merge commit, the checks and the review. */
function Evidence({ ticket }: { ticket: GateRecordedTicket }) {
  const navigate = useBbNavigate();
  const repo = githubRepo(ticket.prUrl);
  const number = prNumber(ticket.prUrl);
  const short = ticket.mergeSha?.slice(0, 7) ?? null;
  const checks = ticket.checks;
  const total = checks === null ? 0 : checks.passed + checks.failed + checks.pending;
  // Each cell keeps its normal width as a minimum and grows with its text; the row wraps a cell that no longer fits.
  const cell = "flex max-w-full shrink-0 items-center text-xs";
  return (
    <>
      <span className={`${cell} min-w-14`}>
        {ticket.prUrl === null ? (
          <span className="text-[var(--loom-muted)]">no PR</span>
        ) : (
          <a className={`${LINK} loom-num`} href={ticket.prUrl} target="_blank" rel="noreferrer" aria-label={`${ticket.key}'s pull request${number === null ? "" : ` #${number}`}`}>
            {number === null ? "PR" : `#${number}`}
          </a>
        )}
      </span>
      <span className={`${cell} min-w-[4.5rem]`}>
        {short === null ? (
          <span className="text-[var(--loom-muted)]">not recorded</span>
        ) : repo !== null ? (
          <a className={`${LINK} font-mono`} href={`${repo}/commit/${ticket.mergeSha}`} target="_blank" rel="noreferrer" aria-label={`${ticket.key}'s merge commit ${short}`}>
            {short}
          </a>
        ) : (
          <button type="button" className={`${LINK} cursor-pointer font-mono`} aria-label={`Copy ${ticket.key}'s merge commit ${short}`} onClick={() => void experimental_copyToClipboard({ text: ticket.mergeSha! }).then(() => toast.success(`Copied ${short}`))}>
            {short}
            <Icon name="Copy" className="size-3 text-[var(--loom-muted)]" />
          </button>
        )}
      </span>
      <span className={`${cell} min-w-16`}>
        {checks === null ? (
          <span className="text-[var(--loom-muted)]">not read</span>
        ) : (
          <Tip text={`Read ${formatDuration(Math.max(0, Date.now() - checks.at))} ago: ${checks.passed} passed${checks.failed > 0 ? `, ${checks.failed} failing` : ""}${checks.pending > 0 ? `, ${checks.pending} pending` : ""}`}>
            <a className={`${LINK} loom-num`} href={repo === null ? (ticket.prUrl ?? undefined) : `${ticket.prUrl}/checks`} target="_blank" rel="noreferrer" aria-label={`${ticket.key}'s checks: ${checks.passed} of ${total} passed`}>
              <Icon name={checks.failed > 0 ? "CircleX" : "CircleCheck"} className={`size-3 ${checks.failed > 0 ? "text-[var(--loom-bad)]" : "text-[var(--loom-ok)]"}`} />
              {checks.passed}/{total}
            </a>
          </Tip>
        )}
      </span>
      <span className={`${cell} min-w-[5.5rem]`}>
        {ticket.review === null ? (
          <span className="text-[var(--loom-muted)]">no review</span>
        ) : ticket.review.threadId === null ? (
          <span>
            {ticket.review.verdict === "approved" ? "approved" : ticket.review.verdict.replace(/_/g, " ")} · round {ticket.review.round}
          </span>
        ) : (
          <button type="button" className={`${LINK} cursor-pointer`} aria-label={`${ticket.key}'s review: ${ticket.review.verdict.replace(/_/g, " ")} in round ${ticket.review.round}; opens the reviewer's thread`} onClick={() => navigate.toThread(ticket.review!.threadId!)}>
            {ticket.review.verdict === "approved" ? "approved" : ticket.review.verdict.replace(/_/g, " ")} · r{ticket.review.round}
          </button>
        )}
      </span>
    </>
  );
}

function Recorded({ gate, finished, tray, onTicket }: { gate: GateView; finished: NonNullable<GateView["finished"]>; tray: Tray; onTicket(key: string): void }) {
  const [reportOpen, setReportOpen] = useState(false);
  const done = finished.tickets.filter((ticket) => ticket.state === "done").length;
  const cut = finished.tickets.filter((ticket) => ticket.state === "cancelled").length;
  const threads: Thread[] = finished.tickets.map((ticket) => (ticket.state === "done" ? "done" : ticket.state === "cancelled" ? "cut" : "open"));
  const closedAt = finished.closedAt === null ? null : new Date(finished.closedAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
  const key = "flex min-h-6 items-center gap-1.5 font-mono text-xs font-semibold";
  return (
    <>
      <PhaseHead
        index={finished.index}
        title={finished.title}
        chip={<Chip state="closed" />}
        bar={<TicketBar threads={threads} height={8} className="w-24" />}
        count={
          <span className="flex items-baseline gap-2 whitespace-nowrap">
            <span className="loom-num text-[26px] leading-none font-extrabold tracking-tight">{done}</span>
            <span className="text-xs text-[var(--loom-muted)]">
              done{cut > 0 ? ` · ${cut} cut` : ""}
              {closedAt === null ? "" : ` · ${closedAt}`}
            </span>
          </span>
        }
      />
      <Section title="Done when" count={finished.doneWhen.length}>
        <DoneWhen lines={finished.doneWhen} phase={finished.index} tray={tray} version={gate.version} />
      </Section>
      <Section title="Tickets" count={finished.tickets.length}>
        <ul data-gate-recorded aria-label={`${phaseName(finished.index)}'s tickets as Loom recorded them`} className="grid gap-px">
          <li aria-hidden className={`${HEADING} grid grid-cols-[1rem_4.75rem_minmax(0,1fr)] gap-x-2 normal-case tracking-normal @max-xl/loom:hidden`}>
            <span />
            <span>Ticket</span>
            <span className="flex gap-x-3">
              <span className="w-14">PR</span>
              <span className="w-[4.5rem]">Merge</span>
              <span className="w-16">Checks</span>
              <span>Review</span>
            </span>
          </li>
          {finished.tickets.map((ticket) => (
            // Not a grid of rem columns: at 200% text those took the whole row. The record moves under the key when it has
            // less than 14rem beside it.
            <li key={ticket.key} data-recorded={ticket.key} data-state={ticket.state} className="flex flex-wrap items-center gap-x-2 border-b border-[var(--loom-line)] py-0.5 last:border-b-0 @max-xl/loom:items-start @max-xl/loom:[&>svg]:mt-[15px]">
              <Icon name={ticket.state === "done" ? "GitMerge" : ticket.state === "cancelled" ? "Unavailable" : "Circle"} className={`size-3.5 shrink-0 ${ticket.state === "done" ? "text-[var(--loom-ok)]" : "text-[var(--loom-muted)]"}`} />
              <span data-recorded-key className="min-w-[4.75rem] shrink-0">
              <Tip text={ticket.title}>
                <button type="button" className={`${key} ${TAP} w-fit @max-xl/loom:min-w-11 max-[576px]:min-w-11 pointer-coarse:min-w-11 cursor-pointer underline decoration-[var(--loom-line)] underline-offset-2 hover:decoration-current`} aria-label={`${ticket.key}: ${ticket.title}`} onClick={() => onTicket(ticket.key)}>
                  {ticket.key}
                </button>
              </Tip>
              </span>
              {ticket.state === "cancelled" ? (
                <span className="min-w-[min(100%,14rem)] flex-1 text-xs [overflow-wrap:anywhere] @max-xl/loom:py-1">
                  <span className="text-[var(--loom-muted)]">cancelled{ticket.cancel?.by === "human" ? " by you" : ticket.cancel?.by === "planner" ? " by the planner" : ""}</span>
                  {ticket.cancel !== null && ticket.cancel.reason !== "" && (
                    <>
                      {" · "}
                      <q data-content className="[overflow-wrap:anywhere]">
                        {ticket.cancel.reason}
                      </q>
                    </>
                  )}
                </span>
              ) : (
                <span data-recorded-evidence className="flex min-w-[min(100%,14rem)] flex-1 flex-wrap gap-x-3 gap-y-0">
                  <Evidence ticket={ticket} />
                </span>
              )}
            </li>
          ))}
        </ul>
      </Section>
      {finished.report !== null && (
        <Section
          title="Planner's report"
          aside={
            <Tip text="The planner wrote this. Loom does not check its claims; the tickets above are Loom's record.">
              <span tabIndex={0} data-unverified className={`${CHIP_BASE} border-dashed border-[var(--loom-muted)] text-[var(--loom-muted)]`}>
                <span aria-hidden className="inline-block size-2 rounded-full border border-dashed border-current" />
                unverified
              </span>
            </Tip>
          }
        >
          <Part path={`phase[${finished.index}].report`} label={`${phaseName(finished.index)} › report`} tray={tray} version={gate.version} className="pr-5">
            <span data-content data-report className={`whitespace-pre-wrap text-[13px] leading-relaxed [overflow-wrap:anywhere] ${reportOpen ? "block" : "line-clamp-6"}`}>
              {finished.report}
            </span>
          </Part>
          {finished.report.split("\n").length > 6 || finished.report.length > 480 ? (
            <button type="button" data-report-toggle aria-expanded={reportOpen} className={`${BUTTON} w-fit`} onClick={() => setReportOpen(!reportOpen)}>
              {reportOpen ? "Show less" : "Show all"}
            </button>
          ) : null}
        </Section>
      )}
    </>
  );
}

function Proposed({ gate, view, tray, onTicket }: { gate: GateView; view: ProjectView; tray: Tray; onTicket(key: string): void }) {
  const { proposed } = gate;
  const cards = useMemo(() => proposedCards(gate, view.board), [gate, view.board]);
  const index = useMemo(() => depIndex([...view.board, ...cards]), [view.board, cards]);
  const first = proposed.tickets[0]?.key;
  const last = proposed.tickets.at(-1)?.key;
  return (
    <>
      <PhaseHead
        index={proposed.index}
        title={proposed.title}
        chip={<Chip state="proposed" />}
        bar={<TicketBar threads={[...proposed.tickets.map((): Thread => "proposed"), ...Array.from({ length: Math.max(0, proposed.maxTickets - proposed.tickets.length) }, (): Thread => "planned")]} height={8} className="w-24" />}
        count={
          <span className="loom-num whitespace-nowrap text-[26px] leading-none font-extrabold tracking-tight" aria-label={`${proposed.tickets.length} of ${proposed.maxTickets} tickets`}>
            {proposed.tickets.length}
            <small className="text-[14px] font-semibold tracking-normal text-[var(--loom-muted)]">/{proposed.maxTickets}</small>
          </span>
        }
      />
      <Part path={`phase[${proposed.index}].goal`} label={`${phaseName(proposed.index)} › goal`} tray={tray} version={gate.version} className="pr-5">
        <span data-content className="block text-[13px] leading-snug text-[var(--loom-muted)] [overflow-wrap:anywhere]">
          {proposed.goal}
        </span>
      </Part>
      <Section title="Done when" count={proposed.doneWhen.length}>
        <DoneWhen lines={proposed.doneWhen} phase={proposed.index} tray={tray} version={gate.version} />
      </Section>
      <Section
        title="Tickets"
        count={proposed.tickets.length}
        aside={
          first !== undefined && (
            <Tip text="Keys are provisional until you approve: approval numbers the tickets in this order">
              <span tabIndex={0} data-key-range className="loom-num text-[11px] text-[var(--loom-muted)]">
                {first === last ? first : `${first} to ${last}`} · provisional
              </span>
            </Tip>
          )
        }
      >
        <ul data-gate-proposed aria-label={`${phaseName(proposed.index)}'s proposed tickets`} className="grid gap-px">
          {proposed.tickets.map((ticket) => {
            const waits = waitWords(ticket);
            const when = startWords(ticket, view.overview.state === "paused", gate.holdUntil);
            return (
              <li key={ticket.ref} data-proposed={ticket.ref} data-proposed-key={ticket.key}>
                <Part path={`ticket[${ticket.ref}]`} label={`${ticket.key} (${ticket.ref})`} tray={tray} version={gate.version} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2 border-b border-[var(--loom-line)] py-1 pr-5 @max-xl/loom:py-2">
                  <Icon name={ticket.starts ? "Play" : "Clock"} className={`mt-0.5 size-3.5 ${ticket.starts ? "text-foreground" : "text-[var(--loom-muted)]"}`} />
                  <span className="grid min-w-0 gap-0.5">
                    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[13px] leading-snug">
                      <span className="font-mono text-xs font-semibold">{ticket.key}</span>
                      {/* Nothing being approved is cut: the title wraps. */}
                      <span data-content className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                        {ticket.title}
                      </span>
                    </span>
                    <span className="flex min-w-0 flex-wrap gap-x-2 text-xs text-[var(--loom-muted)]">
                      <span data-start={when.kind} className={ticket.starts ? "font-semibold text-foreground" : ""}>
                        {when.words}
                      </span>
                      {ticket.ready && waits !== null && <span>{waits}</span>}
                      {ticket.repo !== null && <span className="font-mono">{ticket.repo}</span>}
                    </span>
                  </span>
                </Part>
              </li>
            );
          })}
        </ul>
      </Section>
      {cards.length > 0 && (
        <section aria-label={`${phaseName(proposed.index)}'s dependencies`} data-gate-picture className="border-t border-[var(--loom-line)] pt-2.5">
          <PhaseMap
            index={index}
            scope={cards}
            phases={view.phases}
            focus={null}
            // A ticket on the board opens; a proposed one has no record yet, so its row takes focus.
            onPick={(key) => (view.board.some((card) => card.key === key) ? onTicket(key) : document.querySelector<HTMLElement>(`[data-proposed-key="${key}"] [data-gate-part]`)?.focus())}
            label={`What ${phaseName(proposed.index)}'s tickets wait on`}
            still
          />
        </section>
      )}
    </>
  );
}

function Changes({ gate, tray }: { gate: GateView; tray: Tray }) {
  if (gate.changes.length === 0) return <p className="text-xs text-[var(--loom-muted)]">No other changes: the version only fills {phaseName(gate.proposed.index)}.</p>;
  return (
    <ul data-gate-changes className="grid gap-1">
      {gate.changes.map((change) => (
        <li key={change.path}>
          <Part path={change.path} label={changeName(change)} tray={tray} version={gate.version} className="py-1 pr-5">
            <span className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
              <b className="font-semibold">{changeName(change)}</b>
              <span className="text-xs text-[var(--loom-muted)] [overflow-wrap:anywhere]">{changeText(change)}</span>
              {gate.finished !== null && change.path === `phase[${gate.finished.index}].report` && <span className="text-xs text-[var(--loom-muted)]">· on the left</span>}
            </span>
          </Part>
        </li>
      ))}
    </ul>
  );
}

/** Loom's spec review of the version, in a few words. */
function Review({ view, version }: { view: ProjectView; version: number }) {
  const status = view.specReview;
  const mine = status !== null && "version" in status && status.version === version ? status : null;
  const [icon, tone, words, tip] =
    mine === null
      ? ["Info", "text-[var(--loom-muted)]", "no spec review", "Loom ran no spec review of this version"]
      : mine.kind === "approved"
        ? ["SecurityCheck", "text-[var(--loom-ok)]", "review passed", `Loom's spec review passed v${version} in round ${mine.round}`]
        : mine.kind === "skipped"
          ? ["SecurityCheck", "text-[var(--loom-muted)]", "review skipped", "It changes only operational settings, so no reviewer ran; you still approve it"]
          : mine.kind === "reviewing"
            ? ["Loading", "text-[var(--loom-run)]", `reviewing · round ${mine.round}`, "Loom is reviewing it; Approve waits until the review passes"]
            : mine.kind === "changes"
              ? ["AlertCircle", "text-[var(--loom-warn)]", `review found ${plural(mine.findings.length, "problem")}`, "The planner revises the spec for them before it asks you"]
              : mine.kind === "limit"
                ? ["AlertCircle", "text-[var(--loom-warn)]", "review stopped", `Loom stopped reviewing with ${plural(mine.findings.length, "finding")} open`]
                : ["CircleX", "text-[var(--loom-bad)]", "review did not finish", mine.kind === "failed" ? mine.reason : ""];
  return (
    <Tip text={tip}>
      <span tabIndex={0} data-gate-review={mine?.kind ?? "none"} className="inline-flex items-center gap-1 whitespace-nowrap text-xs">
        <Icon name={icon} className={`size-3.5 ${tone}`} />
        {words}
      </span>
    </Tip>
  );
}

function Footer({ gate, view, tray, busy, onApprove }: { gate: GateView; view: ProjectView; tray: Tray; busy: boolean; onApprove(version: number): void }) {
  const send = useLoomWrite("sendNotes");
  const { busy: sending, error, run } = useRun();
  const notes = tray.notes;
  const older = notes.some((note) => note.version < gate.version);
  const blocks = specReviewBlocks(view.specReview);
  const paused = view.overview.state === "paused";
  const words = approveWords(gate, paused);
  // The facts keep a floor of width, so a long armed Yes wraps onto its own row instead of squeezing them under it.
  // Beside an icon the group holding both keeps the floor, and the facts take what the icon leaves.
  const facts = (items: readonly string[], besideIcon = false) => (
    <span data-gate-facts className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--loom-muted)] ${besideIcon ? "min-w-0 flex-1" : "min-w-[min(100%,14rem)]"}`}>
      {items.map((fact, index) => (
        <span key={fact} className="min-w-0 max-w-full [overflow-wrap:anywhere]">
          {index > 0 && <span aria-hidden className="mr-2">·</span>}
          {fact}
        </span>
      ))}
    </span>
  );
  let body: ReactNode;
  if (notes.length > 0) {
    const label = `Send ${plural(notes.length, "comment")}`;
    const go = () =>
      void run(async () => {
        await send({ slug: view.overview.slug, notes: notes.map(sentForm), ...(older ? { includeOlder: true as const } : {}), confirm: true });
        tray.clear();
        toast.success(`Sent ${plural(notes.length, "comment")} to the planner`);
      });
    body = (
      <>
        {/* On a phone Send names the count, and the bar keeps to one row. */}
        <span className="flex items-center gap-1.5 text-sm font-semibold @max-xl/loom:hidden">
          <Icon name="MessageSquare" className="size-4" />
          {plural(notes.length, "comment")} unsent
        </span>
        <span className="contents @max-xl/loom:hidden">{facts(["approve after sending", `the planner replies with v${gate.version + 1}`])}</span>
        <span className={`ml-auto flex flex-wrap items-center justify-end gap-2 @max-xl/loom:ml-0 @max-xl/loom:w-full ${CONFIRM_GROWS}`}>
          <ConfirmButton label="Discard" confirmLabel={`Yes, discard ${plural(notes.length, "comment")}`} danger disarmKey={`${gate.version} ${notes.length}`} onConfirm={() => tray.clear()} />
          {older ? (
            <ConfirmButton primary label={label} confirmLabel={`Yes, send to v${gate.version}: some were written on an older version`} disarmKey={`${gate.version} ${notes.length}`} disabled={sending} onConfirm={go} />
          ) : (
            <button type="button" data-gate-send className={BUTTON_CTA} disabled={sending} onClick={go}>
              <Icon name="MessageSquare" className="size-3.5" />
              {label}
            </button>
          )}
        </span>
      </>
    );
  } else if (blocks) {
    const status = view.specReview!;
    const reason = status.kind === "failed" ? `v${gate.version}'s spec review did not finish: ${status.reason}` : status.kind === "changes" ? `Loom's spec review found ${plural(status.findings.length, "problem")}; the planner is revising v${gate.version}` : `Loom is reviewing v${gate.version}`;
    const cli = `bb loom approve ${view.overview.slug} --version ${gate.version} --skip-review`;
    body = (
      <>
        <p role="status" className="flex min-w-0 flex-1 items-start gap-1.5 text-xs [overflow-wrap:anywhere]">
          <Icon name={status.kind === "failed" ? "CircleX" : "Loading"} className={`mt-px size-3.5 shrink-0 ${status.kind === "failed" ? "text-[var(--loom-bad)]" : "text-[var(--loom-run)]"}`} />
          <span>
            {reason}. {status.kind === "failed" ? "Approve waits for a review that passes, or skip it from the CLI." : "Approve waits until it passes."}
          </span>
        </p>
        {status.kind === "failed" && (
          <button type="button" className={BUTTON} title={cli} onClick={() => void experimental_copyToClipboard({ text: cli }).then(() => toast.success("Copied the CLI approve"))}>
            <Icon name="Copy" className="size-3.5" />
            Copy CLI approve
          </button>
        )}
      </>
    );
  } else {
    body = (
      <>
        <span className="flex min-w-[min(100%,16rem)] flex-1 items-center gap-1.5">
          <Icon name={paused ? "Pause" : "Play"} className="size-3.5 shrink-0 text-[var(--loom-muted)]" />
          {facts(words.facts, true)}
        </span>
        <span className={`min-w-0 max-w-full @max-xl/loom:w-full [&>*]:@max-xl/loom:w-full ${CONFIRM_GROWS}`}>
          <ConfirmButton primary lead label={words.label} confirmLabel={words.yes} disarmKey={JSON.stringify([gate.version, gate.proposed.tickets.map((ticket) => ticket.key), gate.changes.map((change) => change.path), paused, gate.startNow])} disabled={busy} onConfirm={() => onApprove(gate.version)} />
        </span>
      </>
    );
  }
  return (
    <>
      {body}
      {error !== null && (
        <p role="alert" className="w-full text-xs text-[var(--loom-bad)]">
          {error}
        </p>
      )}
    </>
  );
}

const SIDE_LABEL = (gate: GateView, side: Side) => (side === "finished" ? `${phaseName(gate.finished!.index)} recorded` : side === "proposed" ? `${phaseName(gate.proposed.index)} proposed` : "Other changes");

/** The one-line summary of the sides a narrow gate does not show. */
export function hiddenSummary(gate: GateView, shown: Side, paused = false): string {
  const parts: string[] = [];
  const finished = gate.finished;
  if (shown !== "finished" && finished !== null) {
    const done = finished.tickets.filter((ticket) => ticket.state === "done").length;
    const cut = finished.tickets.filter((ticket) => ticket.state === "cancelled").length;
    parts.push(`${phaseName(finished.index)}: closed · ${done} done${cut > 0 ? ` · ${cut} cut` : ""}`);
  }
  if (shown !== "proposed") parts.push(`${phaseName(gate.proposed.index)}: ${plural(gate.proposed.tickets.length, "ticket")}, ${paused ? "none start while paused" : gate.holdUntil !== null ? `none start until about ${holdClock(gate.holdUntil)}` : startsText(gate.startNow, "at once")}`);
  return parts.join(" · ");
}

export function GateScreen({ view, gate, busy, onApprove, onTicket, onWholeSpec }: { view: ProjectView; gate: GateView; busy: boolean; onApprove(version: number): void; onTicket(key: string): void; onWholeSpec(): void }) {
  const tray = useNoteTray(view.overview.slug);
  const root = useRef<HTMLDivElement>(null);
  const footer = useRef<HTMLDivElement>(null);
  const height = useFitHeight(root, footer);
  const sides: Side[] = [...(gate.finished === null ? [] : ["finished" as const]), "proposed", "changes"];
  const [side, setSide] = useState<Side>(gate.finished === null ? "proposed" : "finished");
  const on = (which: Side) => (side === which ? "" : "@max-5xl/loom:hidden");
  const age = gate.proposedAt > 0 ? formatDuration(Math.max(0, view.now - gate.proposedAt)) : null;
  const unsent = tray.notes.length;
  return (
    <div ref={root} data-gate={gate.version} className="flex min-h-0 flex-col gap-2.5" style={height === null ? undefined : { height }}>
      <div data-gate-version className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className={`${CHIP_BASE} border-[var(--attention)] bg-[var(--loom-att-tint)] font-semibold text-foreground`}>v{gate.version} pending</span>
        {/* Each separator stays with the fact after it, so a wrapped line never ends on one. */}
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--loom-muted)]">
          {age !== null && <span className="whitespace-nowrap">proposed {age} ago</span>}
          <span className="whitespace-nowrap">
            {age !== null && <span aria-hidden className="mr-2">·</span>}vs v{gate.inForce} in force
          </span>
          <span className="inline-flex items-center whitespace-nowrap">
            <span aria-hidden className="mr-2">·</span>
            <Review view={view} version={gate.version} />
          </span>
        </span>
        <span className="@max-5xl/loom:hidden">
          <Disclosure
            label={`Other changes in v${gate.version}`}
            className="w-[min(26rem,calc(100vw-24px))]"
            trigger={
              <button type="button" data-gate-other className={BUTTON}>
                <Icon name="Layers" className="size-3.5" />
                Other changes
                <span className="loom-num font-semibold">{gate.changes.length}</span>
              </button>
            }
          >
            <div className="grid gap-2">
              <h3 className={HEADING}>Other changes in v{gate.version}</h3>
              <Changes gate={gate} tray={tray} />
            </div>
          </Disclosure>
        </span>
        <span className="ml-auto flex items-center gap-2">
          {unsent > 0 && (
            <span className="inline-flex items-center gap-1 text-xs" aria-label={`${plural(unsent, "comment")} unsent`}>
              <Icon name="MessageSquare" className="size-3.5 text-[var(--loom-muted)]" />
              <span className="loom-num">{unsent}</span>
            </span>
          )}
          <button type="button" data-whole-spec className={BUTTON} onClick={onWholeSpec}>
            Read the whole spec
          </button>
        </span>
      </div>

      <div className="hidden shrink-0 gap-1.5 @max-5xl/loom:grid">
        <div role="tablist" aria-label="Gate side" className="inline-flex w-fit max-w-full flex-wrap gap-0.5 rounded-md border border-[var(--loom-line)] p-0.5">
          {sides.map((one) => (
            <button
              key={one}
              type="button"
              role="tab"
              aria-selected={side === one}
              data-gate-side={one}
              onClick={() => setSide(one)}
              className={`inline-flex min-h-7 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded px-2.5 text-xs ${TAP} ${side === one ? "bg-[var(--loom-sel)] font-semibold text-foreground" : "text-[var(--loom-muted)] hover:bg-state-hover"}`}
            >
              {SIDE_LABEL(gate, one)}
              {one === "changes" && <span className="loom-num font-semibold">{gate.changes.length}</span>}
            </button>
          ))}
        </div>
        <p data-gate-summary className="text-xs text-[var(--loom-muted)]">
          {hiddenSummary(gate, side, view.overview.state === "paused")}
        </p>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-2 items-start gap-3.5 @max-5xl/loom:grid-cols-1">
        {gate.finished !== null && (
          <section aria-label={`${phaseName(gate.finished.index)}, as Loom recorded it`} data-gate-side-panel="finished" className={`${COLUMN} max-h-full overflow-y-auto ${on("finished")}`}>
            <Recorded gate={gate} finished={gate.finished} tray={tray} onTicket={onTicket} />
          </section>
        )}
        <section aria-label={`${phaseName(gate.proposed.index)}, as v${gate.version} proposes it`} data-gate-side-panel="proposed" data-att="true" className={`${COLUMN} max-h-full overflow-y-auto bg-[color-mix(in_oklab,var(--attention)_4%,var(--loom-card))] ${on("proposed")}`}>
          <Proposed gate={gate} view={view} tray={tray} onTicket={onTicket} />
        </section>
        <section aria-label={`Other changes in v${gate.version}`} data-gate-side-panel="changes" className={`${COLUMN} hidden max-h-full overflow-y-auto ${side === "changes" ? "@max-5xl/loom:flex" : ""}`}>
          <Changes gate={gate} tray={tray} />
        </section>
      </div>

      {/* The dock, not the card, is sticky: the theme's .loom-card rule sets position: relative and would win. */}
      {/* Docked, it never takes more than 70% of the screen: with enlarged text its own content scrolls instead. */}
      <div ref={footer} data-gate-dock className="shrink-0 @max-xl/loom:sticky @max-xl/loom:bottom-0 @max-xl/loom:z-10 @max-xl/loom:max-h-[70dvh] @max-xl/loom:overflow-y-auto @max-xl/loom:bg-background @max-xl/loom:pt-1.5 @max-xl/loom:pb-[env(safe-area-inset-bottom)]">
        <div data-gate-footer className="loom-card flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-2.5">
          <Footer gate={gate} view={view} tray={tray} busy={busy} onApprove={onApprove} />
        </div>
      </div>
    </div>
  );
}
