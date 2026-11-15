// @vitest-environment node
import { expect, it, vi } from "vitest";
import { setup } from "./runtime-fixture";
const ask = {
  question: "Clarify?",
  why: "Unresolved",
  kind: "decision" as const,
  options: [{ id: "a", label: "A", detail: "", recommended: true }],
  meanwhile: "Keep scouting",
  holds: [],
};
it("observes a new ask only after its containing transaction commits", async () => {
  const f = setup(),
    opened = vi.fn();
  f.k.askOpened = opened;
  const saved = f.k.store.atomic(() => {
    const saved = f.k.ask("lead", ask);
    expect(opened).not.toHaveBeenCalled();
    return saved;
  });
  await Promise.resolve();
  expect(opened).toHaveBeenCalledOnce();
  expect(opened).toHaveBeenCalledWith(saved);
});
it("does not notify about an ask rolled back by its containing plan transaction", async () => {
  const f = setup(),
    opened = vi.fn();
  f.k.askOpened = opened;
  expect(() =>
    f.k.store.atomic(() => {
      f.k.ask("lead", ask);
      throw new Error("Rollback plan");
    }),
  ).toThrow("Rollback plan");
  await Promise.resolve();
  expect(opened).not.toHaveBeenCalled();
  expect(f.k.store.openAsks("lead")).toHaveLength(0);
});
