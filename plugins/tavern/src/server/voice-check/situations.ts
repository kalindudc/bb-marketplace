/**
 * The voice check's five canned situations. Each gives the model a brief with fixed facts and asks for the arguments it would
 * pass to the real tool. The reference answers are written plainly by hand: they set the length ceilings, and the tests use
 * them as the passing case. Change these only with a test.
 */

export type SituationId = "blocker" | "ask" | "failed" | "report" | "wrap";
export type Tool = "tavern_report" | "tavern_ask" | "tavern_wrap";
/** A fact the answer must carry verbatim (case-insensitive), in one of the named fields. */
export type Fact = { text: string; in: readonly string[] };
export type Situation = {
  id: SituationId;
  title: string;
  tool: Tool;
  brief: string;
  facts: readonly Fact[];
  /** Fields that must read plain: no voice markers. Dotted paths; "options.label" means every option's label. */
  plain: readonly string[];
  /** Whether `voice` may be non-empty. The server drops it for blocked and needs-decision reports anyway. */
  voice: boolean;
  reference: Record<string, unknown>;
};

export const SITUATIONS: readonly Situation[] = [
  {
    id: "blocker", title: "A blocker", tool: "tavern_report",
    brief: "You are a party member. Installing dependencies fails: `npm ci` exits 1 with `npm ERR! code E403` for the package `@shop/vault-saturn`. The registry token in `~/.npmrc` has expired. You cannot continue until someone with registry access renews the token. File your report.",
    facts: [{ text: "@shop/vault-saturn", in: ["outcome", "headline"] }, { text: "E403", in: ["outcome", "headline"] }, { text: "token", in: ["outcome"] }],
    plain: ["outcome", "headline"], voice: false,
    reference: {
      status: "blocked", headline: "Blocked: npm ci fails with E403 on @shop/vault-saturn; the registry token has expired.",
      outcome: "npm ci exits 1 with E403 for @shop/vault-saturn. The registry token in ~/.npmrc has expired. I need someone with registry access to renew the token before I can install dependencies.",
      evidence: [{ kind: "command", ref: "npm ci", detail: "npm ERR! code E403 for @shop/vault-saturn", exitCode: 1 }], artifacts: [], voice: null,
    },
  },
  {
    id: "ask", title: "An ask with options", tool: "tavern_ask",
    brief: "You are a Keeper. The vault manifest is ready. The user must decide: open it now as a draft pull request, or wait for Luc's review first. While they decide, the staging checks keep running. Open the ask (kind decision, not reversible).",
    facts: [{ text: "Luc", in: ["question", "options.label", "options.detail", "why"] }, { text: "draft", in: ["question", "options.label", "options.detail"] }],
    plain: ["question", "why", "meanwhile", "options.label", "options.detail"], voice: false,
    reference: {
      question: "Open the vault manifest as a draft pull request now, or wait for Luc's review?", why: "It changes who sees the manifest first.", kind: "decision",
      options: [{ id: "draft-now", label: "Open a draft pull request now", detail: "", recommended: false }, { id: "wait-luc", label: "Wait for Luc's review", detail: "", recommended: false }],
      meanwhile: "The staging checks keep running.", holds: [],
    },
  },
  {
    id: "failed", title: "A failed check", tool: "tavern_report",
    brief: "You are a Warden checking a builder's work. You ran `npm test`: it exits 1, and 2 of 14 tests fail: `parses uppercase units` and `rejects empty input`. The other 12 pass. File your report (status done; the check failed).",
    facts: [{ text: "parses uppercase units", in: ["outcome"] }, { text: "rejects empty input", in: ["outcome"] }, { text: "2 of 14", in: ["outcome", "headline"] }],
    plain: ["outcome", "headline"], voice: false,
    reference: {
      status: "done", headline: "Check failed: 2 of 14 tests fail.",
      outcome: "npm test exits 1. 2 of 14 tests fail: parses uppercase units and rejects empty input. The other 12 pass.",
      evidence: [{ kind: "command", ref: "npm test", detail: "2 of 14 failed", exitCode: 1 }], artifacts: [], voice: null,
    },
  },
  {
    id: "report", title: "A report with evidence", tool: "tavern_report",
    brief: "You are a builder. You added `isZeroDuration(ms)` to `src/duration.js` with 3 tests in `test/duration.test.js`. `npm test` exits 0 and all 3 new tests pass. File your report. You may add one short line in your character's voice in the voice field.",
    facts: [{ text: "src/duration.js", in: ["outcome"] }, { text: "3", in: ["outcome", "headline"] }],
    plain: ["outcome", "headline"], voice: true,
    reference: {
      status: "done", headline: "Added isZeroDuration(ms) with 3 passing tests.",
      outcome: "Added isZeroDuration(ms) to src/duration.js with 3 tests in test/duration.test.js. npm test exits 0.",
      evidence: [{ kind: "command", ref: "npm test", detail: "all tests pass", exitCode: 0 }, { kind: "file", ref: "src/duration.js", detail: "isZeroDuration added", exitCode: null }], artifacts: ["src/duration.js"], voice: null,
    },
  },
  {
    id: "wrap", title: "A wrap", tool: "tavern_wrap",
    brief: "You are a Keeper wrapping the verified quest `quest-vault` (Vault cutover). Every waypoint is verified except `w4` (load test), skipped because staging was frozen; the user still has to schedule it. Write the wrap. One short line in your character's voice is welcome at the start or end of the outcome, nowhere else.",
    facts: [{ text: "w4", in: ["skipped.waypointId"] }, { text: "load test", in: ["left", "skipped.reason"] }],
    plain: ["left", "skipped.reason"], voice: false,
    reference: {
      boardQuestId: "quest-vault", outcome: "The vault cutover is done and verified, except the load test.",
      left: "Schedule the load test (w4) once staging unfreezes.", skipped: [{ waypointId: "w4", reason: "Load test skipped: staging was frozen." }],
    },
  },
];
