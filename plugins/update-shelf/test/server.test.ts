import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { GitHub } from "../src/github";
import { createPlugin } from "../src/plugin";
import { GENUI_CANDIDATE, GENUI_INSTALLED, burn, current, genui, results } from "./fixtures";

const GENUI_SOURCE = {
  requested: "git:https://github.com/o/r.git@semver:genui/:>=0.1.0 <1.0.0",
  resolved: "https://github.com/o/r.git@genui/v0.2.6 (d86c13657608)",
  subdirectory: "plugins/genui",
  tagPrefix: "genui/",
  engines: {},
  history: [{ version: GENUI_INSTALLED, activatedAt: 1 }],
};

function setup(options: { startUpdate?: (pluginId: string) => Promise<unknown>; github?: Partial<GitHub> } = {}) {
  const started: string[] = [];
  const githubCalls: string[] = [];
  const github: GitHub = {
    async file(_repo, path, ref) {
      githubCalls.push(`file ${path}@${ref}`);
      return path.endsWith("CHANGELOG.md") ? "## [0.2.7]\n- Trusted file directories.\n\n## [0.2.6]\n- Animations.\n" : null;
    },
    async commitDate(_repo, sha) {
      githubCalls.push(`date ${sha}`);
      return "2026-10-21T12:00:00Z";
    },
    async commits(_repo, { head, path }) {
      githubCalls.push(`commits ${path}@${head}`);
      return [{ sha: "c1", title: "genui: trusted dirs", url: "https://github.com/o/r/commit/c1" }];
    },
    ...options.github,
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "update-shelf",
    sdk: {
      plugins: {
        list: async () => ({ plugins: [genui, current, burn] }) as never,
        listUpdateResults: async () => results as never,
        getSource: async () => GENUI_SOURCE as never,
        experimental_updateJobs: { list: async () => [{ id: "j1", pluginId: "burn", displayName: "Burn", state: "queued" }] as never },
        experimental_startUpdate: async ({ pluginId }) => {
          started.push(pluginId);
          if (options.startUpdate !== undefined) await options.startUpdate(pluginId);
          return { id: `job-${pluginId}`, pluginId, displayName: pluginId, state: "queued" } as never;
        },
      },
    },
  });
  createPlugin({ github })(bb);
  return { harness, started, githubCalls };
}

describe("update-shelf backend", () => {
  it("lists the plugins waiting for an update with their running jobs", async () => {
    const { harness } = setup();
    const result = (await harness.behavior.callRpc("list", null)) as { updates: Array<{ id: string; job: unknown }> };
    expect(result.updates.map((update) => [update.id, update.job])).toEqual([
      ["burn", { state: "queued", detail: null }],
      ["genui", null],
    ]);
  });

  it("reads a changelog between the installed and the candidate commit, once per update", async () => {
    const { harness, githubCalls } = setup();
    const first = (await harness.behavior.callRpc("changelog", { id: "genui" })) as { notes: Array<{ version: string }>; commits: unknown[] };
    expect(first.notes.map((entry) => entry.version)).toEqual(["0.2.7"]);
    expect(first.commits).toHaveLength(1);
    await harness.behavior.callRpc("changelog", { id: "genui" });
    expect(githubCalls).toEqual([
      `file plugins/genui/CHANGELOG.md@${GENUI_CANDIDATE}`,
      `date ${GENUI_INSTALLED}`,
      `commits plugins/genui@${GENUI_CANDIDATE}`,
    ]);
  });

  it("reads again after a failed read instead of keeping the failure", async () => {
    let fail = true;
    const { harness } = setup({
      github: {
        async file() {
          if (fail) throw new Error("offline");
          return "## [0.2.7]\n- New\n";
        },
        async commitDate() {
          if (fail) throw new Error("offline");
          return "2026-10-21T12:00:00Z";
        },
      },
    });
    const failed = (await harness.behavior.callRpc("changelog", { id: "genui" })) as { unavailable: string | null };
    expect(failed.unavailable).toMatch(/offline/u);
    fail = false;
    const read = (await harness.behavior.callRpc("changelog", { id: "genui" })) as { notes: unknown[]; unavailable: string | null };
    expect(read.unavailable).toBeNull();
    expect(read.notes).toHaveLength(1);
  });

  it("answers plainly for a plugin with no waiting update", async () => {
    const { harness } = setup();
    const result = (await harness.behavior.callRpc("changelog", { id: "loom" })) as { unavailable: string };
    expect(result.unavailable).toBe("No update is waiting for this plugin.");
  });

  it("starts each update and leaves this plugin for last, since updating it reloads this backend", async () => {
    const { harness, started } = setup();
    const result = await harness.behavior.callRpc("update", { ids: ["update-shelf", "genui", "burn", "genui"] });
    expect(started).toEqual(["genui", "burn", "update-shelf"]);
    expect(result).toEqual({ started: ["genui", "burn", "update-shelf"], failed: [] });
  });

  it("keeps going past an update bb refuses to start", async () => {
    const { harness } = setup({
      startUpdate: async (pluginId) => {
        if (pluginId === "genui") throw new Error("no compatible update");
      },
    });
    const result = await harness.behavior.callRpc("update", { ids: ["genui", "burn"] });
    expect(result).toEqual({ started: ["burn"], failed: [{ id: "genui", error: "no compatible update" }] });
  });

  it("refuses an empty update request at the boundary", async () => {
    const { harness } = setup();
    await expect(harness.behavior.callRpc("update", { ids: [] })).rejects.toThrow();
  });
});
