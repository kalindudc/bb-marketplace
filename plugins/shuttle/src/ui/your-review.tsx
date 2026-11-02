import { useEffect, useRef, useState, type ReactNode } from "react";
import { experimental_Icon as Icon, experimental_usePluginId, Markdown, UrlLink } from "@get-bb/plugin-sdk/app";
import type { MyReview, PostView, PrView, ReviewDraft, Severity } from "../contract";
import { postText } from "../next";
import { NextButtons, useActions } from "./actions";
import { BUTTON, BUTTON_GHOST, BUTTON_PRIMARY_LARGE, FIELD, FitTextarea, Segmented } from "./common";
import { ago, plural, settingsHref } from "./format";
import { isLive } from "./pills";
import { reviewInQueue, useQueueReview } from "./posts";
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
  const submit = useQueueReview();
  const ticked = findings.filter((finding) => finding.on);
  const blank = ticked.some((finding) => finding.body.trim() === "");
  const set = (id: string, patch: Partial<(typeof findings)[number]>) => setFindings((current) => current.map((finding) => (finding.id === id ? { ...finding, ...patch } : finding)));
  const all = ticked.length === findings.length;
  const inQueue = reviewInQueue(pr);

  const post = () => submit.run(pr, {
    verdict, body: summary.trim(), draftId: draft.id, ...(stale ? { staleOk } : {}),
    findings: ticked.map((finding) => ({ path: finding.path, line: finding.line, body: finding.body.trim() })),
  });

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
      {draft.notes !== null && (
        <section aria-label="For you" data-draft-notes className="mt-3 rounded-md border border-border bg-card px-3 py-2">
          <div className="mb-1 flex items-center gap-1.5 text-[12.5px] font-semibold text-foreground">
            <Icon name="Info" className="size-3.5 text-muted-foreground" aria-hidden />For you
            <span className="font-normal text-muted-foreground">· Never posted</span>
          </div>
          <div className="min-w-0 break-words text-[13px]"><Markdown content={draft.notes} /></div>
        </section>
      )}
      <div className={LABEL}>Summary</div>
      <FitTextarea aria-label="Summary" rows={2} className={`${FIELD} w-full`} value={summary} onChange={(event) => setSummary(event.target.value)} />
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
              <FitTextarea aria-label={`Text of the finding at ${location(finding.path, finding.line)}`} rows={1} value={finding.body}
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
          <button type="button" className={BUTTON_PRIMARY_LARGE} disabled={inQueue || submit.isPending || blank || (ticked.length === 0 && summary.trim() === "") || (stale && !staleOk)} onClick={() => void post()}>
            {inQueue
              ? <><Icon name="Clock" className="size-3.5" aria-hidden />Queued to post</>
              : <><Icon name="Sent" className="size-3.5" aria-hidden />Post review · {plural(ticked.length, "comment")}</>}
          </button>
        )}
        <button type="button" className={BUTTON_GHOST} onClick={() => void actions.writes.discard(pr, draft.id)}>Discard draft</button>
      </div>
      {pr.can.review
        ? <div className={NOTE}>Posts to {pr.serverName} as you, in the background: one review with inline comments. Edit a finding's text before you post.</div>
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

/** A review of yours in the queue: what it posts, where it stands, and Cancel until it starts. */
function Posting({ pr, post }: { pr: PrView; post: PostView }) {
  const { writes } = useActions();
  const queued = post.state === "queued";
  return (
    <div data-posting={post.id}>
      <div className="flex items-center gap-2 text-sm">
        <Icon name="Sent" className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1"><b>{postText(post)}</b> {queued ? "is queued to post" : "is posting"} to {post.serverName}</span>
        <span className="text-xs text-muted-foreground">{queued ? `queued ${ago(post.at)}` : `started ${ago(post.startedAt ?? post.at)}`}</span>
      </div>
      <div aria-hidden className="my-2 h-1 overflow-hidden rounded bg-surface-recessed"><div className="h-full w-2/5 animate-pulse rounded bg-muted-foreground" /></div>
      {/* Until the server has given it an id, there is nothing to cancel yet. */}
      {queued && post.id > 0 && <Buttons><button type="button" className={BUTTON} onClick={() => void writes.cancelPost(pr)}><Icon name="X" className="size-3.5" aria-hidden />Cancel</button></Buttons>}
      <div className={NOTE}>You can leave: Shuttle posts it in the background, after any reviews ahead of it on {post.serverName}, and says when it's done.</div>
    </div>
  );
}

/** A review of yours the server did not take, why, and what to do about it. */
function PostFailed({ pr, post }: { pr: PrView; post: PostView }) {
  const { writes } = useActions();
  return (
    <div role="alert" data-post-failed={post.id} className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive-text">
      <div><b className="font-semibold">Your review didn't post</b> ({postText(post)}): {post.error ?? "it failed"}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <button type="button" className={BUTTON} onClick={() => void writes.retryPost(pr)}><Icon name="RotateCcw" className="size-3.5" aria-hidden />Try again</button>
        <button type="button" className={BUTTON_GHOST} onClick={() => void writes.clearPost(pr)}>Dismiss</button>
        {post.draftId !== null && <span className="text-muted-foreground">Or change the draft below and post it again.</span>}
      </div>
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

  const post = pr.post;
  const posting = post !== null && post.state !== "failed" ? post : null;
  let body: ReactNode;
  if (posting !== null) {
    body = (
      <>
        <Posting pr={pr} post={posting} />
        {draft !== null && posting.draftId !== draft.id && <div className="mt-4"><DraftReview key={draft.id} pr={pr} draft={draft} /></div>}
      </>
    );
  } else if (draft !== null) {
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
      {post !== null && post.state === "failed" && <PostFailed pr={pr} post={post} />}
      {body}
    </section>
  );
}
