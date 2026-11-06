// What holds a pull request with nothing before it back from Loom's Ready to merge verdict, as codes the engine and the
// page both test, and the words they show. No imports, so the page can take it without the engine.

/** What a pull request with nothing before it still waits on, by code; holdText says it in words. */
export type VerdictHold =
  | { code: "targets"; branch: string; base: string }
  | { code: "conflicts"; base: string }
  | { code: "pushing" }
  | { code: "draft" }
  | { code: "changes_requested" }
  | { code: "needs_review" }
  | { code: "checks_unread" }
  | { code: "failing"; count: number }
  | { code: "pending"; count: number };

const checks = (count: number) => `${count} ${count === 1 ? "check" : "checks"}`;

/** A hold in the words the Merge order tab and Loom's posts use: "draft", "needs review", "1 check pending". */
export function holdText(hold: VerdictHold): string {
  switch (hold.code) {
    case "targets":
      return `targets ${hold.branch}, not ${hold.base}`;
    case "conflicts":
      return `conflicts with ${hold.base}`;
    case "pushing":
      return "Loom is pushing a fix";
    case "draft":
      return "draft";
    case "changes_requested":
      return "changes requested";
    case "needs_review":
      return "needs review";
    case "checks_unread":
      return "checks not read";
    case "failing":
      return `${checks(hold.count)} failing`;
    case "pending":
      return `${checks(hold.count)} pending`;
  }
}
