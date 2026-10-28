import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract, type Changelog } from "./contract";
import type { GitHub } from "./github";
import { updateRows, type LabelMemory } from "./pending";
import { releaseNotes } from "./release-notes";
import { isCommit, refFromDisplay, semverFromRef } from "./versions";

export interface PluginDeps {
  github: GitHub;
}

const CHANGELOG_CACHE_LIMIT = 100;

export function createPlugin(deps: PluginDeps) {
  return function plugin(bb: BbPluginApi): void {
    const plugins = bb.sdk.plugins;
    // Keyed by both commits, so a cached changelog is never shown for another update.
    const changelogs = new Map<string, Promise<Changelog>>();
    const labels: LabelMemory = new Map();

    const rows = async () => {
      const [list, results, jobs] = await Promise.all([
        plugins.list(),
        plugins.listUpdateResults(),
        plugins.experimental_updateJobs.list(),
      ]);
      return updateRows(list.plugins, results, jobs, labels);
    };

    bb.rpc.register(rpcContract, {
      async list() {
        return { updates: await rows() };
      },

      async changelog({ id }) {
        const [list, results, source] = await Promise.all([
          plugins.list(),
          plugins.listUpdateResults(),
          plugins.getSource({ pluginId: id }),
        ]);
        const installed = list.plugins.find((plugin) => plugin.id === id);
        const candidate = installed?.updateState.availableVersion;
        if (installed === undefined || candidate === undefined) {
          return {
            toVersion: null,
            notes: [],
            commits: [],
            moreCommits: 0,
            commitsCapped: false,
            compareUrl: null,
            unavailable: "No update is waiting for this plugin.",
          };
        }
        const result = results.find((entry) => entry.id === id);
        const latestActivation = [...source.history].sort((a, b) => b.activatedAt - a.activatedAt)[0]?.version ?? null;
        const installedCommit = [result?.installed.version, latestActivation].find(
          (value): value is string => value !== undefined && value !== null && isCommit(value),
        ) ?? null;
        const candidateRef = result?.candidate?.version === candidate ? refFromDisplay(result.candidate.display) : null;
        const key = `${id}\u0000${installedCommit}\u0000${candidate}`;
        let pending = changelogs.get(key);
        if (pending === undefined) {
          pending = releaseNotes(
            {
              source: source.resolved || source.requested,
              subdirectory: source.subdirectory ?? null,
              installedCommit,
              candidateCommit: candidate,
              installedVersion: installed.version,
              candidateVersion: candidateRef === null ? null : semverFromRef(candidateRef),
            },
            deps.github,
          );
          changelogs.set(key, pending);
          if (changelogs.size > CHANGELOG_CACHE_LIMIT) changelogs.delete(changelogs.keys().next().value!);
          pending.then(
            (value) => {
              if (value.unavailable !== null) changelogs.delete(key);
            },
            () => changelogs.delete(key),
          );
        }
        return pending;
      },

      async update({ ids }) {
        // Updating this plugin reloads this backend, so it goes last.
        const ordered = [...new Set(ids)].sort((a, b) => Number(a === bb.pluginId) - Number(b === bb.pluginId));
        const before = new Map((await rows()).filter((row) => row.updateAvailable).map((row) => [row.id, row]));
        const started: string[] = [];
        const failed: Array<{ id: string; error: string }> = [];
        for (const id of ordered) {
          try {
            const job = await plugins.experimental_startUpdate({ pluginId: id });
            const row = before.get(id);
            if (row !== undefined) labels.set(job.id, { installed: row.installed, candidate: row.candidate });
            started.push(id);
          } catch (error) {
            failed.push({ id, error: error instanceof Error ? error.message : String(error) });
          }
        }
        return { started, failed };
      },
    });
  };
}
