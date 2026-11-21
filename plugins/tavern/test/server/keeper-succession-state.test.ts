// @vitest-environment node
import { describe, expect, it } from "vitest";
import { KeeperSuccessionStore } from "../../src/server/keeper/succession-store";
import { setup } from "./runtime-fixture";

const by = { kind: "user" as const };
const party = [{ threadId: "member-a", notifications: "stuck" as const }];

function fixture() {
  const f = setup();
  const s = new KeeperSuccessionStore(f.k.store, f.time);
  const request = () => s.propose("lead", by, "Fresh context");
  return { ...f, s, request };
}

describe("Keeper succession authority", () => {
  it("keeps a staged candidate fenced and commits one current owner with its follow-ups", () => {
    const { s, k, request } = fixture();
    const op = request();
    expect(s.current("lead")).toBe("lead");
    expect(request().id).toBe(op.id);
    s.prepare(op.id, party);
    s.bindCandidate(op.id, "candidate");
    expect(s.fence("lead")).toMatchObject({ kind: "preparing" });
    expect(s.fence("candidate")).toMatchObject({ kind: "candidate" });
    s.cutover(op.id, [({ successor }) => { k.bind(successor, "keeper", "wren", "project"); }]);
    expect(s.current("lead")).toBe("candidate");
    expect(s.fence("lead")).toEqual({ kind: "retired", current: "candidate" });
    expect(s.fence("candidate")).toBeNull();
    expect(s.get(op.id)).toMatchObject({ state: "done", followups: { members: [{ ...party[0], done: false }], visible: false, bootstrap: false } });
    expect(() => request()).toThrow(/current Keeper/);
    expect(() => s.propose("candidate", by, "Too soon")).toThrow(/follow-ups/);
  });

  it("rolls back the pointer if transfer fails and leaves a failed candidate inert after restart", () => {
    const f = fixture(), op = f.request();
    f.s.prepare(op.id, party);
    f.s.bindCandidate(op.id, "candidate");
    expect(() => f.s.cutover(op.id, [() => { f.k.store.patch("lead", { hidden: true }); }, () => { throw new Error("transfer failed"); }])).toThrow("transfer failed");
    const restored = new KeeperSuccessionStore(f.k.store, f.time);
    expect(f.k.store.runtime("lead").hidden).toBe(false);
    expect(restored.current("lead")).toBe("lead");
    expect(restored.get(op.id).state).toBe("preparing");
    restored.fail(op.id, "transfer failed");
    expect(restored.fence("candidate")).toMatchObject({ kind: "candidate" });
    expect(restored.fence("lead")).toBeNull();
    expect(restored.propose("lead", by, "Retry").id).not.toBe(op.id);
  });

  it("does not rewind a committed handover and resolves a retired Keeper through a second generation", () => {
    const { s, k, request } = fixture();
    const first = request();
    s.prepare(first.id, party); s.bindCandidate(first.id, "replacement"); s.cutover(first.id, [({ successor }) => { k.bind(successor, "keeper", "wren", "project"); }]);
    expect(() => s.fail(first.id, "network disconnected")).toThrow(/already committed/);
    s.complete(first.id, "member-a"); s.complete(first.id, "visible"); s.complete(first.id, "bootstrap");
    const second = s.propose("replacement", by, "Fresh again");
    expect(second.generation).toBe(2);
    s.prepare(second.id, []); s.bindCandidate(second.id, "current"); s.cutover(second.id, [({ successor }) => { k.bind(successor, "keeper", "wren", "project"); }]);
    expect(s.current("lead")).toBe("current");
    expect(s.current("replacement")).toBe("current");
  });
});
