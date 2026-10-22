import type { NewThreadRequest } from "@get-bb/plugin-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/db/store";
import type { BbProjectInfo } from "../src/ports";
import { LoomError, Projects } from "../src/projects";
import { Clock, FakePort, makeDb, specToml, type Doc } from "./helpers";

let clock: Clock;
let store: Store;
let bb: FakePort;
let projects: Projects;

beforeEach(() => {
  clock = new Clock();
  store = new Store(makeDb(), clock.now);
  bb = new FakePort();
  projects = new Projects({ store, bb, now: clock.now });
});

const propose = (edit?: (doc: Doc) => void, threadId = "thr_plan") => projects.propose({ toml: specToml(edit), threadId, bbProjectId: "proj_1", hostId: "host_local" });

async function failure(promise: Promise<unknown>): Promise<LoomError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(LoomError);
  return error as LoomError;
}

const eventKinds = (projectId: number) => store.events(projectId).map((event) => event.kind);

describe("propose", () => {
  it("creates a draft with a section, a planner row and the planner moved into the section", async () => {
    const result = await propose();
    expect(result).toEqual({ slug: "csv", version: 1, state: "draft", warnings: [], pending: false, change: "created" });

    const project = store.projectBySlug("csv")!;
    expect(project).toMatchObject({ name: "CSV export", key: "CSV", state: "draft", bb_project_id: "proj_1", host_id: "host_local", section_id: "sec_1", planner_thread_id: "thr_plan", approved_version: null });
    expect(store.threadByThreadId("thr_plan")).toMatchObject({ role: "planner", state: "active", project_id: project.id });
    expect(store.specVersion(project.id, 1)).toMatchObject({ proposed_by: "thr_plan" });
    expect(bb.callsTo("ensureSection")).toEqual([[null, "Loom · CSV export (csv)"]]);
    expect(bb.callsTo("moveThread")).toEqual([["thr_plan", "sec_1"]]);
    expect(bb.callsTo("setMetadata")).toEqual([["thr_plan", { project: "csv", role: "planner" }]]);
    expect(eventKinds(project.id)).toEqual(["project.created", "spec.proposed"]);
  });

  it("refuses an invalid spec with numbered errors and creates nothing", async () => {
    const error = await failure(propose((doc) => (doc.project.key = "csv")));
    expect(error.code).toBe("loom_invalid_spec");
    expect(error.message).toContain("Spec not saved.");
    expect(error.message).toMatch(/\n1\. project\.key: /);
    expect(store.projects()).toEqual([]);
    expect(bb.callsTo("ensureSection")).toEqual([]);
  });

  it("refuses a worker or reviewer provider bb does not have, naming the ids it has", async () => {
    bb.providers = ["pi", "codex", "claude-code"];
    const error = await failure(
      propose((doc) => {
        doc.agents.worker = { provider: "codex" };
        doc.agents.reviewer = { provider: "claude", model: "sonnet" };
      }),
    );
    expect(error.code).toBe("loom_invalid_spec");
    expect(error.message).toContain('\n1. agents.reviewer.provider: bb has no provider "claude". Use one of: claude-code, codex, pi.');
    expect(store.projects()).toEqual([]);

    const both = await failure(propose((doc) => (doc.agents.reviewer = { provider: "gemini" })));
    expect(both.message).toContain('1. agents.worker.provider: bb has no provider "claude".');
    expect(both.message).toContain('2. agents.reviewer.provider: bb has no provider "gemini".');
  });

  it("checks no provider when the spec sets none, and accepts the spec when bb's providers cannot be read or bb lists none", async () => {
    bb.providers = [];
    await propose((doc) => (doc.agents = {}));
    expect(bb.callsTo("providerIds")).toEqual([]);
    expect(await propose((doc) => (doc.project.goal = "Export orders as CSV, with a delimiter and a date range filter."))).toMatchObject({ version: 2 });
    bb.providers = new Error("bb is restarting");
    expect(await propose((doc) => (doc.project.goal = "Export orders as CSV, with a delimiter the person can choose."))).toMatchObject({ version: 3 });
    expect(bb.callsTo("log").some(([level, text]) => level === "warn" && String(text).includes("bb is restarting"))).toBe(true);
  });

  it("revising a draft adds a version and keeps the old one", async () => {
    await propose();
    const result = await propose((doc) => (doc.project.goal = "Export orders and customers as CSV files from the admin page."));
    expect(result).toMatchObject({ version: 2, state: "draft", pending: false, change: "revised" });
    const project = store.projectBySlug("csv")!;
    expect(store.specVersion(project.id, 1)?.toml).not.toContain("orders and customers");
    expect(store.specVersion(project.id, 2)?.toml).toContain("orders and customers");
    expect(eventKinds(project.id)).toEqual(["project.created", "spec.proposed", "spec.proposed"]);
    expect(projects.spec("csv", 1).status).toBe("superseded");
    expect(projects.spec("csv")).toMatchObject({ version: 2, status: "draft" });
    expect((await failure(projects.approve("csv", "human", 1))).message).toContain("is not the one waiting for approval (version 2)");
    expect(await projects.approve("csv", "human")).toMatchObject({ version: 2, applied: "draft" });
    expect(bb.callsTo("ensureSection")).toEqual([
      [null, "Loom · CSV export (csv)"],
      ["sec_1", "Loom · CSV export (csv)"],
    ]);
  });

  it("renames the section when a draft revision changes the name or key", async () => {
    await propose();
    await propose((doc) => {
      doc.project.name = "Orders CSV";
      doc.project.key = "ORD";
    });
    expect(store.projectBySlug("csv")).toMatchObject({ name: "Orders CSV", key: "ORD" });
    expect(bb.callsTo("renameSection")).toEqual([["sec_1", "Loom · Orders CSV (csv)"]]);
  });

  it("proposing an identical spec is a no-op that returns the existing version", async () => {
    await propose();
    const project = store.projectBySlug("csv")!;
    const before = store.events(project.id).length;
    const again = await propose();
    expect(again).toMatchObject({ version: 1, change: "unchanged", pending: false });
    expect(store.events(project.id)).toHaveLength(before);
  });

  it("a revision after approval becomes a pending version and leaves the tickets alone", async () => {
    await propose();
    await projects.approve("csv", "human");
    const result = await propose((doc) => {
      doc.project.goal = "Export orders as CSV, with a delimiter the person can choose.";
      doc.ticket[0].title = "Changed title";
    });
    expect(result).toMatchObject({ version: 2, state: "ready", pending: true, change: "pending" });
    expect(result.warnings).toContain("Ticket changes after approval go through the planner's board tools.");
    const project = store.projectBySlug("csv")!;
    expect(project).toMatchObject({ approved_version: 1, pending_version: 2 });
    expect(store.tickets(project.id).map((ticket) => ticket.title)).toEqual(["Order rows", "Export endpoint"]);

    const third = await propose((doc) => (doc.project.goal = "Export orders as CSV, with a delimiter and a date range filter."));
    expect(third).toMatchObject({ version: 3, pending: true });
    expect(store.projectBySlug("csv")?.pending_version).toBe(3);

    const same = await propose((doc) => (doc.project.goal = "Export orders as CSV, with a delimiter and a date range filter."));
    expect(same).toMatchObject({ version: 3, pending: true, change: "unchanged" });
  });

  it("refuses a proposal from a thread that is not the planner", async () => {
    await propose();
    const error = await failure(propose(undefined, "thr_other"));
    expect(error.code).toBe("loom_invalid_spec");
    expect(error.message).toContain('1. project.slug: "csv" is already a Loom project and this thread is not its planner. Choose another slug.');
    expect(store.projects()).toHaveLength(1);
  });

  it("refuses a planner proposing a different slug", async () => {
    await propose();
    const error = await failure(propose((doc) => (doc.project.slug = "other")));
    expect(error.message).toContain("1. This thread already plans csv; a revision must keep that slug.");
    expect(store.projectBySlug("other")).toBeNull();
  });

  it("refuses a key used by another project, archived ones included", async () => {
    await propose();
    await projects.archive("csv", "human");
    const error = await failure(propose((doc) => (doc.project.slug = "csv-two"), "thr_two"));
    expect(error.message).toContain('1. project.key: "CSV" is used by project csv. Choose another key.');
    expect(store.projectBySlug("csv-two")).toBeNull();
  });

  it("refuses to change the key or the merge setup after approval", async () => {
    await propose();
    await projects.approve("csv", "human");
    const key = await failure(propose((doc) => (doc.project.key = "XYZ")));
    expect(key.message).toContain('project.key: cannot change from "CSV" to "XYZ" after approval, because ticket keys already use it.');
    const strategy = await failure(propose((doc) => (doc.merge = { strategy: "pr" })));
    expect(strategy.message).toContain('merge.strategy: cannot change from "integration" to "pr" after approval');
    const branch = await failure(propose((doc) => (doc.merge = { strategy: "integration", branch: "other/branch" })));
    expect(branch.message).toContain('merge.branch: cannot change from "loom/csv" to "other/branch" after approval');
    expect(store.projectBySlug("csv")?.pending_version).toBeNull();
  });

  it("refuses a revision of an archived project", async () => {
    await propose();
    await projects.archive("csv", "human");
    const error = await failure(propose((doc) => (doc.project.key = "CSV")));
    expect(error.message).toContain("Project csv is archived.");
  });

  it("refuses worker and reviewer threads", async () => {
    await propose();
    const project = store.projectBySlug("csv")!;
    store.addThread({ thread_id: "thr_worker", project_id: project.id, role: "worker", state: "active" });
    const error = await failure(propose((doc) => (doc.project.slug = "other"), "thr_worker"));
    expect(error.message).toContain("Workers and reviewers cannot propose projects.");
  });

  it("refuses when bb already has a section with that name, and creates nothing", async () => {
    bb.takenNames.add("Loom · CSV export (csv)");
    const error = await failure(propose());
    expect(error.code).toBe("loom_invalid_spec");
    expect(error.message).toContain('1. A sidebar section named "Loom · CSV export (csv)" already exists. Rename it, or choose another slug.');
    expect(store.projects()).toEqual([]);
    expect(bb.callsTo("moveThread")).toEqual([]);
  });

  it("deletes the section it just made when saving the project fails", async () => {
    const original = store.createProject.bind(store);
    store.createProject = () => {
      throw new Error("disk full");
    };
    await expect(propose()).rejects.toThrow("disk full");
    store.createProject = original;
    expect(bb.callsTo("deleteSection")).toEqual([["sec_1"]]);
  });

  it("keeps the project when moving the thread fails, and logs a warning", async () => {
    bb.moveThread = async () => {
      throw new Error("bb is down");
    };
    const result = await propose();
    expect(result.state).toBe("draft");
    expect(store.projectBySlug("csv")).not.toBeNull();
    expect(bb.callsTo("log").some(([level, text]) => level === "warn" && String(text).includes("bb is down"))).toBe(true);
  });
});

