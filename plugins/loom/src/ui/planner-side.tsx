import { useState } from "react";
import type { PlannerVersion, PlannerView } from "../contract";
import { changeLine, type JourneyStep, type QuestionRound } from "../planner-journey";
import { BUTTON_PRIMARY, CARD, FIELD, messageOf, plural, useLoomWrite } from "./common";
import { timeLabel } from "./planner-kit";

const TITLE = "mb-2 flex items-baseline gap-2 text-sm font-semibold";

/** A message to the planner from the page, sent as the human's own words. Changes to the spec go to the Spec tab instead, where the next version answers each comment. */
export function MessageBox({ threadId, live, text, onText }: { threadId: string; live: boolean; text: string; onText(text: string): void }) {
  const message = useLoomWrite("messagePlanner");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const send = () => {
    setBusy(true);
    setError(null);
    message({ threadId, text: text.trim(), confirm: true }).then(
      () => {
        onText("");
        setSent(true);
        setBusy(false);
      },
      (failure: unknown) => {
        setError(messageOf(failure));
        setBusy(false);
      },
    );
  };
  return (
    <section data-message-planner aria-label="Message the planner" className={`${CARD} bg-card`}>
      <h3 className={TITLE}>Message the planner</h3>
      <textarea
        aria-label="Message to the planner"
        placeholder={live ? "Ask it something, or tell it what to change…" : "The planner's thread has ended."}
        value={text}
        disabled={!live || busy}
        maxLength={20_000}
        onChange={(event) => {
          onText(event.target.value);
          setSent(false);
        }}
        className={`${FIELD} min-h-20 resize-y`}
      />
      <p className="mt-1.5 text-[11px] text-muted-foreground">To change the spec, comment on the Spec tab instead: the planner gets every comment in one message, and the next version shows what it did with each.</p>
      {error !== null && <p role="alert" className="mt-1 text-xs text-destructive-text">{error}</p>}
      <div className="mt-2 flex items-center gap-2">
        {sent && <span role="status" className="text-xs text-success">Sent. Its reply shows under What happened.</span>}
        <button type="button" className={`${BUTTON_PRIMARY} ml-auto`} disabled={!live || busy || text.trim() === ""} onClick={send}>
          Send
        </button>
      </div>
    </section>
  );
}

/** The human's answers to the planner's questions, newest round first; an answer a later round asks again is marked as replaced. */
export function Decisions({ rounds, now }: { rounds: readonly QuestionRound[]; now: number }) {
  const answered = rounds.filter((round) => round.status === "answered" && round.answers.length > 0).reverse();
  const total = answered.reduce((sum, round) => sum + round.answers.length, 0);
  const seen = new Set<string>();
  return (
    <section data-decisions aria-label="What you decided" className={`${CARD} bg-card`}>
      <h3 className={TITLE}>
        What you decided {total > 0 && <span className="text-xs font-normal text-muted-foreground">{plural(total, "answer")}</span>}
      </h3>
      {answered.length === 0 ? (
        <p className="text-xs text-muted-foreground">Your answers to the planner's questions collect here, so you can see what it works from.</p>
      ) : (
        <div className="space-y-2">
          {answered.map((round) => (
            <div key={round.id}>
              <p className="text-[11px] text-subtle-foreground">{timeLabel(round.answeredAt!, now)}</p>
              <dl className="divide-y divide-dashed divide-border-seam text-xs">
                {round.answers.map((answer) => {
                  const replaced = seen.has(answer.header);
                  seen.add(answer.header);
                  return (
                    <div key={answer.question} data-decision={answer.header} className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2 py-1">
                      <dt className="text-muted-foreground" title={answer.question}>
                        {answer.header}
                      </dt>
                      <dd className={`[overflow-wrap:anywhere] ${replaced ? "text-subtle-foreground line-through" : ""}`}>
                        {answer.answer}
                        {replaced && <span className="block text-[11px] text-primary no-underline">asked again later</span>}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const STATUS: Record<PlannerVersion["status"], { label: string; tone: string }> = {
  draft: { label: "Draft", tone: "border-warning text-warning-text" },
  pending: { label: "Waits for you", tone: "border-warning text-warning-text" },
  approved: { label: "In force", tone: "border-success text-success" },
  superseded: { label: "Superseded", tone: "border-border-seam text-muted-foreground" },
};

const REVIEW_LABEL: Record<NonNullable<PlannerVersion["review"]>["state"], string> = {
  approved: "review passed",
  changes_requested: "review found problems",
  failed: "review did not finish",
  reviewing: "in review",
  skipped: "review skipped",
};

/** Every spec version, newest first, each opening the Spec tab on it. */
export function Versions({ versions, onSpec }: { versions: readonly PlannerVersion[]; onSpec?(version: number): void }) {
  return (
    <section data-versions aria-label="Spec versions" className={`${CARD} bg-card`}>
      <h3 className={TITLE}>Spec versions</h3>
      {versions.length === 0 ? (
        <p className="text-xs text-muted-foreground">No draft yet. The planner proposes one once it has what it needs from you.</p>
      ) : (
        <ul className="space-y-0.5">
          {[...versions].reverse().map((entry) => {
            const status = STATUS[entry.status];
            const body = (
              <>
                <b className="text-xs">v{entry.version}</b>
                <span className="min-w-0 text-xs">
                  <span className={`mr-1.5 inline-block rounded-full border px-1.5 text-[10.5px] leading-4 ${status.tone}`}>{status.label}</span>
                  <span className="text-muted-foreground">
                    {changeLine(entry.tickets, entry.change)}
                    {entry.review === null ? "" : ` · ${REVIEW_LABEL[entry.review.state]}`}
                  </span>
                </span>
              </>
            );
            return (
              <li key={entry.version}>
                {onSpec === undefined ? (
                  <div className="grid grid-cols-[2rem_minmax(0,1fr)] items-baseline gap-2 px-1.5 py-1">{body}</div>
                ) : (
                  <button type="button" aria-label={`Open v${entry.version} on the Spec tab`} onClick={() => onSpec(entry.version)} className="grid w-full cursor-pointer grid-cols-[2rem_minmax(0,1fr)] items-baseline gap-2 rounded px-1.5 py-1 text-left hover:bg-state-hover">
                    {body}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function About({ view, rounds, steps }: { view: PlannerView; rounds: readonly QuestionRound[]; steps: readonly JourneyStep[] }) {
  const asked = rounds.length;
  const questions = rounds.reduce((sum, round) => sum + round.answers.length, 0);
  const messages = steps.filter((step) => step.kind === "message").length;
  const comments = steps.reduce((sum, step) => sum + (step.kind === "notes" ? step.notes.length : 0), 0);
  const rows: Array<[string, string]> = [
    ["Started", timeLabel(view.startedAt, view.now)],
    ["Questions", asked === 0 ? "none yet" : `${plural(asked, "round")}${questions === 0 ? "" : `, ${plural(questions, "answer")}`}`],
    ["Your input", [plural(comments, "comment"), messages === 0 ? "" : `${plural(messages, "message")} from this page`].filter((part) => part !== "").join(" · ")],
    ...(view.approvedVersion === null ? [] : ([["Triage", view.triageRounds === 0 ? "no rounds yet" : plural(view.triageRounds, "round")]] as Array<[string, string]>)),
  ];
  return (
    <section data-about-planner aria-label="About this planner" className={`${CARD} bg-card`}>
      <h3 className={TITLE}>About this planner</h3>
      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
        {rows.map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="text-muted-foreground">{key}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
