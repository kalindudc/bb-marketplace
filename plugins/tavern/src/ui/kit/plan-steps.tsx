import { useId, useState } from "react";
import type { BoardQuestSummary } from "../../shared/contract";
import { SHAPE_PATHS } from "../../shared/heraldry";
import { memberName } from "../../shared/member-name";
import { roleOf, scheduledWord } from "../../shared/plan-text";
import type { Plan } from "../../shared/schema";
import { KEEPER_SUBJECT_OWNER, settled, waypointCheck, waypointLabel } from "../../shared/waypoint";
import { Crest } from "./crest";
import { ExpandsMark, Glyph } from "./glyphs";
import { checkWord, layoutWaypoints } from "./quest-map";
import type { Registry } from "./registry";

const emptyNames = { classes: [], characters: [] };
type Waypoint = BoardQuestSummary["waypoints"][number];
export const stepNumber = (id: string) => id.replace(/^w/, "");

export function planSlot(slot: Plan["party"][number], registry: Registry | undefined) {
  const cls = registry?.classes.find(c => c.id === slot.classId);
  const character = registry?.characters.find(c => c.id === slot.characterId);
  const name = character?.name ?? roleOf(slot) ?? memberName(slot, registry ?? emptyNames);
  return { slot, cls, character, name, className: memberName({ classId: slot.classId, characterId: null }, registry ?? emptyNames) };
}

type Slot = ReturnType<typeof planSlot>;
type Owner = {
  kind: "you" | "outside" | "keeper" | "member" | "permanent";
  name: string;
  slot?: Slot;
  hired?: boolean;
  identity?: Pick<Slot, "cls" | "character">;
};

export function planSteps(quest: BoardQuestSummary, plan: Plan, previous: Plan | undefined, registry: Registry | undefined) {
  const slots = plan.party.map(s => planSlot(s, registry));
  const old = new Map(previous?.waypoints.map(w => [w.id, w]));
  const outsides = quest.waypoints.filter(w => w.actor === "outside");
  const members = new Map(quest.members.map(member => [member.threadId, member]));
  const byId = new Map(quest.waypoints.map(w => {
    const matching = slots.filter(s => s.slot.waypointIds.includes(w.id));
    const slot = matching.find(s => s.slot.classId === (w.ownerMember?.classId ?? w.owner)) ?? matching.find(s => s.slot.classId !== "warden");
    const hired = w.ownerMember;
    const owner: Owner = w.actor === "user" ? { kind: "you", name: "You" }
      : w.actor === "outside" ? { kind: "outside", name: w.owner ?? "Outside owner" }
      : w.owner === KEEPER_SUBJECT_OWNER || w.owner === quest.keeperThreadId ? { kind: "keeper", name: "Keeper" }
      : { kind: slot?.slot.permanent || w.ownerMember?.permanent ? "permanent" : "member", slot,
        name: hired ? memberName(hired, registry ?? emptyNames) : slot?.name ?? w.owner ?? "Unassigned", hired: !!hired,
        identity: hired ? { cls: registry?.classes.find(c => c.id === hired.classId), character: registry?.characters.find(c => c.id === hired.characterId) } : slot };
    const word = scheduledWord(w.doneWhen);
    const warning = word && (owner.kind === "member" || owner.kind === "keeper") && !outsides.some(out =>
      out.dependsOn.includes(w.id) || `${out.title} ${out.owner ?? ""}`.toLowerCase().includes(word.toLowerCase())) ? word : null;
    const was = old.get(w.id);
    const change = !previous ? null : !was ? "New" : w.title !== was.title || w.owner !== was.owner || w.actor !== was.actor
      || waypointCheck(w) !== waypointCheck(was) || w.doneWhen !== was.doneWhen || w.dependsOn.join(",") !== was.dependsOn.join(",") ? "Changed" : null;
    const kind = waypointCheck(w);
    const checker = kind === "warden" ? matching.find(s => s.slot.classId === "warden") : undefined;
    const check = checker?.character ? `${checker.name} checks` : checkWord(w);
    const verifier = w.verifiedBy ? members.get(w.verifiedBy) : undefined;
    const proof = w.state === "verified" ? `Verified by ${verifier ? memberName(verifier, registry ?? emptyNames) : "a Warden"}`
      : w.state === "accepted" ? `Accepted by ${w.acceptedBy ?? "the Keeper"}; no Warden check` : null;
    return [w.id, { w, owner, warning, change, check, kind, proof }] as const;
  }));
  type Step = NonNullable<ReturnType<typeof byId.get>>;
  const stages: Step[][] = [];
  let error: string | null = null;
  try {
    for (const node of layoutWaypoints(quest.waypoints)) (stages[node.column] ??= []).push(byId.get(node.waypoint.id)!);
  } catch (err) { error = err instanceof Error ? err.message : String(err); }
  return { slots, steps: [...byId.values()], stages, error };
}

