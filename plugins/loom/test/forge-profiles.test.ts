// Forge profiles: command forges kept in Loom's settings that a spec names by id. A spec stores only the id, so an edit
// reaches every project that uses the profile at its next forge call, and each change is recorded where it runs.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createCli } from "../src/cli";
import { specOf } from "../src/ctx";
import { forgeCheck, forgeTest, formatForgeTest } from "../src/forge-check";
import { deleteProfile, importProfiles, PROFILE_CHANGED, profileHash, profilesToml, profileUses, saveProfile } from "../src/forge-profiles";
import { pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import type { SpawnArgs } from "../src/ports";
import { parseSpec, readSpec, type ForgeProfile } from "../src/spec";
import { Clock, FakePort, makeCtx, makeHost, reachApproved, seedProject, startWorker, specToml, ticketOf, type Doc, type EngineHarness } from "./helpers";

const FORGE: ForgeProfile = {
  id: "forge",
  name: "Forge",
  kind: "command",
  open: "forge pr create",
  state: "forge pr state",
  feedback: "forge pr feedback",
  ready: "forge pr ready",
  notes: "The review bot clears a finding when a push fixes it; never resolve its threads.",
};

let h: EngineHarness;
beforeEach(() => {
  h = makeCtx();
});

const project = () => h.store.projectBySlug("csv")!;
const usesProfile = (extra: Doc = {}) => (doc: Doc) => {
  doc.merge = { strategy: "pr", forge: { profile: "forge", ...extra }, describe: "loom" };
};
const queue = async () => {
  await runMergeQueue(h.ctx, project(), specOf(h.store, project()));
  await settleMerges(h.ctx);
};
const poll = async () => {
  h.clock.advance(5 * 60_000);
  await pollPullRequests(h.ctx, project());
};

describe("a spec that names a forge profile", () => {
  it("is checked with the profile's commands and stored with only its id", () => {
    saveProfile(h.store, FORGE, null);
    const parsed = parseSpec(specToml(usesProfile()), h.store);
    expect(parsed.errors).toEqual([]);
    expect(parsed.spec!.merge.forge).toEqual({ kind: "command", profile: "forge" });
    const runs = readSpec(JSON.stringify(parsed.spec), h.store).merge.forge!;
    expect(runs).toMatchObject({ kind: "command", profile: "forge", open: "forge pr create", feedback: "forge pr feedback", ready: "forge pr ready" });
  });

  it("refuses a profile Loom does not have, naming the ones it has, and a profile on a forge that is not a command forge", () => {
    expect(parseSpec(specToml(usesProfile())).errors).toEqual([expect.stringContaining('merge.forge.profile: Loom has no forge profile "forge". It has none yet')]);
    saveProfile(h.store, { ...FORGE, id: "other" }, null);
    expect(parseSpec(specToml(usesProfile()), h.store).errors).toEqual(['merge.forge.profile: Loom has no forge profile "forge". Use one of: other.']);
    expect(parseSpec(specToml((doc) => (doc.merge = { strategy: "pr", forge: { kind: "gh", profile: "other" } })), h.store).errors[0]).toContain('merge.forge.kind: a forge profile is a command forge');
  });

  it("lets the spec's own keys win over the profile's, and checks the forge as it would run", () => {
    saveProfile(h.store, { ...FORGE, ignore_checks: ["reviews"] }, null);
    const parsed = parseSpec(specToml(usesProfile({ ignore_checks: ["lint"], state: "my state" })), h.store);
    expect(readSpec(JSON.stringify(parsed.spec), h.store).merge.forge).toMatchObject({ ignore_checks: ["lint"], state: "my state", open: "forge pr create" });
    // The profile has no merge command, so auto_merge with method = "command" is refused as on a spec's own forge.
    const merging = parseSpec(specToml(usesProfile({ auto_merge: { method: "command", rejected: ["no*"] } })), h.store);
    expect(merging.errors).toContain('merge.forge.merge: is required with auto_merge on a kind = "command" forge. Add the command that merges the pull request in LOOM_URL, or hands it to the server\'s merge service.');
  });

  it("is refused at loom_propose when the profile is unknown", async () => {
    await expect(h.projects.propose({ toml: specToml(usesProfile()), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_1" })).rejects.toThrow('Loom has no forge profile "forge"');
  });
});

describe("a running project on a forge profile", () => {
  it("opens and reads its pull requests with the profile's commands, and an edit to the profile takes effect at the next read", async () => {
    saveProfile(h.store, FORGE, null);
    await seedProject(h, usesProfile());
    expect(JSON.parse(h.store.specVersion(project().id, 1)!.spec_json).merge.forge).toEqual({ kind: "command", profile: "forge" });
    await reachApproved(h);
    await queue();
    expect(h.host.callsTo("prCreate")[0]).toMatchObject({ forge: { kind: "command", open: "forge pr create" } });
    const url = ticketOf(h, "CSV-1").pr_url!;
    await poll();
    expect(h.host.callsTo("prFeedback").at(-1)).toEqual({ repo: "/repo", url, forge: { kind: "command", feedback: "forge pr feedback" } });

    const before = h.store.forgeProfileRow("forge")!.hash;
    const saved = saveProfile(h.store, { ...FORGE, feedback: "forge pr feedback --v2" }, "forge");
    expect(saved).toMatchObject({ changed: true, told: ["csv"] });
    await poll();
    expect(h.host.callsTo("prFeedback").at(-1)).toEqual({ repo: "/repo", url, forge: { kind: "command", feedback: "forge pr feedback --v2" } });

    const events = h.store.projectEvents(project().id).filter((event) => event.kind === PROFILE_CHANGED);
    expect(events.map((event) => JSON.parse(event.data_json))).toEqual([{ profile: "forge", hash: saved.hash, was: before }]);
    const post = h.store.posts(ticketOf(h, "CSV-1").id).filter((each) => each.kind === "system").at(-1)!;
    expect(post.body).toBe(`The forge profile Forge (forge) changed, from version ${before} to ${saved.hash}: Loom runs its new commands from its next call to the forge.`);
  });

  it("marks a draft ready with the profile's ready command, and needs no after_open script for it", async () => {
    saveProfile(h.store, FORGE, null);
    await seedProject(h, usesProfile());
    await reachApproved(h);
    await queue();
    expect(h.host.callsTo("prReady")).toEqual([{ repo: "/repo", url: ticketOf(h, "CSV-1").pr_url, forge: { kind: "command", ready: "forge pr ready" } }]);
  });

  it("records nothing when a save changes nothing", async () => {
    saveProfile(h.store, FORGE, null);
    await seedProject(h, usesProfile());
    expect(saveProfile(h.store, { ...FORGE }, "forge")).toMatchObject({ changed: false, told: [] });
    expect(h.store.projectEvents(project().id).filter((event) => event.kind === PROFILE_CHANGED)).toEqual([]);
  });

  it("tells workers and reviewers the profile's notes", async () => {
    saveProfile(h.store, FORGE, null);
    await seedProject(h, usesProfile());
    await startWorker(h);
    const prompt = (h.bb.callsTo("spawnThread")[0]![0] as SpawnArgs).prompt;
    expect(prompt).toContain(`## About this forge\n${FORGE.notes}`);
  });

  it("keeps a profile a project uses, and deletes one no project uses", async () => {
    saveProfile(h.store, FORGE, null);
    saveProfile(h.store, { ...FORGE, id: "spare" }, null);
    await seedProject(h, usesProfile());
    expect(profileUses(h.store, "forge")).toEqual([{ slug: "csv", name: "CSV export", state: "running", inForce: true }]);
    expect(() => deleteProfile(h.store, "forge")).toThrow("The forge profile forge is in use by csv, so Loom keeps it.");
    deleteProfile(h.store, "spare");
    expect(h.store.forgeProfileIds()).toEqual(["forge"]);
  });

  it("keeps a profile that any stored spec version names, an archived project's or an older version's, so their history stays readable", async () => {
    saveProfile(h.store, FORGE, null);
    saveProfile(h.store, { ...FORGE, id: "other" }, null);
    await seedProject(h, usesProfile());
    h.store.updateProject(project().id, { state: "archived" });
    expect(profileUses(h.store, "forge")).toEqual([]);
    expect(() => deleteProfile(h.store, "forge")).toThrow("The forge profile forge is named by a stored spec of csv (v1), so Loom keeps it");
    expect(() => specOf(h.store, project())).not.toThrow();
    expect(h.store.forgeProfileIds()).toEqual(["forge", "other"]);
  });

  it("keeps a profile only an older version names, after the project moved to its own commands", async () => {
    saveProfile(h.store, FORGE, null);
    await seedProject(h, usesProfile());
    await h.projects.propose({ toml: specToml((doc) => (doc.merge = { strategy: "pr", forge: { kind: "command", open: "mine open", state: "mine state" }, describe: "loom" })), threadId: "thr_plan", bbProjectId: "proj_1", hostId: "host_1" });
    await h.projects.approve("csv", "human", 2);
    expect(project().approved_version).toBe(2);
    expect(profileUses(h.store, "forge")).toEqual([]);
    expect(() => deleteProfile(h.store, "forge")).toThrow("named by a stored spec of csv (v1)");
    expect(() => readSpec(h.store.specVersion(project().id, 1)!.spec_json, h.store)).not.toThrow();
  });

  it("refuses an id that changes, and a new profile whose id is taken", () => {
    saveProfile(h.store, FORGE, null);
    expect(() => saveProfile(h.store, { ...FORGE, id: "forge2" }, "forge")).toThrow("A forge profile's id cannot change");
    expect(() => saveProfile(h.store, FORGE, null)).toThrow("Loom has a forge profile forge already");
    expect(() => saveProfile(h.store, { id: "x", name: "X", open: "o" }, null)).toThrow("The forge profile is not valid: state:");
  });

  it("says which profile version a forge check ran", async () => {
    saveProfile(h.store, FORGE, null);
    await seedProject(h, usesProfile());
    await reachApproved(h);
    await queue();
    const check = await forgeCheck(h.ctx, { slug: "csv", target: "CSV-1" });
    expect(check.profile).toEqual({ id: "forge", hash: profileHash(FORGE) });
  });
});

describe("checking a profile before it is saved", () => {
  it("refuses a profile whose review gate lacks a command, or sets review_rounds with no gate, on save and on import", () => {
    expect(() => saveProfile(h.store, { ...FORGE, review_start: "bot start" }, null)).toThrow("review_read: is required with review_start");
    expect(() => saveProfile(h.store, { ...FORGE, review_rounds: 2 }, null)).toThrow("review_rounds: only a review gate uses it");
    expect(() => importProfiles(h.store, '[[forge]]\nid = "lab"\nname = "Lab"\nopen = "o"\nstate = "s"\nreview_read = "r"\n', false)).toThrow("review_start: is required with review_read");
    expect(h.store.forgeProfileIds()).toEqual([]);
  });

  it("refuses an edit that would leave a project unable to run, names the project and the field, and keeps the profile", async () => {
    const gated: ForgeProfile = { ...FORGE, review_start: "bot start", review_read: "bot read" };
    saveProfile(h.store, gated, null);
    await seedProject(h, (doc) => (doc.merge = { strategy: "pr", publish: {}, forge: { profile: "forge" } }));
    const before = h.store.forgeProfileRow("forge")!;
    const { review_read: _read, ...noRead } = gated;
    expect(() => saveProfile(h.store, noRead, "forge")).toThrow("review_read: is required with review_start");
    const { ready: _ready, ...noReady } = gated;
    expect(() => saveProfile(h.store, noReady, "forge")).toThrow(
      "Loom kept the forge profile forge as it was: the edit would leave csv (spec v1) unable to run: merge.forge: merge.publish marks drafts ready, and this forge has no ready command.",
    );
    expect(() => importProfiles(h.store, profilesToml(h.store).replace(/ready = "forge pr ready"\n/u, ""), false)).toThrow("the edit would leave csv (spec v1) unable to run");
    expect(h.store.forgeProfileRow("forge")).toEqual(before);
    expect(h.store.projectEvents(project().id).filter((event) => event.kind === PROFILE_CHANGED)).toEqual([]);
    expect(saveProfile(h.store, { ...gated, notes: "Answer the bot once." }, "forge")).toMatchObject({ changed: true, told: ["csv"] });
    expect(h.store.latestSpecVersion(project().id)!.version).toBe(1);
  });
});

describe("a spec with the forge's commands inline", () => {
  it("reads as it did: no profile is looked up", async () => {
    const inline = { kind: "command", open: "review create", state: "review state" };
    await seedProject(h, (doc) => (doc.merge = { strategy: "pr", forge: inline, describe: "loom" }));
    expect(specOf(h.store, project()).merge.forge).toEqual(inline);
  });
});

describe("testing a profile", () => {
  it("runs only its state and feedback commands, in the home directory of bb's machine", async () => {
    const all: ForgeProfile = { ...FORGE, edit: "forge edit", reply: "forge reply", merge: "forge merge", request_reviews: "forge ask", after_open: ["forge ci"], after_push: ["forge ci"] };
    const url = "https://forge.example.com/acme/shop/pull/7";
    h.host.feedback.set(url, { head: "abc123", checks: [{ key: "check:1", name: "build", state: "passed", url: null, started: null, startedAt: null, completedAt: null, progress: null, steps: null }] });
    const test = await forgeTest(h.ctx, all, profileHash(all), url);
    expect(h.host.calls.map((call) => call.method)).toEqual(["homeDir", "prState", "prFeedback"]);
    expect(h.host.callsTo("prState")).toEqual([{ repo: "/home/dev", url, forge: { kind: "command", state: "forge pr state" } }]);
    expect(test.state).toEqual({ runs: "forge pr state", state: "OPEN", failure: null });
    const text = formatForgeTest(test);
    expect(text).toContain("It ran only its state and feedback commands");
    expect(text).toContain("Checks: 1\n  passed  build  (check:1)");
  });

  it("says which field the feedback command got wrong", async () => {
    h.host.scripted.prFeedback = [{ outcome: "unavailable", message: "The forge's feedback command must print a JSON object on its last line; head: Invalid input: expected string, received undefined: {}" }];
    const test = await forgeTest(h.ctx, FORGE, null, "https://forge.example.com/acme/shop/pull/7");
    expect(formatForgeTest(test)).toContain("The read failed: The forge's feedback command must print a JSON object on its last line; head:");
  });
});

describe("export and import", () => {
  it("round-trips the profiles as [[forge]] tables, says what an import changes, and saves only with apply", async () => {
    saveProfile(h.store, FORGE, null);
    await seedProject(h, usesProfile());
    const toml = profilesToml(h.store);
    expect(toml).toContain('[[forge]]\nid = "forge"');
    expect(importProfiles(h.store, toml, false)).toEqual({ changes: [] });
    const edited = toml.replace('state = "forge pr state"', 'state = "forge pr state --json"') + '\n[[forge]]\nid = "lab"\nname = "Lab"\nopen = "lab open"\nstate = "lab state"\n';
    expect(importProfiles(h.store, edited, false)).toEqual({ changes: ["changes forge profile forge, which csv uses now", "adds forge profile lab"] });
    expect(h.store.forgeProfile("forge")!.state).toBe("forge pr state");
    importProfiles(h.store, edited, true);
    expect(h.store.forgeProfile("forge")!.state).toBe("forge pr state --json");
    expect(h.store.forgeProfileIds()).toEqual(["forge", "lab"]);
    expect(() => importProfiles(h.store, "[server]\nid = 1", false)).toThrow("Unknown table server");
  });
});

describe("bb loom forge", () => {
  it("lists, shows, tests, exports and imports profiles", async () => {
    const fake = new FakePort();
    const clock = new Clock();
    const host = makeHost({ port: fake, clock });
    host.bb.cli.register(createCli(host.projects, host.engine, host.store, clock.now));
    const cli = (argv: string[], threadId?: string) => host.harness.runCli(argv, threadId === undefined ? undefined : { threadId });
    const dir = mkdtempSync(join(tmpdir(), "loom-forge-"));
    const file = join(dir, "forges.toml");
    writeFileSync(file, '[[forge]]\nid = "forge"\nname = "Forge"\nopen = "forge pr create"\nstate = "forge pr state"\n');

    expect((await cli(["forge", "list"])).stdout).toContain("No forge profiles.");
    expect((await cli(["forge", "import", file])).stdout).toBe("Importing would make 1 change:\n- adds forge profile forge\nRun it again with --apply to save them.\n");
    expect(host.store.forgeProfileIds()).toEqual([]);
    expect((await cli(["forge", "import", file, "--apply"])).stdout).toBe("Imported 1 change:\n- adds forge profile forge\n");
    const hash = host.store.forgeProfileRow("forge")!.hash;
    expect((await cli(["forge", "list"])).stdout).toBe(`forge  Forge  version ${hash}  used by no project\n`);
    expect((await cli(["forge", "show", "forge"])).stdout).toContain(`version ${hash}`);
    expect((await cli(["forge", "export"])).stdout).toContain('id = "forge"');
    const tested = await cli(["forge", "test", "forge", "https://forge.example.com/acme/shop/pull/7"]);
    expect(tested).toMatchObject({ exitCode: 0 });
    expect(tested.stdout).toContain("feedback: none, so Loom reads only the state");
  });
});
