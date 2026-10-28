import type { PendingUpdate, UpdateJob, UpdatePhase } from "./contract";
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

interface ResolvedVersionLike {
  version: string;
  display: string;
}

export interface UpdateResultLike {
  id: string;
  installed: ResolvedVersionLike;
  candidate?: ResolvedVersionLike | undefined;
}

export interface UpdateJobLike {
  id: string;
  pluginId: string;
  state: "queued" | "running" | "completed" | "failed";
  phase?: string | undefined;
  error?: string | undefined;
  result?:
    | {
        from: ResolvedVersionLike;
        to?: ResolvedVersionLike | undefined;
        outcome: "current" | "updated" | "rolled-back";
        detail?: string | undefined;
      }
    | undefined;
}

export type VersionLabels = Pick<PendingUpdate, "installed" | "candidate">;

/**
 * The versions of each job's update, by job id, remembered while bb still describes the update.
 * bb clears a plugin's waiting update as soon as it starts activating the new version, 30 seconds or more
 * before the job finishes, and its plugin record then names the new version as the installed one.
 */
export type LabelMemory = Map<string, VersionLabels>;

const PHASES = new Set<string>(["preparing", "activating", "checking", "rolling-back"]);

const isActive = (job: UpdateJobLike) => job.state === "queued" || job.state === "running";
const isFailure = (job: UpdateJobLike) => job.state === "failed" || job.result?.outcome === "rolled-back";

/**
 * A row for every plugin with a waiting update, an update in bb's queue, or an update that finished while bb
 * still keeps its job (ten minutes). Running and queued rows come first, in the order bb will run them.
 */
export function updateRows(
  plugins: readonly InstalledPluginLike[],
  results: readonly UpdateResultLike[],
  jobs: readonly UpdateJobLike[],
  memory: LabelMemory,
): PendingUpdate[] {
  const queue = jobs.filter((job) => job.state === "queued").map((job) => job.id);
  const live = new Set(jobs.map((job) => job.id));
  for (const id of memory.keys()) if (!live.has(id)) memory.delete(id);

  const rows = plugins.flatMap((plugin): PendingUpdate[] => {
    const available = plugin.updateState.availableVersion || null;
    const latest = jobs.filter((job) => job.pluginId === plugin.id).at(-1) ?? null;
    // A finished job says nothing about an update that is waiting now, unless it failed on the way there.
    const job = latest === null || (available !== null && !isActive(latest) && !isFailure(latest)) ? null : latest;
    if (available === null && job === null) return [];

    const result = results.find((entry) => entry.id === plugin.id);
    let labels: VersionLabels;
    if (available !== null) {
      labels = {
        installed: { version: result?.installed.version ?? plugin.version, label: packageLabel(plugin.version) },
        candidate: {
          version: available,
          label: versionLabel(available, result?.candidate?.version === available ? result.candidate.display : null),
        },
      };
      if (job !== null) memory.set(job.id, labels);
    } else {
      labels = memory.get(job!.id) ?? labelsWithoutUpdate(job!, plugin, result);
    }

    const failure = plugin.updateState.lastFailure;
    const imageUrl = plugin.logoUrl ?? plugin.iconUrl;
    return [
      {
        id: plugin.id,
        name: plugin.name ?? plugin.id,
        icon: imageUrl === null && plugin.icon !== null && /^[A-Za-z0-9_/-]+$/u.test(plugin.icon) ? plugin.icon : null,
        imageUrl,
        ...labels,
        updateAvailable: available !== null,
        lastFailure:
          available === null || failure === undefined
            ? null
            : failure.detail || `The update to ${versionLabel(failure.version, null)} was rolled back.`,
        job: job === null ? null : toJob(job, queue),
      },
    ];
  });
  return rows.sort((left, right) => rank(left) - rank(right) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

function toJob(job: UpdateJobLike, queue: readonly string[]): UpdateJob {
  const rolledBack = job.result?.outcome === "rolled-back";
  return {
    id: job.id,
    state: job.state,
    phase: job.state === "running" && PHASES.has(job.phase ?? "") ? (job.phase as UpdatePhase) : null,
    queuePosition: job.state === "queued" ? queue.indexOf(job.id) + 1 : null,
    outcome: job.state === "completed" ? (job.result?.outcome ?? null) : null,
    error:
      job.state === "failed"
        ? job.error || "The update failed."
        : rolledBack
          ? job.result?.detail || "The new version failed its check, so bb restored the previous one."
          : null,
  };
}

/** Versions for a job bb no longer describes as a waiting update: from its result, or from the last check. */
function labelsWithoutUpdate(job: UpdateJobLike, plugin: InstalledPluginLike, result: UpdateResultLike | undefined): VersionLabels {
  if (job.result !== undefined) {
    const to = job.result.to ?? job.result.from;
    return { installed: resolvedLabel(job.result.from), candidate: resolvedLabel(to) };
  }
  return {
    installed: result !== undefined ? resolvedLabel(result.installed) : { version: plugin.version, label: packageLabel(plugin.version) },
    candidate: result?.candidate !== undefined ? resolvedLabel(result.candidate) : { version: "", label: "new version" },
  };
}

const resolvedLabel = (resolved: ResolvedVersionLike) => ({ version: resolved.version, label: versionLabel(resolved.version, resolved.display) });

const packageLabel = (version: string) => (isCommit(version) ? shortCommit(version) : version);

function rank(row: PendingUpdate): number {
  if (row.job?.state === "running") return 0;
  if (row.job?.state === "queued") return 1 + (row.job.queuePosition ?? 0) / 1000;
  return row.updateAvailable ? 2 : 3;
}
