// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "./runtime-fixture";
import { registerScopeSettings } from "../../src/server/scopes";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(initial?: string) {
  const root = mkdtempSync(join(tmpdir(), "tavern-settings-"));
  roots.push(root);
  let saved = initial;
  let listener: (next: { scopes: string }, previous: { scopes: string }) => void;
  const define = vi.fn((descriptors: { scopes: { default: string } }) => ({
    get: async () => ({ scopes: saved ?? descriptors.scopes.default }),
    onChange: (callback: typeof listener) => {
      listener = callback;
    },
  }));
  const create = async () => {
    const f = setup();
    Object.assign(f.bb, { settings: { define } });
    f.bb.sdk.threads.storageLocation = async () => ({ hostId: "host", storageRootPath: root });
    await registerScopeSettings(f.bb, f.runtime, {
      dataDir: root,
      installGuard: false,
      policyOptions: { home: root },
    });
    return f;
  };
  return {
    root,
    define,
    create,
    set: (next: string) => {
      const previous = saved ?? "enforce";
      saved = next;
      listener({ scopes: next }, { scopes: previous });
    },
  };
}

describe("persisted scope mode setting", () => {
  it("declares enforce, watch and off with enforce as the default", async () => {
    const f = fixture();
    const host = await f.create();
    expect(f.define).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: expect.objectContaining({
          type: "select",
          options: ["enforce", "watch", "off"],
          default: "enforce",
        }),
      }),
    );
    expect(host.runtime.scopes!.api.mode()).toBe("enforce");
  });
  it.each(["watch", "off"])(
    "loads persisted %s and applies live changes to scope files without a reload",
    async (initial) => {
      const f = fixture(initial);
      const host = await f.create();
      const api = host.runtime.scopes!.api;
      expect(api.mode()).toBe(initial);
      await api.writeScope("lead", api.scopeForHire("keeper"));
      const file = join(f.root, "scopes/lead.json");
      expect(JSON.parse(readFileSync(file, "utf8")).mode).toBe(initial);
      const setMode = vi.spyOn(api, "setMode");
      f.set("enforce");
      expect(setMode).toHaveBeenCalledWith("enforce");
      expect(JSON.parse(readFileSync(file, "utf8")).mode).toBe("enforce");
      expect(host.bb.rpc.experimental_invalidate).toHaveBeenCalledWith(
        expect.arrayContaining(["tavern:thread:lead", "tavern:room"]),
      );
      f.set("off");
      expect(JSON.parse(readFileSync(file, "utf8")).mode).toBe("off");
      expect((await f.create()).runtime.scopes!.api.mode()).toBe("off");
    },
  );
});
