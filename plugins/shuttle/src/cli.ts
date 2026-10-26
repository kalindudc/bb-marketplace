import { PluginCliError, cliCommand, defineCli, type PluginCliRegistration, type PluginCliResult } from "@get-bb/plugin-sdk";
import { readFile } from "node:fs/promises";
import { AGENT_MODES, AREAS, type AgentMode, type Area } from "./contract";
import { errText } from "./ctx";
import { prDetail, prList, serverText } from "./format";
import type { Shuttle } from "./shuttle";

const json = { type: "boolean", description: "Print machine-readable JSON." } as const;
const thread = { type: "string", description: "The thread id; the calling thread by default." } as const;
const PR = { name: "pr", description: "A PR link, or a key such as github:owner/repo#123.", required: true } as const;
const out = (stdout: string): PluginCliResult => ({ exitCode: 0, stdout: stdout.endsWith("\n") ? stdout : `${stdout}\n` });
const toJson = (value: unknown) => JSON.stringify(value, null, 2);
const LISTS = ["inbox", ...AREAS] as const;
const countsText = (counts: Record<string, number>) => LISTS.map((l) => `${l} ${counts[l]}`).join(", ");

async function guarded(fn: () => Promise<PluginCliResult> | PluginCliResult): Promise<PluginCliResult> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof PluginCliError) throw error;
    throw new PluginCliError(errText(error));
  }
}

function threadOf(option: string | undefined, ctx: { threadId?: string }): string {
  const id = option ?? ctx.threadId;
  if (!id) throw new PluginCliError("No thread: run this inside a thread or pass --thread <id>.");
  return id;
}

