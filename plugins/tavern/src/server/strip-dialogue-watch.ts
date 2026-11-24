import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { readStripScene } from "./strip-scene";
import { SpeechAttempts, DialogueWatches } from "./strip-dialogue";
import { speechMinGapMs } from "../shared/says";
import { dialogueRequestSchema } from "../shared/strip-scene";
import type { PiSpeech } from "./pi-speech";
import { stopAllReason } from "./stop-all";
import type { TavernRuntime } from "./runtime";

export function registerDialogueWatch(bb: BbPluginApi, runtime: TavernRuntime, speech: Pick<PiSpeech, "complete" | "dispose" | "refresh" | "setWatching" | "stop">) {
  const { keeper } = runtime;
  const attempts = new SpeechAttempts(keeper.store);
  const watches = new DialogueWatches(threadId => {
    const member = keeper.member(threadId);
    const config = runtime.config();
    const settings = config.tavern;
    const now = keeper.now();
    if (!member || !settings.contextualSpeech || !settings.characters || !settings.widgetRow || settings.characterQuietUntil > now || stopAllReason(keeper.store)) return null;
    const scene = readStripScene(keeper, member);
    const thread = keeper.store.runtime(threadId);
    const held = (member.lastReportAt != null && now - member.lastReportAt < 60_000) ||
      (thread.typingAt != null && now - thread.typingAt < config.knobs.typingHoldSeconds * 1_000) ||
      runtime.scopes?.view(threadId)?.pendingAskId;
    return { scene: held && scene.posture === "clear" ? { ...scene, posture: "held" as const } : scene, voice: settings.voice };
  }, (seat, at, now) => {
    const reserved = attempts.reserve(seat, at, now);
    if (reserved) bb.rpc.experimental_invalidate(["tavern:settings"]);
    return reserved;
  }, (scene, signal, reserve) => speech.complete(scene, runtime.config().tavern, signal, reserve), () => keeper.now(), active => speech.setWatching(active));
  const notice = (threadId: string | null) => {
    if (!threadId || !watches.has(threadId)) return;
    queueMicrotask(() => void watches.changed(threadId).catch(() => {}));
  };
  const onEvent = keeper.store.onEvent;
  keeper.store.onEvent = event => {
    onEvent?.(event);
    const { type, data, keeperThreadId, actor } = event;
    if (type === "tavern.stopped") { watches.cancelFlights(); void speech.stop(); }
    if (data.phase || type.startsWith("ask.") || type === "route.recorded" || type === "route.corrected") notice(keeperThreadId);
    if ((type === "waypoint.review-round" || type === "waypoint.review-rejected") && actor.kind === "agent") notice(actor.threadId);
    if ((type.startsWith("member.") || type === "report.filed" || type.startsWith("ask.")) && typeof data.memberThreadId === "string") notice(data.memberThreadId);
  };
  const unlistenJournal = keeper.journal.onChange(threadId => { notice(threadId); });
  bb.http.experimental_websocket("/strip-dialogue", ({ url }) => {
    const threadId = url.searchParams.get("thread");
    const projectId = url.searchParams.get("project");
    let release: (() => void) | null = null;
    let pane: Parameters<typeof watches.subscribe>[1] | undefined;
    let closed = false;
    return {
      async onOpen(socket) {
        if (!threadId || !projectId || threadId.length > 120 || projectId.length > 120) { socket.close(1008); return; }
        try {
          const thread = await bb.sdk.threads.get({ threadId });
          if (closed) return;
          if (thread.id !== threadId || thread.projectId !== projectId || thread.visibility !== "visible" || thread.archivedAt !== null || thread.deletedAt !== null) { socket.close(1008); return; }
          pane = line => { if (socket.readyState === 1) socket.send(JSON.stringify(line)); };
          release = watches.subscribe(threadId, pane);
          if (!release) socket.close(1008);
        } catch { socket.close(1008); }
      },
      onMessage(_socket, data) {
        if (closed || !release || !pane || !threadId || typeof data !== "string" || data.length > 64) return;
        let value: unknown;
        try { value = JSON.parse(data); } catch { return; }
        const request = dialogueRequestSchema.safeParse(value);
        if (!request.success) return;
        void watches.request(threadId, pane, request.data, speechMinGapMs(runtime.config().tavern.speechGapMinutes)).catch(() => {});
      },
      onClose() { closed = true; release?.(); },
      onError() { closed = true; release?.(); },
    };
  });
  const drop = ({ thread }: { thread: { id: string } }) => watches.drop(thread.id);
  bb.events.on("thread.archived", drop);
  bb.events.on("thread.deleted", drop);
  bb.onDispose(() => { unlistenJournal(); watches.dispose(); return speech.dispose(); });
  return () => { void speech.refresh(runtime.config().tavern); };
}
