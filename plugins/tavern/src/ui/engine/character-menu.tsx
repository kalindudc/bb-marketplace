import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ambientMotionPatch, characterQuietPatch, charactersPatch, CHARACTER_QUIET_HOUR_MS, voicePatch, DEFAULT_VOICE, type SettingsPatch, type VoiceBeforeOff, type VoiceMode } from "../../shared/settings";
import { clockTime } from "../../shared/time";
import { Glyph, type GlyphName } from "../kit/glyphs";
import type { MotionMode } from "./rules";

export type ChangeCharacterSetting = (patch: SettingsPatch, receipt: string) => void;

export function CharacterMenu({ id, name, trigger, mode, voice, voiceBeforeOff = DEFAULT_VOICE, quietUntil, close, change, openSheet }: {
  id: string;
  name: string;
  trigger: HTMLButtonElement;
  mode: MotionMode;
  voice: VoiceMode;
  voiceBeforeOff?: VoiceBeforeOff;
  quietUntil?: number;
  close: (restoreFocus: boolean) => void;
  change: ChangeCharacterSetting;
  openSheet: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const { left, top, bottom } = trigger.getBoundingClientRect();
  const above = top >= window.innerHeight / 2;
  const anchor = { "--twalk-menu-x": `${left}px`, "--twalk-menu-y": `${above ? top - 4 : bottom + 4}px` } as CSSProperties;
  useLayoutEffect(() => {
    const el = menu.current!;
    el.querySelector("button")?.focus({ preventScroll: true });
    const away = (event: PointerEvent) => {
      if (event.target instanceof Node && !el.contains(event.target) && !trigger.contains(event.target)) close(false);
    };
    const resize = () => close(true);
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("resize", resize);
    };
  }, [close, trigger]);

  const choose = (run: () => void) => { close(true); run(); };
  const changeTo = (patch: SettingsPatch, message: string) => choose(() => change(patch, message));
  const item = (label: string, glyph: GlyphName, run: () => void) =>
    <button type="button" role="menuitem" tabIndex={-1} onClick={run}><Glyph name={glyph} size={14} /><span>{label}</span></button>;
  return createPortal(<div className="tavern" data-bb-plugin="tavern">
    <div ref={menu} id={id} className="tavern-menu twalk-menu" role="menu" aria-label={`${name}'s character settings`}
      style={anchor} data-above={above || undefined} onContextMenu={e => e.preventDefault()} onKeyDown={e => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); return; }
        if (e.key === "Tab") { e.stopPropagation(); close(true); return; }
        const buttons = Array.from(e.currentTarget.querySelectorAll("button"));
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1
          : e.key === "ArrowDown" ? (at + 1) % buttons.length : e.key === "ArrowUp" ? (at - 1 + buttons.length) % buttons.length : null;
        if (next !== null) { e.preventDefault(); e.stopPropagation(); buttons[next]?.focus(); }
      }}>
      {item("Hide characters", "hide", () => changeTo(charactersPatch(false), "Characters hidden."))}
      <div className="menu-sep" role="separator" />
      <div className="twalk-menu-group" role="group" aria-label="Ambient motion">
        <span className="lbl" aria-hidden="true">Motion</span>
        {([["calm", "Calm"], ["lively", "Lively"], ["off", "Off"]] as const).map(([value, label]) =>
          <button key={value} type="button" role="menuitemradio" aria-checked={mode === value} tabIndex={-1}
            onClick={() => changeTo(ambientMotionPatch(value), `Motion set to ${label}.`)}>
            <span className="twalk-radio" aria-hidden="true" /><span>{label}</span>
          </button>)}
      </div>
      <div className="menu-sep" role="separator" />
      <button type="button" role="menuitemcheckbox" aria-checked={voice !== "off"} tabIndex={-1} onClick={() => {
        const next = voice === "off" ? voiceBeforeOff : "off";
        changeTo(voicePatch(next, voice), next === "off" ? "Speech bubbles off." : `Speech bubbles set to ${next === "light" ? "Light" : "Full"}.`);
      }}><span className="twalk-checkbox" aria-hidden="true">{voice !== "off" && <Glyph name="check" size={12} />}</span><span>Speech bubbles</span></button>
      {item(`Open ${name}'s sheet`, "book", () => choose(openSheet))}
      {quietUntil ? <button type="button" role="menuitemcheckbox" aria-checked="true" tabIndex={-1}
        onClick={() => changeTo(characterQuietPatch(0), "Quiet ended.")}>
        <span className="twalk-checkbox" aria-hidden="true"><Glyph name="check" size={12} /></span><span>Quiet until {clockTime(quietUntil)}</span>
      </button> : item("Quiet for an hour", "pause", () => {
        const until = Date.now() + CHARACTER_QUIET_HOUR_MS;
        changeTo(characterQuietPatch(until), `Quiet until ${clockTime(until)}.`);
      })}
    </div>
  </div>, document.body);
}
