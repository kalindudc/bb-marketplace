import { useHandBackReply } from "./handback-reply";
import { attentionView, attentionTitle } from "../../shared/attention";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";
import { experimental_useRpcQuery, experimental_useRpcMutation, experimental_usePluginId, experimental_useAppPanel, useBbNavigate, useComposer, useRpc, UrlLink, type PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { charactersPatch, settingsContract, type SettingsPatch } from "../../shared/settings";
import { isSetupPrompt } from "../../shared/setup";
import { classDifferences, composerProjectId, fieldWords, rearmClassSettings, startRefusal, useClassStart } from "./class-start";
import { rpcContract, type ThreadDecor } from "../../shared/contract";
import type { Ask, CheckerHandoffHold, ClassDef, Phase as QuestPhase } from "../../shared/schema";
import type { ClassNotice } from "../../shared/class-execution-contract";
import { AskCard, Crest, KEEPER_STATE_HINT, DecidedForYou, useDecisionSeen, ExpandsMark, Glyph, IconButton, OpensMark, QueryState, Skeleton, SkCrest, SkLine, TimeAgo, Vocabulary, memberIdentity, plural, useRegistry, useSkeletonCount, useSkeletonDelay, type Registry, glowVars, QuietNotice, useArmedNewQuest, activeHold, heldQuests, releaseWords, Clamp, localTime, useNow } from "../kit";
import { PHASE_STEPS, phaseIndex, phaseWord } from "../kit/phase";
import { LEDGER_TAB } from "./tabs";
import { summaryCountWords } from "../kit/rows";
import { acknowledgeAskReveal, acknowledgeWidgetReveal, useWidgetPanel, useWidgetReveal, threadDecorCache } from "./state";
import { useChangeCue, useTavernMotion } from "../kit/motion";
import { ThreadPartyStrip } from "../engine/thread-party";
import { takeArmedClass } from "../kit/remember";
import { MemberPanel, memberFinished } from "./member-brief";
import { clusterGuardWords, memberIdentityWords } from "../kit/member-identity";
import { HUE_CSS } from "../../shared/heraldry";
import { PlacementFacts } from "../kit/placement";
import { memberIdentityLabel } from "../../shared/identity";
import { watchActWords } from "../../scope/act-routing";

export const CLASS_PROVIDER = "classes";

/** "anthropic/claude-opus-5-5" reads as "Claude Opus 5.5". */
export function modelLabel(model: string | null) {
  if (!model) return "Your default model";
  const words = (model.split("/").pop() ?? model).replace(/(\d+)-(\d+)/g, "$1.$2").split("-").map(w => /^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1));
  // "gpt-6-1-sol" reads "GPT-6.1 Sol", as OpenAI writes it; other families read "Claude Opus 5.5".
  return words[0] === "Gpt" && words[1] ? [`GPT-${words[1]}`, ...words.slice(2)].join(" ") : words.join(" ");
}
/** The server picks the first free character in the class's order when the thread starts, so name the candidates, never one. */
export function candidateNames(registry: Registry, cls: ClassDef) {
  const names = cls.characters.map(id => registry.characters.find(c => c.id === id)?.name).filter((n): n is string => !!n);
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/** Puts the class's pill at the start of the draft. The class banner then applies the class's settings, as the server resolves them, once. */
export function selectClass(composer: PluginComposerApi, cls: ClassDef, pluginId: string) {
  return Promise.resolve().then(() => {
    composer.replace(draft => {
      const existing = draft.mentions.filter(m => m.kind === "plugin" && m.pluginId === pluginId && m.provider === CLASS_PROVIDER);
      let text = draft.text;
      const ranges = existing.map(m => ({ from: m.from, to: m.to })).sort((a, b) => b.from - a.from);
      for (const range of ranges) text = text.slice(0, range.from) + text.slice(range.to);
      const mentions = draft.mentions.filter(m => !existing.includes(m)).map(m => {
        const removedBefore = ranges.filter(r => r.to <= m.from).reduce((n, r) => n + r.to - r.from, 0);
        return { ...m, from: m.from - removedBefore, to: m.to - removedBefore };
      });
      const prefix = `!${cls.label} `;
      return { text: prefix + text, mentions: [{ kind: "plugin" as const, pluginId, provider: CLASS_PROVIDER, id: cls.id, label: cls.label, from: 0, to: prefix.length - 1 }, ...mentions.map(m => ({ ...m, from: m.from + prefix.length, to: m.to + prefix.length }))] };
    });
    composer.experimental_closePopup();
    composer.focus();
  });
}

/** Tavern's lantern, for threads without a character. */
/** The tavern sign (Keela's set): a wall bracket with the board hung from it and a Keeper's shield on the board. */
export function TavernMark({ size = 16 }: { size?: number }) {
  return <svg className="tavern-glyph" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" strokeLinejoin="miter"><path d="M3.25 3.25v8.5M3.25 5.25h17.5M3.25 10.25l5-5M8.75 5.25v3.5M17.75 5.25v3.5" /><path d="M5.75 8.75h15v12h-15Z" /><path d="M10.75 11.75h5v3c0 1.6-1 2.7-2.5 3.3-1.5-.6-2.5-1.7-2.5-3.3Z" /></svg>;
}
export function ClassPickerPopover() {
  const composer = useComposer();
  const pluginId = experimental_usePluginId();
  const registry = useRegistry();
  const [active, setActive] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const projectId = composerProjectId(composer);
  // What each class resolves to in this project (a project file can change a class's model); the class file's own model until it loads.
  const resolved = experimental_useRpcQuery({ contract: rpcContract, method: "classExecutions", input: projectId ? { projectId } : {} });
  const startModel = (cls: ClassDef) => { const start = resolved.data?.classes.find(c => c.classId === cls.id)?.start; return start && !start.errors.length && start.execution ? start.execution.model ?? null : cls.model; };
  const unstartable = (cls: ClassDef) => resolved.data?.classes.find(c => c.classId === cls.id)?.start.errors[0] ?? null;
  const classes = registry.data?.classes.filter(c => c.startable) ?? [];
  useEffect(() => { buttons.current[0]?.focus(); }, [classes.length]);
  async function pick(cls: ClassDef) { setPending(true); setError(null); try { rearmClassSettings(composer.key, cls.id); await selectClass(composer, cls, pluginId); } catch (e) { setError(e); setPending(false); } }
  return (
    <div className="tavern class-pop">
      <div className="cp-h"><b>Start as a class</b> <span className="anc">thread type</span></div>
      <QueryState error={registry.error ?? error} loading={registry.isLoading} retry={() => void registry.refetch()} />
      <div className="class-picker" role="listbox" aria-label="Startable classes" aria-busy={pending} onKeyDown={e => {
        if (e.key === "Escape") { e.preventDefault(); composer.experimental_closePopup(); }
        const next = e.key === "ArrowDown" ? (active + 1) % classes.length : e.key === "ArrowUp" ? (active + classes.length - 1) % classes.length : e.key === "Home" ? 0 : e.key === "End" ? classes.length - 1 : null;
        if (next !== null && classes.length) { e.preventDefault(); setActive(next); buttons.current[next]?.focus(); }
      }}>
        {classes.map((cls, i) => {
          const character = registry.data!.characters.find(c => cls.characters.includes(c.id));
          const who = candidateNames(registry.data!, cls);
          const off = unstartable(cls);
          return (
            <button type="button" role="option" aria-selected={active === i} tabIndex={active === i ? 0 : -1} disabled={pending} key={cls.id} ref={el => { buttons.current[i] = el; }} onFocus={() => setActive(i)} onClick={() => void pick(cls)}>
              <Crest cls={cls} character={character ? { ...character, name: cls.label } : { name: cls.label, hue: "ink", charge: "chevron", plain: true }} size={24} title={`${cls.label} crest`} />
              <span className="cp-t">
                <span className="cp-n"><b>{cls.label}</b> <span className="anc">{cls.plain}</span></span>
                <span className="cp-d">{cls.description}</span>
                <span className="cp-m">{who ? `${who} takes it` : "No character: named by its class"} · {modelLabel(startModel(cls))}{cls.greenlight === "explicit" ? " · staffing waits for your greenlight" : ""}</span>
                {off && <span className="cp-off">Can’t start here: {off}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {resolved.error && <p className="m small cp-note">Couldn’t read this project’s class settings ({resolved.error instanceof Error ? resolved.error.message : String(resolved.error)}). Models shown are the class files’; the banner checks again when you pick.</p>}
      {registry.data?.problems.map(p => <p className="problem" role="alert" key={p.path}>{p.path}: {p.message}</p>)}
    </div>
  );
}

/**
 * The new-thread composer's class: the pill's, or the default class from settings when there is no pill. The server resolves the class's
 * provider, model, reasoning and permission; they are applied once per draft, and the banner says when the pickers differ, and when the
 * server will refuse the start. A default class that can't start says so: the thread starts plain, never silently.
 */
export function ClassBanner() {
  const composer = useComposer();
  const pluginId = experimental_usePluginId();
  const registry = useRegistry();
  const settings = experimental_useRpcQuery({ contract: settingsContract, method: "settings", input: null });
  const mention = composer.draft.mentions.find(m => m.kind === "plugin" && m.pluginId === pluginId && m.provider === CLASS_PROVIDER);
  const pillId = mention && "id" in mention ? mention.id : null;
  const configured = settings.data?.effective.tavern.defaultClass;
  const defaultId = !pillId && configured && configured !== "none" ? configured : null;
  const classId = pillId ?? defaultId;
  const start = useClassStart(classId);
  const [plainError, setPlainError] = useState<string | null>(null);
  // The page's armed record is spent here: a class pill gets its class's settings however it arrived.
  useEffect(() => { if (pillId) takeArmedClass(pillId); }, [pillId]);
  if (!classId) return null;
  const cls = registry.data?.classes.find(c => c.id === classId);
  const label = cls?.label ?? classId;
  const startPlain = async () => {
    setPlainError(null);
    try {
      await composer.submit({ experimental_data: { classId: "none" } });
    } catch (err) { setPlainError(err instanceof Error ? err.message : String(err)); }
  };
  const plain = <button type="button" className="btn sm tw-plain" disabled={composer.isSubmittingBlocked || composer.isEmpty} title={composer.submittingBlockedReason ?? (composer.isEmpty ? "Write a message first" : "Send this message without the default class")} onClick={() => void startPlain()}>Start as a plain thread</button>;
  if (defaultId && isSetupPrompt(composer.draft.text)) return (
    <section className="tavern twidget tw-class" aria-label="Tavern class for this thread">
      <div className="tw-row">{plain}<span className="tw-text">Setup needs no Tavern class. Sending as usual uses the default class, {label}.</span></div>
      {plainError && <p className="problem tw-class-err" role="alert">Couldn’t start a plain thread: {plainError}</p>}
    </section>
  );
  const reason = start.facts?.errors[0] ?? null;
  const readError = start.error ? (start.error instanceof Error ? start.error.message : String(start.error)) : null;
  const settingsLink = <UrlLink href={`/settings/plugins/${encodeURIComponent(pluginId)}`} className="lnk-btn act" title="Tavern's settings: New threads start as"><span>Settings</span><OpensMark /></UrlLink>;
  if (reason) return (
    <section className="tavern twidget tw-class tw-class-off" aria-label="Tavern class for this thread">
      {defaultId
        ? <p className="tw-class-note"><span>Starts as a plain thread: the default class {label} can’t start here ({reason}).</span>{settingsLink}</p>
        : <p className="problem tw-class-refuse" role="alert"><span>{label} can’t start here: {reason}</span></p>}
    </section>
  );
  if (!cls || !registry.data) return null;
  const character = registry.data.characters.find(c => cls.characters.includes(c.id));
  const who = candidateNames(registry.data, cls);
  const line = `${defaultId ? "By default · " : ""}${who ? `${who} takes it, whoever is free when you send` : "No character: the thread is named by its class"}${cls.id === "keeper" ? " · rangers scout first; staffing waits for your greenlight" : ""}`;
  const selection = composer.selection;
  const refusal = start.facts && start.settled ? startRefusal(start.facts, selection) : null;
  const diffs = start.execution && start.settled && !refusal ? classDifferences(start.execution, selection) : [];
  const appliedValues = start.applied as Record<string, unknown> | null;
  // A field still at what setSelection left is one bb didn't take; anything else is the person's own pick.
  const kept = diffs.filter(d => appliedValues !== null && (appliedValues[d.field] ?? null) === d.have);
  const chosen = diffs.filter(d => !kept.includes(d));
  const words = (list: typeof diffs, side: "have" | "want") => list.map(d => fieldWords(d.field, side === "have" ? d.have : d.want, modelLabel)).join(" · ");
  const useClass = <button type="button" className="btn sm" disabled={start.pending} onClick={() => void start.apply()} title={`Set the composer to the ${label} class's settings`}>Use class settings</button>;
  return (
    <section className="tavern twidget tw-class" aria-label="Tavern class for this thread">
      <div className="tw-row">
        {character ? <Crest cls={cls} character={{ ...character, name: cls.label }} size={18} title={`${cls.label} crest`} /> : <Crest cls={cls} character={{ name: cls.label, hue: "ink", charge: "chevron", plain: true }} size={18} />}
        <span className="tw-name"><b>{cls.label}</b> <span className="anc">{cls.plain}</span></span>
        <span className="tw-text" title={line}>{line}</span>
        {defaultId && plain}
      </div>
      {refusal && <p className="problem tw-class-refuse" role="alert"><span><b>Won’t start as {label}.</b> {refusal}</span>{start.execution && useClass}</p>}
      {chosen.length > 0 && <p className="tw-class-diff"><span>Running on {words(chosen, "have")}; the {label} class says {words(chosen, "want")}.</span>{useClass}</p>}
      {kept.length > 0 && <p className="tw-class-diff"><span className="m">This composer doesn’t offer the {label} class’s {words(kept, "want")}, so it starts on {words(kept, "have")}.</span></p>}
      {readError && <p className="problem tw-class-err" role="alert">Couldn’t read the {label} class’s settings ({readError}). Check the pickers below before you send.</p>}
      {start.applyError && <p className="problem tw-class-err" role="alert">Couldn’t set the {label}’s settings ({start.applyError}). Pick them below before you send.</p>}
      {plainError && <p className="problem tw-class-err" role="alert">Couldn’t start a plain thread: {plainError}</p>}
    </section>
  );
}

export function TavernBanner() { const composer = useComposer(); return composer.scope.kind === "thread" ? <ThreadWidget threadId={composer.scope.threadId} /> : null; }

type Open = null | "asks" | "decided" | "brief" | "quests";

export function ThreadWidget({ threadId }: { threadId: string }) {
  const composer = useComposer();
  const panel = experimental_useAppPanel();
  const navigate = useBbNavigate();
  const registry = useRegistry();
  const decor = experimental_useRpcQuery({ contract: rpcContract, method: "decor", input: { threadId } });
  const hide = experimental_useRpcMutation({ contract: rpcContract, method: "setHidden", optimistic: (input, cache) => cache.update("decor", { threadId: input.threadId }, d => ({ ...d, hidden: input.hidden })) });
  const typing = experimental_useRpcMutation({ contract: rpcContract, method: "typing" });
  const readSettings = useRpc<typeof settingsContract>();
  const updateSettings = experimental_useRpcMutation({ contract: settingsContract, method: "settingsUpdate" });
  const savingCharacter = useRef(false);
  const focusAfterCharacterChange = useRef<"actor" | "restore" | null>(null);
  const stack = useRef<HTMLDivElement>(null);
  const receiptEl = useRef<HTMLDivElement>(null);
  const [characterReceipt, setCharacterReceipt] = useState<{ text: string; show: boolean } | null>(null);
  const [receiptFocused, setReceiptFocused] = useState(false);
  const [open, setOpen] = useWidgetPanel(threadId);
  const [error, setError] = useState<unknown>(null);
  useHandBackReply(threadId, composer, setError);
  const { revealAskId, revealVersion } = useWidgetReveal(threadId);
  const lastTyping = useRef(0);
  const [pageSince] = useState(Date.now);
  const data = decor.data;
  const keeper = data?.keeperView;
  // The row's skeleton shows only where this device last saw a row (2 a Keeper's, 1 a member's), so a plain thread never flashes one.
  const lastRow = useSkeletonCount(`skel:thread:widget:${threadId}`, data ? (!data.member || data.hidden || data.widgetRow === false ? 0 : data.keeperView ? 2 : 1) : undefined, 0);
  const skeletonShown = useSkeletonDelay(!data && decor.isLoading && lastRow > 0);
  const armed = useArmedNewQuest(threadId);
  const isArmed = armed.armed && !!keeper;
  // Any successful send ends the arm: "Send as a new quest" goes through the same submit, and a plain send was the user's choice.
  useEffect(() => { if (!isArmed) return; return composer.onSubmitted(() => armed.disarm()); }, [isArmed, composer, armed.disarm]);
  useEffect(() => { if (data) threadDecorCache.set(threadId, data); return () => { threadDecorCache.delete(threadId); }; }, [threadId, data]);
  useEffect(() => { if (acknowledgeWidgetReveal(threadId, revealVersion)) setOpen("asks"); }, [threadId, revealVersion]);
  // Motion: the row holds still while an ask is in it, and for 2 s after the user types (the coordinator's hold; a restored draft doesn't
  // count); the busy dot pulses twice when its Keeper turns busy or the row comes into view busy, then holds solid.
  const need = needsOf(keeper);
  const { cue, settle } = useTavernMotion(`thread:${threadId}`, { held: need.asks + need.holds > 0 || (!!data && !keeper && scopeAlerts(data) > 0) });
  const dot = useRef<HTMLElement>(null);
  const pulsing = !!keeper && keeper.quietSince == null && keeper.status === "busy" && !!data?.member && !!registry.data;
  const pulse = () => cue(dot.current, "busy dot", { key: "dot", ms: 3200, className: "mo-pulse", ambient: true, region: "widget" });
  useLayoutEffect(() => { if (pulsing) pulse(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useChangeCue(pulsing, (_prev, next) => { if (next) pulse(); });
  useEffect(() => {
    if (!pulsing || data?.ambientMotion !== "lively") return;
    const timer = setInterval(() => cue(dot.current, "busy repeat", { key: "dot", ms: 3200, className: "mo-pulse", ambient: true, repeat: true, region: "widget" }), (data.repeatSeconds ?? 20) * 1000);
    return () => { clearInterval(timer); settle(c => c.kind === "busy repeat"); };
  }, [pulsing, data?.ambientMotion, data?.repeatSeconds, cue, settle]);
  useLayoutEffect(() => {
    const target = focusAfterCharacterChange.current;
    if (!target || data?.characters !== (target === "actor")) return;
    focusAfterCharacterChange.current = null;
    if (document.activeElement === document.body)
      stack.current?.querySelector<HTMLElement>(target === "actor" ? "button[data-actor]" : ".tw-show-characters")?.focus({ preventScroll: true });
  }, [data?.characters]);
  useEffect(() => {
    const el = receiptEl.current;
    if (!characterReceipt || !el || receiptFocused) return;
    const timer = setTimeout(() => cue(el, "character receipt", {
      key: "character-receipt", auto: false, ms: 120, className: "mo-character-receipt",
      onDone: () => setCharacterReceipt(current => current === characterReceipt ? null : current),
    }), 3_800);
    return () => { clearTimeout(timer); settle(c => c.el === el); };
  }, [characterReceipt, receiptFocused, cue, settle]);
  useEffect(() => {
    if (!keeper || !composer.text.trim()) return;
    const ping = () => { lastTyping.current = Date.now(); void typing.mutate({ threadId }).catch(setError); };
    const timer = setTimeout(ping, Math.max(500, 10000 - (Date.now() - lastTyping.current)));
    return () => clearTimeout(timer);
  }, [composer.text, threadId, !!keeper, typing.mutate]);
  if (!data) return decor.error ? <div className="tavern twidget"><QueryState error={decor.error} retry={() => void decor.refetch()} /></div> : decor.isLoading && lastRow > 0 ? <SkWidget keeper={lastRow === 2} shown={skeletonShown} /> : null;
  // A thread without a member has only its journal, which lives in bb's context row (journal-segment.tsx), so it gets no Tavern row.
  const notice = data.classNotice ?? null;
  if (!data.member) return <ClassNoticeLine threadId={threadId} notice={notice} standalone />;
  const armedLine = isArmed ? <ArmedLine onCancel={armed.disarm} onError={setError} /> : null;
  // Arming comes from the user's own pick on the page, so a hidden row, or one the Widget row setting turned off, shows the armed line
  // alone until it ends.
  if (data.hidden || data.widgetRow === false) return armedLine ? <section className="tavern twidget v-armed" aria-label="Tavern: new board quest" data-part="TavernWidget">{armedLine}<QueryState error={error} /></section> : <ClassNoticeLine threadId={threadId} notice={notice} standalone />;
  const names = registry.data ?? { classes: [], characters: [] };
  const name = memberIdentityLabel(data.member, names);
  const identity = registry.data ? memberIdentity(registry.data, data.member) : null;
  const toggle = (what: Exclude<Open, null>) => setOpen(open === what ? null : what);
  const variant = keeper ? "keeper" : data.member.role === "member" ? "member" : "solo";
  const clusterWarning = keeper && data.scope?.clusterGuard !== "armed" ? clusterGuardWords(data.scope) : null;
  const lit = !!identity && !identity.character.plain;
  const surface: CSSProperties & { "--widget-edge": string } = { ...(lit ? glowVars(data.boardQuest ? `quest:${data.boardQuest.id}` : `keeper:${threadId}`) : {}), "--widget-edge": lit ? HUE_CSS[identity.character.hue] : "var(--tavern-line)" };
  const hideBtn = <IconButton glyph="close" className="tw-hide" label="Hide Tavern in this thread (⌥⌘T). The crest in the composer brings it back" onClick={() => void hide.mutate({ threadId, hidden: true }).catch(setError)} />;
  const changeCharacter = async (patch: SettingsPatch, text: string) => {
    if (savingCharacter.current) return;
    savingCharacter.current = true;
    setError(null);
    try {
      const { revision } = await readSettings.call("settings", null);
      const characters = patch.tavern?.characters;
      if (characters !== undefined && stack.current?.contains(document.activeElement))
        focusAfterCharacterChange.current = characters ? "actor" : "restore";
      const out = await updateSettings.mutate({ revision, patch, why: "Changed from the composer’s character controls" });
      if (out.code === "stale") throw new Error("Settings changed elsewhere. Nothing was saved; try again.");
      if (out.code === "invalid") throw new Error(out.problems.map(problem => problem.message).join("; "));
      setReceiptFocused(false);
      setCharacterReceipt({ text: characters === false ? `${text} Settings → Atmosphere.` : `${text} Also in Settings, Atmosphere.`, show: characters === false });
    } catch (error) {
      focusAfterCharacterChange.current = null;
      setError(error);
    } finally {
      savingCharacter.current = false;
    }
  };
  const restoreCharacters = () => void changeCharacter(charactersPatch(true), "Characters shown.");
  const showCharacters = data.characters === false && <IconButton glyph="party" className="tw-show-characters" label="Show characters"
    disabled={updateSettings.isPending} onClick={restoreCharacters} />;
  const walker = data.characters !== false && identity && !identity.character.plain
    ? <ThreadPartyStrip key={`${threadId}:${identity.character.id}`} data={data} character={identity.character}
        classLabel={identity.cls.label} voice={data.voice ?? registry.data?.voice ?? "full"} pageSince={pageSince} change={changeCharacter}
        held={need.asks + need.holds > 0 || (!keeper && scopeAlerts(data) > 0)} />
    : null;

  return (
    <div className="tavern-thread-stack" ref={stack}>
    {characterReceipt && <div ref={receiptEl} className="tavern twalk-receipt">
      <p className="receipt-inline" role="status"><Glyph name="check" size={12} /><small className="twalk-receipt-text" title={characterReceipt.text}>{characterReceipt.text}</small></p>
      {characterReceipt.show && data.characters === false && <button type="button" className="lnk twalk-show-receipt" title="Show characters"
        onClick={restoreCharacters} onFocus={() => setReceiptFocused(true)} onBlur={() => setReceiptFocused(false)} disabled={updateSettings.isPending}>Show</button>}
    </div>}
    {walker}
    <section className={`tavern twidget v-${variant} ${lit ? "glow" : ""} ${open ? "is-open" : ""} ${keeper?.quietSince != null ? "is-quiet" : ""}`} style={surface} aria-label="Tavern widget" data-part="TavernWidget">
      <div className="tw-row">
        {identity && data.member && keeper && <span className={`tw-id ${keeper ? `st-${keeper.quietSince != null ? "quiet" : keeper.status}` : ""}`} title={`This thread: ${name}, ${identity.cls.label} (${identity.cls.plain})${keeper ? ` · ${data.pendingEvents ?? 0} updates waiting for the Keeper’s next turn · ${keeper.quietSince != null ? `quiet: ${KEEPER_STATE_HINT.quiet}` : `${STATUS_WORD[keeper.status]}: ${STATUS_HINT[keeper.status]}`}` : ""}`}><span className="tw-crest"><Crest {...identity} size={18} />{keeper && <i ref={dot} className="tw-dot" aria-hidden="true" />}</span>{<span className="who-t tw-name"><b>{name}</b>{keeper ? <span aria-hidden="true"> · </span> : <span className="anc">{identity.cls.label} · {identity.cls.plain}</span>}</span>}{keeper && <span className="sr">Keeper, {STATUS_WORD[keeper.status]}</span>}</span>}
        {!keeper && data.member && registry.data && <button type="button" className="tw-id tw-member-id act" title={memberIdentityWords(data.member, registry.data, data.scope, memberFinished(data))} aria-label={memberIdentityWords(data.member, registry.data, data.scope, memberFinished(data))} aria-expanded={open === "brief"} aria-controls={`tw-brief-${threadId}`} onClick={() => toggle("brief")}>
          {identity && <span className="tw-crest"><Crest {...identity} size={18} /></span>}
          <span className="who-t tw-name"><b>{name}</b><span className="tw-member-class"> · {identity?.cls.label ?? data.member.classId}</span></span>
        </button>}
        {keeper && <KeeperParts quiet={<QuietNotice threadId={threadId} since={keeper.quietSince} compact />} data={data} open={open} toggle={toggle} onLedger={group => panel.openTab({ tab: LEDGER_TAB, ...(group ? { params: { attentionGroup: group } } : {}) })} onQuest={id => navigate.toPluginPanel("tavern", { subPath: `quest/${id}` })} />}
        {variant === "member" && <MemberParts data={data} registry={registry.data ?? null} open={open} toggle={toggle} onQuest={id => navigate.toPluginPanel("tavern", { subPath: `quest/${id}` })} onThread={id => navigate.toThread(id)} />}
        {showCharacters}{hideBtn}
      </div>
      {clusterWarning && <p className="tw-cluster-warning">{clusterWarning}</p>}
      {variant === "member" && data.boardQuest && <WidgetWaypoints member={data.member} reported={data.lastReportedWaypointId} />}
      {open !== "brief" && <PlacementFacts placement={data.member.placement} memberName={name} />}
      <ClassNoticeLine threadId={threadId} notice={notice} />
      {armedLine}
      <QueryState error={error} />
      {keeper && open === "asks" && <AsksPanel threadId={threadId} asks={keeper.openAsks} holds={heldQuests(keeper.boardQuests, keeper.openAsks)} quests={keeper.boardQuests} revealAskId={revealAskId} revealVersion={revealVersion} onClose={() => setOpen(null)} />}
      {keeper && keeper.quietSince == null && open === "quests" && <div id={`tw-quests-${threadId}`} className="tw-panel tw-quest-popover" role="region" aria-label="Board quests">
        <ul>{keeper.boardQuests.map(q => <li key={q.id}><button type="button" className="lnk-btn act" onClick={() => { setOpen(null); navigate.toPluginPanel("tavern", { subPath: `quest/${q.id}` }); }}><b>{q.title}</b><OpensMark /></button>{!!q.attention?.summaries && <span className="m">{summaryCountWords(q.attention.summaries)}</span>}</li>)}</ul>
        <div className="tw-pf"><button type="button" className="btn sm" onClick={() => { setOpen(null); panel.openTab({ tab: LEDGER_TAB }); }}>Open the Ledger</button><button type="button" className="btn sm" onClick={() => setOpen(null)}>Close</button></div>
      </div>}
      {keeper && open === "decided" && <DecidedPanel threadId={threadId} data={data} />}
      {open === "brief" && !keeper && <div className="tw-panel tw-brief" id={`tw-brief-${threadId}`} role="region" aria-label="Member"><MemberPanel key={threadId} data={data} cue={data.ambientMotion === "off" ? undefined : cue} registry={registry.data ?? null} scopeDetails={<ScopePanel data={data} />} onQuest={id => navigate.toPluginPanel("tavern", { subPath: `quest/${id}` })} /></div>}
    </section>
    </div>
  );
}

/**
 * The widget row while it loads: its frame from the first frame, its shapes at the kit's delay, in the row's own classes so the
 * height is the real row's at every width (24 px chips, 44 px on phones) and bb's composer below does not move when it swaps.
 */
export function SkWidget({ keeper, shown }: { keeper: boolean; shown: boolean }) {
  return <Skeleton label="the Tavern row" shown={shown} className={`tavern twidget v-${keeper ? "keeper" : "member"} sk-widget`}>
    <div className="tw-row">
      <span className="tw-id"><span className="tw-crest"><SkCrest size={18} /></span><span className="who-t tw-name"><SkLine w="10ch" /></span></span>
      <span className="tw-chip"><SkLine w={keeper ? "9ch" : "12ch"} /></span>
      <span className="tw-chip"><SkLine w="6ch" /></span>
      <span className="tw-sp" />
      <span className="ibtn" />
    </div>
  </Skeleton>;
}

/** The page's "Start a quest" opened this Keeper: the user's next message can become a new board quest. bb's plain send can't be redirected, so the line carries the action. */
/**
 * The server's note on how this thread started against its class (first turn only): a default class that couldn't start, a model or
 * reasoning that differs from the class's. It shows even with the row hidden, because a start is never changed silently. After a switch,
 * one receipt says what bb applied, until the next send.
 */
export function ClassNoticeLine({ threadId, notice, standalone = false }: { threadId: string; notice: ClassNotice | null; standalone?: boolean }) {
  const composer = useComposer();
  const pluginId = experimental_usePluginId();
  const apply = experimental_useRpcMutation({ contract: rpcContract, method: "applyClassExecution" });
  const dismiss = experimental_useRpcMutation({ contract: rpcContract, method: "dismissClassNotice", optimistic: (input, cache) => cache.update("decor", { threadId: input.threadId }, d => ({ ...d, classNotice: null })) });
  const [receipt, setReceipt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => composer.onSubmitted(() => setReceipt(null)), [composer]);
  if (!notice && !receipt) return null;
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const use = () => { setError(null); void apply.mutate({ threadId }).then(r => setReceipt(`Now on ${[r.model ? modelLabel(r.model) : null, r.reasoningLevel ? `${r.reasoningLevel} reasoning` : null].filter(Boolean).join(" · ") || "the class’s settings"}.`), fail); };
  const switchTo = notice?.switchExecution ? [notice.switchExecution.model ? modelLabel(notice.switchExecution.model) : null, notice.switchExecution.reasoningLevel ? `${notice.switchExecution.reasoningLevel} reasoning` : null].filter(Boolean).join(" · ") : "";
  // bb confirmed the switch, so the receipt replaces the note even before the cleared note arrives.
  const line = notice && !receipt
    ? <p className="tw-class-notice" data-part="ClassNotice">
        <Glyph name="bell" size={13} />
        <span className="tw-cn-t">{notice.message}</span>
        {notice.switchExecution && <button type="button" className="btn sm" disabled={apply.isPending} title={switchTo ? `Switch this thread to ${switchTo}` : "Switch this thread to its class's model and reasoning"} onClick={use}>Use class settings</button>}
        {notice.settings && <UrlLink href={`/settings/plugins/${encodeURIComponent(pluginId)}`} className="lnk-btn act" title="Tavern's settings: New threads start as"><span>Settings</span><OpensMark /></UrlLink>}
        {/* A word, not a ×: the row's own × hides Tavern, and the two sit one above the other on a phone. An action, so a .btn (README: interaction rules). */}
        <button type="button" className="btn sm tw-cn-x" aria-label="Dismiss this note" title="Dismiss this note; the thread keeps its settings" onClick={() => { setError(null); void dismiss.mutate({ threadId }).catch(fail); }} disabled={dismiss.isPending}>Dismiss</button>
      </p>
    : <p className="tw-class-notice is-done" role="status" data-part="ClassNotice"><Glyph name="check" size={13} /><span className="tw-cn-t">{receipt}</span></p>;
  const body = <>{line}{error && <p className="problem tw-class-err" role="alert">{error}</p>}</>;
  return standalone ? <section className="tavern twidget v-notice" aria-label="Tavern: how this thread started" data-part="TavernWidget">{body}</section> : body;
}

function ArmedLine({ onCancel, onError }: { onCancel: () => void; onError: (e: unknown) => void }) {
  const composer = useComposer();
  const [sending, setSending] = useState(false);
  const empty = composer.isEmpty;
  const send = async () => { setSending(true); try { await composer.submit({ experimental_data: { route: "new-quest" } }); } catch (e) { onError(e); } finally { setSending(false); } };
  return (
    <div className="tw-armed" role="group" aria-label="New board quest" title="Your next message can start a new board quest (goal)">
      <Glyph name="board-quest" size={14} />
      <span className="tw-text">Your next message can start a new board quest <span className="anc">goal</span></span>
      <button type="button" className="btn sm" disabled={empty || sending || composer.isSubmitting} aria-disabled={empty || sending} title={empty ? "Type the goal first, then send it as a new board quest" : "Send what you typed as a new board quest (goal) for this Keeper"} onClick={() => void send()}>Send as a new quest</button>
      <button type="button" className="lnk-btn" title="Keep this a normal message" onClick={() => { onCancel(); composer.focus(); }}>Cancel</button>
    </div>
  );
}

/** The widget's words for the server's Keeper status; "listening" reads as "idle" (keeperStatus says why). */
const STATUS_WORD = { listening: "idle", busy: "busy", holding: "holding while you type" } as const;
const STATUS_HINT = { listening: KEEPER_STATE_HINT.idle, busy: KEEPER_STATE_HINT.busy, holding: KEEPER_STATE_HINT.holding } as const;
function KeeperParts({ data, open, toggle, onLedger, onQuest, quiet }: { data: ThreadDecor; open: Open; toggle: (o: "asks" | "decided" | "quests") => void; onLedger: (group?: "need" | "new") => void; onQuest: (id: string) => void; quiet: ReactNode }) {
  const keeper = data.keeperView!;
  const list = attentionView(keeper.attention), need = list.needYou;
  const decided = list.new;
  // A quiet Keeper moves no quest until resumed, so the notice takes the quests' place; the quest pages stay one click away in the Ledger.
  return <>
    {quiet}
    {keeper.quietSince == null && <span className={`tw-quests ${keeper.boardQuests.reduce((n, q) => n + q.short.length, 0) > 18 ? "long" : ""}`} role="group" aria-label="Board quests (goals)">
      {keeper.boardQuests.map(q => {
        const unread = q.attention?.summaries ?? 0;
        const suffix = unread ? `, ${summaryCountWords(unread)}` : "";
        return <button type="button" key={q.id} className="tw-quest act" title={`Open the quest page: ${q.title} · ${q.phase} · plan v${q.planVersion} · ${q.move.text}${suffix}`} aria-label={`Open the quest page for ${q.title}: ${q.phase}, plan v${q.planVersion}${suffix}`} onClick={() => onQuest(q.id)}><b>{q.short}</b>{unread > 0 && <span className="tw-unread m" aria-hidden="true">{unread} new</span>}{q.phase === "held" ? <span>{q.move.text}</span> : <><Phase phase={q.phase} />{q.phase === "scout" && q.nextNewsBy != null && <span>{q.move.text}</span>}</>}<OpensMark /></button>;
      })}
    </span>}
    {keeper.quietSince == null && keeper.boardQuests.length > 0 && <button type="button" className="tw-chip tw-quests-count act" title={keeper.boardQuests.map(q => q.title).join(" · ")} aria-label={`Show ${plural(keeper.boardQuests.length, "quest")}`} aria-expanded={open === "quests"} aria-controls={`tw-quests-${data.threadId}`} onClick={() => toggle("quests")}>{plural(keeper.boardQuests.length, "quest")}</button>}
    {/* The free space carries the status words and measures itself, so they show only when the whole phrase fits; the dot, the crest's tooltip and the hidden name carry it otherwise. */}
    <span className="tw-sp tw-free">{keeper.status === "holding" && keeper.quietSince == null && <span className="tw-sw" aria-hidden="true">holding<span className="tw-sw-x"> while you type</span></span>}</span>

    {/* A count of nothing is not shown: no asks chip and no decided chip at zero, unless its panel is open, so Close stays reachable after the last answer. */}
    {need > 0 && <button type="button" className="tw-asks act has" data-ask title={attentionTitle(list, "need")} aria-label={`${need} need you: open the Ledger`} onClick={() => onLedger("need")}><Glyph name="ask" size={13} /><span className="num">{need}</span><span className="tw-w">need you</span><OpensMark /></button>}
    {decided > 0 && <button type="button" className="tw-chip tw-new act" title={attentionTitle(list, "new")} aria-label={`${decided} new: open the Ledger`} onClick={() => onLedger("new")}><Glyph name="bell" size={13} /><span className="num">{decided}</span><span className="tw-w">new</span><OpensMark /></button>}
    <button type="button" className="tw-chip tw-ledger act" aria-label="Open the Keeper’s ledger (what the lead knows)" title="Open the Keeper’s ledger (what the lead knows)" onClick={() => onLedger()}><Glyph name="book" size={13} /><span>Ledger</span><span className="anc tw-anc">lead state</span><OpensMark /></button>
  </>;
}

function Phase({ phase }: { phase: QuestPhase }) {
  const phases = PHASE_STEPS.map(step => step.id);
  const at = phaseIndex(phase);
  return <span className="tw-ph" aria-hidden="true">{phases.map((p, i) => <i key={p} className={i < at ? "d" : i === at ? "c" : ""} />)}<span className="tw-pw">{phase === "closing" ? phaseWord(phase) : phase}</span></span>;
}

const scopeAlerts = (data: ThreadDecor) => (data.scope?.problems?.length ?? 0) + (data.violations?.filter(v => v.mode !== "watch").length ?? 0) + (data.scope?.error ? 1 : 0) + (data.scope?.pendingAskId ? 1 : 0);

/** A member's guardrails in plain words: the mode, what it may touch, policy problems, and each rule break with whether it was stopped. */
function ScopePanel({ data }: { data: ThreadDecor }) {
  const revoke = experimental_useRpcMutation({ contract: rpcContract, method: "revokeShellGrant" });
  const [grantError, setGrantError] = useState<unknown>(null);
  const ms = data.scope; if (!ms) return <p className="m">No scope details are recorded for this member.</p>;
  const mode = ms.mode ?? "enforce"; const sc = ms.scope; const observations = data.violations ?? [];
  const watch = watchActWords(observations);
  const otherWatch = observations.filter(v => v.mode === "watch" && !v.act).length;
  const violations = observations.filter(v => v.mode !== "watch");
  return <section className="tw-scope" aria-label="Scope (guardrails)">
    <h4>Scope details</h4>
    <p className="m small">The act catalogue checks shell commands, not non-shell tool actions or commands inside an interpreter.</p>
    {ms.error && <p className="problem" role="alert">The scope could not be applied: {ms.error}</p>}
    {sc && mode !== "off" && <ul className="tw-sfacts">{sc.writes.allow.length > 0 && <li>Allowed write paths: {sc.writes.allow.join(", ")}</li>}{sc.shell.deny.length > 0 && <li>{plural(sc.shell.deny.length, "blocked command rule")}</li>}</ul>}
    {ms.pendingAskId && <p className="m small">A wider scope is waiting for your answer in the Keeper’s thread.</p>}
    {(ms.problems ?? []).length > 0 && <ul className="tw-sprob" aria-label="Policy problems">{ms.problems!.map((pr, i) => <li key={i}><b>Policy problem</b> <span>{pr}</span></li>)}</ul>}
    {ms.shellGrants?.length ? <div className="tw-shell-grants">
      <h4>Shell grants</h4>
      <ul aria-label="Shell grants">{ms.shellGrants.map(grant => <li key={grant.id}>
        <code>{grant.target.command}</code>
        <span className="m tw-grant-target"><code>{grant.target.cwd}</code>{grant.target.destinations?.map(value => <code key={value}>{value}</code>)}</span>
        <span>{grant.scope === "once" ? "Once" : "For this quest"}</span>
        <span className="m">{grant.state === "issued" ? mode !== "enforce" ? "Not enforced in this mode" : grant.usable ? "Ready" : ms.restartNeeded ? "Waiting for restart" : "Ready for the member's next session" : { used: "Used", expired: "Ended", revoked: "Revoked" }[grant.state]}</span>
        {grant.state === "issued" && <button type="button" className="btn sm" disabled={revoke.isPending} onClick={() => { setGrantError(null); void revoke.mutate({ threadId: data.threadId, id: grant.id }).catch(setGrantError); }}>Revoke</button>}
      </li>)}</ul>
      <QueryState error={grantError} />
    </div> : null}
    {watch && <p className="m small">{watch}</p>}
    {otherWatch > 0 && <p className="m small">{plural(otherWatch, "other Watch observation")}. Nothing was stopped.</p>}
    {violations.length > 0 && <ul className="tw-viol" aria-label="Rule breaks">{violations.map(v => <li key={`${v.eventId}-${v.seq}`} className={v.stopped ? "stopped" : "missed"}><span className="vs">{v.stopped ? "Stopped" : "Not stopped"}</span><span className="vr">{v.reason} <code>{v.ruleId}</code>{v.stopError ? <span className="m"> · {v.stopError}</span> : null}</span><TimeAgo at={v.at} /></li>)}</ul>}
    {ms.restartNeeded ? <p className="m small"><b>Restart needed.</b> {ms.restartNeeded}</p> : <p className="m small">A scope change applies to the next guarded call.</p>}
  </section>;
}

const waypointWords = (id: string | null) => id ? `waypoint ${id.replace(/^w(?=\d+$)/, "")}` : "no waypoint";

function WidgetWaypoints({ member, reported }: { member: NonNullable<ThreadDecor["member"]>; reported?: string | null }) {
  const current = member.checkerWaypointId ?? member.waypointId;
  const differentReport = reported && reported !== current ? reported : null;
  if (!differentReport) return null;
  return <p className="tw-waypoints"><span className={current ? "tw-waypoint-compact" : undefined}>Current: {waypointWords(current)}</span><span>Last report: {waypointWords(differentReport)}</span></p>;
}

function MemberParts({ data, registry, open, toggle, onQuest, onThread }: { data: ThreadDecor; registry: Registry | null; open: Open; toggle: (o: "brief") => void; onQuest: (id: string) => void; onThread: (id: string) => void }) {
  const m = data.member!;
  const keeperId = data.keeper && registry ? memberIdentity(registry, data.keeper) : null;
  const current = m.checkerWaypointId ?? m.waypointId;
  const wp = waypointWords(current);
  const keeperName = data.keeper ? memberIdentityLabel(data.keeper, registry ?? { classes: [], characters: [] }) : null;
  return <>
    {m.errand || !data.boardQuest
      ? <span className="tw-fact" title={m.title ?? undefined}><b>Side quest</b> <span className="anc">errand</span></span>
      : <button type="button" className="tw-chip tw-where act" title={`Open the quest page: ${data.boardQuest.title} · ${wp}${m.title ? ` · ${m.title}` : ""}`} aria-label={`Open the quest page for ${data.boardQuest.title}, ${wp}`} onClick={() => onQuest(data.boardQuest!.id)}><b>{data.boardQuest.short}</b>{current && <span className="tw-w">· {wp}</span>}<OpensMark /></button>}
    {keeperId && data.keeper && <button type="button" className="tw-chip tw-keeper act" title={`Open ${keeperName}’s thread: Keeper (lead) of this member`} aria-label={`Open ${keeperName}’s thread, the Keeper (lead) this member reports to`} onClick={() => onThread(data.keeper!.threadId)}><Crest {...keeperId} size={14} /><span className="tw-kn">{keeperName}</span><OpensMark /></button>}
    <span className="tw-sp" />
    {(() => { const alerts = scopeAlerts(data); const label = `Member${alerts ? `, ${plural(alerts, "scope alert")}` : ""}: show this member’s class, brief and guardrails`; return <button type="button" className={`tw-chip act ${alerts ? "tw-alert" : ""}`} aria-expanded={open === "brief"} aria-controls={`tw-brief-${data.threadId}`} title={label} aria-label={label} onClick={() => toggle("brief")}><Glyph name="eye" size={13} /><span className="tw-brief-w">Member</span>{alerts > 0 && <span className="tw-al">{plural(alerts, "alert")}</span>}<ExpandsMark open={open === "brief"} /></button>; })()}
  </>;
}

type KeeperView = NonNullable<ThreadDecor["keeperView"]>;
type HeldQuest = KeeperView["boardQuests"][number];
/** Attention holds the row still until the underlying user actions finish. */
const needsOf = (keeper: KeeperView | null | undefined) => ({ asks: attentionView(keeper?.attention).needYou, holds: 0 });
const holdKey = (hold: CheckerHandoffHold) => `hold:${hold.id}`;

function AsksPanel({ threadId, asks, holds, quests, revealAskId, revealVersion, onClose }: { threadId: string; asks: Ask[]; holds: HeldQuest[]; quests: KeeperView["boardQuests"]; revealAskId: string | null; revealVersion: number; onClose: () => void }) {
  const only = asks.length + holds.length === 1 ? asks[0]?.id ?? holdKey(activeHold(holds[0]!)!) : null;
  const [expanded, setExpanded] = useState<string | null>(only);
  const [receipts, setReceipts] = useState<Ask[]>([]);
  const [released, setReleased] = useState<{ quest: HeldQuest; hold: CheckerHandoffHold }[]>([]);
  useEffect(() => { if (revealAskId && acknowledgeAskReveal(threadId, revealVersion)) setExpanded(revealAskId); }, [threadId, revealAskId, revealVersion]);
  const shown = [...asks, ...receipts.filter(r => !asks.some(a => a.id === r.id))];
  // A released hold keeps its receipt until the panel closes, even after the server's next read drops it.
  const waiting = holds.filter(q => !released.some(r => r.hold.id === activeHold(q)!.id));
  return (
    <div className="tw-panel tw-asks-p" id={`asks-${threadId}`} role="region" aria-label="Asks waiting for you">
      {shown.length + waiting.length + released.length === 0 ? <p className="m small tw-none">Nothing needs you.</p> : shown.map(ask => {
        const q = quests.find(b => b.id === ask.boardQuestId);
        const isOpen = expanded === ask.id;
        const done = !asks.some(a => a.id === ask.id);
        return (
          <div className={`tw-ask k-${ask.releaseHoldId ? "hold" : ask.kind} ${isOpen ? "open" : ""}`} key={ask.id} {...(done ? {} : { "data-ask": "" })}>
            {!done && (
              <button type="button" className="tw-ask-row act" aria-expanded={isOpen} onClick={() => setExpanded(isOpen ? null : ask.id)}>
                {/* The Keeper's ask to release a hold is the hold, so it reads as one, not as a blocker. */}
                <span className="tw-ak">{ask.releaseHoldId ? "Checker handoff" : KIND_WORD[ask.kind]}</span>
                <span className="tw-aq" title={ask.question}>{ask.question}</span>
                {q && <span className="tw-ag">{q.short}</span>}
                <TimeAgo at={ask.createdAt} />
                <span className="tw-ago">{isOpen ? "Fold" : "Answer"}<ExpandsMark open={isOpen} /></span>
              </button>
            )}
            {/* The row keeps the question to one line; the panel prints it in full, wrapped, so it reads before you answer. */}
            {isOpen && !done && <p className="tw-aq-open" data-content>{ask.question}</p>}
            {isOpen && !done && ask.kind === "greenlight" && <p className="m small tw-same">The same seal as the quest map card in the chat: sealing either one seals both.</p>}
            {(isOpen || done) && <AskCard ask={ask} via="banner" headless={!done} onFold={() => setExpanded(null)} onAnswered={a => setReceipts(r => [...r, a])} />}
          </div>
        );
      })}
      {waiting.map(q => { const hold = activeHold(q)!, key = holdKey(hold); return <HoldItem key={key} quest={q} hold={hold} open={expanded === key} onToggle={() => setExpanded(expanded === key ? null : key)} onReleased={h => setReleased(r => [...r, { quest: q, hold: h }])} />; })}
      {released.map(r => <HoldReceipt key={holdKey(r.hold)} quest={r.quest} hold={r.hold} />)}
      <div className="tw-pf">{asks.length > 0 ? <span className="m small">Answering here clears the ask everywhere: the common room, the phone and the chat pointer.</span> : waiting.length > 0 ? <span className="m small">Releasing here clears the hold everywhere: the common room and the quest page.</span> : <span />}<button type="button" className="btn sm" onClick={onClose}>Close</button></div>
    </div>
  );
}
/**
 * A checker-handoff hold, drawn like an ask beside the asks and never animated: the Keeper hires or re-tasks no Warden on the quest
 * until the user releases it. The server's answer is the receipt; a refusal says why in words and leaves the control in place.
 */
function HoldItem({ quest, hold, open, onToggle, onReleased }: { quest: HeldQuest; hold: CheckerHandoffHold; open: boolean; onToggle: () => void; onReleased: (hold: CheckerHandoffHold) => void }) {
  const release = experimental_useRpcMutation({ contract: rpcContract, method: "releaseCheckerHandoff" });
  const [problem, setProblem] = useState<string | null>(null);
  const now = useNow();
  const press = async () => {
    setProblem(null);
    try { onReleased((await release.mutate({ boardQuestId: quest.id, holdId: hold.id, via: "banner" })).checkerHandoffHold); }
    catch (e) { setProblem(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <div className={`tw-ask k-hold ${open ? "open" : ""}`} data-ask>
      <button type="button" className="tw-ask-row act" aria-expanded={open} onClick={onToggle}>
        <span className="tw-ak">Checker handoff</span>
        <span className="tw-aq" title={hold.reason} data-content>{hold.reason}</span>
        <span className="tw-ag">{quest.short}</span>
        <TimeAgo at={hold.createdAt} />
        <span className="tw-ago">{open ? "Fold" : "Review"}<ExpandsMark open={open} /></span>
      </button>
      {open && <section className="tavern ask k-hold" aria-label={`Checker handoff on hold: ${quest.short}`}>
        <p className="ask-why">No Warden is hired or re-tasked on this quest until you release it.</p>
        <p className="m small tw-hold-src">Held at {localTime(hold.createdAt, now)}, from your message: <Clamp text={`“${hold.sourceText}”`} /></p>
        {problem && <p className="problem" role="alert">Couldn’t release it: {problem}</p>}
        <div className="ask-f">
          <button type="button" className="btn pri" disabled={release.isPending} onClick={() => void press()} title="Lets the Keeper hand the work to a Warden for checking">{release.isPending ? "Releasing…" : "Release checker handoff"}</button>
          <button type="button" className="btn" onClick={onToggle}>Not now</button>
        </div>
      </section>}
    </div>
  );
}
function HoldReceipt({ quest, hold }: { quest: HeldQuest; hold: CheckerHandoffHold }) {
  const now = useNow();
  const r = hold.release; if (!r) return null;
  return <div className="tw-ask k-hold"><div className="tavern receipt" role="status" aria-label={`Checker handoff released: ${quest.short}`}><Glyph name="check" /><b>Checker handoff released</b><span className="m">at {localTime(r.at, now)}, {releaseWords(r)}. The Keeper can hand the work to a Warden now.</span></div></div>;
}
const KIND_WORD: Record<Ask["kind"], string> = { greenlight: "Quest map (greenlight)", decision: "Decision", conclude: "Conclude", production: "Production", "cluster-write": "Cluster write", merge: "Merge", destructive: "Destructive", "sends-as-you": "Sends as you", blocker: "Blocker", credential: "Credential", scope: "Scope change" };

function DecidedPanel({ threadId, data }: { threadId: string; data: ThreadDecor }) {
  const undo = experimental_useRpcMutation({ contract: rpcContract, method: "undoDecision" });
  const seen = useDecisionSeen({ keeperThreadId: threadId, throughId: data.keeperView!.decidedThroughId });
  const [error, setError] = useState<unknown>(null);
  return <div className="tw-panel" id={`decided-${threadId}`}><DecidedForYou decisions={data.keeperView!.decidedForYou} total={data.keeperView!.decidedCount} pending={undo.isPending} onUndo={id => void undo.mutate({ decisionId: id }).catch(setError)} {...seen} /><QueryState error={error} /></div>;
}

export function CrestToggle() { const composer = useComposer(); return composer.scope.kind === "thread" ? <ThreadToggle threadId={composer.scope.threadId} /> : null; }
function ThreadToggle({ threadId }: { threadId: string }) {
  const decor = experimental_useRpcQuery({ contract: rpcContract, method: "decor", input: { threadId } });
  const registry = useRegistry();
  const hide = experimental_useRpcMutation({ contract: rpcContract, method: "setHidden", optimistic: (input, cache) => cache.update("decor", { threadId: input.threadId }, d => ({ ...d, hidden: input.hidden })) });
  const [error, setError] = useState<unknown>(null);
  const data = decor.data;
  // With the Widget row setting off, a thread can't show the row, so there's no toggle to offer.
  if (!data?.member || data.widgetRow === false) return null;
  const identity = data.member && registry.data ? memberIdentity(registry.data, data.member) : null;
  const { asks: openAsks, holds } = needsOf(data.keeperView), asks = openAsks + holds;
  const counted = `${asks} need you`;
  return (
    <span className="tavern">
      <button type="button" className={`crest-toggle ${data.hidden ? "is-hidden" : ""}`} aria-label={`${data.hidden ? "Show" : "Hide"} Tavern · ${counted}`} title={data.hidden ? `Show Tavern (⌥⌘T)${asks ? ` · ${asks} need you` : ""}` : "Hide Tavern (⌥⌘T)"} aria-pressed={!data.hidden} disabled={hide.isPending} onClick={() => void hide.mutate({ threadId, hidden: !data.hidden }).catch(setError)}>
        {identity ? <Crest {...identity} size={16} /> : <TavernMark size={16} />}
        {data.hidden && asks > 0 && <span className="ask-dot" aria-hidden="true">{asks}</span>}
      </button>
      {error !== null && <span className="sr" role="alert">{error instanceof Error ? error.message : String(error)}</span>}
    </span>
  );
}
