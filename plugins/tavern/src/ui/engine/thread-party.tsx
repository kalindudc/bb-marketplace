import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ThreadDecor } from "../../shared/contract";
import { characterMood, REPORTED_MS, VERIFIED_MS, widgetMoodFacts } from "../../shared/mood";
import { pickLine, type LineFacts } from "../../shared/says";
import type { CharacterDef } from "../../shared/schema";
import type { VoiceMode } from "../../shared/settings";
import { motion, STUCK_IN_VIEW, stuckInView, type Surface } from "../kit/motion";
import { REPORT_READING, reportReading } from "./report-reading";
import { BUBBLE_MS, planSpeech, reportSpeechHeld, speechDecision, speechSlot } from "./speech";
import { PartyStrip, type StripSpeech } from "./strip";

function useWidgetMood(data: ThreadDecor) {
  const [now, setNow] = useState(Date.now);
  const facts = widgetMoodFacts(data, now);
  const reportAt = facts.report?.status === "done" ? facts.report.createdAt : null;
  const verifiedAt = facts.verdict?.status === "verified" ? facts.verdict.at : null;
  useLayoutEffect(() => { setNow(Date.now()); }, [reportAt, verifiedAt]);
  useEffect(() => {
    const due = (at: number | null, window: number) => at === null ? Infinity : now < at ? at : at + window;
    const next = [due(reportAt, facts.reportedMs ?? REPORTED_MS), due(verifiedAt, facts.verifiedMs ?? VERIFIED_MS)].filter(at => at > now);
    const at = Math.min(...next);
    if (!Number.isFinite(at)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, at - Date.now()));
    return () => clearTimeout(timer);
  }, [now, reportAt, verifiedAt, facts.reportedMs, facts.verifiedMs]);
  return characterMood(facts);
}

function watchSpeechHold(surface: Surface, dismiss: () => void, readingHold?: () => boolean) {
  const selector = readingHold ? `${STUCK_IN_VIEW}, ${REPORT_READING}` : STUCK_IN_VIEW;
  const check = () => {
    const { typing, held } = motion.getHolds(surface);
    if (typing || held || document.hidden || stuckInView() || readingHold?.()) dismiss();
  };
  const io = typeof IntersectionObserver === "function" ? new IntersectionObserver(check) : null;
  const inspect = () => {
    check();
    if (io) {
      io.disconnect();
      for (const el of document.querySelectorAll(selector)) io.observe(el);
    }
  };
  const dom = new MutationObserver(inspect);
  dom.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "role", "hidden", "data-ask", "data-stuck", "data-tavern-report", "data-tavern-report-at"] });
  const events = ["input", "keydown", "compositionstart", "compositionupdate", "visibilitychange", "scroll"];
  for (const event of events) document.addEventListener(event, check, true);
  window.addEventListener("resize", check);
  inspect();
  return () => {
    for (const event of events) document.removeEventListener(event, check, true);
    window.removeEventListener("resize", check);
    dom.disconnect();
    io?.disconnect();
  };
}

type Props = {
  data: ThreadDecor;
  character: CharacterDef;
  classLabel: string;
  voice: VoiceMode;
  held: boolean;
  pageSince: number;
};

