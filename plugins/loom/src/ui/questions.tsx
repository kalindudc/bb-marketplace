import { useCallback, useEffect, useRef, useState } from "react";
import { experimental_useSidebarThreads, useBbNavigate, useSdk, type PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import { BUTTON, BUTTON_PRIMARY, CARD, FIELD, HEADING, messageOf } from "./common";

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

/** The planner's open plugin questions, which bb's embedded chat leaves out. Lists them only while the sidebar says the thread waits on the user. */
export function PlannerQuestions({ threadId }: { threadId: string }) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const waiting = experimental_useSidebarThreads().threads.find((thread) => thread.id === threadId)?.hasPendingInteraction === true;
  const [rows, setRows] = useState<PluginInteraction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(sdk);
  latest.current = sdk;

  // Bumped when the thread or its waiting flag changes and on unmount, so a late list response is dropped.
  const generation = useRef(0);
  const load = useCallback(() => {
    const asked = generation.current;
    latest.current.threads.interactions.list({ threadId }).then(
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

  if (rows.length === 0 && error === null) return null;
  return (
    <div className="space-y-3">
      {error !== null && <p role="alert" className="text-xs text-destructive-text">Could not read the planner's questions: {error}</p>}
      {rows.map((row) => {
        const questions = row.origin.rendererId === ASK_RENDERER_ID ? questionsOf(row.payload.data) : null;
        if (questions === null) {
          return (
            <section key={row.id} data-question-card={row.id} className={`${CARD} flex flex-wrap items-center gap-2`}>
              <h2 className="text-sm font-semibold">{row.payload.title}</h2>
              <button type="button" className={`${BUTTON} ml-auto`} onClick={() => navigate.toThread(threadId)}>
                Answer in the thread
              </button>
            </section>
          );
        }
        return <QuestionCard key={row.id} id={row.id} title={row.payload.title} questions={questions} send={(answers) => respond(row.id, answers)} />;
      })}
    </div>
  );
}

function QuestionCard({ id, title, questions, send }: { id: string; title: string; questions: AskQuestion[]; send(answers: Answers): Promise<void> }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textOf = (question: AskQuestion) => (typed[question.id] ?? "").trim();
  const answered = questions.every((question) => (picked[question.id] ?? []).length > 0 || textOf(question) !== "");

  const toggle = (question: AskQuestion, value: string) =>
    setPicked((current) => {
      const now = current[question.id] ?? [];
      const next = now.includes(value) ? now.filter((entry) => entry !== value) : question.multiSelect ? [...now, value] : [value];
      return { ...current, [question.id]: next };
    });

  // Stays disabled after a sent answer: the card goes away when the list no longer has the question.
  const submit = () => {
    setBusy(true);
    setError(null);
    const answers: Answers = Object.fromEntries(questions.map((question) => [question.id, { selected: picked[question.id] ?? [], ...(textOf(question) === "" ? {} : { freeText: textOf(question) }) }]));
    send(answers).catch((failure: unknown) => {
      setError(messageOf(failure));
      setBusy(false);
    });
  };

  return (
    <section data-question-card={id} className={`${CARD} space-y-3`}>
      <h2 className={HEADING}>{title}</h2>
      {questions.map((question) => (
        <fieldset key={question.id} className="space-y-2">
          <legend className="text-sm font-semibold">{question.prompt}</legend>
          <p className="text-xs text-muted-foreground">{question.shortLabel}</p>
          {question.context !== undefined && <p className="text-xs text-muted-foreground">{question.context}</p>}
          <div className="flex flex-wrap gap-2">
            {question.options.map((option) => {
              const on = (picked[question.id] ?? []).includes(option.value);
              return (
                <button key={option.value} type="button" aria-pressed={on} disabled={busy} onClick={() => toggle(question, option.value)} className={`${BUTTON} h-auto flex-col items-start py-1 text-left ${on ? "bg-surface-selected" : ""}`}>
                  <span className="flex items-center gap-1.5">
                    {option.label}
                    {option.recommended === true && <span className="rounded-sm bg-surface-selected px-1 text-[10px] text-muted-foreground">Recommended</span>}
                  </span>
                  {option.description !== undefined && <span className="text-[11px] text-muted-foreground">{option.description}</span>}
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
      ))}
      {error !== null && <p role="alert" className="text-xs text-destructive-text">{error}</p>}
      <button type="button" className={BUTTON_PRIMARY} disabled={busy || !answered} onClick={submit}>
        Send answer
      </button>
    </section>
  );
}
