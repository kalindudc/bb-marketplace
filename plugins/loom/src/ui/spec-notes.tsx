import { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { SentNote, SpecVersionView, rpcContract } from "../contract";
import { notesMessage } from "../prompts";
import type { SpecNote } from "../spec-paths";
import { BUTTON, BUTTON_PRIMARY, CARD, ConfirmButton, FIELD, HEADING, plural, useRun } from "./common";
import type { NoteTarget } from "./spec-marks";

/** A note not sent yet. `version` is the version on screen when it was written. */
export interface DraftNote extends SpecNote {
  label: string;
}

const keyOf = (slug: string) => `loom.notes.${slug}`;

// Storage can be unavailable: then the tray keeps its notes in memory only.
function savedNotes(slug: string): DraftNote[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(keyOf(slug)) ?? "[]");
    return Array.isArray(saved) ? (saved as DraftNote[]) : [];
  } catch {
    return [];
  }
}

function saveNotes(slug: string, notes: readonly DraftNote[]): void {
  try {
    if (notes.length === 0) localStorage.removeItem(keyOf(slug));
    else localStorage.setItem(keyOf(slug), JSON.stringify(notes));
  } catch {}
}

/** The unsent notes of one project, kept in local storage until they are sent. */
export function useNoteTray(slug: string) {
  const [notes, setNotes] = useState(() => savedNotes(slug));
  const update = (next: DraftNote[]) => {
    setNotes(next);
    saveNotes(slug, next);
  };
  return {
    notes,
    add: (note: DraftNote) => update([...notes, note]),
    remove: (index: number) => update(notes.filter((_, at) => at !== index)),
    clear: () => update([]),
  };
}

export function NoteComposer({ target, onAdd, onCancel }: { target: NoteTarget; onAdd(body: string): void; onCancel(): void }) {
  const [body, setBody] = useState("");
  return (
    <section data-note-composer className={`${CARD} space-y-2`}>
      <p className="text-xs">
        Note on <span className="font-semibold">{target.label}</span>
      </p>
      <textarea aria-label="Note text" autoFocus rows={3} maxLength={4000} className={FIELD} placeholder="What should the planner change here?" value={body} onChange={(event) => setBody(event.target.value)} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={BUTTON_PRIMARY} disabled={body.trim() === ""} onClick={() => onAdd(body.trim())}>
          Add note
        </button>
        <button type="button" className={BUTTON} onClick={onCancel}>
          Cancel
        </button>
        <span className="text-[11px] text-muted-foreground">Notes collect below; send them together.</span>
      </div>
    </section>
  );
}

function sentState(note: SentNote): { text: string; tone: string } {
  if (note.answeredIn === null) return { text: "Waiting for the planner's next version", tone: "text-muted-foreground" };
  if (note.changed) return { text: `v${note.answeredIn} changes this`, tone: "text-primary" };
  return { text: `v${note.answeredIn} leaves this as it was; the planner may have answered in its chat`, tone: "text-muted-foreground" };
}

/** The unsent notes with Send and Preview, then the sent ones with what the planner's next version did about them. */
export function NoteTray({ view, notes, onRemove, onSent }: { view: SpecVersionView; notes: DraftNote[]; onRemove(index: number): void; onSent(view: SpecVersionView): void }) {
  const rpc = useRpc<typeof rpcContract>();
  const { busy, error, run } = useRun();
  const [preview, setPreview] = useState(false);
  const newest = view.versions.at(-1)!;
  const older = notes.some((note) => note.version < newest.version);
  const label = `Send ${plural(notes.length, "note")} to the planner`;
  const send = () =>
    void run(async () => {
      const sent = await rpc.call("sendNotes", { slug: view.slug, notes: notes.map(({ version, paths, body }) => ({ version, paths, body })), ...(older ? { includeOlder: true as const } : {}), confirm: true });
      onSent(sent);
    });

  return (
    <section data-notes-tray className={`${CARD} space-y-2`}>
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        Notes for the planner <span className="text-xs font-normal text-muted-foreground">{notes.length} to send</span>
      </h3>
      {notes.length === 0 && <p className="text-xs text-muted-foreground">Press "+ note" on a ticket card, or on any line of the selected ticket and the other tabs. Notes stay here until you send them together.</p>}
      {notes.map((note, index) => (
        <div key={index} data-draft-note className="space-y-0.5 rounded-md border border-border-seam p-2">
          <div className="flex items-start gap-2">
            <span className="text-xs font-medium text-warning-text">{note.label}</span>
            <button type="button" aria-label={`Remove the note on ${note.label}`} className="ml-auto cursor-pointer rounded px-1 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground" onClick={() => onRemove(index)}>
              ✕
            </button>
          </div>
          <p className="text-sm whitespace-pre-wrap">{note.body}</p>
          {note.version < newest.version && (
            <p className="text-[11px] text-warning-text">
              Written on v{note.version}; v{newest.version} is newer
            </p>
          )}
        </div>
      ))}
      {error !== null && (
        <p role="alert" className="text-xs text-destructive-text">
          {error}
        </p>
      )}
      {notes.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {older ? (
            <ConfirmButton label={label} disabled={busy} onConfirm={send} />
          ) : (
            <button type="button" className={BUTTON_PRIMARY} disabled={busy} onClick={send}>
              {label}
            </button>
          )}
          <button type="button" className={BUTTON} aria-expanded={preview} onClick={() => setPreview(!preview)}>
            Preview message
          </button>
        </div>
      )}
      {preview && notes.length > 0 && (
        <pre data-notes-preview className="overflow-x-auto rounded-md border border-border-seam p-2 text-xs leading-relaxed whitespace-pre-wrap">
          {notesMessage({ slug: view.slug, version: newest.version, status: newest.status, notes })}
        </pre>
      )}
      {view.notes.length > 0 && <h4 className={`${HEADING} pt-1`}>Sent</h4>}
      {view.notes.map((note, index) => {
        const state = sentState(note);
        return (
          <div key={index} data-sent-note className="space-y-0.5 rounded-md border border-border-seam p-2">
            <p className="font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
              {note.paths.join(", ")} · written on v{note.version}
            </p>
            <p className="text-sm whitespace-pre-wrap">{note.body}</p>
            <p className={`text-[11px] ${state.tone}`}>{state.text}</p>
          </div>
        );
      })}
    </section>
  );
}
