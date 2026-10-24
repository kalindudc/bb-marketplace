import { PluginCliError, cliCommand, defineCli, type PluginCliRegistration, type PluginCliResult } from "@get-bb/plugin-sdk";
import { readFile } from "node:fs/promises";
import { SECTIONS, type Section } from "./contract";
import { errText } from "./ctx";
import { prDetail, prList } from "./format";
import type { Shuttle } from "./shuttle";

const json = { type: "boolean", description: "Print machine-readable JSON." } as const;
const thread = { type: "string", description: "The thread id; the calling thread by default." } as const;
const PR = { name: "pr", description: "A PR link, or a key such as github:owner/repo#123.", required: true } as const;
const out = (stdout: string): PluginCliResult => ({ exitCode: 0, stdout: stdout.endsWith("\n") ? stdout : `${stdout}\n` });
const toJson = (value: unknown) => JSON.stringify(value, null, 2);

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
            const servers = overview.servers.map((s) => `${s.id}  ${!s.enabled ? "off" : s.ok === null ? "not synced yet" : s.ok ? `ok as ${s.login}` : `failing: ${s.error}`}`);
            const counts = SECTIONS.map((s) => `${s} ${overview.counts[s]}`).join(", ");
            return out([...servers, counts, overview.paused ? "automations are paused" : ""].filter(Boolean).join("\n"));
          }),
      }),
      list: cliCommand({
        summary: `List the PRs of one section: ${SECTIONS.join(", ")} (needs by default)`,
        options: { section: { type: "string", description: `One of ${SECTIONS.join(", ")}.` }, json },
        run: ({ options }) =>
          guarded(() => {
            const section = (options.section ?? "needs") as Section;
            if (!SECTIONS.includes(section)) throw new PluginCliError(`--section must be one of ${SECTIONS.join(", ")}`);
            const prs = shuttle.list(section);
            return out(options.json ? toJson(prs) : prList(prs, `Nothing in ${section}.`));
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
      watch: cliCommand({
        summary: "Watch a PR so new reviews go to its owner threads, or stop with --off",
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
        options: { preset: { type: "string", description: "A preset id." }, project: { type: "string", description: "The bb project for the thread; matched from the repository by default." }, note: { type: "string", description: "A note for the reviewer." }, json },
        run: ({ options, positionals }) =>
          guarded(async () => {
            const known = await shuttle.lookup(positionals.pr);
            const threadId = await shuttle.review({ key: known.key, ...(options.preset ? { presetId: options.preset } : {}), ...(options.project ? { projectId: options.project } : {}), ...(options.note ? { note: options.note } : {}) });
            return out(options.json ? toJson({ threadId }) : `Started review thread ${threadId} for ${known.key}.`);
          }),
      }),
      sync: cliCommand({
        summary: "Sync every server now, run due auto reviews and check watched PRs",
        options: { json },
        run: ({ options }) =>
          guarded(async () => {
            await shuttle.sync();
            const overview = shuttle.overview();
            return out(options.json ? toJson(overview) : `Synced. ${SECTIONS.map((s) => `${s} ${overview.counts[s]}`).join(", ")}`);
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
