import { useState, type ReactNode } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import type { SpecVersionView } from "../contract";
import type { Spec, TicketSpec } from "../spec";
import type { SpecChange } from "../spec-diff";
import { repoSettings } from "../repos";
import { wavesOf } from "../spec-paths";
import { BUTTON, CHIP, HEADING, RepoChip, listText, plural } from "./common";
import { FilesPane } from "./spec-panes";
import { CHANGED_TAG, Commentable, DiffList, NEW_TAG, REMOVED_TAG, ReviewContext, WordDiff, changeAt, kept, useReview, type ListMark } from "./spec-review-kit";
import { PRIORITY_COLOURS, TicketMap, type TicketMark } from "./spec-ticket-map";

export type TicketLayout = "list" | "map" | "files";
const LAYOUTS: ReadonlyArray<{ layout: TicketLayout; label: string }> = [
  { layout: "list", label: "List + detail" },
  { layout: "map", label: "Map" },
  { layout: "files", label: "Files" },
];
/** The selected ticket: a ref of the spec on screen, or `removed:<ref>` for a ticket it dropped. */
export const REMOVED = "removed:";
const LONG_BRIEF = 900;

function Priority({ priority }: { priority: number }) {
  return <span className={`inline-flex h-4 shrink-0 items-center rounded px-1 text-[10px] font-bold text-white ${PRIORITY_COLOURS[priority] ?? "bg-subtle-foreground"}`}>P{priority}</span>;
}

function Label({ children }: { children: ReactNode }) {
  return <h4 className={`${HEADING} mt-3 mb-1 first:mt-0`}>{children}</h4>;
}

/** How a ticket compares with the version on the other side: new, changed, or the same (null when nothing is compared). */
function markOf(changes: readonly SpecChange[], compared: boolean, ref: string): TicketMark {
  if (!compared) return null;
  if (changes.some((change) => change.kind === "ticket-added" && change.ref === ref)) return "new";
  return changes.some((change) => change.ref === ref) ? "changed" : "same";
}

/** The parts of a ticket that changed, for its list row: "criteria, files". */
function changedParts(changes: readonly SpecChange[], ref: string): string[] {
  const names: Record<string, string> = { title: "title", body: "brief", acceptance: "criteria", scope: "files", verify: "verify", depends_on: "order", merge_after: "merge order", priority: "priority", repo: "repo" };
  const parts = changes.filter((change) => change.ref === ref && change.kind !== "ticket-added").map((change) => names[/^ticket\[[^\]]+\]\.(\w+)/.exec(change.path)?.[1] ?? ""] ?? "");
  return [...new Set(parts.filter((part) => part !== ""))];
}

function Brief({ ticket, base }: { ticket: TicketSpec; base: string }) {
  const review = useReview();
  const change = changeAt(review, `${base}.body`);
  const [whole, setWhole] = useState(false);
  const [diff, setDiff] = useState<boolean | null>(null);
  const showDiff = change?.kind === "text" && (diff ?? review.only);
  return (
    <div className="min-w-0">
      <Label>
        Brief for the worker {change !== undefined && <span className={`${CHANGED_TAG} ml-1 normal-case tracking-normal`}>rewritten</span>}
      </Label>
      <Commentable target={{ paths: [`${base}.body`], label: `${ticket.ref} › brief`, kind: "text" }} className="p-1" showWas={false}>
        {showDiff ? (
          <WordDiff before={change.before} after={change.after} />
        ) : (
          <div className={ticket.body.length > LONG_BRIEF && !whole ? "max-h-72 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]" : ""}>
            <Markdown content={ticket.body} className="text-sm [overflow-wrap:anywhere] [&_pre]:whitespace-pre-wrap" />
          </div>
        )}
      </Commentable>
      <div className="mt-1 flex flex-wrap gap-1">
        {!showDiff && ticket.body.length > LONG_BRIEF && (
          <button type="button" className={BUTTON} aria-expanded={whole} onClick={() => setWhole(!whole)}>
            {whole ? "Show less" : "Read the whole brief"}
          </button>
        )}
        {change?.kind === "text" && (
          <button type="button" className={BUTTON} onClick={() => setDiff(!showDiff)}>
            {showDiff ? "Show the brief as it reads now" : "Show what changed"}
          </button>
        )}
      </div>
    </div>
  );
}

