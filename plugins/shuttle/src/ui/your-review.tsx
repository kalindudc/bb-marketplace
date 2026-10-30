import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { experimental_Icon as Icon, experimental_usePluginId, UrlLink } from "@get-bb/plugin-sdk/app";
import type { MyReview, PrView, ReviewDraft, Severity } from "../contract";
import { NextButtons, useActions } from "./actions";
import { BUTTON, BUTTON_GHOST, BUTTON_PRIMARY_LARGE, FIELD, Segmented } from "./common";
import { useShuttleMutation } from "./data";
import { ago, plural, settingsHref } from "./format";
import { isLive } from "./pills";
import { usePrState } from "./pr-state";

const SEVERITY_TEXT: Record<Severity, string> = { high: "text-destructive-text", medium: "text-warning-text", low: "text-foreground", nit: "text-muted-foreground" };
export const VERDICT_OPTIONS = [
  { value: "comment" as const, label: "Comment" },
  { value: "approve" as const, label: "Approve" },
  { value: "changes" as const, label: "Request changes" },
];
const DID: Record<MyReview["verdict"], string> = { approve: "You approved", changes: "You requested changes", comment: "You commented", dismissed: "Your review was dismissed" };

const NOTE = "mt-2 text-xs text-muted-foreground";
const LABEL = "mb-1.5 mt-4 text-[12.5px] font-semibold text-foreground";

const location = (path: string, line: number | null) => `${path.split("/").slice(-2).join("/")}${line === null ? "" : `:${line}`}`;

