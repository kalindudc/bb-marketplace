import { useState } from "react";
import { toast } from "sonner";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { MERGE_METHODS, type MergeMethod, type PrView } from "../contract";
import { BUTTON_GHOST, BUTTON_SUCCESS, Choice, Dialog, ErrorNote, FIELD, LABEL } from "./common";
import { messageOf, useShuttleMutation, useShuttleQuery } from "./data";
import { plural, tinyKey } from "./format";

const METHODS: Record<MergeMethod, { title: string; hint: string }> = {
  squash: { title: "Squash and merge", hint: "One commit on the base branch" },
  merge: { title: "Create a merge commit", hint: "Keeps every commit" },
  rebase: { title: "Rebase and merge", hint: "Replays each commit on the base branch" },
};

const STATE_TEXT: Record<string, string> = {
  blocked: "Required reviews or checks are missing.",
  behind: "The base branch moved on: update the branch first.",
  conflicts: "It has conflicts with the base branch.",
  pending: "Checks are still running.",
  unknown: "",
  clean: "",
};

function Line({ tone, icon, children }: { tone: string; icon: string; children: string }) {
  return (
    <li className={`flex items-center gap-2 py-0.5 text-sm ${tone}`}>
      <Icon name={icon} className="size-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </li>
  );
}

