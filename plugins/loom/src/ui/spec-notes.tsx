import { useState } from "react";
import type { SpecSection } from "../spec-diff";
import type { SpecNote } from "../spec-paths";

/** A note not sent yet. `version` is the version on screen when it was written. */
export interface DraftNote extends SpecNote {
  label: string;
  /** The Spec page's section the note's part is in; notes kept from before the Spec page had sections have none. */
  section?: SpecSection;
}

/** What the RPC takes of a draft note. */
export const sentForm = ({ version, paths, body, suggest }: DraftNote): SpecNote => ({ version, paths, body, ...(suggest === undefined ? {} : { suggest }) });

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
    replace: (index: number, note: DraftNote) => update(notes.map((one, at) => (at === index ? note : one))),
    remove: (index: number) => update(notes.filter((_, at) => at !== index)),
    clear: () => update([]),
  };
}
