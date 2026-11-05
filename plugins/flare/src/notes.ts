import { KIND_LABELS } from "./kinds";
import type { FlareRow } from "./store";

// Flare's dispatch hook recognizes its own notes by these prefixes and never lets one start a turn.
export const FORWARD_PREFIX = "[Flare from a child thread]";
export const NUDGE_PREFIX = "[Flare reminder]";

export function forwardText(flare: Pick<FlareRow, "threadId" | "kind" | "title" | "body">, childTitle: string | null): string {
  const from = childTitle === null ? `@thread:${flare.threadId}` : `"${childTitle}" (@thread:${flare.threadId})`;
  const lines = [`${FORWARD_PREFIX} ${from} sent a ${KIND_LABELS[flare.kind].toLowerCase()}: ${flare.title}`];
  if (flare.body !== "") lines.push("", flare.body);
  lines.push("", "The child is still working and needs no reply. Use this if it changes your plan; otherwise carry on.");
  return lines.join("\n");
}

/** `again` when the turn already had a flare or a reminder, so the quiet time counts from that and not the start. */
export function nudgeText(minutes: number, again: boolean): string {
  return [
    again
      ? `${NUDGE_PREFIX} This turn has gone ${minutes} minutes since its last flare or reminder.`
      : `${NUDGE_PREFIX} This turn has run for ${minutes} minutes without a flare.`,
    "If you have a finding, a decision or a blocker the user should see now, send it with the flare tool (or `bb flare send`), then keep working.",
    "If there is nothing new, ignore this and carry on. Do not reply to this reminder.",
  ].join(" ");
}

export const TOOL_DESCRIPTION =
  "Send up a flare: a short note the user sees right away, while you keep working, in a banner above the message box and the thread's Flares tab. It returns at once and nothing replies, so your turn carries on.";

export const TOOL_INSTRUCTIONS = `# Flare
\`flare\` posts a short note the user sees while you keep working: a banner above the message box, the thread's Flares tab and, for blockers, a push notification. It is fire and forget: it returns at once, nothing replies, and your turn carries on. Never wait for an answer and never end your turn because you sent one.

Send a flare when:
- the user asked for updates, findings or a summary as you go, or the task will take more than a few minutes;
- you confirmed something the user would want to know now, such as a root cause, a number or a failing test;
- you made a decision they might want to redirect, such as an approach, a trade-off or a part you skipped;
- you are blocked or working around something, such as missing access or a failing service (kind "blocker");
- you finished a phase of a long task (kind "progress", or "summary" for a wrap-up).

Write for someone glancing over: the title is one line that stands on its own, about 80 characters; the body is optional Markdown with the evidence (paths, numbers, commands), a few lines at most. Send one flare per real event; one to five in a long turn is typical. Do not flare routine steps such as reading a file.

Kinds: finding (the default), progress, decision, blocker, summary. Set notify to true only for something the user must see now; blockers notify on their own.

A flare does not replace your final answer. End the turn with your full answer as usual; you may point to earlier flares there instead of repeating them.

If the result says the flare was not sent, carry on with your work and send it again later, once, if it still matters. Never stop or loop over it. \`flare_list\` reads the flares already sent in this thread, for example after your context was compacted. Without the tool, \`bb flare send "<title>" --body "<markdown>" --kind <kind>\` does the same.`;

export const SENT = "Flare sent. Keep working; nothing will reply.";
export const DUPLICATE = "That flare was already sent a moment ago, so it went only once. Keep working.";
export const notSaved = (reason: string): string =>
  `The flare was not saved (${reason}). Carry on with your work, and send it again later if it still matters.`;
