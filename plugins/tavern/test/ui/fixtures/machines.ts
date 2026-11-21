import Database from "better-sqlite3";
import { roomSchema, type Room } from "../../../src/shared/contract";
import { memberSchema } from "../../../src/shared/schema";
import { placementSettingsSchema, type PlacementSettings } from "../../../src/shared/placement-settings";
import type { PlacementCatalog, PlacementPreview, PlacementPreviewInput } from "../../../src/ui/page/machines-contract";
import { placementHandlers } from "../../../src/server/placement/rpc";
import type { TavernRuntime } from "../../../src/server/runtime";
import { MIGRATIONS } from "../../../src/server/migrations";
import { DEFAULT_SETTINGS } from "../../../src/shared/settings";
import { registry } from "../../../src/ui/page/fixtures";
import { createFakePluginHost, makeThreadResponse } from "../../server/host";

// Example provider capabilities, Keepers and machine rules at three volumes.

export const machinesCatalog: PlacementCatalog = {"hostId":"host_test000001","environments":[{"id":"project-checkout","displayName":"Project checkout","description":"Work in a project checkout on this machine.","machineProviderId":null,"environmentProviderId":null,"inputs":{"type":"object","properties":{"path":{"type":"string","minLength":1},"branch":{"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"existing"},"name":{"type":"string","minLength":1}},"required":["kind","name"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"new"},"baseBranch":{"type":"string","minLength":1}},"required":["kind","baseBranch"],"additionalProperties":false}]}}},"acceptsEmptyInputs":true},{"id":"git-worktree","displayName":"Worktree","description":"Create an isolated Git worktree for your changes.","machineProviderId":null,"environmentProviderId":null,"inputs":{"default":{"branch":{"kind":"default"}},"anyOf":[{"type":"object","properties":{"kind":{"type":"string","const":"existing"},"path":{"type":"string","minLength":1}},"required":["kind","path"],"additionalProperties":false},{"type":"object","properties":{"branch":{"default":{"kind":"default"},"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"named"},"name":{"type":"string","minLength":1}},"required":["kind","name"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"default"}},"required":["kind"],"additionalProperties":false}]}},"additionalProperties":false}]},"acceptsEmptyInputs":true},{"id":"remote-monorepo-checkout","displayName":"Remote monorepo checkout","description":"An isolated monorepo checkout on the member machine.","machineProviderId":null,"environmentProviderId":null,"inputs":{"anyOf":[{"type":"object","properties":{"branch":{"type":"string","pattern":"^(?!-)(?!.*\\.\\.)(?!.*\\/\\/)(?!.*@\\{)(?!.*\\.lock$)(?!.*\\/$)(?!.*\\.$)[A-Za-z0-9._\\/-]{1,200}$"},"base":{"type":"string","pattern":"^(?!-)[A-Za-z0-9._\\/~^-]{1,200}$"},"fromLaptopBranch":{"type":"string","pattern":"^(?!-)(?!.*\\.\\.)(?!.*\\/\\/)(?!.*@\\{)(?!.*\\.lock$)(?!.*\\/$)(?!.*\\.$)[A-Za-z0-9._\\/-]{1,200}$"}},"additionalProperties":false},{"type":"null"}]},"acceptsEmptyInputs":true},{"id":"personal-workspace","displayName":"Personal workspace","description":"Create a personal directory without a project.","machineProviderId":null,"environmentProviderId":null,"inputs":null,"acceptsEmptyInputs":true},{"id":"workspace-tree","displayName":"Workspace tree","description":"Attach to a sparse repository checkout with the requested areas.","machineProviderId":null,"environmentProviderId":null,"inputs":{"anyOf":[{"type":"object","properties":{"tree":{"type":"string","minLength":1},"zones":{"maxItems":50,"type":"array","items":{"type":"string","minLength":1}},"zone":{"type":"string","minLength":1},"branch":{"type":"string","minLength":1}},"required":["tree"],"additionalProperties":false},{"type":"object","properties":{"pool":{"type":"object","properties":{"branch":{"type":"string","minLength":1,"maxLength":200,"pattern":"^(?!-)(?!.*\\.\\.)(?!.*\\/\\/)[A-Za-z0-9._/-]+(?<![./])$"},"from":{"type":"string","minLength":1,"pattern":"^[A-Za-z0-9][A-Za-z0-9._-]*$"},"zones":{"minItems":1,"maxItems":50,"type":"array","items":{"type":"string","minLength":1}},"base":{"type":"string","minLength":1,"maxLength":200,"pattern":"^(?!-)[A-Za-z0-9._/@^~-]+$"},"mergeBaseBranch":{"type":"string","minLength":1,"maxLength":200},"waitForSlotSeconds":{"type":"integer","minimum":0,"maximum":1800}},"required":["from","zones"],"additionalProperties":false}},"required":["pool"],"additionalProperties":false}]},"acceptsEmptyInputs":false},{"id":"remote-monorepo","displayName":"Remote monorepo sandbox","description":"A new sandbox with a dedicated monorepo checkout.","machineProviderId":"remote-monorepo","environmentProviderId":"remote-monorepo-checkout","inputs":{"anyOf":[{"type":"object","properties":{"branch":{"type":"string","pattern":"^(?!-)(?!.*\\.\\.)(?!.*\\/\\/)(?!.*@\\{)(?!.*\\.lock$)(?!.*\\/$)(?!.*\\.$)[A-Za-z0-9._\\/-]{1,200}$"},"base":{"type":"string","pattern":"^(?!-)[A-Za-z0-9._\\/~^-]{1,200}$"},"fromLaptopBranch":{"type":"string","pattern":"^(?!-)(?!.*\\.\\.)(?!.*\\/\\/)(?!.*@\\{)(?!.*\\.lock$)(?!.*\\/$)(?!.*\\.$)[A-Za-z0-9._\\/-]{1,200}$"}},"additionalProperties":false},{"type":"null"}]},"acceptsEmptyInputs":true}],"machines":[{"id":"manual","displayName":"Manual machine setup","description":"Run one command on a machine you already have to connect it to this server.","inputs":null,"acceptsEmptyInputs":true},{"id":"remote-sandbox","displayName":"Remote sandbox","description":"A new sandbox connected to the current server.","inputs":{"anyOf":[{"type":"object","properties":{"cores":{"type":"integer","minimum":1,"maximum":20},"memoryGb":{"type":"integer","minimum":1,"maximum":30},"diskGb":{"type":"integer","minimum":10,"maximum":50},"image":{"type":"string","pattern":"^[a-z0-9][a-z0-9._-]*$"},"checkout":{"type":"object","properties":{"revision":{"type":"string","pattern":"^[0-9a-f]{40}$"},"zones":{"maxItems":32,"type":"array","items":{"type":"string","pattern":"^(\\/\\/)?[A-Za-z0-9_.-]+(\\/[A-Za-z0-9_.-]+)*\\/?$"}}},"additionalProperties":false}},"additionalProperties":false},{"type":"null"}]},"acceptsEmptyInputs":true},{"id":"remote-monorepo","displayName":"Remote monorepo sandbox","description":"A new sandbox with a dedicated monorepo checkout.","inputs":{"anyOf":[{"type":"object","properties":{"revision":{"type":"string","pattern":"^[0-9a-f]{40}$"},"zones":{"maxItems":32,"type":"array","items":{"type":"string","pattern":"^(\\/\\/)?[A-Za-z0-9_.-]+(\\/[A-Za-z0-9_.-]+)*\\/?$"}},"cores":{"type":"integer","minimum":1,"maximum":20},"memoryGb":{"type":"integer","minimum":1,"maximum":30},"diskGb":{"type":"integer","minimum":10,"maximum":50},"image":{"type":"string","pattern":"^[a-z0-9][a-z0-9._-]*$"}},"additionalProperties":false},{"type":"null"}]},"acceptsEmptyInputs":true}],"hosts":[{"id":"host_test000001","name":"Demo laptop","connected":true}],"projects":[{"id":"proj_test000003","name":"infrastructure","remotes":["https://forge.example/example-org/infrastructure.git"],"path":"/home/demo/projects/infrastructure"},{"id":"proj_test000017","name":"infra-tools","remotes":["https://forge.example/example-org/infra-tools.git"],"path":"/home/demo/projects/infra-tools"},{"id":"proj_test000018","name":"sample-project-03","remotes":["https://forge.example/example-org/sample-project-03.git"],"path":"/home/demo/projects/sample-project-03"},{"id":"proj_test000007","name":"network-infra","remotes":["https://forge.example/example-org/network-infra.git"],"path":"/home/demo/projects/network-infra"},{"id":"proj_test000004","name":"sample-project-05","remotes":["https://forge.example/example-org/sample-project-05.git"],"path":"/home/demo/projects/sample-project-05"},{"id":"proj_test000027","name":"sample-project-06","remotes":["https://forge.example/example-org/sample-project-06.git"],"path":"/home/demo/projects/sample-project-06"},{"id":"proj_test000011","name":"sample-project-07","remotes":["https://forge.example/example-org/sample-project-07.git"],"path":"/home/demo/projects/sample-project-07"},{"id":"proj_test000012","name":"sample-project-08","remotes":["https://forge.example/example-org/sample-project-08.git"],"path":"/home/demo/projects/sample-project-08"},{"id":"proj_test000001","name":"sample-project-09","remotes":["https://forge.example/example-org/sample-project-09.git"],"path":"/home/demo/projects/sample-project-09"},{"id":"proj_test000009","name":"sample-marketplace","remotes":["https://forge.example/example-org/sample-marketplace.git"],"path":"/home/demo/projects/sample-marketplace"},{"id":"proj_test000002","name":"sample-router","remotes":["https://forge.example/example-org/monorepo.git"],"path":"/home/demo/projects/sample-router"},{"id":"proj_test000026","name":"archive-events","remotes":[],"path":"/home/demo/projects/archive-events"},{"id":"proj_test000023","name":"sample-project-13","remotes":["https://forge.example/example-org/sample-project-13.git"],"path":"/home/demo/projects/sample-project-13"},{"id":"proj_test000014","name":"sample-project-14","remotes":["https://forge.example/example-org/sample-project-14.git"],"path":"/home/demo/projects/sample-project-14"},{"id":"proj_test000016","name":"sample-project-15","remotes":[],"path":"/home/demo/projects/sample-project-15"},{"id":"proj_test000022","name":"sample-project-16","remotes":["https://forge.example/example-org/sample-project-16.git"],"path":"/home/demo/projects/sample-project-16"},{"id":"proj_test000008","name":"sample-project-17","remotes":["https://forge.example/example-org/sample-project-17.git"],"path":"/home/demo/projects/sample-project-17"},{"id":"proj_test000025","name":"sample-project-18","remotes":["https://forge.example/example-org/sample-project-18.git"],"path":"/home/demo/projects/sample-project-18"},{"id":"proj_test000021","name":"sample-project-19","remotes":["https://forge.example/example-org/sample-project-19.git"],"path":"/home/demo/projects/sample-project-19"},{"id":"proj_test000006","name":"sample-project-20","remotes":["https://forge.example/example-org/sample-project-20.git"],"path":"/home/demo/projects/sample-project-20"},{"id":"proj_test000019","name":"sample-project-21","remotes":["https://forge.example/example-org/sample-project-21.git"],"path":"/home/demo/projects/sample-project-21"},{"id":"proj_test000010","name":"sample-project-22","remotes":["https://forge.example/example-org/sample-project-22.git"],"path":"/home/demo/projects/sample-project-22"},{"id":"proj_test000015","name":"sample-project-23","remotes":["https://forge.example/example-org/sample-project-23.git"],"path":"/home/demo/projects/sample-project-23"},{"id":"proj_test000020","name":"sample-project-24","remotes":["https://forge.example/example-org/sample-project-24.git"],"path":"/home/demo/projects/sample-project-24"},{"id":"proj_test000005","name":"sample-project-25","remotes":["https://forge.example/example-org/sample-project-25.git"],"path":"/home/demo/projects/sample-project-25"},{"id":"proj_test000013","name":"sample-project-26","remotes":["https://forge.example/example-org/sample-project-26.git"],"path":"/home/demo/projects/sample-project-26"},{"id":"proj_test000024","name":"sample-app","remotes":["https://forge.example/example-org/sample-app.git"],"path":"/home/demo/projects/sample-app"}]};