/** One ticket in full: its brief, criteria, files, verify commands, order and priority, each part with what changed and a comment. */
function TicketDetail({ ticket, spec, view, onSelect }: { ticket: TicketSpec; spec: Spec; view: Pick<SpecVersionView, "overlaps">; onSelect(ref: string): void }) {
  const review = useReview();
  const base = `ticket[${ticket.ref}]`;
  const [whole, setWhole] = useState(false);
  const isNew = review.changes.some((change) => change.kind === "ticket-added" && change.ref === ticket.ref);
  // A ticket picked on the map that did not change shows whole; a changed one shows what changed and what carries a note.
  const trim = review.only && !isNew && !whole && kept(review, [base]);
  const has = (part: string) => !trim || kept(review, [`${base}.${part}`]);
  const wave = wavesOf(spec.ticket)[ticket.ref]! + 1;
  const dependents = spec.ticket.filter((entry) => entry.depends_on.includes(ticket.ref)).map((entry) => entry.ref);
  const checks = repoSettings(spec, ticket.repo ?? null).checks;
  const overlaps = view.overlaps.filter((overlap) => overlap.a === ticket.ref || overlap.b === ticket.ref);
  const chip = (ref: string, mark: ListMark = null) =>
    mark === "removed" ? (
      <span key={ref} data-removed className="rounded-full border border-dashed border-destructive-text/40 px-2 font-mono text-[11px] leading-5 text-destructive-text line-through">
        {ref}
      </span>
    ) : (
      <button key={ref} type="button" onClick={() => onSelect(ref)} className={`cursor-pointer rounded-full border px-2 font-mono text-[11px] leading-5 hover:border-primary ${mark === "added" ? "border-success bg-success/15" : "border-border-seam"}`}>
        {ref}
      </button>
    );
  const item = (kind: "criterion" | "file" | "command", part: string, label: (index: number, text: string) => string) => (text: string, mark: ListMark, index: number) =>
    mark === "removed" ? (
      <span data-removed className={`block rounded-md bg-destructive-text/10 px-1.5 py-1 text-destructive-text line-through ${kind === "criterion" ? "text-sm" : "font-mono text-xs"}`}>
        {text}
      </span>
    ) : (
      <Commentable target={{ paths: [`${base}.${part}[${index}]`], label: label(index, text), kind }} className={`px-1.5 py-1 ${kind === "criterion" ? "text-sm" : "font-mono text-xs [overflow-wrap:anywhere]"} ${mark === "added" ? "bg-success/15 ring-1 ring-success" : kind === "criterion" ? "" : "bg-surface-recessed"}`}>
        {kind === "criterion" && <span className="mr-1.5 text-xs text-subtle-foreground">{index + 1}.</span>}
        {text}
        {mark === "added" && <span className="ml-1.5 text-[10px] font-semibold text-success">new</span>}
      </Commentable>
    );
  const brief = has("body") ? <Brief ticket={ticket} base={base} /> : null;
  const facts = (
    <div className="min-w-0">
      {has("acceptance") && (
        <>
          <Label>Done when</Label>
          <div className="space-y-1">
            <DiffList path={`${base}.acceptance`} items={ticket.acceptance} compact={trim} render={item("criterion", "acceptance", (index) => `${ticket.ref} › criterion ${index + 1}`)} />
          </div>
        </>
      )}
      {has("scope") && (
        <>
          <Label>May change · {ticket.scope.length}</Label>
          <div className="flex flex-wrap gap-1">
            <DiffList path={`${base}.scope`} items={ticket.scope} compact={trim} render={item("file", "scope", (_, glob) => `${ticket.ref} › file ${glob}`)} />
          </div>
        </>
      )}
      {has("verify") && (
        <>
          <Label>Verify</Label>
          {ticket.verify.length === 0 && changeAt(review, `${base}.verify`) === undefined ? (
            <Commentable target={{ paths: [`${base}.verify`], label: `${ticket.ref} › verify`, kind: "command" }} className="p-1 text-sm text-muted-foreground">
              No command of its own; only {listText(checks)} {checks.length === 1 ? "runs" : "run"}.
            </Commentable>
          ) : (
            <div className="space-y-1">
              <DiffList path={`${base}.verify`} items={ticket.verify} compact={trim} render={item("command", "verify", (index) => `${ticket.ref} › verify ${index + 1}`)} />
            </div>
          )}
        </>
      )}
      {has("depends_on") && (
        <>
          <Label>Order</Label>
          <p className="flex flex-wrap items-center gap-1.5 text-sm">
            <Commentable as="span" target={{ paths: [`${base}.depends_on`], label: `${ticket.ref} › waits for`, kind: "deps" }} className="px-1 text-muted-foreground" showWas={false}>
              Waits for
            </Commentable>
            {ticket.depends_on.length === 0 && changeAt(review, `${base}.depends_on`) === undefined ? <span className="text-xs text-muted-foreground">nothing, so it starts in wave 1</span> : <DiffList path={`${base}.depends_on`} items={ticket.depends_on} compact={false} render={(ref, mark) => chip(ref, mark)} />}
          </p>
          <p data-unblocks className="mt-1 flex flex-wrap items-center gap-1.5 text-sm">
            <span className="px-1 text-muted-foreground">Unblocks</span>
            {dependents.length === 0 ? <span className="text-xs text-muted-foreground">nothing</span> : dependents.map((ref) => chip(ref))}
          </p>
        </>
      )}
      {has("merge_after") && ((ticket.merge_after ?? []).length > 0 || changeAt(review, `${base}.merge_after`) !== undefined) && (
        <p data-merge-after className="mt-1 flex flex-wrap items-center gap-1.5 text-sm">
          <Commentable as="span" target={{ paths: [`${base}.merge_after`], label: `${ticket.ref} › merges after`, kind: "deps" }} className="px-1 text-muted-foreground" showWas={false}>
            Merges after
          </Commentable>
          <DiffList path={`${base}.merge_after`} items={ticket.merge_after ?? []} compact={false} render={(ref, mark) => chip(ref, mark)} />
        </p>
      )}
      {(trim || whole) && (
        <button type="button" className={`${BUTTON} mt-3`} onClick={() => setWhole(!whole)}>
          {whole ? "Show only what changed" : "Show the whole ticket"}
        </button>
      )}
    </div>
  );
  return (
    <article data-ticket-detail={ticket.ref} data-anchor={base} aria-label={`Ticket ${ticket.ref}`} className="@container min-w-0 rounded-lg border border-border-seam bg-card p-3">
      <header className="flex flex-wrap items-center gap-2">
        <Commentable as="span" target={{ paths: [`${base}.priority`], label: `${ticket.ref} › priority`, kind: "enum", value: ticket.priority, options: [0, 1, 2, 3], names: { 0: "P0", 1: "P1", 2: "P2", 3: "P3" } }} className="inline-flex items-center">
          <Priority priority={ticket.priority} />
        </Commentable>
        <span className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{ticket.ref}</span>
        <span className={`${CHIP} px-2 text-muted-foreground`}>wave {wave}</span>
        {ticket.repo !== undefined && (
          <Commentable as="span" target={{ paths: [`${base}.repo`], label: `${ticket.ref} › repo`, kind: "text", value: ticket.repo }} className="inline-flex items-center">
            <RepoChip name={ticket.repo} />
          </Commentable>
        )}
        {isNew && <span className={NEW_TAG}>NEW IN v{review.version}</span>}
        {review.onComment !== undefined && (
          <button type="button" className={`${BUTTON} ml-auto`} onClick={(event) => review.onComment!({ paths: [base], label: `${ticket.ref} (whole ticket)`, kind: "ticket" }, event.currentTarget)}>
            Comment on the ticket
          </button>
        )}
      </header>
      <Commentable target={{ paths: [`${base}.title`], label: `${ticket.ref} › title`, kind: "text" }} className="mt-1.5 p-1">
        <h3 className="inline text-base font-semibold">{ticket.title}</h3>
      </Commentable>
      {overlaps.length > 0 && (
        <p data-ticket-overlap className="mt-2 rounded-md bg-warning/10 px-2 py-1.5 text-xs text-warning-text">
          {overlaps.map((overlap) => `Shares ${listText(overlap.paths)} with ${overlap.a === ticket.ref ? overlap.b : overlap.a}, and nothing orders them, so they run one at a time.`).join(" ")}
        </p>
      )}
      <div className={`mt-2 grid gap-4 ${brief === null ? "" : "@3xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]"}`}>
        {brief}
        {facts}
      </div>
    </article>
  );
}

