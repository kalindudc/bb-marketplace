// Ship's Do next: the person's moves in order, each a row with its one action, and what holds the rest on one line.
// The steps come from do-next.ts, so a merge shows here only when the merge order and the rollout both allow it.
import { useState } from "react";
import { experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { ProjectView } from "../contract";
import { ActionButton, BUTTON, ConfirmButton, TAP, useAction, useLoomWrite } from "./common";
import { doNextOf, type DoNext, type DoStep } from "./ship-plan";
import { Disclosure } from "./kit";

const short = (sha: string) => sha.slice(0, 7);
const VERB: Record<DoStep["kind"], string> = { merge: "Merge", confirm: "Confirm merge", release: "Release draft", live: "Mark live" };
const KEY_LINK = "inline-flex min-h-6 @max-xl/loom:min-h-11 max-[576px]:min-h-11 @max-xl/loom:min-w-11 max-[576px]:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11 cursor-pointer items-center justify-center rounded font-mono text-xs font-semibold hover:text-[var(--loom-link)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function PrButtons({ step }: { step: DoStep }) {
  const navigate = useBbNavigate();
  if (step.prs.length === 0) return null;
  if (step.prs.length === 1) {
    const pr = step.prs[0]!;
    return (
      <button type="button" data-do-pr={pr.key} aria-label={`Open ${pr.key}'s pull request${pr.number === null ? "" : ` #${pr.number}`}`} className={BUTTON} onClick={() => navigate.openUrl(pr.url)}>
        <Icon name="ExternalLink" className="size-3.5" aria-hidden />
        {pr.number === null ? "PR" : `#${pr.number}`}
      </button>
    );
  }
  return (
    <Disclosure
      label={`${step.prs.length} pull requests`}
      align="end"
      className="w-64"
      trigger={
        <button type="button" data-do-prs={step.keys.join(",")} className={BUTTON}>
          <Icon name="ExternalLink" className="size-3.5" aria-hidden />
          {step.prs.length} PRs
        </button>
      }
    >
      {(close) => (
        <ul className="grid gap-0.5">
          {step.prs.map((pr) => (
            <li key={pr.key}>
              <button
                type="button"
                data-do-pr={pr.key}
                className={`flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${TAP}`}
                onClick={() => {
                  close();
                  navigate.openUrl(pr.url);
                }}
              >
                <span className="font-mono text-xs font-semibold">{pr.key}</span>
                <span className="text-[var(--loom-muted)]">{pr.number === null ? "pull request" : `#${pr.number}`}</span>
                <Icon name="ExternalLink" className="ml-auto size-3.5 text-[var(--loom-muted)]" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Disclosure>
  );
}

function StepAction({ slug, step, busy, act, onMarked }: { slug: string; step: DoStep; busy: boolean; act: ReturnType<typeof useAction>["act"]; onMarked(target: string): void }) {
  const confirmMerge = useLoomWrite("confirmMerge");
  const releaseDraft = useLoomWrite("releaseDraft");
  const markLive = useLoomWrite("markLive");
  const key = step.keys[0]!;
  if (step.kind === "confirm" && step.confirm !== null) {
    const { prUrl, sha } = step.confirm;
    return <ConfirmButton key={`${prUrl} ${sha}`} label="Confirm merge" confirmLabel={`Yes, merge ${short(sha)}`} primary disabled={busy} onConfirm={() => void act(() => confirmMerge({ key, prUrl, sha, confirm: true }), `${key} merge of ${short(sha)} confirmed`)} />;
  }
  if (step.kind === "release" && step.prs[0] !== undefined) {
    const prUrl = step.prs[0].url;
    return <ConfirmButton key={prUrl} label="Release draft" confirmLabel="Yes, mark it ready for review" disabled={busy} onConfirm={() => void act(() => releaseDraft({ key, prUrl, confirm: true }), `${key} released from draft`)} />;
  }
  if (step.kind === "live" && step.target !== null) {
    const target = step.target;
    return (
      <ActionButton
        label="Mark live"
        icon={<Icon name="RadioTower" className="size-3.5" aria-hidden />}
        title={`Marks ${target} live; Undo live takes it back`}
        disabled={busy}
        onClick={() => void act(() => markLive({ slug, target, confirm: true }), `Marked ${target} live`).then((ok) => ok && onMarked(target))}
      />
    );
  }
  return <PrButtons step={step} />;
}

function StepRow({ slug, step, number, busy, act, onMarked, onTicket }: { slug: string; step: DoStep; number: number; busy: boolean; act: ReturnType<typeof useAction>["act"]; onMarked(target: string): void; onTicket(key: string): void }) {
  const single = step.keys.length === 1;
  return (
    <li data-do-step={step.id} data-do-kind={step.kind} className="flex min-w-0 items-start gap-2.5 py-2 @max-xl/loom:flex-wrap">
      <span aria-hidden className="loom-num mt-0.5 inline-grid size-5 shrink-0 place-items-center rounded-full border border-[var(--loom-line)] text-[11px] font-semibold">
        {number}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-1.5 text-[13px]">
          {step.keys.map((key, index) => (
            <span key={key} className="shrink-0">
              <button type="button" aria-label={`Open ${key}`} className={`${KEY_LINK} ${TAP}`} onClick={() => onTicket(key)}>
                {key}
              </button>
              {index < step.keys.length - 1 && <span className="text-[var(--loom-muted)]">,</span>}
            </span>
          ))}
          {single && (
            <span data-content className="min-w-0 truncate" title={step.title}>
              {step.title}
            </span>
          )}
        </div>
        <p className="text-xs text-[var(--loom-muted)] [overflow-wrap:anywhere]">
          <span className="font-semibold text-foreground">{VERB[step.kind]}</span>
          {step.facts.length > 0 && ` · ${step.facts.join(" · ")}`}
        </p>
        {step.first !== null && (
          <p data-do-first className="text-xs [overflow-wrap:anywhere]">
            <span className="font-semibold">First:</span> <span className="text-[var(--loom-muted)]">{step.first}</span>
          </p>
        )}
        {step.then !== null && (
          <p data-do-then className="text-xs [overflow-wrap:anywhere]">
            <span className="font-semibold">Then</span> <span className="text-[var(--loom-muted)]">{step.then}</span>
          </p>
        )}
      </div>
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-1.5 @max-xl/loom:shrink @max-xl/loom:basis-full @max-xl/loom:pl-7.5">
        {(step.kind === "confirm" || step.kind === "release") && <PrButtons step={step} />}
        <StepAction slug={slug} step={step} busy={busy} act={act} onMarked={onMarked} />
      </div>
    </li>
  );
}

const HELD_SHOWN = 4;

/** What holds the rest, one reason a row with its tickets, the biggest groups first; the rest behind a count. */
function HeldList({ held, onTicket }: { held: DoNext["held"]; onTicket(key: string): void }) {
  const [all, setAll] = useState(false);
  const shown = all ? held : held.slice(0, HELD_SHOWN);
  const count = held.reduce((sum, group) => sum + group.keys.length, 0);
  return (
    <div data-do-held className="mt-1 border-t border-[var(--loom-line)] pt-2">
      <h3 className="mb-1 flex items-center gap-2 text-[11px] font-semibold tracking-wider text-[var(--loom-muted)] uppercase">
        Held
        <span className="loom-num rounded-sm border border-[var(--loom-line)] px-1 leading-4 tracking-normal text-foreground">{count}</span>
      </h3>
      <ul className="grid gap-y-0.5 text-xs">
        {shown.map((group) => (
          <li key={group.why} data-held-why={group.why} className="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)] items-baseline gap-x-3 @max-xl/loom:grid-cols-1">
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {group.keys.map((key, index) => (
                <span key={key}>
                  <button type="button" aria-label={`Open ${key}`} className={`${KEY_LINK} ${TAP}`} onClick={() => onTicket(key)}>
                    {key}
                  </button>
                  {index < group.keys.length - 1 && <span className="text-[var(--loom-muted)]">, </span>}
                </span>
              ))}
            </span>
            <span className="min-w-0 text-[var(--loom-muted)] [overflow-wrap:anywhere]">{group.why}</span>
          </li>
        ))}
      </ul>
      {held.length > HELD_SHOWN && (
        <button type="button" aria-expanded={all} className={`mt-1 cursor-pointer rounded text-xs text-[var(--loom-muted)] hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${TAP}`} onClick={() => setAll(!all)}>
          {all ? "Fewer" : `${held.length - HELD_SHOWN} more reasons`}
        </button>
      )}
    </div>
  );
}

/** Do next for a pull request project; nothing for one without a merge order. */
export function DoNextCard({ view, onTicket }: { view: ProjectView; onTicket(key: string): void }) {
  const slug = view.overview.slug;
  const plan = doNextOf(view);
  const { busy, act } = useAction();
  const markLive = useLoomWrite("markLive");
  // Steps marked live here keep a row with Undo live until the page leaves Ship; the next read drops them from the plan.
  const [marked, setMarked] = useState<readonly string[]>([]);
  if (plan === null) return null;
  const steps = plan.steps.filter((step) => !(step.kind === "live" && step.target !== null && marked.includes(step.target)));
  const onMarked = (target: string) => setMarked((before) => [...before.filter((one) => one !== target), target]);
  const undo = (target: string) => void act(() => markLive({ slug, target, undo: true, confirm: true }), `${target} is no longer marked live`).then((ok) => ok && setMarked((before) => before.filter((one) => one !== target)));
  return (
    <section data-do-next aria-labelledby="do-next-title" className="loom-card mb-3 rounded-md px-3 pt-2.5 pb-2">
      <div className="flex items-center gap-2">
        <h2 id="do-next-title" className="text-sm font-semibold">
          Do next
        </h2>
        <span className="loom-num rounded-sm border border-[var(--loom-line)] px-1 text-[11px] leading-4">{steps.length}</span>
        <span className="ml-auto text-[11px] text-[var(--loom-muted)] @max-xl/loom:hidden">from the merge order and the rollout</span>
      </div>
      {steps.length === 0 && marked.length === 0 ? (
        <p data-do-empty className="flex items-center gap-2 py-2 text-sm text-[var(--loom-muted)]">
          <Icon name="CircleCheck" className="size-4" aria-hidden />
          Nothing to merge or mark live now
        </p>
      ) : (
        <ol className="divide-y divide-[var(--loom-line)]">
          {steps.map((step, index) => (
            <StepRow key={step.id} slug={slug} step={step} number={index + 1} busy={busy} act={act} onMarked={onMarked} onTicket={onTicket} />
          ))}
          {marked.map((target) => (
            <li key={`marked:${target}`} data-do-marked={target} className="flex min-w-0 items-center gap-2.5 py-2">
              <Icon name="RadioTower" className="size-4 shrink-0 text-[var(--loom-ok)]" aria-hidden />
              <span className="min-w-0 flex-1 text-[13px]">
                <span className="font-mono text-xs font-semibold">{target}</span> <span className="text-[var(--loom-muted)]">marked live</span>
              </span>
              <ActionButton label="Undo live" title={`Takes ${target}'s live mark back`} disabled={busy} onClick={() => undo(target)} />
            </li>
          ))}
        </ol>
      )}
      {plan.held.length > 0 && <HeldList held={plan.held} onTicket={onTicket} />}
    </section>
  );
}
