// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ArrivalMark, useLookedSince } from "../../../src/ui/kit/arrival";
import { readRemembered, writeRemembered } from "../../../src/ui/kit/remember";
import { motion } from "../../../src/ui/kit/motion";
import { installAnimations } from "./motion-fakes";

let fx: ReturnType<typeof installAnimations>;
beforeEach(() => { motion.reset(); motion.now = () => 1_000_000; fx = installAnimations({ "mo-arrive": 300 }); localStorage.clear(); });
afterEach(() => { cleanup(); fx.uninstall(); motion.reset(); });

function Probe({ scope, onSince }: { scope: string; onSince: (v: number | undefined) => void }) { onSince(useLookedSince(scope)); return null; }

describe("useLookedSince", () => {
  it("reads the last look once per view and records a new one when the view is left", () => {
    const seen: (number | undefined)[] = [];
    const v = render(<Probe scope="room" onSince={x => seen.push(x)} />);
    expect(seen[0]).toBeUndefined();
    v.unmount();
    expect(typeof readRemembered<number>("looked:room")).toBe("number");
    writeRemembered("looked:room", 1234);
    render(<Probe scope="room" onSince={x => seen.push(x)} />);
    expect(seen.at(-1)).toBe(1234);
  });
});

describe("ArrivalMark", () => {
  const mount = (at: number, since: number | undefined) => render(<div className="tavern"><ArrivalMark at={at} since={since} surface="page" cueKey="q1" /></div>);

  it("shows the primary mark and the word on what changed since the last look, and fades it in once", () => {
    const v = mount(200, 100);
    expect(v.container.querySelector(".arrival-mark")!.textContent).toBe("new");
    expect([...motion.cues].map(c => c.kind)).toEqual(["arrival"]);
  });

  it("shows nothing on a first visit or for something older than the last look", () => {
    expect(mount(200, undefined).container.querySelector(".arrival-mark")).toBeNull();
    cleanup();
    expect(mount(50, 100).container.querySelector(".arrival-mark")).toBeNull();
    expect(motion.cues.size).toBe(0);
  });
});
