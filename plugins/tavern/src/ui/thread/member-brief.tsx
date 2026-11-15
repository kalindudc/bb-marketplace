import type { Brief } from "../../shared/schema";
import "./member-brief.css";

function BriefText({ text }: { text: string }) {
  return <>{text.split(/(`[^`]+`)/g).map((part, i) => part.startsWith("`") && part.endsWith("`") && part.length > 2 ? <code key={i}>{part.slice(1, -1)}</code> : part)}</>;
}

export function MemberBrief({ brief, classId }: { brief: Brief; classId: string }) {
  const context = brief.context.filter(text => text.trim());
  const questions = classId === "ranger" ? brief.questions.filter(text => text.trim()) : [];
  return <div className="tw-brief-fields">
    <section><header><h4>Outcome</h4><span className="tag">{brief.mode === "make-it-work" ? "Make it work" : "Make it better"}</span></header><p className="tw-brief-outcome" data-content><BriefText text={brief.outcome} /></p></section>
    {brief.doneWhen.trim() && <section><h4>Done when</h4><p data-content><BriefText text={brief.doneWhen} /></p></section>}
    {questions.length > 0 && <section><h4>Questions{brief.timeboxMinutes !== null && <span className="m"> · {brief.timeboxMinutes} min</span>}</h4><ol>{questions.map((text, i) => <li key={i} data-content><BriefText text={text} /></li>)}</ol></section>}
    {context.length > 0 && <section><h4>Context</h4><ul>{context.map((text, i) => <li key={i} data-content><BriefText text={text} /></li>)}</ul></section>}
    {brief.outOfScope.trim() && <section className="m"><h4>Out of scope</h4><p data-content><BriefText text={brief.outOfScope} /></p></section>}
  </div>;
}
