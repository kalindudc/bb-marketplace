// One spec version as the Spec page reads it: the parsed spec, what it changed, the notes the human sent on it and Loom's reviews.
import type { Store } from "./db/store";
import { LoomError, type Projects, type SpecView } from "./projects";
import { scopeOverlaps, validateSemantics, type Spec } from "./spec";
import { changedAt, specChanges, type SpecChanges, type SpecNote } from "./spec-paths";
import type { SpecFinding } from "./spec-review";

export interface SentNote extends SpecNote {
  sentAt: number;
  /** The newest version, when it is newer than the one the note was written on. */
  answeredIn: number | null;
  /** Whether `answeredIn` changed a part the note is about. */
  changed: boolean;
}

export interface SpecVersionView {
  slug: string;
  version: number;
  status: SpecView["status"];
  toml: string;
  spec: Spec;
  overlaps: Array<{ a: string; b: string; paths: string[] }>;
  warnings: string[];
  /** What this version changed from the one before; null for version 1. */
  changes: SpecChanges | null;
  /**
   * The version the page compares this one with, by default the version in force for a pending one and the one before
   * for any other; null for version 1. The page diffs the two specs itself.
   */
  compared: { version: number; status: SpecView["status"]; spec: Spec } | null;
  versions: Array<{ version: number; status: SpecView["status"] }>;
  /** Newest batch first, in the order sent within a batch. */
  notes: SentNote[];
  /** Loom's spec reviews of this version and the ones before it, oldest first, leaving out the ones a newer version or an approval replaced. */
  reviews: SpecReviewRound[];
}

/** One round of Loom's spec review of a version. */
export interface SpecReviewRound {
  version: number;
  round: number;
  state: "reviewing" | "approved" | "changes_requested" | "failed";
  summary: string | null;
  findings: SpecFinding[];
  reason: string | null;
  startedAt: number;
  endedAt: number | null;
}

export function specVersionView(deps: { store: Store; projects: Projects }, slug: string, version?: number, base?: number): SpecVersionView {
  const { store, projects } = deps;
  const project = projects.require(slug);
  const newest = store.latestSpecVersion(project.id)!.version;
  const view = projects.spec(slug, version ?? newest);
  if (base !== undefined && base >= view.version) throw new LoomError("loom_invalid_input", `Compare v${view.version} with an older version, v1 to v${view.version - 1}.`);
  const inForce = project.approved_version;
  const comparedWith = base ?? (view.status === "pending" && inForce !== null && inForce < view.version ? inForce : view.version > 1 ? view.version - 1 : null);
  const parsed = new Map<number, Spec>();
  const specAt = (n: number): Spec => {
    if (!parsed.has(n)) parsed.set(n, JSON.parse(store.specVersion(project.id, n)!.spec_json) as Spec);
    return parsed.get(n)!;
  };
  const spec = specAt(view.version);

  const batches = store
    .eventsOfKind(project.id, "human.action")
    .map((event) => ({ at: event.at, data: JSON.parse(event.data_json) as { action: string; notes?: SpecNote[] } }))
    .filter(({ data }) => data.action === "notes")
    .reverse();
  const notes = batches.flatMap(({ at, data }) =>
    data.notes!.map((note): SentNote => {
      const answeredIn = newest > note.version ? newest : null;
      return { ...note, sentAt: at, answeredIn, changed: answeredIn !== null && changedAt(specChanges(specAt(note.version), specAt(answeredIn)), note.paths) };
    }),
  );

  return {
    slug,
    version: view.version,
    status: view.status,
    toml: view.toml,
    spec,
    overlaps: scopeOverlaps(spec.ticket).map(({ i, j, paths }) => ({ a: spec.ticket[i]!.ref, b: spec.ticket[j]!.ref, paths })),
    warnings: validateSemantics(spec, view.toml).warnings,
    changes: view.version === 1 ? null : specChanges(specAt(view.version - 1), spec),
    compared: comparedWith === null ? null : { version: comparedWith, status: projects.specStatus(project, comparedWith), spec: specAt(comparedWith) },
    versions: Array.from({ length: newest }, (_, index) => ({ version: index + 1, status: projects.specStatus(project, index + 1) })),
    notes,
    reviews: store
      .specReviews(project.id)
      .filter((row) => row.state !== "superseded" && row.version <= view.version)
      .map((row) => ({
        version: row.version,
        round: row.round,
        state: row.state as SpecReviewRound["state"],
        summary: row.summary,
        findings: JSON.parse(row.findings_json) as SpecFinding[],
        reason: row.reason,
        startedAt: row.started_at,
        endedAt: row.ended_at,
      })),
  };
}
