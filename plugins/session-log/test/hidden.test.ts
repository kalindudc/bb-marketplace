import { describe, expect, it } from "vitest";
import { applyRequestEvents, hiddenMessagesOf } from "../src/hidden";
import { acceptedEvent, rejectedEvent, requestEvent } from "./fixtures";

describe("hiddenMessagesOf", () => {
  it("keeps a plugin's agent-only steer, which bb's timeline drops", () => {
    expect(hiddenMessagesOf(requestEvent(25))).toEqual([expect.objectContaining({
      kind: "hidden",
      id: "hidden:creq_25",
      seq: 25,
      startedAt: 2_500,
      turnId: "turn-1",
      steer: true,
      alongsideVisible: false,
      text: "Relevant memory: task 42",
      attachments: [],
    })]);
  });

  it("ignores messages the chat already shows in full", () => {
    expect(hiddenMessagesOf(requestEvent(1, {
      input: [{ type: "text", text: "Please check the tests.", mentions: [] }],
      target: { kind: "thread-start" },
    }))).toEqual([]);
  });

  it("keeps only the hidden parts of a message the chat shows in part", () => {
    const [message] = hiddenMessagesOf(requestEvent(5, {
      input: [
        { type: "text", text: "Look at @notes", mentions: [] },
        { type: "text", text: "Context for @notes", mentions: [], visibility: "agent-only" },
        { type: "localImage", path: "/tmp/shot.png", visibility: "agent-only" },
      ],
      target: { kind: "new-turn" },
    }));
    expect(message).toMatchObject({
      alongsideVisible: true, steer: false, turnId: null, text: "Context for @notes", attachments: ["Image: /tmp/shot.png"],
    });
  });

  it("treats a suppressed tool result as hidden in full, and marks retries", () => {
    const [result] = hiddenMessagesOf(requestEvent(7, {
      initiator: "system",
      systemMessageKind: "tool-result-delivered",
      systemMessageSubject: { kind: "tool-call", toolName: "wait_for_ci", suppress: true },
      input: [{ type: "text", text: "CI passed", mentions: [] }],
    }));
    expect(result).toMatchObject({ suppressedTool: "wait_for_ci", alongsideVisible: false, text: "CI passed" });

    const [retry] = hiddenMessagesOf(requestEvent(9, { retryOfRequestId: "creq_1", target: { kind: "new-turn" } }));
    expect(retry).toMatchObject({ retry: true, steer: false });
  });

  it("reads each input group of a grouped dispatch on its own", () => {
    const messages = hiddenMessagesOf(requestEvent(11, {
      inputGroups: [
        [{ type: "text", text: "Visible", mentions: [] }],
        [{ type: "text", text: "Hidden", mentions: [], visibility: "agent-only" }],
      ],
    }));
    expect(messages.map(({ id, text, alongsideVisible }) => [id, text, alongsideVisible]))
      .toEqual([["hidden:creq_11:1", "Hidden", false]]);
  });
});

describe("applyRequestEvents", () => {
  it("places an accepted steer at its acceptance, like bb places a visible steer", () => {
    const messages = applyRequestEvents([], [requestEvent(25), acceptedEvent(27, "creq_25")]);
    expect(messages).toEqual([expect.objectContaining({ seq: 27, startedAt: 2_700, steer: true, turnId: "turn-1" })]);
  });

  it("turns a steer that found no running turn into a message of the new turn", () => {
    const messages = applyRequestEvents([], [requestEvent(25), acceptedEvent(27, "creq_25", "turn-2")]);
    expect(messages[0]).toMatchObject({ seq: 25, steer: false, turnId: "turn-2" });
  });

  it("marks rejections, keeps order by seq, and returns the same list when nothing changes", () => {
    const first = applyRequestEvents([], [requestEvent(10), requestEvent(12)]);
    const settled = applyRequestEvents(first, [acceptedEvent(14, "creq_10"), rejectedEvent(15, "creq_12")]);
    expect(settled.map(({ id, seq, rejected }) => [id, seq, rejected])).toEqual([
      ["hidden:creq_12", 12, true], ["hidden:creq_10", 14, false],
    ]);
    expect(applyRequestEvents(settled, [acceptedEvent(20, "creq_other"), requestEvent(10)])).toBe(settled);
  });
});
