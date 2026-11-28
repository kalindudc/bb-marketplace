// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import extension, { type PiGuardApi } from "../../adapters/pi/extension";
import { scopeForClass } from "../../src/scope/presets";
import { ScopeStore } from "../../src/scope/store";
import { Registry } from "../../src/server/registry";
import type { Scope } from "../../src/scope/schema";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const source = fileURLToPath(new URL("../../", import.meta.url));
const registry = new Registry(source, source);
const available = ["read", "edit", "write", "bash", "codemode", "journal", "tavern_status", "tavern_report", "tavern_request_sources",
  "flare", "compaction_point", "ScheduleWakeup", "shuttle_link", "shuttle_prs", "shuttle_feedback_done", "cortex_note", "check_ui", "local_browser", "browser",
  "tg_search", "chat_read", "web_fetch", "web_search", "shuttle_boards", "AskUserQuestion", "ast_query", "list_minions",
  "spawn", "bb_workflow_run", "loom_discover", "study_propose", "unknown"];
const skillNames = ["journal", "quest-management", "tavern", "tavern-keeper", "cortex", "flare", "wakeup", "shuttle", "research", "my-voice", "house-style"];

function session(role: string, patch: Partial<Scope> = {}, tools = available) {
  const root = mkdtempSync(join(tmpdir(), "tavern-pi-prompt-")); roots.push(root);
  const repo = join(root, "repo"); mkdirSync(join(repo, ".git"), { recursive: true });
  const store = new ScopeStore(root), thread = "thread", file = store.file(thread);
  const definition = registry.read().classes.find(c => c.id === role)!;
  const base = scopeForClass(role);
  const scope = store.write(thread, { ...base, role, preset: "open", writes: { mode: "any", allow: [], deny: [] }, piLoadout: registry.piLoadout(definition, base.preset), ...patch });
  vi.stubEnv("TAVERN_SCOPE_FILE", file);
  vi.stubEnv("BB_THREAD_ID", thread);
  const handlers = new Map<string, Parameters<PiGuardApi["on"]>[1]>();
  let active = [...tools];
  const setActiveTools = vi.fn((names: string[]) => { active = names; });
  const pi = { on: (name: string, fn: Parameters<PiGuardApi["on"]>[1]) => handlers.set(name, fn), getActiveTools: () => active, getAllTools: () => tools.map(name => ({ name })), setActiveTools };
  extension(pi);
  const prompt = () => ({
    skills: skillNames.map(name => ({ name, description: `Details for ${name}`, filePath: `/skills/${name}/SKILL.md` })),
    contextFiles: [{ path: join(repo, "AGENTS.md") }, { path: join(root, "AGENTS.md") }, { path: join(repo, "sub/AGENTS.md") }],
    appendSystemPrompt: "Preserve shared system and authority instructions",
    selectedTools: [...active],
  });
  const emit = (name: string, input: Parameters<Parameters<PiGuardApi["on"]>[1]>[0] = {}) => handlers.get(name)?.(input, { cwd: repo });
  const turn = () => { const options = prompt(); emit("before_agent_start", { systemPromptOptions: options }); return options; };
  return { turn, emit, repo, file, scope, setActiveTools, active: () => active };
}
const blocked = { block: true, reason: expect.stringMatching(/^\[Tavern scope blocked\].*loadout/) };

it("keeps Keeper browsers without gateway defaults, preserves repository rules and indexes all skills", () => {
  const f = session("keeper");
  f.emit("session_start");
  const options = f.turn();
  expect(f.active()).toEqual(expect.arrayContaining(["local_browser", "browser", "tavern_status", "journal", "shuttle_link", "shuttle_prs", "shuttle_feedback_done", "cortex_note", "check_ui", "ScheduleWakeup"]));
  for (const tool of ["tg_search", "AskUserQuestion", "web_fetch", "shuttle_boards", "bb_workflow_run", "unknown"]) expect(f.active()).not.toContain(tool);
  expect(options.skills.map(({ name, filePath }) => [name, filePath])).toEqual(skillNames.map(name => [name, `/skills/${name}/SKILL.md`]));
  expect(options.skills.filter(skill => skill.description).map(skill => skill.name)).toEqual(skillNames.slice(0, 8));
  expect(options.contextFiles.map(file => file.path)).toContain(join(f.repo, "AGENTS.md"));
  expect(options.contextFiles).toHaveLength(3);
  expect(options.appendSystemPrompt).toBe("Preserve shared system and authority instructions");
});

