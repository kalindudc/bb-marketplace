import { Fragment, useId, type ReactNode } from "react";
import type { BoardQuestSummary } from "../../shared/contract";
import { memberName } from "../../shared/member-name";
import type { Plan, Waypoint } from "../../shared/schema";
import { listChanges, planForecast, roleOf, sentenceChanges, wordDiff } from "../../shared/plan-text";
import { waypointCheck } from "../../shared/waypoint";
import { checkWord } from "./quest-map";
import type { Registry } from "./registry";

const changedTo = <span role="img" aria-label="changed to">→</span>;
const waypointNumbers = (ids: string[]) => ids.map(id => id.replace(/^w/, "")).join(", ") || "none";

function WordChange({ before, after }: { before: string; after: string }) {
  return wordDiff(before, after).map((run, i) => <Fragment key={i}>
    {i > 0 && " "}{"text" in run ? run.text : <>{run.before && <del>{run.before}</del>}{run.before && run.after && " "}{run.after && <ins>{run.after}</ins>}</>}
  </Fragment>);
}

function partyChanges(before: Plan["party"], after: Plan["party"], classLabel: (id: string) => string, slotLabel: (slot: Plan["party"][number]) => string) {
  const later = after.map(slot => JSON.stringify(slot));
  const matched = new Set<number>();
  const unmatched: Plan["party"] = [];
  let reordered = false;
  let last = -1;
  for (const slot of before) {
    const signature = JSON.stringify(slot);
    const index = later.findIndex((key, i) => !matched.has(i) && key === signature);
    if (index < 0) { unmatched.push(slot); continue; }
    matched.add(index);
    reordered ||= index < last;
    last = index;
  }

  const classes = new Set([...before, ...after].map(slot => slot.classId));
  return {
    reordered,
    lines: [...classes].flatMap(id => {
      const name = classLabel(id);
      const from = before.filter(slot => slot.classId === id).length;
      const to = after.filter(slot => slot.classId === id).length;
      const prior = unmatched.filter(slot => slot.classId === id);
      const next = after.filter((slot, i) => slot.classId === id && !matched.has(i));
      const lines: ReactNode[] = [];
      if (from !== to) lines.push(`${name} ${from} to ${to}`);
      let updated = false;
      for (const [i, slot] of prior.entries()) {
        const current = next[i];
        if (!current) break;
        const { waypointIds: a, ...was } = slot;
        const { waypointIds: b, ...now } = current;
        if (a.join(",") !== b.join(",")) {
          const added = b.filter(w => !a.includes(w)), removed = a.filter(w => !b.includes(w));
          const label = slotLabel(current);
          lines.push(added.length || removed.length ? <>{label}{added.length > 0 && <> <ins>{added.map(w => `+${w.replace(/^w/, "")}`).join(", ")}</ins></>}{removed.length > 0 && <> <del>{removed.map(w => `−${w.replace(/^w/, "")}`).join(", ")}</del></>}</>
            : <>{label} on waypoint <del>{waypointNumbers(a)}</del> {changedTo} <ins>{waypointNumbers(b)}</ins></>);
        }
        updated ||= JSON.stringify(was) !== JSON.stringify(now);
      }
      if (updated) lines.push(`${name} slots updated`);
      return lines;
    }),
  };
}

