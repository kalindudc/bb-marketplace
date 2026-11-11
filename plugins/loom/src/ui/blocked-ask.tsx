// A blocked ticket's answer, where the person makes it: what the worker asks, its question as a form with its pick
// preselected when it gave options, a note, and Requeue with the attempt it starts. A block without options keeps the
// worker's prose and asks for a note, as before. Picking an option is the answer; the note adds to it.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { TicketAction, TicketDetail } from "../contract";
import { ActionButton, BUTTON, FIELD, TAP } from "./common";
import { focusNote } from "./dispatch";
import { PHONE_TEXT, useNarrowPage } from "./narrow";
import { ago } from "./ticket-cards";

const LINK = "inline-flex cursor-pointer items-center justify-center rounded text-xs text-foreground underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring @max-xl/loom:min-h-11 @max-xl/loom:min-w-11 max-[576px]:min-h-11 max-[576px]:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11";

/** The note Requeue sends: the option chosen, then the person's own words. */
export function answerNote(ask: TicketDetail["ask"], choice: number | null, note: string): string {
  const option = ask === null || choice === null ? undefined : ask.options[choice];
  const text = note.trim();
  if (option === undefined) return text;
  return text === "" ? option.label : `${option.label}\n\n${text}`;
}

export function BlockedAsk({ ticket, now, busy, onAction, onJump }: { ticket: TicketDetail; now: number; busy: boolean; onAction(action: TicketAction, note: string): Promise<boolean>; onJump(postId: number): void }) {
  const ask = ticket.ask;
  const options = ask?.options ?? [];
  const [choice, setChoice] = useState<number | null>(ask?.recommended ?? null);
  const [other, setOther] = useState(false);
  const [note, setNote] = useState("");
  const [whole, setWhole] = useState(false);
  const root = useRef<HTMLElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  // On a phone the answer's buttons dock at the bottom of the screen, under the thumb, from the first screen on: the
  // dock is the pane's own child, so it sticks while the pane is in view, and it sits under the form once scrolled to.
  const narrow = useNarrowPage(root);
  const dock = useRef<HTMLDivElement>(null);
  // Focus and scrolling stop above the dock, so nothing the keyboard reaches ends up under it.
  useLayoutEffect(() => {
    const page = root.current?.closest<HTMLElement>("[data-loom-scroll]");
    if (!narrow || page == null || dock.current === null) return;
    page.style.scrollPaddingBottom = `${dock.current.offsetHeight + 8}px`;
    return () => {
      page.style.scrollPaddingBottom = "";
    };
  }, [narrow, ticket.reviewAgain]);
  // Opened from Home's queue to answer it: the note takes focus once.
  useEffect(() => {
    if (focusNote.get() !== ticket.key) return;
    focusNote.set(null);
    field.current?.scrollIntoView?.({ block: "center" });
    field.current?.focus({ preventScroll: true });
  }, [ticket.key]);
  const block = ticket.posts.filter((post) => post.kind === "block").at(-1);
  const worker = block?.authorKind === "worker";
  const picked = options.length > 0 && !other ? choice : null;
  const answer = answerNote(ask, picked, note);
  const reason = ticket.blockedReason ?? "";
  const long = reason.length > 360 || reason.split("\n").length > 5;
  const pick = (index: number | null) => {
    setOther(index === null);
    setChoice(index);
  };
  const digits = (event: KeyboardEvent<HTMLElement>) => {
    const n = Number(event.key);
    if (!Number.isInteger(n) || n < 1 || n > options.length + 1 || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    pick(n === options.length + 1 ? null : n - 1);
    event.currentTarget.querySelectorAll<HTMLInputElement>("input[type=radio]")[n - 1]?.focus();
  };
  const review = ticket.reviewAgain && <ActionButton label="Review again as is" disabled={busy} onClick={() => void onAction("review", note.trim()).then((done) => done && setNote(""))} />;
  const requeue = <ActionButton primary icon={<Icon name="RotateCcw" aria-hidden className="size-3.5" />} label={`Requeue · attempt ${ticket.attempt + 1}`} title="Sends your answer to the next worker" disabled={busy || answer === ""} onClick={() => void onAction("requeue", answer).then((done) => done && setNote(""))} />;
  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      {review}
      <span className="flex-1" />
      {requeue}
    </div>
  );
  const write = () => {
    field.current?.scrollIntoView?.({ block: "center" });
    field.current?.focus({ preventScroll: true });
  };
  return (
    <>
      <section ref={root} onFocus={narrow ? (event) => (event.target as HTMLElement).scrollIntoView?.({ block: "nearest" }) : undefined} data-blocked-callout data-ticket-actions aria-label={worker ? "The worker asks" : "Blocked"} className="loom-card loom-lead grid gap-2.5 rounded-md p-3">
        <p className="m-0 flex items-center gap-1.5 text-sm font-semibold">
          <Icon name="AlertCircle" aria-hidden className="size-4 text-[var(--attention)]" />
          {worker ? "Worker asks" : "Blocked"}
          {block !== undefined && <span className="loom-num text-xs font-normal text-[var(--loom-muted)]">{ago(block.at, now)}</span>}
        </p>
        {reason !== "" && (
          <div className="grid gap-1">
            <p className={`m-0 whitespace-pre-line text-[13px] leading-relaxed [overflow-wrap:anywhere] ${long && !whole ? "line-clamp-5" : ""}`}>{reason}</p>
            <span className="flex flex-wrap gap-3">
              {long && (
                <button type="button" aria-expanded={whole} onClick={() => setWhole(!whole)} className={LINK}>
                  {whole ? "Show less" : "Show all"}
                </button>
              )}
              {block !== undefined && (
                <button type="button" aria-label="Read the post that blocked it" onClick={() => onJump(block.id)} className={LINK}>
                  Read the post
                </button>
              )}
            </span>
          </div>
        )}
        {ticket.pr?.pushedSha != null && ticket.prUrl !== null && (
          <p data-blocked-pr className="m-0 text-xs text-[var(--loom-muted)] [overflow-wrap:anywhere]">
            Loom stopped following {ticket.prUrl}, which stays open. A requeue starts a new worker on the same pull request, and Loom pushes its fixes as more commits.
          </p>
        )}
        {ask?.question != null && <p className="m-0 text-sm font-semibold [overflow-wrap:anywhere]">{ask.question}</p>}
        {options.length > 0 && (
          <div role="radiogroup" aria-label={ask?.question ?? "The worker's options"} data-ask-options onKeyDown={digits} className="grid gap-1">
            {[...options.map((option, index) => ({ ...option, index })), { label: "Other…", consequence: null, index: null }].map((option, at) => {
              const on = option.index === null ? other : !other && choice === option.index;
              return (
                <label key={at} data-ask-option={option.index ?? "other"} className={`flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 ${on ? "bg-[var(--loom-sel)] shadow-[inset_0_0_0_1px_var(--primary)]" : "hover:bg-state-hover"} ${TAP}`}>
                  <input type="radio" name={`ask-${ticket.key}`} checked={on} onChange={() => pick(option.index)} className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5 text-[13px] [overflow-wrap:anywhere]">
                      {option.label}
                      {option.index !== null && option.index === ask?.recommended && <span className="rounded-sm bg-[var(--loom-att-tint)] px-1 text-[11px] font-semibold">Recommended</span>}
                    </span>
                    {option.consequence !== null && <span className="block text-xs text-[var(--loom-muted)] [overflow-wrap:anywhere]">{option.consequence}</span>}
                  </span>
                  <kbd aria-hidden className="loom-num hidden rounded border border-[var(--loom-line)] px-1 text-[11px] text-[var(--loom-muted)] @md/loom:inline">
                    {at + 1}
                  </kbd>
                </label>
              );
            })}
          </div>
        )}
        <textarea ref={field} aria-label="Note" value={note} rows={2} placeholder={picked !== null ? "Note (optional)" : "Your answer for the next worker (required)"} onChange={(event) => setNote(event.target.value)} className={`${FIELD} ${PHONE_TEXT}`} />
        {!narrow && actions}
        {ticket.replyTo === "planner" && <p className="m-0 text-xs text-[var(--loom-muted)]">Or reply on the post: the planner gets it now and can requeue the ticket itself.</p>}
        {ticket.reviewAgain && (
          <p data-review-again className="m-0 text-xs text-[var(--loom-muted)]">
            Review again as is starts no worker: the ticket goes back to review for the commit whose checks passed last, or back on its pull request when that has all of its work. Your note, if any, goes on the ticket.
          </p>
        )}
      </section>
      {narrow && (
        <div ref={dock} data-answer-dock className="sticky bottom-0 z-20 -mt-1 grid gap-2 border-t border-[var(--loom-line)] bg-[var(--loom-card)] px-1 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 shadow-[0_-10px_18px_-14px_rgb(0_0_0/0.45)] [&_button]:w-full [&_button]:justify-center">
          {review}
          {answer === "" ? (
            <button type="button" onClick={write} className={`${BUTTON} font-semibold`}>
              <Icon name="MessageSquare" aria-hidden className="size-3.5" />
              Write your answer to requeue
            </button>
          ) : (
            requeue
          )}
        </div>
      )}
    </>
  );
}
