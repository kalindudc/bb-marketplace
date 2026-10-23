import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { experimental_Icon as Icon, Markdown, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { ActivityItem, Attempt, ChecksItem, Mark, PostDto, TicketDetail } from "../contract";
import { formatDuration, plural } from "../format";
import { BUTTON, FIELD } from "./common";
import { Avatar, ago, CLAMP, ChecksCard, checksText, FeedbackCard, GHOST, INNER, MARKDOWN, MergeRow, PrTextCard, ReviewCard, useLong } from "./ticket-cards";

const INDENT_PX = 16;
const MAX_DEPTH = 6;

export const replyHint = (to: TicketDetail["replyTo"], ticket?: Pick<TicketDetail, "state" | "projectState">) =>
  ticket?.state === "pr_open" && ticket.projectState === "running"
    ? "This starts a fix round: the worker gets it now, and Loom pushes the fix to the pull request as one more commit."
    : to === "worker"
      ? "The worker gets this now."
      : to === "planner"
        ? "The planner gets this now."
        : "It stays on the ticket for anyone who reads it.";

export function ReplyBox({ textLabel, sendLabel, busy, hint, placeholder, onSend, onCancel }: { textLabel: string; sendLabel: string; busy: boolean; hint: string; placeholder?: string; onSend(body: string): Promise<boolean>; onCancel?(): void }) {
  const [text, setText] = useState("");
  return (
    <div className="mt-2 space-y-2">
      <textarea aria-label={textLabel} value={text} rows={3} placeholder={placeholder} onChange={(event) => setText(event.target.value)} className={FIELD} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" aria-label={sendLabel} disabled={busy || text.trim() === ""} onClick={() => void onSend(text.trim()).then((sent) => sent && setText(""))} className={BUTTON}>
          Send reply
        </button>
        {onCancel !== undefined && (
          <button type="button" onClick={onCancel} className={BUTTON}>
            Cancel
          </button>
        )}
        <span data-reply-hint className="text-[11px] text-subtle-foreground">
          {hint}
        </span>
      </div>
    </div>
  );
}

/** What the cards of one stream share: the ticket, the clock, and the open composer and expanded posts the stream holds. */
interface StreamCtx {
  ticket: TicketDetail;
  now: number;
  busy: boolean;
  composer: number | null;
  expanded: ReadonlySet<number>;
  toggleComposer(postId: number): void;
  toggleExpanded(postId: number): void;
  send(postId: number, body: string): Promise<boolean>;
  onBrief(): void;
  openThread(threadId: string): void;
  openUrl(url: string): void;
}

const KIND_TAGS: Partial<Record<PostDto["kind"], { text: string; tone: string }>> = {
  note: { text: "note", tone: "bg-foreground/5 text-muted-foreground" },
  submit: { text: "Submitted for checks", tone: "bg-timeline-accent/15 text-timeline-accent" },
  block: { text: "Blocked", tone: "bg-destructive-text/15 text-destructive-text" },
};

function nameOf(ctx: StreamCtx, post: PostDto): string {
  switch (post.authorKind) {
    case "planner":
      return "Planner";
    case "worker": {
      const attempt = ctx.ticket.activity.attempts.find((candidate) => candidate.threadId !== null && candidate.threadId === post.authorThreadId);
      return attempt === undefined ? "Worker" : `Worker · attempt ${attempt.n}`;
    }
    case "reviewer":
      return "Reviewer";
    case "human":
      return "You";
    case "loom":
      return "Loom";
  }
}

/** A top-level post's replies: the posts right after it with a depth above 0, since `ticket.posts` is in thread order. */
function repliesOf(ticket: TicketDetail, postId: number): PostDto[] {
  const start = ticket.posts.findIndex((post) => post.id === postId);
  const replies: PostDto[] = [];
  for (let index = start + 1; start !== -1 && index < ticket.posts.length && ticket.posts[index]!.depth > 0; index += 1) replies.push(ticket.posts[index]!);
  return replies;
}

function Replies({ ctx, postId }: { ctx: StreamCtx; postId: number }) {
  const replies = repliesOf(ctx.ticket, postId);
  if (replies.length === 0) return null;
  return (
    <div className="space-y-1.5 px-3 pb-3">
      {replies.map((reply) => (
        <PostCard key={reply.id} ctx={ctx} post={reply} withReplies={false} />
      ))}
    </div>
  );
}

function ReplyButton({ ctx, postId }: { ctx: StreamCtx; postId: number }) {
  return (
    <button type="button" aria-label={`Reply to #${postId}`} onClick={() => ctx.toggleComposer(postId)} className={GHOST}>
      Reply
    </button>
  );
}

function Composer({ ctx, postId }: { ctx: StreamCtx; postId: number }) {
  if (ctx.composer !== postId) return null;
  return (
    <div className="px-3 pb-3">
      <ReplyBox textLabel={`Reply text for #${postId}`} sendLabel={`Send reply to #${postId}`} busy={ctx.busy} hint={replyHint(ctx.ticket.replyTo, ctx.ticket)} onSend={(body) => ctx.send(postId, body)} onCancel={() => ctx.toggleComposer(postId)} />
    </div>
  );
}

function PostCard({ ctx, post, withReplies }: { ctx: StreamCtx; post: PostDto; withReplies: boolean }) {
  const navigate = useBbNavigate();
  const expanded = ctx.expanded.has(post.id);
  const { ref, long } = useLong(post.body, expanded);
  const tag = KIND_TAGS[post.kind];
  const bar = post.kind === "block" ? "shadow-[inset_3px_0_0_var(--destructive-text)]" : post.authorKind === "human" ? "shadow-[inset_3px_0_0_var(--success)]" : "";
  return (
    <article data-post={post.id} style={{ marginLeft: `${Math.min(post.depth, MAX_DEPTH) * INDENT_PX}px` }} className={`${INNER} ${bar}`}>
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pt-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5 font-semibold text-foreground">
          <Avatar kind={post.authorKind} />
          {nameOf(ctx, post)}
        </span>
        {tag !== undefined && <span className={`rounded px-1.5 text-[11px] ${tag.tone}`}>{tag.text}</span>}
        <span>{ago(post.at, ctx.now)}</span>
        <span className="text-[11px] text-subtle-foreground">#{post.id}</span>
      </header>
      <div ref={ref} data-post-body className={`px-3 pt-1 ${long && !expanded ? CLAMP : ""}`}>
        <Markdown content={post.body} className={MARKDOWN} />
      </div>
      <div className="flex flex-wrap gap-0.5 px-2 pb-1.5 pt-0.5">
        {long && (
          <button type="button" onClick={() => ctx.toggleExpanded(post.id)} className={GHOST}>
            {expanded ? "Show less" : "Show all"}
          </button>
        )}
        <ReplyButton ctx={ctx} postId={post.id} />
        {post.authorThreadId !== null && (
          <button type="button" aria-label={`Open the thread of #${post.id}`} onClick={() => navigate.toThread(post.authorThreadId!)} className={GHOST}>
            ↗ Thread
          </button>
        )}
      </div>
      <Composer ctx={ctx} postId={post.id} />
      {withReplies && <Replies ctx={ctx} postId={post.id} />}
    </article>
  );
}

/** A system post as a row: an edit by the planner, a cancel, or a thread that could not start or run. */
function Marker({ ctx, post }: { ctx: StreamCtx; post: PostDto }) {
  const edit = /^The planner edited this ticket: (.+)\.$/.exec(post.body);
  const editsBody = post.authorKind === "planner" && edit !== null && edit[1]!.split(", ").includes("body");
  const failed = post.body.startsWith("Could not start") || post.body.startsWith("The checks could not run");
  return (
    <div data-marker={post.id}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1 text-xs text-muted-foreground">
        <Icon name="EditFile" aria-hidden className="size-3.5" />
        <Avatar kind={post.authorKind} />
        <span className={`[overflow-wrap:anywhere] ${failed ? "text-destructive-text" : "text-foreground"}`}>{post.body}</span>
        <span className="text-subtle-foreground">{ago(post.at, ctx.now)}</span>
        {editsBody && (
          <button type="button" onClick={ctx.onBrief} className={GHOST}>
            Read the brief
          </button>
        )}
      </div>
      <Replies ctx={ctx} postId={post.id} />
    </div>
  );
}

function Item({ ctx, item, openFailed }: { ctx: StreamCtx; item: ActivityItem; openFailed: ChecksItem | null }) {
  const post = (id: number | null) => (id === null ? null : (ctx.ticket.posts.find((candidate) => candidate.id === id) ?? null));
  switch (item.type) {
    case "checks":
      return (
        <div>
          <ChecksCard item={item} now={ctx.now} openFailed={item === openFailed} />
          {item.postId !== null && <Replies ctx={ctx} postId={item.postId} />}
        </div>
      );
    case "merge":
      return (
        <div>
          <MergeRow item={item} post={post(item.postId)} now={ctx.now} />
          {item.postId !== null && <Replies ctx={ctx} postId={item.postId} />}
        </div>
      );
    case "review": {
      const review = ctx.ticket.reviews.find((candidate) => candidate.id === item.reviewId)!;
      const posted = post(item.postId)!;
      const notes = item.notePostIds.map(post).filter((note): note is PostDto => note !== null);
      return (
        <ReviewCard
          review={review}
          post={posted}
          thread={ctx.ticket.threads.find((thread) => thread.threadId !== null && thread.threadId === review.threadId) ?? null}
          now={ctx.now}
          notes={notes.length === 0 ? null : notes.map((note) => <PostCard key={note.id} ctx={ctx} post={note} withReplies />)}
          footer={
            <>
              <div className="px-2 pb-1.5">
                <ReplyButton ctx={ctx} postId={posted.id} />
              </div>
              <Composer ctx={ctx} postId={posted.id} />
              <Replies ctx={ctx} postId={posted.id} />
            </>
          }
        />
      );
    }
    case "post": {
      const posted = post(item.postId)!;
      return posted.kind === "system" ? <Marker ctx={ctx} post={posted} /> : <PostCard ctx={ctx} post={posted} withReplies />;
    }
    case "pr_text": {
      const author = post(item.postId)?.authorThreadId ?? null;
      return (
        <div>
          <PrTextCard item={item} now={ctx.now} onThread={author === null ? null : () => ctx.openThread(author)} />
          <Replies ctx={ctx} postId={item.postId} />
        </div>
      );
    }
    case "pr_feedback":
      return (
        <div>
          <FeedbackCard item={item} max={ctx.ticket.pr?.maxRounds ?? 0} now={ctx.now} openUrl={ctx.openUrl} />
          <Replies ctx={ctx} postId={item.postId} />
        </div>
      );
  }
}

const MARK_GLYPHS: Record<Mark, { glyph: string; tone: string }> = {
  pass: { glyph: "✓", tone: "text-success-foreground" },
  fail: { glyph: "✗", tone: "text-destructive-text" },
  running: { glyph: "●", tone: "text-timeline-accent" },
  none: { glyph: "·", tone: "text-muted-foreground" },
};

function Pipeline({ pipeline }: { pipeline: Attempt["pipeline"] }) {
  const stages: Array<[string, Mark[]]> = [
    ["Work", [pipeline.work]],
    ["Checks", pipeline.checks],
    ["Review", pipeline.review],
    ["Merge", pipeline.merge],
    ["PR", pipeline.pr],
  ];
  return (
    <span data-pipeline className="inline-flex flex-wrap items-center gap-1 text-[11.5px] text-muted-foreground">
      {stages
        .filter(([, marks], index) => index === 0 || marks.length > 0)
        .map(([label, marks], index) => (
          <Fragment key={label}>
            {index > 0 && (
              <span aria-hidden className="text-subtle-foreground">
                {" → "}
              </span>
            )}
            <span className="rounded bg-foreground/5 px-1.5">
              {label}{" "}
              {marks.map((mark, at) => (
                <span key={at} className={MARK_GLYPHS[mark].tone}>
                  {MARK_GLYPHS[mark].glyph}
                </span>
              ))}
            </span>
          </Fragment>
        ))}
    </span>
  );
}

const OUTCOMES: Record<Attempt["outcome"], { text: string; tone: string }> = {
  merged: { text: "Merged", tone: "bg-success/15 text-success-foreground" },
  in_progress: { text: "In progress", tone: "bg-timeline-accent/15 text-timeline-accent" },
  blocked: { text: "Blocked", tone: "bg-destructive-text/15 text-destructive-text" },
  cancelled: { text: "Cancelled", tone: "bg-muted-foreground/15 text-muted-foreground" },
  ended: { text: "Ended", tone: "bg-muted-foreground/15 text-muted-foreground" },
};

function Pulse() {
  return <span aria-hidden className="inline-block size-2 shrink-0 animate-pulse rounded-full bg-timeline-accent" />;
}

/** What the newest attempt is doing now. Checking needs none: the running check card shows it. */
function LiveRow({ ctx, attempt }: { ctx: StreamCtx; attempt: Attempt }) {
  const navigate = useBbNavigate();
  const { ticket, now } = ctx;
  const reviewer = ticket.threads.filter((thread) => thread.role === "reviewer" && thread.state !== "ended" && thread.threadId !== null && thread.reviewRound === ticket.reviewRound).at(-1);
  const row = (live: boolean, text: ReactNode, action?: ReactNode) => (
    <div data-live-row className={`flex flex-wrap items-center gap-2 py-1 text-xs ${live ? "text-timeline-accent" : "text-muted-foreground"}`}>
      {live && <Pulse />}
      <span className="font-semibold">{text}</span>
      {action}
    </div>
  );
  const pr = ticket.pr;
  const worker = ticket.threads.filter((thread) => thread.role === "worker" && thread.state !== "ended" && thread.threadId !== null).at(-1);
  const openWorker =
    worker === undefined ? undefined : (
      <button type="button" onClick={() => navigate.toThread(worker.threadId!)} className={GHOST}>
        <span aria-hidden>↗</span> Open the worker thread
      </button>
    );
  const fixing = pr !== null && pr.pushedSha !== null;
  switch (ticket.state) {
    case "working":
      return fixing ? row(true, `The worker is fixing fix round ${pr.rounds} of the pull request · for ${formatDuration(now - ticket.stateAt)}`, openWorker) : row(true, `The worker is working · for ${formatDuration(now - attempt.startedAt)}`);
    case "review":
      return reviewer === undefined
        ? row(false, "Waiting for a reviewer")
        : row(
            true,
            `Reviewer round ${ticket.reviewRound} is reviewing · for ${formatDuration(now - reviewer.startedAt)}`,
            <button type="button" onClick={() => navigate.toThread(reviewer.threadId!)} className={GHOST}>
              <span aria-hidden>↗</span> Open the reviewer thread
            </button>,
          );
    case "approved":
      if (pr?.writing != null) return row(true, `${pr.writing.fix ? `The worker is writing the commit message for fix round ${pr.rounds}` : "The worker is writing the pull request"} · for ${formatDuration(now - pr.writing.since)}`, openWorker);
      return row(false, pr === null ? "Approved; waiting for its turn to merge" : fixing ? "Approved; waiting for its turn to push the fix" : "Approved; waiting for its turn to open its pull request");
    case "merging":
      return row(true, pr === null ? "Loom is merging" : fixing ? `Loom is pushing fix round ${pr.rounds}` : "Loom is opening the pull request");
    case "pr_open": {
      const open =
        ticket.prUrl === null ? undefined : (
          <button type="button" onClick={() => navigate.openUrl(ticket.prUrl!)} className={GHOST}>
            Open the pull request ↗
          </button>
        );
      if (pr?.forge === "none") return row(false, "Loom pushed the branch; the ticket is done when the remote's base branch contains it");
      if (pr === null || !pr.follows) return row(false, "The pull request is open; Loom checks every 5 minutes whether it merged", open);
      const next = pr.nextCheckAt === null ? "" : ` · next check ${pr.nextCheckAt <= now ? "now" : `in ${formatDuration(pr.nextCheckAt - now)}`}`;
      return row(true, `Loom is following the pull request: ${pr.checks === null ? "waiting for its checks" : `checks ${checksText(pr.checks)}`}${next}`, open);
    }
    default:
      return null;
  }
}

function AttemptCard({ ctx, attempt, newest, open, onToggle, openFailed }: { ctx: StreamCtx; attempt: Attempt; newest: boolean; open: boolean; onToggle(): void; openFailed: ChecksItem | null }) {
  const navigate = useBbNavigate();
  const outcome = OUTCOMES[attempt.outcome];
  const unstarted = attempt.threadId === null && attempt.endedAt !== null;
  return (
    <section data-attempt={attempt.n} data-open={open ? "true" : "false"} className="rounded-lg border border-border-seam bg-card">
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <Icon name="ChevronRight" aria-hidden className={`size-3.5 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="text-[13.5px] font-semibold">Attempt {attempt.n}</span>
        <Pipeline pipeline={attempt.pipeline} />
        <span className={`rounded-full px-2 text-xs font-semibold ${outcome.tone}`}>{outcome.text}</span>
        <span className="flex-1" />
        <span data-attempt-time className="text-xs text-muted-foreground">
          {attempt.threadId === null && attempt.endedAt !== null ? ago(attempt.startedAt, ctx.now) : `${formatDuration((attempt.endedAt ?? ctx.now) - attempt.startedAt)} · ${ago(attempt.startedAt, ctx.now)}`}
        </span>
        {!open && attempt.line !== null && (
          <span data-attempt-line className="basis-full pl-5 text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {attempt.line}
          </span>
        )}
      </button>
      {open && (
        <div className="ml-5 space-y-2 border-l border-border-seam pb-3 pl-3 pr-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1 text-xs text-muted-foreground">
            <span aria-hidden>▷</span>
            <Avatar kind="worker" />
            <span className="font-semibold text-foreground">Worker attempt {attempt.n} {unstarted ? "could not start" : "started"}</span>
            <span className="text-subtle-foreground">{ago(attempt.startedAt, ctx.now)}</span>
            {attempt.threadId !== null && (
              <button type="button" aria-label={`Open the thread of attempt ${attempt.n}`} onClick={() => navigate.toThread(attempt.threadId!)} className={GHOST}>
                ↗ Thread
              </button>
            )}
          </div>
          {attempt.items.map((item, index) => (
            <Item key={`${item.type}-${item.postId ?? `at-${index}`}`} ctx={ctx} item={item} openFailed={openFailed} />
          ))}
          {newest && <LiveRow ctx={ctx} attempt={attempt} />}
        </div>
      )}
    </section>
  );
}

/** The brief and what was posted before the first attempt. */
function Planning({ ctx }: { ctx: StreamCtx }) {
  const { brief, before } = ctx.ticket.activity;
  const post = brief === null ? undefined : ctx.ticket.posts.find((candidate) => candidate.id === brief.postId);
  if (post === undefined && before.length === 0) return null;
  return (
    <section data-planning className="space-y-2 rounded-lg border border-dashed border-border-seam p-3">
      {brief !== null && post !== undefined && (
        <article data-post={post.id} style={{ marginLeft: "0px" }}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <Avatar kind="planner" />
            <span className="font-semibold text-foreground">The planner wrote the brief</span>
            <span>
              {ago(post.at, ctx.now)}
              {brief.edits > 0 && `, edited ${plural(brief.edits, "time")} since (${brief.fields.join(", ")})`}
            </span>
            <span className="flex-1" />
            <button type="button" onClick={ctx.onBrief} className={BUTTON}>
              Read the brief
            </button>
            <ReplyButton ctx={ctx} postId={post.id} />
          </div>
          <Composer ctx={ctx} postId={post.id} />
          <div className="mt-2">
            <Replies ctx={ctx} postId={post.id} />
          </div>
        </article>
      )}
      {before.map((item, index) => (
        <Item key={`${item.type}-${item.postId ?? `at-${index}`}`} ctx={ctx} item={item} openFailed={null} />
      ))}
    </section>
  );
}

const holds = (attempt: Attempt, postId: number) => attempt.items.some((item) => item.postId === postId || (item.type === "review" && item.notePostIds.includes(postId)));

/** Every attempt as a card, newest first by default, with the planning group after them; the newest attempt starts open. */
export function Stream({ ticket, now, busy, onReply, onBrief, jumpTo }: { ticket: TicketDetail; now: number; busy: boolean; onReply(body: string, parentId?: number): Promise<boolean>; onBrief(): void; jumpTo: { postId: number; seq: number } | null }) {
  const navigate = useBbNavigate();
  const root = useRef<HTMLDivElement>(null);
  const [order, setOrder] = useState<"newest" | "oldest">("newest");
  const [opened, setOpened] = useState<Record<number, boolean>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const [composer, setComposer] = useState<number | null>(null);
  const [scrollTo, setScrollTo] = useState<{ postId: number; seq: number } | null>(null);
  const { attempts } = ticket.activity;
  const newest = attempts.at(-1);

  useEffect(() => {
    if (jumpTo === null) return;
    const holder = attempts.find((attempt) => holds(attempt, jumpTo.postId));
    if (holder !== undefined) setOpened((before) => ({ ...before, [holder.claimPostId]: true }));
    setScrollTo(jumpTo);
    // Only a new jump moves the page; a refresh of the ticket does not.
  }, [jumpTo]);
  useEffect(() => {
    if (scrollTo !== null) root.current?.querySelector(`[data-post="${scrollTo.postId}"]`)?.scrollIntoView({ block: "center" });
  }, [scrollTo]);

  const ctx: StreamCtx = {
    ticket,
    now,
    busy,
    composer,
    expanded,
    toggleComposer: (postId) => setComposer((open) => (open === postId ? null : postId)),
    toggleExpanded: (postId) =>
      setExpanded((before) => {
        const next = new Set(before);
        if (!next.delete(postId)) next.add(postId);
        return next;
      }),
    send: async (postId, body) => {
      const sent = await onReply(body, postId);
      if (sent) setComposer(null);
      return sent;
    },
    onBrief,
    openThread: (threadId) => navigate.toThread(threadId),
    openUrl: (url) => navigate.openUrl(url),
  };
  const failedChecks = attempts.flatMap((attempt) => attempt.items.filter((item): item is ChecksItem => item.type === "checks" && item.status === "failed"));
  const openFailed = failedChecks.at(-1) ?? null;
  const isOpen = (attempt: Attempt) => opened[attempt.claimPostId] ?? attempt === newest;
  const shown = order === "newest" ? [...attempts].reverse() : attempts;
  const planning = <Planning ctx={ctx} />;
  const pressed = (mine: "newest" | "oldest") => `${GHOST} ${order === mine ? "bg-surface-selected text-foreground" : ""}`;

  return (
    <div ref={root} className="space-y-3">
      <div data-stream-toolbar className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{attempts.length === 0 ? "No attempts yet" : `${plural(attempts.length, "attempt")} · ${plural(ticket.posts.length, "post")}`}</span>
        <span className="flex-1" />
        {attempts.length > 0 && (
          <>
            <span className="inline-flex rounded-md border border-border-seam p-0.5">
              <button type="button" aria-pressed={order === "newest"} onClick={() => setOrder("newest")} className={pressed("newest")}>
                Newest first
              </button>
              <button type="button" aria-pressed={order === "oldest"} onClick={() => setOrder("oldest")} className={pressed("oldest")}>
                Oldest first
              </button>
            </span>
            <button type="button" onClick={() => setOpened(Object.fromEntries(attempts.map((attempt) => [attempt.claimPostId, true])))} className={GHOST}>
              Expand all
            </button>
          </>
        )}
      </div>
      {order === "oldest" && planning}
      {shown.map((attempt) => (
        <AttemptCard
          key={attempt.claimPostId}
          ctx={ctx}
          attempt={attempt}
          newest={attempt === newest}
          open={isOpen(attempt)}
          onToggle={() => setOpened((before) => ({ ...before, [attempt.claimPostId]: !isOpen(attempt) }))}
          openFailed={openFailed}
        />
      ))}
      {order === "newest" && planning}
    </div>
  );
}