export function PlanChanges({ plan, plans, quest, registry }: {
  plan: Plan; plans: Plan[]; quest: BoardQuestSummary; registry?: Registry;
}) {
  const heading = useId();
  const previous = plans.find(p => p.version === plan.version - 1);
  if (!previous && !plan.changeNote) return null;
  const title = previous ? `Changed since v${previous.version}` : plan.version === 1 ? "Keeper’s note" : "Plan update";
  const rows: { key: string; label?: string; text: ReactNode }[] = [];

  if (previous) {
    const names = registry ?? { classes: [], characters: [] };
    const classLabel = (id: string) => names.classes.find(cls => cls.id === id)?.label ?? id.charAt(0).toUpperCase() + id.slice(1);
    const ownerLabel = (w: Waypoint) => {
      if (w.actor === "user") return "You";
      if (w.actor === "outside") return w.owner ?? "Outside owner";
      const member = quest.members.find(m => m.threadId === w.owner);
      return member ? memberName(member, names) : w.owner ? classLabel(w.owner) : "Unassigned";
    };
    const old = new Map(previous.waypoints.map(w => [w.id, w]));
    const next = new Map(plan.waypoints.map(w => [w.id, w]));
    for (const w of plan.waypoints) if (!old.has(w.id)) rows.push({ key: `add:${w.id}`, label: "Added", text: w.title });
    for (const w of previous.waypoints) if (!next.has(w.id)) rows.push({ key: `remove:${w.id}`, label: "Removed", text: w.title });
    for (const w of plan.waypoints) {
      const was = old.get(w.id);
      if (!was) continue;
      const fields: [label: string, before: string, after: string, unchanged?: number][] = [];
      if (w.title !== was.title) fields.push(["Title", was.title, w.title]);
      if (w.owner !== was.owner || w.actor !== was.actor) fields.push(["owner", ownerLabel(was), ownerLabel(w)]);
      if (waypointCheck(w) !== waypointCheck(was)) fields.push(["check", checkWord(was), checkWord(w)]);
      if (w.dependsOn.join(",") !== was.dependsOn.join(",")) fields.push(["after", waypointNumbers(was.dependsOn), waypointNumbers(w.dependsOn)]);
      if (w.doneWhen !== was.doneWhen) {
        const { removed, added, unchanged } = sentenceChanges(was.doneWhen ?? "", w.doneWhen ?? "");
        if (removed.length || added.length) fields.push([
          "done when",
          removed.join(" ") || (was.doneWhen ? "" : "not specified"),
          added.join(" ") || (w.doneWhen ? "" : "not specified"),
          unchanged,
        ]);
      }
      if (!fields.length) continue;
      const sameTitle = w.title === was.title;
      rows.push({
        key: `change:${w.id}`,
        text: <>{sameTitle && <><b>{w.title}</b> · </>}{fields.map(([label, before, after, unchanged], i) => <Fragment key={label}>
          {i > 0 ? "; " : ""}{label}: {label === "done when" ? <WordChange before={before} after={after} /> : <>{before && <del>{before}</del>}{before && after && <> {changedTo} </>}{after && <ins>{after}</ins>}</>}
          {!!unchanged && <span className="m"> ({unchanged} other {unchanged === 1 ? "sentence" : "sentences"} unchanged)</span>}
        </Fragment>)}</>,
      });
    }

    const party = partyChanges(previous.party, plan.party, classLabel, slot => names.characters.find(c => c.id === slot.characterId)?.name ?? roleOf(slot) ?? classLabel(slot.classId));
    if (party.lines.length) rows.push({ key: "party", label: "Party", text: party.lines.map((line, i) => <Fragment key={i}>{i > 0 && " · "}{line}</Fragment>) });
    const oldQuestions = new Map(previous.questions.map(q => [q.id, q]));
    const newQuestions = new Map(plan.questions.map(q => [q.id, q]));
    const added = plan.questions.filter(q => !oldQuestions.has(q.id)).length;
    const removed = previous.questions.filter(q => !newQuestions.has(q.id)).length;
    if (added) rows.push({ key: "questions-added", label: "Questions", text: <ins>+{added} for you</ins> });
    if (removed) rows.push({ key: "questions-removed", label: "Questions", text: `${removed} removed` });
    for (const q of plan.questions) {
      const was = oldQuestions.get(q.id);
      if (was && JSON.stringify(was) !== JSON.stringify(q)) rows.push({ key: `question:${q.id}`, label: "Question updated", text: q.text });
    }
    const oldOrder = previous.waypoints.filter(w => next.has(w.id));
    const newOrder = plan.waypoints.filter(w => old.has(w.id));
    if (newOrder.some((w, i) => w.id !== oldOrder[i]?.id)) rows.push({ key: "waypoint-order", label: "Order", text: "Waypoints reordered" });
    if (party.reordered) rows.push({ key: "party-order", label: "Order", text: "Party slots reordered" });

    const fields = [
      ["Goal", previous.goal, plan.goal], ["Done when", previous.doneWhen, plan.doneWhen],
      ["Forecast", planForecast(previous), planForecast(plan)], ["Review load", previous.reviewLoad, plan.reviewLoad],
    ] as const;
    for (const [label, before, after] of fields) {
      if (before === after) continue;
      const { removed, added, unchanged } = sentenceChanges(before, after);
      if (!removed.length && !added.length) continue;
      rows.push({ key: `plan:${label}`, label, text: <><WordChange before={removed.join(" ")} after={added.join(" ")} />
        {!!unchanged && <span className="m"> ({unchanged} other {unchanged === 1 ? "sentence" : "sentences"} unchanged)</span>}</> });
    }
    const { removed: findingsRemoved, added: findingsAdded } = listChanges(previous.findings, plan.findings);
    if (findingsRemoved.length || findingsAdded.length) rows.push({ key: "plan:findings", label: "Findings", text: <>
      {findingsAdded.length > 0 && <ins>{findingsAdded.length} new or reworded</ins>}
      {findingsAdded.length > 0 && findingsRemoved.length > 0 && " · "}
      {findingsRemoved.length > 0 && <del>{findingsRemoved.length} removed or replaced</del>}
    </> });
  }

  return <section className="plan-changes" aria-labelledby={heading}>
    <h3 id={heading}>{title}</h3>
    {plan.changeNote && <p data-content>{plan.changeNote}</p>}
    {rows.length > 0 ? <ul role="list">{rows.map(row => <li key={row.key} data-content>
      {row.label && <><b>{row.label}:</b> </>}{row.text}
    </li>)}</ul>
      : !plan.changeNote && <p>No changes to this plan.</p>}
  </section>;
}