describe("repos", () => {
  const withRepos = (doc: Doc) => {
    doc.repo = [
      { name: "web", project: "proj_web" },
      { name: "api", project: "proj_api", base: "trunk" },
    ];
    doc.ticket[0].repo = "web";
    doc.ticket[1].repo = "api";
  };
  const multi = (edit?: (doc: Doc) => void) =>
    propose((doc) => {
      withRepos(doc);
      edit?.(doc);
    });
  const ticketRepos = () => store.tickets(store.projectBySlug("csv")!.id).map((ticket) => [ticket.key, ticket.repo]);

  beforeEach(() => {
    bb.addBbProject("proj_web", { host_local: "/src/web" });
    bb.addBbProject("proj_api", { host_local: "/src/api", host_other: "/elsewhere/api" });
  });

  it("accepts repos that are standard bb projects checked out on the proposer's machine, reading bb's projects once, and stores each ticket's repo", async () => {
    expect(await multi()).toMatchObject({ slug: "csv", version: 1, state: "draft", change: "created" });
    expect(bb.callsTo("listProjects")).toHaveLength(1);
    await projects.approve("csv", "human");
    expect(ticketRepos()).toEqual([
      ["CSV-1", "web"],
      ["CSV-2", "api"],
    ]);
  });

  it("makes no listProjects call for a single-repo spec, and stores null for each of its tickets", async () => {
    await propose();
    await propose((doc) => (doc.project.goal = "Export orders as CSV, with a delimiter the person can choose."));
    await projects.approve("csv", "human");
    await propose((doc) => (doc.project.goal = "Export orders as CSV, with a delimiter and a date range filter."));
    expect(bb.callsTo("listProjects")).toEqual([]);
    expect(ticketRepos()).toEqual([
      ["CSV-1", null],
      ["CSV-2", null],
    ]);
  });

  it("refuses a bb project bb does not know and lists the standard projects as name (id), leaving the personal one out", async () => {
    bb.addBbProject("proj_personal", {}, { name: "Personal", kind: "personal" });
    const error = await failure(multi((doc) => (doc.repo[1].project = "proj_nope")));
    expect(error.code).toBe("loom_invalid_spec");
    expect(error.message).toContain(`\n1. repo[1].project: bb has no project "proj_nope". Use the id of one of bb's projects: shop (proj_1), web (proj_web), api (proj_api).`);
    expect(error.message).not.toContain("proj_personal");
    expect(error.message).not.toMatch(/\n2\. /);
    expect(store.projects()).toEqual([]);
  });

  it("lists at most 20 known projects", async () => {
    for (let n = 1; n <= 25; n += 1) bb.addBbProject(`proj_x${n}`, { host_local: `/src/x${n}` });
    const error = await failure(multi((doc) => (doc.repo[0].project = "proj_nope")));
    const listed = error.message.match(/Use the id of one of bb's projects: (.*)\.$/m)![1]!;
    expect(listed.split(", ").filter((entry) => / \(proj_\w+\)$/.test(entry))).toHaveLength(20);
    expect(listed).toMatch(/^shop \(proj_1\), web \(proj_web\), api \(proj_api\), x1 \(proj_x1\), /);
    expect(listed).toContain("x17 (proj_x17), and 8 more");
    expect(listed).not.toContain("proj_x18");
  });

  it("refuses bb's personal project", async () => {
    bb.addBbProject("proj_personal", {}, { name: "Personal", kind: "personal" });
    const error = await failure(multi((doc) => (doc.repo[0].project = "proj_personal")));
    expect(error.message).toContain(`1. repo[0].project: "proj_personal" is bb's personal project, which has no git checkout. Use the id of one of bb's projects: shop (proj_1), web (proj_web), api (proj_api).`);
  });

  it("refuses a bb project with no checkout on the proposer's machine and gives the command that clones it there", async () => {
    bb.addBbProject("proj_docs", { host_other: "/src/docs" });
    const error = await failure(
      multi((doc) => {
        doc.repo.push({ name: "docs", project: "proj_docs" });
        doc.ticket[1].repo = "docs";
      }),
    );
    expect(error.message).toContain("1. repo[2].project: bb project docs (proj_docs) has no checkout on this machine (host_local), where the project's workers run. Clone it here with `bb project source add proj_docs --clone --machine host_local`, then call loom_propose again.");
    expect(error.message).not.toMatch(/\n2\. /);
    expect(store.projects()).toEqual([]);
  });

  it("refuses the spec and says to try again when bb's projects cannot be read", async () => {
    bb.bbProjects = new Error("bb is restarting");
    const error = await failure(multi());
    expect(error.code).toBe("loom_invalid_spec");
    expect(error.message).toContain("1. repo: Loom could not read bb's projects to check the [[repo]] tables (bb is restarting), and the project could not start without a checkout of every repo. Call loom_propose again in a moment.");
    expect(store.projects()).toEqual([]);
    expect(bb.callsTo("ensureSection")).toEqual([]);
  });

  it("refuses a multi-repo spec when bb cannot say which machine the proposer runs on", async () => {
    const error = await failure(projects.propose({ toml: specToml(withRepos), threadId: "thr_plan", bbProjectId: "proj_1", hostId: null }));
    expect(error.message).toContain("1. repo: bb did not say which machine this thread runs on");
    expect(bb.callsTo("listProjects")).toEqual([]);
    expect(await projects.propose({ toml: specToml(), threadId: "thr_plan", bbProjectId: "proj_1", hostId: null })).toMatchObject({ change: "created" });
  });

  describe("after approval", () => {
    beforeEach(async () => {
      await multi();
      await projects.approve("csv", "human");
    });
    const pendingVersion = () => store.projectBySlug("csv")!.pending_version;

    it("saves a revision that only adds a repo as a pending version", async () => {
      bb.addBbProject("proj_docs", { host_local: "/src/docs" });
      const result = await multi((doc) => doc.repo.push({ name: "docs", project: "proj_docs" }));
      expect(result).toMatchObject({ version: 2, pending: true, change: "pending" });
      expect(pendingVersion()).toBe(2);
    });

    it("still checks an added repo against bb", async () => {
      const error = await failure(multi((doc) => doc.repo.push({ name: "docs", project: "proj_nope" })));
      expect(error.message).toContain('repo[2].project: bb has no project "proj_nope".');
      expect(pendingVersion()).toBeNull();
    });

    it("refuses to remove a repo", async () => {
      const error = await failure(
        multi((doc) => {
          doc.repo.pop();
          doc.ticket[1].repo = "web";
        }),
      );
      expect(error.message).toContain('1. repo: cannot remove repo "api" after approval, because its tickets, branches and worktrees already use it. Keep its [[repo]] table;');
      expect(pendingVersion()).toBeNull();
    });

    it("refuses to rename a repo", async () => {
      const error = await failure(
        multi((doc) => {
          doc.repo[1].name = "backend";
          doc.ticket[1].repo = "backend";
        }),
      );
      expect(error.message).toContain('1. repo[1].name: cannot change from "api" to "backend" after approval, because its tickets, branches and worktrees already use the name. Keep the name "api".');
      expect(error.message).not.toMatch(/\n2\. /);
      expect(pendingVersion()).toBeNull();
    });

    it("refuses to change a repo's project, base or remote", async () => {
      bb.addBbProject("proj_site", { host_local: "/src/site" });
      const project = await failure(multi((doc) => (doc.repo[0].project = "proj_site")));
      expect(project.message).toContain('1. repo[0].project: repo "web" cannot change from "proj_web" to "proj_site" after approval, because its tickets, branches and worktrees already use it. Keep the project; for work in another repository, add a new [[repo]] table.');

      const base = await failure(multi((doc) => (doc.repo[1].base = "main")));
      expect(base.message).toContain('1. repo[1].base: repo "api" cannot change from "trunk" to "main" after approval, because its tickets, branches and worktrees already use it. Set repo[1].base = "trunk" to keep it, or archive this project and propose a new one.');

      const inherited = await failure(multi((doc) => (doc.project.base = "develop")));
      expect(inherited.message).toContain('1. repo[0].base: repo "web" cannot change from "main" to "develop"');
      expect(inherited.message).not.toMatch(/\n2\. /);

      const remote = await failure(multi((doc) => (doc.repo[1].remote = "upstream")));
      expect(remote.message).toContain('1. repo[1].remote: repo "api" cannot change from "origin" to "upstream" after approval, because its tickets, branches and worktrees already use it. Set repo[1].remote = "origin" to keep it, or archive this project and propose a new one.');
      expect(pendingVersion()).toBeNull();
    });

    it("accepts a repo that keeps its settings by naming them where it inherited them", async () => {
      const result = await multi((doc) => {
        doc.project.base = "develop";
        doc.repo[0].base = "main";
      });
      expect(result).toMatchObject({ pending: true, change: "pending" });
    });
  });

  it("refuses to add [[repo]] to a project approved without it", async () => {
    await propose();
    await projects.approve("csv", "human");
    const error = await failure(multi());
    expect(error.message).toContain("1. repo: cannot add [[repo]] tables after approval to a project approved without them, because its tickets, branches and worktrees already use the project's own repository. Remove the [[repo]] tables, or archive this project and propose a new one with them.");
    expect(error.message).not.toMatch(/\n2\. /);
    expect(store.projectBySlug("csv")!.pending_version).toBeNull();
  });
});

describe("ensureProjectSection", () => {
  const expectRepaired = (expectedId: string) => {
    const project = store.projectBySlug("csv")!;
    expect(project.section_id).toBe(expectedId);
    expect(bb.sections.has(expectedId)).toBe(true);
    expect(bb.sections.get(expectedId)).toBe("Loom · CSV export (csv)");
    expect(bb.callsTo("moveThread").at(-1)).toEqual(["thr_plan", expectedId]);
  };

  it("proposing an unchanged spec recreates a deleted section and moves the planner into it", async () => {
    await propose();
    bb.sections.delete("sec_1");
    const result = await propose();
    expect(result).toMatchObject({ change: "unchanged", version: 1 });
    expectRepaired("sec_2");
    expect(bb.callsTo("moveThread")).toEqual([
      ["thr_plan", "sec_1"],
      ["thr_plan", "sec_2"],
    ]);
  });

  it("repairs the section when a draft revision renames the project", async () => {
    await propose();
    bb.sections.delete("sec_1");
    await propose((doc) => (doc.project.name = "Orders CSV"));
    const project = store.projectBySlug("csv")!;
    expect(project).toMatchObject({ name: "Orders CSV", section_id: "sec_2" });
    expect([...bb.sections]).toEqual([["sec_2", "Loom · Orders CSV (csv)"]]);
    expect(bb.callsTo("moveThread").at(-1)).toEqual(["thr_plan", "sec_2"]);
  });

  it("repairs the section when an approved project gets a pending version", async () => {
    await propose();
    await projects.approve("csv", "human");
    bb.sections.delete("sec_1");
    const result = await propose((doc) => (doc.project.goal = "Export orders as CSV, with a delimiter the person can choose."));
    expect(result.change).toBe("pending");
    expectRepaired("sec_2");
  });

  it("leaves a section that still exists alone", async () => {
    await propose();
    expect(await projects.ensureProjectSection(store.projectBySlug("csv")!)).toBe("sec_1");
    await propose();
    expect(store.projectBySlug("csv")?.section_id).toBe("sec_1");
    expect(bb.callsTo("moveThread")).toEqual([["thr_plan", "sec_1"]]);
  });

  it("returns the new id for a caller such as the engine", async () => {
    await propose();
    bb.sections.delete("sec_1");
    expect(await projects.ensureProjectSection(store.projectBySlug("csv")!)).toBe("sec_2");
    expect(store.projectBySlug("csv")?.section_id).toBe("sec_2");
  });

  it("logs a warning and returns the stored id when bb refuses", async () => {
    await propose();
    bb.sections.delete("sec_1");
    bb.takenNames.add("Loom · CSV export (csv)");
    const result = await propose();
    expect(result.change).toBe("unchanged");
    expect(await projects.ensureProjectSection(store.projectBySlug("csv")!)).toBe("sec_1");
    expect(store.projectBySlug("csv")?.section_id).toBe("sec_1");
    expect(bb.callsTo("moveThread")).toEqual([["thr_plan", "sec_1"]]);
    expect(bb.callsTo("log").some(([level, text]) => level === "warn" && String(text).includes("Could not repair the project's section"))).toBe(true);
  });

  it("does not give an archived project a new section", async () => {
    await propose();
    await projects.archive("csv", "human");
    const calls = bb.callsTo("ensureSection").length;
    expect(await projects.ensureProjectSection(store.projectBySlug("csv")!)).toBeNull();
    expect(bb.callsTo("ensureSection")).toHaveLength(calls);
  });
});

describe("approve", () => {
  it("creates tickets in spec order with brief posts", async () => {
    await propose();
    const result = await projects.approve("csv", "human");
    expect(result).toEqual({ slug: "csv", state: "ready", version: 1, applied: "draft", tickets: ["CSV-1", "CSV-2"] });

    const project = store.projectBySlug("csv")!;
    expect(project).toMatchObject({ state: "ready", approved_version: 1, pending_version: null });
    const tickets = store.tickets(project.id);
    expect(tickets.map((ticket) => [ticket.key, ticket.ref, ticket.state, ticket.seq])).toEqual([
      ["CSV-1", "csv-model", "queued", 1],
      ["CSV-2", "csv-export", "queued", 2],
    ]);
    expect(JSON.parse(tickets[1]!.deps_json)).toEqual(["CSV-1"]);
    expect(JSON.parse(tickets[1]!.scope_json)).toEqual(["src/export/**"]);
    expect(tickets[1]).toMatchObject({ priority: 2, created_by: "human" });

    const posts = store.posts(tickets[1]!.id);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ kind: "brief", parent_id: null, author_kind: "planner", author_thread_id: "thr_plan" });
    expect(posts[0]!.body).toBe("Serve the file.\n\nAcceptance criteria:\n1. WHEN the endpoint is called THE SYSTEM SHALL stream a CSV\n2. WHEN there are no orders THE SYSTEM SHALL return a header row");
    expect(eventKinds(project.id).filter((kind) => kind === "spec.approved")).toHaveLength(1);
  });

  it("refuses a second approval and names the current state", async () => {
    await propose();
    await projects.approve("csv", "human");
    const error = await failure(projects.approve("csv", "human"));
    expect(error.code).toBe("loom_invalid_state");
    expect(error.message).toContain("ready");
  });

  it("refuses a version other than the one waiting for approval", async () => {
    await propose();
    const error = await failure(projects.approve("csv", "human", 5));
    expect(error.code).toBe("loom_invalid_state");
    expect(error.message).toContain("version 5");
    expect(store.projectBySlug("csv")?.state).toBe("draft");
    await projects.approve("csv", "human", 1);
    expect(store.projectBySlug("csv")?.state).toBe("ready");
  });

  it("applies a pending version, renaming the section when the name changed", async () => {
    await propose();
    await projects.approve("csv", "human");
    await propose((doc) => (doc.project.name = "Orders CSV"));
    expect((await failure(projects.approve("csv", "human", 9))).message).toContain("version 9");
    const result = await projects.approve("csv", "human", 2);
    expect(result).toEqual({ slug: "csv", state: "ready", version: 2, applied: "pending", tickets: [] });
    expect(store.projectBySlug("csv")).toMatchObject({ approved_version: 2, pending_version: null, name: "Orders CSV" });
    expect(bb.callsTo("renameSection")).toEqual([["sec_1", "Loom · Orders CSV (csv)"]]);
    expect(store.tickets(store.projectBySlug("csv")!.id)).toHaveLength(2);
  });

  it("refuses an unknown project", async () => {
    const error = await failure(projects.approve("nope", "human"));
    expect(error.code).toBe("loom_not_found");
    expect(error.message).toContain("nope");
  });
});

