import { useEffect, useRef, useState } from "react";
import { UrlLink, type ExperimentalMessageMetadataProps } from "@get-bb/plugin-sdk/app";
import { messageOf, useShuttleQuery } from "../data";
import { enterReference, leaveReference, tapReference, type LinkTargetRef } from "./dom";
import { scanReferenceText, type ReferenceRange } from "./reference-text";

export function MessageReferences({ message }: ExperimentalMessageMetadataProps) {
  const marker = useRef<HTMLSpanElement>(null);
  const [snapshot, setSnapshot] = useState({ text: "", urls: [] as string[] });
  const ranges = useRef<ReferenceRange[]>([]);
  const query = useShuttleQuery("resolveReferences", { threadId: message.threadId, messageId: message.id, ...snapshot }, snapshot.text.includes("#"));
  const rows = query.data?.rows ?? [];
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    let observer: MutationObserver | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: string | null = null;
    const root = () => marker.current?.closest("[data-timeline-row-id]") ?? null;
    const scan = () => {
      const row = root();
      if (!row) return;
      const next = scanReferenceText(row);
      ranges.current = next.ranges;
      setSnapshot((old) => old.text === next.text && JSON.stringify(old.urls) === JSON.stringify(next.urls) ? old : { text: next.text, urls: next.urls });
    };
    const schedule = () => {
      if (current) { leaveReference(); current = null; }
      ranges.current = [];
      clearTimeout(timer); timer = setTimeout(scan, 300);
    };
    const at = (event: PointerEvent): LinkTargetRef | null => {
      if ((event.target as Element | null)?.closest?.("[data-shuttle-references]")) return null;
      for (const ref of ranges.current) {
        const record = rowsRef.current.find((r) => r.number === ref.number && r.url !== null);
        const el = marker.current?.querySelector<HTMLAnchorElement>(`a[data-shuttle-reference-number="${ref.number}"]`);
        if (!record?.url || !el || !ref.range.startContainer.isConnected || typeof ref.range.getClientRects !== "function") continue;
        if ([...ref.range.getClientRects()].some((r) => event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom)) {
          const original = ref.range.toString();
          return { el, url: record.url, key: el.dataset.shuttleKey ?? record.id, kind: el.dataset.shuttleLink ?? "pr", referenceId: record.id, rect: () => ref.range.getBoundingClientRect(), valid: () => ref.range.startContainer.isConnected && ref.range.endContainer.isConnected && ref.range.toString() === original };
        }
      }
      return null;
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const target = at(event);
      if (target?.referenceId === current) return;
      if (current) leaveReference();
      current = target?.referenceId ?? null;
      if (target) enterReference(target);
    };
    const leave = () => { if (current) leaveReference(); current = null; };
    const touch = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      const target = at(event);
      if (target) { event.preventDefault(); tapReference(target); }
    };
    let row: Element | null = null;
    const start = setTimeout(() => {
      row = root();
      if (!row) return;
      scan();
      observer = new MutationObserver(schedule);
      observer.observe(row, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["href"] });
      row.addEventListener("pointermove", move as EventListener);
      row.addEventListener("pointerleave", leave);
      row.addEventListener("pointerup", touch as EventListener);
    }, 0);
    return () => {
      clearTimeout(start); clearTimeout(timer); observer?.disconnect(); leave();
      row?.removeEventListener("pointermove", move as EventListener);
      row?.removeEventListener("pointerleave", leave);
      row?.removeEventListener("pointerup", touch as EventListener);
    };
  }, [message.id, message.threadId]);

  return <span ref={marker} data-shuttle-references="" className={rows.some((r) => r.url) || query.error ? "mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground" : "contents"}>
    {rows.some((r) => r.url) && <span>References:</span>}
    {rows.filter((r) => r.url).map((row) => <UrlLink key={row.id} href={row.url!} data-shuttle-reference-id={row.id} data-shuttle-reference-number={row.number}
      title={`${row.reason}. Review or correct this match in Insights › References.`}>#{row.number}</UrlLink>)}
    {query.error && <span role="status" title={messageOf(query.error)}>Reference lookup unavailable</span>}
  </span>;
}
