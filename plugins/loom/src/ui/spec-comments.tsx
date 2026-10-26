import { useEffect, useRef, useState } from "react";
import type { SentNote, SpecVersionView } from "../contract";
import { notesMessage } from "../prompts";
import { sectionOf, type SpecSection } from "../spec-diff";
import { WHOLE_SPEC } from "../spec-paths";
import { BUTTON, BUTTON_PRIMARY, ConfirmButton, FIELD, HEADING, plural, useLoomWrite, useRun } from "./common";
import { sentForm, type DraftNote } from "./spec-notes";
import { Pin, formatValue, tomlLiteral, type CommentKind, type CommentTarget, type SpecValue } from "./spec-review-kit";

const SECTIONS: ReadonlyArray<{ section: SpecSection; label: string }> = [
  { section: "settings", label: "How it runs" },
  { section: "tickets", label: "Tickets" },
  { section: "guardrails", label: "Goal & guardrails" },
];

const QUICK: Record<CommentKind, readonly string[]> = {
  ticket: ["Split it in two", "Merge it into another ticket", "Drop it", "It is too vague", "It should run earlier"],
  criterion: ["Unclear", "Not testable", "Missing a case", "Drop it"],
  file: ["Should not change this", "Too broad", "Also needs another file"],
  command: ["Drop it", "Wrong command", "Too slow"],
  deps: ["Should not wait for this", "Should also wait for another ticket"],
  text: ["Unclear", "Drop it", "Needs more detail"],
  enum: [],
  number: [],
  bool: [],
};
// Quick picks that start a sentence for the human to finish; the others are a whole remark.
const STARTERS: Readonly<Record<string, string>> = {
  "Split it in two": "Split this ticket in two: ",
  "Merge it into another ticket": "Merge this into ",
  "It should run earlier": "Run this earlier: it does not need ",
  "Should also wait for another ticket": "Also wait for ",
  "Also needs another file": "Also needs ",
};

const OPTION = "cursor-pointer rounded-full border border-border-seam px-2 text-xs leading-5 hover:border-warning-text";

