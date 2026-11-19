import { AWAY_STOP_LIST, type AwayStopKind } from "../shared/away";
import type { Scope, ShellRule } from "./schema";

const marker = /^away:([a-f0-9]{64}):policy:([1-9][0-9]?)$/;
const neverMatches = "(?!)";

export function awaySelectionRule(key: string, items: readonly AwayStopKind[]): ShellRule {
  const mask = AWAY_STOP_LIST.reduce((value, kind, index) => items.includes(kind) ? value | (1 << index) : value, 0);
  // The legacy guard sees the away prefix and still denies every catalogue act.
  return { id: `away:${key}:policy:${mask}`, regex: neverMatches, why: "Closing time selection" };
}

export function selectedAwayGuards(scope: Scope): readonly AwayStopKind[] | undefined {
  const away = scope.shell.deny.filter(rule => rule.id.startsWith("away:"));
  const markers = away.flatMap(rule => {
    const match = rule.regex === neverMatches && marker.exec(rule.id);
    return match ? [{ key: match[1]!, mask: Number(match[2]) }] : [];
  });
  const selection = markers[0];
  if (!selection || markers.length !== 1 || selection.mask >= (1 << AWAY_STOP_LIST.length) - 1 || !away.every(rule => rule.id.startsWith(`away:${selection.key}:`))) return undefined;
  return AWAY_STOP_LIST.filter((_, index) => selection.mask & (1 << index));
}
