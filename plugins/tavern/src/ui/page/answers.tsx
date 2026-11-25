import { experimental_useRpcQuery, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { rpcContract } from "../../shared/contract";
import { OpensMark, QueryState, TimeAgo } from "../kit";
import { AnswerQuotes, answerKind, summaryPath } from "../kit/summary-card";

export function AnswerSearchForm({ query, onSearch, scoped = false }: { query: string; onSearch: (query: string) => void; scoped?: boolean }) {
  const [input, setInput] = useState(query);
  useEffect(() => setInput(query), [query]);
  const label = scoped ? "Search this quest’s answers" : "Search answers";
  return <form role="search" aria-label={label} className="tv-answer-search" onSubmit={event => { event.preventDefault(); onSearch(input.trim()); }}>
    <input type="search" className="tv-text" aria-label={label} placeholder="Title, kind, quest or your words" value={input} onChange={event => setInput(event.target.value)} />
    <button type="submit" className="btn sm">Search</button>
    {(input || query) && <button type="button" className="btn sm ghost" onClick={() => { setInput(""); onSearch(""); }}>Clear</button>}
  </form>;
}

export function AnswerResults({ query, questId, onOpen }: { query: string; questId?: string; onOpen?: () => void }) {
  const navigate = useBbNavigate();
  const [pages, setPages] = useState<number[]>([]);
  const before = pages.at(-1);
  const search = experimental_useRpcQuery({ contract: rpcContract, method: "searchAnswers", input: { query, ...(questId ? { boardQuestId: questId } : {}), ...(before ? { before } : {}) } });
  return <div className="tv-answer-results">
    <QueryState error={search.error} loading={search.isLoading} label="answers" retry={() => void search.refetch()} />
    {search.data && (search.data.answers.length ? <ol className="tv-sums" aria-label="Matching answers">{search.data.answers.map(answer => <li key={answer.id} className="nested tv-answer-result">
      <div className="tv-sum-h"><button className="lnk-btn act" type="button" onClick={() => {
        onOpen?.();
        navigate.toPluginPanel("tavern", { subPath: summaryPath(answer.boardQuestId, answer.id) });
      }}><strong data-content>{answer.title}</strong><OpensMark /></button><TimeAgo at={answer.createdAt} /></div>
      <div className="tv-sum-meta"><span className="tag">{answerKind(answer)}</span><span data-content>{answer.questTitle}</span>{answer.correctedBy && <span className="m">Replaced</span>}</div>
      <AnswerQuotes messages={answer.answerMessages} />
    </li>)}</ol> : <p className="tv-empty" role="status" data-empty>{query ? "No answers match your search." : "No answers recorded yet."}</p>)}
    {(pages.length > 0 || search.data?.nextCursor != null) && <div className="tv-sum-actions">
      {pages.length > 0 && <button type="button" className="btn sm" onClick={() => setPages(pages.slice(0, -1))}>Newer answers</button>}
      {search.data?.nextCursor != null && <button type="button" className="btn sm" onClick={() => setPages([...pages, search.data!.nextCursor!])}>Older answers</button>}
    </div>}
  </div>;
}

export function AnswersPage() {
  const [query, setQuery] = useState("");
  return <div className="tv-card tv-sum-sec">
    <AnswerSearchForm query={query} onSearch={setQuery} />
    <AnswerResults key={query} query={query} />
  </div>;
}

export function UnansweredMessages({ questId }: { questId: string }) {
  const [pages, setPages] = useState<number[]>([]);
  const before = pages.at(-1);
  const query = experimental_useRpcQuery({ contract: rpcContract, method: "unansweredMessages", input: { boardQuestId: questId, ...(before ? { before } : {}) } });
  if (!query.data?.messages.length && !pages.length && !query.error) return null;
  return <section className="tv-unanswered" aria-label="Unanswered messages">
    <h3>Unanswered messages</h3>
    <QueryState error={query.error} loading={query.isLoading} label="unanswered messages" retry={() => void query.refetch()} />
    <ul className="tv-sums">{query.data?.messages.map(message => <li key={message.id}>
      <span className={`route-chip k-${message.kind}`}>{message.kind === "steer" ? "Steer" : "Question"}</span>
      <q data-content>{message.text}</q><TimeAgo at={message.at} />
    </li>)}</ul>
    <div className="tv-sum-actions">
      {pages.length > 0 && <button type="button" className="btn sm" onClick={() => setPages(pages.slice(0, -1))}>Newer messages</button>}
      {query.data?.nextCursor != null && <button type="button" className="btn sm" onClick={() => setPages([...pages, query.data!.nextCursor!])}>Older messages</button>}
    </div>
  </section>;
}
