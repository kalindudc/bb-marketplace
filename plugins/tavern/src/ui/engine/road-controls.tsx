import { useEffect, useId, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { PLACE_TARGET, placeWords, type RoadItem } from "./road-places";

export function RoadControls({ items, member, hasAsk, title, highlight }: {
  items: readonly RoadItem[];
  member: string;
  hasAsk: boolean;
  title?: string;
  highlight: (id: string | null) => void;
}) {
  const tooltipId = useId();
  const [pointer, setPointer] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ trigger: HTMLButtonElement; id: string; anchor: DOMRect } | null>(null);
  const active = pointer ?? focus;
  const activeId = items.some(item => item.place.id === active) ? active : null;
  useEffect(() => { highlight(activeId); return () => highlight(null); }, [highlight, activeId]);
  const selected = items.find(({ place }) => place.id === opened?.id);
  useEffect(() => {
    if (!opened) return;
    if (!selected) { setOpened(null); return; }
    const close = () => setOpened(null);
    const away = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !opened.trigger.contains(event.target)) close();
    };
    const onScroll = () => {
      const { left, top } = opened.trigger.getBoundingClientRect();
      if (left !== opened.anchor.left || top !== opened.anchor.top) close();
    };
    const timer = setTimeout(close, 5_000);
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [opened, !!selected]);

  const words = selected && placeWords(selected.place, member, hasAsk, title);
  const anchor = opened?.anchor;
  const above = !!anchor && anchor.top >= window.innerHeight / 2;
  const stripTop = above ? opened?.trigger.closest(".twalk")?.getBoundingClientRect().top : undefined;
  const position: (CSSProperties & { "--twalk-tip-x": string }) | undefined = anchor ? {
    "--twalk-tip-x": `${anchor.left}px`,
    ...(stripTop === undefined ? { top: anchor.bottom + 4 } : { bottom: innerHeight - stripTop + 4 }),
  } : undefined;
  return <>
    {items.map(({ place, target }) => {
      const { name, detail } = placeWords(place, member, hasAsk, title);
      const expanded = selected?.place.id === place.id;
      return <button key={place.id} type="button" className="twalk-place" style={{ left: target, width: PLACE_TARGET, height: PLACE_TARGET }}
        data-place={place.id} data-place-state={place.state} aria-label={`${name}. ${detail}`}
        aria-expanded={expanded} aria-controls={expanded ? tooltipId : undefined}
        onPointerEnter={event => { if (event.pointerType !== "touch") setPointer(place.id); }}
        onPointerLeave={() => setPointer(null)}
        onFocus={event => { if (event.currentTarget.matches(":focus-visible")) setFocus(place.id); }}
        onBlur={() => { setFocus(null); setOpened(null); }}
        onClick={event => {
          const trigger = event.currentTarget;
          trigger.focus({ preventScroll: true });
          setOpened(expanded ? null : { id: place.id, trigger, anchor: trigger.getBoundingClientRect() });
        }}
        onKeyDown={event => {
          if (event.key === "Escape" && opened) {
            event.preventDefault();
            event.stopPropagation();
            setOpened(null);
          }
        }} />;
    })}
    {words && anchor && createPortal(<div className="tavern" data-bb-plugin="tavern">
      <div className="twalk-place-tip" id={tooltipId} role="tooltip" data-content
        style={position}>
        <strong>{words.name}</strong><span>{words.detail}</span>
      </div>
    </div>, document.body)}
  </>;
}
