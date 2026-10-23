import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown, experimental_useSidebarThreads, useBbNavigate, useSdk, type PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import type { QuestionRound } from "../planner-journey";
import { BUTTON, BUTTON_PRIMARY, FIELD, messageOf } from "./common";
import { PlannerMark } from "./planner-kit";

type Interaction = Awaited<ReturnType<PluginBrowserBbSdk["threads"]["interactions"]["list"]>>[number];
type PluginInteraction = Extract<Interaction, { origin: { kind: "plugin" } }>;
type Answers = Record<string, { selected: string[]; freeText?: string }>;

// bb's built-in Ask User Question and Better Ask share this renderer id and wire format.
const ASK_RENDERER_ID = "ask-user-question";
const MAX_FREE_TEXT = 4096;

export interface AskQuestion {
  id: string;
  prompt: string;
  shortLabel: string;
  multiSelect: boolean;
  allowFreeText: boolean;
  context?: string;
  options: Array<{ value: string; label: string; description?: string; recommended?: boolean }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value);
const isOption = (value: unknown) => isRecord(value) && isString(value.value) && isString(value.label) && optional(value.description, isString) && optional(value.recommended, isBoolean);
const isQuestion = (value: unknown): value is AskQuestion =>
  isRecord(value) &&
  isString(value.id) &&
  isString(value.prompt) &&
  isString(value.shortLabel) &&
  isBoolean(value.multiSelect) &&
  isBoolean(value.allowFreeText) &&
  optional(value.context, isString) &&
  Array.isArray(value.options) &&
  value.options.every(isOption);

/** The questions of an Ask User Question payload, or null unless every field has its type. */
export function questionsOf(data: unknown): AskQuestion[] | null {
  const questions = isRecord(data) ? data.questions : undefined;
  return Array.isArray(questions) && questions.length > 0 && questions.every(isQuestion) ? questions : null;
}

const isPluginRow = (row: Interaction): row is PluginInteraction => row.payload.kind === "plugin" && row.origin?.kind === "plugin";

/** Whether bb's sidebar says the thread waits on the human, for a question or an approval. */
export function useWaiting(threadId: string): boolean {
  return experimental_useSidebarThreads().threads.find((thread) => thread.id === threadId)?.hasPendingInteraction === true;
}

/**
 * The planner's open plugin questions, which bb's embedded chat leaves out. Read while the sidebar says the thread waits on
 * the user, or while `also` says so: its thread events show a round still open that the sidebar does not.
 */
export function usePendingQuestions(threadId: string, also = false) {
  const sdk = useSdk();
  const waiting = useWaiting(threadId) || also;
  const [rows, setRows] = useState<PluginInteraction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(sdk);
  latest.current = sdk;

  // Bumped when the thread or its waiting flag changes and on unmount, so a late list response is dropped.
  const generation = useRef(0);
  const load = useCallback(() => {
    const asked = generation.current;
    Promise.resolve()
      .then(() => latest.current.threads.interactions.list({ threadId }))
      .then(
        (list) => {
          if (generation.current !== asked) return;
          setRows(list.filter(isPluginRow).filter((row) => row.status === "pending").sort((a, b) => a.createdAt - b.createdAt));
          setError(null);
        },
        (failure: unknown) => generation.current === asked && setError(messageOf(failure)),
      );
  }, [threadId]);
  useEffect(() => {
    if (waiting) load();
    else {
      setRows([]);
      setError(null);
    }
    return () => {
      generation.current += 1;
    };
  }, [waiting, load]);

  const respond = async (interactionId: string, answers: Answers) => {
    await latest.current.threads.interactions.respond({ threadId, interactionId, value: { answers } });
    load();
  };
  return { rows, error, respond, waiting };
}

