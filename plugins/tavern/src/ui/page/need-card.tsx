import { experimental_useRpcMutation, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { fromStoppedKeeper, type AttentionItem } from "../../shared/attention";
import { rpcContract, type Room } from "../../shared/contract";
import { OpensMark, TimeAgo } from "../kit";
import { useHandBackActions } from "../kit/memory";
import { CrestOf, characterName, type Registry } from "./common";

export function NeedAction({ label, effect, onClick, disabled }: { label: string; effect: string; onClick: () => void; disabled?: boolean }) {
  const id = useId();
  return <div className="tv-need-action">
    <button type="button" className="btn sm" disabled={disabled} aria-describedby={id} onClick={onClick}>{label}</button>
    <span id={id} className="tv-need-effect">{effect}</span>
  </div>;
}

function NeedQuote({ children }: { children: ReactNode }) {
  const id = useId();
  const ref = useRef<HTMLQuoteElement>(null);
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const quote = ref.current;
    if (!quote || open) return;
    const measure = () => setCut(quote.scrollHeight > quote.clientHeight + 1);
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(quote);
    return () => observer?.disconnect();
  }, [children, open]);
  return <div className="tv-need-reading">
    <blockquote id={id} ref={ref} data-content data-clamped={!open || undefined} className="tv-need-quote">{children}</blockquote>
    {(cut || open) && <button type="button" className="lnk-btn act" aria-controls={id} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Show less" : "Read all"}</button>}
  </div>;
}

function HandBack({ item, keeperName }: { item: AttentionItem & { keeperThreadId: string }; keeperName: string }) {
  const actions = useHandBackActions({ id: item.id, keeperThreadId: item.keeperThreadId, action: item.title, text: item.detail?.text ?? item.title, why: item.detail?.why });
  return <>
    {actions.done ? <p role="status">Done. The Keeper has been told.</p> : <>
      <NeedAction label="Done" effect={`Marks it handled and tells ${keeperName}.`} disabled={actions.pending} onClick={actions.markDone} />
      <NeedAction label="Reply" effect={`Opens ${keeperName}'s thread with this quoted.`} onClick={actions.reply} />
    </>}
    {actions.error != null && <p role="alert">{String(actions.error)}</p>}
  </>;
}

function scopeWords(item: AttentionItem, keeperName: string) {
  switch (item.scope?.kind) {
    case "global": return "all Keepers";
    case "project": return "this project";
    case "quest": return item.scope.label ? `the quest “${item.scope.label}”` : "this quest";
    case "keeper": return `${item.scope.label ?? keeperName} only`;
    default: return null;
  }
}

function RuleActions({ item, scope }: { item: AttentionItem; scope: string | null }) {
  const confirm = experimental_useRpcMutation({ contract: rpcContract, method: "confirmRule" });
  const [error, setError] = useState<unknown>(null);
  const act = (active: boolean) => { setError(null); void confirm.mutate({ ruleId: item.id, active }).catch(setError); };
  return <>
    <NeedAction label="Confirm" effect={scope ? `Turns the rule on for ${scope}.` : "Turns the rule on."} disabled={confirm.isPending} onClick={() => act(true)} />
    <NeedAction label="Dismiss" effect="Removes the proposal; nobody follows it." disabled={confirm.isPending} onClick={() => act(false)} />
    {error != null && <p role="alert">{String(error)}</p>}
  </>;
}

const day = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
export function NeedCard({ item, keeper, registry, questTitle, facts, children }: { item: AttentionItem; keeper?: Room["keepers"][number]; registry: Registry; questTitle?: string; facts?: ReactNode; children?: ReactNode }) {
  const navigate = useBbNavigate();
  const keeperName = keeper ? characterName(registry, keeper.member) : "the Keeper";
  const who = item.who;
  const title = who?.questTitle ?? questTitle;
  const at = who?.startedAt ?? keeper?.threadCreatedAt ?? keeper?.member.createdAt;
  const scope = scopeWords(item, keeperName);
  const ownRule = item.scope?.kind === "keeper" && item.scope.label === keeperName;
  const sentence = item.kind === "hand-back" ? item.need ?? `${keeper ? keeperName : "The Keeper"} handed this back to you.`
    : item.kind === "rule" ? `${keeper ? keeperName : "A Keeper"} proposes a rule${ownRule ? " for its own work" : scope ? ` for ${scope}` : ""}.`
    : item.title;
  const detail = item.detail;
  const quote = item.kind === "rule" ? `“${item.title}”` : item.kind === "hand-back" && detail
    ? [item.title !== detail.text ? item.title : null, `“${detail.text}”`, detail.why].filter(Boolean).join("\n") : null;
  const stopped = fromStoppedKeeper(item);
  const buttons = item.kind === "rule" || item.kind === "hand-back" && item.keeperThreadId;
  return <article data-ask data-need-card={item.kind} className={`tv-need-card${buttons ? " tv-need-split" : ""}`}>
    <header className="tv-need-meta">
      {item.keeperThreadId ? <button type="button" className="act tv-need-person" title={keeper?.threadTitle ?? undefined} aria-label={`Open ${keeper ? keeperName : "the Keeper"}'s thread`} onClick={() => navigate.toThread(item.keeperThreadId!)}>
        {keeper && <CrestOf member={keeper.member} registry={registry} size={18} />}<b>{keeper ? keeperName : "Keeper unavailable"}</b><OpensMark />
      </button> : <span>Keeper unavailable</span>}
      {(stopped || who?.state === "quiet") && <b className="tv-need-state">{stopped ? "Archived" : "Quiet"}</b>}
      {item.questId && (title ? <button type="button" className="act tv-need-quest" onClick={() => navigate.toPluginPanel("tavern", { subPath: `quest/${item.questId}` })}>{title}<OpensMark /></button> : <span>Quest unavailable</span>)}
      <span className="tv-askrow-a"><TimeAgo at={item.since} /></span>
    </header>
    <div className="tv-need-body">
      <p className="tv-need-sentence" data-content>{sentence}</p>
      <div className="tv-need-facts">
        {stopped && item.kind === "hand-back" && <span>Hand-back</span>}
        {stopped && item.kind === "rule" && <span>Rule to confirm</span>}
        {at != null && <span>Keeper started <time dateTime={new Date(at).toISOString()}>{day.format(at)}</time></span>}
        {scope && <span>Applies to {scope}.</span>}
        {!item.questId && title && <span>Proposed during {title}.</span>}
        {facts}
        {who?.state === "quiet" && <span>Answering wakes {keeperName}.</span>}
        {stopped && (item.kind === "rule" && item.scope?.kind !== "global" && item.scope?.kind !== "project"
          ? <span>Confirming changes nothing unless it runs again.</span>
          : <span>{keeper ? keeperName : "The Keeper"} reads replies only if it runs again.</span>)}
        {detail?.validUntil != null && detail.validUntil < Date.now() && <span>Expired. Mark Done to clear it.</span>}
      </div>
      {quote && <NeedQuote>{quote}</NeedQuote>}
      {children}
    </div>
    {buttons && <div className="tv-need-actions">
      {item.kind === "rule" && <RuleActions item={item} scope={scope} />}
      {item.kind === "hand-back" && item.keeperThreadId && <HandBack item={{ ...item, keeperThreadId: item.keeperThreadId }} keeperName={keeperName} />}
    </div>}
  </article>;
}