describe("lifecycle", () => {
  it("moves ready to running to paused to running, one event each", async () => {
    await propose();
    await projects.approve("csv", "human");
    const project = store.projectBySlug("csv")!;
    await projects.start("csv", "human");
    await projects.pause("csv", "human");
    await projects.resume("csv", "human");
    expect(store.project(project.id)?.state).toBe("running");
    const moves = store.events(project.id).filter((event) => event.kind === "project.state").map((event) => JSON.parse(event.data_json));
    expect(moves.map((move) => `${move.from}>${move.to}`)).toEqual(["draft>ready", "ready>running", "running>paused", "paused>running"]);
  });

  it("records pause --now in the event", async () => {
    await propose();
    await projects.approve("csv", "human");
    await projects.start("csv", "human");
    await projects.pause("csv", "human", { now: true });
    const project = store.projectBySlug("csv")!;
    expect(project.system_reason).toBe("pause --now");
  });

  it("refuses invalid moves and names the current state", async () => {
    await propose();
    const start = await failure(projects.start("csv", "human"));
    expect(start.code).toBe("loom_invalid_state");
    expect(start.message).toContain("draft");
    expect(start.hint).toContain("bb loom approve csv");
    expect((await failure(projects.pause("csv", "human"))).message).toContain("draft");
    await projects.approve("csv", "human");
    expect((await failure(projects.resume("csv", "human"))).message).toContain("ready");
    await projects.start("csv", "human");
    expect((await failure(projects.start("csv", "human"))).message).toContain("running");
    expect((await failure(projects.resume("csv", "human"))).message).toContain("running");
  });

  it("archive cancels open tickets and deletes the section", async () => {
    await propose();
    await projects.approve("csv", "human");
    await projects.archive("csv", "human");
    const project = store.projectBySlug("csv")!;
    expect(project).toMatchObject({ state: "archived", section_id: null });
    expect(store.tickets(project.id).map((ticket) => ticket.state)).toEqual(["cancelled", "cancelled"]);
    expect(bb.callsTo("deleteSection")).toEqual([["sec_1"]]);
    expect((await failure(projects.archive("csv", "human"))).message).toContain("archived");
  });

  it("archives a draft that has no tickets", async () => {
    await propose();
    await projects.archive("csv", "human");
    expect(store.projectBySlug("csv")?.state).toBe("archived");
  });
});

