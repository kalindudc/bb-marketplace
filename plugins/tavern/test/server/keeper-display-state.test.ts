// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import type { Room, ThreadDecor } from "../../src/shared/contract";
import { registerRpc } from "../../src/server/rpc";
import { setup } from "./runtime-fixture";

const databases: ReturnType<typeof setup>["k"]["store"]["db"][] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const f = setup();
  databases.push(f.k.store.db);
  registerRpc(f.bb, f.runtime);
  const status = async (surface: "room" | "decor") => {
    if (surface === "room") {
      const room = await f.harness.invokeRpc("room", {}) as Room;
      return room.keepers.find(row => row.member.threadId === "lead")!.status;
    }
    const decor = await f.harness.invokeRpc("decor", { threadId: "lead" }) as ThreadDecor;
    return decor.keeperView!.status;
  };
  const hold = (kind: "message" | "typing") => {
    if (kind === "message") f.k.receiveUser("lead", "Please keep working on this.");
    else f.k.store.patch("lead", { typingAt: f.time() });
  };
  return { ...f, status, hold };
}

describe.each(["room", "decor"] as const)("%s Keeper display state", surface => {
  it.each([
    { kind: "message" as const, elapsed: 0 }, { kind: "message" as const, elapsed: 25_000 },
    { kind: "typing" as const, elapsed: 0 }, { kind: "typing" as const, elapsed: 25_000 },
  ])("shows active work as busy during a recent $kind hold after $elapsed ms", async ({ kind, elapsed }) => {
    const f = fixture(); f.hold(kind); f.k.activity("lead", "working"); f.advance(elapsed);
    expect(f.runtime.held("lead")).toBe(true);
    expect(await f.status(surface)).toBe("busy");
    expect(f.runtime.held("lead")).toBe(true);
  });

  it.each(["message", "typing"] as const)("shows an idle Keeper as holding during a recent %s", async kind => {
    const f = fixture(); f.hold(kind); f.k.activity("lead", "idle");
    expect(f.runtime.held("lead")).toBe(true);
    expect(await f.status(surface)).toBe("holding");
  });

  it("keeps archived precedence over stale working state and recent holds", async () => {
    const f = fixture(); f.hold("message"); f.hold("typing"); f.k.activity("lead", "working");
    f.k.store.patch("lead", { archivedAt: f.time() });
    expect(f.k.member("lead")!.state).toBe("working");
    expect(await f.status(surface)).toBe("listening");
  });

  it("changes from busy to holding after the turn, then listening when the hold expires", async () => {
    const f = fixture(); f.hold("message"); f.k.activity("lead", "working");
    expect(await f.status(surface)).toBe("busy");
    f.k.activity("lead", "idle");
    expect(await f.status(surface)).toBe("holding");
    f.advance(f.runtime.config().knobs.afterMessageHoldSeconds * 1000);
    expect(await f.status(surface)).toBe("listening");
  });

  it("shows busy without a hold while a turn is active", async () => {
    const f = fixture(); f.k.activity("lead", "working");
    expect(f.runtime.held("lead")).toBe(false);
    expect(await f.status(surface)).toBe("busy");
  });

  it("shows listening for an idle Keeper without a hold", async () => {
    const f = fixture();
    expect(f.runtime.held("lead")).toBe(false);
    expect(await f.status(surface)).toBe("listening");
  });
});
