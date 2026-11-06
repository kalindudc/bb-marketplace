// The forge's after_open and after_push commands: run once per pull request and once per push, recorded before they run
// so a retry never repeats one.
import { hostCallTransient } from "./forge-waits";
import { AFTER_OPEN_ENDED, AFTER_OPEN_MS, AFTER_OPEN_STARTED } from "./drafts";
import { andList, clip } from "./prompts";
import { prNumber } from "./host-contract";
import type { RepoSettings } from "./repos";
import { LOOM_ACTOR } from "./states";
import { type EngineCtx } from "./ctx";
import { errText } from "./merge-common";

/** A forge hook's run: where, for which pull request and ticket, and the branches its LOOM_HEAD and LOOM_BASE name. */
type HookArgs = { hostId: string; repo: string; settings: RepoSettings; head: string; base: string; url: string; projectId: number; ticketId: number | null };

/** Runs the forge's after_open commands once a pull request is open; LOOM_BASE is the branch it opened on. */
export async function afterOpen(ctx: EngineCtx, a: HookArgs): Promise<void> {
  const commands = a.settings.forge.after_open ?? [];
  if (a.ticketId === null || commands.length === 0) return forgeHooks(ctx, a, "after_open", commands, {});
  // Recorded before the first await, in the same stretch as the open, so no read marks the pull request ready while they run.
  ctx.store.event(a.projectId, a.ticketId, AFTER_OPEN_STARTED, LOOM_ACTOR, { url: a.url, commands: commands.length });
  try {
    await forgeHooks(ctx, a, "after_open", commands, {});
  } finally {
    ctx.store.event(a.projectId, a.ticketId, AFTER_OPEN_ENDED, LOOM_ACTOR, { url: a.url });
  }
}

/** What an after_push run was for, as its event records it. */
type PushRun = { sha?: string; url?: string; base?: string; pushed?: boolean; moved?: boolean };

/**
 * Runs the forge's after_push commands once Loom pushed to an open pull request, such as a fix round's, a catch-up's or a
 * land's, or moved one to another base (`moved`), such as to start its CI again or mark it ready; LOOM_BASE is the branch
 * it builds on now. A push and a move in one step run them once. They run at most once per push and once per move: the
 * event recorded before the commands run says what they ran for, so a merge that runs again after a failure, and pushes
 * the same commit or moves the pull request to the same base again, runs none for what they already ran for. With
 * neither a new push nor a move, nothing runs.
 */
export async function afterPush(ctx: EngineCtx, a: HookArgs & { sha: string; pushed: boolean; moved: boolean }): Promise<void> {
  const commands = a.settings.forge.after_push ?? [];
  if (commands.length === 0) return;
  const kind = a.ticketId === null ? "project.after_push" : "ticket.after_push";
  const events = a.ticketId === null ? ctx.store.projectEvents(a.projectId).filter((event) => event.kind === kind) : ctx.store.ticketEvents(a.ticketId, [kind]);
  const runs = events.map((event) => JSON.parse(event.data_json) as PushRun).filter((run) => run.url === a.url && run.sha === a.sha);
  const pushed = a.pushed && !runs.some((run) => run.pushed !== false);
  const moved = a.moved && !runs.some((run) => run.moved === true && run.base === a.base);
  if (!pushed && !moved) return;
  ctx.store.event(a.projectId, a.ticketId, kind, LOOM_ACTOR, { sha: a.sha, url: a.url, branch: a.head, base: a.base, pushed, moved } satisfies PushRun & { branch: string });
  await forgeHooks(ctx, a, "after_push", commands, { LOOM_SHA: a.sha }, pushed);
}

/**
 * Runs a forge's after_open or after_push commands. A failure is posted and blocks nothing: the pull request stays as it
 * is, and no command runs again, since a second run could repeat what the first did, such as starting CI. A host call
 * that got no answer stops the rest, which would not get one either, in the same post.
 */
async function forgeHooks(ctx: EngineCtx, a: HookArgs, hook: "after_open" | "after_push", commands: readonly string[], more: Record<string, string>, pushed = false): Promise<void> {
  for (const [index, command] of commands.entries()) {
    let problem: string | null;
    let rest: string[] = [];
    try {
      const env = { LOOM_URL: a.url, LOOM_PR_NUMBER: prNumber(a.url), LOOM_HEAD: a.head, LOOM_BASE: a.base, ...more };
      const result = await ctx.host.call(a.hostId, "exec", { cwd: a.repo, command, timeoutMs: AFTER_OPEN_MS, env });
      const output = result.output.trim() === "" ? "" : `\n\n${clip(result.output.slice(-2000), 2000)}`;
      problem = result.timedOut ? `timed out after ${AFTER_OPEN_MS / 60_000} minutes${output}` : result.exitCode !== 0 ? `failed (exit ${result.exitCode})${output}` : null;
    } catch (error) {
      if (hostCallTransient(error) === null) problem = `could not run: ${errText(error)}`;
      else {
        rest = commands.slice(index + 1);
        problem = `got no answer from the project's machine, so Loom cannot tell whether it ran, and does not run it again: ${errText(error)}`;
      }
    }
    if (problem === null) continue;
    const skipped = rest.length === 0 ? "" : ` Loom did not run ${andList(rest.map((each) => `\`${each}\``))} after it either.`;
    const state = hook === "after_open" ? "is open" : pushed ? "has the push" : `builds on ${a.base}`;
    const body = `The ${hook} command \`${command}\` ${problem}${skipped}\n\nThe pull request ${a.url} ${state}; nothing else changed.`;
    const data = { outcome: `${hook}_failed`, command, url: a.url };
    // A land's pull request belongs to no ticket, so its failure is an event and a log line instead of a post.
    if (a.ticketId === null) {
      ctx.store.event(a.projectId, null, `project.${hook}_failed`, LOOM_ACTOR, data);
      ctx.bb.log("warn", body);
    } else {
      ctx.store.addPost({ project_id: a.projectId, ticket_id: a.ticketId, parent_id: null, author_kind: "loom", author_thread_id: null, kind: "merge", body, data_json: JSON.stringify(data) });
    }
    ctx.store.changed(a.projectId);
    if (rest.length > 0) return;
  }
}

