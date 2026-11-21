import type { DiffView } from "./file-card";
import type { Chip, GroupBy } from "./model";
import { createRemembered } from "./remember";
import { readingSchema, subjectSchema, threadIdPattern } from "./reading-state";
import { parseRoute } from "./route";
import { z } from "zod";
import { createShared } from "./session";

// Remembered on this device; the page and the thread tab share them.
const win = window;
const parseBoolean = (raw: string): boolean | null => (raw === "true" ? true : raw === "false" ? false : null);
const asBoolean = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

export const diffView = createShared<DiffView>("unified", {
  win,
  key: "bb-plugin-vantage:diff-view",
  parse: (raw) => (raw === "split" ? "split" : raw === "unified" ? "unified" : null),
});
export const diffWrap = createShared<boolean>(false, { win, key: "bb-plugin-vantage:diff-wrap", parse: parseBoolean });
export const hideReviewed = createShared<boolean>(false, {
  win,
  key: "bb-plugin-vantage:hide-reviewed",
  parse: parseBoolean,
});
export const groupBy = createShared<GroupBy>("status", {
  win,
  key: "bb-plugin-vantage:group-by",
  parse: (raw) => (raw === "project" ? "project" : raw === "status" ? "status" : null),
});
export const fileTree = createShared<boolean>(true, { win, key: "bb-plugin-vantage:file-tree", parse: parseBoolean });
// Collapse all and Expand all set this, so the next worktree opens the way the last one was left.
export const foldAll = createShared<boolean>(false, { win, key: "bb-plugin-vantage:fold-all", parse: parseBoolean });
// The side panel's navigator width in CSS px once the person resizes it; null keeps the default clamp.
export const navigatorWidth = createShared<number | null>(null, {
  win,
  key: "bb-plugin-vantage:navigator-width",
  parse: (raw) => {
    const width = Number(raw);
    return raw !== "" && Number.isInteger(width) && width > 0 && width <= 4_000 ? width : null;
  },
});

function readingPreference<T>(key: string, parse: (value: unknown) => T | null, max = 100, saveIntervalMs = 0) {
  return createRemembered(win, `bb-plugin-vantage:reading-v1:${key}`, parse, max, saveIntervalMs);
}
const validator =
  <T>(schema: z.ZodType<T>) =>
  (value: unknown): T | null => {
    const result = schema.safeParse(value);
    return result.success ? result.data : null;
  };
export const readerTrees = readingPreference("tree", asBoolean);
export const readerFocus = readingPreference("focus", asBoolean);
const READING_SAVE_INTERVAL_MS = 500;
export const readerFiles = readingPreference("file", validator(readingSchema), 100, READING_SAVE_INTERVAL_MS);
export const panelResume = readingPreference(
  "panel",
  validator(
    z
      .object({
        view: z.enum(["worktrees", "changes"]),
        subject: subjectSchema.nullable(),
        tab: z.enum(["changes", "chat"]),
        // Archived threads read in this tab, newest first: they keep their place in the Trail.
        recent: z.array(z.string().regex(threadIdPattern)).max(12).optional(),
      })
      .strict(),
  ),
);
export const pageResume = readingPreference("page-route", (value) =>
  typeof value === "string" && value.length <= 61_000 && parseRoute(value).canonical === value ? value : null,
);
export const arrivedHandoffs = readingPreference("arrived", asBoolean, 24);
export const trailFolds = readingPreference("trail-folds", asBoolean, 200);

// A file card folded or opened by hand, against what foldAll and reviews would choose; keyed by view, then the card.
export const fileFolds = createRemembered<boolean>(win, "bb-plugin-vantage:file-folds", asBoolean, 1000);
// Folders collapsed in a worktree's file tree, keyed by worktree, then folder.
export const treeFolds = createRemembered<boolean>(win, "bb-plugin-vantage:tree-folds", asBoolean, 1000);
// Worktree list groups folded or opened against their default; only Archived starts folded.
export const groupFolds = createRemembered<boolean>(win, "bb-plugin-vantage:group-folds", asBoolean, 100);
// A worktree's change scope when it is not All changes.
export const reviewScopes = createRemembered<string>(win, "bb-plugin-vantage:review-scopes", asString, 200);
// Repositories whose changes not made by their agents are shown in All changes.
export const otherChangesShown = createRemembered<boolean>(win, "bb-plugin-vantage:other-changes", asBoolean, 200);

// Collapse all and Expand all set the default for every review and All changes view, so they also drop every file folded
// or opened by hand there: otherwise a file opened under Expand all would stay open after a later Collapse all elsewhere.
// `open` are files to open beyond the new default, such as the reviewed files Expand all opens in the view it ran in.
export function setFoldAll(folded: boolean, open: readonly string[] = []): void {
  const handSet = [...fileFolds.snapshot().keys()].filter(
    (key) => key.startsWith("review\0") || key.startsWith("changes\0"),
  );
  foldAll.set(folded);
  fileFolds.setMany([...handSet.map((key) => [key, undefined] as const), ...open.map((key) => [key, false] as const)]);
}

// The page's list filters, shared by its sidebar and its body but not remembered.
export const pageText = createShared<string>("");
export const pageChip = createShared<Chip | null>(null);

// Tests clear localStorage between cases; this reads every remembered value from it again.
export function reloadUiState(): void {
  for (const shared of [diffView, diffWrap, hideReviewed, groupBy, fileTree, foldAll, navigatorWidth]) shared.reload();
  for (const store of [
    fileFolds,
    treeFolds,
    groupFolds,
    reviewScopes,
    otherChangesShown,
    readerTrees,
    readerFocus,
    readerFiles,
    panelResume,
    pageResume,
    arrivedHandoffs,
    trailFolds,
  ])
    store.reload();
}