export function createCli(shuttle: Shuttle): PluginCliRegistration {
  return defineCli({
    name: "shuttle",
    summary: "Your pull requests and review requests on every server, linked to the threads that own them (Shuttle)",
    commands: {
      status: cliCommand({
        summary: "Show each server's sync status and the count of every list",
        options: { json },
        run: ({ options }) =>
          guarded(() => {
            const overview = shuttle.overview();
            if (options.json) return out(toJson(overview));
            const servers = overview.servers.map((s) => serverText(s));
            return out([...servers, countsText(overview.counts), overview.paused ? "automations are paused" : "", overview.autoAgent ? "auto agent is on" : ""].filter(Boolean).join("\n"));
          }),
      }),
      list: cliCommand({
        summary: `List the PRs of one area: ${LISTS.join(", ")} (inbox by default)`,
        options: { area: { type: "string", description: `One of ${LISTS.join(", ")}.` }, json },
        run: ({ options }) =>
          guarded(() => {
            const area = options.area ?? "inbox";
            if (!(LISTS as readonly string[]).includes(area)) throw new PluginCliError(`--area must be one of ${LISTS.join(", ")}`);
            const prs = area === "inbox" ? shuttle.inbox().prs : shuttle.list(area as Area);
            return out(options.json ? toJson(prs) : prList(prs, area === "inbox" ? "Nothing waits on you." : `Nothing in ${area}.`));
          }),
      }),
      search: cliCommand({
        summary: "Find PRs Shuttle already has by words in their title, repository, number, author, branches or labels",
        positionals: [{ name: "words", description: "Every word must match; #123 is a PR number.", required: true, variadic: true }],
        options: { json },
        run: ({ options, positionals }) =>
          guarded(() => {
            const query = positionals.words.join(" ");
            const { prs, total } = shuttle.search(query);
            if (options.json) return out(toJson({ prs, total }));
            const more = total > prs.length ? `\n${total - prs.length} more match; add a word to narrow it down.` : "";
            return out(prList(prs, `No PR Shuttle has matches \u201c${query}\u201d.`) + more);
          }),
      }),
      show: cliCommand({
        summary: "Show one PR, fetched fresh from its server, with its threads and recent Shuttle activity",
        positionals: [PR],
        options: { json },
        run: ({ options, positionals }) =>
          guarded(async () => {
            const view = await shuttle.lookup(positionals.pr);
            const detail = shuttle.detail(view.key);
            return out(options.json ? toJson(detail) : prDetail(detail.pr, detail.events));
          }),
      }),
      link: cliCommand({
        summary: "Link a PR to a thread (the calling thread by default); a thread can own several PRs",
        positionals: [PR],
        options: { thread, role: { type: "string", description: "owner (default), review or reference." }, json },
        run: ({ options, positionals }, ctx) =>
          guarded(async () => {
            const role = (options.role ?? "owner") as "owner" | "review" | "reference";
            if (!["owner", "review", "reference"].includes(role)) throw new PluginCliError("--role must be owner, review or reference");
            const view = await shuttle.link(positionals.pr, threadOf(options.thread, ctx), role);
            return out(options.json ? toJson(view) : prDetail(view));
          }),
      }),
      unlink: cliCommand({
        summary: "Remove a PR's link to a thread (the calling thread by default)",
        positionals: [PR],
        options: { thread, json },
        run: ({ options, positionals }, ctx) =>
          guarded(async () => {
            const view = await shuttle.unlink(positionals.pr, threadOf(options.thread, ctx));
            return out(options.json ? toJson(view) : prDetail(view));
          }),
      }),
      agent: cliCommand({
        summary: "Set a PR's agent, the thread that gets its new reviews and failed checks: --thread <id>, --new or --none, and what it does with --mode",
        positionals: [PR],
        options: {
          thread: { type: "string", description: "The thread to make the agent." },
          new: { type: "boolean", description: "Start a new thread for the PR as its agent." },
          none: { type: "boolean", description: "No agent; its thread stays linked for reference." },
          mode: { type: "string", description: `${AGENT_MODES.join(", ")}: fix asks it to fix new feedback, notify only sends it.` },
          json,
        },
        run: ({ options, positionals }) =>
          guarded(async () => {
            const mode = options.mode as AgentMode | undefined;
            if (mode !== undefined && !AGENT_MODES.includes(mode)) throw new PluginCliError(`--mode must be one of ${AGENT_MODES.join(", ")}`);
            const targets = [options.thread !== undefined, options.new === true, options.none === true].filter(Boolean).length;
            if (targets > 1) throw new PluginCliError("Pass one of --thread, --new and --none");
            const known = await shuttle.lookup(positionals.pr);
            let view;
            if (targets === 0) {
              if (!mode) throw new PluginCliError("Pass --thread, --new, --none or --mode");
              view = await shuttle.setAgentMode(known.key, mode);
            } else {
              const target = options.none ? { kind: "none" as const } : options.new ? { kind: "new" as const } : { kind: "existing" as const, threadId: options.thread! };
              view = (await shuttle.setAgent(known.key, target, mode)).pr;
            }
            return out(options.json ? toJson(view) : prDetail(view));
          }),
      }),
      track: cliCommand({
        summary: "Track someone else's PR so it stays in Reviews and comes to the Inbox when it changes after your review, or stop with --off",
        positionals: [PR],
        options: { off: { type: "boolean", description: "Stop tracking." }, json },
        run: ({ options, positionals }) =>
          guarded(async () => {
            const known = await shuttle.lookup(positionals.pr);
            const view = shuttle.track(known.key, options.off !== true);
            return out(options.json ? toJson(view) : prDetail(view));
          }),
      }),
      watch: cliCommand({
        summary: "Set what a PR's agent does with new feedback: act (fix it) or forward (just tell it), or stop with --off; `agent` does the same with more choices",
        positionals: [PR],
        options: { mode: { type: "string", description: "act (default: send and ask the thread to act) or forward (send only)." }, off: { type: "boolean", description: "Stop watching." }, json },
        run: ({ options, positionals }) =>
          guarded(async () => {
            const mode = options.off ? null : ((options.mode ?? "act") as "act" | "forward");
            if (mode !== null && mode !== "act" && mode !== "forward") throw new PluginCliError("--mode must be act or forward");
            const known = await shuttle.lookup(positionals.pr);
            const view = shuttle.watch(known.key, mode);
            return out(options.json ? toJson(view) : prDetail(view));
          }),
      }),
      review: cliCommand({
        summary: "Start a review thread for a PR with a preset (the default preset by default)",
        positionals: [PR],
        options: {
          preset: { type: "string", description: "A preset id." },
          project: { type: "string", description: "The bb project for a new thread; matched from the repository by default." },
          note: { type: "string", description: "A note for the reviewer." },
          "new-thread": { type: "boolean", description: "Start a new thread even when the PR has a review thread of Shuttle's to bring back." },
          json,
        },
        run: ({ options, positionals }) =>
          guarded(async () => {
            const known = await shuttle.lookup(positionals.pr);
            const result = await shuttle.review({
              key: known.key,
              ...(options.preset ? { presetId: options.preset } : {}),
              ...(options.project ? { projectId: options.project } : {}),
              ...(options.note ? { note: options.note } : {}),
              ...(options["new-thread"] ? { newThread: true } : {}),
            });
            if (options.json) return out(toJson(result));
            return out(result.revived ? `Brought review thread ${result.threadId} back from the archive for ${known.key}.` : `Started the review of ${known.key} in thread ${result.threadId}.`);
          }),
      }),
      sync: cliCommand({
        summary: "Sync every server now, or one with --server, run due auto reviews and check watched PRs",
        options: { server: { type: "string", description: "Only this server, by id." }, json },
        run: ({ options }) =>
          guarded(async () => {
            await shuttle.sync(undefined, options.server === undefined ? undefined : [options.server]);
            const overview = shuttle.overview();
            if (options.json) return out(toJson(overview));
            const synced = overview.servers.filter((s) => s.enabled && (options.server === undefined || s.id === options.server));
            const failing = synced.filter((s) => s.state !== "ok");
            return out([failing.length === 0 ? "Synced." : "Synced, with failures:", ...failing.map((s) => serverText(s)), countsText(overview.counts)].join("\n"));
          }),
      }),
      "config-export": cliCommand({
        summary: "Print Shuttle's servers, presets and automations as TOML",
        run: () => guarded(() => out(shuttle.exportToml())),
      }),
      "config-import": cliCommand({
        summary: "Read servers, presets and automations from a TOML file; prints the changes, and saves them with --apply",
        positionals: [{ name: "file", description: "The TOML file.", required: true }],
        options: { apply: { type: "boolean", description: "Save the changes." } },
        run: ({ options, positionals }) =>
          guarded(async () => {
            const result = shuttle.importToml(await readFile(positionals.file, "utf8"), options.apply === true);
            const list = result.changes.length ? result.changes.map((c) => `- ${c}`).join("\n") : "No changes.";
            return out(`${list}\n${options.apply ? "Saved." : "Nothing saved; run again with --apply to save."}`);
          }),
      }),
    },
  });
}
