// Where each repo of a Loom project is checked out on the project's machine.
import type { ProjectRow, TicketRow } from "./db/store";
import type { BbPort } from "./ports";
import { LoomError } from "./projects";
import { repoSettings, type RepoSettings } from "./repos";
import type { Spec } from "./spec";

export interface RepoCheckout {
  hostId: string;
  bbProjectId: string;
  path: string;
  settings: RepoSettings;
}

export function ticketRepo(spec: Spec, ticket: Pick<TicketRow, "repo">): RepoSettings {
  return repoSettings(spec, ticket.repo);
}

/** The checkout of repo `name` on the project's machine; a null name is the Loom project's own repository. Throws loom_no_checkout when there is none. */
export async function repoCheckout(ctx: { bb: BbPort }, project: ProjectRow, spec: Spec, name: string | null): Promise<RepoCheckout> {
  const settings = repoSettings(spec, name);
  const bbProjectId = settings.bbProjectId ?? project.bb_project_id;
  const hostId = project.host_id;
  const path = hostId === null ? null : await ctx.bb.projectCheckout(bbProjectId, hostId);
  if (hostId === null || path === null) {
    const repo = name === null ? "The project's repository" : `Repo "${name}"`;
    const machine = hostId ?? "<machine>";
    throw new LoomError(
      "loom_no_checkout",
      `${repo} (bb project ${bbProjectId}) has no checkout on the machine ${hostId ?? "(unknown)"} that this Loom project uses. Clone it there with \`bb project source add ${bbProjectId} --clone --machine ${machine}\`, then resume.`,
    );
  }
  return { hostId, bbProjectId, path, settings };
}
