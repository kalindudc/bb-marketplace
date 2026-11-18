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

// Fixtures for the machine placement page: this bb's real catalog (captured 2026-11-14 with `bb environment providers`,
// `bb machine providers`, `bb machine list` and `bb project list`), the user's live Keepers, and rules at three volumes.

export const machinesCatalog: PlacementCatalog = {"hostId":"host_fiffwzr9t6","environments":[{"id":"project-checkout","displayName":"Project checkout","description":"Work in a project checkout on this machine.","machineProviderId":null,"environmentProviderId":null,"inputs":{"type":"object","properties":{"path":{"type":"string","minLength":1},"branch":{"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"existing"},"name":{"type":"string","minLength":1}},"required":["kind","name"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"new"},"baseBranch":{"type":"string","minLength":1}},"required":["kind","baseBranch"],"additionalProperties":false}]}}},"acceptsEmptyInputs":true},{"id":"git-worktree","displayName":"Worktree","description":"Create an isolated Git worktree for your changes.","machineProviderId":null,"environmentProviderId":null,"inputs":{"default":{"branch":{"kind":"default"}},"anyOf":[{"type":"object","properties":{"kind":{"type":"string","const":"existing"},"path":{"type":"string","minLength":1}},"required":["kind","path"],"additionalProperties":false},{"type":"object","properties":{"branch":{"default":{"kind":"default"},"oneOf":[{"type":"object","properties":{"kind":{"type":"string","const":"named"},"name":{"type":"string","minLength":1}},"required":["kind","name"],"additionalProperties":false},{"type":"object","properties":{"kind":{"type":"string","const":"default"}},"required":["kind"],"additionalProperties":false}]}},"additionalProperties":false}]},"acceptsEmptyInputs":true},{"id":"aquifer-world-checkout","displayName":"Aquifer World checkout","description":"The Shopify World checkout of an Aquifer World sandbox, on a branch of its own: no clone, no worktree. One branch per machine.","machineProviderId":null,"environmentProviderId":null,"inputs":{"anyOf":[{"type":"object","properties":{"branch":{"type":"string","pattern":"^(?!-)(?!.*\\.\\.)(?!.*\\/\\/)(?!.*@\\{)(?!.*\\.lock$)(?!.*\\/$)(?!.*\\.$)[A-Za-z0-9._\\/-]{1,200}$"},"base":{"type":"string","pattern":"^(?!-)[A-Za-z0-9._\\/~^-]{1,200}$"},"fromLaptopBranch":{"type":"string","pattern":"^(?!-)(?!.*\\.\\.)(?!.*\\/\\/)(?!.*@\\{)(?!.*\\.lock$)(?!.*\\/$)(?!.*\\.$)[A-Za-z0-9._\\/-]{1,200}$"}},"additionalProperties":false},{"type":"null"}]},"acceptsEmptyInputs":true},{"id":"personal-workspace","displayName":"Personal workspace","description":"Create a personal directory without a project.","machineProviderId":null,"environmentProviderId":null,"inputs":null,"acceptsEmptyInputs":true},{"id":"world-tree","displayName":"World tree","description":"Attach a thread to the root of a Shopify World tree, creating the tree or adding the zones it needs to the sparse checkout.","machineProviderId":null,"environmentProviderId":null,"inputs":{"anyOf":[{"type":"object","properties":{"tree":{"type":"string","minLength":1},"zones":{"maxItems":50,"type":"array","items":{"type":"string","minLength":1}},"zone":{"type":"string","minLength":1},"branch":{"type":"string","minLength":1}},"required":["tree"],"additionalProperties":false},{"type":"object","properties":{"pool":{"type":"object","properties":{"branch":{"type":"string","minLength":1,"maxLength":200,"pattern":"^(?!-)(?!.*\\.\\.)(?!.*\\/\\/)[A-Za-z0-9._/-]+(?<![./])$"},"from":{"type":"string","minLength":1,"pattern":"^[A-Za-z0-9][A-Za-z0-9._-]*$"},"zones":{"minItems":1,"maxItems":50,"type":"array","items":{"type":"string","minLength":1}},"base":{"type":"string","minLength":1,"maxLength":200,"pattern":"^(?!-)[A-Za-z0-9._/@^~-]+$"},"mergeBaseBranch":{"type":"string","minLength":1,"maxLength":200},"waitForSlotSeconds":{"type":"integer","minimum":0,"maximum":1800}},"required":["from","zones"],"additionalProperties":false}},"required":["pool"],"additionalProperties":false}]},"acceptsEmptyInputs":false},{"id":"aquifer-world","displayName":"Aquifer World sandbox","description":"A new Aquifer sandbox with the Shopify World checkout (every zone, ready in seconds), on a branch of its own. Commits are authored as you; pushes go out as you.","machineProviderId":"aquifer-world","environmentProviderId":"aquifer-world-checkout","inputs":{"anyOf":[{"type":"object","properties":{"branch":{"type":"string","pattern":"^(?!-)(?!.*\\.\\.)(?!.*\\/\\/)(?!.*@\\{)(?!.*\\.lock$)(?!.*\\/$)(?!.*\\.$)[A-Za-z0-9._\\/-]{1,200}$"},"base":{"type":"string","pattern":"^(?!-)[A-Za-z0-9._\\/~^-]{1,200}$"},"fromLaptopBranch":{"type":"string","pattern":"^(?!-)(?!.*\\.\\.)(?!.*\\/\\/)(?!.*@\\{)(?!.*\\.lock$)(?!.*\\/$)(?!.*\\.$)[A-Za-z0-9._\\/-]{1,200}$"}},"additionalProperties":false},{"type":"null"}]},"acceptsEmptyInputs":true}],"machines":[{"id":"manual","displayName":"Manual machine setup","description":"Run one command on a machine you already have to connect it to this server.","inputs":null,"acceptsEmptyInputs":true},{"id":"aquifer","displayName":"Aquifer sandbox","description":"An Aquifer sandbox that runs bb's daemon and reaches this laptop through a tunnel the laptop opens. It moves to a fresh sandbox before Aquifer's 2-hour limit.","inputs":{"anyOf":[{"type":"object","properties":{"cores":{"type":"integer","minimum":1,"maximum":20},"memoryGb":{"type":"integer","minimum":1,"maximum":30},"diskGb":{"type":"integer","minimum":10,"maximum":50},"image":{"type":"string","pattern":"^[a-z0-9][a-z0-9._-]*$"},"world":{"type":"object","properties":{"revision":{"type":"string","pattern":"^[0-9a-f]{40}$"},"zones":{"maxItems":32,"type":"array","items":{"type":"string","pattern":"^(\\/\\/)?[A-Za-z0-9_.-]+(\\/[A-Za-z0-9_.-]+)*\\/?$"}}},"additionalProperties":false}},"additionalProperties":false},{"type":"null"}]},"acceptsEmptyInputs":true},{"id":"aquifer-world","displayName":"Aquifer World sandbox","description":"An Aquifer sandbox with the Shopify World checkout (all zones). Commits are authored as you; pushes go out as you through this laptop. Moves to a fresh sandbox before the 2-hour limit.","inputs":{"anyOf":[{"type":"object","properties":{"revision":{"type":"string","pattern":"^[0-9a-f]{40}$"},"zones":{"maxItems":32,"type":"array","items":{"type":"string","pattern":"^(\\/\\/)?[A-Za-z0-9_.-]+(\\/[A-Za-z0-9_.-]+)*\\/?$"}},"cores":{"type":"integer","minimum":1,"maximum":20},"memoryGb":{"type":"integer","minimum":1,"maximum":30},"diskGb":{"type":"integer","minimum":10,"maximum":50},"image":{"type":"string","pattern":"^[a-z0-9][a-z0-9._-]*$"}},"additionalProperties":false},{"type":"null"}]},"acceptsEmptyInputs":true}],"hosts":[{"id":"host_fiffwzr9t6","name":"MacBook Pro (30)","connected":true}],"projects":[{"id":"proj_3r67g96xxe","name":"infrastructure","remotes":["https://github.com/Shopify/infrastructure.git"],"path":"/Users/me/src/github.com/Shopify/infrastructure"},{"id":"proj_mddz3fcct5","name":"infra-central","remotes":["https://github.com/Shopify/infra-central.git"],"path":"/Users/me/src/github.com/Shopify/infra-central"},{"id":"proj_nxh8myi7jx","name":"terraform-the-cloud","remotes":["https://github.com/Shopify/terraform-the-cloud.git"],"path":"/Users/me/src/github.com/Shopify/terraform-the-cloud"},{"id":"proj_7epvwh9rjx","name":"edge-infrastructure","remotes":["https://github.com/Shopify/edge-infrastructure.git"],"path":"/Users/me/src/github.com/Shopify/edge-infrastructure"},{"id":"proj_4uv78tq7iw","name":"cortex","remotes":["https://github.com/kalindudc/cortex.git"],"path":"/Users/me/src/github.com/kalindudc/cortex"},{"id":"proj_zzfug9epa4","name":"shell","remotes":["https://github.com/kalindudc/shell.git"],"path":"/Users/me/src/github.com/kalindudc/shell"},{"id":"proj_chsa5edz4r","name":"pi-quests","remotes":["https://github.com/kalindudc/pi-quests.git"],"path":"/Users/me/src/github.com/kalindudc/pi-quests"},{"id":"proj_egmnek7bzk","name":"edgey","remotes":["https://github.com/Shopify/edgey.git"],"path":"/Users/me/src/github.com/Shopify/edgey"},{"id":"proj_2pqaghwyec","name":"pi-minions","remotes":["https://github.com/kalindudc/pi-minions.git"],"path":"/Users/me/src/github.com/kalindudc/pi-minions"},{"id":"proj_7przffsyfd","name":"bb-marketplace","remotes":["https://github.com/kalindudc/bb-marketplace.git"],"path":"/Users/me/src/github.com/kalindudc/bb-marketplace"},{"id":"proj_3m7ijbk6gx","name":"nginx-routing-modules","remotes":["https://delta.shopify.io/shop/world.git"],"path":"/Users/me/world/trees/root/src/areas/infra/routing/nginx-routing-modules"},{"id":"proj_v75cbnswyk","name":"ar-routing-events","remotes":[],"path":"/Users/me/src/ar-routing-events"},{"id":"proj_th5f77zwdq","name":"burn","remotes":["https://github.com/kalindudc/burn.git"],"path":"/Users/me/src/github.com/kalindudc/burn"},{"id":"proj_jq86jefbjt","name":"spy-v2","remotes":["https://github.com/Shopify/spy-v2.git"],"path":"/Users/me/src/github.com/Shopify/spy-v2"},{"id":"proj_kfjwr3uasq","name":"loom-live-check","remotes":[],"path":"/Users/me/src/loom-live-check"},{"id":"proj_t5p6zvp6s8","name":"wafflestack","remotes":["https://github.com/Shopify/wafflestack.git"],"path":"/Users/me/src/github.com/Shopify/wafflestack"},{"id":"proj_7p2evhzavc","name":"record-store","remotes":["https://github.com/Shopify/record-store.git"],"path":"/Users/me/src/github.com/Shopify/record-store"},{"id":"proj_uvw3nxmk6f","name":"bb-marketplace-shopify-playground","remotes":["https://github.com/shopify-playground/bb-marketplace.git"],"path":"/Users/me/src/github.com/shopify-playground/bb-marketplace"},{"id":"proj_sax5d3tixr","name":"ubertool","remotes":["https://github.com/Shopify/ubertool.git"],"path":"/Users/me/src/github.com/Shopify/ubertool"},{"id":"proj_6baw3a9yhq","name":"shop-js","remotes":["https://github.com/Shopify/shop-js.git"],"path":"/Users/me/src/github.com/Shopify/shop-js"},{"id":"proj_pgiupdzrn4","name":"production-platform","remotes":["https://github.com/Shopify/production-platform.git"],"path":"/Users/me/src/github.com/Shopify/production-platform"},{"id":"proj_bkr74dzrmd","name":"cdn-detective","remotes":["https://github.com/Shopify/cdn-detective.git"],"path":"/Users/me/src/github.com/Shopify/cdn-detective"},{"id":"proj_jzfgbwdidz","name":"edge-cache-service","remotes":["https://github.com/Shopify/edge-cache-service"],"path":"/Users/me/src/github.com/Shopify/edge-cache-service"},{"id":"proj_qebqir8dps","name":"ingress-nginx","remotes":["https://github.com/Shopify/ingress-nginx.git"],"path":"/Users/me/src/github.com/Shopify/ingress-nginx"},{"id":"proj_4vvitkw3p6","name":"shopify-terraform-modules","remotes":["https://github.com/Shopify/shopify-terraform-modules.git"],"path":"/Users/me/src/github.com/Shopify/shopify-terraform-modules"},{"id":"proj_jeyq3qaex5","name":"shopify-debug","remotes":["https://github.com/Shopify/shopify-debug"],"path":"/Users/me/src/github.com/Shopify/shopify-debug"},{"id":"proj_ttq967ke9y","name":"tavern-live-r2","remotes":["/Users/me/tavern-live-r2/origin.git"],"path":"/Users/me/tavern-live-r2/app"}]};

const at = 1794660736997;
const keeperMember = (threadId: string, characterId: string, displayName: string, lastActiveAt: number) => memberSchema.parse({ threadId, classId: "keeper", characterId, displayName, role: "keeper", keeperThreadId: null, boardQuestId: null, waypointId: null, errand: false, title: null, place: "table", state: "idle", doing: null, createdAt: at, lastActiveAt, lastReportAt: null, strikes: 0, verifiedWins: 3 });
const quest = (id: string, keeperThreadId: string, short: string, title: string) => ({ id, keeperThreadId, title, short, phase: "build" as const, planVersion: 1, greenlitVersion: 1, createdAt: at, updatedAt: at, endedAt: null, archivedAt: null, plan: null, waypoints: [], members: [], openAsks: 0, move: { who: "keeper" as const, text: "Building" } });
/** The user's Keepers: two Wrens share a thread title, so their start time tells them apart; both lead a quest named Uppercase durations. */
export const machinesRoom: Room = roomSchema.parse({
  keepers: [
    { member: keeperMember("thr_t3zru37rah", "wren", "Wren", at + 50 * 60_000), threadTitle: "Find plugins missing from README table", threadCreatedAt: 1794636237857, boardQuests: [quest("quest_e459cbf4", "thr_t3zru37rah", "README missing plugins", "List plugins/* folders missing from the README.md plugin table, one per line, in /tmp/tavern-smoke/missing-plugins.md (read-only on repo)")], errands: [], status: "listening" },
    { member: keeperMember("thr_vhnrtdty72", "wren", "Wren", at + 20 * 60_000), threadTitle: "Support uppercase units in parseDuration", threadCreatedAt: 1794656692754, boardQuests: [quest("quest_08eee999", "thr_vhnrtdty72", "Uppercase durations", "parseDuration accepts uppercase units, with test; npm test passes")], errands: [], status: "listening" },
    { member: keeperMember("thr_wzgz6eyctp", "wren", "Wren", at + 10 * 60_000), threadTitle: "Support uppercase units in parseDuration", threadCreatedAt: 1794656425490, boardQuests: [quest("quest_04663432", "thr_wzgz6eyctp", "Uppercase durations", "parseDuration accepts uppercase units, with test; npm test passes")], errands: [], status: "listening" },
    { member: keeperMember("thr_yj6ei8hxus", "moss", "Moss", at), threadTitle: "Add formatDuration to src/duration.js", threadCreatedAt: 1794660736997, boardQuests: [quest("quest_9e7f9c0f", "thr_yj6ei8hxus", "formatDuration", "Add formatDuration(ms) to src/duration.js (inverse of parseDuration) with tests in test/duration.test.js; npm test passes; delivered as a commit on a branch")], errands: [], status: "listening" },
  ],
  asks: [], decidedForYou: [], review: { waiting: 0, budget: 3, items: [] }, solos: [], recent: [],
});
/** Where each fixture Keeper works. */
export const keeperFacts: Record<string, { projectId: string; path: string; env: string }> = {
  thr_t3zru37rah: { projectId: "proj_7przffsyfd", path: "/Users/me/.bb/plugins/environment-git-worktree/host-data/worktrees/thr_t3zru37rah/bb-marketplace", env: "git-worktree" },
  thr_vhnrtdty72: { projectId: "proj_ttq967ke9y", path: "/Users/me/tavern-live-r2/app", env: "project-checkout" },
  thr_wzgz6eyctp: { projectId: "proj_ttq967ke9y", path: "/Users/me/tavern-live-r2/app", env: "project-checkout" },
  thr_yj6ei8hxus: { projectId: "proj_ttq967ke9y", path: "/Users/me/tavern-live-r2/app", env: "project-checkout" },
};

const consent = { guardInstall: true, remoteDetectionOnly: true, linuxUncontainedChecks: true };
const none = { guardInstall: false, remoteDetectionOnly: false, linuxUncontainedChecks: false };
const shopWorld = { id: "shop-world-remote", label: "Shop/world on an Aquifer machine", enabled: true, match: { repoRemotes: ["delta.shopify.io/shop/world"] },
  target: { kind: "provider", environmentProviderId: "aquifer-world-checkout", inputs: { fromLaptopBranch: "{keeper.branch}" }, machine: { type: "new", machineProviderId: "aquifer-world", inputs: { cores: 4, memoryGb: 8 } }, workspace: "dedicated-machine" }, consent };
export const machineVolumes: Record<"empty" | "one" | "many", PlacementSettings> = {
  empty: placementSettingsSchema.parse({}),
  one: placementSettingsSchema.parse({ rules: [shopWorld] }),
  many: placementSettingsSchema.parse({ maxMakers: 4, maxCheckers: 2, rules: [
    { id: "one-quest-local", label: "Keep Uppercase durations where its Keeper is", enabled: true, match: { questIds: ["quest_08eee999"] }, target: { kind: "current" }, consent: none },
    shopWorld,
    { id: "world-trees-smiths", label: "Smiths in any World tree", enabled: true, match: { keeperPathGlobs: ["~/world/trees/*/src"], classes: ["smith"] },
      target: { kind: "provider", environmentProviderId: "aquifer-world-checkout", machine: { type: "new", machineProviderId: "aquifer-world", inputs: { cores: 8, memoryGb: 16 } }, workspace: "dedicated-machine" }, consent },
    { id: "bb-marketplace-wardens", label: "bb-marketplace Wardens on their own sandbox", enabled: true, match: { projectIds: ["proj_7przffsyfd"], classes: ["warden"] },
      target: { kind: "provider", environmentProviderId: "project-checkout", machine: { type: "new", machineProviderId: "aquifer", inputs: { cores: 2, memoryGb: 4 } }, workspace: "dedicated-machine" }, consent },
    { id: "infra-smiths-big", label: "Infra Smiths on big sandboxes", enabled: false, match: { projectIds: ["proj_3r67g96xxe", "proj_nxh8myi7jx"], classes: ["smith"] },
      target: { kind: "provider", environmentProviderId: "project-checkout", machine: { type: "new", machineProviderId: "aquifer", inputs: { cores: 16, memoryGb: 30, diskGb: 50 } }, workspace: "dedicated-machine" }, consent: none },
    { id: "devbox-rangers", label: "Rangers on a devbox", enabled: true, match: { classes: ["ranger"], projectIds: ["proj_mddz3fcct5"] },
      target: { kind: "provider", environmentProviderId: "devbox-checkout", machine: { type: "new", machineProviderId: "devbox", inputs: { size: "m" } }, workspace: "dedicated-machine" }, consent },
    { id: "everything-else-remote", label: "Everything else on a new Aquifer sandbox", enabled: true, match: {},
      target: { kind: "provider", environmentProviderId: "project-checkout", machine: { type: "new", machineProviderId: "aquifer" }, workspace: "dedicated-machine" }, consent },
    { id: "edge-wardens-local", label: "edge-infrastructure Wardens stay local", enabled: true, match: { projectIds: ["proj_7epvwh9rjx"], classes: ["warden"] }, target: { kind: "current" }, consent: none },
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
          inspection: { home: "/Users/me", repoRemotes: project.remotes } };
      } }),
    } as unknown as TavernRuntime;
    return await placementHandlers(runtime).placementPreview({ ...input, projectId });
  } finally {
    db.close();
  }
}
