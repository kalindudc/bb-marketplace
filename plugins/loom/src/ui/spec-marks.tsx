import { createContext, useContext, type ReactNode } from "react";
import { changedAt, isUnder, type SpecChanges } from "../spec-paths";

export interface NoteTarget {
  paths: string[];
  label: string;
}

/** What the dashboard marks on every part of the spec: the changes of the version on screen and the paths of the unsent notes. */
export interface Marks {
  version: number;
  changes: SpecChanges | null;
  notePaths: readonly string[];
  /** Absent on a rewound page, which takes no notes. */
  onNote?(target: NoteTarget): void;
}

export const MarksContext = createContext<Marks | null>(null);

/** "provider / model" with only the parts that are set. */
export const modelLabel = ({ provider, model }: { provider?: string; model?: string }) => [provider, model].filter((part) => part !== undefined).join(" / ") || "the default model";

export const notesUnder = (notePaths: readonly string[], path: string) => notePaths.filter((notePath) => notePath === path || isUnder(notePath, path)).length;

/** One part of the spec that takes a note. `paths` starts with the note's path, then every other spec path the part shows. */
export function Noteable({ paths, label, children }: { paths: string[]; label: string; children: ReactNode }) {
  const marks = useContext(MarksContext);
  const changed = marks?.changes != null && changedAt(marks.changes, paths);
  const noted = marks !== null && notesUnder(marks.notePaths, paths[0]!) > 0;
  return (
    <div
      data-note-target={paths[0]}
      data-changed={changed || undefined}
      data-noted={noted || undefined}
      className={`group relative rounded-md border-l-2 py-1 pr-16 pl-2 text-sm ${noted ? "border-warning-text" : changed ? "border-primary" : "border-transparent"} hover:bg-state-hover`}
    >
      {children}
      {changed && <span className="ml-2 text-[11px] text-primary">changed in v{marks!.version}</span>}
      {noted && <span className="ml-2 text-[11px] text-warning-text">has your note</span>}
      {marks?.onNote !== undefined && (
        <button
          type="button"
          aria-label={`Add a note on ${label}`}
          className="absolute top-1 right-1 cursor-pointer rounded px-1.5 text-[11px] text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => marks.onNote?.({ paths, label })}
        >
          + note
        </button>
      )}
    </div>
  );
}
