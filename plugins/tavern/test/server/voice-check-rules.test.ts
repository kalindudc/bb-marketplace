import { describe, expect, it } from "vitest";
import { ANSWER_END, ANSWER_START, judgeRules, readAnswer } from "../../src/server/voice-check/rules";
import { SITUATIONS, type SituationId } from "../../src/server/voice-check/situations";

const reference = () => Object.fromEntries(SITUATIONS.map((s) => [s.id, structuredClone(s.reference)])) as Record<SituationId, Record<string, unknown>>;
const wren = { name: "Wren", style: "Brisk and wry; fond of lantern metaphors", quirks: ["calls tests little lanterns"] };
const failures = (answers: Record<string, unknown>, id: SituationId, who = wren) => judgeRules(answers, who).situations.find((s) => s.id === id)!.failures.map((f) => f.rule);

describe("The voice check's rules", () => {
  it("passes the plain reference answers, for a plain voice and a styled one", () => {
    for (const who of [{ name: "Pip", style: "plain", quirks: [] }, wren]) {
      const result = judgeRules(reference(), who);
      expect(result.situations.map((s) => [s.id, s.failures])).toEqual(SITUATIONS.map((s) => [s.id, []]));
      expect(result.pass).toBe(true);
    }
  });

  it("fails a voice line where none is allowed, and allows one on a done report", () => {
    const a = reference();
    a.blocker.voice = "Lanterns out, friends.";
    expect(failures(a, "blocker")).toContain("voice-not-allowed");
    a.report.voice = "One more lamp lit.";
    expect(failures(a, "report")).toEqual([]);
  });

  it("finds voice markers in plain fields: exclamations, emoji, shouting, the style's own words and the name as a speaker", () => {
    const a = reference();
    a.blocker.outcome = `${a.blocker.outcome as string} What a mess!`;
    a.failed.headline = "Check failed: 2 of 14 tests fail 🔥";
    a.ask.question = "Light the lantern: open the manifest as a draft pull request now, or wait for Luc's review?";
    a.report.outcome = `${a.report.outcome as string} Wren thinks this is DONE.`;
    expect(failures(a, "blocker")).toEqual(["exclamation"]);
    expect(failures(a, "failed")).toEqual(["emoji"]);
    expect(failures(a, "ask")).toEqual(["style-word"]);
    expect(failures(a, "report")).toEqual(expect.arrayContaining(["speaker", "shouting"]));
    expect(judgeRules(a, wren).situations.find((s) => s.id === "ask")!.failures[0]!.quote).toBe("lantern");
  });

  it("allows capitals and style words that the brief itself uses", () => {
    const a = reference();
    a.blocker.outcome = "npm ci exits 1 with E403 for @shop/vault-saturn. The registry token has expired; renew it.";
    expect(failures(a, "blocker", { name: "Wren", style: "speaks of the registry and tokens fondly", quirks: [] })).toEqual([]);
  });

  it("allows an exclamation mark inside text the brief gives, such as npm's own ERR!, but not one added after it", () => {
    // Live on 14 Nov, Opus quoted "npm ERR! code E403" from the brief and the blocker failed on its "!".
    const a = reference();
    a.blocker.outcome = "I can't install dependencies. `npm ci` exits 1 with `npm ERR! code E403` for the package `@shop/vault-saturn`. The registry token in `~/.npmrc` has expired.";
    expect(failures(a, "blocker")).toEqual([]);
    a.blocker.outcome = "`npm ci` exits 1 with `npm ERR! code E403` for @shop/vault-saturn. The registry token has expired!";
    expect(failures(a, "blocker")).toEqual(["exclamation"]);
    a.blocker.outcome = "Blocked on @shop/vault-saturn: E403! The registry token has expired.";
    expect(failures(a, "blocker")).toEqual(["exclamation"]);
    // The brief's "ERR!" excuses only that word, never another "!" in the same answer.
    a.blocker.outcome = "`npm ci` exits 1 with `npm ERR! code E403` for @shop/vault-saturn. The registry token has expired. Done!";
    expect(judgeRules(a, wren).situations.find((x) => x.id === "blocker")!.failures).toEqual([{ rule: "exclamation", field: "outcome", quote: expect.stringMatching(/Done!$/) }]);
  });

  it("requires each fixed fact verbatim in its field", () => {
    const a = reference();
    a.failed.outcome = "npm test exits 1. 2 of 14 tests fail: parses uppercase units. The other 12 pass.";
    const result = judgeRules(a, wren).situations.find((s) => s.id === "failed")!;
    expect(result.failures).toEqual([{ rule: "missing-fact", field: "outcome", quote: "rejects empty input" }]);
  });

  it("checks the answer against the real tool shape and length", () => {
    const a = reference();
    a.ask.options = [(a.ask.options as unknown[])[0]];
    a.wrap.left = "Schedule the load test (w4) once staging unfreezes. ".repeat(4);
    expect(failures(a, "ask")).toContain("shape");
    expect(failures(a, "wrap")).toContain("too-long");
  });

  it("lets a wrap open with one voiced line, but keeps what is left plain", () => {
    const a = reference();
    a.wrap.outcome = "Lanterns all lit! The vault cutover is done and verified, except the load test.";
    expect(failures(a, "wrap")).toEqual([]);
    a.wrap.left = "Schedule the load test (w4) once staging unfreezes!";
    expect(failures(a, "wrap")).toEqual(["exclamation"]);
  });

  it("fails a situation that is missing from the answer, and the run when nothing parses", () => {
    const a = reference() as Record<string, unknown>;
    delete a.wrap;
    expect(failures(a, "wrap")).toEqual(["missing"]);
    expect(judgeRules(null, wren).parsed).toBe(false);
  });
});

describe("Reading the answer", () => {
  const marked = (json: unknown) => `${ANSWER_START}\n${JSON.stringify(json)}\n${ANSWER_END}`;
  it("takes the first marked answer after the prompt, never a later message from another plugin", () => {
    // Probe 1: cortex injected a memory message after the prompt, and the model answered it too.
    const messages = [marked({ blocker: { ok: 1 } }), "I got the cortex memory list, but it doesn't contain a request."];
    expect(readAnswer(messages)).toEqual({ blocker: { ok: 1 } });
  });
  it("finds the block inside prose, and gives null when there is none or it doesn't parse", () => {
    expect(readAnswer([`Here you go:\n${marked({ a: 1 })}\nDone.`])).toEqual({ a: 1 });
    expect(readAnswer(["no block here"])).toBeNull();
    expect(readAnswer([`${ANSWER_START}\n{not json\n${ANSWER_END}`])).toBeNull();
  });
});
