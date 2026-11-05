import { useEffect, useRef, useState, type ReactNode } from "react";
import { experimental_Icon as Icon, experimental_usePluginId, Markdown, UrlLink } from "@get-bb/plugin-sdk/app";
import type { GateFinding, HistoryFate, MyReview, PostView, PrView, ReviewDraft, ReviewHistoryItem, Severity } from "../contract";
import { postText } from "../next";
import { NextButtons, useActions } from "./actions";
import { BUTTON, BUTTON_GHOST, BUTTON_PRIMARY, BUTTON_PRIMARY_LARGE, FIELD, FitTextarea, Segmented } from "./common";
import { useShuttleMutation, useShuttleQuery } from "./data";
import { ago, clock, plural, settingsHref, span } from "./format";
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

const CHECK_NAMES = { safety: "Safety", accuracy: "Accuracy", quality: "Quality", alignment: "Alignment" } as const;

/** What auto post made of one finding, as a chip beside it, with every check in its tooltip. */
function GateChip({ finding, posting }: { finding: GateFinding; posting: boolean }) {
  const failed = finding.checks.find((check) => !check.ok);
  const scores = finding.holds === null ? "" : `\nVerifier: holds ${finding.holds.toFixed(2)}, worth posting ${finding.worth?.toFixed(2) ?? "?"}${finding.why ? `. ${finding.why}` : ""}`;
  const title = `${finding.checks.map((check) => `${check.ok ? "\u2713" : "\u2717"} ${CHECK_NAMES[check.check]}: ${check.reason}`).join("\n")}${scores}`;
  const text = posting ? "would post" : failed ? `held: ${failed.reason}` : "passed, draft held";
  const tone = posting ? "border-success/40 text-success" : failed ? "border-border text-muted-foreground" : "border-warning/40 text-warning-text";
  return <span data-gate-finding={posting ? "post" : failed ? "held" : "passed"} title={title} className={`min-w-0 truncate rounded border px-1 text-[10.5px] ${tone}`}>{text}</span>;
}