/** One answered or open round from a `system/interaction/lifecycle` event's interaction; null for anything that is not a planner question. */
function roundOf(data: unknown, at: number): { id: string; status: string; round: QuestionRound } | null {
  const interaction = isRecord(data) && isRecord(data.interaction) ? data.interaction : null;
  if (interaction === null || !isString(interaction.id) || !isString(interaction.status)) return null;
  const origin = isRecord(interaction.origin) ? interaction.origin : null;
  if (origin?.kind !== "plugin" || origin.rendererId !== ASK_RENDERER_ID) return null;
  const payload = isRecord(interaction.payload) ? interaction.payload : {};
  const resolution = isRecord(interaction.resolution) ? interaction.resolution : {};
  const description = isRecord(resolution.description) ? resolution.description : {};
  const answered = isRecord(description.payload) ? description.payload : {};
  const answers: QuestionRound["answers"] = [];
  const given = isRecord(answered.answers) ? answered.answers : {};
  for (const question of Array.isArray(answered.questions) ? answered.questions : []) {
    if (!isRecord(question) || !isString(question.question)) continue;
    const answer = given[question.question];
    if (isString(answer)) answers.push({ header: isString(question.header) ? question.header : question.question, question: question.question, answer });
  }
  // Without the structured payload, bb's own description has a "- question — answer" line for each.
  if (answers.length === 0 && isString(description.detail)) {
    for (const line of description.detail.split("\n")) {
      const match = /^- (.+?) — (.+)$/.exec(line.trim());
      if (match !== null) answers.push({ header: match[1]!, question: match[1]!, answer: match[2]! });
    }
  }
  const title = isString(payload.title) ? payload.title : "Questions";
  return { id: interaction.id, status: interaction.status, round: { id: interaction.id, title, askedAt: at, status: "open", answeredAt: null, answers } };
}

// bb returns at most 100 thread events a call; this many pages is far more question rounds than a planner asks.
const EVENT_PAGE = 100;
const MAX_PAGES = 10;

/** The thread's interaction lifecycle events, oldest first, page by page. */
async function readLifecycle(sdk: PluginBrowserBbSdk, threadId: string) {
  const rows: Awaited<ReturnType<PluginBrowserBbSdk["threads"]["events"]["list"]>> = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const after = rows.at(-1)?.seq;
    const next = await sdk.threads.events.list({ threadId, types: ["system/interaction/lifecycle"], limit: String(EVENT_PAGE), order: "asc", ...(after === undefined ? {} : { afterSeq: String(after) }) });
    rows.push(...next);
    if (next.length < EVENT_PAGE) break;
  }
  return rows;
}

/** Every question round of the planner's thread, asked and answered, read from bb's thread events again when `stamp` changes. */
export function useQuestionRounds(threadId: string, stamp: string): QuestionRound[] {
  const sdk = useSdk();
  const [rounds, setRounds] = useState<QuestionRound[]>([]);
  const latest = useRef(sdk);
  latest.current = sdk;
  useEffect(() => {
    let live = true;
    // A bb without this API, or a refusal, leaves the rounds out: the page still shows Loom's own steps.
    readLifecycle(latest.current, threadId)
      .then(
        (rows) => {
          if (!live) return;
          const byId = new Map<string, QuestionRound>();
          for (const row of rows) {
            const parsed = roundOf(row.data, row.createdAt);
            if (parsed === null) continue;
            const asked = byId.get(parsed.id) ?? parsed.round;
            // Pending and resolving still wait on the human; any other end, such as an interrupted turn, closes the round unanswered.
            if (parsed.status === "pending" || parsed.status === "resolving") byId.set(parsed.id, asked);
            else if (parsed.status === "resolved") byId.set(parsed.id, { ...asked, status: "answered", answeredAt: parsed.round.askedAt, answers: parsed.round.answers });
            else byId.set(parsed.id, { ...asked, status: "ended", answeredAt: parsed.round.askedAt, answers: [] });
          }
          setRounds([...byId.values()].sort((a, b) => a.askedAt - b.askedAt));
        },
        () => live && setRounds([]),
      );
    return () => {
      live = false;
    };
  }, [threadId, stamp]);
  return rounds;
}