it("keeps web search and fetch for Rangers, and keeps full descriptions for opted-in skills", () => {
  const ranger = registry.read().classes.find(c => c.id === "ranger")!;
  const f = session("ranger", { piLoadout: registry.piLoadout(ranger, "readonly", { skills: ["research"], tools: ["chat_read"] }) });
  f.emit("session_start");
  const options = f.turn();
  expect(f.active()).toEqual(expect.arrayContaining(["web_fetch", "web_search", "chat_read", "tavern_request_sources", "write"]));
  expect(options.skills.filter(skill => skill.description).map(skill => skill.name)).toEqual(["journal", "quest-management", "tavern", "research"]);
  expect(options.skills).toHaveLength(skillNames.length);
  expect(f.emit("tool_call", { toolName: "chat_read" })).toBeUndefined();
  expect(f.emit("tool_call", { toolName: "bash", input: { command: "kubectl delete pod demo" } })).toMatchObject({ block: true });
});

it("refuses an unknown named tool before executing the hire but accepts an installed hidden tool", () => {
  const f = session("keeper", {}, [...available, "tavern_hire"]);
  f.emit("session_start");
  expect(f.active()).not.toContain("chat_read");
  const hire = (tool: string) => f.emit("tool_call", { toolName: "tavern_hire", input: { loadout: { tools: [tool] } } });
  expect(hire("missing_fixture_tool")).toMatchObject({ block: true, reason: expect.stringMatching(/not hired.*missing_fixture_tool/i) });
  expect(hire("chat_read")).toBeUndefined();
});

it("uses a custom Keeper's resolved lists even without the hire tool", () => {
  const role = { ...registry.read().classes.find(c => c.id === "keeper")!, id: "guide", kind: "keeper" as const, piTools: undefined, piSkills: undefined };
  const f = session("keeper", { role: role.id, piLoadout: registry.piLoadout(role, "open") });
  f.emit("session_start");
  expect(f.active()).toContain("shuttle_link");
  expect(f.turn().skills.find(skill => skill.name === "tavern-keeper")?.description).toBeTruthy();
});

it("keeps the exact same prompt options and tool list across ordinary turns and a scope rewrite", () => {
  const f = session("smith");
  f.emit("session_start");
  const first = f.turn();
  expect(f.turn()).toEqual(first);
  writeFileSync(f.file, JSON.stringify({ ...f.scope, issuedAt: 99, mode: "watch", tools: { ...f.scope.tools, deny: ["web_fetch"] } }));
  expect(f.turn()).toEqual(first);
  writeFileSync(f.file, "{");
  expect(f.turn()).toEqual(first);
  expect(f.setActiveTools).toHaveBeenCalledTimes(1);
});

it.each(["enforce", "watch", "off"] as const)("refuses hidden tools even through a nested call when the act guard is %s", mode => {
  const f = session("warden", { mode });
  f.emit("session_start");
  expect(f.active()).toEqual(expect.arrayContaining(["bash", "codemode", "journal", "local_browser", "shuttle_prs"]));
  expect(f.active()).not.toContain("web_fetch");
  const call = { toolName: "web_fetch", toolCallId: "script-call/1", parentToolCallId: "script-call" };
  expect(f.emit("tool_call", call)).toMatchObject(blocked);
  writeFileSync(f.file, "{}");
  expect(f.emit("tool_call", call)).toMatchObject(blocked);
  expect(f.emit("tool_call", { toolName: "read" })).toBeUndefined();
});

it("intersects the class loadout with explicit tool restrictions in the scope", () => {
  const f = session("ranger", { tools: { allow: ["read", "write", "journal"], deny: ["write"], hide: true } });
  f.emit("session_start");
  expect(f.active()).toEqual(["read", "journal"]);
  expect(f.emit("tool_call", { toolName: "write" })).toMatchObject(blocked);
});