/** A ticket the version on screen dropped, as the compared version had it, read only. */
function RemovedDetail({ change, compared, onSelect }: { change: Extract<SpecChange, { kind: "ticket-removed" }>; compared: Spec; onSelect(ref: string): void }) {
  const review = useReview();
  const ticket = compared.ticket.find((entry) => entry.ref === change.ref)!;
  return (
    <div data-removed-ticket={change.ref} className="space-y-2">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span className={REMOVED_TAG}>REMOVED IN v{review.version}</span>
        <span className="font-mono text-xs text-muted-foreground">{change.ref}</span>
        {change.into.length > 0 && (
          <>
            <span className="text-xs text-muted-foreground">its files go to</span>
            {change.into.map((ref) => (
              <button key={ref} type="button" className="cursor-pointer rounded-full border border-border-seam px-2 font-mono text-[11px] leading-5 hover:border-primary" onClick={() => onSelect(ref)}>
                {ref}
              </button>
            ))}
          </>
        )}
      </p>
      <ReviewContext.Provider value={{ version: review.version, changes: [], only: false, notes: [] }}>
        <div className="opacity-80">
          <TicketDetail ticket={ticket} spec={compared} view={{ overlaps: [] }} onSelect={() => undefined} />
        </div>
      </ReviewContext.Provider>
    </div>
  );
}

