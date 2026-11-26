import { Markdown, experimental_FileLink as FileLink, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { ReactNode, ComponentProps, Ref } from "react";
import type { Ask, KeeperNote, SummaryView } from "../../shared/schema";
import { FoldSummary } from "./glyphs";
import { EvidenceList, TimeAgo } from "./primitives";
import { AskCard } from "./ask-card";
import { KeeperNoteRows } from "./memory";
import { TaleResults } from "./tale-results";
import { Prose } from "./report-view";
import { taleDeliveryBlocks } from "./tale-delivery";
import "./summary-card.css";

export const summaryPath = (questId: string, summaryId: string) => `quest/${questId}/summary/${summaryId}`;

export function answerKind(summary: Pick<SummaryView, "request" | "results">) {
  return summary.request ? "Needs you" : summary.results ? "Result" : "Answer";
}

export function AnswerQuotes({ messages }: { messages: SummaryView["answerMessages"] }) {
  return messages?.length ? <div className="tv-answer-quotes"><span className="lbl">In reply to</span><ul className="tv-sums">
    {messages.map(message => <li key={message.id}><q className="ct" data-content>{message.text}</q></li>)}
  </ul></div> : null;
}

export function SummaryCard({ summary, ask, handBack, chat = false, history = false, document, children, cardRef }: {
  summary: SummaryView; ask?: Ask | null; handBack?: KeeperNote | null; chat?: boolean; history?: boolean; document?: ComponentProps<typeof Markdown>["experimental_document"]; children?: ReactNode; cardRef?: Ref<HTMLElement>;
}) {
  const navigate = useBbNavigate();
  const { id, title, createdAt, body, links, next, results, request, correctedBy, seen, keeperThreadId } = summary;
  return <article ref={cardRef} id={chat || history ? undefined : `tavern-summary-${id}`} tabIndex={chat || history ? undefined : -1} className={`tv-sum ${chat ? "tavern tcard k-tavern-summary" : "nested"}`} data-summary={id}>
    <header className="tv-sum-h"><h3 data-content>{title}</h3><span className="tv-sum-meta">
      <span className="tag">{answerKind(summary)}</span>
      {correctedBy ? <span className="m">Replaced</span> : !seen && !history && <span className="arrival-mark"><i aria-hidden="true" />new</span>}
      <TimeAgo at={createdAt} />
    </span></header>
    {chat && summary.questTitle && <p className="m small tv-answer-quest" data-content>{summary.questTitle}</p>}
    <AnswerQuotes messages={summary.answerMessages} />
    <div className="tv-sum-body tale-delivery-markdown" data-content>{taleDeliveryBlocks(body, "").map((block, i) => block.kind === "markdown" || chat && /^[`~]/.test(block.source.trimStart())
      ? <Markdown key={i} content={block.source} experimental_document={document} />
      : <div key={i} className="tale-visual"><p>A visual in the Keeper’s message</p><button type="button" className="lnk-btn act" onClick={() => navigate.toThread(keeperThreadId)}>Open the Keeper’s thread</button><details><FoldSummary>Show source</FoldSummary><pre><code>{block.source}</code></pre></details></div>)}</div>
    {summary.childQuestId && <button type="button" className="lnk-btn act" onClick={() =>
      navigate.toPluginPanel("tavern", { subPath: `quest/${summary.childQuestId}` })}>Open side quest result</button>}
    <TaleResults results={results} compact />
    {links.length > 0 && <EvidenceList evidence={links} fileRef={ref => ref.startsWith("$BB_THREAD_STORAGE/") ? <FileLink target={{ kind: "thread-storage", threadId: keeperThreadId, path: ref.slice("$BB_THREAD_STORAGE/".length) }}>{ref}</FileLink> : undefined} />}
    {!!next?.length && <div className="tv-sum-next"><b>Next</b><ul>{next.map((line, i) => <li key={i}><Prose text={line} /></li>)}</ul></div>}
    {request && !history && <div className="tv-sum-request">
      {ask ? <AskCard ask={ask} via={chat ? "chat" : "page"} /> : handBack ? handBack.state === "open"
        ? <KeeperNoteRows notes={[handBack]} label="Handed back to you" />
        : <p>{handBack.action ?? handBack.text} <span className="m">Closed</span></p>
      : <p className="m">{request.kind === "ask" ? "Ask" : "Hand-back"} no longer open.</p>}
    </div>}
    {children}
  </article>;
}
