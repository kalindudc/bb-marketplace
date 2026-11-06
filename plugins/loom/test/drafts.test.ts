// A ticket's pull request is a draft only while the human holds it (`[[ticket]] keep_draft = true`): Loom marks every other
// one ready for review, once, at the open or at a read that finds it a draft, and never one it holds. The human releases
// a held draft; the planner can only ask for that.
import { beforeEach, describe, expect, it } from "vitest";
import { createCli } from "../src/cli";
import type { ThreadRow } from "../src/db/store";
import { pollPullRequests, runMergeQueue, settleMerges } from "../src/merge";
import { mergeOrderOf } from "../src/merge-order";
import { askForPrTexts, handInPrText } from "../src/pull-requests";
import { boardCards } from "../src/rpc";
import { parseSpec, specHash } from "../src/spec";
import { registerTools } from "../src/tools";
import { specOf } from "../src/workers";
import { Clock, FakePort, makeHost, reachApproved, seedProject, specToml, ticketOf, type Doc, type EngineHarness } from "./helpers";

const URL = "https://github.com/acme/shop/pull/1";
const TEXT = { title: "Add order rows", body: "## Summary\n\nAdd order rows.", commit_message: "Add the order row mapper" };

let host: ReturnType<typeof makeHost>;
let fake: FakePort;
let h: EngineHarness;
beforeEach(() => {
  fake = new FakePort();
  fake.addThread("thr_plan", "idle");
  const clock = new Clock();
  host = makeHost({ port: fake, clock });
  registerTools(host.bb, host.projects, host.engine);
  host.bb.cli.register(createCli(host.projects, host.engine, host.store, clock.now));
  h = { ctx: host.engine.ctx, store: host.store, bb: fake, host: host.hostPort, projects: host.projects, clock, kicks: { count: 0 } };
});

const project = () => h.store.projectBySlug("csv")!;
const spec = () => specOf(h.store, project());
const ticket = () => ticketOf(h, "CSV-1");
const readies = () => h.host.callsTo("prReady");
const outcomes = (outcome: string) => h.store.posts(ticket().id).filter((post) => (JSON.parse(post.data_json) as { outcome?: string }).outcome === outcome);
const poll = async () => {
  h.clock.advance(5 * 60_000);
  await pollPullRequests(h.ctx, project());
};
const card = () => boardCards(h.store.tickets(project().id), h.store.threadsForProject(project().id), spec(), h.store).find((each) => each.key === "CSV-1")!;
const cli = (argv: string[], threadId?: string) => host.harness.runCli(argv, threadId === undefined ? undefined : { threadId });

async function openPr(edit: (doc: Doc) => void = () => undefined): Promise<ThreadRow> {
  await seedProject(h, (doc) => {
    doc.merge = { strategy: "pr" };
    edit(doc);
  });
  const worker = await reachApproved(h);
  await askForPrTexts(h.ctx, project(), spec());
  handInPrText(h.ctx, worker.thread_id!, TEXT);
  await runMergeQueue(h.ctx, project(), spec());
  await settleMerges(h.ctx);
  expect(ticket()).toMatchObject({ state: "pr_open", pr_url: URL });
  return worker;
}

describe("keep_draft in the spec", () => {
  it("is off when unset, so a spec without it hashes as before, and is set per ticket", () => {
    const plain = parseSpec(specToml());
    expect(plain.errors).toEqual([]);
    expect("keep_draft" in plain.spec!.ticket[0]!).toBe(false);
    const held = parseSpec(specToml((doc) => void (doc.ticket[0].keep_draft = true)));
    expect(held.errors).toEqual([]);
    expect(held.spec!.ticket[0]!.keep_draft).toBe(true);
    expect(specHash(held.spec!)).not.toBe(specHash(plain.spec!));
  });
});

