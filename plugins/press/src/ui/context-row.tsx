import {
  experimental_ThreadContextCardRow,
  experimental_useAppPanel,
  experimental_useRpcQuery,
  type ExperimentalThreadContextCardProps,
} from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { rpcContract } from "../contract";
import { useFooterPresence } from "./footer";
import { PressRing } from "./footer-chip";
import { chipBusy, chipText, PRESS_TAB, statusLines, usageTone } from "./model";

const Row = experimental_ThreadContextCardRow;

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

  const lines = statusLines(data);
  const title = lines.join("\n");
  const chip = <button type="button" className="press-chip" data-tone={usageTone(data)} data-busy={chipBusy(data) ? "" : undefined}
    title={title} aria-label={`Press: ${lines.join(". ")}. Open Press`}
    onClick={() => panel.openTab({ tab: PRESS_TAB })}><PressRing data={data} />{chipText(data)}</button>;
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
