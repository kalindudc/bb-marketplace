// The project line: one row over every project view. The state pill opens the state's facts with Pause or Resume; then who
// is working and what it cost; then the next step, led by the one action that moves the project. Rewound, the line says
// when the page shows and how to come back.
import { experimental_DetailRow as DetailRow, experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { BoardCard, ProjectView } from "../contract";
import { compactCount, formatDuration, isMultiRepoProject, plural } from "../format";
import { PAUSE_NOW_REASON } from "../states";
import { ActionButton, BUTTON, ConfirmButton } from "./common";
import { controlsOf, leadOf, offerTarget, useControl, type ControlOffer } from "./controls";
import { Disclosure, KBD } from "./kit";
import { SettingPaths } from "./next-step-bar";
import { startsText } from "./gate";
import { useUnread } from "./spec-read";
import { momentWhen, tellingLine, type Moments } from "./time-ruler";
import type { View } from "./views";

const STATE_WORDS: Record<string, string> = { draft: "Draft", ready: "Ready", running: "Running", paused: "Paused", done: "Done", archived: "Archived" };

/** "Paused by Loom" when Loom paused it for a reason of its own, such as a spent budget. */
export function stateWord(overview: ProjectView["overview"]): string {
  if (overview.state === "paused" && overview.reason !== null && overview.reason !== PAUSE_NOW_REASON) return "Paused by Loom";
  return STATE_WORDS[overview.state] ?? overview.state;
}

function StateMark({ state }: { state: string }) {
  if (state === "running") return <span aria-hidden className="size-2 shrink-0 rounded-full bg-primary shadow-[0_0_6px_color-mix(in_oklab,var(--primary)_70%,transparent)]" />;
  if (state === "paused") return <Icon name="Pause" aria-hidden className="size-3 shrink-0 text-foreground" />;
  if (state === "done") return <Icon name="CircleCheck" aria-hidden className="size-3 shrink-0 text-success" />;
  if (state === "archived") return <Icon name="Archive" aria-hidden className="size-3 shrink-0 text-[var(--loom-muted)]" />;
  return <span aria-hidden className="size-2 shrink-0 rounded-full border border-foreground" />;
}

/** Slots as rings, filled while an agent holds one. */
function Slots({ used, max, role }: { used: number; max: number; role: string }) {
  const shown = Math.min(max, 6);
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span aria-hidden className="inline-flex gap-[3px]">
        {Array.from({ length: shown }, (_, index) => (
          <span key={index} className={`size-[9px] rounded-full border-[1.5px] ${index < used ? "border-primary bg-[color-mix(in_oklab,var(--primary)_35%,transparent)]" : "border-[var(--loom-muted)]"}`} />
        ))}
      </span>
      <span className="loom-num">
        {used}/{max} {role}
      </span>
    </span>
  );
}

function Facts({ view }: { view: ProjectView }) {
  const capacity = view.health?.capacity ?? null;
  const budget = view.health?.budget ?? null;
  const tokens = view.metrics.tokens.total;
  return (
    <span data-project-facts className="flex min-w-0 items-center gap-3 overflow-hidden text-xs whitespace-nowrap text-[var(--loom-muted)] @max-2xl/loom:hidden">
      {capacity !== null && <Slots used={capacity.workers} max={capacity.maxWorkers} role="workers" />}
      {capacity !== null && capacity.maxReviewers > 0 && <Slots used={capacity.reviewers} max={capacity.maxReviewers} role="reviewers" />}
      {isMultiRepoProject(view.overview) && (
        <span className="inline-flex items-center gap-1">
          <Icon name="FolderGit" aria-hidden className="size-3.5" />
          {plural(view.overview.repos.length, "repo")}
        </span>
      )}
      <span>{view.overview.strategy === "integration" ? "integration branch" : "PR per ticket"}</span>
      <span className="loom-num">
        {compactCount(budget?.used ?? tokens)}
        {budget !== null && ` of ${compactCount(budget.max)}`} tokens
      </span>
    </span>
  );
}

