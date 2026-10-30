import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { experimental_Icon as Icon, Markdown, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { ConversationItem, HunkLine, PrView } from "../contract";
import { nudgeText, useActions } from "./actions";
import { Avatar } from "./avatar";
import { BUTTON, BUTTON_GHOST, BUTTON_PRIMARY, PaneSection, Pill, Segmented } from "./common";
import { openExternal, undoToast, useShuttleMutation } from "./data";
import { age, ago, plural, tinyKey } from "./format";
import { isLive } from "./pills";
import { conversationOrder, hideBotComments, type ConversationOrder } from "./prefs";
import { useStored } from "./remember";
import { usePrState } from "./pr-state";
import { isFeedback, Tag, tagOf } from "./tags";
import { VERDICT_OPTIONS } from "./your-review";

/** One review thread: its comments oldest first, where it is, and the code it is about. */
export interface ThreadGroup {
  key: string;
  thread: string | null;
  path: string | null;
  line: number | null;
  resolved: boolean;
  hunk: HunkLine[] | null;
  comments: ConversationItem[];
  /** When it started and when it last moved. */
  first: number;
  last: number;
}

export function threadsOf(items: readonly ConversationItem[]): ThreadGroup[] {
  const groups = new Map<string, ThreadGroup>();
  for (const item of items) {
    if (item.kind !== "thread") continue;
    const key = item.thread ?? item.id;
    const group = groups.get(key) ?? { key, thread: item.thread, path: item.path, line: item.line, resolved: item.resolved, hunk: null, comments: [], first: 0, last: 0 };
    group.comments.push(item);
    group.hunk ??= item.hunk;
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const comments = [...group.comments].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    return { ...group, comments, first: comments[0]?.at ?? 0, last: comments.at(-1)?.at ?? 0 };
  });
}

const fileName = (path: string | null) => (path === null ? "the PR" : path.split("/").at(-1) ?? path);
const whoOf = (item: ConversationItem) => (item.mine ? "You" : item.author ?? "Someone");
const isNew = (item: ConversationItem, since: number | null) => since !== null && !item.mine && item.at !== null && item.at > since;

function NewMark({ item, since }: { item: ConversationItem; since: number | null }) {
  return isNew(item, since) ? <Pill tone="info">New</Pill> : null;
}

function Time({ at }: { at: number | null }) {
  if (at === null) return null;
  return <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()} className="text-[11.5px] text-muted-foreground">{ago(at)}</time>;
}

function Hunk({ lines }: { lines: readonly HunkLine[] }) {
  return (
    <pre data-hunk className="m-0 overflow-x-auto border-b border-border py-1 font-mono text-[11.5px] leading-[1.6]">
      {lines.map((line, index) => (
        <div key={index} className={`w-max min-w-full whitespace-pre px-3 ${line.kind === "add" ? "bg-diff-added/10" : line.kind === "del" ? "bg-diff-removed/10" : ""} ${index === lines.length - 1 ? "shadow-[inset_3px_0_0_var(--primary)]" : ""}`}>
          <span className="mr-2.5 inline-block w-7 select-none text-right text-muted-foreground">{line.line ?? ""}</span>
          <span className="select-none text-muted-foreground">{line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}</span>
          {line.text}
        </div>
      ))}
    </pre>
  );
}

function ReplyBox({ pr, thread, to, autoFocus, onClose }: { pr: PrView; thread: string; to: string; autoFocus: boolean; onClose(): void }) {
  const [text, setText] = usePrState(pr.key, "replyText", "", `reply/${thread}`);
  const reply = useShuttleMutation("reply");
  const send = async () => {
    const body = text.trim();
    if (body === "") return;
    if ((await reply.run({ key: pr.key, thread, body })) === null) return;
    toast.success(`Replied on ${pr.serverName}.`);
    setText("");
    onClose();
  };
  return (
    <div className="mx-3 mb-2.5 rounded-lg border border-ring bg-background">
      <textarea aria-label={`Reply to ${to}`} autoFocus={autoFocus} rows={2} value={text} placeholder={`Reply to ${to}…`}
        onChange={(event) => setText(event.target.value)} className="block w-full resize-y bg-transparent px-2.5 py-2 text-sm outline-none" />
      <div className="flex items-center gap-1.5 border-t border-border px-2 py-1.5">
        <span className="flex-1 text-xs text-muted-foreground">Replies on {pr.serverName} as you</span>
        <button type="button" className={BUTTON_GHOST} onClick={() => { setText(""); onClose(); }}>Cancel</button>
        <button type="button" className={BUTTON_PRIMARY} disabled={reply.isPending || text.trim() === ""} onClick={() => void send()}>Reply</button>
      </div>
    </div>
  );
}

