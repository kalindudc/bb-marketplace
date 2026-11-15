import Sqlite from "better-sqlite3";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export function makeHost(metadata: Record<string, unknown> = {}, legacyEnabled = false) {
  const db = new Sqlite(":memory:");
  const mirrors: unknown[] = [], sent: unknown[] = [], warnings: string[] = [], infos: string[] = [];
  const listeners = new Map<string, ((payload: any) => unknown)[]>();
  const disposal: (() => unknown)[] = [];
  const tools = new Map<string, any>();
  const threads = new Map<string, any>();
  let eventRows: any[] = [];
  const bb = {
    pluginId: "tavern",
    storage: { database: () => db, migrate: (_db: unknown, statements: string[]) => db.exec(statements.join("\n")) },
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => threads.get(threadId) ?? { id: threadId, status: "active", originKind: null, originPluginId: null, sourceThreadId: null },
        getPluginMetadata: async () => metadata,
        updatePluginMetadata: async (args: unknown) => { mirrors.push(args); return {}; },
        send: async (args: unknown) => { sent.push(args); return {}; },
        events: { list: async (args: any) => eventRows.filter(e => args.types.includes(e.type) && (args.afterSeq === undefined || e.seq > Number(args.afterSeq))).sort((a, b) => args.order === "desc" ? b.seq - a.seq : a.seq - b.seq).slice(0, Number(args.limit)) },
      },
      plugins: { list: async () => ({ plugins: legacyEnabled ? [{ id: "pi-quests", enabled: true }] : [] }) },
    },
    agents: { registerTool: (tool: any) => tools.set(tool.name, tool) },
    events: { on: (name: string, fn: (payload: any) => unknown) => { listeners.set(name, [...(listeners.get(name) ?? []), fn]); return () => listeners.set(name, listeners.get(name)!.filter(x => x !== fn)); } },
    log: { warn: (msg: string) => warnings.push(msg), info: (msg: string) => infos.push(msg) },
    onDispose: (fn: () => unknown) => disposal.push(fn),
  } as unknown as BbPluginApi;
  return { bb, db, mirrors, sent, warnings, infos, tools, threads,
    setEvents: (rows: any[]) => { eventRows = rows; },
    emit: async (name: string, payload: unknown) => { for (const fn of listeners.get(name) ?? []) await fn(payload); },
    dispose: async () => { for (const fn of disposal.reverse()) await fn(); db.close(); },
  };
}