describe("posts and blocking", () => {
  async function approved() {
    await propose();
    await projects.approve("csv", "human");
  }

  it("adds a human reply under a post", async () => {
    await approved();
    const brief = store.posts(store.ticketByKey("CSV-1")!.id)[0]!;
    const reply = projects.post("CSV-1", { body: "Please keep the header row.", parentId: brief.id, author: "human" });
    expect(reply).toMatchObject({ kind: "reply", parent_id: brief.id, author_kind: "human", author_thread_id: null });
    const top = projects.post("CSV-1", { body: "A new top-level note.", author: "human" });
    expect(top.parent_id).toBeNull();
  });

  it("refuses a reply to a post on another ticket and an unknown ticket", async () => {
    await approved();
    const other = store.posts(store.ticketByKey("CSV-2")!.id)[0]!;
    const parent = await failure(Promise.resolve().then(() => projects.post("CSV-1", { body: "hi", parentId: other.id, author: "human" })));
    expect(parent.code).toBe("loom_not_found");
    expect(parent.message).toContain("another ticket");
    const missing = await failure(Promise.resolve().then(() => projects.post("CSV-9", { body: "hi", author: "human" })));
    expect(missing.code).toBe("loom_not_found");
    expect(missing.message).toContain("CSV-9");
    const empty = await failure(Promise.resolve().then(() => projects.post("CSV-1", { body: "   ", author: "human" })));
    expect(empty.message).toContain("empty");
  });

  it("blocks a ticket with a reason and a block post, and refuses a second block", async () => {
    await approved();
    const ticket = projects.block("CSV-1", "Waiting on the data team.", "human");
    expect(ticket).toMatchObject({ state: "blocked", blocked_reason: "Waiting on the data team." });
    const posts = store.posts(ticket.id);
    expect(posts.at(-1)).toMatchObject({ kind: "block", author_kind: "human", body: "Waiting on the data team." });
    expect(() => projects.block("CSV-1", "again", "human")).toThrow(/blocked/);
  });
});

