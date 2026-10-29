import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { experimental_Icon as Icon, Markdown, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { ConversationItem, PrView } from "../contract";
import { nudgeText, useActions } from "./actions";
import { BUTTON_GHOST, BUTTON_PRIMARY, SectionTitle, Segmented, type Tone } from "./common";
import { openExternal, undoToast, useShuttleMutation } from "./data";
import { age, checkName, plural, tinyKey } from "./format";
import { isLive } from "./pills";
import { VERDICT_OPTIONS } from "./your-review";
import { usePrState } from "./pr-state";

const TAG_TONES: Record<Tone, string> = {
  neutral: "border-border text-muted-foreground",
  ok: "border-success/40 text-success",
  bad: "border-destructive/40 text-destructive",
  warn: "border-warning/40 text-warning-text",
  info: "border-primary/40 text-primary",
  brand: "border-ring/40 text-foreground",
};

const approval = (item: ConversationItem) => item.kind === "review" && /approv/iu.test(item.state ?? "");
/** Feedback someone else left that still asks for something. */
const isFeedback = (item: ConversationItem) => !item.mine && !item.resolved && !approval(item);

/** What happened to an item on your PR: what the agent did with it, whether it was sent, or that nothing could take it. */
function tagOf(pr: PrView, item: ConversationItem): { tone: Tone; text: string; icon?: string } | null {
  if (!pr.mine) return null;
  const outcome = item.outcome;
  if (outcome !== null) {
    if (outcome.outcome === "fixed") return { tone: "ok", icon: "GitCommit", text: outcome.commit ? `Fixed in ${outcome.commit.slice(0, 7)}` : "Fixed" };
    if (outcome.outcome === "replied") return { tone: "ok", text: "Agent replied" };
    if (outcome.outcome === "declined") return { tone: "neutral", text: "Declined" };
    return { tone: "warn", text: "Agent asks" };
  }
  if (item.delivery === "sent") return { tone: "info", text: "Sent to agent" };
  if (item.delivery === "pending") return { tone: "neutral", text: "Sending soon" };
  if (pr.agent === null && isFeedback(item)) return { tone: "warn", text: "Not sent · no agent" };
  return null;
}

function kindOf(item: ConversationItem): string {
  if (item.kind === "check") return "check failed";
  if (item.kind === "review") return item.state ?? "reviewed";
  return item.resolved ? "commented · resolved" : "commented";
}

function Avatar({ item }: { item: ConversationItem }) {
  if (item.kind === "check") return <span aria-hidden className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-md bg-muted text-destructive"><Icon name="X" className="size-3" /></span>;
  if (item.bot) return <span aria-hidden className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"><Icon name="Bot" className="size-3" /></span>;
  const initial = (item.mine ? "you" : item.author ?? "?").replace(/^@/u, "").charAt(0).toUpperCase();
  return <span aria-hidden className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-bold text-foreground">{initial}</span>;
}

function ReplyBox({ pr, item, autoFocus, onClose }: { pr: PrView; item: ConversationItem; autoFocus: boolean; onClose(): void }) {
  const [text, setText] = usePrState(pr.key, "replyText", "", `reply/${item.id}`);
  const reply = useShuttleMutation("reply");
  const send = async () => {
    const body = text.trim();
    if (body === "" || item.thread === null) return;
    if ((await reply.run({ key: pr.key, thread: item.thread, body })) === null) return;
    toast.success(`Replied on ${pr.serverName}.`);
    setText("");
    onClose();
  };
  return (
    <div className="mt-2 rounded-lg border border-primary/60 bg-background">
      <textarea aria-label={`Reply to ${item.author ?? "the thread"}`} autoFocus={autoFocus} rows={2} value={text} placeholder={`Reply to ${item.author ?? "the thread"}…`}
        onChange={(event) => setText(event.target.value)} className="block w-full resize-y bg-transparent px-2.5 py-2 text-sm outline-none" />
      <div className="flex items-center gap-1.5 border-t border-border px-2 py-1.5">
        <span className="flex-1 text-xs text-muted-foreground">Replies on {pr.serverName} as you</span>
        <button type="button" className={BUTTON_GHOST} onClick={() => { setText(""); onClose(); }}>Cancel</button>
        <button type="button" className={BUTTON_PRIMARY} disabled={reply.isPending || text.trim() === ""} onClick={() => void send()}>Reply</button>
      </div>
    </div>
  );
}

function Item({ pr, item, onResolve }: { pr: PrView; item: ConversationItem; onResolve(item: ConversationItem): void }) {
  const actions = useActions();
  const [replying, setReplying] = usePrState(pr.key, "replyOpen", false, `reply/${item.id}`);
  const focusReply = useRef(false);
  const tag = tagOf(pr, item);
  const live = isLive(pr);
  const inThread = item.kind === "thread" && item.thread !== null;
  const canReply = live && inThread && pr.can.reply;
  const canResolve = live && inThread && pr.can.resolve;
  const canSend = live && pr.mine && pr.agent === null && isFeedback(item);
  const link = "cursor-pointer text-muted-foreground hover:text-foreground";
  return (
    <li data-item={item.id} className="flex gap-2.5 border-t border-border py-2.5 first:border-t-0">
      <Avatar item={item} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <b className="text-[13px]">{item.mine ? "You" : item.author ?? (item.kind === "check" ? "CI" : "Someone")}</b>
          <span className="text-muted-foreground">{kindOf(item)}</span>
          {item.at !== null && <span className="text-[11px] text-muted-foreground">{age(item.at)}</span>}
          {tag !== null && (
            <span data-tag className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 text-[10.5px] leading-[17px] ${TAG_TONES[tag.tone]}`}>
              {tag.icon && <Icon name={tag.icon} fallback="Circle" className="size-3" aria-hidden />}{tag.text}
            </span>
          )}
        </div>
        {item.path !== null && (
          <span title={item.path} className="mt-1 inline-block max-w-full truncate rounded border border-border bg-background px-1 font-mono text-[11px] text-muted-foreground">
            {item.path}{item.line !== null && `:${item.line}`}
          </span>
        )}
        <div className="mt-0.5 min-w-0 break-words text-[13px]"><Markdown content={item.body} /></div>
        {item.outcome?.note && <div className="mt-0.5 text-xs text-muted-foreground">{item.outcome.note}</div>}
        {(canReply || canResolve || canSend) && (
          <div className="mt-1 flex gap-3 text-xs">
            {canReply && !replying && <button type="button" className={link} onClick={() => { focusReply.current = true; setReplying(true); }}>Reply</button>}
            {canSend && <button type="button" className={link} onClick={() => actions.pickAgent(pr)}>Send to an agent</button>}
            {canResolve && <button type="button" className={link} onClick={() => onResolve(item)}>{item.resolved ? "Reopen" : "Resolve"}</button>}
          </div>
        )}
        {replying && <ReplyBox pr={pr} item={item} autoFocus={focusReply.current} onClose={() => setReplying(false)} />}
      </div>
    </li>
  );
}

/** The PR's reviews, comments and failed checks, newest first, with the composer at the end. */
export function Conversation({ pr, items, error, phone }: { pr: PrView; items: readonly ConversationItem[] | undefined; error: string | null; phone: boolean }) {
  const resolve = useShuttleMutation("resolve", ({ key, thread, resolved }, cache) =>
    cache.update("conversation", { key }, (current) => ({ ...current, items: current.items.map((item) => (item.thread === thread ? { ...item, resolved } : item)) })));
  const toggle = async (item: ConversationItem, undoable = true) => {
    if (item.thread === null) return;
    const resolved = !item.resolved;
    if ((await resolve.run({ key: pr.key, thread: item.thread, resolved })) === null) return;
    const message = resolved ? "Resolved the conversation." : "Reopened the conversation.";
    if (undoable) undoToast(message, () => void toggle({ ...item, resolved }, false));
    else toast.success(message);
  };
  const sorted = [...(items ?? [])].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return (
    <section aria-label="Conversation" className="mx-4 mt-4">
      <SectionTitle icon="MessageSquare">
        <span className="flex-1">Conversation</span>
        {items !== undefined && <span className="normal-case tracking-normal">{plural(items.length, "item")}</span>}
      </SectionTitle>
      {error !== null && <div className="mb-1.5 text-xs text-muted-foreground">{error}</div>}
      {items === undefined && error === null && <div className="text-sm text-muted-foreground">Loading the conversation…</div>}
      {items !== undefined && items.length === 0 && <div className="text-sm text-muted-foreground">No reviews or comments yet.</div>}
      {sorted.length > 0 && <ul>{sorted.map((item) => <Item key={item.id} pr={pr} item={item} onResolve={(target) => void toggle(target)} />)}</ul>}
      {isLive(pr) && !phone && <Composer pr={pr} />}
    </section>
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
    <div data-composer className="mt-3 rounded-lg border border-border bg-background focus-within:border-primary/60">
      <textarea ref={box} aria-label={`Comment on ${tinyKey(pr)}`} autoFocus={autoFocus} rows={3} value={text} placeholder={`Comment on ${tinyKey(pr)}… Markdown works`}
        onChange={(event) => setText(event.target.value)} className="block min-h-16 w-full resize-y bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground" />
      <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-2 py-1.5">
        {options.length > 1 && <div className="shrink-0"><Segmented label="Post as" value={verdict} options={options} onChange={setVerdict} /></div>}
        <span className="flex-1" />
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

/** Your PR's checks: the failing ones by name, how many still run and how many passed. */
export function ChecksSection({ pr, items }: { pr: PrView; items: readonly ConversationItem[] | undefined }) {
  const navigate = useBbNavigate();
  if (!pr.mine || !isLive(pr) || pr.checks === "none") return null;
  const counts = pr.checkCounts;
  const failing = (items ?? []).filter((item) => item.kind === "check");
  const row = "flex items-center gap-2 py-1 text-[13px]";
  return (
    <section aria-label="Checks" className="mx-4 mt-4">
      <SectionTitle icon="Check">
        <span className="flex-1">Checks</span>
        {counts !== null && <span className="normal-case tracking-normal">{counts.passed} of {counts.total} pass</span>}
      </SectionTitle>
      {failing.map((item) => (
        <div key={item.id} data-failing-check className={row}>
          <Icon name="X" className="size-3.5 shrink-0 text-destructive" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{checkName(item.body)}</span>
          {item.url !== null && <button type="button" className="cursor-pointer text-xs text-primary hover:underline" onClick={() => openExternal(navigate, item.url!)}>Log</button>}
        </div>
      ))}
      {failing.length === 0 && pr.checks === "failed" && counts === null && (
        <div className={row}><Icon name="X" className="size-3.5 text-destructive" aria-hidden /><span className="flex-1">Some checks fail</span></div>
      )}
      {(counts !== null ? counts.pending > 0 : pr.checks === "pending") && (
        <div className={row}><Icon name="Clock" className="size-3.5 text-warning-text" aria-hidden /><span className="flex-1">{counts !== null ? `${counts.pending} still running` : "Some still running"}</span></div>
      )}
      {(counts !== null ? counts.passed > 0 : pr.checks === "passed") && (
        <div className={row}><Icon name="Check" className="size-3.5 text-success" aria-hidden /><span className="flex-1 text-muted-foreground">{counts !== null ? `${counts.passed} passed` : "All pass"}</span></div>
      )}
    </section>
  );
}