export function ThreadPartyStrip({ data, character, classLabel, voice, held, pageSince }: Props) {
  const member = data.member!;
  const mood = useWidgetMood(data);
  const surface: Surface = `thread:${data.threadId}`;
  const actorId = `${member.threadId}:${character.id}`;
  const [transition, setTransition] = useState(() => ({ mood, since: Date.now(), order: 0 }));
  if (transition.mood !== mood) setTransition({ mood, since: Date.now(), order: transition.order + 1 });
  const [cueEnd, setCueEnd] = useState<{ transition: typeof transition; at: number } | null>(null);
  const [last, setLast] = useState<{ text: string; at: number } | null>(null);
  const [tried, setTried] = useState<{ event?: number; ambient?: number }>({});
  const [bubble, setBubble] = useState<{ line: StripSpeech; transition: typeof transition; at: number; automatic: boolean } | null>(null);
  const latestReport = useRef(-Infinity);
  const ownReportAt = Math.max(member.lastReportAt ?? -Infinity, data.moodSignals?.report?.createdAt ?? -Infinity);
  const reading = () => {
    const { reportInView, latestReportAt } = reportReading(data.threadId);
    latestReport.current = Math.max(latestReport.current, ownReportAt, latestReportAt);
    return { reportInView, latestReportAt: latestReport.current };
  };
  const wrapped = [data.boardQuest, ...(data.keeperView?.boardQuests ?? [])].reduce<typeof data.boardQuest>((latest, quest) =>
    quest?.phase === "done" && quest.endedAt != null && (!latest || quest.endedAt > latest.endedAt!) ? quest : latest, null);
  const verdict = mood === "verified" ? data.moodSignals?.verdict : null;
  const facts: LineFacts = {
    quest: data.boardQuest?.title ?? member.title,
    waypoint: verdict?.waypointTitle ?? data.moodSignals?.waypointTitle,
    checker: verdict?.checkerName,
  };
  const visible = bubble?.transition === transition && voice !== "off" && !held && speechSlot(mood) ? bubble : null;
  const cueEndsAt = cueEnd?.transition === transition ? cueEnd.at : undefined;
  const input = {
    actorId, voice, mood, moodSince: transition.since, pageSince, cueEndsAt,
    milestone: transition.order > 0 && cueEndsAt !== undefined,
    arrivedAt: member.createdAt, wrappedAt: wrapped?.endedAt ?? undefined,
    lastLineAt: last?.at ?? null, lastEventAttemptAt: tried.event, lastAmbientAttemptAt: tried.ambient,
  };
  const live = useRef<(click: boolean) => void>(() => {});
  useLayoutEffect(() => {
    live.current = click => {
      const now = Date.now();
      const scheduled = planSpeech({ ...input, now, click });
      if (!scheduled || scheduled.at > now) return;
      const holds = motion.getHolds(surface);
      const decision = speechDecision({ ...input, now, click, typing: holds.typing, held: held || holds.held,
        stuckInView: document.hidden || stuckInView(), ...(click ? {} : reading()) });
      const lineFacts = decision?.slot === "wrap" ? { ...facts, quest: wrapped?.title } : facts;
      const text = decision && pickLine(character.says?.[decision.slot], decision.key, last?.text ?? null, lineFacts);
      if (text) {
        setLast({ text, at: now });
        setBubble({ line: { actorId: character.id, text }, transition, at: now, automatic: !click });
      } else if (!click) {
        setTried(prior => ({ ...prior, [scheduled.kind === "ambient" ? "ambient" : "event"]: now }));
      }
    };
  });
  const plan = planSpeech({ ...input, now: Date.now() });
  useEffect(() => {
    if (!character.says || plan?.at === undefined) return;
    const timer = setTimeout(() => live.current(false), Math.max(0, plan.at - Date.now()));
    return () => clearTimeout(timer);
  }, [character.says, plan?.at, plan?.key]);
  useLayoutEffect(() => {
    if (bubble && !visible) setBubble(null);
    if (!visible) return;
    const dismiss = () => setBubble(null);
    const stop = watchSpeechHold(surface, dismiss, visible.automatic ? () => reportSpeechHeld({ now: Date.now(), ...reading() }) : undefined);
    const timer = setTimeout(dismiss, Math.max(0, visible.at + BUBBLE_MS - Date.now()));
    return () => { stop(); clearTimeout(timer); };
  }, [bubble, visible, surface, ownReportAt]);

  if (mood === "released") return null;
  return <PartyStrip
    character={character} classId={member.classId} classLabel={classLabel} mood={mood}
    keeper={!!data.keeperView} surface={surface} region="widget" mode={data.ambientMotion ?? "calm"} held={held}
    speech={visible?.line ?? null} canClickSpeak={voice !== "off" && speechSlot(mood) && !!character.says?.[mood]?.length}
    onActorClick={() => live.current(true)} onMoodCueEnd={() => {
      const at = Date.now();
      setCueEnd(previous => previous && previous.transition.order > transition.order ? previous : { transition, at });
    }}
  />;
}