describe("marking a pull request ready for review", () => {
  it("marks a draft ready right after it opens, and says so, when no after_open command might do it", async () => {
    await openPr();
    expect(readies()).toEqual([{ repo: "/repo", url: URL, forge: { kind: "gh" } }]);
    expect(outcomes("pr_marked_ready")).toHaveLength(1);
    await poll();
    expect(readies()).toHaveLength(1);
  });

  it("leaves an opened draft to the after_open commands, and marks it ready once at a later read that still finds a draft", async () => {
    await openPr((doc) => void (doc.merge.forge = { kind: "gh", after_open: ["ready-by-branch"] }));
    expect(readies()).toEqual([]);
    h.host.prMeta.set(URL, { ...h.host.prMeta.get(URL), draft: true });
    await poll();
    expect(readies()).toHaveLength(1);
    // Someone made it a draft again: Loom marked it ready once for this pull request, and leaves it now.
    h.host.prMeta.set(URL, { ...h.host.prMeta.get(URL), draft: true });
    await poll();
    await poll();
    expect(readies()).toHaveLength(1);
  });

  it("marks a stale draft from before this version ready at the next read", async () => {
    await openPr((doc) => void (doc.merge.forge = { kind: "gh", after_open: ["noop"] }));
    h.host.prMeta.set(URL, { ...h.host.prMeta.get(URL), draft: true });
    // The read Loom kept from before this version says it is a draft.
    h.store.updateTicket(ticket().id, { pr_meta_json: JSON.stringify({ at: 0, draft: true, review: null, base: "main" }) });
    expect(card().draft).toBe("marking");
    await poll();
    expect(readies()).toHaveLength(1);
    expect(outcomes("pr_marked_ready")).toHaveLength(1);
    expect(card().draft).toBeNull();
  });

  it("never marks a held ticket's draft ready, and shows it as held until the human releases it", async () => {
    await openPr((doc) => void (doc.ticket[0].keep_draft = true));
    expect(readies()).toEqual([]);
    for (let read = 0; read < 3; read += 1) await poll();
    expect(readies()).toEqual([]);
    expect(card().draft).toBe("held");
    expect(mergeOrderOf(spec(), h.store.tickets(project().id))!.entries.find((entry) => entry.key === "CSV-1")).toMatchObject({ draftHold: "held" });
  });
});

describe("releasing a held draft", () => {
  it("is the human's: the CLI refuses a Loom thread, and the planner can only ask", async () => {
    await openPr((doc) => void (doc.ticket[0].keep_draft = true));
    const planner = await cli(["release", "csv", "--ticket", "CSV-1", "--json"], "thr_plan");
    expect((JSON.parse(planner.stdout) as { error: { code: string } }).error.code).toBe("loom_human_only");
    const asked = await host.harness.callAgentTool("loom_release_draft", { key: "CSV-1", note: "The flag is on in production now." }, { threadId: "thr_plan", projectId: "proj_1" });
    expect(JSON.stringify(asked)).toContain("Asked the human to release CSV-1's draft");
    expect(readies()).toEqual([]);
    expect(card()).toMatchObject({ draft: "held", releaseRequested: { note: "The flag is on in production now." } });

    const released = await cli(["release", "csv", "--ticket", "CSV-1"]);
    expect(released).toMatchObject({ exitCode: 0 });
    expect(released.stdout).toContain(`Released ${URL} from draft`);
    expect(readies()).toHaveLength(1);
    expect(ticket().keep_draft).toBe(0);
    expect(card().draft).toBeNull();
    await poll();
    expect(readies()).toHaveLength(1);
  });

  it("refuses a ticket that is not held", async () => {
    await openPr((doc) => void (doc.merge.forge = { kind: "gh", after_open: ["noop"] }));
    const refused = await cli(["release", "csv", "--ticket", "CSV-1", "--json"]);
    expect((JSON.parse(refused.stdout) as { error: { message: string } }).error.message).toContain("CSV-1 is not held as a draft");
  });
});

