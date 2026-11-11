import { useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { AutomationPause, Overview } from "../contract";
import { BUTTON, BUTTON_GHOST, BUTTON_PRIMARY, Dialog, ErrorNote, FIELD } from "./common";
import { messageOf, useShuttleMutation } from "./data";

const DAY = 86_400_000;
type Duration = "today" | "day" | "week" | "custom" | "indefinite";

const resumeTime = (until: number) => new Date(until).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function AutomationPauseControls({ overview }: { overview: Overview }) {
  const pause = useShuttleMutation("setAutomationPause");
  const [open, setOpen] = useState(false);
  const [duration, setDuration] = useState<Duration>("today");
  const [custom, setCustom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const customUntil = new Date(custom).getTime();
  const invalidCustom = duration === "custom" && (!Number.isFinite(customUntil) || customUntil <= Date.now());
  const change = async (input: AutomationPause) => {
    setError(null);
    try {
      await pause.mutate(input);
      setOpen(false);
    } catch (error) {
      setError(messageOf(error));
    }
  };
  const submit = () => {
    if (invalidCustom || pause.isPending) return;
    if (duration === "indefinite") return change({ mode: "indefinite" });
    const tomorrow = new Date();
    tomorrow.setHours(24, 0, 0, 0);
    const until = duration === "today" ? tomorrow.getTime() : duration === "custom" ? customUntil : Date.now() + (duration === "week" ? 7 : 1) * DAY;
    return change({ mode: "until", until });
  };
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className={`flex items-center gap-1.5 ${overview.paused ? "text-warning-text" : "text-muted-foreground"}`}>
        <Icon name={overview.paused ? "Pause" : "Bot"} fallback="Circle" className="size-3.5 shrink-0" aria-hidden />
        <span>{overview.paused ? "Automations paused" : "Automations on"}</span>
      </div>
      {overview.paused && (
        <div className="text-muted-foreground" role="status">
          {overview.pauseUntil === null ? "Until you resume" : <>Resumes <time dateTime={new Date(overview.pauseUntil).toISOString()}>{resumeTime(overview.pauseUntil)}</time></>}
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        {overview.paused && <button type="button" className={BUTTON} disabled={pause.isPending} onClick={() => void change({ mode: "resume" })}>Resume now</button>}
        <button type="button" className={BUTTON_GHOST} disabled={pause.isPending} onClick={() => { setError(null); setDuration("today"); setCustom(""); setOpen(true); }}>
          {overview.paused ? "Change pause" : "Pause automations"}
        </button>
      </div>
      {!open && error !== null && <ErrorNote>{error}</ErrorNote>}
      {open && (
        <Dialog title="Pause automations" subtitle="New automatic reviews, auto posting, agent assignment and feedback delivery stop. Lists keep syncing. Manual actions and already-running threads continue."
          onClose={() => { if (!pause.isPending) setOpen(false); }}>
          <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <label className="flex flex-col gap-1 text-sm">
              Pause for
              <select className={FIELD} value={duration} disabled={pause.isPending} onChange={(event) => { setDuration(event.target.value as Duration); setError(null); }}>
                <option value="today">For today</option>
                <option value="day">For 24 hours</option>
                <option value="week">For 1 week</option>
                <option value="custom">Until a date and time</option>
                <option value="indefinite">Until I resume</option>
              </select>
            </label>
            {duration === "custom" && (
              <label className="flex min-w-0 flex-col gap-1 text-sm">
                Resume at
                <input type="datetime-local" className={`${FIELD} min-w-0 max-w-full`} value={custom} disabled={pause.isPending}
                  onChange={(event) => { setCustom(event.target.value); setError(null); }} />
              </label>
            )}
            {invalidCustom && custom !== "" && <div role="status" className="text-xs text-warning-text">Choose a future date and time.</div>}
            <div className="text-xs text-muted-foreground">
              {duration === "today" ? "Resumes at midnight in your local time zone." : duration === "indefinite" ? "Stays paused until you resume it." : "Dates use your local time zone. If bb is closed at the return time, automation resumes when it reopens."}
            </div>
            {error !== null && <ErrorNote>{error}</ErrorNote>}
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className={BUTTON_GHOST} disabled={pause.isPending} onClick={() => setOpen(false)}>Cancel</button>
              <button type="submit" className={BUTTON_PRIMARY} disabled={pause.isPending || invalidCustom}>{pause.isPending ? "Saving…" : "Pause automations"}</button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}
