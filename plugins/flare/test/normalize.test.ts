// @vitest-environment node
import { describe, expect, it } from "vitest";
import { BODY_MAX, TITLE_MAX, normalizeFlare } from "../src/normalize";

describe("normalizeFlare", () => {
  it("keeps a well-formed flare as it is", () => {
    expect(normalizeFlare({ title: "Root cause found", body: "The cache key drops the locale.", kind: "finding" })).toEqual({
      ok: true,
      draft: { kind: "finding", title: "Root cause found", body: "The cache key drops the locale.", urgent: false },
      notes: [],
    });
  });

  it("defaults the kind to a finding and reads notify as urgent", () => {
    const result = normalizeFlare({ title: "Deploy is stuck", notify: true });
    expect(result).toMatchObject({ ok: true, draft: { kind: "finding", urgent: true, body: "" } });
  });

  it("puts the title on one line", () => {
    const result = normalizeFlare({ title: "  Two\nlines  of   title " });
    expect(result).toMatchObject({ ok: true, draft: { title: "Two lines of title" } });
  });

  it("takes the title from the body's first line when there is none", () => {
    const result = normalizeFlare({ body: "## Staging is down\n\nThe health check returns 503." });
    expect(result).toMatchObject({ ok: true, draft: { title: "Staging is down", body: "The health check returns 503." } });
  });

  it("sends nothing without a title or a body, and says so without failing", () => {
    const result = normalizeFlare({ title: "   ", body: "\n\n" });
    expect(result).toEqual({
      ok: false,
      reason: "Nothing was sent: a flare needs a title. Carry on, and send it again with a title if it still matters.",
    });
  });

  it("cuts a long title and a long body, with a note for each", () => {
    const result = normalizeFlare({ title: "word ".repeat(60), body: "x".repeat(BODY_MAX + 50) });
    if (!result.ok) throw new Error("expected a flare");
    expect(result.draft.title.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(result.draft.title.endsWith("…")).toBe(true);
    expect(result.draft.body.length).toBeLessThanOrEqual(BODY_MAX);
    expect(result.notes).toEqual([
      `The title was cut to ${TITLE_MAX} characters; detail belongs in the body.`,
      `The body was cut to ${BODY_MAX} characters.`,
    ]);
  });

  it("understands kinds written another way, and sends an unknown kind as a finding", () => {
    expect(normalizeFlare({ title: "a", kind: "Blocker" })).toMatchObject({ ok: true, draft: { kind: "blocker" } });
    expect(normalizeFlare({ title: "a", kind: "blocked" })).toMatchObject({ ok: true, draft: { kind: "blocker" } });
    expect(normalizeFlare({ title: "a", kind: "update" })).toMatchObject({ ok: true, draft: { kind: "progress" } });
    expect(normalizeFlare({ title: "a", kind: "celebration" })).toEqual({
      ok: true,
      draft: { kind: "finding", title: "a", body: "", urgent: false },
      notes: ['"celebration" is not a kind, so it went as a finding.'],
    });
  });

  it("reads scalars of the wrong type and ignores the rest, instead of failing", () => {
    expect(normalizeFlare({ title: 42, body: { text: "x" }, kind: 7, notify: "true" })).toMatchObject({
      ok: true,
      draft: { title: "42", body: "", urgent: true },
    });
    expect(normalizeFlare({ title: "a", notify: "yes" })).toMatchObject({ ok: true, draft: { urgent: false } });
    expect(normalizeFlare({ title: { text: "x" } })).toMatchObject({ ok: false });
  });

  it("skips a bare heading marker when it takes the title from the body", () => {
    expect(normalizeFlare({ body: "###\nReal first line\nmore" })).toMatchObject({ ok: true, draft: { title: "Real first line", body: "more" } });
  });

  it("does not take inherited object keys for kinds", () => {
    for (const kind of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(normalizeFlare({ title: "a", kind })).toMatchObject({ ok: true, draft: { kind: "finding" } });
    }
  });
});
