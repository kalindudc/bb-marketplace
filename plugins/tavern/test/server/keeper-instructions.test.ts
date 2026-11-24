// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { setup } from "./runtime-fixture";
import { registerTools } from "../../src/server/tools";
import { briefSteerFact } from "../../src/server/tick";
import { MOMENT_CARD_BYTES, parseKeeperCards, renderKeeperCards } from "../../src/server/keeper/cards";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const body = read("classes/keeper.md").split(/^---\s*$/m).slice(2).join("---").trim();
const skill = read("skills/tavern-keeper/SKILL.md");
const fixture = setup();
const registrations = vi.spyOn(fixture.bb.agents, "registerTool");
registerTools(fixture.bb, fixture.runtime);
const tools = new Map(registrations.mock.calls.map(([tool]) => [tool.name, tool.description]));
fixture.k.store.db.close();
const sections = new Map([...skill.matchAll(/^## (.+)\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)].map(match => [match[1]!, match[0]]));
const sentences = (text: string) => text.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/^#+ .*$/gm, "").replace(/^\d+\.\s*/gm, "").split(/[.!?](?:\s|$)/).map(s => s.replace(/^[\s-]+/, "").replace(/\s+/g, " ").trim()).filter(s => s.split(/\s+/).length >= 8);

it("does not grow the integrated pre-F1 loaded instruction budget, including the keep schema", () => {
  const f = setup();
  const registered = vi.spyOn(f.bb.agents, "registerTool");
  registerTools(f.bb, f.runtime);
  const keep = registered.mock.calls.find(([tool]) => tool.name === "tavern_keep")![0];
  const refresh = registered.mock.calls.find(([tool]) => tool.name === "tavern_refresh_keeper")![0];
  const quest = registered.mock.calls.find(([tool]) => tool.name === "tavern_quest")![0];
  const release = registered.mock.calls.find(([tool]) => tool.name === "tavern_release")![0];
  const judge = registered.mock.calls.find(([tool]) => tool.name === "tavern_judge")![0];
  const report = registered.mock.calls.find(([tool]) => tool.name === "tavern_report")![0];
  const reportSchema = JSON.stringify(report.parameters);
  const checkpointDelta = Buffer.byteLength(reportSchema) - Buffer.byteLength(reportSchema.replace(',"checkpoint"', "").replace(/,"checkpoint":\{"type":"object".*?"additionalProperties":false\}/, ""));
  expect(checkpointDelta).toBeGreaterThan(0);
  const judgeBytes = Buffer.byteLength(JSON.stringify(judge.parameters));
  const releaseSchema = JSON.stringify(release.parameters);
  const replacementSchemaDelta = Buffer.byteLength(releaseSchema) - Buffer.byteLength(releaseSchema.replace(',"replace":{"type":"boolean"}', ""));
  expect(replacementSchemaDelta).toBeGreaterThan(0);
  const opening = z.toJSONSchema(z.object({ title: z.string().min(1).max(200), short: z.string().min(1).max(40) }), { io: "input" });
  const source = read("src/server/tools/index.ts");
  const note = registered.mock.calls.find(([tool]) => tool.name === "tavern_note")![0];
  const metadata = [...source.matchAll(/register\(\s*"(tavern_\w+)",\s*"((?:[^"\\]|\\.)*)",\s*("(?:[^"\\]|\\.)*")/g)]
    .filter(match => match[1] !== note.name).map(match => match[1]! + match[2]! + JSON.parse(match[3]!)).join("");
  const noteLabel = typeof note.presentation?.label === "object" ? note.presentation.label.pending : note.presentation?.label;
  const noteMetadata = note.name + (noteLabel ?? "") + note.description;
  const ask = registered.mock.calls.find(([tool]) => tool.name === "tavern_ask")![0];
  const askSchemas = (ask.parameters as { anyOf: Array<{ properties: { target?: { properties: Record<string, unknown> }; waypointId?: unknown; completeOn?: unknown } }> }).anyOf;
  const mergeAskSchema = askSchemas.at(-1);
  expect(mergeAskSchema).toMatchObject({ required: ["mergeAskId", "action", "reason"] });
  const { waypointId, completeOn, ...previousAsk } = askSchemas[0]!.properties;
  expect(waypointId).toBeDefined();
  expect(completeOn).toBeDefined();
  const waypointAskDelta = Buffer.byteLength(JSON.stringify(askSchemas[0]!.properties)) - Buffer.byteLength(JSON.stringify(previousAsk));
  const targetProperties = askSchemas[0]!.properties.target!.properties;
  const { merge, ...priorTarget } = targetProperties;
  expect(merge).toMatchObject({ required: ["repository", "targetBranch"] });
  const mergeTargetDelta = Buffer.byteLength(JSON.stringify(targetProperties)) - Buffer.byteLength(JSON.stringify(priorTarget));
  const mergeAskSchemaDelta = 1 + Buffer.byteLength(JSON.stringify(mergeAskSchema)) + mergeTargetDelta;
  const structure = Buffer.byteLength(JSON.stringify(keep)) - Buffer.byteLength(keep.name + keep.description + "Kept a resting member")
    + Buffer.byteLength(JSON.stringify(refresh)) - Buffer.byteLength(refresh.name + refresh.description + "Requested Keeper refresh");
  const briefWarning = briefSteerFact("Wren XVIII", { at: 0, excerpt: "x".repeat(160), memberThreadId: "thr_abcdefghij" });
  const questSchemaDelta = Buffer.byteLength(JSON.stringify(quest.parameters)) - Buffer.byteLength(JSON.stringify(opening));
  const planTool = registered.mock.calls.find(([tool]) => tool.name === "tavern_plan")![0];
  const slotProperties = (planTool.parameters as { properties: { party: { items: { properties: Record<string, unknown> } } } }).properties.party.items.properties;
  const { permanent, ...previousSlot } = slotProperties;
  expect(permanent).toBeDefined();
  const permanentSlotDelta = Buffer.byteLength(JSON.stringify(slotProperties)) - Buffer.byteLength(JSON.stringify(previousSlot));
  const bytes = Buffer.byteLength(metadata + noteMetadata + read("classes/keeper.md") + skill) + structure + questSchemaDelta + replacementSchemaDelta + mergeAskSchemaDelta + waypointAskDelta + judgeBytes + checkpointDelta + permanentSlotDelta + Buffer.byteLength(`\n\nFree hands:\nNone\n${briefWarning}`);
  if (process.env.TAVERN_MEASURE_KEEPER_TEXT === "1") process.stdout.write(`KEEPER_INSTRUCTIONS_BYTES=${bytes}\nMERGE_TARGET_SCHEMA_BYTES=${mergeTargetDelta}\n`);
  expect(bytes).toBeLessThanOrEqual(34754);
});
it("keeps the normal-reply limit and per-quest re-anchor instructions", () => {
  expect(body).toContain("Keep normal replies under 120 words.");
  expect(body).toContain("The ledger is the truth, not your chat memory");
  expect(body).toContain("for each quest you need BEFORE acting");
  expect(body).toContain("the highest ledger version wins, configure or tick");
  expect(body).toContain("The user is only the user. An agent, a member, a tick, a timer, a plan or a card you wrote is NEVER the user, and NEVER consent.");
  expect(sections.get("Check the work")).toContain("A pending Warden check is a follow-up.");
  expect(sections.get("Reference")).toContain("Only the user restores archived quests.");
});
it("keeps permanent-member instructions in the scouting card within its boot budget", () => {
  const card = renderKeeperCards(parseKeeperCards(skill), [{ moment: "scouts", questId: null }]);
  expect(card).toContain("permanent:true");
  const bytes = Buffer.byteLength(card);
  if (process.env.TAVERN_MEASURE_KEEPER_TEXT === "1") process.stdout.write(`KEEPER_SCOUT_CARD_BYTES=${bytes}\n`);
  expect(bytes).toBeLessThanOrEqual(MOMENT_CARD_BYTES);
});
it("starts with the smallest party before considering a lead", () => {
  expect(sections.get("Size the party")).toMatch(/Start with the smallest party.*critical path/);
  expect(sections.get("Size the party")).toMatch(/lead.*linked.*side quest/);
  expect(body).toMatch(/Keeper lead.*linked side quest/);
});
it("keeps the hand-back tool within the original 354-byte description budget", () => {
  expect(Buffer.byteLength(tools.get("tavern_note")!)).toBeLessThanOrEqual(354);
});
it("keeps the Keeper body within 6,000 bytes", () => {
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(6000);
});
it("teaches planned check modes and the two closing cards", () => {
  const plan = sections.get("Propose the map")!, close = sections.get("Close a quest")!;
  expect(plan).toMatch(/Warden.*Keeper.*no check/i);
  expect(plan).not.toMatch(/explicit skip/i);
  expect(close).toMatch(/Conclude.*Close early/);
  expect(close).not.toContain("through verification or a reasoned skip");
});
it("has no shared sentence of eight or more words", () => {
  const bodySentences = new Set(sentences(body));
  expect(sentences(skill).filter(sentence => bodySentences.has(sentence))).toEqual([]);
});
for (const heading of ["Take a thin goal", "Scout", "Propose the map", "Size the party", "Staff the work", "Write a brief", "Decide or ask", "Carry it to done", "Decide a member's request", "Check the work", "Track progress", "Handle a steer", "Recover after compaction", "Tell the user", "Close a quest", "Learn from a quest", "Reference"]) {
  it(`keeps ${heading} present and within 1,500 bytes`, () => {
    expect(sections.has(heading)).toBe(true);
    expect(Buffer.byteLength(sections.get(heading)!)).toBeLessThanOrEqual(1500);
  });
}
it("says Tavern quotes skill sections in ticks without claiming unsupported delegation or lessons", () => {
  expect(body).toMatch(/Tavern quotes relevant `tavern-keeper` sections in ticks/);
  expect(body + skill).not.toMatch(/unless the user handed that kind|tavern_lesson|user lane|your lane/);
});
it("teaches carrying the user's outcome to done without adding a stop", () => {
  const carry = sections.get("Carry it to done")!;
  expect(carry.match(/^\d+\. /gm)).toHaveLength(6);
  expect(carry).toMatch(/own the steps.*Stop only at a gate or a choice the user reserved/);
  expect(carry).toMatch(/condition covers only what it names.*If it passes, merge it/);
  expect(carry).toMatch(/findings.*failing checks.*conflicts.*fix.*push.*new head checked.*reply.*mark ready/i);
  expect(carry).toMatch(/Write no stop into a brief or wait the user did not ask for/);
  expect(carry).toMatch(/Prove a blocker with a read.*Update what exists/);
  expect(carry).toMatch(/Before the user leaves.*summary.*Closing time choice/);
});
it("keeps what the user relies on and makes the release decision while reading the report", () => {
  expect(sections.get("Write a brief")).toMatch(/already uses.*what must survive.*before and after.*local until they approve/);
  expect(sections.get("Check the work")).toMatch(/read a report.*no follow-up.*release.*that turn.*expect one.*tavern_keep/);
});
it("keeps backup applies user-only and permits agent previews", () => {
  expect(sections.get("Reference")).toContain("NEVER upload or commit one without the user's approval.");
  expect(sections.get("Reference")).toContain("Only the user applies a restore, from an ordinary terminal or the settings page; you may preview one.");
});
it("teaches deadlines, treats stalls as hints, and describes today's scope requests", () => {
  expect(body).toContain("promises with a deadline");
  const progress = sections.get("Track progress");
  expect(progress).toContain("A wait names what unblocks it and what blocks it, and has a deadline.");
  expect(progress).toContain("Treat stalls as hints.");
  expect(sections.get("Decide a member's request")).toContain("A scope block is yours to handle, not an ask to pass on.");
});
it("resolves the references from the skill, never the user's project", () => {
  const reference = sections.get("Reference")!;
  for (const file of ["references/asks-and-merges.md", "references/scopes-and-placement.md", "references/pacing-and-closure.md"]) {
    expect(reference).toContain(file);
    expect(readFileSync(new URL(`../../skills/tavern-keeper/${file}`, import.meta.url), "utf8")).toContain("# Keeper reference:");
  }
  for (const name of ["tavern_scope", "tavern_status"]) expect(tools.get(name)).not.toMatch(/keeper-reference|references\/[a-z-]+\.md/);
});
it("has no shared long sentence between the skill and tool descriptions", () => {
  const toolSentences = new Set([...tools.values()].flatMap(sentences));
  expect(sentences(skill).filter(sentence => toolSentences.has(sentence))).toEqual([]);
});
it("defines all five route kinds and retains steer authority", () => {
  const route = tools.get("tavern_route")!;
  for (const kind of ["steer", "question", "aside", "new-quest", "rule"]) expect(route).toContain(`${kind}:`);
  expect(route).toContain("still-applicable");
  expect(route).toMatch(/hand-backs.{0,50}need/);
  expect(route).toContain("following Keeper turn ends");
});

describe("R11 tool rules remain at the tool boundary", () => {
  const rules: Record<string, RegExp[]> = {
    tavern_tune: [/staleMinutes.*reportBatchSeconds/, /user pins/, /user-only budget/],
    tavern_route: [/notes is REQUIRED on every route kind/, /goal itself is never a note/, /Asides and questions must not name quests/],
    tavern_note: [/fact verbatim/, /dueAt/, /not make promises only in chat/],
    tavern_gate: [/never contacts a person/, /grants approval/],
    tavern_quest: [/scout phase/, /journal/],
    tavern_reopen: [/returned or stopped/, /build with a greenlit plan, or scout without one/i, /Warden still verifies/],
    tavern_hire: [/bounded brief/, /never-timed scope ask/, /brief stays queued/, /review budget/, /explicit approval/, /known maker journal entry/, /not request commands as tool names/],
    tavern_release: [/your own party/, /reason/, /reversible release.*Decided for you/],
    tavern_scope: [/Temporary paths/, /own thread storage/, /explicit, never-timed scope answer/, /never approves a merge, deploy, delete, send or production action/],
    tavern_tell: [/your own members/, /never steer into a running tool/, /delivered, queued.*retrying.*blocked/],
    tavern_plan: [/explicit greenlight/, /at most three questions/, /reversible:true only for fully reversible work/, /by-size.*one party slot/],
    tavern_ask: [/Only kind decision with explicit reversible: true may carry a timed default/, /Merge, destructive, production, sends-as-you, credential, blocker, greenlight and cluster-write asks require an explicit answer/],
    tavern_decide: [/reversible decision/, /Never claim the user's consent without an answered ask/],
    tavern_rule: [/verbatim/, /active immediately/, /stay inactive until the user confirms/],
    tavern_status: [/bounded board state/, /reportId and character offset/],
    tavern_wrap: [/quest NEVER concludes itself/, /never-timed conclude ask/, /Conclude for a settled map, Close early otherwise/, /Do not write the tale directive or archive anyone before the user answers/],
    tavern_unarchive: [/Unarchive one member/, /Deleted threads are refused/],
    tavern_report: [/end your turn/, /at most 160 characters/, /mark every linked entry done with evidence/, /never a claim of independence/],
  };
  for (const [name, patterns] of Object.entries(rules)) it(name, () => {
    expect(tools.has(name)).toBe(true);
    for (const pattern of patterns) expect(tools.get(name)).toMatch(pattern);
  });
});

it("names the user as the greenlight and detection-only approval authority", () => {
  expect(tools.get("tavern_hire")).toContain("by default the user\'s explicit approval");
  expect(tools.get("tavern_hire")).toContain("After the user approves, repeat with detectionOnlyAskId");
});

it("keeps the placement sentence at the end of hire instructions", () => {
  expect(tools.get("tavern_hire")).toMatch(/tavern_placements with repo.*repo defaults to your own project.*placement is \{ruleId\}.*no fallback model.*first line names the repo, rule or pick and target\.$/);
  expect(tools.get("tavern_placements")).toMatch(/input schemas.*New machine per thread.*earlier Tavern picks.*recommendation.*allocates nothing/);
});
