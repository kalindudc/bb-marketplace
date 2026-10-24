import type { DiffView } from "./file-card";
import type { Chip, GroupBy } from "./model";
import { createShared } from "./session";

// Remembered on this device; the page and the thread tab share them.
const win = window;
export const diffView = createShared<DiffView>("unified", { win, key: "bb-plugin-vantage:diff-view", parse: (raw) => (raw === "split" ? "split" : raw === "unified" ? "unified" : null) });
export const hideReviewed = createShared<boolean>(false, { win, key: "bb-plugin-vantage:hide-reviewed", parse: (raw) => (raw === "true" ? true : raw === "false" ? false : null) });
export const groupBy = createShared<GroupBy>("status", { win, key: "bb-plugin-vantage:group-by", parse: (raw) => (raw === "project" ? "project" : raw === "status" ? "status" : null) });
export const fileTree = createShared<boolean>(true, { win, key: "bb-plugin-vantage:file-tree", parse: (raw) => (raw === "true" ? true : raw === "false" ? false : null) });

// The page's list filters, shared by its sidebar and its body but not remembered.
export const pageText = createShared<string>("");
export const pageChip = createShared<Chip | null>(null);
