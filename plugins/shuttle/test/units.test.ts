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
    expect(parseLink("https://forge.test/shop/world/pull/12", servers)).toEqual({ server: "forge", repo: "shop/world", number: 12 });
    expect(() => resolveQuery("nope:a/b#1", servers)).toThrow(/no server called nope/u);
    expect(() => resolveQuery("hello", servers)).toThrow(/no server's link pattern/u);
  });
});

describe("projects", () => {
  it("matches a repo to a project by remote, then by repository name, then the default", () => {
    const projects = [
      { id: "a", name: "world", gitRemoteUrl: "git@github.com:Shopify/world.git" },
      { id: "b", name: "bb", gitRemoteUrl: "https://github.com/get-bb/bb" },
    ];
    expect(remotePath("git@github.com:Shopify/world.git")).toBe("shopify/world");
    expect(matchProject("get-bb/bb", projects, null)).toBe("b");
    expect(matchProject("shop/world", projects, null)).toBe("a");
    expect(matchProject("x/y", projects, "b")).toBe("b");
    expect(matchProject("x/y", projects, null)).toBeNull();
  });
});

describe("templates and globs", () => {
  it("fills known variables and leaves unknown ones", () => {
    expect(renderTemplate("{url} {nope}", { url: "u" })).toBe("u {nope}");
    expect(globMatch("get-bb/*", "get-bb/bb")).toBe(true);
    expect(globMatch("shop/world", "Shop/World")).toBe(true);
    expect(globMatch("shop/*", "other/x")).toBe(false);
  });
});

describe("command adapter", () => {
  const server = parseConfig({ ...DEFAULT_CONFIG, servers: [{ ...TEST_SERVER, commands: { whoami: "echo me", view: 'printf \'{"repo":"%s","number":%s,"title":"T","state":"open","draft":true}\' "$SHUTTLE_REPO" "$SHUTTLE_NUMBER"', activity: "echo nope", authored: "echo oops >&2; exit 3", mentioned: 'echo \'[{"repo":"a/b","number":"x"}]\'' } }] }).servers[0]!;
  const adapter = new CommandAdapter(server, runProcess);

  it("runs real shell commands with the PR in the environment", async () => {
    expect(await adapter.whoami()).toBe("me");
    const view = await adapter.view("shop/world", 7);
    expect(view).toMatchObject({ repo: "shop/world", number: 7, state: "draft", url: "https://forge.test/shop/world/pull/7", checks: "none" });
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

describe("shell safety", () => {
  it("quotes server data in read commands and refuses hostile repo names", async () => {
    const { fillCommand } = await import("../src/adapters/exec");
    expect(fillCommand("dt pr view {number} -R {repo} {url}", "a/b", 3, "https://x/y?a=1&b=2")).toBe("dt pr view 3 -R a/b 'https://x/y?a=1&b=2'");
    expect(fillCommand("x {repo}", "a/b'; echo pwned", 1, "u")).toBe("x 'a/b'\\''; echo pwned'");
    const server = parseConfig({ ...DEFAULT_CONFIG, servers: [{ ...TEST_SERVER, commands: { view: 'echo \'{"repo":"a/b; echo pwned","number":1,"title":"T","state":"open"}\'' } }] }).servers[0]!;
    await expect(new CommandAdapter(server, runProcess).view("a/b", 1)).rejects.toThrow(/wrong shape: repo/u);
  });
});

describe("github adapter", () => {
  it("searches team requests without the ones that name the user", () => {
    expect(searchQuery("team_requested", {})).toContain("review-requested:@me -user-review-requested:@me");
    expect(searchQuery("authored", { state: "closed", since: "2026-10-01" })).toContain("is:closed updated:>=2026-10-01");
  });

  it("keeps real review activity and failed checks", () => {
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
    expect(activity.items.map((i) => i.id)).toEqual(["R1:CHANGES_REQUESTED", "T1:C0", "T1:C1", "IC1", "CK1:abc"]);
    expect(activity.items[3]!.bot).toBe(true);
  });
});

describe("reviews", () => {
  it("sends the prompt to an existing thread when asked, and refuses without a project", async () => {
    const h = harness();
    h.lists.review_requested = [pr(3), pr(4, { repo: "x/unknown" })];
    await h.shuttle.sync();
    h.port.addThread("thr_mine", "Mine");
    await h.shuttle.review({ key: "forge:shop/world#3", threadId: "thr_mine", note: "focus on filters" });
    expect(h.port.sent[0]).toMatchObject({ threadId: "thr_mine" });
    expect(h.port.sent[0]!.text).toContain("Note from me: focus on filters");
    await expect(h.shuttle.review({ key: "forge:x/unknown#4" })).rejects.toThrow(/no bb project matches x\/unknown/u);
    h.settings.defaultProject = "proj_world";
    await h.shuttle.review({ key: "forge:x/unknown#4" });
    expect(h.port.spawned[0]).toMatchObject({ projectId: "proj_world", workspace: "project-default" });
  });

  it("files review threads in the configured section, and still starts them when the section cannot be made", async () => {
    const h = harness();
    h.lists.review_requested = [pr(3), pr(4)];
    await h.shuttle.sync();
    h.settings.reviewSection = "PR reviews";
    await h.shuttle.review({ key: "forge:shop/world#3" });
    await h.shuttle.review({ key: "forge:shop/world#4" });
    expect(h.port.spawned.map((s) => s.sectionId)).toEqual(["sec_1", "sec_1"]);
    h.port.failSections = true;
    await h.shuttle.review({ key: "forge:shop/world#3" });
    expect(h.port.spawned[2]!.sectionId).toBeUndefined();
    expect(h.shuttle.activity().some((e) => e.kind === "section_failed")).toBe(true);
    const owner = await h.shuttle.newThread("forge:shop/world#4", "own");
    expect(h.port.spawned.find((s) => s.threadId === owner)!.sectionId).toBeUndefined();
  });

  it("starts an owner thread that is linked and watched for my PR", async () => {
    const h = harness();
    h.lists.authored = [pr(1, { author: "me" })];
    await h.shuttle.sync();
    const threadId = await h.shuttle.newThread("forge:shop/world#1", "own");
    expect(h.shuttle.view("forge:shop/world#1")).toMatchObject({ watch: "act", links: [{ threadId, role: "owner" }] });
  });
});
