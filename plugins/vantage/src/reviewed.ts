import { useCallback } from "react";
import { experimental_useRpcKeyedQuery, experimental_useRpcMutation } from "@get-bb/plugin-sdk/app";
import { rpcContract, type FileChange, type ReviewMarks, type Worktree } from "./contract";

// Which change of a file a mark is for: the uncommitted one, the one committed on the branch, or one commit's.
export type Part = "uncommitted" | "committed" | `commit:${string}`;

export interface FilePart { part: Part; file: FileChange }

const EMPTY: Record<string, ReviewMarks> = {};

export const markId = (part: Part, path: string): string => `${part}\0${path}`;

// Counts stand in for the content: an edit that changes no line count after the tick is not noticed.
export const signature = (file: FileChange): string =>
  [file.status, file.additions ?? "", file.deletions ?? "", file.previousPath ?? ""].join(":");

export function worktreeParts(worktree: Pick<Worktree, "uncommitted" | "committed">): FilePart[] {
  return [
    ...worktree.uncommitted.map((file) => ({ part: "uncommitted" as const, file })),
    ...worktree.committed.map((file) => ({ part: "committed" as const, file })),
  ];
}

export const isReviewed = (marks: ReviewMarks | undefined, { part, file }: FilePart): boolean =>
  marks?.[markId(part, file.path)] === signature(file);

// Ticked once, but the file changed since.
export const isStale = (marks: ReviewMarks | undefined, { part, file }: FilePart): boolean => {
  const stored = marks?.[markId(part, file.path)];
  return stored !== undefined && stored !== signature(file);
};

export function progress(marks: ReviewMarks | undefined, parts: readonly FilePart[]): { reviewed: number; total: number } {
  return { reviewed: parts.filter((part) => isReviewed(marks, part)).length, total: parts.length };
}

export function useReviewMarks(keys: readonly string[]): Record<string, ReviewMarks> {
  const { data } = experimental_useRpcKeyedQuery({ contract: rpcContract, method: "reviewed", keys });
  return keys.length === 0 ? EMPTY : (data ?? EMPTY);
}

export type SetReviewed = (key: string, parts: readonly FilePart[], reviewed: boolean) => Promise<void>;

export function useSetReviewed(): SetReviewed {
  const { mutate } = experimental_useRpcMutation({
    contract: rpcContract,
    method: "setReviewed",
    optimistic(input, cache) {
      cache.updateKey("reviewed", input.key, (current) => {
        const next = { ...current };
        for (const { mark, signature: value } of input.marks) {
          delete next[mark];
          if (value !== null) next[mark] = value;
        }
        return next;
      });
    },
  });
  return useCallback(async (key, parts, reviewed) => {
    if (parts.length === 0) return;
    await mutate({ key, marks: parts.map((part) => ({ mark: markId(part.part, part.file.path), signature: reviewed ? signature(part.file) : null })) });
  }, [mutate]);
}
