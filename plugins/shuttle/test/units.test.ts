// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CommandAdapter } from "../src/adapters/command";
import { runProcess } from "../src/adapters/exec";
import { searchQuery, toActivity } from "../src/adapters/github";
import { configChanges, configFromToml, configToToml, DEFAULT_CONFIG, parseConfig } from "../src/config";
import { parseKey, parseLink, resolveQuery } from "../src/keys";
import { matchProject, remotePath } from "../src/projects";
import { renderTemplate } from "../src/reviews";
import { globMatch } from "../src/sync";
import { TEST_SERVER, harness, pr, testConfig } from "./helpers";

describe("config", () => {
  it("refuses a command server without a link pattern, link or view command", () => {
    expect(() => parseConfig({ ...DEFAULT_CONFIG, servers: [{ id: "x", name: "X", kind: "command" }] })).toThrow(/link pattern.*link template.*view command/su);
  });

  it("round-trips through TOML and lists the changes of an import", () => {
    const config = testConfig();
    const toml = configToToml(config);
    expect(toml).toContain("[[server]]");
    expect(configFromToml(toml)).toEqual(config);
    const next = configFromToml(toml.replace('name = "Forge"', 'name = "Forge 2"'));
    expect(configChanges(config, next)).toEqual(["changes server forge"]);
    expect(() => configFromToml("[nope]\na = 1")).toThrow(/unknown table nope/u);
  });
});

