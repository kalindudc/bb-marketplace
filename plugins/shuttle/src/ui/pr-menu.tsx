import { toast } from "sonner";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { PrAction, PrView } from "../contract";
import { useActions } from "./actions";
import { BUTTON_OFF, BUTTON_ON, ICON_GHOST, ICON_GHOST_LARGE, ICON_GHOST_LARGE_ON } from "./common";
import { Picker, PickerAction, PickerGroup, PickerSeparator } from "./picker";
import { isLive } from "./pills";

/** Copies text and says what was copied; a browser that refuses says so instead. */
export function copy(text: string, what: string): void {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (clipboard === undefined) return void toast.error("This browser does not let Shuttle copy");
  clipboard.writeText(text).then(() => toast.success(`Copied ${what}.`), () => toast.error(`Could not copy ${what}.`));
}

export function TrackButton({ pr, iconOnly = false }: { pr: PrView; iconOnly?: boolean }) {
  const { writes } = useActions();
  const label = pr.tracked ? "Tracked" : "Track";
  return (
    <button type="button" aria-pressed={pr.tracked} aria-label={label} title="Keep it in Reviews › Tracked; changes show in your Inbox"
      className={iconOnly ? (pr.tracked ? ICON_GHOST_LARGE_ON : ICON_GHOST_LARGE) : pr.tracked ? BUTTON_ON : BUTTON_OFF}
      onClick={() => void writes.setTracked(pr, !pr.tracked)}>
      <Icon name="Pin" className="size-3.5" aria-hidden />
      {!iconOnly && label}
    </button>
  );
}

const STATE_ACTIONS: { action: Extract<PrAction, "ready" | "draft" | "close" | "reopen">; label: string; icon: string; when(pr: PrView): boolean; danger?: true }[] = [
  { action: "ready", label: "Ready for review", icon: "Check", when: (pr) => pr.state === "draft" },
  { action: "draft", label: "Convert to draft", icon: "GitPullRequestDraft", when: (pr) => pr.state === "open" },
  { action: "close", label: "Close pull request", icon: "GitPullRequestClosed", when: (pr) => isLive(pr), danger: true },
  { action: "reopen", label: "Reopen", icon: "RotateCcw", when: (pr) => pr.state === "closed" },
];

/** Everything that does not need a place on screen: copying, tracking, snoozing, threads, reviews, and your PR's state. */
export function PrMenu({ pr, triggerClassName = ICON_GHOST }: { pr: PrView; triggerClassName?: string }) {
  const actions = useActions();
  const live = isLive(pr);
  const states = pr.mine ? STATE_ACTIONS.filter((entry) => entry.when(pr) && pr.actions.includes(entry.action)) : [];
  const missing = pr.mine ? STATE_ACTIONS.filter((entry) => entry.when(pr) && !pr.actions.includes(entry.action)) : [];
  return (
    <Picker phone={actions.phone} title="More" triggerLabel={`More for ${pr.repo}${pr.sep}${pr.number}`} triggerClassName={triggerClassName}
      trigger={<Icon name="MoreHorizontal" className="size-4" aria-hidden />}>
      <PickerAction onSelect={() => copy(pr.url, "the link")}><Icon name="Link" className="size-3.5" aria-hidden />Copy link</PickerAction>
      <PickerAction onSelect={() => copy(pr.key, pr.key)}><Icon name="Copy" className="size-3.5" aria-hidden />Copy key</PickerAction>
      {pr.headRef !== null && <PickerAction onSelect={() => copy(pr.headRef!, "the branch name")}><Icon name="GitBranch" className="size-3.5" aria-hidden />Copy branch name</PickerAction>}
      <PickerAction onSelect={() => actions.open(pr)}><Icon name="ExternalLink" className="size-3.5" aria-hidden />Open on {pr.serverName}</PickerAction>
      <PickerSeparator />
      {!pr.mine && (
        <PickerAction onSelect={() => void actions.writes.setTracked(pr, !pr.tracked)}><Icon name="Pin" className="size-3.5" aria-hidden />{pr.tracked ? "Stop tracking" : "Track"}</PickerAction>
      )}
      {live && pr.snoozedUntil === null && (
        <>
          <PickerAction onSelect={() => void actions.writes.setSnooze(pr, "tomorrow")}><Icon name="Clock" className="size-3.5" aria-hidden />Snooze until tomorrow</PickerAction>
          <PickerAction onSelect={() => void actions.writes.setSnooze(pr, "update")}><Icon name="Clock" className="size-3.5" aria-hidden />Snooze until it changes</PickerAction>
        </>
      )}
      {live && pr.snoozedUntil !== null && (
        <PickerAction onSelect={() => void actions.writes.setSnooze(pr, null)}><Icon name="Clock" className="size-3.5" aria-hidden />Bring back to the Inbox</PickerAction>
      )}
      <PickerAction onSelect={() => actions.link(pr)}><Icon name="Link" className="size-3.5" aria-hidden />Link a thread…</PickerAction>
      {!pr.mine && live && <PickerAction onSelect={() => actions.startReview(pr)}><Icon name="Play" className="size-3.5" aria-hidden />Start an AI review…</PickerAction>}
      {(states.length > 0 || missing.length > 0) && <PickerSeparator />}
      {states.map((entry) => (
        <PickerAction key={entry.action} danger={entry.danger === true} onSelect={() => actions.edits.apply(pr, { kind: entry.action })}>
          <Icon name={entry.icon} className="size-3.5" aria-hidden />{entry.label}
        </PickerAction>
      ))}
      {missing.length > 0 && <PickerGroup>{pr.serverName} can't {missing.map((entry) => entry.label.toLowerCase()).join(" or ")}</PickerGroup>}
    </Picker>
  );
}