/** The state pill: its facts on hover, focus or a tap, with the one-click Pause or Resume. */
function StatePill({ view, rewound }: { view: ProjectView; rewound: boolean }) {
  const { overview } = view;
  const { busy, run } = useControl(overview.slug);
  const word = stateWord(overview);
  const capacity = view.health?.capacity ?? null;
  const budget = view.health?.budget ?? null;
  const offers = controlsOf(view).filter((offer) => offer.action === "pause" || offer.action === "pauseNow" || offer.action === "resume");
  const trigger = (
    <button type="button" data-state-pill={overview.state} aria-label={`${word}: details`} className="inline-flex h-7 shrink-0 @max-xl/loom:min-h-11 pointer-coarse:min-h-11 cursor-pointer items-center gap-1.5 rounded-full border border-[var(--loom-line)] bg-[var(--loom-card)] px-2.5 text-xs font-semibold text-foreground hover:bg-state-hover">
      <StateMark state={overview.state} />
      {word}
      <Icon name="ChevronDown" aria-hidden className="size-3 text-[var(--loom-muted)]" />
    </button>
  );
  return (
    <Disclosure trigger={trigger} label={`${overview.name}: ${word}`} hover className="w-80">
      {(close) => (
        <div data-state-card className="space-y-1.5 text-[13px]">
          <div className="flex items-center gap-2 font-semibold">
            <StateMark state={overview.state} />
            {word}
          </div>
          {overview.reason !== null && overview.reason !== PAUSE_NOW_REASON && overview.state === "paused" && <p className="text-xs text-foreground [overflow-wrap:anywhere]">{overview.reason}</p>}
          <DetailRow label="Since" icon="Clock">
            {momentWhen(overview.updatedAt)}
          </DetailRow>
          {capacity !== null && (
            <DetailRow label="Workers" icon="Bot">
              <Slots used={capacity.workers} max={capacity.maxWorkers} role="working" />
            </DetailRow>
          )}
          {capacity !== null && capacity.maxReviewers > 0 && (
            <DetailRow label="Reviewers" icon="SecurityCheck">
              <Slots used={capacity.reviewers} max={capacity.maxReviewers} role="reviewing" />
            </DetailRow>
          )}
          <DetailRow label="Tokens" icon="Limitation">
            <span className="loom-num">
              {compactCount(budget?.used ?? view.metrics.tokens.total)}
              {budget !== null && ` of ${compactCount(budget.max)}`}
            </span>
          </DetailRow>
          {offers.length > 0 && !rewound && (
            <div className="flex flex-wrap justify-end gap-1.5 pt-1.5">
              {offers.map((offer) => (
                <ActionButton
                  key={offer.action}
                  label={offer.label}
                  title={offer.hint}
                  icon={<Icon name={offer.icon} aria-hidden className="size-3.5" />}
                  disabled={busy}
                  onClick={() => {
                    close();
                    void run(offer.action);
                  }}
                />
              ))}
            </div>
          )}
          {offers.some((offer) => offer.action === "pauseNow") && !rewound && <p className="text-right text-[11px] text-[var(--loom-muted)]">Pause: workers finish their turn · Pause now: stops them at once</p>}
        </div>
      )}
    </Disclosure>
  );
}

/** The oldest blocked ticket that is not the one open, which the line asks the person to answer. */
function askingOf(board: readonly BoardCard[], open: string | null): BoardCard | null {
  return [...board].filter((card) => card.state === "blocked" && card.key !== open).sort((a, b) => a.stateAt - b.stateAt)[0] ?? null;
}