const at = 1794660736997;
const keeperMember = (threadId: string, characterId: string, displayName: string, lastActiveAt: number) => memberSchema.parse({ threadId, classId: "keeper", characterId, displayName, role: "keeper", keeperThreadId: null, boardQuestId: null, waypointId: null, errand: false, title: null, place: "table", state: "idle", doing: null, createdAt: at, lastActiveAt, lastReportAt: null, strikes: 0, verifiedWins: 3 });
const quest = (id: string, keeperThreadId: string, short: string, title: string) => ({ id, keeperThreadId, title, short, phase: "build" as const, planVersion: 1, greenlitVersion: 1, createdAt: at, updatedAt: at, endedAt: null, archivedAt: null, plan: null, waypoints: [], members: [], openAsks: 0, move: { who: "keeper" as const, text: "Building" } });
/** Fixture Keepers: two Wrens share a thread title, so their start time tells them apart; both lead a quest named Uppercase durations. */
export const machinesRoom: Room = roomSchema.parse({
  keepers: [
    { member: keeperMember("thr_test000053", "wren", "Wren", at + 50 * 60_000), threadTitle: "Find plugins missing from README table", threadCreatedAt: 1794636237857, boardQuests: [quest("quest_e459cbf4", "thr_test000053", "README missing plugins", "List plugins/* folders missing from the README.md plugin table, one per line, in /tmp/tavern-smoke/missing-plugins.md (read-only on repo)")], errands: [], status: "listening" },
    { member: keeperMember("thr_test000057", "wren", "Wren", at + 20 * 60_000), threadTitle: "Support uppercase units in parseDuration", threadCreatedAt: 1794656692754, boardQuests: [quest("quest_08eee999", "thr_test000057", "Uppercase durations", "parseDuration accepts uppercase units, with test; npm test passes")], errands: [], status: "listening" },
    { member: keeperMember("thr_test000059", "wren", "Wren", at + 10 * 60_000), threadTitle: "Support uppercase units in parseDuration", threadCreatedAt: 1794656425490, boardQuests: [quest("quest_04663432", "thr_test000059", "Uppercase durations", "parseDuration accepts uppercase units, with test; npm test passes")], errands: [], status: "listening" },
    { member: keeperMember("thr_test000063", "moss", "Moss", at), threadTitle: "Add formatDuration to src/duration.js", threadCreatedAt: 1794660736997, boardQuests: [quest("quest_9e7f9c0f", "thr_test000063", "formatDuration", "Add formatDuration(ms) to src/duration.js (inverse of parseDuration) with tests in test/duration.test.js; npm test passes; delivered as a commit on a branch")], errands: [], status: "listening" },
  ],
  asks: [], decidedForYou: [], review: { waiting: 0, budget: 3, items: [] }, solos: [], recent: [],
});
/** Where each fixture Keeper works. */
export const keeperFacts: Record<string, { projectId: string; path: string; env: string }> = {
  thr_test000053: { projectId: "proj_test000009", path: "/home/demo/worktrees/thr_test000053/sample-marketplace", env: "git-worktree" },
  thr_test000057: { projectId: "proj_test000024", path: "/home/demo/projects/sample-app", env: "project-checkout" },
  thr_test000059: { projectId: "proj_test000024", path: "/home/demo/projects/sample-app", env: "project-checkout" },
  thr_test000063: { projectId: "proj_test000024", path: "/home/demo/projects/sample-app", env: "project-checkout" },
};

