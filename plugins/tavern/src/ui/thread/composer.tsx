import { useHandBackReply } from "./handback-reply";
import { attentionView, attentionTitle, attentionNotes } from "../../shared/attention";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type CSSProperties, type MouseEvent } from "react";
import { experimental_useRpcQuery, experimental_useRpcMutation, experimental_usePluginId, experimental_useAppPanel, useBbNavigate, useComposer, useRpc, UrlLink, type PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { charactersPatch, settingsContract, type SettingsPatch } from "../../shared/settings";
import { isSetupPrompt } from "../../shared/setup";
import { RetiredKeeperNotice } from "../kit/succession";
import { classDifferences, composerProjectId, fieldWords, rearmClassSettings, startRefusal, useClassStart } from "./class-start";
import { rpcContract, type ThreadDecor } from "../../shared/contract";
import type { Ask, CheckerHandoffHold, ClassDef, Phase as QuestPhase } from "../../shared/schema";
import type { ClassNotice } from "../../shared/class-execution-contract";
import { AskCard, Crest, KeeperNoteRows, PhaseStrip, StatusPill, DecidedForYou, useDecisionSeen, ExpandsMark, Glyph, IconButton, OpensMark, QueryState, Skeleton, SkCrest, SkLine, TimeAgo, Vocabulary, memberIdentity, plural, useRegistry, useSkeletonCount, useSkeletonDelay, type Registry, glowVars, QuietNotice, useArmedNewQuest, activeHold, heldQuests, releaseWords, Clamp, localTime, useNow } from "../kit";
import { PHASE_STEPS, phaseIndex, phaseWord } from "../kit/phase";
import { LEDGER_TAB } from "./tabs";
import { pathProgress, summaryCountWords } from "../kit/rows";
import { NewSummaries } from "./new-summaries";
import { useWidgetPanel, threadDecorCache, type WidgetPanel } from "./state";
import { useChangeCue, useTavernMotion } from "../kit/motion";
import { ThreadPartyStrip } from "../engine/thread-party";
import { takeArmedClass } from "../kit/remember";
import { MemberPanel, memberFinished } from "./member-brief";
import { memberIdentityWords } from "../kit/member-identity";
import { keeperGuards, keeperState, useKeeperStop } from "./keeper-state";
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

type Open = NonNullable<WidgetPanel>["kind"] | null;
type KeeperSection = Exclude<Open, "brief" | null>;
const SECTION_LABEL = { asks: "Asks waiting for you", decided: "New for you", quests: "Board quests" };
const LEDGER_LABEL = "Open the Keeper’s ledger (what the lead knows)";
const sectionId = (threadId: string, kind: KeeperSection) => `tw-${kind}-${threadId}`;

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
  const [widgetPanel, setWidgetPanel] = useWidgetPanel(threadId);
  const open = widgetPanel?.kind ?? null;
  const opener = useRef<{ threadId: string; kind: KeeperSection; button: HTMLButtonElement } | null>(null);
  const [error, setError] = useState<unknown>(null);
  useHandBackReply(threadId, composer, setError);
  const lastTyping = useRef(0);
  const [pageSince] = useState(Date.now);
  const data = decor.data;
  const keeper = data?.keeperView;
  const stopped = useKeeperStop(!!keeper);
  const retired = data?.succession?.state === "done" && data.succession.current !== threadId;
  useEffect(() => {
    if (!retired) return;
    composer.setInputLock(true);
    return () => composer.setInputLock(false);
  }, [composer, retired]);
  // The row's skeleton shows only where this device last saw a row (2 a Keeper's, 1 a member's), so a plain thread never flashes one.
  const lastRow = useSkeletonCount(`skel:thread:widget:${threadId}`, data ? (!data.member || data.hidden || data.widgetRow === false ? 0 : data.keeperView ? 2 : 1) : undefined, 0);
  const skeletonShown = useSkeletonDelay(!data && decor.isLoading && lastRow > 0);
  const armed = useArmedNewQuest(threadId);
  const isArmed = armed.armed && !!keeper;
  // Any successful send ends the arm: "Send as a new quest" goes through the same submit, and a plain send was the user's choice.
  useEffect(() => { if (!isArmed) return; return composer.onSubmitted(() => armed.disarm()); }, [isArmed, composer, armed.disarm]);
  useEffect(() => { if (data) threadDecorCache.set(threadId, data); return () => { threadDecorCache.delete(threadId); }; }, [threadId, data]);
  // Motion: the row holds still while an ask is in it, and for 2 s after the user types (the coordinator's hold; a restored draft doesn't
  // count); the busy dot pulses twice when its Keeper turns busy or the row comes into view busy, then holds solid.
  const need = needsOf(keeper);
  const held = !!stopped || need.asks + need.holds > 0 || (!keeper && Boolean(data?.openScopeAsk || data?.scope?.pendingAskId || data?.scope?.error));
  const { cue, settle } = useTavernMotion(`thread:${threadId}`, { held });
  const dot = useRef<HTMLElement>(null);
  const pulsing = !stopped && !!keeper && keeper.quietSince == null && keeper.status === "busy" && !!data?.member && !!registry.data;
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
    if (document.activeElement === document.body) {
      const button = stack.current?.querySelector<HTMLElement>(target === "actor" ? "button[data-actor]" : ".tw-row .tw-show-characters");
      const visible = button && getComputedStyle(button).display !== "none" ? button : stack.current?.querySelector<HTMLElement>(".tw-expand");
      visible?.focus({ preventScroll: true });
    }
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
    if (!keeper || retired || !composer.text.trim()) return;
    const ping = () => { lastTyping.current = Date.now(); void typing.mutate({ threadId }).catch(setError); };
    const timer = setTimeout(ping, Math.max(500, 10000 - (Date.now() - lastTyping.current)));
    return () => clearTimeout(timer);
  }, [composer.text, threadId, !!keeper, retired, typing.mutate]);
  if (retired) return <RetiredKeeperNotice view={data!.succession!} />;
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
  const toggle = (kind: "brief") => setWidgetPanel(open === kind ? null : { kind });
  const keeperSection = keeper && open !== "brief" ? open : null;
  const attention = attentionView(keeper?.attention);
  const holds = keeper && keeperSection === "asks" ? heldQuests(keeper.boardQuests, keeper.openAsks) : [];
  const activity = keeper ? keeperState(keeper, stopped) : null;
  const activityLabel = activity ? `${activity.word}${activity.since == null ? "" : ` since ${new Date(activity.since).toLocaleString()}`}: ${activity.detail}` : "";
  const guard = keeperGuards(data.scope);
  const closePanel = (from?: HTMLButtonElement) => {
    const trigger = open === "asks" ? ".tw-asks" : open === "quests" ? ".tw-quest" : open === "brief" ? ".tw-member-id" : ".tw-new";
    const button = from ?? (opener.current?.kind === open && opener.current.threadId === threadId ? opener.current.button : stack.current?.querySelector<HTMLButtonElement>(trigger));
    setWidgetPanel(null);
    opener.current = null;
    const fallback = stack.current?.querySelector<HTMLButtonElement>(".tw-expand");
    (button?.isConnected && !button.hasAttribute("data-empty") ? button : fallback)?.focus({ preventScroll: true });
  };
  const toggleSection = (kind: KeeperSection, button: HTMLButtonElement) => {
    if (open === kind) { closePanel(button); return; }
    opener.current = { threadId, kind, button };
    if (kind !== "asks") { setWidgetPanel({ kind }); return; }
    const ask = keeper?.openAsks[0];
    const holdQuest = !ask && keeper ? heldQuests(keeper.boardQuests, keeper.openAsks)[0] : undefined;
    const hold = holdQuest && activeHold(holdQuest);
    setWidgetPanel({ kind, askId: ask?.id ?? (hold ? holdKey(hold) : null) });
  };
  const onLedger = () => panel.openTab({ tab: LEDGER_TAB });
  const onQuest = (id: string) => navigate.toPluginPanel("tavern", { subPath: `quest/${id}` });
  const guardButton = guard.words.length > 0 && <button type="button" className="ibtn tw-guard act" data-warning={guard.warning || undefined}
    aria-label={`Open guardrails in the Ledger: ${guard.words.join(" · ")}`} title={`Open guardrails in the Ledger: ${guard.words.join(" · ")}`}
    onClick={() => panel.openTab({ tab: LEDGER_TAB, params: { attentionGroup: "guard" } })}><Glyph name="shield" /></button>;
  const variant = keeper ? "keeper" : data.member.role === "member" ? "member" : "solo";
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
        held={held} />
    : null;

  return (
    <div className="tavern-thread-stack" ref={stack}>
    {characterReceipt && <div ref={receiptEl} className="tavern twalk-receipt">
      <p className="receipt-inline" role="status"><Glyph name="check" size={12} /><small className="twalk-receipt-text" title={characterReceipt.text}>{characterReceipt.text}</small></p>
      {characterReceipt.show && data.characters === false && <button type="button" className="lnk twalk-show-receipt" title="Show characters"
        onClick={restoreCharacters} onFocus={() => setReceiptFocused(true)} onBlur={() => setReceiptFocused(false)} disabled={updateSettings.isPending}>Show</button>}
    </div>}
    {walker}
    <section className={`tavern twidget v-${variant} ${lit ? "glow" : ""} ${open ? "is-open" : ""} ${keeper?.quietSince != null ? "is-quiet" : ""}`} style={surface} aria-label="Tavern widget" data-part="TavernWidget" onKeyDown={event => {
      if (!open || event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      closePanel();
    }}>
      <div className="tw-row">
        {keeper && activity && <span className={`tw-id st-${stopped ? "stopped" : keeper.quietSince != null ? "quiet" : keeper.status}`} title={`This thread: ${name}${identity ? `, ${identity.cls.label} (${identity.cls.plain})` : ""} · ${activityLabel} · ${data.pendingEvents ?? 0} updates waiting for the Keeper’s next turn`}>
          {identity && <span className="tw-crest"><Crest {...identity} size={18} /></span>}
          <span className="who-t tw-name"><b>{name}</b></span>
          <span ref={dot} className="tw-dot" aria-hidden="true"><span className="tw-state">{activity.word}</span><Glyph name={activity.icon} size={10} /></span>
          <span className="sr">Keeper, {activityLabel}</span>
        </span>}
        {!keeper && data.member && registry.data && <button type="button" className="tw-id tw-member-id act" title={memberIdentityWords(data.member, registry.data, data.scope, memberFinished(data))} aria-label={memberIdentityWords(data.member, registry.data, data.scope, memberFinished(data))} aria-expanded={open === "brief"} aria-controls={`tw-brief-${threadId}`} onClick={() => toggle("brief")}>
          {identity && <span className="tw-crest"><Crest {...identity} size={18} /></span>}
          <span className="who-t tw-name"><b>{name}</b><span className="tw-member-class"> · {identity?.cls.label ?? data.member.classId}</span></span>
        </button>}
        {keeper && <>
          <QuietNotice threadId={threadId} since={stopped ? null : keeper.quietSince} compact onError={setError} />
          <KeeperParts data={data} open={keeperSection} onToggle={toggleSection} />
          {guardButton}
          <button type="button" className="tw-chip tw-ledger act" aria-label={LEDGER_LABEL} title={LEDGER_LABEL} onClick={onLedger}><Glyph name="book" size={13} /><span>Ledger</span><OpensMark /></button>
        </>}
        {variant === "member" && <MemberParts data={data} registry={registry.data ?? null} open={open} toggle={toggle} onQuest={id => navigate.toPluginPanel("tavern", { subPath: `quest/${id}` })} onThread={id => navigate.toThread(id)} />}
        {showCharacters}{hideBtn}
      </div>
      {variant === "member" && data.boardQuest && <WidgetWaypoints member={data.member} reported={data.lastReportedWaypointId} />}
      {open !== "brief" && <PlacementFacts placement={data.member.placement} memberName={name} />}
      <ClassNoticeLine threadId={threadId} notice={notice} />
      {armedLine}
      <QueryState error={error} />
      {keeper && keeperSection && <div id={sectionId(threadId, keeperSection)} className={`tw-panel ${keeperSection === "asks" ? "tw-asks-p" : keeperSection === "decided" ? "tw-new-panel" : "tw-quest-popover"}`} role="region" aria-label={SECTION_LABEL[keeperSection]}>
        <div className="tw-section-body">
          {widgetPanel?.kind === "asks" && <AsksPanel key={threadId} asks={keeper.openAsks} holds={holds} quests={keeper.boardQuests} attention={attention} expanded={widgetPanel.askId} onSelect={askId => setWidgetPanel({ kind: "asks", askId })} onClose={closePanel} onQuest={onQuest} onLedger={() => panel.openTab({ tab: LEDGER_TAB, params: { attentionGroup: "need" } })} />}
          {keeperSection === "decided" && <>
            <NewSummaries attention={attention} />
            <DecidedPanel threadId={threadId} data={data} />
          </>}
          {keeperSection === "quests" && <QuestBriefs quests={keeper.boardQuests} onQuest={onQuest} />}
        </div>
        <div className="tw-pf tw-section-actions">
          <button type="button" className="btn sm tw-panel-ledger" onClick={onLedger}>Open the Ledger</button>
          {guardButton}
          {showCharacters}
          <button type="button" className="btn sm" onClick={() => closePanel()}>Close</button>
        </div>
      </div>}
      {open === "brief" && !keeper && <div className="tw-panel tw-brief" id={`tw-brief-${threadId}`} role="region" aria-label="Member"><MemberPanel key={threadId} data={data} cue={data.ambientMotion === "off" ? undefined : cue} registry={registry.data ?? null} scopeDetails={<ScopePanel data={data} />} onQuest={id => navigate.toPluginPanel("tavern", { subPath: `quest/${id}` })} /></div>}
    </section>
    </div>
  );
}

