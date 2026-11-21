import { readFileSync } from "node:fs";
import type { TavernEvent } from "../../shared/schema";
import { settled } from "../../shared/waypoint";
import { dataFence } from "../instructions";
import { isOpenQuest } from "../liveness";
import { routeQuestIds, type Keeper } from "./service";

const HEADINGS = {
  opening: ["Take a thin goal", "Scout"],
  scouts: ["Propose the map", "Size the party"],
  staffing: ["Staff the work", "Write a brief"],
  request: ["Decide a member's request"],
  check: ["Check the work"],
  stalled: ["Track progress"],
  steer: ["Handle a steer"],
  recovery: ["Recover after compaction"],
  tell: ["Tell the user"],
  close: ["Close a quest"],
  learn: ["Learn from a quest"],
} as const;
type Moment = keyof typeof HEADINGS;
export const MOMENT_CARD_BYTES = 1500;
export type KeeperCards = ReadonlyMap<string, string>;
export type MomentCard = { moment: Moment; questId: string | null };

export function renderKeeperCards(skill: KeeperCards, cards: MomentCard[]) {
  const headings = [...new Set(cards.flatMap(card => [...HEADINGS[card.moment]]))];
  if (!headings.length) return "";
  return `Reference from your skill (quoted):\n${dataFence(headings.map(heading => skill.get(heading)!).join("\n\n"))}\n\n`;
}

export function parseKeeperCards(text: string): KeeperCards {
  const sections = new Map<string, string>();
  let title: string | undefined, lines: string[] = [], fence: string | undefined;
  const save = () => {
    if (!title) return;
    if (sections.has(title)) throw new Error(`Tavern's Keeper skill repeats the heading "${title}".`);
    sections.set(title, lines.join("\n").trimEnd());
  };
  for (const line of text.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
    } else if (marker) {
      fence = marker[1];
    } else {
      const heading = /^## (.+)$/.exec(line);
      if (heading) { save(); title = heading[1]!.trim(); lines = []; }
    }
    if (title) lines.push(line);
  }
  save();
  for (const heading of [...Object.values(HEADINGS).flat(), "Decide or ask", "Reference"]) {
    if (!sections.has(heading)) throw new Error(`Tavern's Keeper skill is missing the heading "${heading}".`);
  }
  const bundles = [...Object.keys(HEADINGS).map(moment => [moment as Moment]), ["check", "close"] as Moment[], ["check", "tell"] as Moment[]];
  for (const bundle of bundles) {
    if (Buffer.byteLength(renderKeeperCards(sections, bundle.map(moment => ({ moment, questId: null })))) > MOMENT_CARD_BYTES)
      throw new Error(`Tavern's Keeper moment card for "${bundle.flatMap(moment => [...HEADINGS[moment]]).join("; ")}" exceeds ${MOMENT_CARD_BYTES} bytes.`);
  }
  return sections;
}

export function loadKeeperCards(root: URL) {
  return parseKeeperCards(readFileSync(new URL("skills/tavern-keeper/SKILL.md", root), "utf8"));
}

export function eventMoments(k: Keeper, event: TavernEvent, waypointProgress: (questId: string) => { any: boolean; all: boolean }): MomentCard[] {
  const { type, boardQuestId: questId, data } = event;
  if ((type === "route.recorded" || type === "route.corrected") && typeof data.routeId === "string") {
    const route = k.store.get("routes", data.routeId);
    if (route?.kind !== "steer") return [];
    return routeQuestIds(route).filter(id => isOpenQuest(k.store.get("quests", id))).map(id => ({ moment: "steer", questId: id }));
  }
  if (!questId) return [];
  const quest = k.store.get("quests", questId);
  if (!quest) return [];
  const card = (...moments: Moment[]): MomentCard[] => moments.map(moment => ({ moment, questId }));
  if (type === "quest.opened") return quest.phase === "scout" && !quest.planVersion ? card("opening") : [];
  if (type === "quest.wrapped" || type === "quest.stopped") return card("learn");
  if (!isOpenQuest(quest)) return [];
  if (type === "ask.answered" || type === "ask.defaulted") {
    const ask = typeof data.askId === "string" ? k.store.get("asks", data.askId) : null;
    if (ask?.kind === "greenlight" && ask.answer?.optionId === "approve" && ask.effect?.type === "greenlight"
      && ask.effect.planVersion === quest.greenlitVersion && quest.phase === "build") return card("staffing");
  }
  if (type === "decision.made" && data.cause === "auto-approve" && quest.phase === "build") return card("staffing");
  if (type === "scope.act-held" || type === "scope.violation" && data.mode !== "watch") return card("request");
  if (type === "ask.opened") {
    const ask = typeof data.askId === "string" ? k.store.get("asks", data.askId) : null;
    if (ask?.state === "open" && ask.kind === "scope") return card("request");
  }
  if (type === "member.stale" || type === "member.failed") return card("stalled");
  let check = false;
  if (type === "report.filed") {
    const report = typeof data.reportId === "string" ? k.store.get("reports", data.reportId) : null;
    if (quest.planVersion === 0 && report && k.member(report.memberThreadId)?.classId === "ranger") return card("scouts");
    check = report?.status === "done" && !!report.waypointId;
  }
  if (type === "plan.proposed" && typeof data.version === "number" && data.version !== quest.planVersion) return [];
  const phase = type === "quest.phase" || (typeof data.phase === "object" && data.phase !== null && "from" in data.phase && "to" in data.phase && data.phase.from !== data.phase.to);
  const settling = check || type === "waypoint.review-round" && data.verdict === "verified" || type === "journal.changed" ||
    type === "decision.made" && !!data.waypoint || type === "plan.proposed";
  const progress = settling ? waypointProgress(questId) : null;
  const currentPlanApproved = (quest.checkPlanVersion ?? quest.greenlitVersion) === quest.planVersion;
  const decision: Moment | null = progress?.all && currentPlanApproved ? "close" : progress?.any || phase ? "tell" : null;
  return card(...(check ? ["check" as const] : []), ...(decision ? [decision] : []));
}

export function readWaypointProgress(k: Keeper, questId: string) {
  const { waypoints } = k.summary(questId);
  return { any: waypoints.some(settled), all: waypoints.length > 0 && waypoints.every(settled) };
}

export const momentKey = (card: MomentCard) => card.questId === null ? card.moment : `${card.moment}:${card.questId}`;
