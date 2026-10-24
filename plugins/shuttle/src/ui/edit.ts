import { useCallback, useRef } from "react";
import { toast } from "sonner";
import type { Label, PrView, ReviewerRef } from "../contract";
import { patchPr, undoToast, useShuttleMutation, type Input } from "./data";
import { shortKey } from "./format";

export type Change = Input<"editPr">["change"];

const sameReviewer = (a: ReviewerRef, b: ReviewerRef) => a.login === b.login && a.team === b.team;

/** The PR as it will be once the server has made the change; null lists stay null until the server reads them. */
export function applyChange(pr: PrView, change: Change, colors: ReadonlyMap<string, string | null>): PrView {
  switch (change.kind) {
    case "ready":
    case "reopen":
      return { ...pr, state: "open" };
    case "draft":
      return { ...pr, state: "draft" };
    case "close":
      return { ...pr, state: "closed" };
    case "labels": {
      if (pr.labels === null) return pr;
      const remove = new Set(change.remove ?? []);
      const kept = pr.labels.filter((label) => !remove.has(label.name));
      const added = (change.add ?? []).filter((name) => !kept.some((label) => label.name === name)).map((name) => ({ name, color: colors.get(name) ?? null }));
      return { ...pr, labels: [...kept, ...added] };
    }
    case "reviewers": {
      if (pr.reviewers === null) return pr;
      const remove = change.remove ?? [];
      const add = change.add ?? [];
      const kept = pr.reviewers
        .filter((reviewer) => !remove.some((ref) => sameReviewer(ref, reviewer)))
        .map((reviewer) => (add.some((ref) => sameReviewer(ref, reviewer)) ? { ...reviewer, state: "requested" as const } : reviewer));
      const added = add.filter((ref) => !kept.some((reviewer) => sameReviewer(ref, reviewer))).map((ref) => ({ ...ref, state: "requested" as const }));
      return { ...pr, reviewers: [...kept, ...added] };
    }
  }
}

const who = (ref: ReviewerRef) => ref.login;

function describeChange(pr: PrView, change: Change): string {
  const name = shortKey(pr);
  switch (change.kind) {
    case "ready": return `${name} is ready for review`;
    case "draft": return `${name} is a draft again`;
    case "close": return `Closed ${name}`;
    case "reopen": return `Reopened ${name}`;
    case "labels": {
      const [added] = change.add ?? [];
      const [removed] = change.remove ?? [];
      return added !== undefined ? `Added label “${added}”` : `Removed label “${removed}”`;
    }
    case "reviewers": {
      const [added] = change.add ?? [];
      const [removed] = change.remove ?? [];
      if (added === undefined) return `Withdrew the request to ${who(removed!)}`;
      const already = pr.reviewers?.find((reviewer) => sameReviewer(reviewer, added)) ?? null;
      return already !== null && already.state !== "requested" ? `Asked ${who(added)} to review again` : `Asked ${who(added)} to review`;
    }
  }
}

/** The change that undoes `change`; a request to review again has none, since the earlier review stays on the server. */
function inverseOf(pr: PrView, change: Change): Change | null {
  switch (change.kind) {
    case "ready": return { kind: "draft" };
    case "draft": return { kind: "ready" };
    case "close": return { kind: "reopen" };
    case "reopen": return { kind: "close" };
    case "labels": return { kind: "labels", add: change.remove ?? [], remove: change.add ?? [] };
    case "reviewers": {
      const askAgain = (change.add ?? []).some((ref) => pr.reviewers?.some((reviewer) => sameReviewer(reviewer, ref) && reviewer.state !== "requested"));
      return askAgain ? null : { kind: "reviewers", add: change.remove ?? [], remove: change.add ?? [] };
    }
  }
}

/**
 * Changes the user's PRs at once: the Inbox, every loaded list, the detail and the linked threads' lists
 * show the change before the server answers, a toast offers Undo once it has, and a refusal puts it back.
 */
export function useEditPrs(threadIds: readonly string[]) {
  // Colours learned from PRs and the label picker, kept so an undone removal comes back in its colour.
  const colors = useRef(new Map<string, string | null>());

  const mutation = useShuttleMutation("editPr", ({ key, change }, cache) => {
    const known = new Map(colors.current);
    patchPr(cache, key, (item) => applyChange(item, change, known), threadIds);
  });

  const send = async (pr: PrView, change: Change, message: string, undo: { change: Change; message: string } | null) => {
    const result = await mutation.run({ key: pr.key, change });
    if (result === null) return;
    // Some servers can't go back, such as Delta from ready to draft; the PR the server returned says which.
    if (undo === null || !result.pr.actions.includes(undo.change.kind)) toast.success(message);
    else undoToast(message, () => void send(result.pr, undo.change, undo.message, null));
  };

  const apply = (pr: PrView, change: Change) => {
    for (const label of pr.labels ?? []) colors.current.set(label.name, label.color);
    const inverse = inverseOf(pr, change);
    void send(pr, change, describeChange(pr, change), inverse === null ? null : { change: inverse, message: describeChange(applyChange(pr, change, colors.current), inverse) });
  };
  const rememberColors = useCallback((labels: readonly Label[]) => {
    for (const label of labels) colors.current.set(label.name, label.color);
  }, []);
  return { apply, rememberColors };
}

/** The edits of one PR, for its Manage card. */
export function useEditPr(pr: PrView) {
  const edits = useEditPrs(pr.links.map((link) => link.threadId));
  return { apply: (change: Change) => edits.apply(pr, change), rememberColors: edits.rememberColors };
}

export type EditPr = ReturnType<typeof useEditPr>;