function Comment({ pr, item, since }: { pr: PrView; item: ConversationItem; since: number | null }) {
  const tag = tagOf(pr, item);
  return (
    <li data-item={item.id} className="flex gap-2.5 border-t border-border px-3 py-2.5 first:border-t-0">
      <Avatar login={item.author ?? "?"} bot={item.bot} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <b className="text-[13px]">{whoOf(item)}</b>
          <Time at={item.at} />
          <NewMark item={item} since={since} />
          {tag !== null && <Tag tag={tag} />}
        </div>
        <div className="mt-0.5 min-w-0 break-words text-[13px]"><Markdown content={item.body} /></div>
        {item.outcome?.note && <div className="mt-1 flex items-start gap-1.5 rounded-md bg-success/10 px-2 py-1 text-xs text-success"><Icon name="Bot" className="mt-0.5 size-3 shrink-0" aria-hidden />{item.outcome.note}</div>}
      </div>
    </li>
  );
}

/** A review thread on a line: the code, every comment, and Reply, Resolve and Send to an agent where they apply. */
function ThreadCard({ pr, group, since, onResolve }: { pr: PrView; group: ThreadGroup; since: number | null; onResolve(group: ThreadGroup): void }) {
  const actions = useActions();
  const navigate = useBbNavigate();
  const [replying, setReplying] = usePrState(pr.key, "replyOpen", false, `reply/${group.key}`);
  const focusReply = useRef(false);
  const live = isLive(pr);
  const canReply = live && group.thread !== null && pr.can.reply;
  const canResolve = live && group.thread !== null && pr.can.resolve;
  const canSend = live && pr.mine && pr.agent === null && group.comments.some(isFeedback);
  const url = group.comments[0]?.url ?? null;
  const starter = group.comments[0];
  return (
    <article data-thread={group.key} className="mb-2.5 scroll-mt-28 overflow-hidden rounded-lg border border-border bg-card">
      <header className="flex min-w-0 items-center gap-1.5 border-b border-border bg-surface-recessed px-3 py-1.5 text-xs">
        <Icon name="File" fallback="FileText" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate font-mono text-[11.5px]" title={group.path ?? undefined}>{group.path ?? "Whole PR"}</span>
        {group.line !== null && <span className="shrink-0 text-muted-foreground">line {group.line}</span>}
        <span className="flex-1" />
        {group.resolved && <Pill tone="ok" icon="Check">Resolved</Pill>}
      </header>
      {group.hunk !== null && <Hunk lines={group.hunk} />}
      <ul>{group.comments.map((item) => <Comment key={item.id} pr={pr} item={item} since={since} />)}</ul>
      {replying && group.thread !== null && <ReplyBox pr={pr} thread={group.thread} to={starter?.author ?? "the thread"} autoFocus={focusReply.current} onClose={() => setReplying(false)} />}
      {(canReply || canResolve || canSend || url !== null) && (
        <footer className="flex flex-wrap items-center gap-1.5 border-t border-border px-2.5 py-1.5">
          {canReply && !replying && (
            <button type="button" className={BUTTON} onClick={() => { focusReply.current = true; setReplying(true); }}>
              <Icon name="Reply" fallback="MessageSquare" className="size-3.5" aria-hidden />Reply
            </button>
          )}
          {canResolve && (
            <button type="button" className={BUTTON} onClick={() => onResolve(group)}>
              <Icon name={group.resolved ? "RotateCcw" : "Check"} className="size-3.5" aria-hidden />{group.resolved ? "Reopen" : "Resolve"}
            </button>
          )}
          {canSend && (
            <button type="button" className={BUTTON} onClick={() => actions.pickAgent(pr)}>
              <Icon name="Bot" className="size-3.5" aria-hidden />Send to an agent
            </button>
          )}
          <span className="flex-1" />
          {url !== null && (
            <button type="button" className={BUTTON_GHOST} onClick={() => openExternal(navigate, url)}>
              View on {pr.serverName}<Icon name="ExternalLink" className="size-3" aria-hidden />
            </button>
          )}
        </footer>
      )}
    </article>
  );
}