describe("keys and links", () => {
  const servers = [...DEFAULT_CONFIG.servers, parseConfig({ ...DEFAULT_CONFIG, servers: [TEST_SERVER] }).servers[0]!];
  it("parses keys with either sign and links of every server", () => {
    expect(parseKey("gitlab:group/sub/proj!77")).toEqual({ server: "gitlab", repo: "group/sub/proj", number: 77 });
    expect(parseLink("https://github.com/get-bb/bb/pull/4411/files", servers)).toEqual({ server: "github", repo: "get-bb/bb", number: 4411 });
    expect(parseLink("https://forge.test/acme/app/pull/12", servers)).toEqual({ server: "forge", repo: "acme/app", number: 12 });
    expect(() => resolveQuery("nope:a/b#1", servers)).toThrow(/no server called nope/u);
    expect(() => resolveQuery("hello", servers)).toThrow(/no server's link pattern/u);
  });
});

describe("projects", () => {
  it("matches a repo to a project by remote, then by repository name, then the default", () => {
    const projects = [
      { id: "a", name: "app", gitRemoteUrl: "git@github.com:acme/app.git" },
      { id: "b", name: "bb", gitRemoteUrl: "https://github.com/get-bb/bb" },
    ];
    expect(remotePath("git@github.com:acme/app.git")).toBe("acme/app");
    expect(matchProject("get-bb/bb", projects, null)).toBe("b");
    expect(matchProject("acme/app", projects, null)).toBe("a");
    expect(matchProject("x/y", projects, "b")).toBe("b");
    expect(matchProject("x/y", projects, null)).toBeNull();
  });
});

describe("templates and globs", () => {
  it("fills known variables and leaves unknown ones", () => {
    expect(renderTemplate("{url} {nope}", { url: "u" })).toBe("u {nope}");
    expect(globMatch("get-bb/*", "get-bb/bb")).toBe(true);
    expect(globMatch("acme/app", "Acme/App")).toBe(true);
    expect(globMatch("acme/*", "other/x")).toBe(false);
  });
});

describe("command adapter", () => {
  const server = parseConfig({ ...DEFAULT_CONFIG, servers: [{ ...TEST_SERVER, commands: { whoami: "echo me", view: 'printf \'{"repo":"%s","number":%s,"title":"T","state":"open","draft":true}\' "$SHUTTLE_REPO" "$SHUTTLE_NUMBER"', activity: "echo nope", authored: "echo oops >&2; exit 3", mentioned: 'echo \'[{"repo":"a/b","number":"x"}]\'' } }] }).servers[0]!;
  const adapter = new CommandAdapter(server, runProcess);

  it("runs real shell commands with the PR in the environment", async () => {
    expect(await adapter.whoami()).toBe("me");
    const view = await adapter.view("acme/app", 7);
    expect(view).toMatchObject({ repo: "acme/app", number: 7, state: "draft", url: "https://forge.test/acme/app/pull/7", checks: "none" });
  });

  it("says what went wrong: exit code, not JSON, wrong shape", async () => {
    await expect(adapter.list("authored", { state: "open" })).rejects.toThrow(/authored exited 3: oops/u);
    await expect(adapter.activity("a/b", 1)).rejects.toThrow(/did not print JSON/u);
    await expect(adapter.list("mentioned", {})).rejects.toThrow(/wrong shape/u);
    const capped = new CommandAdapter(parseConfig({ ...DEFAULT_CONFIG, servers: [{ ...TEST_SERVER, commands: { ...TEST_SERVER.commands, authored: 'echo \'{"items":[{"repo":"a/b","number":1,"title":"T","state":"open"}],"complete":false}\'' } }] }).servers[0]!, runProcess);
    expect(await capped.list("authored", { state: "open" })).toMatchObject({ complete: false, rows: [{ number: 1 }] });
    expect(adapter.operations()).toEqual(["whoami", "authored", "mentioned", "view", "activity"]);
  });
});

describe("server workspaces", () => {
  const worktreePreset = parseConfig({ ...DEFAULT_CONFIG, presets: [{ id: "p", name: "P", default: true, workspace: "worktree", prompt: "x" }] }).presets[0]!;
  const row = (extra: Record<string, unknown> = {}) => ({ number: 7, repo: "acme/app", server: "lab", head: "abc", head_ref: "sam/fix it", base: "main", ...extra }) as never;

  it("fills a provider's inputs at any depth, and leaves the project's own workspace alone", async () => {
    const { workspaceFor } = await import("../src/workspaces");
    const provider = { kind: "provider" as const, provider: "my-trees", inputs: { tree: "shuttle-{number}", paths: ["src/{repo_name}"], depth: 1 } };
    expect(await workspaceFor(worktreePreset, provider, row(), runProcess)).toEqual({ kind: "provider", providerId: "my-trees", inputs: { tree: "shuttle-7", paths: ["src/app"], depth: 1 } });
    expect(await workspaceFor({ ...worktreePreset, workspace: "project-default" }, provider, row(), runProcess)).toEqual({ kind: "project-default" });
    expect(await workspaceFor(worktreePreset, undefined, row(), runProcess)).toEqual({ kind: "worktree" });
  });

  it("puts a provider's review on a new machine of its own, with the machine's inputs filled too", async () => {
    const { workspaceFor } = await import("../src/workspaces");
    const provider = { kind: "provider" as const, provider: "sandbox-checkout", inputs: { base: "origin/{head_ref}" }, machine: { provider: "sandbox", inputs: { revision: "{head}", paths: ["src/{repo_name}"] } } };
    expect(await workspaceFor(worktreePreset, provider, row(), runProcess)).toEqual({
      kind: "provider",
      providerId: "sandbox-checkout",
      inputs: { base: "origin/sam/fix it" },
      machine: { providerId: "sandbox", inputs: { revision: "abc", paths: ["src/app"] } },
    });
    expect(await workspaceFor({ ...worktreePreset, workspace: "project-default" }, provider, row(), runProcess)).toEqual({ kind: "project-default" });
  });

  it("reads a machine from TOML, with empty inputs by default, and refuses one that is not a provider id", () => {
    const toml = configToToml(testConfig()).replace("[[preset]]", '[server.workspace]\nkind = "provider"\nprovider = "sandbox-checkout"\n\n[server.workspace.machine]\nprovider = "sandbox"\n\n[[preset]]');
    expect(configFromToml(toml).servers[0]!.workspace).toEqual({ kind: "provider", provider: "sandbox-checkout", inputs: {}, machine: { provider: "sandbox", inputs: {} } });
    const bad = { ...TEST_SERVER, workspace: { kind: "provider", provider: "sandbox-checkout", machine: { provider: "Not An Id" } } };
    expect(() => parseConfig({ ...DEFAULT_CONFIG, servers: [bad] })).toThrow(/machine\.provider: must be a bb machine provider id/u);
    const command = { ...TEST_SERVER, workspace: { kind: "command", command: "echo /tmp", machine: { provider: "sandbox" } } };
    expect(() => parseConfig({ ...DEFAULT_CONFIG, servers: [command] })).toThrow(/machine/u);
  });

  it("runs a command with shell-quoted PR data and takes the path on its last line", async () => {
    const { workspaceFor } = await import("../src/workspaces");
    const command = { kind: "command" as const, command: "echo preparing >&2; echo noise; printf '/tmp/trees/%s\\n' {head_ref}" };
    expect(await workspaceFor(worktreePreset, command, row({ head_ref: "a; echo pwned" }), runProcess)).toEqual({ kind: "path", path: "/tmp/trees/a; echo pwned" });
    await expect(workspaceFor(worktreePreset, { kind: "command", command: "echo relative/path" }, row(), runProcess)).rejects.toThrow(/absolute path/u);
    await expect(workspaceFor(worktreePreset, { kind: "command", command: "echo nope >&2; exit 4" }, row(), runProcess)).rejects.toThrow(/exited 4: nope/u);
  });

  it("starts a review in the server's provider", async () => {
    const h = harness(testConfig({
      servers: [{ ...TEST_SERVER, workspace: { kind: "provider", provider: "my-trees", inputs: { tree: "shuttle-{number}" } } }],
      presets: [{ id: "p", name: "P", default: true, workspace: "worktree", prompt: "x" }],
    } as never));
    h.lists.review_requested = [pr(3)];
    await h.shuttle.sync();
    await h.shuttle.review({ key: "forge:acme/app#3" });
    expect(h.port.spawned[0]!.workspace).toEqual({ kind: "provider", providerId: "my-trees", inputs: { tree: "shuttle-3" } });
  });

  it("tests the review workspace against bb's providers: ids, a composition's own machine provider and inputs", async () => {
    const h = harness();
    const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
    h.port.environments = [
      { id: "my-trees", displayName: "My trees", description: null, inputs: schema({ tree: { type: "string", minLength: 1 } }, ["tree"]), machineProviderId: null },
      { id: "sandbox-checkout", displayName: "Sandbox checkout", description: null, inputs: schema({ base: { type: "string", pattern: "^[A-Za-z0-9._/-]+$" } }), machineProviderId: null },
      { id: "sandbox-full", displayName: "Sandbox with checkout", description: null, inputs: schema({ base: { type: "string" } }), machineProviderId: "sandbox" },
      { id: "bare", displayName: "Bare", description: null, inputs: null, machineProviderId: null },
    ];
    h.port.machines = [
      { id: "sandbox", displayName: "Sandbox", description: "A sandbox", inputs: schema({ cores: { type: "integer", maximum: 20 }, revision: { type: "string", pattern: "^[0-9a-f]{40}$" } }) },
      { id: "plain", displayName: "Plain", description: null, inputs: null },
    ];
    const workspaceRow = async (workspace: unknown) => {
      const results = await h.shuttle.testServer({ server: { ...TEST_SERVER, ...(workspace === undefined ? {} : { workspace }) } });
      const row = results.find((result) => result.operation === "workspace")!;
      return `${row.ok ? "ok" : "fail"}: ${row.detail}`;
    };
    expect(await workspaceRow(undefined)).toBe("ok: bb's git worktree, on the machine with the project's checkout");
    expect(await workspaceRow({ kind: "command", command: "echo /tmp" })).toBe("ok: a command prints the checkout's path; the test does not run it");
    expect(await workspaceRow({ kind: "provider", provider: "my-trees", inputs: { tree: "shuttle-{number}" } })).toBe("ok: My trees (my-trees), on the machine with the project's checkout");
    expect(await workspaceRow({ kind: "provider", provider: "sandbox-checkout", inputs: { base: "origin/{head_ref}" }, machine: { provider: "sandbox", inputs: { cores: 8, revision: "{head}" } } })).toBe("ok: Sandbox checkout (sandbox-checkout), on a new Sandbox machine (sandbox) for each review");
    expect(await workspaceRow({ kind: "provider", provider: "sandbox-full", inputs: {}, machine: { provider: "sandbox", inputs: {} } })).toBe("ok: Sandbox with checkout (sandbox-full), on a new Sandbox machine (sandbox) for each review");

    expect(await workspaceRow({ kind: "provider", provider: "sandbox-checkout", inputs: {}, machine: { provider: "plain", inputs: {} } })).toBe("ok: Sandbox checkout (sandbox-checkout), on a new Plain machine (plain) for each review");

    expect(await workspaceRow({ kind: "provider", provider: "nope", inputs: {} })).toBe('fail: bb has no environment provider "nope"; it has bare, my-trees, sandbox-checkout, sandbox-full');
    expect(await workspaceRow({ kind: "provider", provider: "sandbox-full", inputs: {} })).toBe("fail: Sandbox with checkout (sandbox-full) makes a new machine for each review with the machine provider sandbox, so the machine must be sandbox");
    expect(await workspaceRow({ kind: "provider", provider: "my-trees", inputs: {} })).toBe("fail: inputs.tree: Invalid input: expected string, received undefined");
    expect(await workspaceRow({ kind: "provider", provider: "sandbox-checkout", inputs: {}, machine: { provider: "gone", inputs: {} } })).toBe('fail: bb has no machine provider "gone"; it has plain, sandbox');
    expect(await workspaceRow({ kind: "provider", provider: "sandbox-checkout", inputs: {}, machine: { provider: "plain", inputs: { cores: 2 } } })).toBe("fail: machine.inputs: Plain (plain) takes none");
    expect(await workspaceRow({ kind: "provider", provider: "sandbox-checkout", inputs: {}, machine: { provider: "sandbox", inputs: { cores: 64 } } })).toMatch(/^fail: machine\.inputs\.cores: Too big/u);
    // Shuttle sends {} for an environment provider's empty inputs, since one with a schema refuses none at all.
    expect(await workspaceRow({ kind: "provider", provider: "bare", inputs: {} })).toBe("fail: inputs: Bare (bare) takes no inputs, and bb refuses the empty inputs Shuttle sends it");
  });

  it("starts a review on a new machine when the server's workspace names one", async () => {
    const h = harness(testConfig({
      servers: [{ ...TEST_SERVER, workspace: { kind: "provider", provider: "sandbox-checkout", inputs: {}, machine: { provider: "sandbox", inputs: { cores: 4 } } } }],
      presets: [{ id: "p", name: "P", default: true, workspace: "worktree", prompt: "x" }],
    } as never));
    h.lists.review_requested = [pr(3)];
    await h.shuttle.sync();
    await h.shuttle.review({ key: "forge:acme/app#3" });
    expect(h.port.spawned[0]!.workspace).toEqual({ kind: "provider", providerId: "sandbox-checkout", inputs: {}, machine: { providerId: "sandbox", inputs: { cores: 4 } } });
  });
});

describe("descriptions", () => {
  it("are read by view, kept through list syncs, and fetched once for a PR only lists have seen", async () => {
    const h = harness();
    h.lists.review_requested = [pr(3)];
    await h.shuttle.sync();
    expect(h.shuttle.detail("forge:acme/app#3").body).toBeNull();
    h.views[3] = pr(3, { body: "Explains the change" });
    await h.shuttle.refreshStale(["forge:acme/app#3"], 60_000);
    expect(h.shuttle.detail("forge:acme/app#3").body).toBe("Explains the change");
    await h.shuttle.sync();
    expect(h.shuttle.detail("forge:acme/app#3").body).toBe("Explains the change");
    h.views[4] = pr(4);
    await h.shuttle.lookup("forge:acme/app#4");
    expect(h.shuttle.detail("forge:acme/app#4").body).toBe("");
  });
});

describe("shell safety", () => {
  it("quotes server data in read commands, fills each placeholder once, and refuses hostile repo names", async () => {
    const { fillCommand } = await import("../src/adapters/exec");
    expect(fillCommand("lab pr view {number} -R {repo} {url}", "a/b", 3, "https://x/y?a=1&b=2")).toBe("lab pr view 3 -R a/b 'https://x/y?a=1&b=2'");
    expect(fillCommand("x {repo}", "a/b'; echo pwned", 1, "u")).toBe("x 'a/b'\\''; echo pwned'");
    const crafted = fillCommand("x -R {repo} {number}", "x{url}/y{number}", 7, "https://forge.test/p/7?tab=$(printf${IFS}INJECTED)");
    expect(crafted).toBe("x -R 'x{url}/y{number}' 7");
    const run = await runProcess("/bin/sh", ["-c", crafted.replace(/^x /u, "printf '%s\\n' ")], { timeoutMs: 5000 });
    expect(run.stdout).toBe("-R\nx{url}/y{number}\n7\n");
    const server = parseConfig({ ...DEFAULT_CONFIG, servers: [{ ...TEST_SERVER, commands: { view: 'echo \'{"repo":"a/b; echo pwned","number":1,"title":"T","state":"open"}\'' } }] }).servers[0]!;
    await expect(new CommandAdapter(server, runProcess).view("a/b", 1)).rejects.toThrow(/wrong shape: repo/u);
  });
});

describe("github adapter", () => {
  it("searches team requests without the ones that name the user", () => {
    expect(searchQuery("team_requested", {})).toContain("review-requested:@me -user-review-requested:@me");
    expect(searchQuery("authored", { state: "closed", since: "2026-10-01" })).toContain("is:closed updated:>=2026-10-01");
  });

  it("searches closed PRs from an exact time when it has one, which GitHub's search takes", () => {
    expect(searchQuery("authored", { state: "closed", since: "2026-10-23", sinceAt: "2026-10-23T11:55:00+00:00" })).toContain("is:closed updated:>=2026-10-23T11:55:00+00:00");
  });

  it("keeps real review activity, resolved threads marked, and failed checks", () => {
    const who = (login: string, bot = false) => ({ login, __typename: bot ? "Bot" : "User" });
    const activity = toActivity({
      headRefOid: "abc",
      reviews: { nodes: [
        { id: "R1", state: "CHANGES_REQUESTED", body: "Fix it", url: "u1", author: who("ana") },
        { id: "R2", state: "COMMENTED", body: "", url: null, author: who("ana") },
        { id: "R3", state: "PENDING", body: "draft", url: null, author: who("ana") },
      ] },
      reviewThreads: { nodes: [
        { id: "T1", isResolved: false, path: "a.rs", line: 4, comments: { nodes: [{ id: "C0", body: "first", url: null, author: who("ana") }, { id: "C1", body: "here", url: null, author: who("tom") }] } },
        { id: "T2", isResolved: true, path: "b.rs", line: 1, comments: { nodes: [{ id: "C2", body: "done", url: null, author: who("tom") }] } },
      ] },
      comments: { nodes: [{ id: "IC1", body: "lgtm", url: null, author: who("dependabot", true) }] },
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
        { __typename: "CheckRun", id: "CK1", name: "lint", conclusion: "FAILURE", detailsUrl: "d" },
        { __typename: "CheckRun", id: "CK2", name: "test", conclusion: "SUCCESS", detailsUrl: "d" },
      ] } } } }] },
    });
    expect(activity.items.map((i) => i.id)).toEqual(["R1:CHANGES_REQUESTED", "T1:C0", "T1:C1", "T2:C2", "IC1", "CK1:abc"]);
    expect(activity.items.map((i) => i.resolved)).toEqual([null, false, false, true, null, null]);
    expect(activity.items[4]!.bot).toBe(true);
  });
});