/** Merge one of your PRs from Shuttle, only while its head is the one you saw; or turn on auto-merge. */
export function MergeDialog({ pr, onClose }: { pr: PrView; onClose(): void }) {
  const options = useShuttleQuery("mergeOptions", { key: pr.key });
  const merge = useShuttleMutation("merge");
  const [chosen, setChosen] = useState<MergeMethod | null>(null);
  const [subject, setSubject] = useState(`${pr.title} (${pr.sep}${pr.number})`);
  const [deleteChoice, setDeleteChoice] = useState<boolean | null>(null);
  const loaded = options.data;
  const method = chosen ?? loaded?.default ?? null;
  const deleteBranch = deleteChoice ?? loaded?.deleteBranch ?? false;
  // Merge now only when the server says it can, or cannot tell (a command server without merge_options):
  // the head guard and the server still refuse a merge that is not allowed.
  const now = loaded !== undefined && (loaded.state === "clean" || loaded.state === "unknown");
  const auto = loaded !== undefined && !now && loaded.state !== "conflicts" && loaded.canAuto;
  const stuck = loaded !== undefined && !now && !auto;
  const head = pr.head;

  const counts = pr.checkCounts;
  const approvers = (pr.reviewers ?? []).filter((reviewer) => reviewer.state === "approved").map((reviewer) => reviewer.login);
  const waiting = (pr.reviewers ?? []).filter((reviewer) => reviewer.state === "requested" && !reviewer.team).length;

  const submit = async () => {
    if (method === null || head === null) return;
    const out = await merge.run({ key: pr.key, method, head, auto, deleteBranch, ...(method === "squash" && subject.trim() !== "" ? { subject: subject.trim() } : {}) });
    if (out === null) return;
    toast.success(out.merged
      ? `Merged ${tinyKey(pr)} on ${pr.serverName} (${method})${deleteBranch ? ", and deleted its branch" : ""}.`
      : `Auto-merge is on for ${tinyKey(pr)}: it merges once ${pr.serverName} lets it.`);
    onClose();
  };

  return (
    <Dialog title={`Merge ${tinyKey(pr)}`} leading={<Icon name="GitMerge" className="size-4" aria-hidden />} onClose={onClose}
      footer={(
        <>
          <span className="flex-1" />
          <button type="button" className={BUTTON_GHOST} onClick={onClose}>Cancel</button>
          <button type="button" className={BUTTON_SUCCESS} disabled={loaded === undefined || stuck || method === null || head === null || merge.isPending} onClick={() => void submit()}>
            <Icon name="GitMerge" className="size-3.5" aria-hidden />{auto ? "Turn on auto-merge" : "Merge"}
          </button>
        </>
      )}>
      <ul aria-label="Before it merges" className="mb-1">
        {pr.checks === "passed" && <Line tone="text-success" icon="Check">{counts !== null ? `All ${counts.total} checks pass` : "All checks pass"}</Line>}
        {pr.checks === "pending" && <Line tone="text-warning-text" icon="Clock">{counts !== null ? `${counts.pending} of ${counts.total} checks still running` : "Checks are still running"}</Line>}
        {pr.checks === "failed" && <Line tone="text-destructive-text" icon="X">{counts !== null ? `${plural(counts.failed, "check")} fail` : "Checks fail"}</Line>}
        {pr.checks === "none" && <Line tone="text-muted-foreground" icon="Info">No checks</Line>}
        {approvers.length > 0
          ? <Line tone="text-success" icon="Check">{`Approved by ${approvers.join(", ")}`}</Line>
          : <Line tone="text-warning-text" icon="Clock">Nobody has approved yet</Line>}
        {waiting > 0 && <Line tone="text-muted-foreground" icon="Info">{`${plural(waiting, "requested reviewer")} ${waiting === 1 ? "has" : "have"} not reviewed.`}</Line>}
      </ul>
      {options.error !== null && <ErrorNote>Could not read how {tinyKey(pr)} can merge: {messageOf(options.error)}</ErrorNote>}
      {loaded === undefined && options.error === null && <div className="py-2 text-sm text-muted-foreground">Asking {pr.serverName} how it can merge…</div>}
      {loaded !== undefined && (
        <>
          {loaded.state !== "clean" && (loaded.detail !== null || loaded.state !== "unknown") && (
            <div role={stuck ? "alert" : undefined} className={`mt-2 rounded-md border px-3 py-2 text-xs ${stuck ? "border-destructive/40 bg-destructive/10 text-destructive-text" : "border-warning/40 bg-warning/5 text-warning-text"}`}>
              {loaded.detail ?? STATE_TEXT[loaded.state]}
            </div>
          )}
          {loaded.state === "unknown" && loaded.detail === null && (
            <div className="mt-2 text-xs text-muted-foreground">{pr.serverName} doesn't say whether it can merge; it refuses if it can't.</div>
          )}
          <div className={LABEL}>How</div>
          <div role="radiogroup" aria-label="How">
            {MERGE_METHODS.map((item) => {
              const allowed = loaded.methods.includes(item);
              return (
                <Choice key={item} on={method === item} disabled={!allowed} onPick={() => setChosen(item)}
                  title={<>{METHODS[item].title}{item === loaded.default && <span className="ml-1.5 text-xs font-normal text-muted-foreground">repo default</span>}</>}
                  hint={allowed ? METHODS[item].hint : "Not allowed in this repository"} />
              );
            })}
          </div>
          {method === "squash" && (
            <>
              <div className={LABEL}>Commit title</div>
              <input aria-label="Commit title" className={`${FIELD} w-full`} value={subject} onChange={(event) => setSubject(event.target.value)} />
            </>
          )}
          {auto && (
            <>
              <div className={LABEL}>When</div>
              <Choice on title="When it can merge" hint={`Turns on auto-merge: it merges once its required checks and reviews pass. You can cancel it until then.`} onPick={() => {}} />
            </>
          )}
          <label className="mt-2.5 flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" checked={deleteBranch} onChange={(event) => setDeleteChoice(event.target.checked)} className="size-4 cursor-pointer accent-foreground" />
            Delete the branch after merging
          </label>
          {head !== null
            ? <div className="mt-2 text-xs text-muted-foreground">Merges only if nobody pushed since you looked (head <span className="font-mono">{head.slice(0, 7)}</span>).</div>
            : <div className="mt-2 text-xs text-destructive-text">Shuttle does not know this PR's head yet. Sync, then try again.</div>}
        </>
      )}
    </Dialog>
  );
}
