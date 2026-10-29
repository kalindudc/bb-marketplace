import { PluginCliError, cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, hostSignals } from "./src/contract";
import { BROWSERS } from "./src/browsers";
import { createEngine, type HostCall } from "./src/engine";
import { createHandoffSessions } from "./src/handoff";
import { STATUS_CHANNEL, rpcContract, type Status } from "./src/rpc";
import { parsePattern } from "./src/signin";

export { rpcContract };

function describeStatus(status: Status): string {
  const lines = [
    `Browser:   ${status.browser ? `${status.browser.name}${status.profile ? ` (profile ${status.profile})` : ""}` : "none found"}`,
  ];
  if (!status.supported) lines.push("Sessions:  sync works on macOS and Linux");
  if (status.syncing) lines.push("Sessions:  syncing now");
  if (status.lastSync) {
    const sync = status.lastSync;
    lines.push(
      `Last sync: ${new Date(sync.at).toLocaleString()} (${sync.reason}) — ${sync.status === "unchanged" ? "nothing new" : `${sync.set} set, ${sync.removed} removed${sync.rejected ? `, ${sync.rejected} refused by bb` : ""}`}, ${sync.cookies} cookies in the profile${sync.undecryptable ? `, ${sync.undecryptable} unreadable` : ""}`,
    );
  } else {
    lines.push("Last sync: never");
  }
  if (status.error) lines.push(`Problem:   ${status.error.message} [${status.error.code}]`);
  return lines.join("\n");
}

