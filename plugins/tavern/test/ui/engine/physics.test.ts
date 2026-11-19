import { expect, it } from "vitest";
import { createBody, stepBody, hop } from "../../../src/ui/engine/physics";

it("integrates position, hop and swing deterministically, then settles", () => {
  const run = () => {
    const body = createBody();
    hop(body);
    const trace = [];
    for (let i = 0; i < 360; i++) {
      stepBody(body, i < 35 ? 100 : null, 1 / 60);
      trace.push({ ...body });
    }
    return trace;
  };
  const trace = run();
  expect(trace).toEqual(run());
  expect(trace[9]!.x).toBeGreaterThan(0);
  expect(trace[9]!.lift).toBeGreaterThan(0);
  expect(Math.abs(trace[9]!.swing)).toBeGreaterThan(0.01);
  expect(trace[35]!.x).toBe(trace[34]!.x);
  expect(trace.at(-1)!.lift).toBe(0);
  expect(trace.at(-1)!.swing).toBeCloseTo(0, 3);
});
