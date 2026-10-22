import { BUTTON_PRIMARY, CARD, HEADING } from "./common";

const STEPS: ReadonlyArray<[string, string]> = [
  ["Plan.", "A planner agent asks you a few questions, reads the code and writes a spec: tickets with acceptance criteria, the checks that must pass, and how work merges."],
  ["Approve.", "You read the spec here and approve it. The tickets appear on the board. Nothing runs before this."],
  ["Start.", "Workers pick up ready tickets, each in its own git worktree, only when dependencies are done and files do not overlap."],
  ["Check and review.", "Loom runs your check commands. Separate reviewer agents approve or send numbered findings back."],
  ["Merge and land.", "Approved work merges into one integration branch (you read it on the Changes tab, then land it as one pull request or straight onto the base branch) or opens one pull request per ticket."],
];

const ROLES: ReadonlyArray<[string, string]> = [
  ["You", "approve the spec, start, pause, answer blocked tickets, land"],
  ["Planner", "writes the spec, answers blocked tickets in triage"],
  ["Workers", "one per ticket; note, submit, or block"],
  ["Reviewers", "approve or request changes, on their own model"],
  ["Loom", "moves tickets, runs checks, merges; agents never push"],
];

const LIFE = ["queued", "working", "checking", "review", "approved", "merging", "done"];
const TERMINAL = ["bb loom list", "bb loom approve <slug>", "bb loom start <slug>", "bb loom metrics <slug>"];

/** The five steps from a goal to merged work. */
export function GuideSteps() {
  return (
    <ol className="space-y-2.5">
      {STEPS.map(([title, text], index) => (
        <li key={title} data-guide-step className="flex gap-2.5 text-sm">
          <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border-seam text-[11px] text-muted-foreground">{index + 1}</span>
          <span>
            <b>{title}</b> <span className="text-muted-foreground">{text}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** What Loom is, who does what, and the way into a first project. */
export function Guide({ onStart }: { onStart(): void }) {
  return (
    <div data-guide className="grid gap-4 p-4 lg:grid-cols-[1.4fr_1fr]">
      <section className={`${CARD} space-y-3`}>
        <h2 className={HEADING}>Welcome to Loom</h2>
        <p className="text-sm">
          Loom runs a software project with agents. You describe the goal; a planner turns it into a ticket board; workers build tickets in their own worktrees; separate reviewers check the work; Loom merges what passes. You stay in control: nothing starts until you
          approve, and nothing is pushed until you land.
        </p>
        <GuideSteps />
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <button type="button" className={BUTTON_PRIMARY} onClick={onStart}>
            Start your first project
          </button>
          <span className="text-xs text-muted-foreground">Takes about 5 minutes of questions with the planner.</span>
        </div>
      </section>
      <div className="grid content-start gap-4">
        <section className={CARD}>
          <h2 className={HEADING}>Who does what</h2>
          <table className="mt-2 w-full text-sm">
            <tbody>
              {ROLES.map(([who, what]) => (
                <tr key={who}>
                  <td className="py-0.5 pr-3 align-top font-medium">{who}</td>
                  <td className="py-0.5 text-muted-foreground">{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className={CARD}>
          <h2 className={HEADING}>A ticket's life</h2>
          <p className="mt-2 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            {LIFE.map((state, index) => (
              <span key={state} className="flex items-center gap-1">
                {index > 0 && <span aria-hidden>→</span>}
                <span className="rounded-full border border-border-seam px-2 py-0.5">{state}</span>
              </span>
            ))}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">Failed checks and requested changes go back to working. A stuck ticket is blocked until the planner or you answer it.</p>
        </section>
        <details className={CARD}>
          <summary className="cursor-pointer text-sm">Prefer the terminal?</summary>
          <pre className="mt-2 text-xs leading-relaxed">{TERMINAL.join("\n")}</pre>
        </details>
      </div>
    </div>
  );
}