type Road = ReturnType<typeof planSteps>;
export type PlanStep = Road["steps"][number];

export function PlanOwnerMark({ owner, size = 16 }: { owner: Owner; size?: number }) {
  if (owner.kind === "outside") return <Glyph name="gate" size={size} />;
  if (owner.kind === "you") return <svg className="wp-mark you" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.5 22.5 12 12 22.5 1.5 12Z" /><path className="in" d="M12 7.5 16.5 12 12 16.5 7.5 12Z" /></svg>;
  const { cls, character } = owner.identity ?? owner.slot ?? {};
  return <span className="qm-owner-mark" aria-hidden="true">
    {cls && character ? <Crest cls={cls} character={character} size={size} />
      : <svg className={`wp-mark ${owner.hired || owner.kind === "keeper" ? "qm-filled" : "open"}`} width={size} height={size} viewBox="0 0 24 24"><path d={SHAPE_PATHS[cls?.shape ?? "shield"]} /></svg>}
    {owner.kind === "permanent" && <Glyph name="standing" size={10} className="qm-standing" />}
  </span>;
}

export function planOwnerText(owner: Owner) {
  if (owner.kind === "you") return "Your move";
  if (owner.kind === "outside") return `${owner.name} · Outside Tavern`;
  return owner.kind === "permanent" ? `${owner.name} · permanent` : owner.name;
}

function StepRow({ step, onOpenAsk, stepId, compact }: { step: PlanStep; onOpenAsk: (id: string) => void; stepId: string; compact: boolean }) {
  const [open, setOpen] = useState(false);
  const content = useId();
  const { w, owner, warning, change, check, proof } = step;
  const done = compact && settled(w);
  const facts = <>{planOwnerText(owner)} · {check} · {w.leadTime ?? "lead time unknown"}{w.dependsOn.length > 0 && ` · after ${w.dependsOn.map(stepNumber).join(", ")}`}</>;
  return <li className={`qm-step ${done ? "is-done" : ""} owner-${owner.kind}`}>
    <button type="button" id={stepId} className="qm-step-toggle" aria-controls={content} aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="qm-step-mark"><PlanOwnerMark owner={owner} size={18} /></span><span className="qm-step-num m">{stepNumber(w.id)}</span>{" "}
      <span className="qm-step-main"><b data-content>{w.title}</b>{!done && <span className="m"> {facts}</span>}
        {warning && !done && <span className="qm-warn"><Glyph name="st-stale" size={12} /> Mentions {warning}</span>}
      </span>
      {" "}<span className="qm-step-state">{change && <span className="qm-step-change">{change}</span>}
        {w.state !== "planned" && <span className="m">{done && (w.state === "verified" || w.state === "done" || w.state === "accepted") && <Glyph name="check" size={11} />}{waypointLabel(w.state)}</span>}
        <ExpandsMark open={open} />
      </span>
    </button>
    <div className="qm-step-detail" id={content} hidden={!open}>
      <b>Done when</b><p data-content>{w.doneWhen ?? "Not specified"}</p>
      {done && <p className="m">{facts}</p>}
      {warning && done && <p className="qm-warn"><Glyph name="st-stale" size={12} />Mentions {warning}</p>}
      {proof && <p>{proof}</p>}
      {w.rejectedReason && <p>Rejected: {w.rejectedReason}</p>}
      {w.resolutionReason && <p>{w.resolutionReason}</p>}
    </div>
    {w.askId && <button type="button" className="btn sm qm-step-ask" onClick={() => onOpenAsk(w.askId!)}>Answer ask: {w.title}</button>}
  </li>;
}

export function PlanRoad({ road, stepId, onOpenAsk, compact }: { road: Road; stepId: (id: string) => string; onOpenAsk: (id: string) => void; compact: boolean }) {
  if (road.error) return <p className="problem" role="alert">{road.error}</p>;
  return <section aria-label="Route in order">
    {!road.steps.some(s => s.kind === "warden") && <p className="wp-check-note m">No Warden checks on this map</p>}
    <ol className="qm-road" aria-label="Waypoints in order" role="list">
      {road.stages.map((stage, i) => <li key={i} aria-label={`Stage ${i + 1}${stage.length > 1 ? `, ${stage.length} can run at once` : ""}`}>
        {stage.length > 1 && <span className="qm-stage m">{stage.length} at once</span>}
        <ol className="qm-stage-steps" role="list">{stage.map(step => <StepRow key={step.w.id} step={step} stepId={stepId(step.w.id)} onOpenAsk={onOpenAsk} compact={compact} />)}</ol>
      </li>)}
    </ol>
  </section>;
}
