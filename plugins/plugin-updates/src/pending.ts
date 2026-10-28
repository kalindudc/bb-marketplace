import type { PendingUpdate } from "./contract";
import { isCommit, shortCommit, versionLabel } from "./versions";

/** The parts of bb's installed-plugin record this plugin reads. */
export interface InstalledPluginLike {
  id: string;
  name: string | null;
  version: string;
  icon: string | null;
  iconUrl: string | null;
  logoUrl: string | null;
  updateState: {
    availableVersion?: string | undefined;
    lastFailure?: { version: string; detail: string } | undefined;
  };
}

export interface UpdateResultLike {
  id: string;
  installed: { version: string; display: string };
  candidate?: { version: string; display: string } | undefined;
}

export interface UpdateJobLike {
  pluginId: string;
  state: "queued" | "running" | "completed" | "failed";
  phase?: string | undefined;
  error?: string | undefined;
}

const PHASES: Record<string, string> = {
  preparing: "Preparing",
  activating: "Activating",
  checking: "Checking",
  "rolling-back": "Rolling back",
};

/**
 * Every plugin bb marks as having an update, the same set the Installed page marks with its Update signal,
 * with the versions to show and the state of its latest update job.
 */
export function pendingUpdates(
  plugins: readonly InstalledPluginLike[],
  results: readonly UpdateResultLike[],
  jobs: readonly UpdateJobLike[],
): PendingUpdate[] {
  return plugins
    .flatMap((plugin): PendingUpdate[] => {
      const candidate = plugin.updateState.availableVersion;
      if (candidate === undefined || candidate === "") return [];
      const result = results.find((entry) => entry.id === plugin.id);
      const candidateDisplay = result?.candidate?.version === candidate ? result.candidate.display : null;
      const failure = plugin.updateState.lastFailure;
      const imageUrl = plugin.logoUrl ?? plugin.iconUrl;
      return [
        {
          id: plugin.id,
          name: plugin.name ?? plugin.id,
          icon: imageUrl === null && plugin.icon !== null && /^[A-Za-z0-9_/-]+$/u.test(plugin.icon) ? plugin.icon : null,
          imageUrl,
          installed: {
            version: result?.installed.version ?? plugin.version,
            label: isCommit(plugin.version) ? shortCommit(plugin.version) : plugin.version,
          },
          candidate: { version: candidate, label: versionLabel(candidate, candidateDisplay) },
          lastFailure: failure === undefined ? null : failure.detail || `The update to ${versionLabel(failure.version, null)} was rolled back.`,
          job: latestJob(jobs, plugin.id),
        },
      ];
    })
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

function latestJob(jobs: readonly UpdateJobLike[], pluginId: string): PendingUpdate["job"] {
  const job = jobs.filter((entry) => entry.pluginId === pluginId).at(-1);
  if (job === undefined || job.state === "completed") return null;
  if (job.state === "failed") return { state: "failed", detail: job.error ?? null };
  if (job.state === "running") return { state: "running", detail: PHASES[job.phase ?? ""] ?? null };
  return { state: "queued", detail: null };
}
