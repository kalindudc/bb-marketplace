import { isDeepStrictEqual } from "node:util";
import type { Plan } from "../../shared/schema";

function changedFields<T extends object>(before: T, after: T) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)] as (keyof T)[]);
  return Object.fromEntries([...keys].filter(key => !isDeepStrictEqual(before[key], after[key]))
    .map(key => [key, { before: before[key] ?? null, after: after[key] ?? null }]));
}

export function planDiff(before: Plan, after: Plan) {
  const content = ({ boardQuestId, version, createdAt, fromSteer, changeNote, waypoints, ...plan }: Plan) => plan;
  const oldWaypoints = new Map(before.waypoints.map(w => [w.id, w]));
  const newWaypoints = new Map(after.waypoints.map(w => [w.id, w]));
  const changed = after.waypoints.flatMap(w => {
    const previous = oldWaypoints.get(w.id);
    if (!previous) return [];
    const fields = changedFields(previous, w);
    return Object.keys(fields).length ? [{ id: w.id, fields }] : [];
  });
  const oldOrder = [...oldWaypoints.keys()];
  const newOrder = [...newWaypoints.keys()];
  return {
    fields: changedFields(content(before), content(after)),
    waypoints: {
      added: after.waypoints.filter(w => !oldWaypoints.has(w.id)),
      removed: before.waypoints.filter(w => !newWaypoints.has(w.id)),
      changed,
      ...(!isDeepStrictEqual(oldOrder, newOrder) ? { order: { before: oldOrder, after: newOrder } } : {}),
    },
  };
}