describe("roles", () => {
  async function withWorker() {
    await propose();
    const project = store.projectBySlug("csv")!;
    return store.addThread({ spawn_token: "tok_1", project_id: project.id, role: "worker", state: "spawning" });
  }

  it("finds a row by thread id and ignores metadata that claims a role", async () => {
    await propose();
    expect(projects.roleOf("thr_plan")).toMatchObject({ role: "planner" });
    expect(projects.roleOf("thr_unknown", { role: "worker", project: "csv" })).toBeNull();
  });

  it("binds a spawning row through its spawn token, once", async () => {
    const row = await withWorker();
    expect(projects.roleOf("thr_w", { spawnToken: "tok_1" })).toMatchObject({ id: row.id, role: "worker", thread_id: "thr_w", state: "spawning" });
    expect(projects.roleOf("thr_w")).toMatchObject({ id: row.id });
    expect(projects.roleOf("thr_other", { spawnToken: "tok_1" })).toBeNull();
    expect(projects.roleOf("thr_x", { spawnToken: "forged" })).toBeNull();
    expect(projects.roleOf("thr_y", { spawnToken: 42 })).toBeNull();
  });

  it("does not bind a row that is no longer spawning", async () => {
    const row = await withWorker();
    store.updateThread(row.id, { state: "active" });
    expect(projects.roleOf("thr_w", { spawnToken: "tok_1" })).toBeNull();
  });

  it("requireRole refuses a thread with another role or none", async () => {
    await withWorker();
    expect(projects.requireRole("thr_plan", "planner")).toMatchObject({ role: "planner" });
    expect(() => projects.requireRole("thr_plan", "worker")).toThrow("This tool is for Loom worker threads.");
    expect(() => projects.requireRole("thr_none", "planner")).toThrow("This tool is for Loom planner threads.");
    expect(projects.requireRole("thr_w", "worker", { spawnToken: "tok_1" })).toMatchObject({ role: "worker" });
  });

  it("requireProposer passes for a new thread or the planner of that slug only", async () => {
    await withWorker();
    expect(() => projects.requireProposer("thr_new", "csv")).not.toThrow();
    expect(() => projects.requireProposer("thr_plan", "csv")).not.toThrow();
    expect(() => projects.requireProposer("thr_plan", "other")).toThrow("This thread already plans csv; a revision must keep that slug.");
    projects.roleOf("thr_w", { spawnToken: "tok_1" });
    expect(() => projects.requireProposer("thr_w", "csv")).toThrow("Workers and reviewers cannot propose projects.");
  });

  it("requireProposer and propose refuse a planner row that has ended, and keep allowing a thread that has no row", async () => {
    await propose();
    projects.threadGone("thr_plan", "deleted");
    expect(() => projects.requireProposer("thr_plan", "csv")).toThrow("This planner thread has ended.");
    expect(() => projects.requireProposer("thr_new", "csv")).not.toThrow();
    const error = await failure(propose((doc) => (doc.project.goal = "A changed goal that a deleted planner must not be able to propose.")));
    expect(error.code).toBe("loom_invalid_spec");
    expect(error.message).toContain("This planner thread has ended.");
    expect(store.projectBySlug("csv")!.pending_version).toBeNull();
    expect(store.specVersion(store.projectBySlug("csv")!.id, 2)).toBeNull();
  });

  it("ends the planner row when its thread is deleted", async () => {
    await propose();
    projects.threadGone("thr_plan", "deleted");
    expect(store.threadByThreadId("thr_plan")).toMatchObject({ state: "ended", end_reason: "deleted", ended_at: clock.t });
    projects.threadGone("thr_unknown", "deleted");
  });
});