// Tony's review of 0.35.0: each of these let a draft go ready without the human, or twice, or with the wrong title.
describe("draft holds the planner and concurrent work cannot get around", () => {
  const followDraftNow = async () => (await import("../src/drafts")).followDraft(h.ctx, project(), ticket().id, true, "main");
  const asDraft = () => h.store.updateTicket(ticket().id, { pr_meta_json: JSON.stringify({ at: 0, draft: true, review: null, base: "main" }) });
  const edit = (patch: object, key = "CSV-1") => host.harness.callAgentTool("loom_edit_ticket", { key, patch }, { threadId: "thr_plan", projectId: "proj_1" });
  const gate = () => {
    let open!: () => void;
    const shut = new Promise<void>((resolve) => (open = resolve));
    return { shut, open };
  };

  it("refuses a planner's edit that clears keep_draft once the pull request exists, and takes one that sets it or clears it before", async () => {
    await openPr((doc) => void (doc.ticket[0].keep_draft = true));
    const refused = await edit({ keep_draft: false });
    expect(JSON.stringify(refused)).toContain("Only the human releases it");
    expect(ticket().keep_draft).toBe(1);
    await poll();
    expect(readies()).toEqual([]);
    // Holding an open pull request is always allowed, and so is letting go before a pull request exists.
    expect(JSON.stringify(await edit({ keep_draft: true }))).toContain("CSV-1 changed: keep_draft");
    expect(JSON.stringify(await edit({ keep_draft: true }, "CSV-2"))).toContain("CSV-2 changed: keep_draft");
    expect(ticketOf(h, "CSV-2").keep_draft).toBe(1);
    expect(JSON.stringify(await edit({ keep_draft: false }, "CSV-2"))).toContain("CSV-2 changed: keep_draft");
    expect(ticketOf(h, "CSV-2").keep_draft).toBe(0);
  });

  it("does not mark it ready when the human holds it while Loom looks up the checkout", async () => {
    await openPr((doc) => void (doc.merge.forge = { kind: "gh", after_open: ["noop"] }));
    asDraft();
    const lookup = fake.projectCheckout.bind(fake);
    let held = false;
    fake.projectCheckout = async (...args) => {
      if (!held) {
        held = true;
        h.store.updateTicket(ticket().id, { keep_draft: 1 });
      }
      return lookup(...args);
    };
    expect(await followDraftNow()).toBe(false);
    expect(readies()).toEqual([]);
  });

  it("dispatches one ready when the opening and a read both try at once", async () => {
    await openPr((doc) => void (doc.merge.forge = { kind: "gh", after_open: ["noop"] }));
    asDraft();
    const pending = gate();
    h.host.before.prReady = () => pending.shut;
    const first = followDraftNow();
    const second = followDraftNow();
    pending.open();
    await Promise.all([first, second]);
    expect(readies()).toHaveLength(1);
    expect(h.store.ticketEvents(ticket().id, ["ticket.pr_marked_ready"])).toHaveLength(1);
  });

  it("keeps the new pull request's hold when the ticket's pull request was replaced while a release waited", async () => {
    await openPr((doc) => void (doc.ticket[0].keep_draft = true));
    const NEW = "https://github.com/acme/shop/pull/2";
    h.host.before.prReady = () => void h.store.updateTicket(ticket().id, { pr_url: NEW });
    await expect(host.engine.releaseDraft("CSV-1", URL)).rejects.toThrow("changed while Loom released it");
    expect(ticket()).toMatchObject({ pr_url: NEW, keep_draft: 1 });
    expect(h.store.ticketEvents(ticket().id, ["ticket.draft_released"])).toEqual([]);
  });

  it("waits for the after_open commands to finish before it marks a draft ready, also across a restart", async () => {
    await seedProject(h, (doc) => void (doc.merge = { strategy: "pr", forge: { kind: "gh", after_open: ["ready-by-branch"] } }));
    const worker = await reachApproved(h);
    await askForPrTexts(h.ctx, project(), spec());
    handInPrText(h.ctx, worker.thread_id!, TEXT);
    const pending = gate();
    h.host.before.exec = () => pending.shut;
    const merging = runMergeQueue(h.ctx, project(), spec()).then(() => settleMerges(h.ctx));
    for (let turn = 0; turn < 50 && ticket().pr_url === null; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(ticket()).toMatchObject({ state: "pr_open", pr_url: URL });
    h.host.prMeta.set(URL, { ...h.host.prMeta.get(URL), draft: true });
    await poll();
    expect(readies()).toEqual([]);
    pending.open();
    await merging;
    await poll();
    expect(readies()).toHaveLength(1);

    // A restart lost the run: once its commands' time is up, it counts as over.
    h.store.event(project().id, ticket().id, "ticket.after_open_started", "loom", { url: "https://github.com/acme/shop/pull/9", commands: 1 });
    h.store.updateTicket(ticket().id, { pr_url: "https://github.com/acme/shop/pull/9" });
    asDraft();
    h.host.prMeta.set("https://github.com/acme/shop/pull/9", { draft: true, base: "main" });
    expect(await followDraftNow()).toBe(false);
    h.clock.advance(10 * 60_000);
    expect(await followDraftNow()).toBe(true);
  });

  it("opens a held ticket's pull request as a draft even when merge.draft is false", async () => {
    await openPr((doc) => {
      doc.merge.draft = false;
      doc.ticket[0].keep_draft = true;
    });
    expect(h.host.callsTo("prCreate")[0]).toMatchObject({ draft: true });
    expect(readies()).toEqual([]);
  });
});
