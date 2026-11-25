import { useBbContext, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ThreadDecor } from "../../shared/contract";
import { dialogueSlot, SPEECH_REPLY_MS, type DialogueRequest } from "../../shared/strip-scene";
import { DialogueSocket, type DialogueLine } from "./dialogue-socket";
import { characterMood, REPORTED_MS, VERIFIED_MS, widgetMoodFacts } from "../../shared/mood";
import { pickLine, type LineFacts } from "../../shared/says";
import type { CharacterDef } from "../../shared/schema";
import type { VoiceMode } from "../../shared/settings";
import { motion, STUCK_IN_VIEW, stuckInView, type Surface } from "../kit/motion";
import type { ChangeCharacterSetting } from "./character-menu";
import { useCharacterQuiet } from "./character-quiet";
import { REPORT_READING, reportReading } from "./report-reading";
import { BUBBLE_MS, planSpeech, reportSpeechHeld, speechDecision, speechSlot } from "./speech";
import { PartyStrip, type StripSpeech, type AskDisclosure } from "./strip";

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

const CANNED_DELAY_MS = 1_500;

type Props = {
  data: ThreadDecor;
  character: CharacterDef;
  classLabel: string;
  voice: VoiceMode;
  held: boolean;
  pageSince: number;
  change: ChangeCharacterSetting;
  askDisclosure?: AskDisclosure;
};