/** The comment box for one part: a suggested value where the part has one, quick picks, and the text. */
export function CommentBox({ target, existing, position, onSave, onDelete, onCancel }: { target: CommentTarget; existing: DraftNote | null; position: { top: number; left: number }; onSave(body: string, suggest: DraftNote["suggest"]): void; onDelete?(): void; onCancel(): void }) {
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [body, setBody] = useState(existing?.body ?? "");
  const initial = existing?.suggest ?? (target.preset !== undefined && target.value !== undefined && target.preset !== target.value ? { from: tomlLiteral(target.value), to: tomlLiteral(target.preset) } : undefined);
  const [suggest, setSuggest] = useState<DraftNote["suggest"]>(initial);
  const current = target.value;
  const toggle = (next: SpecValue) => setSuggest(current === undefined || next === current || suggest?.to === tomlLiteral(next) ? undefined : { from: tomlLiteral(current), to: tomlLiteral(next) });
  const save = () => {
    if (body.trim() === "" && suggest === undefined) return field.current?.focus();
    onSave(body.trim(), suggest);
  };
  useEffect(() => {
    field.current?.focus();
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) onCancel();
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [onCancel]);

  const name = (value: SpecValue) => target.names?.[String(value)] ?? formatValue(value);
  let choices = null;
  if (current !== undefined && target.kind === "enum" && target.options !== undefined) {
    choices = (
      <div className="flex flex-wrap gap-1">
        {target.options.map((option) =>
          option === current ? (
            <span key={String(option)} className="rounded-full border border-dashed border-border-seam px-2 text-xs leading-5 text-subtle-foreground">
              {name(option)} · now
            </span>
          ) : (
            <button key={String(option)} type="button" aria-pressed={suggest?.to === tomlLiteral(option)} className={`${OPTION} ${suggest?.to === tomlLiteral(option) ? "border-warning bg-warning text-black" : ""}`} onClick={() => toggle(option)}>
              {name(option)}
            </button>
          ),
        )}
      </div>
    );
  } else if (typeof current === "number" && target.kind === "number") {
    const step = target.step ?? 1;
    const shown = suggest === undefined ? current : Number(suggest.to);
    const move = (by: number) => toggle(Math.min(target.max ?? Number.MAX_SAFE_INTEGER, Math.max(target.min ?? 0, shown + by)));
    choices = (
      <div className="flex items-center gap-1.5">
        <button type="button" aria-label="Less" className={BUTTON} disabled={shown <= (target.min ?? 0)} onClick={() => move(-step)}>
          −
        </button>
        <output aria-label="Suggested value" className="min-w-12 text-center text-sm font-semibold tabular-nums">
          {shown}
          {target.unit === undefined ? "" : ` ${target.unit}`}
        </output>
        <button type="button" aria-label="More" className={BUTTON} disabled={shown >= (target.max ?? Number.MAX_SAFE_INTEGER)} onClick={() => move(step)}>
          +
        </button>
        <span className="text-[11px] text-subtle-foreground">
          now {current}
          {target.min !== undefined && target.max !== undefined && ` · ${target.min} to ${target.max}`}
        </span>
      </div>
    );
  } else if (typeof current === "boolean" && target.kind === "bool") {
    choices = (
      <div className="flex flex-wrap gap-1">
        <span className="rounded-full border border-dashed border-border-seam px-2 text-xs leading-5 text-subtle-foreground">{current ? "on" : "off"} · now</span>
        <button type="button" aria-pressed={suggest !== undefined} className={`${OPTION} ${suggest !== undefined ? "border-warning bg-warning text-black" : ""}`} onClick={() => toggle(!current)}>
          Turn it {current ? "off" : "on"}
        </button>
      </div>
    );
  }
  if (choices === null && suggest !== undefined) {
    choices = (
      <div className="flex flex-wrap items-center gap-1.5">
        <Suggestion suggest={suggest} />
        <button type="button" className={OPTION} onClick={() => setSuggest(undefined)}>
          Drop the suggestion
        </button>
      </div>
    );
  }
  const quick = QUICK[target.kind];

  return (
    <div
      ref={box}
      role="dialog"
      aria-label={`Comment on ${target.label}`}
      data-comment-box
      style={{ top: position.top, left: position.left }}
      className="absolute z-40 w-[22rem] max-w-[calc(100%-1.5rem)] space-y-2 rounded-lg border border-border-seam bg-popover p-3 text-popover-foreground shadow-lg"
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) save();
      }}
    >
      <div className="flex items-start gap-2">
        <p className="min-w-0 text-xs">
          {existing === null ? "Comment on" : "Edit the comment on"} <b className="block text-sm">{target.label}</b>
          <code className="font-mono text-[11px] text-subtle-foreground [overflow-wrap:anywhere]">{target.paths[0]}</code>
        </p>
        <button type="button" aria-label="Close" className="ml-auto cursor-pointer rounded px-1 text-muted-foreground hover:bg-state-hover" onClick={onCancel}>
          ✕
        </button>
      </div>
      {choices !== null && (
        <div className="space-y-1">
          <p className="text-[11px] text-muted-foreground">{target.kind === "enum" ? "Suggest instead" : target.kind === "number" || target.kind === "bool" ? "Suggest a value" : "Suggested value"}</p>
          {choices}
        </div>
      )}
      {quick.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {quick.map((pick) => (
            <button key={pick} type="button" className={OPTION} onClick={() => setBody((text) => (text.trim() === "" ? (STARTERS[pick] ?? `${pick}. `) : `${text.trimEnd()} ${STARTERS[pick] ?? `${pick}.`}`))}>
              {pick}
            </button>
          ))}
        </div>
      )}
      <textarea ref={field} aria-label="Comment" rows={3} maxLength={4000} className={FIELD} placeholder={suggest === undefined ? "What should the planner change here, and why?" : "Why? (optional)"} value={body} onChange={(event) => setBody(event.target.value)} />
      <div className="flex items-center gap-2">
        <span className="mr-auto text-[11px] text-subtle-foreground">⌘↵ adds · Esc closes</span>
        {onDelete !== undefined && (
          <button type="button" className={`${BUTTON} text-destructive-text`} onClick={onDelete}>
            Delete
          </button>
        )}
        <button type="button" className={BUTTON} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={BUTTON_PRIMARY} disabled={body.trim() === "" && suggest === undefined} onClick={save}>
          {existing === null ? "Add comment" : "Save"}
        </button>
      </div>
    </div>
  );
}

