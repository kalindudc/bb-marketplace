import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { parseRenderPrompt } from "./provider";

// Which companion turn shows which flare, so the Flares tab can draw a divider with the flare's time over its message.
// bb tells a message metadata component only the message's turn, so this reads it from the companion's own events: a
// turn request carries the prompt (and with it the flare id), and its acceptance names the turn it became.

// bb serves at most 100 events per page.
const PAGE = 100;

interface Cursor {
  afterSeq: number;
  requests: Map<string, string>;
  marks: Map<string, string>;
}

export class CompanionMarks {
  private readonly cursors = new Map<string, Cursor>();
  private readonly reading = new Map<string, Promise<ReadonlyMap<string, string>>>();

  constructor(private readonly bb: BbPluginApi) {}

  /** turn id to flare id for every flare the companion has drawn so far. */
  read(companionId: string): Promise<ReadonlyMap<string, string>> {
    const running = this.reading.get(companionId);
    if (running !== undefined) return running;
    const next = this.catchUp(companionId).finally(() => this.reading.delete(companionId));
    this.reading.set(companionId, next);
    return next;
  }

  private async catchUp(companionId: string): Promise<ReadonlyMap<string, string>> {
    const cursor = this.cursors.get(companionId) ?? { afterSeq: 0, requests: new Map<string, string>(), marks: new Map<string, string>() };
    this.cursors.set(companionId, cursor);
    for (;;) {
      const rows = await this.bb.sdk.threads.events.list({
        threadId: companionId,
        types: ["client/turn/requested", "turn/input/accepted"],
        order: "asc",
        afterSeq: String(cursor.afterSeq),
        limit: String(PAGE),
      });
      for (const row of rows) {
        cursor.afterSeq = Math.max(cursor.afterSeq, row.seq);
        const data = row.data as { requestId?: unknown; clientRequestId?: unknown; input?: unknown };
        if (row.type === "client/turn/requested" && typeof data.requestId === "string" && Array.isArray(data.input)) {
          const text = (data.input as { type?: unknown; text?: unknown }[]).find((part) => part.type === "text" && typeof part.text === "string")?.text as string | undefined;
          const flareId = text === undefined ? null : parseRenderPrompt(text)?.flareId ?? null;
          if (flareId !== null) cursor.requests.set(data.requestId, flareId);
        } else if (row.type === "turn/input/accepted" && typeof data.clientRequestId === "string" && row.scope.kind === "turn") {
          const flareId = cursor.requests.get(data.clientRequestId);
          if (flareId !== undefined) {
            cursor.marks.set((row.scope as { turnId: string }).turnId, flareId);
            cursor.requests.delete(data.clientRequestId);
          }
        }
      }
      if (rows.length < PAGE) return cursor.marks;
    }
  }

  forget(companionId: string): void {
    this.cursors.delete(companionId);
  }
}
