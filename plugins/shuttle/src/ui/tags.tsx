import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { ConversationItem, PrView } from "../contract";
import type { Tone } from "./common";

const TAG_TONES: Record<Tone, string> = {
  neutral: "border-border text-muted-foreground",
  ok: "border-success/25 text-success",
  bad: "border-surface-destructive-border text-destructive-text",
  warn: "border-warning/20 text-warning-text",
  info: "border-border bg-surface-raised text-foreground",
  brand: "border-border text-foreground",
};

export interface TagLook {
  tone: Tone;
  text: string;
  icon?: string;
}

const approval = (item: ConversationItem) => item.kind === "review" && /approv/iu.test(item.state ?? "");
/** Feedback someone else left that still asks for something. */
export const isFeedback = (item: ConversationItem) => !item.mine && !item.resolved && !approval(item);

/** What happened to an item on your PR: what the agent did with it, whether it was sent, or that nothing could take it. */
export function tagOf(pr: PrView, item: ConversationItem): TagLook | null {
  if (!pr.mine) return null;
  const outcome = item.outcome;
  if (outcome !== null) {
    if (outcome.outcome === "fixed") return { tone: "ok", icon: "GitCommit", text: outcome.commit ? `Fixed in ${outcome.commit.slice(0, 7)}` : "Fixed" };
    if (outcome.outcome === "replied") return { tone: "ok", text: "Agent replied" };
    if (outcome.outcome === "declined") return { tone: "neutral", text: "Declined" };
    return { tone: "warn", text: "Agent asks" };
  }
  if (item.delivery === "sent") return { tone: "info", text: "Sent to agent" };
  if (item.delivery === "pending") return { tone: "neutral", text: "Sending soon" };
  if (pr.agent === null && isFeedback(item)) return { tone: "warn", text: "Not sent · no agent" };
  return null;
}

export function Tag({ tag }: { tag: TagLook }) {
  return (
    <span data-tag className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 text-[10.5px] leading-[17px] ${TAG_TONES[tag.tone]}`}>
      {tag.icon && <Icon name={tag.icon} fallback="Circle" className="size-3" aria-hidden />}{tag.text}
    </span>
  );
}
