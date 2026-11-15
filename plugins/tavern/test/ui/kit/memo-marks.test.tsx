// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { ArrivalMark, Crest, CrestOf, Glyph, OpensMark, PhaseMark, StateMark, TimeAgo } from "../../../src/ui/kit";
import { CrestPaths } from "../../../src/ui/kit/crest";
import { PageGlyph } from "../../../src/ui/page/glyphs";
import { Ago } from "../../../src/ui/page/common";
import type { Phase } from "../../../src/shared/schema";
import { fixtureCharacter, fixtureClass, fixtureMember, fixtureRegistry } from "../../../src/ui/thread/fixtures";

// Each part is a React.memo. The test swaps the memo's inner function for one that counts its calls and then runs the original, so the
// memo itself (what React compares, and when it bails out) is the real one. React reads the inner function when the part mounts.
const parts = { ArrivalMark, Crest, CrestOf, CrestPaths, Glyph, OpensMark, PhaseMark, StateMark, TimeAgo, PageGlyph, Ago };
type Name = keyof typeof parts;
const counts = {} as Record<Name, number>;
const restore: (() => void)[] = [];
function countRenders() {
  for (const [name, part] of Object.entries(parts) as [Name, unknown][]) {
    const m = part as { $$typeof: symbol; type: (props: object) => ReactNode };
    expect(m.$$typeof, `${name} is a React.memo`).toBe(Symbol.for("react.memo"));
    const inner = m.type;
    counts[name] = 0;
    m.type = (props: object) => { counts[name] += 1; return inner(props); };
    restore.push(() => { m.type = inner; });
  }
}
afterEach(() => { cleanup(); restore.splice(0).forEach(r => r()); vi.useRealTimers(); });

const AT = new Date(2026, 10, 14, 11, 0).getTime();
type Props = { tick: number; glyph?: number; phase?: Phase; tone?: "busy" | "idle"; at?: number; crest?: number; fresh?: boolean };
function Parent({ tick, glyph = 14, phase = "build", tone = "busy", at = AT, crest = 20, fresh = false }: Props) {
  // Stable data, as React Query's structural sharing keeps it between refetches; `fresh` passes a new character object with the same values.
  const character = fresh ? { ...fixtureCharacter } : fixtureCharacter;
  return <div data-tick={tick}>
    <Crest cls={fixtureClass} character={character} size={crest} />
    <svg><CrestPaths shape="shield" hue="teal" charge="chevron" size={20} /></svg>
    <CrestOf member={fixtureMember} registry={fixtureRegistry} />
    <Glyph name="ask" size={glyph} />
    <OpensMark />
    <PhaseMark phase={phase} tone="work" />
    <StateMark tone={tone}>{tone}</StateMark>
    <TimeAgo at={at} />
    <ArrivalMark at={AT} since={AT - 1} surface="page" cueKey="row:q1" still />
    <PageGlyph name="quest" />
    <Ago at={AT} />
  </div>;
}

describe("the kit's small marks are memoized", () => {
  it("skip every part when the parent re-renders with the same props", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AT + 5 * 60_000);
    countRenders();
    const view = render(<Parent tick={0} />);
    const mounted = { ...counts };
    // Glyph draws for itself, OpensMark, StateMark and PageGlyph; Crest for itself and CrestOf; TimeAgo for itself and Ago.
    expect(mounted).toMatchObject({ Glyph: 4, Crest: 2, CrestPaths: 3, TimeAgo: 2, OpensMark: 1, StateMark: 1, PhaseMark: 1, CrestOf: 1, ArrivalMark: 1, PageGlyph: 1, Ago: 1 });
    view.rerender(<Parent tick={1} />);
    view.rerender(<Parent tick={2} />);
    expect(counts).toEqual(mounted);
  });

  it("re-render only the part whose prop changed, and what it draws", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AT + 5 * 60_000);
    countRenders();
    const view = render(<Parent tick={0} />);
    const before = { ...counts };
    view.rerender(<Parent tick={1} glyph={16} />);
    expect(counts).toEqual({ ...before, Glyph: before.Glyph + 1 });
    view.rerender(<Parent tick={2} glyph={16} phase="check" tone="idle" at={AT + 60_000} />);
    // StateMark's tone changes its own Glyph's name, so that Glyph draws again too.
    expect(counts).toEqual({ ...before, Glyph: before.Glyph + 2, PhaseMark: 2, StateMark: 2, TimeAgo: before.TimeAgo + 1 });
    view.rerender(<Parent tick={3} glyph={16} phase="check" tone="idle" at={AT + 60_000} crest={32} />);
    expect(counts.Crest).toBe(before.Crest + 1);
    expect(counts.CrestPaths).toBe(before.CrestPaths + 1);
  });

  it("keeps the crest's paths when a caller passes a new character object with the same values", () => {
    countRenders();
    const view = render(<Parent tick={0} fresh />);
    const before = { ...counts };
    view.rerender(<Parent tick={1} fresh />);
    // A fresh object defeats Crest's memo (one svg element), but CrestPaths compares the shape, hue, charge and size, and skips.
    expect(counts.Crest).toBe(before.Crest + 1);
    expect(counts.CrestPaths).toBe(before.CrestPaths);
  });

  it("still update TimeAgo from its own minute timer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(AT + 30_000);
    countRenders();
    const view = render(<Parent tick={0} />);
    const time = () => view.container.querySelector("time")!.textContent;
    expect(time()).toBe("just now");
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(time()).toBe("1m ago");
  });
});
