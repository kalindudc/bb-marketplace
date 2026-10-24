import type { DiffView } from "./file-card";
import type { Chip, GroupBy } from "./model";
import { createRemembered } from "./remember";
import { createShared } from "./session";

// Remembered on this device; the page and the thread tab share them.
const win = window;
const parseBoolean = (raw: string): boolean | null => (raw === "true" ? true : raw === "false" ? false : null);
const asBoolean = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

export const diffView = createShared<DiffView>("unified", { win, key: "bb-plugin-vantage:diff-view", parse: (raw) => (raw === "split" ? "split" : raw === "unified" ? "unified" : null) });
export const diffWrap = createShared<boolean>(false, { win, key: "bb-plugin-vantage:diff-wrap", parse: parseBoolean });
export const hideReviewed = createShared<boolean>(false, { win, key: "bb-plugin-vantage:hide-reviewed", parse: parseBoolean });
export const groupBy = createShared<GroupBy>("status", { win, key: "bb-plugin-vantage:group-by", parse: (raw) => (raw === "project" ? "project" : raw === "status" ? "status" : null) });
export const fileTree = createShared<boolean>(true, { win, key: "bb-plugin-vantage:file-tree", parse: parseBoolean });
// Collapse all and Expand all set this, so the next worktree opens the way the last one was left.
export const foldAll = createShared<boolean>(false, { win, key: "bb-plugin-vantage:fold-all", parse: parseBoolean });

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
  const handSet = [...fileFolds.snapshot().keys()].filter((key) => key.startsWith("review\0") || key.startsWith("changes\0"));
  foldAll.set(folded);
  fileFolds.setMany([...handSet.map((key) => [key, undefined] as const), ...open.map((key) => [key, false] as const)]);
}

// The page's list filters, shared by its sidebar and its body but not remembered.
export const pageText = createShared<string>("");
export const pageChip = createShared<Chip | null>(null);

// Tests clear localStorage between cases; this reads every remembered value from it again.
export function reloadUiState(): void {
  for (const shared of [diffView, diffWrap, hideReviewed, groupBy, fileTree, foldAll]) shared.reload();
  for (const store of [fileFolds, treeFolds, groupFolds, reviewScopes, otherChangesShown]) store.reload();
}