function LeadControl({ view, offer }: { view: ProjectView; offer: ControlOffer }) {
  const { busy, run } = useControl(view.overview.slug);
  // A version the Spec view could not read is approved unseen, and the armed button says so.
  const unread = useUnread(view.overview.slug);
  const act = () => void run(offer.action, offer.version);
  if (offer.yes === null) return <ActionButton primary className="loom-lead" label={offer.label} title={offer.hint} disabled={busy} onClick={act} />;
  const yes = offer.action === "approve" && offer.version !== undefined && unread.has(offer.version) ? `Yes, approve v${offer.version} unread` : offer.yes;
  return <ConfirmButton primary lead label={offer.label} confirmLabel={yes} disarmKey={offerTarget(offer)} disabled={busy} onConfirm={act} />;
}

/** The next step in words. Beside a lead button, which names the step already, it is an info button that opens the why. */
function NextStepText({ view, withLead }: { view: ProjectView; withLead: boolean }) {
  const next = view.next;
  if (next === null) return null;
  const repos = view.overview.repos.flatMap((repo) => (repo.name === null ? [] : [repo.name]));
  const title = next.title.replace(/^Next: /, "").replace(/\.$/, "");
  const trigger = withLead ? (
    <button type="button" data-next-title aria-label={`Why: ${title}`} className="inline-flex size-7 shrink-0 @max-xl/loom:size-11 pointer-coarse:size-11 cursor-pointer items-center justify-center rounded-md text-[var(--loom-muted)] hover:bg-state-hover hover:text-foreground">
      <Icon name="Info" aria-hidden className="size-4" />
    </button>
  ) : (
    <button type="button" data-next-title className={`min-w-0 cursor-pointer truncate text-left text-xs @max-xl/loom:min-h-11 pointer-coarse:min-h-11 underline decoration-dotted underline-offset-4 ${next.tone === "warning" ? "font-semibold text-foreground" : "text-[var(--loom-muted)]"}`}>
      {title}
    </button>
  );
  return (
    <Disclosure trigger={trigger} label="Next step" hover align="end" className="w-96">
      <div data-next-text className="space-y-1 text-[13px] [overflow-wrap:anywhere]" data-content>
        <p className="font-semibold">{next.title}</p>
        <p>{next.text}</p>
        {next.paths !== undefined && next.paths.length > 0 && <SettingPaths paths={next.paths} repos={repos} />}
      </div>
    </Disclosure>
  );
}