export function ThreadPartyStrip({ data, character, classLabel, voice, held, pageSince, change, askDisclosure }: Props) {
  const navigate = useBbNavigate();
  const { threadId: activeThread } = useBbContext();
  const quiet = useCharacterQuiet(data.characterQuietUntil);
  const speechMode = quiet ? "off" : voice;
  const motionMode = data.ambientMotion ?? "calm";
  const member = data.member!;
  const mood = useWidgetMood(data);
  const surface: Surface = `thread:${data.threadId}`;
  const actorId = `${member.threadId}:${character.id}`;
  const [transition, setTransition] = useState(() => ({ mood, since: Date.now(), order: 0 }));
  if (transition.mood !== mood) setTransition({ mood, since: Date.now(), order: transition.order + 1 });
  const [cueEnd, setCueEnd] = useState<{ transition: typeof transition; at: number } | null>(null);
  const [last, setLast] = useState<{ text: string; at: number } | null>(null);
  const [tried, setTried] = useState<{ event?: number; ambient?: number }>({});
  const [bubble, setBubble] = useState<{ line: StripSpeech; transition: typeof transition; at: number; automatic: boolean; revision?: string; request?: DialogueRequest; fallbackShown?: boolean; shownAt?: number } | null>(null);
  const [speechVisible, setSpeechVisible] = useState(false);
  const [dialogue, setDialogue] = useState<DialogueLine | null>(null);
  const [eventRevision, setEventRevision] = useState<string | null>(null);
  const contextual = data.contextualSpeech === true;
  const workbench = data.stripScene;
  const revision = workbench?.revision;
  const contextualSlot = dialogueSlot(workbench, speechMode);
  const mayWatch = contextual && activeThread === data.threadId && speechVisible && !held && speechMode !== "off" && workbench?.posture !== "gone";
  const previousScene = useRef({ revision, mayWatch });
  useLayoutEffect(() => {
    const previous = previousScene.current;
    previousScene.current = { revision, mayWatch };
    if (previous.revision !== revision) setDialogue(line => line?.revision === previous.revision ? null : line);
    if (!mayWatch || !previous.mayWatch || !contextualSlot || revision === undefined || previous.revision === revision) return;
    if (workbench?.at != null && workbench.at >= pageSince) setEventRevision(revision);
  }, [revision, contextualSlot, mayWatch, workbench?.at, pageSince]);
  useLayoutEffect(() => {
    if (!mayWatch) { setDialogue(null); setEventRevision(null); }
  }, [mayWatch]);
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
    quest: data.boardQuest?.short || data.boardQuest?.title || member.title,
    waypoint: verdict?.waypointTitle ?? data.moodSignals?.waypointTitle,
    checker: verdict?.checkerName,
  };
  const visible = bubble?.transition === transition && speechMode !== "off" && !held && speechSlot(mood) &&
    (!bubble.line.contextual || mayWatch && bubble.revision === revision) ? bubble : null;
  const request = visible?.request;
  const pending = visible?.line.contextual && (visible.automatic || request);
  const reply = visible && pending && dialogue?.revision === visible.revision &&
    dialogue?.request?.kind === request?.kind && dialogue?.request?.at === request?.at &&
    dialogue && dialogue.receivedAt < visible.at + SPEECH_REPLY_MS ? dialogue : null;
  const waitingForDraw = visible?.line.ambientAt !== undefined && visible.shownAt === undefined;
  const timeout = pending && !reply || waitingForDraw ? SPEECH_REPLY_MS : BUBBLE_MS;
  const expiresAt = visible && Math.max((visible.shownAt ?? visible.at) + BUBBLE_MS, (reply?.receivedAt ?? visible.at) + timeout);
  const cueEndsAt = cueEnd?.transition === transition ? cueEnd.at : undefined;
  const input = {
    actorId, voice: speechMode, mood, moodSince: transition.since, pageSince, cueEndsAt,
    milestone: !contextual && transition.order > 0 && cueEndsAt !== undefined,
    arrivedAt: contextual ? undefined : member.createdAt, wrappedAt: contextual ? undefined : wrapped?.endedAt ?? undefined,
    speechGapMinutes: data.speechGapMinutes,
    lastLineAt: last?.at ?? null, lastEventAttemptAt: tried.event, lastAmbientAttemptAt: tried.ambient,
  };
  const live = useRef<(click: boolean, event?: boolean) => void>(() => {});
  useLayoutEffect(() => {
    live.current = (click, event = false) => {
      const now = Date.now();
      const holds = motion.getHolds(surface);
      if (contextual && (event || click && mayWatch)) {
        if (!mayWatch || holds.typing || holds.held || document.hidden || stuckInView() || reportSpeechHeld({ now, ...reading() }) || !speechSlot(mood)) return;
        if (!click && (!contextualSlot || eventRevision !== revision)) return;
        const slot = click ? contextualSlot ?? mood : contextualSlot!;
        const choices = character.says?.[slot]?.filter(line => line.length <= 56 && line.split(/\s+/).length <= 10);
        const key = `${actorId}:${slot}:${revision}:${click ? now : "event"}`;
        const text = pickLine(choices, key, last?.text ?? null, {}) ?? (click ? pickLine(choices, key, null, {}) : null);
        if (!click) setEventRevision(null);
        if (text) {
          setLast({ text, at: now });
          setBubble({ line: { actorId: character.id, text, contextual: true, announce: click }, transition, at: now, automatic: !click, revision,
            ...(click && workbench?.posture === "clear" ? { request: { kind: "click", at: now } } : {}) });
        }
        return;
      }
      const scheduled = planSpeech({ ...input, now, click });
      if (!scheduled || scheduled.at > now) return;
      const decision = speechDecision({ ...input, now, click, typing: holds.typing, held: held || holds.held,
        stuckInView: document.hidden || stuckInView(), ...(click ? {} : reading()) });
      const lineFacts = decision?.slot === "wrap" ? { ...facts, quest: wrapped?.short || wrapped?.title } : facts;
      const ambient = scheduled.kind === "ambient" && mayWatch && workbench?.posture === "clear";
      const choices = decision ? character.says?.[decision.slot] : undefined;
      const text = decision && (pickLine(choices, decision.key, last?.text ?? null, lineFacts)
        ?? (ambient ? pickLine(choices, decision.key, null, lineFacts) : null));
      if (text) {
        setLast({ text, at: now });
        setBubble({ line: { actorId: character.id, text, ...(scheduled.kind === "ambient" ? { ambientAt: now } : {}),
          ...(ambient ? { contextual: true } : {}) }, transition,
          at: now, automatic: !click, ...(ambient ? { revision, request: { kind: "ambient", at: now } } : {}) });
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
  useEffect(() => {
    if (!contextual || !mayWatch || !contextualSlot || !eventRevision || eventRevision !== revision) return;
    live.current(false, true);
  }, [contextual, mayWatch, contextualSlot, eventRevision, revision]);
  useLayoutEffect(() => {
    if (bubble && !visible) setBubble(null);
    if (!visible || expiresAt === null) return;
    const dismiss = () => setBubble(null);
    const stop = watchSpeechHold(surface, dismiss, visible.automatic ? () => reportSpeechHeld({ now: Date.now(), ...reading() }) : undefined);
    const timer = setTimeout(dismiss, Math.max(0, expiresAt - Date.now()));
    const fallback = pending && !reply && !visible.fallbackShown ? setTimeout(() => {
      setBubble(prior => prior === visible ? { ...visible, fallbackShown: true } : prior);
    }, Math.max(0, visible.at + CANNED_DELAY_MS - Date.now())) : undefined;
    return () => { stop(); clearTimeout(timer); clearTimeout(fallback); };
  }, [bubble, visible, expiresAt, pending, reply, surface, ownReportAt]);

  const line = visible && (!pending || reply || visible.fallbackShown) ? visible.line : null;
  if (mood === "released") return null;
  return <>
    {mayWatch && <DialogueSocket threadId={data.threadId} onLine={setDialogue} request={request} />}
    <PartyStrip
    character={character} classId={member.classId} classLabel={classLabel} mood={mood} memberId={member.threadId}
    askDisclosure={askDisclosure} keeper={!!data.keeperView} surface={surface} region="widget" mode={motionMode} held={held} quiet={quiet}
    road={workbench?.road} repeatSeconds={data.repeatSeconds}
    onOpenQuest={(id, sealed) => navigate.toPluginPanel("tavern", { subPath: `${sealed ? "tale" : "quest"}/${id}` })}
    actorMenu={{ mode: motionMode, voice, voiceBeforeOff: data.voiceBeforeOff, quietUntil: quiet ? data.characterQuietUntil : undefined, change, openSheet: () => navigate.toPluginPanel("tavern", { subPath: `character/${character.id}` }) }}
    speech={line && reply?.text ? { ...line, text: reply.text } : line ?? null} canClickSpeak={speechMode !== "off" && speechSlot(mood) && !!character.says?.[contextualSlot ?? mood]?.length}
    onSpeechVisible={contextual ? setSpeechVisible : undefined}
    onAmbientShown={ambientAt => {
      const shownAt = Date.now();
      setBubble(current => current?.line.ambientAt === ambientAt && current.shownAt === undefined ? { ...current, shownAt } : current);
    }}
    onActorClick={() => live.current(true)} onMoodCueEnd={() => {
      const at = Date.now();
      setCueEnd(previous => previous && previous.transition.order > transition.order ? previous : { transition, at });
    }}
  /></>;
}
