import { useEffect, useRef, useState, type CSSProperties } from "react";
import { experimental_useRpcQuery, experimental_useRpcMutation, type ExperimentalMessageMetadataProps, type ExperimentalThreadTabProps, type JsonValue, experimental_useAppPanel, useSdk, useBbContext } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../../shared/contract";
import { ROUTE_KINDS, type Route, type Rule } from "../../shared/schema";
import { messageKey } from "../../shared/text";
import { Glyph, QueryState, RULE_SCOPE, SkGlyph, SkLine, Skeleton, TimeAgo, readRemembered, rememberCount, writeRemembered, ruleScopeLabel, useSkeletonCount, useSkeletonDelay, useWidenRule } from "../kit";
export function routeForMetadata(routes: Route[], at: number, text?: string) { const exact = routes.filter(r => r.messageAt === at); if (exact.length === 1)
    return exact[0]!; const matches = text === undefined ? [] : routes.filter(r => r.messageKey === messageKey(text)); return matches.length === 1 ? matches[0]! : null; }
type Sdk = ReturnType<typeof useSdk>;
type Timeline = Awaited<ReturnType<Sdk["threads"]["timeline"]>>;
const timelineReads = new WeakMap<Sdk, Map<string, {
    revision: string;
    promise: Promise<Map<string, string>>;
}>>();
async function readMessageTexts(sdk: Sdk, threadId: string) {
    const messages = new Map<string, string>();
    let cursor: {
        anchorId: string;
        anchorSeq: number;
    } | null = null;
    for (let page = 0; page < 3; page++) {
        const result: Timeline = await sdk.threads.timeline({ threadId, segmentLimit: "100", includeNestedRows: "true", ...(cursor ? { beforeAnchorId: cursor.anchorId, beforeAnchorSeq: String(cursor.anchorSeq) } : {}) });
        if (!("rows" in result))
            throw new Error("Tavern expected a complete timeline page.");
        const collect = (rows: typeof result.rows) => { for (const row of rows) {
            if (row.kind === "conversation" && row.role === "user")
                messages.set(row.id, row.text);
            else if (row.kind === "turn" && row.children)
                collect(row.children);
        } };
        collect(result.rows);
        cursor = result.timelinePage.olderCursor;
        if (!cursor)
            break;
    }
    return messages;
}
export function ReadAsTag({ message }: ExperimentalMessageMetadataProps) { return message.role === "user" && message.initiator === "user" ? <UserReadAs threadId={message.threadId} at={message.createdAt} messageId={message.id}/> : null; }
function UserReadAs({ threadId, at, messageId }: {
    threadId: string;
    at: number;
    messageId: string;
}) {
    const query = experimental_useRpcQuery({ contract: rpcContract, method: "routes", input: { threadId } });
    const decor = experimental_useRpcQuery({ contract: rpcContract, method: "decor", input: { threadId } });
    const panel = experimental_useAppPanel();
    const sdk = useSdk();
    const [messageText, setMessageText] = useState<string | undefined>(undefined);
    const [textRead, setTextRead] = useState(false);
    const [error, setError] = useState<unknown>(null);
    const revision = query.data?.routes.map(r => `${r.id}:${r.corrected}`).join(",") ?? "";
    useEffect(() => {
        if (decor.data?.member?.role !== "keeper" || !revision)
            return;
        let active = true;
        let reads = timelineReads.get(sdk);
        if (!reads) {
            reads = new Map();
            timelineReads.set(sdk, reads);
        }
        let read = reads.get(threadId);
        if (!read || read.revision !== revision) {
            read = { revision, promise: readMessageTexts(sdk, threadId) };
            reads.set(threadId, read);
        }
        void read.promise.then(messages => { if (active) {
            setMessageText(messages.get(messageId));
            setTextRead(true);
            setError(null);
        } }).catch(e => { if (active)
            setError(e); setTextRead(true); reads!.delete(threadId); });
        return () => { active = false; };
    }, [sdk, threadId, messageId, revision, decor.data?.member?.role]);
    const role = decor.data ? decor.data.member?.role ?? null : undefined;
    const route = role === "keeper" && query.data && (textRead || !revision) ? routeForMetadata(query.data.routes, at, messageText) ?? null : undefined;
    // What this message showed last time on this device: 1 the Keeper's read-as tag, 2 the member line, 0 nothing. A message this device
    // has not drawn yet takes the thread's flag, which is set only where tags were seen, so plain threads never draw one.
    const shown = role === undefined ? undefined : role === "member" ? 2 : role !== "keeper" ? 0 : route === undefined ? undefined : route ? 1 : 0;
    const [threadSeen] = useState(() => { const v = readRemembered<number>(readAsThreadKey(threadId)); return v === 1 || v === 2 ? v : 0; });
    const seen = useSkeletonCount(`skel:thread:readas:${messageId}`, shown, threadSeen);
    useEffect(() => { if (shown) rememberCount(readAsThreadKey(threadId), shown); else if (role === null) rememberCount(readAsThreadKey(threadId), 0); }, [threadId, shown, role]);
    const loading = shown === undefined && !error && !decor.error && !query.error;
    const late = useSkeletonDelay(loading && seen > 0);
    // The line's width last time: the user's bubble is as wide as its widest line, so a wider stand-in would move the bubble sideways.
    const widthKey = `skel:thread:readas-w:${messageId}`;
    const [seenWidth] = useState(() => { const v = readRemembered<number>(widthKey); return typeof v === "number" && v > 0 ? Math.round(v) : null; });
    const line = useRef<HTMLDivElement>(null);
    useEffect(() => { const w = Math.round(line.current?.getBoundingClientRect().width ?? 0); if (w > 0 && w !== seenWidth) writeRemembered(widthKey, w); });
    if (loading) return seen > 0 ? <SkReadAs member={seen === 2} shown={late} width={seenWidth} /> : null;
    if (decor.data?.member?.role === "member")
        return <div ref={line} className="tavern readas member"><Glyph name="route" size={12} /><span>The Keeper hears this in its next tick</span></div>;
    if (decor.data?.member?.role !== "keeper")
        return null;
    if (!route)
        return error ? <span className="tavern readas" role="alert">Read-as unavailable: {error instanceof Error ? error.message : String(error)}</span> : null;
    const quest = query.data!.boardQuests.find(q => q.id === route.boardQuestId);
    const rule = route.ruleId ? query.data!.rules?.find(r => r.id === route.ruleId) ?? null : null;
    const kind = ROUTE_WORD[route.kind];
    return <div ref={line} className="tavern readas" role="group" aria-label={`Read as ${kind}${quest ? ` for ${quest.title}` : ""}: ${route.summary}`}>
      <span className="ra-l">read as</span>
      {quest && <span className="ra-goal" title={quest.title}>{quest.title}</span>}
      <span className={`route-chip k-${route.kind}`}>{kind}</span>
      {route.kind === "rule" && rule && <RuleScopeOnReceipt rule={rule} questTitle={rule.scope === "quest" ? query.data!.boardQuests.find(q => q.id === rule.scopeId)?.title ?? null : null} />}
      {route.corrected && <span className="m">· corrected</span>}
      <button type="button" className="ra-fix" aria-label={`Re-route this message, now read as ${kind}${quest ? ` for ${quest.title}` : ""}`} onClick={() => panel.openTab({ tab: { id: "message-route", context: { kind: "thread" }, availability: "action" }, params: { routeId: route.id } })}>Re-route…</button>
      <span className="ra-sum">{route.summary}</span>
    </div>;
}
const readAsThreadKey = (threadId: string) => `skel:thread:readas:${threadId}`;
/** The read-as line while the routes load, in its own classes: the tag's line (its 20 px row, 32 px on touch) and the summary line under it, or the member's one line. */
function SkReadAs({ member, shown, width }: { member: boolean; shown: boolean; width: number | null }) {
    const region = <Skeleton label="how the Keeper read this message" shown={shown} className={`tavern readas sk-readas ${member ? "member" : ""}`}>
      {member ? <><SkGlyph size={12} /><SkLine w="26ch" /></> : <><span className="ra-l"><SkLine w="7ch" /></span><span className="ra-fix"><SkLine w="16ch" /></span><span className="ra-sum"><SkLine w="40%" /></span></>}
    </Skeleton>;
    // At the width the line had last time: the user's bubble is as wide as its widest line, so it keeps its width at the swap.
    return width === null ? region : <div className="sk-readas-w" style={{ "--ra-w": `${width}px` } as CSSProperties}>{region}</div>;
}
/** A stated rule's reach on its read-as line ("· this Keeper"), with the quiet widen action; the confirm expands on its own line under the receipt. */
function RuleScopeOnReceipt({ rule, questTitle }: { rule: Rule; questTitle: string | null }) {
    const widen = experimental_useRpcMutation({ contract: rpcContract, method: "widenRule" });
    const { trigger, confirm } = useWidenRule({ rule, onWiden: () => widen.mutate({ ruleId: rule.id, scope: "global" }) });
    const label = ruleScopeLabel(rule.scope, questTitle);
    return <>
      <span className="ra-scope" title={`Reaches ${RULE_SCOPE[rule.scope].reach}`}>· {label.charAt(0).toLowerCase() + label.slice(1)}</span>
      {trigger}
      {confirm}
    </>;
}
const ROUTE_WORD: Record<Route["kind"], string> = { steer: "steer", question: "question", aside: "aside", "new-quest": "new quest", rule: "standing rule" };
const ROUTE_HELP: Record<Route["kind"], string> = { steer: "It changes a board quest; the Keeper updates the plan", question: "Answer it from the ledger; nothing changes", aside: "Unrelated; a quick answer or a side quest, goals untouched", "new-quest": "Pin it on the board as another goal", rule: "A standing rule in your words; active at once, shown in the ledger" };