/** The planner's open questions as cards for Needs you, one question at a time. A question another plugin draws goes to the thread. */
export function PlannerQuestions({ threadId, rows, error, respond }: { threadId: string } & Pick<ReturnType<typeof usePendingQuestions>, "rows" | "error" | "respond">) {
  const navigate = useBbNavigate();
  if (rows.length === 0 && error === null) return null;
  return (
    <>
      {error !== null && <p role="alert" className="text-xs text-destructive-text">Could not read the planner's questions: {error}</p>}
      {rows.map((row) => {
        const questions = row.origin.rendererId === ASK_RENDERER_ID ? questionsOf(row.payload.data) : null;
        if (questions === null) {
          return (
            <section key={row.id} data-question-card={row.id} className="flex flex-wrap items-center gap-2 rounded-md border border-l-4 border-warning bg-card p-3">
              <PlannerMark />
              <h3 className="text-sm font-semibold">{row.payload.title}</h3>
              <button type="button" className={`${BUTTON} ml-auto`} onClick={() => navigate.toThread(threadId)}>
                Answer in the thread
              </button>
            </section>
          );
        }
        return <QuestionCard key={row.id} id={row.id} title={row.payload.title} questions={questions} send={(answers) => respond(row.id, answers)} />;
      })}
    </>
  );
}

const OPTION = "flex h-auto cursor-pointer flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left text-sm hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60";

function QuestionCard({ id, title, questions, send }: { id: string; title: string; questions: AskQuestion[]; send(answers: Answers): Promise<void> }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [index, setIndex] = useState(0);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const paged = questions.length > 1;
  const textOf = (question: AskQuestion) => (typed[question.id] ?? "").trim();
  const isAnswered = (question: AskQuestion) => (picked[question.id] ?? []).length > 0 || textOf(question) !== "";
  const answered = questions.filter(isAnswered).length;
  const recommendedLeft = questions.some((question) => !isAnswered(question) && question.options.some((option) => option.recommended === true));
  // The planner's form does not change while it is open, but a clamp keeps a shorter one from reading past its end.
  const question = questions[Math.min(index, questions.length - 1)]!;

  const toggle = (value: string) =>
    setPicked((current) => {
      const now = current[question.id] ?? [];
      const next = now.includes(value) ? now.filter((entry) => entry !== value) : question.multiSelect ? [...now, value] : [value];
      return { ...current, [question.id]: next };
    });

  const pickRecommended = () => {
    setPicked((current) => {
      const next = { ...current };
      for (const entry of questions) {
        if ((next[entry.id] ?? []).length > 0 || textOf(entry) !== "") continue;
        const recommended = entry.options.filter((option) => option.recommended === true).map((option) => option.value);
        if (recommended.length > 0) next[entry.id] = entry.multiSelect ? recommended : [recommended[0]!];
      }
      return next;
    });
    if (paged) setReviewing(true);
  };

  // Stays disabled after a sent answer: the card goes away when the list no longer has the question.
  const submit = () => {
    setBusy(true);
    setError(null);
    const answers: Answers = Object.fromEntries(questions.map((entry) => [entry.id, { selected: picked[entry.id] ?? [], ...(textOf(entry) === "" ? {} : { freeText: textOf(entry) }) }]));
    send(answers).catch((failure: unknown) => {
      setError(messageOf(failure));
      setBusy(false);
    });
  };

  const labelsOf = (entry: AskQuestion) => [...(picked[entry.id] ?? []).map((value) => entry.options.find((option) => option.value === value)?.label ?? value), ...(textOf(entry) === "" ? [] : [`“${textOf(entry)}”`])];
  const sendLabel = paged ? `Send ${answered} answers` : "Send answer";

  return (
    <section data-question-card={id} aria-label={title} className="space-y-3 rounded-md border border-l-4 border-warning bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <PlannerMark />
        <h3 className="text-sm font-semibold">{paged ? `The planner asks ${questions.length} questions` : "The planner asks a question"}</h3>
        <span className="text-xs text-muted-foreground">{title}</span>
      </div>
      {paged && (
        <div role="tablist" aria-label="Questions" className="flex flex-wrap gap-1">
          {questions.map((entry, n) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={!reviewing && n === index}
              onClick={() => {
                setIndex(n);
                setReviewing(false);
              }}
              className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-1 text-xs ${!reviewing && n === index ? "border-foreground font-semibold text-foreground" : "border-border-seam text-muted-foreground hover:bg-state-hover"}`}
            >
              <span aria-hidden className={`inline-flex size-4 items-center justify-center rounded-full text-[10px] ${isAnswered(entry) ? "bg-success text-success-foreground" : "bg-surface-selected"}`}>
                {isAnswered(entry) ? "✓" : n + 1}
              </span>
              {entry.shortLabel}
            </button>
          ))}
          <button type="button" role="tab" aria-selected={reviewing} onClick={() => setReviewing(true)} className={`inline-flex cursor-pointer items-center rounded-full border px-2.5 py-0.5 text-xs ${reviewing ? "border-foreground font-semibold text-foreground" : "border-border-seam text-muted-foreground hover:bg-state-hover"}`}>
            Review
          </button>
        </div>
      )}
      {reviewing ? (
        <dl data-question-review className="divide-y divide-dashed divide-border-seam text-sm">
          {questions.map((entry, n) => (
            <div key={entry.id} className="grid grid-cols-[7rem_minmax(0,1fr)_auto] items-baseline gap-3 py-1.5">
              <dt className="text-xs text-muted-foreground">{entry.shortLabel}</dt>
              <dd className={isAnswered(entry) ? "" : "text-warning-text"}>{isAnswered(entry) ? labelsOf(entry).join(", ") : "Not answered yet"}</dd>
              <button
                type="button"
                className="cursor-pointer text-xs text-primary hover:underline"
                onClick={() => {
                  setIndex(n);
                  setReviewing(false);
                }}
              >
                Change
              </button>
            </div>
          ))}
        </dl>
      ) : (
        <fieldset key={question.id} className="space-y-2">
          <legend className="text-base font-semibold">{question.prompt}</legend>
          <p className="text-xs text-muted-foreground">{question.multiSelect ? "Pick any that apply" : "Pick one"}</p>
          {question.context !== undefined && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none">Why it asks</summary>
              <div className="mt-1 rounded-md border border-border-seam p-2">
                <Markdown content={question.context} className="text-xs [overflow-wrap:anywhere]" />
              </div>
            </details>
          )}
          <div className="grid gap-1.5 @3xl:grid-cols-2">
            {question.options.map((option) => {
              const on = (picked[question.id] ?? []).includes(option.value);
              return (
                <button key={option.value} type="button" aria-pressed={on} disabled={busy} onClick={() => toggle(option.value)} className={`${OPTION} ${on ? "border-primary bg-primary/10" : "border-border-seam"}`}>
                  <span className="flex items-center gap-1.5 font-medium">
                    <span aria-hidden className={`inline-flex size-3.5 shrink-0 items-center justify-center border text-[9px] ${question.multiSelect ? "rounded-sm" : "rounded-full"} ${on ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground"}`}>
                      {on ? "✓" : ""}
                    </span>
                    {option.label}
                    {option.recommended === true && <span className="rounded-sm bg-success/15 px-1 text-[10px] text-success">Recommended</span>}
                  </span>
                  {option.description !== undefined && <span className="text-xs text-muted-foreground">{option.description}</span>}
                </button>
              );
            })}
          </div>
          {question.allowFreeText && (
            <input
              type="text"
              aria-label="Or type your own answer"
              placeholder="Or type your own answer"
              maxLength={MAX_FREE_TEXT}
              value={typed[question.id] ?? ""}
              disabled={busy}
              onChange={(event) => setTyped((current) => ({ ...current, [question.id]: event.target.value }))}
              className={FIELD}
            />
          )}
        </fieldset>
      )}
      {error !== null && <p role="alert" className="text-xs text-destructive-text">{error}</p>}
      <div className="flex flex-wrap items-center gap-2 border-t border-border-seam pt-2">
        {paged && (
          <button type="button" className={BUTTON} disabled={!reviewing && index === 0} onClick={() => (reviewing ? setReviewing(false) : setIndex(index - 1))}>
            Back
          </button>
        )}
        {paged && (
          <span className="text-xs text-muted-foreground">
            {answered} of {questions.length} answered
          </span>
        )}
        <span className="ml-auto flex flex-wrap gap-2">
          {recommendedLeft && !reviewing && (
            <button type="button" className={BUTTON} title="Picks the option the planner recommends for every question you have not answered" onClick={pickRecommended}>
              {paged ? "Use the recommended answers for the rest" : "Use the recommended answer"}
            </button>
          )}
          {!paged || reviewing ? (
            <button type="button" className={BUTTON_PRIMARY} disabled={busy || answered < questions.length} onClick={submit}>
              {sendLabel}
            </button>
          ) : index === questions.length - 1 ? (
            <button type="button" className={BUTTON_PRIMARY} onClick={() => setReviewing(true)}>
              Review answers
            </button>
          ) : (
            <button type="button" className={BUTTON_PRIMARY} onClick={() => setIndex(index + 1)}>
              Next
            </button>
          )}
        </span>
      </div>
    </section>
  );
}