/** An AI draft: tick the findings to post, edit their text, pick the verdict, and post one review. */
function DraftReview({ pr, draft }: { pr: PrView; draft: ReviewDraft }) {
  const actions = useActions();
  const scope = `draft/${draft.id}`;
  const [summary, setSummary] = usePrState(pr.key, "summary", draft.summary, scope);
  const [findings, setFindings] = usePrState(pr.key, "findings", () => draft.findings.map((finding) => ({ ...finding, on: finding.severity !== "nit" })), scope);
  // The server refuses the same way: a draft without a head counts as read on an older one.
  const stale = draft.head === null || pr.head === null || draft.head !== pr.head;
  const [chosenVerdict, setVerdict] = usePrState(pr.key, "verdict", draft.verdict, scope);
  const verdict = stale && chosenVerdict === "approve" ? "comment" : chosenVerdict;
  const [staleOk, setStaleOk] = useState(false);
  const submit = useShuttleMutation("submitReview");
  const ticked = findings.filter((finding) => finding.on);
  const blank = ticked.some((finding) => finding.body.trim() === "");
  const set = (id: string, patch: Partial<(typeof findings)[number]>) => setFindings((current) => current.map((finding) => (finding.id === id ? { ...finding, ...patch } : finding)));
  const all = ticked.length === findings.length;

  const post = async () => {
    const out = await submit.run({
      key: pr.key, verdict, body: summary.trim(), draftId: draft.id, ...(stale ? { staleOk } : {}),
      findings: ticked.map((finding) => ({ path: finding.path, line: finding.line, body: finding.body.trim() })),
    });
    if (out !== null) toast.success(`Posted your review on ${pr.serverName}: ${out.placed} inline, ${out.inBody} in the body.`);
  };

  return (
    <div data-draft={draft.id}>
      <div className="mb-1.5 text-xs text-muted-foreground">
        {[draft.preset, draft.trigger === "auto" ? "auto review" : null].filter(Boolean).join(" · ")}
        {draft.head !== null && <> · on <span className="font-mono">{draft.head.slice(0, 7)}</span></>}
        {` · ${ago(draft.at)} · `}
        <button type="button" className="cursor-pointer text-primary hover:underline" onClick={() => actions.openThread(draft.threadId)}>open its thread</button>
      </div>
      {stale && (
        <div role="alert" data-stale-draft className="mb-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning-text">
          <div>
            {draft.head !== null && pr.head !== null
              ? <>{pr.author} pushed since this review read <span className="font-mono">{draft.head.slice(0, 7)}</span>; the PR is now at <span className="font-mono">{pr.head.slice(0, 7)}</span>. </>
              : <>{pr.serverName} doesn't say which commit this review read. </>}
            Its comments stay on the lines it read, and you can't approve from it.
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <button type="button" className={BUTTON} onClick={() => actions.startReview(pr)}>
              <Icon name="Play" className="size-3.5" aria-hidden />Review again
            </button>
            <label className="flex cursor-pointer items-center gap-1.5 text-foreground">
              <input type="checkbox" checked={staleOk} onChange={(event) => setStaleOk(event.target.checked)} className="size-4 cursor-pointer accent-foreground" />
              Post it anyway
            </label>
          </div>
        </div>
      )}
      <div className={LABEL}>Summary</div>
      <textarea aria-label="Summary" rows={3} className={`${FIELD} w-full`} value={summary} onChange={(event) => setSummary(event.target.value)} />
      <div className={`${LABEL} flex items-center`}>
        <span className="flex-1">Findings <span className="font-normal text-muted-foreground">· {ticked.length} of {findings.length} will post</span></span>
        {findings.length > 0 && (
          <button type="button" className="cursor-pointer text-xs font-normal text-primary" onClick={() => setFindings((current) => current.map((finding) => ({ ...finding, on: !all })))}>
            {all ? "None" : "All"}
          </button>
        )}
      </div>
      <ul aria-label="Findings">
        {findings.map((finding) => (
          <li key={finding.id} data-finding={finding.id} className={`flex items-start gap-2.5 border-t border-border py-2 first:border-t-0 ${finding.on ? "" : "opacity-60"}`}>
            <input type="checkbox" aria-label={`Post ${finding.severity} finding at ${location(finding.path, finding.line)}`} checked={finding.on}
              onChange={(event) => set(finding.id, { on: event.target.checked })} className="mt-1 size-4 shrink-0 cursor-pointer accent-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className={`text-[10px] font-bold uppercase tracking-wide ${SEVERITY_TEXT[finding.severity]}`}>{finding.severity}</span>
                <span title={`${finding.path}${finding.line === null ? "" : `:${finding.line}`}`} className="truncate rounded border border-border bg-background px-1 font-mono text-[11px] text-muted-foreground">
                  {location(finding.path, finding.line)}
                </span>
              </div>
              <textarea aria-label={`Text of the finding at ${location(finding.path, finding.line)}`} rows={2} value={finding.body}
                onChange={(event) => set(finding.id, { body: event.target.value })}
                className="mt-1 w-full resize-y rounded border border-transparent bg-transparent px-1 py-0.5 text-[13px] outline-none hover:border-border focus:border-border focus:bg-background" />
            </div>
          </li>
        ))}
      </ul>
      <div className={LABEL}>Post as</div>
      <Segmented label="Post as" value={verdict} options={stale ? VERDICT_OPTIONS.filter((option) => option.value !== "approve") : VERDICT_OPTIONS} onChange={setVerdict} />
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {pr.can.review && (
          <button type="button" className={BUTTON_PRIMARY_LARGE} disabled={submit.isPending || blank || (ticked.length === 0 && summary.trim() === "") || (stale && !staleOk)} onClick={() => void post()}>
            <Icon name="Sent" className="size-3.5" aria-hidden />Post review · {plural(ticked.length, "comment")}
          </button>
        )}
        <button type="button" className={BUTTON_GHOST} onClick={() => void actions.writes.discard(pr, draft.id)}>Discard draft</button>
      </div>
      {pr.can.review
        ? <div className={NOTE}>Posts to {pr.serverName} as you: one review with inline comments. Edit a finding's text before you post.</div>
        : <NoReviewCommand pr={pr} />}
    </div>
  );
}

/** Without a review command in its settings, a command server cannot post: say where to add one. */
function NoReviewCommand({ pr }: { pr: PrView }) {
  const pluginId = experimental_usePluginId();
  return (
    <div data-no-review-command className={NOTE}>
      Shuttle can't post this yet: {pr.serverName} has no <span className="font-mono">review</span> command in{" "}
      <UrlLink href={settingsHref(pluginId)} className="text-primary hover:underline">Settings › Servers</UrlLink>. Add one there (Shuttle's Delta adapter, delta.sh, has it), or post it from the review thread.
    </div>
  );
}

function Buttons({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

/** Where your review of someone else's PR stands, and what you can do about it: the Your review tab. */
export function YourReviewCard({ pr, draft }: { pr: PrView; draft: ReviewDraft | null }) {
  const actions = useActions();
  const card = useRef<HTMLElement>(null);
  const { intent, done } = actions;
  useEffect(() => {
    if (intent?.kind !== "draft" || intent.key !== pr.key || card.current === null) return;
    card.current.scrollIntoView?.({ block: "start", behavior: "smooth" });
    done(intent);
  }, [intent, done, pr.key]);
  if (!isLive(pr)) return null;
  const next = pr.next;
  const run = pr.lastReview;
  const comment = pr.can.comment && <button type="button" className={BUTTON_GHOST} onClick={() => actions.compose(pr)}><Icon name="MessageSquare" className="size-3.5" aria-hidden />Comment</button>;
  const approve = pr.can.review && <button type="button" className={BUTTON} onClick={() => actions.approve(pr)}><Icon name="Check" className="size-3.5" aria-hidden />Approve…</button>;

  let body: ReactNode;
  if (draft !== null) {
    body = <DraftReview key={draft.id} pr={pr} draft={draft} />;
  } else if (run?.state === "running") {
    body = (
      <>
        <div className="flex items-center gap-2 text-sm">
          <Icon name="Bot" className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1"><b>{run.preset}</b> is reviewing in “{run.title}”</span>
          <span className="text-xs text-muted-foreground">{ago(run.at)}</span>
        </div>
        <div aria-hidden className="my-2 h-1 overflow-hidden rounded bg-surface-recessed"><div className="h-full w-2/5 animate-pulse rounded bg-muted-foreground" /></div>
        <Buttons><button type="button" className={BUTTON} onClick={() => actions.openThread(run.threadId)}>Open the thread</button></Buttons>
        <div className={NOTE}>Its findings land here as a draft. Nothing is posted until you choose.</div>
      </>
    );
  } else if (pr.myReview !== null) {
    body = (
      <>
        <div className="flex items-center gap-2 text-sm">
          <Icon name={pr.myReview.verdict === "approve" ? "Check" : "MessageSquare"} className={`size-4 shrink-0 ${pr.myReview.verdict === "approve" ? "text-success" : ""}`} aria-hidden />
          <span className="min-w-0 flex-1"><b>{DID[pr.myReview.verdict]}</b>{pr.myReview.at !== null && ` ${ago(pr.myReview.at)}`}</span>
          {run !== null && <button type="button" className="cursor-pointer text-xs text-primary hover:underline" onClick={() => actions.openThread(run.threadId)}>its thread</button>}
        </div>
        {next.kind === "rereview" ? (
          <>
            <div className="my-2 text-sm">{next.why}</div>
            <Buttons>
              <button type="button" className={BUTTON_PRIMARY_LARGE} onClick={() => actions.startReview(pr)}><Icon name="Play" className="size-3.5" aria-hidden />Re-review with AI</button>
              {approve}
              {comment}
            </Buttons>
            {run !== null && <div className={NOTE}>A re-review goes to the same thread, which knows your last review.</div>}
          </>
        ) : <div className={NOTE}>Comes back to your Inbox when the author pushes or replies.</div>}
      </>
    );
  } else if (next.kind === "review_done" || next.kind === "review_failed") {
    body = (
      <>
        <div className="mb-2 text-sm">{next.why}</div>
        <Buttons><NextButtons pr={pr} />{comment}</Buttons>
      </>
    );
  } else {
    body = (
      <>
        <div className="mb-2 text-sm">{next.why}</div>
        <Buttons>
          <button type="button" className={BUTTON_PRIMARY_LARGE} onClick={() => actions.startReview(pr)}><Icon name="Play" className="size-3.5" aria-hidden />Start AI review</button>
          {next.inbox && <button type="button" className={BUTTON} onClick={() => void actions.writes.setSnooze(pr, "update")}>Not now</button>}
          {approve}
          {comment}
        </Buttons>
        <div className={NOTE}>An AI review runs in its own thread and drafts findings here. Nothing is posted until you choose.</div>
      </>
    );
  }

  return (
    <section ref={card} aria-label="Your review" data-your-review className="scroll-mt-28">
      {body}
    </section>
  );
}
