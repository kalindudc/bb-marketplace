import { Fragment, useId, type ReactNode } from "react";
import type { BoardQuestSummary } from "../../shared/contract";
import { memberName } from "../../shared/member-name";
import type { Plan, Waypoint } from "../../shared/schema";
import { waypointCheck } from "../../shared/waypoint";
import { Clamp } from "./primitives";
import { checkWord } from "./quest-map";
import type { Registry } from "./registry";

function partyChanges(before: Plan["party"], after: Plan["party"], classLabel: (id: string) => string) {
  const later = after.map(slot => JSON.stringify(slot));
  const matched = new Set<number>();
  const unchangedClasses: string[] = [];
  let reordered = false;
  let last = -1;
  for (const slot of before) {
    const signature = JSON.stringify(slot);
    const index = later.findIndex((key, i) => !matched.has(i) && key === signature);
    if (index < 0) continue;
    matched.add(index);
    unchangedClasses.push(slot.classId);
    reordered ||= index < last;
    last = index;
  }

  const classes = new Set([...before, ...after].map(slot => slot.classId));
  return {
    reordered,
    lines: [...classes].flatMap(id => {
      const from = before.filter(slot => slot.classId === id).length;
      const to = after.filter(slot => slot.classId === id).length;
      const unchanged = unchangedClasses.filter(cls => cls === id).length;
      const count = from !== to ? `${classLabel(id)} ${from} to ${to}` : null;
      const updated = unchanged < Math.min(from, to);
      return count ? [`${count}${updated ? "; slots also updated" : ""}`] : updated ? [`${classLabel(id)} slots updated`] : [];
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
  const rows: { key: string; label?: string; text: string; formatted?: ReactNode }[] = [];

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
      const fields: [label: string, before: string, after: string][] = [];
      if (w.title !== was.title) fields.push(["Title", was.title, w.title]);
      if (w.owner !== was.owner || w.actor !== was.actor) fields.push(["owner", ownerLabel(was), ownerLabel(w)]);
      if (waypointCheck(w) !== waypointCheck(was)) fields.push(["check", checkWord(was), checkWord(w)]);
      if (w.doneWhen !== was.doneWhen) fields.push(["done when", was.doneWhen ?? "not specified", w.doneWhen ?? "not specified"]);
      if (!fields.length) continue;
      const sameTitle = w.title === was.title;
      rows.push({
        key: `change:${w.id}`,
        text: (sameTitle ? `${w.title} · ` : "") + fields.map(([label, before, after]) => `${label}: ${before} → ${after}`).join("; "),
        formatted: <>{sameTitle && <><b>{w.title}</b> · </>}{fields.map(([label, before, after], i) => <Fragment key={label}>
          {i > 0 ? "; " : ""}{label}: <del>{before}</del> <span role="img" aria-label="changed to">→</span> {after}
        </Fragment>)}</>,
      });
    }

    const party = partyChanges(previous.party, plan.party, classLabel);
    if (party.lines.length) rows.push({ key: "party", label: "Party", text: party.lines.join(" · ") });
    const oldOrder = previous.waypoints.filter(w => next.has(w.id));
    const newOrder = plan.waypoints.filter(w => old.has(w.id));
    if (newOrder.some((w, i) => w.id !== oldOrder[i]?.id)) rows.push({ key: "waypoint-order", label: "Order", text: "Waypoints reordered" });
    if (party.reordered) rows.push({ key: "party-order", label: "Order", text: "Party slots reordered" });
  }

  return <section className="plan-changes" aria-labelledby={heading}>
    <h3 id={heading}>{title}</h3>
    {plan.changeNote && <p data-content>{plan.changeNote}</p>}
    {rows.length > 0 ? <ul role="list">{rows.map(row => <li key={row.key}>
      <Clamp text={row.label ? `${row.label}: ${row.text}` : row.text}>
        {row.label && <><b>{row.label}:</b> </>}{row.formatted ?? row.text}
      </Clamp>
    </li>)}</ul>
      : !plan.changeNote && <p>No waypoint, party or order changes.</p>}
  </section>;
}
