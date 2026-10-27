import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A bin directory whose git is like the one on a machine that keeps one index for the worktree and syncs only linear
 * history: a temporary index allows only read-tree --empty, diff-tree --no-renames and add --pathspec-from-file are
 * missing, and nothing may make a merge: no merge, pull, cherry-pick or rebase, and no commit-tree with two parents.
 */
export function restrictedGitBin(dir: string): string {
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = join(dir, "restricted-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh
for a in "$@"; do
  case "$a" in
    read-tree) if [ -n "$GIT_INDEX_FILE" ]; then case " $* " in *" --empty "*) ;; *) echo "wt git: read-tree with a temporary index is not implemented" >&2; exit 128;; esac; fi; break;;
    diff-tree) case " $* " in *" --no-renames "*) echo "wt git: 'diff-tree --no-renames' is not yet implemented" >&2; exit 128;; esac; break;;
    add) case " $* " in *" --pathspec-from-file"*) echo "wt git: unknown add option --pathspec-from-file=-" >&2; exit 129;; esac; break;;
    merge|pull|cherry-pick|rebase) echo "restricted git: $a would make history a machine cannot keep" >&2; exit 128;;
    commit-tree) case " $* " in *" -p "*" -p "*) echo "restricted git: a commit with two parents" >&2; exit 128;; esac; break;;
  esac
done
exec "${real}" "$@"
`,
    { mode: 0o755 },
  );
  return bin;
}

/** The commits after `from` on HEAD's history that have two or more parents; a machine must never have one. */
export const mergeCommitsSince = (repo: string, from: string): string[] =>
  execFileSync("git", ["-C", repo, "rev-list", "--min-parents=2", `${from}..HEAD`], { encoding: "utf8" }).split("\n").filter((line) => line !== "");
