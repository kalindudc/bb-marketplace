import type { RowState } from "./status";

export const SPIN_STEPS = 12;
export const SPIN_STEP_MS = 92;
const spinners = new Set<HTMLElement>();
let spinStep = 0;
let spinTimer: ReturnType<typeof setInterval> | undefined;

function stepSpinners() {
  spinStep = (spinStep + 1) % SPIN_STEPS;
  for (const spinner of spinners) spinner.style.transform = `rotate(${spinStep * 360 / SPIN_STEPS}deg)`;
}

// One shared timer steps every running spinner; switchboard.css says why this is not a CSS animation.
function startSpinning(spinner: HTMLElement) {
  spinners.add(spinner);
  spinTimer ??= setInterval(stepSpinners, SPIN_STEP_MS);
  return () => {
    spinners.delete(spinner);
    if (spinners.size === 0) { clearInterval(spinTimer); spinTimer = undefined; }
  };
}

export function StatusGlyph(props: { state: RowState; label: string; spin?: boolean; className?: string }) {
  const { state, label, spin, className = "" } = props;
  const colour = {
    failed: "text-destructive", needs: "text-warning", running: "text-primary",
    unread: "text-sidebar-foreground", idle: "text-subtle-foreground",
  }[state];
  const icon = <svg role="img" aria-label={label} viewBox="0 0 16 16" width="14" height="14"
    className={`shrink-0 ${colour} ${className}`}>
    {state === "running" && <>
      <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeOpacity=".28" strokeWidth="1.6" />
      <path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </>}
    {state === "needs" && <>
      <circle cx="8" cy="8" r="6.2" fill="currentColor" />
      <path d="M6.3 6.2a1.75 1.75 0 1 1 2.5 1.6c-.5.25-.8.6-.8 1.1v.35"
        fill="none" stroke="var(--background)" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="8" cy="11.5" r=".95" fill="var(--background)" />
    </>}
    {state === "failed" && <>
      <circle cx="8" cy="8" r="6.2" fill="currentColor" />
      <path d="M5.8 5.8l4.4 4.4m0-4.4-4.4 4.4" stroke="var(--background)" strokeWidth="1.6" strokeLinecap="round" />
    </>}
    {state === "unread" && <circle cx="8" cy="8" r="3.7" fill="currentColor" />}
    {state === "idle" && <circle cx="8" cy="8" r="3.3" fill="none" stroke="currentColor" strokeWidth="1.3" />}
  </svg>;
  return state === "running" && spin ?
    <span ref={startSpinning} className="sb-spin inline-grid size-[14px] shrink-0 place-items-center text-primary">{icon}</span> : icon;
}