/** Auto post's shadow decision on the draft: what it would do and why. It never posts. */
function GateNote({ pr, draft }: { pr: PrView; draft: ReviewDraft }) {
  const check = useShuttleMutation("checkDraft");
  const gate = draft.gate;
  if (gate === null) return null;
  const post = gate.decision === "post";
  return (
    <section aria-label="Auto post" data-gate={gate.decision} className={`mt-3 rounded-md border px-3 py-2 text-xs ${post ? "border-success/40 bg-success/5" : "border-border bg-card"}`}>
      <div className="flex flex-wrap items-center gap-1.5 text-[12.5px] font-semibold text-foreground">
        <Icon name="Eye" className="size-3.5 text-muted-foreground" aria-hidden />
        Auto post would {post ? `post ${plural(gate.posting.length, "finding")}` : "hold this draft"}
        <span className="font-normal text-muted-foreground">{draft.autoPost === null ? "· nothing from this check is posted" : ""} · checked {ago(gate.at)}</span>
        <button type="button" className="ml-auto cursor-pointer text-xs font-normal text-primary disabled:opacity-60" disabled={check.isPending} onClick={() => void check.run({ key: pr.key, draftId: draft.id })}>
          {check.isPending ? "Checking\u2026" : "Check again"}
        </button>
      </div>
      {!post && gate.reasons.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-muted-foreground">{gate.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
      )}
      {gate.approval && (
        <div data-gate-approval={gate.approval.decision} className="mt-1.5 border-t border-border pt-1.5">
          <span className="font-semibold text-foreground">{gate.approval.decision === "approve" ? "The approval rules would approve this PR" : "The approval rules would not approve this PR"}</span>
          {gate.approval.reasons.length > 0 && <ul className="mt-0.5 list-disc pl-5 text-muted-foreground">{gate.approval.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
        </div>
      )}
    </section>
  );
}

const STOPPED_FALLBACK = { stopped: "you stopped it", refused: "it did not pass at post time" } as const;

/** Shuttle's own plan for the draft in a repository that posts: when it posts, what, and Stop or Post now while it waits. */
function AutoPostBanner({ pr, draft, edited }: { pr: PrView; draft: ReviewDraft; edited: boolean }) {
  const stop = useShuttleMutation("stopAutoPost");
  const now = useShuttleMutation("autoPostNow");
  const plan = draft.autoPost;
  if (plan === null) return null;
  const posting = draft.findings.filter((finding) => plan.findings.includes(finding.id));
  const what = plan.verdict === "approve" ? `approve this PR${posting.length > 0 ? ` with ${plural(posting.length, "comment")}` : ""}` : `post ${plural(posting.length, "comment")}`;
  const frame = "mt-3 rounded-md border px-3 py-2 text-xs";
  if (plan.state === "scheduled") {
    const at = plan.at;
    const left = at === null ? null : at <= Date.now() ? "any moment now" : `in ${span(at - Date.now())}, at ${clock(at)}`;
    return (
      <section role="status" aria-label="Shuttle's post" data-auto-post="scheduled" className={`${frame} border-warning/40 bg-warning/5`}>
        <div className="flex flex-wrap items-center gap-1.5 text-[12.5px] font-semibold text-foreground">
          <Icon name="Clock" className="size-3.5 text-warning-text" aria-hidden />
          Shuttle will {what}{left === null ? "" : ` ${left}`} unless you stop it.
        </div>
        {posting.length > 0 && (
          <div className="mt-1 text-muted-foreground">
            It posts {posting.map((finding, index) => (
              <span key={finding.id}>{index > 0 ? ", " : ""}<span className={`font-semibold uppercase ${SEVERITY_TEXT[finding.severity]}`}>{finding.severity}</span> at <span className="font-mono">{location(finding.path, finding.line)}</span></span>
            ))}, as Shuttle, with the footer from its settings.
          </div>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <button type="button" className={BUTTON_PRIMARY} disabled={stop.isPending || now.isPending} onClick={() => void stop.run({ key: pr.key, draftId: draft.id })}>
            <Icon name="X" className="size-3.5" aria-hidden />{stop.isPending ? "Stopping\u2026" : "Stop"}
          </button>
          {/* Post now sends Shuttle's review as checked, never your edits, so it is gone once you edit. */}
          {!edited && (
            <button type="button" className={BUTTON} disabled={stop.isPending || now.isPending} onClick={() => void now.run({ key: pr.key, draftId: draft.id })}>
              <Icon name="Sent" className="size-3.5" aria-hidden />{now.isPending ? "Posting\u2026" : plan.verdict === "approve" ? "Approve now" : "Post now"}
            </button>
          )}
          <span className="text-muted-foreground">{edited ? "You edited the review, so Shuttle is stopping its post; post yours below." : "Or post it yourself below: that stops Shuttle's post too."}</span>
        </div>
      </section>
    );
  }
  if (plan.state === "queued" || plan.state === "posted") {
    return (
      <section role="status" aria-label="Shuttle's post" data-auto-post={plan.state} className={`${frame} border-border bg-card text-muted-foreground`}>
        <Icon name="Sent" className="mr-1.5 inline size-3.5 align-text-bottom" aria-hidden />
        {plan.state === "queued" ? `Shuttle queued it to post${plan.verdict === null ? "" : `: it will ${what}`}.` : `Shuttle posted it${plan.at === null ? "" : ` ${ago(plan.at)}`}.`}
      </section>
    );
  }
  return (
    <section role="status" aria-label="Shuttle's post" data-auto-post={plan.state} className={`${frame} border-border bg-card text-muted-foreground`}>
      <Icon name="CircleSlash" fallback="Ban" className="mr-1.5 inline size-3.5 align-text-bottom" aria-hidden />
      Shuttle won't post this on its own: {plan.reason ?? STOPPED_FALLBACK[plan.state]}.
    </section>
  );
}

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
  const gated = new Map((draft.gate?.findings ?? []).map((finding) => [finding.id, finding]));
  // Any edit makes the review yours: Shuttle's scheduled post of the draft as it was must not go out instead.
  const edited = summary !== draft.summary || chosenVerdict !== draft.verdict
    || findings.some((finding) => {
      const original = draft.findings.find((f) => f.id === finding.id);
      return original === undefined || finding.body !== original.body || finding.on !== (original.severity !== "nit");
    });
  const stopAuto = useShuttleMutation("stopAutoPost");
  const stoppedFor = useRef<number | null>(null);
  useEffect(() => {
    if (!edited || draft.autoPost?.state !== "scheduled" || stoppedFor.current === draft.id) return;
    stoppedFor.current = draft.id;
    void stopAuto.run({ key: pr.key, draftId: draft.id });
  }, [edited, draft.autoPost?.state, draft.id, pr.key, stopAuto]);

  const post = () => submit.run(pr, {
    verdict, body: summary.trim(), draftId: draft.id, ...(stale ? { staleOk } : {}),
    findings: ticked.map((finding) => ({ id: finding.id, path: finding.path, line: finding.line, body: finding.body.trim() })),
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
      <AutoPostBanner pr={pr} draft={draft} edited={edited} />
      <GateNote pr={pr} draft={draft} />
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
                {gated.get(finding.id) && <GateChip finding={gated.get(finding.id)!} posting={draft.gate?.posting.includes(finding.id) ?? false} />}
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
      <UrlLink href={settingsHref(pluginId)} className="text-primary hover:underline">Settings › Servers</UrlLink>. Add one there, or post it from the review thread.
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

const POSTED_AS: Record<ReviewDraft["verdict"], string> = { approve: "you approved", comment: "you commented", changes: "you requested changes" };

function historyFate(item: ReviewHistoryItem): string {
  if (item.autoPosted !== null) {
    const did = item.autoPosted.verdict === "approve" ? "Shuttle approved" : "Shuttle commented";
    return item.autoPosted.findings.length === 0 ? did : `${did} with ${plural(item.autoPosted.findings.length, "comment")}`;
  }
  if (item.state === "unposted") return "never posted";
  if (item.state === "discarded") return item.discardReason === "superseded" ? "replaced by a newer review" : "you discarded it";
  const posted = item.posted === null ? "you posted it" : POSTED_AS[item.posted];
  return item.postedFindings === null ? posted : `${posted} with ${plural(item.postedFindings, "comment")}`;
}

/**
 * What Shuttle posted from an earlier draft, with a mark on each comment and on the approval: a mark counts against the
 * record and can stop posting in the repository; unticking it takes the mark back.
 */
function AutoPosted({ pr, item }: { pr: PrView; item: ReviewHistoryItem }) {
  const mark = useShuttleMutation("markAutoPost");
  const posted = item.autoPosted;
  if (posted === null) return null;
  const toggle = (findingId: string | null, undo: boolean) => void mark.run({ key: pr.key, draftId: item.id, ...(findingId === null ? {} : { findingId }), ...(undo ? { undo } : {}) });
  const box = "size-4 shrink-0 cursor-pointer accent-foreground";
  return (
    <div data-auto-posted={posted.verdict} className="mt-1.5 rounded-md border border-border bg-card px-3 py-2 text-xs">
      <div className="flex items-center gap-1.5 text-[12.5px] font-semibold text-foreground">
        <Icon name="Sent" className="size-3.5 text-muted-foreground" aria-hidden />
        Shuttle {posted.verdict === "approve" ? "approved this PR" : "commented"}{posted.findings.length > 0 ? ` with ${plural(posted.findings.length, "comment")}` : ""}
        <span className="font-normal text-muted-foreground">· mark what it got wrong; enough marks stop it posting here</span>
      </div>
      {posted.verdict === "approve" && (
        <label className="mt-1.5 flex cursor-pointer items-center gap-2 text-foreground">
          <input type="checkbox" className={box} checked={posted.mistake !== null} disabled={mark.isPending} onChange={() => toggle(null, posted.mistake !== null)} />
          This approval was a mistake{posted.mistake !== null && <span className="text-muted-foreground">· marked {ago(posted.mistake)}</span>}
        </label>
      )}
      {posted.findings.length > 0 && (
        <ul className="mt-1">
          {posted.findings.map((finding) => (
            <li key={finding.id} data-auto-posted-finding={finding.id} className="flex items-start gap-2.5 border-t border-border py-1.5 first:border-t-0">
              <div className="min-w-0 flex-1">
                <span title={`${finding.path}${finding.line === null ? "" : `:${finding.line}`}`} className="rounded border border-border bg-background px-1 font-mono text-[11px] text-muted-foreground">{location(finding.path, finding.line)}</span>
                <div className={`mt-0.5 line-clamp-2 text-[12.5px] ${finding.marked ? "text-muted-foreground line-through" : ""}`}>{finding.body}</div>
              </div>
              <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-foreground">
                <input type="checkbox" className={box} aria-label={`Should not have posted the comment at ${location(finding.path, finding.line)}`} checked={finding.marked} disabled={mark.isPending} onChange={() => toggle(finding.id, finding.marked)} />
                Should not have posted
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const FATE_TEXT: Record<HistoryFate, string> = { posted: "posted", edited: "posted with your edits", left_out: "not posted", auto: "Shuttle posted it", retracted: "Shuttle posted it; you marked it a mistake" };

/** The review as it posted, or its summary when it never did, then every finding with what became of it. */
function EarlierReviewBody({ item }: { item: ReviewHistoryItem }) {
  const text = item.postedBody ?? item.summary;
  return (
    <div data-earlier-body>
      {text.trim()
        ? <div className="mt-1 min-w-0 break-words text-[13px]"><Markdown content={text} /></div>
        : <div className="mt-1 text-muted-foreground">{item.postedBody !== null ? "Posted without text, only its comments." : "No summary."}</div>}
      {item.findings.length > 0 && (
        <ul aria-label="Findings" className="mt-1.5">
          {item.findings.map((finding) => (
            <li key={finding.id} data-earlier-finding={finding.id} data-fate={finding.fate ?? undefined} className="border-t border-border py-1.5 first:border-t-0">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className={`text-[10px] font-bold uppercase tracking-wide ${SEVERITY_TEXT[finding.severity]}`}>{finding.severity}</span>
                <span title={`${finding.path}${finding.line === null ? "" : `:${finding.line}`}`} className="min-w-0 truncate rounded border border-border bg-background px-1 font-mono text-[11px] text-muted-foreground">{location(finding.path, finding.line)}</span>
                {finding.fate !== null && <span className="text-muted-foreground">· {FATE_TEXT[finding.fate]}</span>}
              </div>
              <div className={`mt-0.5 min-w-0 break-words text-[13px] ${finding.fate === "left_out" ? "text-muted-foreground" : ""}`}><Markdown content={finding.body} /></div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One earlier review: when, what it suggested and what became of it, its notes for you, and the whole review folded. */
function EarlierReview({ pr, item, open }: { pr: PrView; item: ReviewHistoryItem; open: boolean }) {
  const actions = useActions();
  return (
    <li data-earlier-review={item.id} className="border-t border-border py-2.5 first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        <b className="text-foreground">{item.preset ?? "AI review"}</b>
        <span>· {ago(item.at)}</span>
        {item.head !== null && <span>· on <span className="font-mono">{item.head.slice(0, 7)}</span></span>}
        <span>· suggested {item.suggested === "changes" ? "requesting changes" : item.suggested === "approve" ? "approving" : "a comment"}, {historyFate(item)}</span>
        <button type="button" className="cursor-pointer text-primary hover:underline" onClick={() => actions.openThread(item.threadId)}>open its thread</button>
      </div>
      <AutoPosted pr={pr} item={item} />
      {item.notes !== null
        ? <div data-earlier-notes className="mt-1.5 min-w-0 break-words rounded-md border border-border bg-card px-3 py-2 text-[13px]"><Markdown content={item.notes} /></div>
        : <div className="mt-1 text-xs text-muted-foreground">No notes for you.</div>}
      <details className="mt-1.5 text-xs" open={open && item.notes === null}>
        <summary className="cursor-pointer text-muted-foreground">
          {item.postedBody === null ? "Summary" : item.autoPosted !== null ? "The review Shuttle posted" : "The review you posted"}{item.findings.length > 0 ? ` and ${plural(item.findings.length, "finding")}` : ""}
        </summary>
        <EarlierReviewBody item={item} />
      </details>
    </li>
  );
}

/** The PR's earlier AI reviews with the notes they left for you, newest first; nothing when there are none. */
function EarlierReviews({ pr }: { pr: PrView }) {
  const history = useShuttleQuery("reviewHistory", { key: pr.key });
  const items = history.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <section aria-label="Earlier reviews" data-earlier-reviews className="mt-5">
      <div className="mb-1.5 text-[12.5px] font-semibold text-foreground">Earlier reviews <span className="font-normal text-muted-foreground">· what each found and posted; notes for you are never posted</span></div>
      <ul>{items.map((item, index) => <EarlierReview key={item.id} pr={pr} item={item} open={index === 0} />)}</ul>
    </section>
  );
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
  // A merged or closed PR keeps only its earlier reviews.
  if (!isLive(pr)) return <section ref={card} aria-label="Your review" data-your-review className="scroll-mt-28"><EarlierReviews pr={pr} /></section>;
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
          {/* A dismissed review's time is when you reviewed, which the next step's words already say. */}
          <span className="min-w-0 flex-1"><b>{DID[pr.myReview.verdict]}</b>{pr.myReview.at !== null && pr.myReview.verdict !== "dismissed" && ` ${ago(pr.myReview.at)}`}</span>
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
      <EarlierReviews pr={pr} />
    </section>
  );
}
