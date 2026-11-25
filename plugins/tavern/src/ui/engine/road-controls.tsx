import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { OpensMark } from "../kit/glyphs";
import { createPortal } from "react-dom";
import { PLACE_TARGET, placeWords, type RoadItem } from "./road-places";

function questWords(place: Extract<RoadItem["place"], { kind: "quest" }>) {
  const { name, detail } = placeWords(place, "", false);
  return `${name} · ${detail}`;
}

type PlaceAnchor = { trigger: HTMLButtonElement; id: string; anchor: DOMRect };

export function RoadControls({ items, member, hasAsk, title, highlight, openQuest }: {
  items: readonly RoadItem[];
  member: string;
  hasAsk: boolean;
  title?: string;
  highlight: (id: string | null) => void;
  openQuest?: (id: string, sealed: boolean) => void;
}) {
  const tooltipId = useId();
  const [pointer, setPointer] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [opened, setOpened] = useState<PlaceAnchor | null>(null);
  const [peek, setPeek] = useState<PlaceAnchor | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const keepTip = () => clearTimeout(leaveTimer.current);
  const leaveTip = () => {
    keepTip();
    leaveTimer.current = setTimeout(() => setPeek(null), 350);
  };
  useEffect(() => () => clearTimeout(leaveTimer.current), []);
  const disclosure = opened ?? peek;
  const active = pointer ?? focus;
  const activeId = items.some(item => item.place.id === active) ? active : null;
  useEffect(() => { highlight(activeId); return () => highlight(null); }, [highlight, activeId]);
  const selected = items.find(({ place }) => place.id === disclosure?.id);
  const folded = selected?.place.kind === "milestones" ? selected.place.quests : undefined;
  useEffect(() => {
    if (!disclosure) return;
    const close = () => { setOpened(null); setPeek(null); };
    if (!selected) { close(); return; }
    const away = (event: PointerEvent) => {
      const { target } = event;
      if (!(target instanceof Node) || !disclosure.trigger.contains(target) &&
        !(folded && document.getElementById(tooltipId)?.contains(target))) close();
    };
    const onScroll = () => {
      const { left, top } = disclosure.trigger.getBoundingClientRect();
      if (left !== disclosure.anchor.left || top !== disclosure.anchor.top) close();
    };
    const dismissPeek = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
    };
    const timer = opened && !folded ? setTimeout(close, 5_000) : undefined;
    if (!opened) document.addEventListener("keydown", dismissPeek);
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", dismissPeek);
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [disclosure, opened, !!selected, !!folded, tooltipId]);
  useEffect(() => {
    if (folded) document.getElementById(tooltipId)?.querySelector("button")?.focus({ preventScroll: true });
  }, [!!folded, tooltipId]);

  const words = selected && placeWords(selected.place, member, hasAsk, title);
  const anchor = disclosure?.anchor;
  const above = !!anchor && anchor.top >= window.innerHeight / 2;
  const stripTop = above ? disclosure?.trigger.closest(".twalk")?.getBoundingClientRect().top : undefined;
  const position: (CSSProperties & { "--twalk-tip-x": string }) | undefined = anchor ? {
    "--twalk-tip-x": `${anchor.left}px`,
    ...(stripTop === undefined ? { top: anchor.bottom + 4 } : { bottom: innerHeight - stripTop + 4 }),
  } : undefined;
  return <>
    {items.map(({ place, target }) => {
      const { name, detail } = placeWords(place, member, hasAsk, title);
      const quest = place.kind === "quest" ? place : null;
      const expanded = opened?.id === place.id;
      const at = (trigger: HTMLButtonElement) => ({ id: place.id, trigger, anchor: trigger.getBoundingClientRect() });
      return <button key={place.id} type="button" className="twalk-place" style={{ left: target, width: PLACE_TARGET, height: PLACE_TARGET }}
        data-place={place.id} data-place-state={place.state} aria-label={quest ? questWords(quest) : `${name}. ${detail}`}
        aria-expanded={quest ? undefined : expanded} aria-controls={expanded ? tooltipId : undefined}
        onPointerEnter={event => {
          if (event.pointerType === "touch") return;
          setPointer(place.id);
          if (quest && !opened) { keepTip(); setPeek(at(event.currentTarget)); }
        }}
        onPointerLeave={event => {
          setPointer(null);
          if (quest && !event.currentTarget.matches(":focus-visible")) leaveTip();
        }}
        onFocus={event => {
          if (!event.currentTarget.matches(":focus-visible")) return;
          setFocus(place.id);
          if (quest) { keepTip(); setPeek(at(event.currentTarget)); }
        }}
        onBlur={event => {
          setFocus(null);
          setPeek(null);
          if (!(event.relatedTarget instanceof Node && document.getElementById(tooltipId)?.contains(event.relatedTarget))) setOpened(null);
        }}
        onClick={event => {
          if (quest) {
            setPeek(null);
            openQuest?.(quest.id, quest.state === "sealed");
            return;
          }
          const trigger = event.currentTarget;
          trigger.focus({ preventScroll: true });
          setPeek(null);
          setOpened(expanded ? null : at(trigger));
        }}
        onKeyDown={event => {
          if (event.key === "Escape" && disclosure) {
            event.preventDefault();
            event.stopPropagation();
            setOpened(null);
            setPeek(null);
          }
        }} />;
    })}
    {words && anchor && createPortal(<div className="tavern" data-bb-plugin="tavern">
      {folded ? <div className="twalk-place-tip twalk-fold" id={tooltipId} role="group" aria-label="Folded quests" data-content
        style={position}
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpened(null); }}
        onKeyDown={event => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          setOpened(null);
          opened?.trigger.focus({ preventScroll: true });
        }}>
        <strong>{words.detail}</strong>
        {folded.map(quest => <button key={quest.id} type="button" className="lnk-btn act" onClick={() => {
          setOpened(null);
          openQuest?.(quest.id, quest.state === "sealed");
        }}><span>{questWords(quest)}</span><OpensMark /></button>)}
      </div> : <div className="twalk-place-tip" id={tooltipId} role="tooltip" data-content style={position}
        onPointerEnter={peek ? keepTip : undefined}
        onPointerLeave={peek ? () => { if (!peek.trigger.matches(":focus-visible")) leaveTip(); } : undefined}>
        {selected.place.kind === "quest" ? questWords(selected.place) : <><strong>{words.name}</strong><span>{words.detail}</span></>}
      </div>}
    </div>, document.body)}
  </>;
}