function Suggestion({ suggest }: { suggest: NonNullable<DraftNote["suggest"]> }) {
  return (
    <span data-suggestion className="mt-1 inline-flex flex-wrap items-center gap-1.5 rounded bg-surface-recessed px-1.5 font-mono text-[11px]">
      <s className="text-destructive-text">{suggest.from}</s>
      <span aria-hidden>→</span>
      <b className="font-semibold text-success">{suggest.to}</b>
    </span>
  );
}

function sentState(note: SentNote): { text: string; tone: string } {
  if (note.answeredIn === null) return { text: "Waiting for the planner's next version", tone: "text-muted-foreground" };
  if (note.changed) return { text: `✓ v${note.answeredIn} changed this`, tone: "text-success" };
  return { text: `v${note.answeredIn} left this as it was; the planner may have answered in its chat`, tone: "text-warning-text" };
}

/**
 * The human's review of the version on screen: the unsent comments by section with their numbers, a note on the whole
 * spec, one Send for all of them (or Approve when there are none), and the comments sent before with what came of them.
 */
export function ReviewPanel({
  view,
  notes,
  labelFor,
  onEdit,
  onRemove,
  onJump,
  onGeneral,
  onSent,
  approve,
}: {
  view: SpecVersionView;
  notes: readonly DraftNote[];
  labelFor(path: string): string;
  onEdit(index: number, anchor: HTMLElement): void;
  onRemove(index: number): void;
  onJump(note: DraftNote): void;
  onGeneral(text: string): void;
  onSent(view: SpecVersionView): void;
  /** The Approve this panel offers when there is nothing to send; null when the page shows it elsewhere or it cannot be approved now. */
  approve: { label: string; busy: boolean; onApprove(): void } | null;
}) {
  const sendNotes = useLoomWrite("sendNotes");
  const { busy, error, run } = useRun();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(false);
  const newest = view.versions.at(-1)!;
  const general = notes.find((note) => note.paths[0] === WHOLE_SPEC);
  const [generalText, setGeneralText] = useState(general?.body ?? "");
  const older = notes.some((note) => note.version < newest.version);
  const count = notes.length;
  const send = () =>
    void run(async () => {
      onSent(await sendNotes({ slug: view.slug, notes: notes.map(sentForm), ...(older ? { includeOlder: true as const } : {}), confirm: true }));
      setGeneralText("");
    });
  const sendLabel = `Send ${plural(count, "comment")} · ask for v${newest.version + 1}`;
  const waiting = view.notes.filter((note) => note.answeredIn === null).length;

  return (
    <aside data-review-panel aria-label="Your review" className="min-w-0 rounded-lg border border-border-seam bg-card shadow-sm">
      <button type="button" aria-expanded={open} className="flex w-full cursor-pointer items-center gap-2 px-3 pt-3 pb-2 text-left @5xl:cursor-default" onClick={() => setOpen(!open)}>
        <h3 className="text-sm font-semibold">Your review of v{view.version}</h3>
        {count > 0 && <span className="text-xs font-semibold text-warning-text">{plural(count, "comment")}</span>}
        <span aria-hidden className="ml-auto text-xs text-muted-foreground @5xl:hidden">
          {open ? "Hide ▾" : "Show ▴"}
        </span>
      </button>
      <div className={`space-y-2 px-3 pb-3 ${open ? "" : "hidden"} @5xl:block`}>
        {notes.filter((note) => note.paths[0] !== WHOLE_SPEC).length === 0 ? (
          <p className="rounded-md border border-dashed border-border-seam px-3 py-2 text-xs text-muted-foreground">
            <b className="text-foreground">Nothing yet.</b> Click any setting, ticket, criterion, file or line to comment on it. Comments collect here and go to the planner together, in one message.
          </p>
        ) : (
          SECTIONS.map(({ section, label }) => {
            const mine = notes.map((note, index) => ({ note, index })).filter(({ note }) => note.paths[0] !== WHOLE_SPEC && (note.section ?? sectionOf(note.paths[0]!)) === section);
            if (mine.length === 0) return null;
            return (
              <div key={section} className="space-y-1">
                <h4 className={HEADING}>
                  {label} · {mine.length}
                </h4>
                {mine.map(({ note, index }) => (
                  <div key={index} data-draft-comment={note.paths[0]} className="rounded-md border border-border-seam bg-surface-recessed/40 p-2">
                    <div className="flex items-center gap-1.5">
                      <Pin n={index + 1} />
                      <button type="button" className="min-w-0 flex-1 cursor-pointer truncate text-left text-xs font-semibold hover:underline" title={`Show ${note.label}`} onClick={() => onJump(note)}>
                        {note.label || labelFor(note.paths[0]!)}
                      </button>
                      <button type="button" aria-label={`Edit the comment on ${note.label}`} className="cursor-pointer rounded px-1 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground" onClick={(event) => onEdit(index, event.currentTarget)}>
                        ✎
                      </button>
                      <button type="button" aria-label={`Remove the comment on ${note.label}`} className="cursor-pointer rounded px-1 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground" onClick={() => onRemove(index)}>
                        ✕
                      </button>
                    </div>
                    {note.suggest !== undefined && <Suggestion suggest={note.suggest} />}
                    {note.body !== "" && <p className="mt-1 text-xs whitespace-pre-wrap">{note.body}</p>}
                    {note.version < newest.version && <p className="mt-1 text-[11px] text-warning-text">Written on v{note.version}; v{newest.version} is newer</p>}
                  </div>
                ))}
              </div>
            );
          })
        )}
        <label className="block space-y-1">
          <span className={HEADING}>Anything else for the planner?</span>
          <textarea
            aria-label="A note on the whole spec"
            rows={2}
            maxLength={4000}
            className={FIELD}
            placeholder="A note on the spec as a whole (optional)"
            value={generalText}
            onChange={(event) => {
              setGeneralText(event.target.value);
              onGeneral(event.target.value);
            }}
          />
        </label>
        {error !== null && (
          <p role="alert" className="text-xs text-destructive-text">
            {error}
          </p>
        )}
        {count > 0 ? (
          <div className="grid gap-1.5">
            {older ? <ConfirmButton label={sendLabel} primary disabled={busy} onConfirm={send} /> : <button type="button" className="inline-flex h-9 cursor-pointer items-center justify-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-default disabled:opacity-50" disabled={busy} onClick={send}>{sendLabel}</button>}
            <button type="button" className={`${BUTTON} justify-center`} aria-expanded={preview} onClick={() => setPreview(!preview)}>
              {preview ? "Hide the message" : "Preview the message"}
            </button>
          </div>
        ) : approve !== null ? (
          <div className="grid gap-1">
            <ConfirmButton label={approve.label} primary disabled={approve.busy} onConfirm={approve.onApprove} />
            <p className="text-center text-[11px] text-subtle-foreground">Nothing runs until you start the project.</p>
          </div>
        ) : null}
        {preview && count > 0 && (
          <pre data-notes-preview className="max-h-72 overflow-auto rounded-md bg-surface-recessed p-2 text-[11px] leading-relaxed whitespace-pre-wrap">
            {notesMessage({ slug: view.slug, version: newest.version, status: newest.status, notes: notes.map(sentForm) })}
          </pre>
        )}
        <p className="text-[11px] text-subtle-foreground">Kept in this browser until you send them. The planner revises the spec and proposes the next version, and this page then shows what changed.</p>
        {view.notes.length > 0 && (
          <details data-sent-comments open={waiting > 0} className="pt-1">
            <summary className={`${HEADING} cursor-pointer`}>
              Sent · {view.notes.length}
              {waiting > 0 && ` · ${waiting} waiting`}
            </summary>
            <div className="mt-1 space-y-1">
              {view.notes.map((note, index) => {
                const state = sentState(note);
                return (
                  <div key={index} data-sent-note className="rounded-md border border-border-seam p-2">
                    <p className="truncate text-[11px] text-muted-foreground" title={note.paths.join(", ")}>
                      {note.paths[0] === WHOLE_SPEC ? "The whole spec" : labelFor(note.paths[0]!)} · written on v{note.version}
                    </p>
                    {note.suggest !== undefined && <Suggestion suggest={note.suggest} />}
                    {note.body !== "" && <p className="mt-0.5 text-xs whitespace-pre-wrap">{note.body}</p>}
                    <p className={`mt-0.5 text-[11px] ${state.tone}`}>{state.text}</p>
                  </div>
                );
              })}
            </div>
          </details>
        )}
      </div>
    </aside>
  );
}