describe("views", () => {
  it("overview counts tickets by state and names the pending version", async () => {
    await propose();
    await projects.approve("csv", "human");
    projects.block("CSV-1", "waiting", "human");
    await propose((doc) => (doc.project.goal = "Export orders as CSV, with a delimiter the person can choose."));
    const overview = projects.overview("csv");
    expect(overview).toMatchObject({ slug: "csv", name: "CSV export", key: "CSV", state: "ready", approvedVersion: 1, pendingVersion: 2, strategy: "integration", branch: "loom/csv", plannerThreadId: "thr_plan", ticketCount: 2 });
    expect(overview.ticketCounts).toEqual({ queued: 1, blocked: 1 });
    expect(projects.list().map((entry) => entry.slug)).toEqual(["csv"]);
  });

  it("spec returns a version's TOML, defaulting to the approved one", async () => {
    await propose();
    expect(projects.spec("csv")).toMatchObject({ version: 1, status: "draft" });
    await projects.approve("csv", "human");
    await propose((doc) => (doc.project.name = "Orders CSV"));
    expect(projects.spec("csv")).toMatchObject({ version: 1, status: "approved" });
    expect(projects.spec("csv", 2)).toMatchObject({ version: 2, status: "pending" });
    expect(projects.spec("csv", 2).toml).toContain("Orders CSV");
    expect(() => projects.spec("csv", 7)).toThrow(/version 7/);
  });

  it("tickets filters by state and rejects an unknown state", async () => {
    await propose();
    await projects.approve("csv", "human");
    projects.block("CSV-2", "waiting", "human");
    expect(projects.tickets("csv").map((ticket) => ticket.key)).toEqual(["CSV-1", "CSV-2"]);
    expect(projects.tickets("csv", ["blocked"]).map((ticket) => ticket.key)).toEqual(["CSV-2"]);
    expect(() => projects.tickets("csv", ["flying" as never])).toThrow(/Unknown ticket state "flying"/);
    expect(projects.tickets("csv")[1]).toMatchObject({ key: "CSV-2", ref: "csv-export", title: "Export endpoint", state: "blocked", deps: ["CSV-1"] });
  });

  it("ticketView orders posts depth first with their depth", async () => {
    await propose();
    await projects.approve("csv", "human");
    const brief = store.posts(store.ticketByKey("CSV-1")!.id)[0]!;
    const first = projects.post("CSV-1", { body: "first", parentId: brief.id, author: "human" });
    const second = projects.post("CSV-1", { body: "second", author: "human" });
    const nested = projects.post("CSV-1", { body: "nested", parentId: first.id, author: "human" });
    const later = projects.post("CSV-1", { body: "later", parentId: brief.id, author: "human" });
    const view = projects.ticketView("CSV-1");
    expect(view).toMatchObject({ key: "CSV-1", slug: "csv", state: "queued", title: "Order rows", deps: [], scope: ["src/model/**"] });
    expect(view.posts.map((post) => [post.id, post.depth])).toEqual([
      [brief.id, 0],
      [first.id, 1],
      [nested.id, 2],
      [later.id, 1],
      [second.id, 0],
    ]);
  });
});

describe("repos in the views", () => {
  const toDone = (key: string) => {
    for (const state of ["working", "checking", "review", "approved", "merging", "done"] as const) store.setTicketState(store.ticketByKey(key)!.id, state, "loom");
  };
  const withRepos = (doc: Doc) => {
    doc.repo = [
      { name: "web", project: "proj_web" },
      { name: "api", project: "proj_api", base: "trunk", remote: "upstream" },
    ];
    doc.ticket[0].repo = "web";
    doc.ticket[1].repo = "api";
    doc.ticket[1].depends_on = [];
  };
  async function multiRepo() {
    bb.addBbProject("proj_web", { host_local: "/src/web" }, { name: "Shop web" });
    bb.addBbProject("proj_api", { host_local: "/src/api" }, { name: "Shop API" });
    await propose(withRepos);
    await projects.approve("csv", "human");
    const project = store.projectBySlug("csv")!;
    store.setProjectState(project.id, "running", "human");
    return project;
  }
  const repo = (over: Record<string, unknown>) => ({ bbProjectName: null, branch: "loom/csv", prUrl: null, landedAt: null, toLand: false, ...over });

  it("a single-repo project has one repo, named null, in the Loom project's bb project, with its last land from the events", async () => {
    await propose();
    await projects.approve("csv", "human");
    const project = store.projectBySlug("csv")!;
    store.setProjectState(project.id, "running", "human");
    expect(projects.overview("csv").repos).toEqual([repo({ name: null, bbProjectId: "proj_1", base: "main" })]);
    expect(projects.tickets("csv").map((ticket) => ticket.repo)).toEqual([null, null]);
    expect(projects.ticketView("CSV-1").repo).toBeNull();

    clock.advance(1000);
    toDone("CSV-1");
    expect(projects.overview("csv").repos[0]).toMatchObject({ landedAt: null, toLand: true });
    clock.advance(1000);
    const url = "https://github.com/acme/shop/pull/1";
    store.updateProject(project.id, { pr_url: url });
    store.event(project.id, null, "project.landed", "human", { url, sha: "abc", created: true });
    const landedAt = clock.now();
    expect(projects.overview("csv").repos[0]).toMatchObject({ prUrl: url, landedAt, toLand: false });

    clock.advance(1000);
    store.event(project.id, null, "project.landed", "human", { direct: true, pushed: "origin/main", sha: "def" });
    expect(projects.overview("csv").repos[0]).toMatchObject({ prUrl: url, landedAt: clock.now() });
  });

  it("a multi-repo project has one repo per [[repo]] table, in the spec's order, with its bb project, base and last land", async () => {
    const project = await multiRepo();
    expect(projects.overview("csv").repos).toEqual([repo({ name: "web", bbProjectId: "proj_web", base: "main" }), repo({ name: "api", bbProjectId: "proj_api", base: "trunk" })]);
    expect(projects.tickets("csv").map((ticket) => [ticket.key, ticket.repo])).toEqual([
      ["CSV-1", "web"],
      ["CSV-2", "api"],
    ]);
    expect(projects.ticketView("CSV-2")).toMatchObject({ key: "CSV-2", repo: "api" });

    clock.advance(1000);
    toDone("CSV-1");
    toDone("CSV-2");
    expect(projects.overview("csv").repos.map((entry) => entry.toLand)).toEqual([true, true]);
    clock.advance(1000);
    const url = "https://github.com/acme/web/pull/1";
    store.updateProjectRepo(project.id, "web", { pr_url: url, landed_sha: "abc", landed_at: clock.now() }, "human", { url, sha: "abc", created: true });
    const [web, api] = projects.overview("csv").repos;
    expect(web).toEqual(repo({ name: "web", bbProjectId: "proj_web", base: "main", prUrl: url, landedAt: clock.now() }));
    expect(api).toMatchObject({ name: "api", prUrl: null, landedAt: null, toLand: true });
  });

  it("a pull request strategy project has no integration branch and nothing to land", async () => {
    bb.addBbProject("proj_web", { host_local: "/src/web" });
    bb.addBbProject("proj_api", { host_local: "/src/api" });
    await propose((doc) => {
      withRepos(doc);
      doc.merge = { strategy: "pr" };
    });
    await projects.approve("csv", "human");
    toDone("CSV-1");
    expect(projects.overview("csv").repos.map((entry) => [entry.name, entry.branch, entry.toLand])).toEqual([
      ["web", null, false],
      ["api", null, false],
    ]);
  });

  it("namedOverview and namedList name each repo's bb project, and leave the name null when bb cannot list its projects", async () => {
    await multiRepo();
    expect((await projects.namedOverview("csv")).repos.map((entry) => [entry.bbProjectId, entry.bbProjectName])).toEqual([
      ["proj_web", "Shop web"],
      ["proj_api", "Shop API"],
    ]);
    expect((await projects.namedList())[0]!.repos.map((entry) => entry.bbProjectName)).toEqual(["Shop web", "Shop API"]);
    expect(bb.callsTo("listProjects").length).toBeGreaterThan(0);

    bb.bbProjects = new Error("bb is restarting");
    expect((await projects.namedOverview("csv")).repos.map((entry) => [entry.bbProjectId, entry.bbProjectName])).toEqual([
      ["proj_web", null],
      ["proj_api", null],
    ]);
    expect(bb.callsTo("log").at(-1)).toEqual(["warn", "Could not read bb's projects, so repos show their bb project id: bb is restarting"]);
    await expect(projects.namedOverview("nope")).rejects.toThrow(/No Loom project/);
  });
});