/** The tickets: a list beside the picked ticket, a map of the waves over the same detail, or the files they may change. */
export function TicketsSection({
  view,
  compared,
  layout,
  onLayout,
  selected,
  onSelect,
  filesView,
  onShowAll,
}: {
  view: SpecVersionView;
  compared: Spec | null;
  layout: TicketLayout;
  onLayout(layout: TicketLayout): void;
  selected: string | null;
  onSelect(ref: string): void;
  /** The view the Files layout reads, with the changes from the compared version. */
  filesView: SpecVersionView;
  onShowAll(): void;
}) {
  const review = useReview();
  const { spec } = view;
  const [lit, setLit] = useState<string | null>(null);
  const waves = wavesOf(spec.ticket);
  const shown = spec.ticket.filter((ticket) => kept(review, [`ticket[${ticket.ref}]`]));
  const removed = review.changes.filter((change): change is Extract<SpecChange, { kind: "ticket-removed" }> => change.kind === "ticket-removed");
  const hidden = spec.ticket.length - shown.length;
  const removedPick = selected?.startsWith(REMOVED) ? removed.find((change) => `${REMOVED}${change.ref}` === selected) : undefined;
  const pick = removedPick === undefined ? (spec.ticket.find((ticket) => ticket.ref === selected) ?? shown[0] ?? (review.only ? null : spec.ticket[0]!)) : null;
  const notesOn = (ref: string) => review.notes.filter((note) => note.paths.some((path) => path === `ticket[${ref}]` || path.startsWith(`ticket[${ref}].`))).length;
  const mark = (ref: string) => markOf(review.changes, compared !== null, ref);
  const columns: TicketSpec[][] = [];
  for (const ticket of shown) (columns[waves[ticket.ref]!] ??= []).push(ticket);
  const workers = spec.agents.max_workers;
  const waveCount = Math.max(...Object.values(waves)) + 1;

  const detail = removedPick !== undefined ? <RemovedDetail change={removedPick} compared={compared!} onSelect={onSelect} /> : pick !== null ? <TicketDetail key={pick.ref} ticket={pick} spec={spec} view={view} onSelect={onSelect} /> : null;
  const list = (
    <nav aria-label="Tickets" data-ticket-list className="max-h-[42rem] min-w-0 overflow-y-auto rounded-lg border border-border-seam bg-card p-1">
      {columns.map((column, wave) =>
        column === undefined ? null : (
          <div key={wave}>
            <h4 className={`${HEADING} px-2 pt-2 pb-1`}>
              Wave {wave + 1}
              {wave === 0 ? " · starts at once" : ""}
            </h4>
            {column.map((ticket) => {
              const parts = changedParts(review.changes, ticket.ref);
              const ticketMark = mark(ticket.ref);
              const notes = notesOn(ticket.ref);
              return (
                <button
                  key={ticket.ref}
                  type="button"
                  data-ticket-row={ticket.ref}
                  data-mark={ticketMark ?? undefined}
                  aria-current={pick?.ref === ticket.ref ? "true" : undefined}
                  onClick={() => onSelect(ticket.ref)}
                  className={`flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${pick?.ref === ticket.ref ? "bg-surface-selected font-medium" : "hover:bg-state-hover"}`}
                >
                  <Priority priority={ticket.priority} />
                  <span className="min-w-0 flex-1 truncate" title={`${ticket.ref}: ${ticket.title}`}>
                    {ticket.title}
                  </span>
                  {ticket.repo !== undefined && <RepoChip name={ticket.repo} />}
                  {ticketMark === "new" ? <span className={NEW_TAG}>NEW</span> : ticketMark === "changed" ? <span className="shrink-0 text-[10.5px] text-primary">{parts.join(", ") || "changed"}</span> : null}
                  {notes > 0 && <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-warning px-1 text-[10px] font-semibold text-black">{notes}</span>}
                </button>
              );
            })}
          </div>
        ),
      )}
      {removed.length > 0 && (
        <div>
          <h4 className={`${HEADING} px-2 pt-2 pb-1`}>Removed in v{review.version}</h4>
          {removed.map((change) => (
            <button
              key={change.ref}
              type="button"
              data-ticket-row={`${REMOVED}${change.ref}`}
              aria-current={removedPick?.ref === change.ref ? "true" : undefined}
              onClick={() => onSelect(`${REMOVED}${change.ref}`)}
              className={`flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${removedPick?.ref === change.ref ? "bg-surface-selected" : "hover:bg-state-hover"}`}
            >
              <span className={REMOVED_TAG}>−</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground line-through">{compared?.ticket.find((ticket) => ticket.ref === change.ref)?.title ?? change.ref}</span>
            </button>
          ))}
        </div>
      )}
      {hidden > 0 && <p className="px-2 py-2 text-[11px] text-subtle-foreground">… {plural(hidden, "unchanged ticket")} hidden</p>}
    </nav>
  );

  return (
    <div className="space-y-3">
      {view.warnings.length > 0 && (
        <ul data-spec-warnings className="space-y-0.5 rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-xs text-warning-text">
          {view.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Ticket layout" className="inline-flex gap-0.5 rounded-md border border-border-seam bg-card p-0.5">
          {LAYOUTS.map((entry) => (
            <button key={entry.layout} type="button" aria-pressed={layout === entry.layout} onClick={() => onLayout(entry.layout)} className={`cursor-pointer rounded px-2.5 py-0.5 text-xs ${layout === entry.layout ? "bg-surface-selected font-semibold text-foreground" : "text-muted-foreground hover:bg-state-hover"}`}>
              {entry.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">
          {plural(spec.ticket.length, "ticket")} in {plural(waveCount, "wave")}; {workers === 1 ? "one runs" : `up to ${workers} run`} at a time.
          {layout === "map" && " Hover a ticket to trace what it waits for and unblocks."}
        </span>
      </div>
      {layout === "files" ? (
        <FilesPane view={filesView} highlighted={lit} onPick={(ref) => setLit(ref === lit ? null : ref)} onClear={() => setLit(null)} />
      ) : layout === "map" ? (
        <>
          <TicketMap tickets={spec.ticket} selected={removedPick === undefined ? (pick?.ref ?? null) : null} onSelect={onSelect} markOf={mark} pinsOf={notesOn} fadedOf={(ref) => !kept(review, [`ticket[${ref}]`])} />
          {removed.length > 0 && (
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              Removed in v{review.version}:
              {removed.map((change) => (
                <button key={change.ref} type="button" className="cursor-pointer rounded-full border border-dashed border-destructive-text/40 px-2 font-mono text-[11px] leading-5 text-destructive-text line-through" onClick={() => onSelect(`${REMOVED}${change.ref}`)}>
                  {change.ref}
                </button>
              ))}
            </p>
          )}
          {detail}
        </>
      ) : (
        <div className="grid gap-3 @3xl:grid-cols-[17rem_minmax(0,1fr)]">
          {list}
          <div className="min-w-0">{detail}</div>
        </div>
      )}
      {hidden > 0 && layout !== "files" && (
        <p data-hidden-line className="flex items-center gap-2 rounded-md border border-dashed border-border-seam px-3 py-2 text-xs text-muted-foreground">
          {hidden === spec.ticket.length ? "No ticket changed." : `${plural(hidden, "ticket")} did not change.`}
          <button type="button" className={`${BUTTON} ml-auto`} onClick={onShowAll}>
            Show {hidden === 1 ? "it" : "them"}
          </button>
        </p>
      )}
    </div>
  );
}