const consent = { guardInstall: true, remoteDetectionOnly: true, linuxUncontainedChecks: true };
const none = { guardInstall: false, remoteDetectionOnly: false, linuxUncontainedChecks: false };
const monorepoRemote = { id: "monorepo-remote", label: "Monorepo on a remote machine", enabled: true, match: { repoRemotes: ["forge.example/example-org/monorepo"] },
  target: { kind: "provider", environmentProviderId: "remote-monorepo-checkout", inputs: { fromLaptopBranch: "{keeper.branch}" }, machine: { type: "new", machineProviderId: "remote-monorepo", inputs: { cores: 4, memoryGb: 8 } }, workspace: "dedicated-machine" }, consent };
export const machineVolumes: Record<"empty" | "one" | "many", PlacementSettings> = {
  empty: placementSettingsSchema.parse({}),
  one: placementSettingsSchema.parse({ rules: [monorepoRemote] }),
  many: placementSettingsSchema.parse({ maxMakers: 4, maxCheckers: 2, rules: [
    { id: "one-quest-local", label: "Keep Uppercase durations where its Keeper is", enabled: true, match: { questIds: ["quest_08eee999"] }, target: { kind: "current" }, consent: none },
    monorepoRemote,
    { id: "workspace-trees-smiths", label: "Smiths in any Workspace tree", enabled: true, match: { keeperPathGlobs: ["~/workspaces/trees/*/src"], classes: ["smith"] },
      target: { kind: "provider", environmentProviderId: "remote-monorepo-checkout", machine: { type: "new", machineProviderId: "remote-monorepo", inputs: { cores: 8, memoryGb: 16 } }, workspace: "dedicated-machine" }, consent },
    { id: "sample-marketplace-wardens", label: "sample-marketplace Wardens on their own sandbox", enabled: true, match: { projectIds: ["proj_test000009"], classes: ["warden"] },
      target: { kind: "provider", environmentProviderId: "project-checkout", machine: { type: "new", machineProviderId: "remote-sandbox", inputs: { cores: 2, memoryGb: 4 } }, workspace: "dedicated-machine" }, consent },
    { id: "infra-smiths-big", label: "Infra Smiths on big sandboxes", enabled: false, match: { projectIds: ["proj_test000003", "proj_test000018"], classes: ["smith"] },
      target: { kind: "provider", environmentProviderId: "project-checkout", machine: { type: "new", machineProviderId: "remote-sandbox", inputs: { cores: 16, memoryGb: 30, diskGb: 50 } }, workspace: "dedicated-machine" }, consent: none },
    { id: "devbox-rangers", label: "Rangers on a devbox", enabled: true, match: { classes: ["ranger"], projectIds: ["proj_test000017"] },
      target: { kind: "provider", environmentProviderId: "devbox-checkout", machine: { type: "new", machineProviderId: "devbox", inputs: { size: "m" } }, workspace: "dedicated-machine" }, consent },
    { id: "everything-else-remote", label: "Everything else on a new Remote sandbox", enabled: true, match: {},
      target: { kind: "provider", environmentProviderId: "project-checkout", machine: { type: "new", machineProviderId: "remote-sandbox" }, workspace: "dedicated-machine" }, consent },
    { id: "edge-wardens-local", label: "network-infra Wardens stay local", enabled: true, match: { projectIds: ["proj_test000007"], classes: ["warden"] }, target: { kind: "current" }, consent: none },
  ] }),
};

