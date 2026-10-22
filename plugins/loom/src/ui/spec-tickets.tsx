import { Fragment, useContext, useState } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import type { SpecVersionView } from "../contract";
import { repoSettings } from "../repos";
import type { TicketSpec } from "../spec";
import { changedAt, dependencyChain, wavesOf } from "../spec-paths";
import { BUTTON, CARD, CHIP, HEADING, RepoChip, listText, plural } from "./common";
import { MarksContext, NOTE_BUTTON, Noteable, notesUnder } from "./spec-marks";

const BRIEF_LIMIT = 1200;
const criteria = (count: number) => `${count} ${count === 1 ? "criterion" : "criteria"}`;

/** "document-sheet waits for fonts and paper-tokens, and unblocks editor-mono." */
function chainSentence(ref: string, { up, down }: { up: string[]; down: string[] }): string {
  const unblocks = down.length === 0 ? "unblocks nothing" : `unblocks ${listText(down)}`;
  return up.length === 0 ? `${ref} starts right away and ${unblocks}.` : `${ref} waits for ${listText(up)}, and ${unblocks}.`;
}

/** The tickets in their dependency waves from top to bottom; a highlighted ticket lights up everything it waits for and everything it unblocks. */
export function TicketsPane({ view, selected, highlighted, onPick, onClear }: { view: SpecVersionView; selected: string; highlighted: string | null; onPick(ref: string): void; onClear(): void }) {
  const marks = useContext(MarksContext);
  const { spec } = view;
  const waves = wavesOf(spec.ticket);
  const columns: TicketSpec[][] = [];
  for (const ticket of spec.ticket) (columns[waves[ticket.ref]!] ??= []).push(ticket);
  const refs = new Set(spec.ticket.map((ticket) => ticket.ref));
  const overlapping = new Set(view.overlaps.flatMap((overlap) => [overlap.a, overlap.b]));
  const chain = highlighted === null ? null : dependencyChain(spec.ticket, highlighted);
  const roleOf = (ref: string) => (chain === null ? undefined : ref === highlighted ? "self" : chain.up.includes(ref) ? "up" : chain.down.includes(ref) ? "down" : undefined);
  const workers = spec.agents.max_workers;

  return (
    <div className="space-y-3">
      {view.warnings.length === 0 ? (
        <p className="text-xs text-muted-foreground">No warnings in v{view.version}.</p>
      ) : (
        <ul data-spec-warnings className="space-y-1 text-xs text-warning-text">
          {view.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      <p className="text-sm">
        {plural(spec.ticket.length, "ticket")} in {plural(columns.length, "wave")}. {workers === 1 ? "One worker runs" : `Up to ${workers} workers run`} at a time; a ticket starts when everything it waits for is done.
      </p>
      {chain === null ? (
        <p className="text-xs text-muted-foreground">Select a ticket to light up what it waits for and what it unblocks.</p>
      ) : (
        <p className="flex flex-wrap items-center gap-2 text-xs">
          <span data-spec-focus>{chainSentence(highlighted!, chain)}</span>
          <button type="button" className={BUTTON} onClick={onClear}>
            Show all
          </button>
        </p>
      )}
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="rounded border border-primary px-1 text-foreground">selected</span>
        <span className="text-warning-text">has your note</span>
        <span className="text-primary">changed</span>
      </p>
      {columns.map((column, wave) => (
        <section key={wave} data-spec-wave={wave + 1} className="space-y-1.5">
          <h4 className="text-xs font-semibold">
            Wave {wave + 1} <span className="font-normal text-muted-foreground">· {wave === 0 ? "starts right away" : `after wave ${wave}`}</span>
          </h4>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-2">
            {column.map((ticket) => {
              const notes = marks === null ? 0 : notesUnder(marks.notePaths, `ticket[${ticket.ref}]`);
              const changed = view.changes !== null && changedAt(view.changes, [`ticket[${ticket.ref}]`]);
              const after = ticket.depends_on.filter((dep) => refs.has(dep));
              const role = roleOf(ticket.ref);
              const dimmed = chain !== null && role === undefined;
              const border = role === "self" ? "border-primary bg-surface-selected ring-1 ring-primary" : `bg-surface-recessed ${ticket.ref === selected || role !== undefined ? "border-primary" : "border-border-seam"}`;
              return (
                <div key={ticket.ref} className={`group relative min-w-0 transition-opacity ${dimmed ? "opacity-40" : ""}`}>
                  <button
                    type="button"
                    data-spec-card={ticket.ref}
                    data-chain={role}
                    data-dimmed={dimmed || undefined}
                    aria-pressed={ticket.ref === selected}
                    onClick={() => onPick(ticket.ref)}
                    className={`block w-full min-w-0 cursor-pointer rounded-md border p-2 text-left hover:bg-state-hover ${border}`}
                  >
                    <span className="block pr-14 text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{ticket.ref}</span>
                    <span className="block text-sm font-medium">{ticket.title}</span>
                    {after.length > 0 && <span className="block text-[11px] text-muted-foreground [overflow-wrap:anywhere]">after {after.join(", ")}</span>}
                    <span className="mt-1.5 flex flex-wrap gap-1 text-muted-foreground">
                      {ticket.repo !== undefined && <RepoChip name={ticket.repo} />}
                      <span className={CHIP}>P{ticket.priority}</span>
                      <span className={CHIP}>{criteria(ticket.acceptance.length)}</span>
                      <span className={CHIP}>{plural(ticket.scope.length, "path")}</span>
                      <span className={CHIP}>{ticket.verify.length > 0 ? "own verify" : "checks only"}</span>
                      {overlapping.has(ticket.ref) && <span className={`${CHIP} text-warning-text`}>overlap</span>}
                      {changed && <span className={`${CHIP} text-primary`}>changed</span>}
                      {notes > 0 && <span className={`${CHIP} text-warning-text`}>{plural(notes, "note")}</span>}
                    </span>
                  </button>
                  {marks?.onNote !== undefined && (
                    <button type="button" aria-label={`Add a note on ticket ${ticket.ref}`} className={`${NOTE_BUTTON} absolute top-1.5 right-1.5`} onClick={() => marks.onNote?.({ paths: [`ticket[${ticket.ref}]`], label: `${ticket.ref} (whole ticket)` })}>
                      + note
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

/** The first paragraphs of a long brief, cut at a blank line outside a code fence; null when the brief is short enough to show whole. */
function briefPreview(body: string): string | null {
  if (body.length <= BRIEF_LIMIT) return null;
  let at = 0;
  let cut = 0;
  let fenced = false;
  for (const line of body.split("\n")) {
    if (at + line.length > BRIEF_LIMIT) break;
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && at > 0 && line.trim() === "") cut = at;
    at += line.length + 1;
  }
  if (cut >= BRIEF_LIMIT / 4) return body.slice(0, cut).trimEnd();
  const space = body.lastIndexOf(" ", BRIEF_LIMIT);
  return `${body.slice(0, space > 0 ? space : BRIEF_LIMIT).trimEnd()} …`;
}

function Brief({ path, label, body }: { path: string; label: string; body: string }) {
  const [whole, setWhole] = useState(false);
  const preview = briefPreview(body);
  return (
    <>
      <Noteable paths={[path]} label={label}>
        <Markdown content={preview === null || whole ? body : preview} className="text-sm [overflow-wrap:anywhere] [&_pre]:whitespace-pre-wrap" />
      </Noteable>
      {preview !== null && (
        <button type="button" className={`${BUTTON} ml-2`} aria-expanded={whole} onClick={() => setWhole(!whole)}>
          {whole ? "Show less" : "Show the whole brief"}
        </button>
      )}
    </>
  );
}

/** The selected ticket in full, as a wide card: the brief on the left, the facts on the right, each part with its own note button. */
export function Inspector({ view, selected, onPick }: { view: SpecVersionView; selected: string; onPick(ref: string): void }) {
  const { spec } = view;
  const ticket = spec.ticket.find((entry) => entry.ref === selected)!;
  const base = `ticket[${ticket.ref}]`;
  const wave = wavesOf(spec.ticket)[ticket.ref]! + 1;
  const dependents = spec.ticket.filter((entry) => entry.depends_on.includes(ticket.ref)).map((entry) => entry.ref);
  const checks = repoSettings(spec, ticket.repo ?? null).checks;
  const refButtons = (refs: readonly string[]) =>
    refs.map((ref, index) => (
      <Fragment key={ref}>
        {index > 0 && ", "}
        <button type="button" className="cursor-pointer text-primary underline-offset-2 hover:underline" onClick={() => onPick(ref)}>
          {ref}
        </button>
      </Fragment>
    ));

  return (
    <section data-spec-inspector aria-label={`Ticket ${ticket.ref}`} className={`${CARD} @container space-y-2`}>
      <Noteable paths={[`${base}.title`]} label={`${ticket.ref} › title`}>
        <h3 className="text-base font-semibold">{ticket.title}</h3>
      </Noteable>
      <div className="grid gap-4 @3xl:grid-cols-[minmax(0,64ch)_minmax(18rem,1fr)]">
        <div className="min-w-0 max-w-[64ch] space-y-1">
          <h4 className={HEADING}>Brief for the worker</h4>
          <Brief key={ticket.ref} path={`${base}.body`} label={`${ticket.ref} › brief`} body={ticket.body} />
        </div>
        <div className="min-w-0 space-y-1">
          <Noteable paths={[base]} label={`${ticket.ref} (whole ticket)`}>
            <p className="text-xs text-muted-foreground">
              <span className="font-mono text-foreground [overflow-wrap:anywhere]">{ticket.ref}</span> · P{ticket.priority} · wave {wave}
              {ticket.repo !== undefined && <> · repo {ticket.repo}</>}
            </p>
          </Noteable>
          <Noteable paths={[`${base}.depends_on`]} label={`${ticket.ref} › waits for`}>
            <span className={HEADING}>Waits for</span> {ticket.depends_on.length === 0 ? "none, so it starts in wave 1" : refButtons(ticket.depends_on)}
          </Noteable>
          <p data-spec-unblocks className="py-1 pl-2 text-sm">
            <span className={HEADING}>Unblocks</span> {dependents.length === 0 ? "nothing" : refButtons(dependents)}
          </p>
          <h4 className={`${HEADING} pt-1`}>Acceptance criteria</h4>
          <ol className="list-none">
            {ticket.acceptance.map((line, index) => (
              <li key={index}>
                <Noteable paths={[`${base}.acceptance[${index}]`]} label={`${ticket.ref} › criterion ${index + 1}`}>
                  {index + 1}. {line}
                </Noteable>
              </li>
            ))}
          </ol>
          <h4 className={`${HEADING} pt-1`}>May change</h4>
          <div className="flex flex-wrap gap-1">
            {ticket.scope.map((glob, index) => (
              <Noteable key={index} paths={[`${base}.scope[${index}]`]} label={`${ticket.ref} › path ${glob}`}>
                <code className="rounded bg-surface-recessed px-1 font-mono text-xs [overflow-wrap:anywhere]">{glob}</code>
              </Noteable>
            ))}
          </div>
          <h4 className={`${HEADING} pt-1`}>Verify</h4>
          {ticket.verify.length === 0 ? (
            <Noteable paths={[`${base}.verify`]} label={`${ticket.ref} › verify`}>
              <span className="text-muted-foreground">No command of its own; only {listText(checks)} {checks.length === 1 ? "runs" : "run"}.</span>
            </Noteable>
          ) : (
            ticket.verify.map((command, index) => (
              <Noteable key={index} paths={[`${base}.verify[${index}]`]} label={`${ticket.ref} › verify ${index + 1}`}>
                <code className="font-mono text-xs [overflow-wrap:anywhere]">{command}</code>
              </Noteable>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