describe("planning", () => {
  const request = (text = "Let people export their orders as CSV.\nWith a date filter.", projectId = "proj_1"): NewThreadRequest => ({
    projectId,
    providerId: "codex",
    model: "gpt-5",
    reasoningLevel: "medium",
    permissionMode: "auto",
    executionInputSources: {},
    environment: { type: "project-default" },
    input: [{ type: "text", text, mentions: [] }],
  });
  const spawned = () => bb.callsTo("spawnPlanner").map(([args]) => args as { request: NewThreadRequest; title: string; kickoff: string });
  const title = "Let people export their orders as CSV.";

  it("startPlanning spawns a planner titled with the goal's first line and the kickoff, records the session, and returns its thread id", async () => {
    expect(await projects.startPlanning({ request: request(), merge: "integration", reviewer: "codex, gpt-5" })).toEqual({ threadId: "thr_p1" });
    expect(bb.callsTo("projectKind")).toEqual([["proj_1"]]);
    expect(spawned()).toHaveLength(1);
    const { request: forwarded, title: threadTitle, kickoff } = spawned()[0]!;
    expect(forwarded).toEqual(request());
    expect(threadTitle).toBe(`Loom plan: ${title}`);
    expect(kickoff).toMatch(/^\[loom\] /);
    expect(kickoff).toContain("Loom page");
    expect(kickoff).toContain("loom-plan");
    expect(kickoff).toContain("loom_propose");
    expect(kickoff).toContain('strategy = "integration"');
    expect(kickoff).toContain("[agents.reviewer]");
    expect(kickoff).toContain(JSON.stringify("codex, gpt-5"));
    expect(store.planning("thr_p1")).toMatchObject({ bb_project_id: "proj_1", title, started_at: clock.t, ended_at: null });
  });

  it("leaves the merge and reviewer sentences out when the merge is ask and the reviewer is empty", async () => {
    await projects.startPlanning({ request: request(), merge: "ask", reviewer: "  " });
    const { kickoff } = spawned()[0]!;
    expect(kickoff).not.toContain("strategy =");
    expect(kickoff).not.toContain("[agents.reviewer]");
    await projects.startPlanning({ request: request(), merge: "pr", reviewer: "" });
    expect(spawned()[1]!.kickoff).toContain('strategy = "pr"');
  });

  it("refuses blank text with loom_invalid_input, and a personal or unknown project with loom_no_checkout, and spawns none of them", async () => {
    const blank = await failure(projects.startPlanning({ request: request("  \n "), merge: "ask", reviewer: "" }));
    expect(blank).toMatchObject({ code: "loom_invalid_input", message: "Describe what should exist when the project is done." });
    bb.projectKinds.set("proj_personal", "personal");
    const personal = await failure(projects.startPlanning({ request: request(undefined, "proj_personal"), merge: "ask", reviewer: "" }));
    expect(personal).toMatchObject({ code: "loom_no_checkout", message: "Loom needs a bb project with a git checkout. Pick a project in the composer." });
    bb.projectKind = async () => null;
    expect((await failure(projects.startPlanning({ request: request(), merge: "ask", reviewer: "" }))).code).toBe("loom_no_checkout");
    expect(spawned()).toEqual([]);
    expect(store.openPlanning()).toEqual([]);
  });

  const KICKOFF = [
    "[loom] The human started this thread from the Loom page to plan a new project, and the goal is the message above.",
    "Plan it with the loom-plan skill: one round of questions here, then read the code, run the checks, and call loom_propose.",
    "The human reviews, approves and starts the draft on the Loom page, so point them there when you hand over.",
  ];
  const withRepos = () => {
    bb.addBbProject("proj_api", { host_local: "/api" }, { name: "shop-api" });
    bb.addBbProject("proj_docs", {}, { name: "docs" });
    bb.addBbProject("proj_personal", {}, { name: "Personal", kind: "personal" });
  };

  it("sends the same kickoff as before when no repos are picked, or only the composer's own project, and does not ask bb for its projects", async () => {
    await projects.startPlanning({ request: request(), merge: "ask", reviewer: "" });
    await projects.startPlanning({ request: request(), merge: "ask", reviewer: "", repos: [] });
    await projects.startPlanning({ request: request(), merge: "ask", reviewer: "", repos: ["proj_1"] });
    expect(spawned().map((args) => args.kickoff)).toEqual([KICKOFF.join("\n"), KICKOFF.join("\n"), KICKOFF.join("\n")]);
    await projects.startPlanning({ request: request(), merge: "integration", reviewer: "codex, gpt-5", repos: [] });
    expect(spawned()[3]!.kickoff).toBe(
      [
        ...KICKOFF,
        'The merge plan is already chosen: strategy = "integration" in [merge], so do not ask about it.',
        'The human asked for this reviewer model: "codex, gpt-5". Write it into [agents.reviewer] as provider and model; ask only if it is unclear.',
      ].join("\n"),
    );
    expect(bb.callsTo("listProjects")).toEqual([]);
  });

  it("lists the picked repos by name and id in the order picked, without repeats or the composer's project, and tells the planner what to do with them", async () => {
    withRepos();
    await projects.startPlanning({ request: request(), merge: "pr", reviewer: "", repos: ["proj_docs", "proj_api", "proj_1", "proj_docs"] });
    const lines = spawned()[0]!.kickoff.split("\n");
    expect(lines.slice(0, 4)).toEqual([...KICKOFF, 'The merge plan is already chosen: strategy = "pr" in [merge], so do not ask about it.']);
    expect(lines.slice(4)).toEqual([
      "The human picked these repos for the work, besides this thread's own project: docs (proj_docs), shop-api (proj_api).",
      "List each repo the work changes in its own [[repo]] table, with its bb project id as project, and include this thread's own project when the work changes it too.",
      "Every repo needs a checkout on this machine, where the workers run: `bb project list --json` shows each project's checkouts by machine, and `bb status` names this machine. For a repo with no checkout here, offer to clone it with `bb project source add <id> --clone --machine <this machine>`, and run that once the human agrees.",
      "The picked repos are a starting point, not a limit: you may find other repos with `bb project list` and `bb project discover`, and add any the work also changes.",
    ]);
    expect(spawned()[0]!.request).toEqual(request());
    expect(store.planning("thr_p1")).toMatchObject({ bb_project_id: "proj_1" });

    await projects.startPlanning({ request: request(), merge: "ask", reviewer: "", repos: ["proj_api"] });
    expect(spawned()[1]!.kickoff.split("\n")[3]).toBe("The human picked this repo for the work, besides this thread's own project: shop-api (proj_api).");
  });

  it("refuses an unknown or personal picked repo with loom_invalid_input naming each, more than 10 repos, and a list bb cannot read, and spawns none of them", async () => {
    withRepos();
    const unknown = await failure(projects.startPlanning({ request: request(), merge: "ask", reviewer: "", repos: ["proj_api", "proj_gone"] }));
    expect(unknown).toMatchObject({ code: "loom_invalid_input", message: 'bb has no project "proj_gone". Pick the repos from bb\'s standard projects.' });
    const personal = await failure(projects.startPlanning({ request: request(), merge: "ask", reviewer: "", repos: ["proj_personal"] }));
    expect(personal).toMatchObject({ code: "loom_invalid_input", message: '"proj_personal" is bb\'s personal project, which has no git checkout. Pick the repos from bb\'s standard projects.' });
    const both = await failure(projects.startPlanning({ request: request(), merge: "ask", reviewer: "", repos: ["proj_gone", "proj_personal"] }));
    expect(both.message).toMatch(/^bb has no project "proj_gone"\. "proj_personal" is bb's personal project/);

    const many = await failure(projects.startPlanning({ request: request(), merge: "ask", reviewer: "", repos: Array.from({ length: 11 }, (_, n) => `proj_${n}`) }));
    expect(many).toMatchObject({ code: "loom_invalid_input", message: "Pick at most 10 repos; 11 were picked." });

    bb.bbProjects = new Error("bb is restarting");
    const unread = await failure(projects.startPlanning({ request: request(), merge: "ask", reviewer: "", repos: ["proj_api"] }));
    expect(unread).toMatchObject({ code: "loom_unavailable", message: "Loom could not read bb's projects to check the picked repos: bb is restarting. Try again in a moment." });
    expect(spawned()).toEqual([]);
    expect(store.openPlanning()).toEqual([]);
  });

  it("bbProjectChoices lists bb's standard projects by name with the machines that have a checkout, and says when bb cannot list them", async () => {
    withRepos();
    bb.addBbProject("proj_web", { host_local: "/web", host_1: "/web" }, { name: "Shop-web" });
    (bb.bbProjects as BbProjectInfo[]).find((project) => project.id === "proj_web")!.sources.push({ hostId: "host_1", path: "/web-2", isDefault: false });
    expect(await projects.bbProjectChoices()).toEqual([
      { id: "proj_docs", name: "docs", hostIds: [] },
      { id: "proj_1", name: "shop", hostIds: ["host_local", "host_1"] },
      { id: "proj_api", name: "shop-api", hostIds: ["host_local"] },
      { id: "proj_web", name: "Shop-web", hostIds: ["host_local", "host_1"] },
    ]);
    bb.bbProjects = new Error("bb is restarting");
    expect(await failure(projects.bbProjectChoices())).toMatchObject({ code: "loom_unavailable", message: "Loom could not read bb's projects to list the repos: bb is restarting. Try again in a moment." });
  });

  it("lists the open sessions newest first, and a session gets its slug and project state once its thread proposes", async () => {
    await projects.startPlanning({ request: request(), merge: "ask", reviewer: "" });
    clock.advance(1000);
    await projects.startPlanning({ request: request("Write the docs site."), merge: "ask", reviewer: "" });
    expect(projects.planningSessions()).toEqual([
      { threadId: "thr_p2", title: "Write the docs site.", startedAt: clock.t, slug: null, projectState: null },
      { threadId: "thr_p1", title, startedAt: clock.t - 1000, slug: null, projectState: null },
    ]);
    await propose(undefined, "thr_p1");
    expect(projects.planningSession("thr_p1")).toEqual({ threadId: "thr_p1", title, startedAt: clock.t - 1000, slug: "csv", projectState: "draft" });
    expect(projects.planningSessions().map((session) => session.slug)).toEqual([null, "csv"]);
    expect(projects.planningSession("thr_nope")).toBeNull();
  });

  it("planningGone ends the session, so it leaves the list", async () => {
    await projects.startPlanning({ request: request(), merge: "ask", reviewer: "" });
    projects.planningGone("thr_p1", "archived");
    expect(projects.planningSessions()).toEqual([]);
    expect(store.planning("thr_p1")).toMatchObject({ ended_at: clock.t, end_reason: "archived" });
    projects.planningGone("thr_unknown", "archived");
  });
});