describe("reviews", () => {
  it("sends the prompt to an existing thread when asked, and refuses without a project", async () => {
    const h = harness();
    h.lists.review_requested = [pr(3), pr(4, { repo: "x/unknown" })];
    await h.shuttle.sync();
    h.port.addThread("thr_mine", "Mine");
    await h.shuttle.review({ key: "forge:acme/app#3", threadId: "thr_mine", note: "focus on filters" });
    expect(h.port.sent[0]).toMatchObject({ threadId: "thr_mine" });
    expect(h.port.sent[0]!.text).toContain("Note from me: focus on filters");
    await expect(h.shuttle.review({ key: "forge:x/unknown#4" })).rejects.toThrow(/no bb project matches x\/unknown/u);
    h.settings.defaultProject = "proj_app";
    await h.shuttle.review({ key: "forge:x/unknown#4" });
    expect(h.port.spawned[0]).toMatchObject({ projectId: "proj_app", workspace: { kind: "project-default" } });
  });

  it("files review threads in the configured section, and still starts them when the section cannot be made", async () => {
    const h = harness();
    h.lists.review_requested = [pr(3), pr(4)];
    await h.shuttle.sync();
    h.settings.reviewSection = "PR reviews";
    await h.shuttle.review({ key: "forge:acme/app#3" });
    await h.shuttle.review({ key: "forge:acme/app#4" });
    expect(h.port.spawned.map((s) => s.sectionId)).toEqual(["sec_1", "sec_1"]);
    h.port.failSections = true;
    await h.shuttle.review({ key: "forge:acme/app#3", newThread: true });
    expect(h.port.spawned[2]!.sectionId).toBeUndefined();
    expect(h.shuttle.activity().some((e) => e.kind === "section_failed")).toBe(true);
    const owner = await h.shuttle.newThread("forge:acme/app#4", "own");
    expect(h.port.spawned.find((s) => s.threadId === owner)!.sectionId).toBeUndefined();
  });

  it("starts an owner thread that is linked and watched for my PR", async () => {
    const h = harness();
    h.lists.authored = [pr(1, { author: "me" })];
    await h.shuttle.sync();
    const threadId = await h.shuttle.newThread("forge:acme/app#1", "own");
    expect(h.shuttle.view("forge:acme/app#1")).toMatchObject({ watch: "act", links: [{ threadId, role: "owner" }] });
  });
});
