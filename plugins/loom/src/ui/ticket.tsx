import { useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { PostDto, ReviewDto, rpcContract, TicketAction, TicketDetail } from "../contract";
import { formatDuration } from "../format";
import { BUTTON, ConfirmButton, FIELD, HEADING, StateBadge, useRemote, useRun } from "./common";

const INDENT_PX = 16;
const MAX_DEPTH = 6;
const LINK = "cursor-pointer rounded text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function ReplyBox({ textLabel, sendLabel, busy, onSend, onCancel }: { textLabel: string; sendLabel: string; busy: boolean; onSend(body: string): Promise<boolean>; onCancel?(): void }) {
  const [text, setText] = useState("");
  return (
    <div className="mt-2 space-y-2">
      <textarea aria-label={textLabel} value={text} rows={3} onChange={(event) => setText(event.target.value)} className={FIELD} />
      <div className="flex gap-2">
        <button
          type="button"
          aria-label={sendLabel}
          disabled={busy || text.trim() === ""}
          onClick={() => void onSend(text.trim()).then((sent) => sent && setText(""))}
          className={BUTTON}
        >
          Send reply
        </button>
        {onCancel !== undefined && (
          <button type="button" onClick={onCancel} className={BUTTON}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

function Post({ post, open, busy, onToggle, onSend }: { post: PostDto; open: boolean; busy: boolean; onToggle(): void; onSend(body: string): Promise<boolean> }) {
  return (
    <article data-post={post.id} style={{ marginLeft: `${Math.min(post.depth, MAX_DEPTH) * INDENT_PX}px` }} className="border-l border-border-seam py-2 pl-3">
      <header className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{post.authorKind}</span>
        <span>{post.kind}</span>
        <span>{formatDuration(Math.max(0, Date.now() - post.at))} ago</span>
        <span>#{post.id}</span>
      </header>
      <div data-post-body className="mt-1 whitespace-pre-wrap break-words text-sm">{post.body}</div>
      <button type="button" aria-label={`Reply to #${post.id}`} onClick={onToggle} className={`${LINK} mt-1`}>
        Reply
      </button>
      {open && <ReplyBox textLabel={`Reply text for #${post.id}`} sendLabel={`Send reply to #${post.id}`} busy={busy} onSend={onSend} onCancel={onToggle} />}
    </article>
  );
}

function Reviews({ reviews }: { reviews: ReviewDto[] }) {
  if (reviews.length === 0) return null;
  return (
    <section data-reviews className="space-y-2">
      <h2 className={HEADING}>Reviews</h2>
      {reviews.map((review) => (
        <div key={review.id} className="text-sm">
          <p>
            <span className="font-medium">Round {review.round}</span> · {review.verdict.replace("_", " ")}
            {review.summary !== null && <span className="text-muted-foreground"> — {review.summary}</span>}
          </p>
          {review.findings.length > 0 && (
            <ul className="ml-4 list-disc text-xs text-muted-foreground">
              {review.findings.map((finding, index) => (
                <li key={index}>
                  {finding.severity}: {finding.title}
                  {finding.file !== undefined && ` (${finding.file}${finding.line === undefined ? "" : `:${finding.line}`})`}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}

export function TicketView({ slug, ticketKey }: { slug: string; ticketKey: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const remote = useRemote((client) => client.call("ticket", { key: ticketKey }), `ticket:${ticketKey}`, slug);
  const { busy, error, run } = useRun();
  const [note, setNote] = useState("");
  const [replyTo, setReplyTo] = useState<number | null>(null);
  const ticket: TicketDetail | null = remote.data;

  if (ticket === null) {
    return remote.error === null ? <p role="status" className="p-4 text-sm text-muted-foreground">Loading…</p> : <p role="alert" className="p-4 text-sm text-destructive-text">Could not load {ticketKey}: {remote.error}</p>;
  }
  const reply = (body: string, parentId?: number) =>
    run(async () => {
      remote.set(await rpc.call("reply", { key: ticketKey, body, ...(parentId === undefined ? {} : { parentId }), confirm: true }));
      setReplyTo(null);
    });
  const act = (action: TicketAction) =>
    run(async () => {
      remote.set(await rpc.call("ticketAction", { key: ticketKey, action, note: note.trim(), confirm: true }));
      setNote("");
    });

  const final = ticket.state === "done" || ticket.state === "cancelled";
  const live = ticket.threads.filter((thread) => thread.threadId !== null && thread.state !== "ended");
  const meta = [ticket.attempt > 0 ? `attempt ${ticket.attempt}` : null, ticket.reviewRound > 0 ? `review round ${ticket.reviewRound}` : null, ticket.deps.length > 0 ? `after ${ticket.deps.join(", ")}` : null].filter((part) => part !== null);

  return (
    <div data-ticket={ticket.key} className="mx-auto w-full max-w-3xl space-y-5 p-4">
      <header data-ticket-header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-base font-semibold">
            {ticket.key} · {ticket.title}
          </h1>
          <StateBadge state={ticket.state} />
        </div>
        <p className="text-xs text-muted-foreground">{meta.join(" · ")}</p>
        {ticket.branch !== null && <p className="font-mono text-xs text-muted-foreground">{ticket.branch}</p>}
        {ticket.blockedReason !== null && ticket.state === "blocked" && <p className="text-sm text-destructive-text">Blocked: {ticket.blockedReason}</p>}
        <div className="flex flex-wrap gap-3">
          {live.map((thread) => (
            <button key={thread.threadId} type="button" aria-label={`Open ${thread.role} thread`} onClick={() => navigate.toThread(thread.threadId!)} className={LINK}>
              {thread.role} thread
            </button>
          ))}
          {ticket.prUrl !== null && (
            <button type="button" aria-label="Open the pull request" onClick={() => navigate.openUrl(ticket.prUrl!)} className={LINK}>
              Pull request
            </button>
          )}
        </div>
        {ticket.acceptance.length > 0 && (
          <section>
            <h2 className={HEADING}>Acceptance criteria</h2>
            <ol className="ml-5 mt-1 list-decimal space-y-1 text-sm">
              {ticket.acceptance.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ol>
          </section>
        )}
      </header>
      {error !== null && <p role="alert" className="text-xs text-destructive-text">{error}</p>}
      <Reviews reviews={ticket.reviews} />
      <section className="space-y-1">
        <h2 className={HEADING}>Thread</h2>
        {ticket.posts.map((post) => (
          <Post key={post.id} post={post} open={replyTo === post.id} busy={busy} onToggle={() => setReplyTo(replyTo === post.id ? null : post.id)} onSend={(body) => reply(body, post.id)} />
        ))}
        <ReplyBox textLabel="New reply" sendLabel="Send reply" busy={busy} onSend={(body) => reply(body)} />
      </section>
      {!final && (
        <section data-ticket-actions className="space-y-2">
          <h2 className={HEADING}>Steer</h2>
          <textarea aria-label="Note" value={note} rows={2} placeholder={ticket.state === "blocked" ? "Your answer for the next worker (required)" : "Why (required)"} onChange={(event) => setNote(event.target.value)} className={FIELD} />
          <div className="flex flex-wrap gap-2">
            {ticket.state === "blocked" && <ConfirmButton label="Requeue" disabled={busy || note.trim() === ""} onConfirm={() => void act("requeue")} />}
            {ticket.state !== "blocked" && <ConfirmButton label="Block" disabled={busy || note.trim() === ""} onConfirm={() => void act("block")} />}
            <ConfirmButton label="Cancel ticket" danger disabled={busy || note.trim() === ""} onConfirm={() => void act("cancel")} />
          </div>
        </section>
      )}
    </div>
  );
}