export function MessageRouteTab({ threadId, params }: ExperimentalThreadTabProps & { params: JsonValue | null }) {
    const query = experimental_useRpcQuery({ contract: rpcContract, method: "routes", input: { threadId } });
    const mutation = experimental_useRpcMutation({ contract: rpcContract, method: "correctRoute" });
    const panel = experimental_useAppPanel();
    const args = params && typeof params === "object" && !Array.isArray(params) ? params : {};
    const [routeId, setRouteId] = useState(typeof args.routeId === "string" ? args.routeId : "");
    const [kind, setKind] = useState<Route["kind"] | null>(null);
    const [questId, setQuestId] = useState("");
    const [error, setError] = useState<unknown>(null);
    const [saved, setSaved] = useState(false);
    const candidates = query.data?.routes.filter(r => typeof args.key !== "string" || r.messageKey === args.key) ?? [];
    const chosen = candidates.find(r => r.id === routeId) ?? (candidates.length === 1 ? candidates[0]! : null);
    const needsQuest = kind === "steer" || kind === "new-quest";
    const nowQuest = chosen && query.data?.boardQuests.find(q => q.id === chosen.boardQuestId);
    return <div className="tavern rtab" data-part="MessageRouteTab">
      <header className="journal-head"><div className="journal-title"><h2>Re-route this message</h2><button type="button" className="btn sm narrow-only" onClick={() => panel.close()}>Back to chat</button></div></header>
      <div className="rt-b">
        {typeof args.text === "string" && <blockquote className="rt-quote">{args.text}</blockquote>}
        <QueryState error={query.error ?? error} loading={query.isLoading} retry={() => void query.refetch()} label="how the Keeper read it" skeleton={<div className="tavern readas rt-now"><span className="ra-l"><SkLine w="8ch" /></span><SkLine w="10ch" /><SkLine w="40%" /></div>} />
        {candidates.length > 1 && <label className="rt-field">Which message?<select value={routeId} onChange={e => setRouteId(e.target.value)}><option value="">Choose the message</option>{candidates.map(r => <option value={r.id} key={r.id}>{new Date(r.messageAt).toLocaleString()} · {r.summary}</option>)}</select></label>}
        {chosen && <div className="tavern readas rt-now"><span className="ra-l">now read as</span>{nowQuest && <span className="ra-goal">{nowQuest.title}</span>}<span className={`route-chip k-${chosen.kind}`}>{ROUTE_WORD[chosen.kind]}</span><TimeAgo at={chosen.messageAt} /><span className="ra-sum">{chosen.summary}</span></div>}
        <fieldset className="opts"><legend className="rt-leg">Read it as</legend>{ROUTE_KINDS.map(k => <label key={k} className="opt"><input type="radio" name={`route-${threadId}`} checked={kind === k} onChange={() => { setKind(k); setSaved(false); }} /><span className="ol"><b>{ROUTE_WORD[k]}</b><span className="m">{ROUTE_HELP[k]}</span></span></label>)}</fieldset>
        {needsQuest && <label className="rt-field">Board quest<select value={questId} onChange={e => setQuestId(e.target.value)}><option value="">Choose the goal</option>{query.data?.boardQuests.map(q => <option value={q.id} key={q.id}>{q.title}</option>)}</select></label>}
        <p className="m small">Asides and questions never change a board quest. Saving wakes the Keeper with the corrected route.</p>
        <div className="ask-f"><button type="button" className="btn pri" disabled={!chosen || !kind || mutation.isPending || (needsQuest && !questId)} onClick={() => { if (chosen && kind) void mutation.mutate({ routeId: chosen.id, kind, boardQuestId: needsQuest ? questId : null }).then(() => setSaved(true)).catch(setError); }}>Save route</button>{saved && <span className="receipt-inline" role="status"><Glyph name="check" /><span>Route corrected</span></span>}</div>
        {query.data && candidates.length === 0 && <p className="m small">The Keeper has not recorded a route for this message yet.</p>}
      </div>
    </div>;
}
const SCOPES = (["keeper", "quest", "project", "global"] as const).map(id => [id, RULE_SCOPE[id].label, `Reaches ${RULE_SCOPE[id].reach}`] as const);
export function RuleTab({ threadId, params }: ExperimentalThreadTabProps & { params: JsonValue | null }) {
    const query = experimental_useRpcQuery({ contract: rpcContract, method: "routes", input: { threadId } });
    const mutation = experimental_useRpcMutation({ contract: rpcContract, method: "addRule" });
    const panel = experimental_useAppPanel();
    const args = params && typeof params === "object" && !Array.isArray(params) ? params : {};
    const { projectId } = useBbContext();
    const [text, setText] = useState(typeof args.text === "string" ? args.text.slice(0, 500) : "");
    const [scope, setScope] = useState<"keeper" | "quest" | "global" | "project">("keeper");
    const [questId, setQuestId] = useState("");
    const [error, setError] = useState<unknown>(null);
    const [saved, setSaved] = useState(false);
    return <div className="tavern rtab" data-part="RuleTab">
      <header className="journal-head"><div className="journal-title"><h2>Make this a standing rule</h2><button type="button" className="btn sm narrow-only" onClick={() => panel.close()}>Back to chat</button></div></header>
      <div className="rt-b">
        <label className="rt-field">Rule<textarea value={text} maxLength={500} onChange={e => { setText(e.target.value); setSaved(false); }} /></label>
        <fieldset className="opts"><legend className="rt-leg">Applies to</legend>{SCOPES.map(([id, label, help]) => <label key={id} className="opt"><input type="radio" name={`scope-${threadId}`} checked={scope === id} disabled={id === "project" && projectId === null} onChange={() => setScope(id)} /><span className="ol"><b>{label}</b><span className="m">{help}</span></span></label>)}</fieldset>
        {scope === "quest" && <label className="rt-field">Board quest<select value={questId} onChange={e => setQuestId(e.target.value)}><option value="">Choose a goal</option>{query.data?.boardQuests.map(q => <option key={q.id} value={q.id}>{q.title}</option>)}</select></label>}
        <p className="m small">Rules go into the chosen Keeper’s instructions at its next tick. You can turn a rule off in the ledger.</p>
        <QueryState error={query.error ?? error} />
        <div className="ask-f"><button type="button" className="btn pri" disabled={mutation.isPending || !text.trim() || (scope === "quest" && !questId)} onClick={() => void mutation.mutate({ scope, scopeId: scope === "global" ? null : scope === "project" ? projectId : scope === "quest" ? questId : threadId, text: text.trim(), source: "message" }).then(() => setSaved(true)).catch(setError)}>Confirm rule</button>{saved && <span className="receipt-inline" role="status"><Glyph name="check" /><span>Standing rule saved</span></span>}</div>
      </div>
    </div>;
}
export function routeMessageParams(text: string) { return { text, key: messageKey(text) }; }