/**
 * The widget row while it loads: its frame from the first frame, its shapes at the kit's delay, in the row's own classes so the
 * height is the real row's at every width and bb's composer below does not move when it swaps.
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

function KeeperParts({ data, open, onToggle }: { data: ThreadDecor; open: KeeperSection | null; onToggle: (kind: KeeperSection, button: HTMLButtonElement) => void }) {
  const keeper = data.keeperView!;
  const list = attentionView(keeper.attention);
  const quest = keeper.boardQuests[0];
  const others = keeper.boardQuests.length - 1;
  const unread = quest?.attention?.summaries ?? 0;
  const questLabel = quest ? `Show ${quest.title}${others > 0 ? ` and ${plural(others, "other quest")}` : ""}` : "";
  const expand = open ? "Fold Tavern widget" : "Expand Tavern widget";
  const urgent = list.needYou ? "asks" : list.new ? "decided" : "quests";
  const disclosure = (kind: KeeperSection) => ({
    "aria-expanded": open === kind,
    "aria-controls": sectionId(data.threadId, kind),
    onClick: (event: MouseEvent<HTMLButtonElement>) => onToggle(kind, event.currentTarget),
  });
  return <>
    <button type="button" className="ibtn tw-expand act" aria-label={expand} title={expand} aria-expanded={open !== null} aria-controls={sectionId(data.threadId, open ?? urgent)} onClick={event => onToggle(open ?? urgent, event.currentTarget)}><ExpandsMark open={open !== null} /></button>
    <span className="tw-sp" />
    {quest && <button type="button" className="tw-quest act" title={`${questLabel} · ${phaseWord(quest.phase)} · ${quest.move.text}${unread ? ` · ${summaryCountWords(unread)}` : ""}`} aria-label={questLabel} {...disclosure("quests")}>
      <b>{quest.short}</b><Phase phase={quest.phase} />
      {others > 0 && <span className="num" aria-hidden="true">+${others}</span>}
      {unread > 0 && <span className="tw-unread m" aria-hidden="true">{unread} new</span>}
    </button>}
    {(list.needYou > 0 || open === "asks") && <button type="button" className="tw-asks act has" data-ask data-empty={list.needYou === 0 || undefined} title={[`${list.needYou} need you`, attentionTitle(list, "need")].filter(Boolean).join(" · ")} aria-label={`${list.needYou} need you`} {...disclosure("asks")}><Glyph name="ask" size={13} /><span className="num">{list.needYou}</span><span className="tw-w">need you</span></button>}
    {(list.new > 0 || open === "decided") && <button type="button" className="tw-chip tw-new act" data-empty={list.new === 0 || undefined} title={[`${list.new} new`, attentionTitle(list, "new")].filter(Boolean).join(" · ")} aria-label={`${list.new} new`} {...disclosure("decided")}><Glyph name="bell" size={13} /><span className="num">{list.new}</span><span className="tw-w">new</span></button>}
  </>;
}

function QuestBriefs({ quests, onQuest }: { quests: KeeperView["boardQuests"]; onQuest: (id: string) => void }) {
  if (!quests.length) return <p className="m small">No board quests yet.</p>;
  return <ul>{quests.map(q => {
    const progress = pathProgress(q);
    return <li key={q.id} className="tw-quest-brief">
      <h3>{q.title}</h3>
      <PhaseStrip phase={q.phase} />
      <p>{q.move.text}</p>
      <p className="m">{progress ? `${progress.done} of ${plural(progress.total, "waypoint")} settled` : "No waypoints yet"}{!!q.attention?.summaries && <> · <span>{summaryCountWords(q.attention.summaries)}</span></>}</p>
      {q.waypoints.length > 0 && <ol aria-label="Waypoints">{q.waypoints.slice(0, 5).map(w => <li key={w.id}><span>{w.title}</span><StatusPill status={w.state}>{w.state}</StatusPill></li>)}</ol>}
      <button type="button" className="lnk-btn act" aria-label={`Open the quest page for ${q.title}`} onClick={() => onQuest(q.id)}>Open quest page{q.waypoints.length > 5 && ` · ${q.waypoints.length - 5} more`}<OpensMark /></button>
    </li>;
  })}</ul>;
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
    {violations.length > 0 && <ul className="tw-viol" aria-label="Rule breaks">{violations.map(v => <li key={`${v.eventId}-${v.seq}`} className={v.prevented || v.stopped ? "stopped" : "missed"}><span className="vs">{v.prevented ? "Blocked before running" : v.stopped ? "Stopped" : "Not stopped"}</span><span className="vr">{v.reason} <code>{v.ruleId}</code>{v.stopError ? <span className="m"> · {v.stopError}</span> : null}</span><TimeAgo at={v.at} /></li>)}</ul>}
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

function AsksPanel({ asks, holds, quests, attention, expanded, onSelect, onClose, onQuest, onLedger }: { asks: Ask[]; holds: HeldQuest[]; quests: KeeperView["boardQuests"]; attention: NonNullable<KeeperView["attention"]>; expanded: string | null; onSelect: (id: string | null) => void; onClose: () => void; onQuest: (id: string) => void; onLedger: () => void }) {
  const [receipts, setReceipts] = useState<Ask[]>([]);
  const [released, setReleased] = useState<{ quest: HeldQuest; hold: CheckerHandoffHold }[]>([]);
  const shown = [...asks, ...receipts.filter(r => !asks.some(a => a.id === r.id))];
  // A released hold keeps its receipt until the panel closes, even after the server's next read drops it.
  const waiting = holds.filter(q => !released.some(r => r.hold.id === activeHold(q)!.id));
  const notes = attentionNotes(attention);
  const rules = attention.items.filter(item => item.kind === "rule");
  const spend = attention.items.filter(item => item.kind === "hold" && item.id.startsWith("spend:"));
  const count = shown.length + waiting.length + released.length + notes.length + rules.length + spend.length;
  const toggle = (id: string) => {
    if (expanded !== id) onSelect(id);
    else if (count === 1) onClose();
    else onSelect(null);
  };
  return (
    <>
      {count === 0 && <p className="m small tw-none">Nothing needs you.</p>}
      {shown.map(ask => {
        const q = quests.find(b => b.id === ask.boardQuestId);
        const isOpen = expanded === ask.id;
        const done = !asks.some(a => a.id === ask.id);
        return (
          <div className={`tw-ask k-${ask.releaseHoldId ? "hold" : ask.kind} ${isOpen ? "open" : ""}`} key={ask.id} {...(done ? {} : { "data-ask": "" })}>
            {!done && (
              <button type="button" className="tw-ask-row act" aria-expanded={isOpen} onClick={() => toggle(ask.id)}>
                {/* The Keeper's ask to release a hold is the hold, so it reads as one, not as a blocker. */}
                <span className="tw-ak">{ask.releaseHoldId ? "Checker handoff" : KIND_WORD[ask.kind]}</span>
                <span className="tw-aq" title={ask.question}>{ask.question}</span>
                {q && <span className="tw-ag">{q.short}</span>}
                <TimeAgo at={ask.createdAt} />
                <span className="tw-ago">{isOpen ? count === 1 ? "Fold" : "Hide answer" : "Answer"}<ExpandsMark open={isOpen} /></span>
              </button>
            )}
            {/* The row keeps the question to one line; the panel prints it in full, wrapped, so it reads before you answer. */}
            {isOpen && !done && <p className="tw-aq-open" data-content>{ask.question}</p>}
            {isOpen && !done && ask.kind === "greenlight" && <p className="m small tw-same">The same seal as the quest map card in the chat: sealing either one seals both.</p>}
            {(isOpen || done) && <AskCard ask={ask} via="banner" headless={!done} onFold={() => toggle(ask.id)} onAnswered={a => setReceipts(r => [...r, a])} />}
          </div>
        );
      })}
      {waiting.map(q => { const hold = activeHold(q)!, key = holdKey(hold); return <HoldItem key={key} quest={q} hold={hold} open={expanded === key} onToggle={() => toggle(key)} onReleased={h => setReleased(r => [...r, { quest: q, hold: h }])} />; })}
      {released.map(r => <HoldReceipt key={holdKey(r.hold)} quest={r.quest} hold={r.hold} />)}
      {(notes.length > 0 || rules.length > 0 || spend.length > 0) && <div className="tw-other-needs">
        <KeeperNoteRows notes={notes} short={id => quests.find(q => q.id === id)?.short ?? null} label="Waiting on you" />
        {rules.length > 0 && <ul className="lg-rows" aria-label="Rules to review">{rules.map(item => <li key={item.id}><span>{item.title}</span><button type="button" className="lnk-btn act" onClick={onLedger}>Review in Ledger<OpensMark /></button></li>)}</ul>}
        {spend.length > 0 && <ul className="lg-rows" aria-label="Spend limits">{spend.map(({ id, title, questId }) => <li key={id}><span>{title}</span>{questId && <button type="button" className="lnk-btn act" onClick={() => onQuest(questId)}>Open quest<OpensMark /></button>}</li>)}</ul>}
      </div>}
      {asks.length > 0 ? <p className="tw-panel-status m small">Answering here clears the ask everywhere: the common room, the phone and the chat pointer.</p> : waiting.length > 0 && <p className="tw-panel-status m small">Releasing here clears the hold everywhere: the common room and the quest page.</p>}
    </>
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
const KIND_WORD: Record<Ask["kind"], string> = { greenlight: "Quest map (greenlight)", decision: "Decision", conclude: "Conclude", production: "Production", "cluster-write": "Cluster write", merge: "Merge", destructive: "Destructive", "sends-as-you": "Sends as you", "drafts-as-you": "Draft as you", blocker: "Blocker", credential: "Credential", scope: "Scope change" };

function DecidedPanel({ threadId, data }: { threadId: string; data: ThreadDecor }) {
  const undo = experimental_useRpcMutation({ contract: rpcContract, method: "undoDecision" });
  const seen = useDecisionSeen({ keeperThreadId: threadId, throughId: data.keeperView!.decidedThroughId });
  const [error, setError] = useState<unknown>(null);
  return <><DecidedForYou decisions={data.keeperView!.decidedForYou} total={data.keeperView!.decidedCount} pending={undo.isPending} onUndo={id => void undo.mutate({ decisionId: id }).catch(setError)} {...seen} /><QueryState error={error} /></>;
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
