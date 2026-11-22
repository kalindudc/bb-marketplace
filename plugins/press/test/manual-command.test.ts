import { describe, expect, it } from "vitest";
import { isCompactDraft, isCompactSubmitKey } from "../src/ui/manual-command";

const draft = { text: "/compact", attachments: [], mentions: [] };
const key = { key: "Enter", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false, repeat: false };

describe("native manual command", () => {
  it("recognizes only /compact without instructions, attachments or mentions", () => {
    expect(isCompactDraft(draft)).toBe(true);
    expect(isCompactDraft({ ...draft, text: " /compact " })).toBe(true);
    for (const text of ["/compact focus", "/compactness", "please /compact", "/compact\nNext task"]) {
      expect(isCompactDraft({ ...draft, text })).toBe(false);
    }
    expect(isCompactDraft({ ...draft, attachments: [{}] })).toBe(false);
    expect(isCompactDraft({ ...draft, mentions: [{}] })).toBe(false);
  });

  it("only intercepts ordinary Enter, not line breaks, other shortcuts or composition", () => {
    expect(isCompactSubmitKey(key)).toBe(true);
    for (const flag of ["ctrlKey", "altKey", "metaKey", "shiftKey", "isComposing"] as const) {
      expect(isCompactSubmitKey({ ...key, [flag]: true })).toBe(false);
    }
    expect(isCompactSubmitKey({ ...key, key: "Tab" })).toBe(false);
  });
});