/** The next step: what moves the project, never pointing at the view or ticket already open (L16). */
function Next({ view, view: { overview }, current, openTicket, rewound, go, onView, onReviewChanges }: { view: ProjectView; current: View; openTicket: string | null; rewound: boolean; go(subPath: string): void; onView(view: View): void; onReviewChanges?: () => void }) {
  const lead = rewound ? null : leadOf(view);
  // A version that fills the next phase is approved on the gate, which says what it creates and starts; the line leads there.
  const gated = lead !== null && lead.action === "approve" && view.gate != null;
  const asking = askingOf(view.board, openTicket);
  // The ticket open below asks too: the line says so, without a second way to the same form.
  const here = asking === null && openTicket !== null ? (view.board.find((card) => card.key === openTicket && card.state === "blocked") ?? null) : null;
  const tone = view.next?.tone ?? "normal";
  return (
    <section data-next-step data-tone={tone} aria-label="Next step" className="ml-auto flex min-w-0 shrink items-center justify-end gap-2.5 @max-xl/loom:gap-1.5">
      {lead === null && asking !== null && !rewound && (
        <>
          <span className="inline-flex min-w-0 items-center gap-1.5 text-xs">
            <Icon name="AlertCircle" aria-hidden className="size-4 shrink-0 text-[var(--attention)]" />
            <b className="shrink-0">{asking.key}</b>
            <span className="truncate text-[var(--loom-muted)] @max-2xl/loom:hidden">asks · {formatDuration(view.now - asking.stateAt)}</span>
          </span>
          <ActionButton primary className="loom-lead" label="Answer" title={`Open ${asking.key} to answer it`} onClick={() => go(`${overview.slug}/${asking.key}`)} />
        </>
      )}
      {lead === null && here !== null && !rewound && (
        <span data-open-ask className="inline-flex min-w-0 items-center gap-1.5 text-xs">
          <Icon name="AlertCircle" aria-hidden className="size-4 shrink-0 text-[var(--attention)]" />
          <b className="shrink-0">{here.key}</b>
          <span className="truncate text-[var(--loom-muted)]">asks · answer below</span>
        </span>
      )}
      {(lead !== null || (asking === null && here === null)) && !(gated && current === "spec") && <NextStepText view={view} withLead={lead !== null && !gated} />}
      {gated && current !== "spec" && (
        <>
          <span data-gate-facts className="hidden shrink-0 text-xs text-[var(--loom-muted)] @2xl/loom:inline">
            v{view.gate!.version} · {plural(view.gate!.proposed.tickets.length, "ticket")} · {view.overview.state === "paused" || view.gate!.holdUntil !== null ? "none start" : startsText(view.gate!.startNow, "now")}
          </span>
          <ActionButton primary className="loom-lead" label="Open the gate" title={`Read v${view.gate!.version} beside what the last phase recorded, then approve it there`} onClick={() => onView("spec")} />
        </>
      )}
      {lead !== null && !gated && lead.action === "approve" && current !== "spec" && overview.state !== "draft" && (
        <button type="button" className={BUTTON} onClick={() => onView("spec")}>
          Read v{lead.version}
        </button>
      )}
      {lead !== null && lead.action === "land" && onReviewChanges !== undefined && (
        <button type="button" className={BUTTON} onClick={onReviewChanges}>
          Review changes
        </button>
      )}
      {lead !== null && !gated && <LeadControl view={view} offer={lead} />}
      {lead === null && asking === null && here === null && tone !== "warning" && !rewound && (
        <span className="inline-flex shrink-0 items-center gap-1 text-xs text-[var(--loom-muted)]">
          <Icon name="Check" aria-hidden className="size-3.5 text-success" />
          nothing needs you
        </span>
      )}
    </section>
  );
}

/** In place of the project line while the page is rewound: when it shows, what happened then, and the way back. */
function RewindLine({ moments, onNow }: { moments: Moments; onNow(): void }) {
  const shown = moments.shown;
  const line = shown === null ? null : tellingLine(shown);
  return (
    <section data-rewind-bar aria-label="Rewound" className="loom-card loom-lit flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-1.5">
      <span role="status" className="flex min-w-0 flex-[1_1_15rem] items-center gap-2.5 text-sm">
        <Icon name="Clock" aria-hidden className="size-4 shrink-0 text-[var(--loom-link)]" />
        <b className="loom-num shrink-0">{shown === null ? "Rewound" : momentWhen(shown.at)}</b>
        {line !== undefined && line !== null && <span className="min-w-0 truncate text-[var(--loom-muted)]">{line.text}</span>}
        <span className="shrink-0 rounded-full border border-[var(--loom-line)] px-2 text-[11px] leading-5 text-foreground">read-only</span>
      </span>
      <span className="inline-flex items-center gap-2">
        <button type="button" className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-semibold @max-xl/loom:min-h-11 pointer-coarse:min-h-11 text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1" onClick={onNow}>
          Back to now
        </button>
        <kbd className={KBD}>Esc</kbd>
      </span>
    </section>
  );
}

export function ProjectLine({ view, moments, current, openTicket, go, onView, onReviewChanges }: { view: ProjectView; moments: Moments; current: View; openTicket: string | null; go(subPath: string): void; onView(view: View): void; onReviewChanges?: () => void }) {
  const rewound = moments.shown !== null || view.at !== null;
  if (rewound) return <RewindLine moments={moments} onNow={() => moments.seekPosition(moments.nowPosition)} />;
  return (
    <div data-project-line className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1.5 py-1.5 @max-xl/loom:gap-x-2">
      <StatePill view={view} rewound={rewound} />
      <Facts view={view} />
      <Next view={view} current={current} openTicket={openTicket} rewound={rewound} go={go} onView={onView} onReviewChanges={onReviewChanges} />
    </div>
  );
}