export default function betterBrowser(bb: BbPluginApi): void {
  const settings = bb.settings.define({
    browser: {
      type: "select",
      label: "Browser",
      description: "Choose a browser installed on this computer, or follow your system default. Safari opens links only.",
      options: ["system", ...BROWSERS.map((browser) => browser.id)],
      experimental_optionLabels: { system: "System default", ...Object.fromEntries(BROWSERS.map((browser) => [browser.id, browser.name])) },
      default: "system",
    },
    sync: {
      type: "boolean",
      label: "Keep sessions in sync",
      description: "Copy signed-in sessions from your browser while bb's Browser is open.",
      default: true,
    },
    signIn: {
      type: "select",
      label: "Sign-in handoff",
      description: "Finish sign-ins that need passkeys or device verification in your real browser.",
      options: ["automatic", "ask", "off"],
      experimental_optionLabels: { automatic: "Automatic", ask: "Ask first", off: "Off" },
      default: "automatic",
    },
    modifierClick: {
      type: "boolean",
      label: "Cmd/Ctrl-click opens your browser",
      description: "Open links externally with Cmd+click on macOS or Ctrl+click elsewhere.",
      default: true,
    },
    profile: {
      type: "string",
      label: "Profile override (optional)",
      description: "Leave blank to follow the browser's last-used profile. Otherwise enter a profile directory, such as Default or Profile 1.",
      experimental_schema: z.string().max(4096),
      default: "",
    },
    signInPages: {
      type: "string",
      label: "Additional sign-in sites (optional)",
      description: "Only needed for sites not detected automatically. One host or path pattern per line, such as login.example.com or example.com/login.",
      experimental_multiline: true,
      experimental_schema: z.string().max(8192).refine(
        (text) => text.split(/\r?\n/).every((line) => !line.trim() || line.trim().startsWith("#") || parsePattern(line) !== null),
        "Each line needs a host such as *.example.com or example.com/login",
      ),
      default: "",
    },
  });

  const client = bb.hosts.experimental_client({ contract: hostContract, experimental_signals: hostSignals });
  const host: HostCall = (method, input, options) => client.call(method, input, options);
  const engine = createEngine({
    desktops: {
      listInstances: (input) => bb.sdk.experimental_desktopBrowsers.listInstances(input),
      createTab: (input) => bb.sdk.experimental_desktopBrowsers.createTab(input),
      acquireControl: (input) => bb.sdk.experimental_desktopBrowsers.acquireControl(input),
      openConnection: (input) => bb.sdk.experimental_desktopBrowsers.openConnection(input),
      releaseControl: (input) => bb.sdk.experimental_desktopBrowsers.releaseControl(input),
      closeTab: (input) => bb.sdk.experimental_desktopBrowsers.closeTab(input),
    },
    listHosts: () => bb.sdk.hosts.list(),
    host,
    settings: async () => {
      const values = await settings.get();
      return { browser: values.browser === "system" ? "" : values.browser, profile: values.profile, sync: values.sync };
    },
    publish: (status) => bb.realtime.publish(STATUS_CHANNEL, status),
    log: bb.log,
    now: () => Date.now(),
    setTimer: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
  });
  const handoffs = createHandoffSessions(() => Date.now());
  bb.onDispose(() => {
    handoffs.clear();
    return engine.dispose();
  });

  client.experimental_onSignal("changed", () => engine.sourceChanged());
  client.experimental_onWorkerExit(() => engine.workerExited());
  settings.onChange((next, previous) => {
    if (next.browser !== previous.browser || next.profile !== previous.profile || next.sync !== previous.sync) engine.settingsChanged();
  });

  bb.rpc.register(rpcContract, {
    status: () => engine.refreshStatus(),
    browsers: () => engine.browsers(),
    async choose({ browserId, profile }) {
      await settings.experimental_set({ browser: browserId === "" ? "system" : browserId, profile });
      return engine.refreshStatus();
    },
    heartbeat: ({ threadId, tabId }) => engine.heartbeat(threadId, tabId),
    handoff: (input) => {
      const result = handoffs.advance(input);
      if (result.effects.length > 0) {
        bb.log.info(`handoff ${JSON.stringify({ threadId: input.threadId, tabId: input.tabId, event: input.event.type, phase: result.episode.phase.kind, effects: result.effects.map((effect) => effect.kind) })}`);
      }
      return result;
    },
    sync: ({ threadId, mode, reason }) => engine.syncNow(mode, reason, threadId),
    openExternal: ({ url }) => {
      if (!/^https?:\/\//i.test(url)) return { ok: false as const, message: "Only http and https links open externally" };
      return engine.openExternal(url);
    },
  });

  bb.cli.register(defineCli({
    name: "better-browser",
    summary: "Sync bb's Browser with your real browser and open links there",
    commands: {
      status: cliCommand({
        summary: "Show the browser bb follows and the last session sync",
        options: { json: { type: "boolean", description: "Print JSON" } },
        async run({ options }) {
          const status = await engine.refreshStatus();
          return { exitCode: 0, stdout: options.json ? JSON.stringify(status, null, 2) : describeStatus(status) };
        },
      }),
      browsers: cliCommand({
        summary: "List the browsers and profiles on the machine running the bb app",
        options: { json: { type: "boolean", description: "Print JSON" } },
        async run({ options }) {
          const list = await engine.browsers();
          if (options.json) return { exitCode: 0, stdout: JSON.stringify(list, null, 2) };
          const rows = list.browsers.filter((browser) => browser.installed).map((browser) => {
            const profiles = browser.profiles.map((profile) => `${profile.directory}${profile.name !== profile.directory ? ` (${profile.name})` : ""}${profile.directory === browser.lastUsedProfile ? " *" : ""}`);
            const tag = browser.id === list.defaultBrowserId ? " [default]" : "";
            return `${browser.id.padEnd(10)} ${browser.name}${tag}${browser.syncable ? `: ${profiles.join(", ") || "no profiles with cookies"}` : ": links only"}`;
          });
          return { exitCode: 0, stdout: [...rows, "", "* the profile the browser used last"].join("\n") };
        },
      }),
      sync: cliCommand({
        summary: "Sync sessions into bb's Browser now",
        options: {
          full: { type: "boolean", description: "Write every cookie bb does not already hold, not only what changed" },
          thread: { type: "string", description: "Thread whose Browser runs the sync; defaults to this thread or the last Browser tab used" },
          json: { type: "boolean", description: "Print JSON" },
        },
        async run({ options }, context) {
          const status = await engine.syncNow(options.full ? "full" : "changes", "manual", options.thread ?? context.threadId);
          return { exitCode: status.error && (status.lastSync?.at ?? 0) < status.error.at ? 1 : 0, stdout: options.json ? JSON.stringify(status, null, 2) : describeStatus(status) };
        },
      }),
      open: cliCommand({
        summary: "Open a link in the browser bb follows",
        positionals: [{ name: "url", description: "An http or https link", required: true }],
        async run({ positionals }) {
          const url = positionals.url;
          if (!url || !/^https?:\/\//i.test(url)) throw new PluginCliError("Give an http or https link", { code: "invalid_url" });
          const opened = await engine.openExternal(url);
          if (!opened.ok) throw new PluginCliError(opened.message, { code: "open_failed" });
          return { exitCode: 0, stdout: `Opened in ${opened.browser}` };
        },
      }),
    },
  }));
}