/** The contract's own messages at their keys, for the refused-save state. */
export const machineProblems = [
  { line: 0, key: "machines.rules.1.target.inputs.fromLaptopBranch", message: "Unknown template {keeper.brnch}. Use {keeper.branch}, {source.commit}, {source.base}, {member.branch} or {quest.id}." },
  { line: 0, key: "machines.rules.2.target.workspace", message: "Dedicated-machine placement needs a new machine for this member." },
  { line: 0, key: "machines.rules.3.target.machine.inputs.cores", message: "Must be at most 20.", allowed: "1 to 20" },
  { line: 0, key: "machines.rules.4.consent", message: "Confirm this rule's marked guard install, remote detection-only execution and Linux checks without containment." },
  { line: 0, key: "machines.rules.5.target.machine.inputs", message: "Provider inputs can't use the key __proto__ (rules[5].target.machine.inputs.__proto__): bb's RPC can't carry it" },
  { line: 0, key: "machines.rules.6.id", message: "Rule IDs must be unique." },
  { line: 0, key: "machines.maxMakers", message: "Must be at most 1000.", allowed: "1 to 1000" },
];

export async function previewFixture(settings: PlacementSettings, input: PlacementPreviewInput): Promise<PlacementPreview> {
  const keeper = input.keeperThreadId ? keeperFacts[input.keeperThreadId] : undefined;
  const projectId = input.projectId ?? keeper?.projectId ?? null;
  const project = machinesCatalog.projects.find(p => p.id === projectId);
  const db = new Database(":memory:");
  try {
    for (const migration of MIGRATIONS) db.exec(migration);
    const { bb } = createFakePluginHost({ pluginId: "tavern", sdk: {
      projects: { get: async () => {
        if (!project) throw new Error("Unknown fixture project.");
        return { id: project.id, gitRemoteUrl: project.remotes[0] ?? null, sources: project.path ? [{ path: project.path, isDefault: true }] : [] };
      } },
      threads: { get: async ({ threadId }: { threadId: string }) => {
        if (!projectId) throw new Error("Unknown fixture Keeper project.");
        return makeThreadResponse({ id: threadId, projectId, environmentId: "env" });
      } },
      environments: { get: async () => ({ id: "env", projectId, hostId: "host", path: keeper?.path, environmentProviderId: keeper?.env,
        status: "ready", hostLifecycle: "active", lifecycle: { phase: "active" } }) },
    } });
    const runtime = {
      bb, settings: { placementPolicy: () => ({ state: "valid", revision: 12, settings }), hasUser: () => false },
      config: () => DEFAULT_SETTINGS, snapshot: () => registry,
      keeper: { member: (id: string) => machinesRoom.keepers.find(k => k.member.threadId === id)?.member,
        store: { db, runtime: (id: string) => ({ projectId: keeperFacts[id]?.projectId }) } },
      placementSources: () => ({ inspect: async () => {
        if (!keeper || !project) throw new Error("Unknown fixture Keeper.");
        return { state: "known", endpoint: { root: keeper.path }, environmentProviderId: keeper.env,
          inspection: { home: "/home/demo", repoRemotes: project.remotes } };
      } }),
    } as unknown as TavernRuntime;
    return await placementHandlers(runtime).placementPreview({ ...input, projectId });
  } finally {
    db.close();
  }
}