function verdictOf(item: ConversationItem): { text: string; className: string; edge: string } {
  const state = (item.state ?? "").toLowerCase();
  if (state.includes("approv")) return { text: "approved", className: "text-success", edge: "border-l-[3px] border-l-success" };
  if (state.includes("change")) return { text: "requested changes", className: "text-destructive-text", edge: "border-l-[3px] border-l-destructive" };
  if (state.includes("dismiss")) return { text: "had a review dismissed", className: "text-muted-foreground", edge: "" };
  return { text: "reviewed", className: "text-muted-foreground", edge: "" };
}

function Review({ pr, item, threads, since, onJump }: { pr: PrView; item: ConversationItem; threads: readonly ThreadGroup[]; since: number | null; onJump(key: string): void }) {
  const verdict = verdictOf(item);
  const tag = tagOf(pr, item);
  const mine = threads.filter((group) => item.review !== null && group.comments.some((comment) => comment.review === item.review));
  const open = mine.filter((group) => !group.resolved).length;
  return (
    <li data-item={item.id} className="flex gap-2.5">
      <Avatar login={item.author ?? "?"} bot={item.bot} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5 text-xs leading-[22px]">
          <b className="text-[13px]">{whoOf(item)}</b>
          <span className={verdict.className}>{verdict.text}</span>
          <Time at={item.at} />
          <NewMark item={item} since={since} />
          {tag !== null && <Tag tag={tag} />}
        </div>
        {(item.body.trim() !== "" || mine.length > 0) && (
          <div className={`mt-1 rounded-lg border border-border bg-card px-3 py-2 ${verdict.edge}`}>
            {item.body.trim() !== "" && <div className="min-w-0 break-words text-[13px]"><Markdown content={item.body} /></div>}
            {mine.length > 0 && (
              <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground ${item.body.trim() !== "" ? "mt-2 border-t border-border pt-2" : ""}`}>
                <span className="inline-flex items-center gap-1"><Icon name="MessageSquare" className="size-3" aria-hidden />
                  {plural(mine.length, "comment")} on lines{open === 0 ? ", resolved" : open === mine.length ? (mine.length === 1 ? ", still open" : mine.length === 2 ? ", both still open" : ", all still open") : `, ${open} still open`}:</span>
                {mine.map((group) => (
                  <button key={group.key} type="button" className="cursor-pointer font-mono text-[11.5px] text-primary hover:underline" onClick={() => onJump(group.key)}>
                    {fileName(group.path)}{group.line !== null && `:${group.line}`}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function PlainComment({ pr, item, since }: { pr: PrView; item: ConversationItem; since: number | null }) {
  const [open, setOpen] = usePrState(pr.key, "open", false, `bot/${item.id}`);
  const tag = tagOf(pr, item);
  if (item.bot && !open) {
    return (
      <li data-item={item.id} className="flex items-center gap-2.5">
        <Avatar login={item.author ?? "bot"} bot />
        <button type="button" aria-expanded={false} className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen(true)}>
          <b className="shrink-0 text-foreground">{item.author ?? "A bot"}</b>
          <span className="min-w-0 flex-1 truncate">{item.body.replace(/\s+/gu, " ").slice(0, 200)}</span>
          {item.at !== null && <span className="shrink-0">{age(item.at)}</span>}
        </button>
      </li>
    );
  }
  return (
    <li data-item={item.id} className="flex gap-2.5">
      <Avatar login={item.author ?? "?"} bot={item.bot} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5 text-xs leading-[22px]">
          <b className="text-[13px]">{whoOf(item)}</b>
          <span className="text-muted-foreground">commented</span>
          <Time at={item.at} />
          <NewMark item={item} since={since} />
          {tag !== null && <Tag tag={tag} />}
          {item.bot && <button type="button" className="cursor-pointer text-muted-foreground hover:text-foreground" onClick={() => setOpen(false)}>Fold</button>}
        </div>
        <div className="mt-1 min-w-0 break-words rounded-lg border border-border bg-card px-3 py-2 text-[13px]"><Markdown content={item.body} /></div>
      </div>
    </li>
  );
}

/** A resolved thread in the timeline: one line until opened. */
function ResolvedThread({ pr, group, since, forced, onResolve, onFold }: { pr: PrView; group: ThreadGroup; since: number | null; forced: boolean; onResolve(group: ThreadGroup): void; onFold(): void }) {
  const [open, setOpen] = usePrState(pr.key, "open", false, `thread/${group.key}`);
  const people = [...new Set(group.comments.map((item) => (item.mine ? "you" : item.author ?? "someone")))];
  if (open || forced) {
    return (
      <li className="min-w-0">
        <ThreadCard pr={pr} group={group} since={since} onResolve={onResolve} />
        <button type="button" className="-mt-1 mb-1 cursor-pointer text-xs text-muted-foreground hover:text-foreground" onClick={() => { setOpen(false); onFold(); }}>Fold it</button>
      </li>
    );
  }
  return (
    <li data-thread={group.key} className="flex items-center gap-2.5">
      <span className="inline-flex w-[22px] shrink-0 justify-center text-success"><Icon name="CircleCheck" fallback="Check" className="size-4" aria-hidden /></span>
      <button type="button" aria-expanded={false} onClick={() => setOpen(true)}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground">
        <span className="min-w-0 flex-1 truncate">
          Resolved: <span className="font-mono">{fileName(group.path)}{group.line !== null && `:${group.line}`}</span> · {people.join(", ")} · {plural(group.comments.length, "comment")}
        </span>
        {group.last > 0 && <span className="shrink-0">{age(group.last)}</span>}
        <Icon name="ChevronRight" className="size-3.5 shrink-0" aria-hidden />
      </button>
    </li>
  );
}

type Entry = { kind: "item"; at: number; item: ConversationItem } | { kind: "resolved"; at: number; group: ThreadGroup };

const ORDER_LABEL: Record<ConversationOrder, string> = { newest: "Newest first", oldest: "Oldest first" };

/**
 * The PR's people talking: open review threads first, with the code they are about, then the reviews,
 * comments and resolved threads in one timeline, newest first unless flipped. Failed checks have their own tab.
 */
export function Conversation({ pr, items, error, phone, since }: { pr: PrView; items: readonly ConversationItem[] | undefined; error: string | null; phone: boolean; since: number | null }) {
  const order = useStored(conversationOrder);
  const hideBots = useStored(hideBotComments);
  const [jump, setJump] = useState<{ key: string; at: number } | null>(null);
  const jumped = jump?.key ?? null;
  const root = useRef<HTMLDivElement>(null);
  const resolve = useShuttleMutation("resolve", ({ key, thread, resolved }, cache) =>
    cache.update("conversation", { key }, (current) => ({ ...current, items: current.items.map((item) => (item.thread === thread ? { ...item, resolved } : item)) })));
  const toggle = async (group: ThreadGroup, undoable = true) => {
    if (group.thread === null) return;
    const resolved = !group.resolved;
    if ((await resolve.run({ key: pr.key, thread: group.thread, resolved })) === null) return;
    const message = resolved ? "Resolved the conversation." : "Reopened the conversation.";
    if (undoable) undoToast(message, () => void toggle({ ...group, resolved }, false));
    else toast.success(message);
  };
  useEffect(() => {
    if (jump === null) return;
    const target = [...(root.current?.querySelectorAll<HTMLElement>("article[data-thread]") ?? [])].find((node) => node.dataset.thread === jump.key);
    target?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, [jump]);

  const spoken = (items ?? []).filter((item) => item.kind !== "check");
  const threads = threadsOf(spoken);
  const newest = (a: number, b: number) => (order === "newest" ? b - a : a - b);
  const open = threads.filter((group) => !group.resolved).sort((a, b) => newest(a.last, b.last));
  const bots = spoken.filter((item) => item.bot && item.kind !== "thread").length;
  const entries: Entry[] = [
    ...spoken.filter((item) => item.kind !== "thread" && !(hideBots && item.bot)).map((item): Entry => ({ kind: "item", at: item.at ?? 0, item })),
    // A resolved thread sits where its last comment does, which is the time its line shows.
    ...threads.filter((group) => group.resolved).map((group): Entry => ({ kind: "resolved", at: group.last, group })),
  ].sort((a, b) => newest(a.at, b.at));
  const people = new Set(spoken.filter((item) => !item.bot).flatMap((item) => (item.mine ? ["you"] : item.author ? [item.author] : [])));
  const fresh = spoken.filter((item) => isNew(item, since)).length;
  const composer = isLive(pr) && !phone ? <Composer pr={pr} /> : null;

  return (
    <div ref={root} data-conversation>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {items !== undefined && <span>{plural(spoken.length, "comment")}{people.size > 0 && ` from ${plural(people.size, "person", "people")}`}</span>}
        {fresh > 0 && <Pill tone="info">{fresh} new since you looked</Pill>}
        <span className="flex-1" />
        {bots > 0 && (
          <label className="inline-flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={hideBots} onChange={(event) => hideBotComments.set(event.target.checked)} className="size-3.5 cursor-pointer accent-foreground" />
            Hide bots ({bots})
          </label>
        )}
        <button type="button" className={BUTTON_GHOST} aria-label={order === "newest" ? "Newest first: show oldest first" : "Oldest first: show newest first"} title="Flip the order"
          onClick={() => conversationOrder.set(order === "newest" ? "oldest" : "newest")}>
          <Icon name="ArrowUpDown" fallback="Sort" className="size-3.5" aria-hidden />{ORDER_LABEL[order]}
        </button>
      </div>
      {error !== null && <div className="mb-2 text-xs text-muted-foreground">{error}</div>}
      {items === undefined && error === null && <div className="text-sm text-muted-foreground">Loading the conversation…</div>}
      {order === "newest" && composer !== null && <div className="mb-5">{composer}</div>}
      {open.length > 0 && (
        <PaneSection title="Open threads" className="mb-5" count={<Pill tone="warn">{open.length}</Pill>} aside={pr.mine && pr.agent !== null && pr.agent.mode !== "off" ? <span className="text-xs text-muted-foreground">New ones go to the agent</span> : undefined}>
          {open.map((group) => <ThreadCard key={group.key} pr={pr} group={group} since={since} onResolve={(target) => void toggle(target)} />)}
        </PaneSection>
      )}
      {entries.length > 0 && (
        <PaneSection title="Timeline" className="mb-5">
          <ul className="flex flex-col gap-3">
            {entries.map((entry) => entry.kind === "resolved"
              ? <ResolvedThread key={entry.group.key} pr={pr} group={entry.group} since={since} forced={jumped === entry.group.key} onResolve={(target) => void toggle(target)} onFold={() => setJump((current) => (current?.key === entry.group.key ? null : current))} />
              : entry.item.kind === "review"
                ? <Review key={entry.item.id} pr={pr} item={entry.item} threads={threads} since={since} onJump={(key) => setJump({ key, at: Date.now() })} />
                : <PlainComment key={entry.item.id} pr={pr} item={entry.item} since={since} />)}
          </ul>
        </PaneSection>
      )}
      {items !== undefined && spoken.length === 0 && <div className="mb-3 text-sm text-muted-foreground">No reviews or comments yet.</div>}
      {order === "oldest" && composer !== null && <div className="mt-2">{composer}</div>}
    </div>
  );
}

/**
 * A comment on the PR as you; on someone else's PR also Approve or Request changes, and on yours
 * "Ask the agent", which sends the text to its thread instead. Only what the server allows shows.
 */
export function Composer({ pr, onDone, autoFocus = false, initialText = "" }: { pr: PrView; onDone?: () => void; autoFocus?: boolean; initialText?: string }) {
  const { intent, done } = useActions();
  const options = pr.mine ? [] : VERDICT_OPTIONS.filter((option) => (option.value === "comment" ? pr.can.comment : pr.can.review));
  const [text, setText] = usePrState(pr.key, "comment", initialText);
  const [verdict, setVerdict] = usePrState(pr.key, "verdict", options[0]?.value ?? "comment");
  const box = useRef<HTMLTextAreaElement>(null);
  const comment = useShuttleMutation("comment");
  const submit = useShuttleMutation("submitReview");
  const ask = useShuttleMutation("askAgent");
  const busy = comment.isPending || submit.isPending || ask.isPending;

  useEffect(() => {
    if (initialText !== "") setText(initialText);
  }, [pr.key, initialText, setText]);

  useEffect(() => {
    if (intent?.kind !== "compose" || intent.key !== pr.key) return;
    if (intent.nudge) setText(nudgeText(pr));
    else if (intent.text !== undefined) setText(intent.text);
    box.current?.focus();
    box.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    done(intent);
  }, [intent, done, pr]);

  const canPost = pr.mine ? pr.can.comment : options.length > 0;
  if (!canPost && pr.agent === null) return null;
  const body = text.trim();

  const send = async () => {
    if (body === "") return;
    if (pr.mine || verdict === "comment") {
      if ((await comment.run({ key: pr.key, body })) === null) return;
      toast.success(`Commented on ${tinyKey(pr)}.`);
    } else {
      if ((await submit.run({ key: pr.key, verdict, body, findings: [] })) === null) return;
      toast.success(`Posted your review of ${tinyKey(pr)} on ${pr.serverName}: ${verdict === "approve" ? "approved" : "changes requested"}.`);
    }
    setText("");
    onDone?.();
  };
  const askAgent = async () => {
    if (body === "" || pr.agent === null) return;
    if ((await ask.run({ key: pr.key, text: body })) === null) return;
    toast.success(`Sent to “${pr.agent.title}”. Nothing was posted on the PR.`);
    setText("");
    onDone?.();
  };

  const label = pr.mine || verdict === "comment" ? "Comment" : verdict === "approve" ? "Approve" : "Request changes";
  return (
    <div data-composer className="rounded-lg border border-input bg-background focus-within:border-ring">
      <textarea ref={box} aria-label={`Comment on ${tinyKey(pr)}`} autoFocus={autoFocus} rows={3} value={text} placeholder={`Comment on ${tinyKey(pr)}… Markdown works`}
        onChange={(event) => setText(event.target.value)} className="block min-h-16 w-full resize-y bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground" />
      <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-2 py-1.5">
        {options.length > 1 && <div className="shrink-0"><Segmented label="Post as" value={verdict} options={options} onChange={setVerdict} /></div>}
        <span className="flex-1 text-xs text-muted-foreground">{options.length > 1 ? "" : `Posts on ${pr.serverName} as you`}</span>
        {pr.mine && pr.agent !== null && (
          <button type="button" className={BUTTON_GHOST} disabled={busy || body === ""} title="Send it to the agent's thread instead of the PR" onClick={() => void askAgent()}>
            <Icon name="Bot" className="size-3.5" aria-hidden />Ask the agent
          </button>
        )}
        {canPost && (
          <button type="button" className={BUTTON_PRIMARY} disabled={busy || body === ""} onClick={() => void send()}>
            <Icon name="Sent" className="size-3.5" aria-hidden />{label}
          </button>
        )}
      </div>
    </div>
  );
}
