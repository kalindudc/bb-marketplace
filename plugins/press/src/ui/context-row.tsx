import {
  experimental_ThreadContextCardRow,
  experimental_useAppPanel,
  experimental_useRpcQuery,
  type ExperimentalThreadContextCardProps,
} from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { rpcContract } from "../contract";
import { useFooterPresence } from "./footer";
import { chipText, PRESS_TAB, shortTokens } from "./model";

const Row = experimental_ThreadContextCardRow;

function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function summary(dto: {
  percent: number | null;
  tokens: number | null;
  window: number | null;
  mode: string;
  nextPoint: string | null;
  lastCompaction: { at: string; point: string; tokensBefore: number | null; tokensAfter: number | null } | null;
}): string {
  const parts: string[] = [];
  if (dto.tokens !== null) parts.push(`${shortTokens(dto.tokens)} of ${shortTokens(dto.window)} tokens`);
  if (dto.mode !== "auto") parts.push(`mode ${dto.mode}`);
  if (dto.lastCompaction) {
    const before = shortTokens(dto.lastCompaction.tokensBefore);
    const after = shortTokens(dto.lastCompaction.tokensAfter);
    parts.push(`last ${dto.lastCompaction.point} at ${clock(dto.lastCompaction.at)}: ${before} to ${after}`);
  } else {
    parts.push("never compacted");
  }
  if (dto.nextPoint) parts.push(`next point: ${dto.nextPoint}`);
  return parts.join(" · ");
}

function ContextChip({ threadId, card }: { threadId: string; card: boolean }) {
  const { data } = experimental_useRpcQuery({
    contract: rpcContract,
    method: "status",
    input: { threadId },
  });

  const panel = experimental_useAppPanel();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const hasFooter = useFooterPresence(anchor);
  if (!data || data.percent === null) return null;

  const title = summary(data);
  const chip = <button type="button" className="press-chip" title={title} aria-label={`Press: ${chipText(data)}`}
    onClick={() => panel.openTab({ tab: PRESS_TAB })}>{chipText(data)}</button>;
  return card
    ? <div ref={setAnchor} hidden={hasFooter}>{!hasFooter && <Row label="Press" title={title} trailing={chip} />}</div>
    : <span ref={setAnchor} hidden={hasFooter}>{!hasFooter && chip}</span>;
}

export function PressContextRow({ threadId }: ExperimentalThreadContextCardProps) {
  return <ContextChip threadId={threadId} card />;
}

export function PressContextSegment({ threadId }: { threadId: string }) {
  return <ContextChip threadId={threadId} card={false} />;
}
