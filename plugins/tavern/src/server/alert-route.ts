import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { alertRouteTag, pushOutcome, testResponse, type AlertRouteView, type HoldReason, type PushOutcome } from "../shared/alert-route";
import type { UserActReceipt } from "./authority";
import type { Keeper } from "./keeper/service";

const pluginId = "push-notifications";
const pushResult = z.object({ ok: z.literal(true), channels: z.array(z.string()) });
type EventRow = { id: number; at: number; data: string };

export class AlertRoute {
  private sending: Promise<AlertRouteView> | null = null;

  constructor(private readonly bb: BbPluginApi, private readonly k: Keeper) {}

  async deliver(title: string, body: string, threadId?: string): Promise<PushOutcome> {
    try {
      const plugin = (await this.bb.sdk.plugins.list()).plugins.find(entry => entry.id === pluginId);
      if (!plugin) return { outcome: "held", reason: "plugin-missing" };
      if (!plugin.enabled) return { outcome: "held", reason: "plugin-disabled" };
      const out = pushResult.parse(await this.bb.sdk.plugins.callRpc({
        pluginId,
        method: "notifications.send",
        input: { title: title.slice(0, 80), body: body.slice(0, 180), ...(threadId ? { threadId } : {}) },
        outputSchema: pushResult as unknown as Parameters<BbPluginApi["sdk"]["plugins"]["callRpc"]>[0]["outputSchema"],
      }));
      return out.channels.length ? { outcome: "sent" } : { outcome: "failed", error: "bb reported no notification channels." };
    } catch (error) {
      return { outcome: "failed", error: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
    }
  }

  recordPush(threadId: string, askId: string | undefined, key: string | null, result: PushOutcome) {
    const holdKey = key && result.outcome === "held" ? JSON.stringify([key, result.reason]) : null;
    if (holdKey && this.k.store.db.prepare("SELECT 1 FROM tavern_events WHERE type='alert.push' AND json_extract(data,'$.holdKey')=? LIMIT 1").get(holdKey)) return;
    this.k.store.event(this.k.now(), null, null, "alert.push", `Alert ${result.outcome}`, {
      ...result, threadId, ...(askId ? { askId } : {}), ...(holdKey ? { holdKey } : {}),
    });
    if (result.outcome !== "held") this.changed();
  }

  hold(threadId: string, askId: string | undefined, key: string | null, reason: HoldReason) {
    this.recordPush(threadId, askId, key, { outcome: "held", reason });
  }

  view(): AlertRouteView {
    const latest = (type: "alert.test" | "alert.test.responded") =>
      this.k.store.db.prepare("SELECT id,at,data FROM tavern_events WHERE keeper_thread_id IS NULL AND type=? ORDER BY id DESC LIMIT 1").get(type) as EventRow | undefined;
    const real = (outcome: "sent" | "failed") =>
      this.k.store.db.prepare("SELECT id,at,data FROM tavern_events WHERE type='alert.push' AND json_extract(data,'$.outcome')=? ORDER BY id DESC LIMIT 1").get(outcome) as EventRow | undefined;
    const test = latest("alert.test"), answer = latest("alert.test.responded");
    const confirmation = answer ? testResponse.parse(JSON.parse(answer.data)) : null;
    const failure = real("failed"), sent = real("sent");
    const testOutcome = test ? pushOutcome.parse(JSON.parse(test.data)) : null;
    const failedAfterConfirmation = (failure?.id ?? 0) > Math.max(sent?.id ?? 0, answer?.id ?? 0)
      || (testOutcome?.outcome === "failed" && test!.id > (answer?.id ?? 0));
    const failureOutcome = failure ? pushOutcome.parse(JSON.parse(failure.data)) : null;
    return {
      proven: confirmation?.response === "arrived" && !failedAfterConfirmation,
      lastTest: test && testOutcome ? { id: test.id, at: test.at, ...testOutcome, response: confirmation?.id === test.id ? confirmation.response : null } : null,
      lastFailure: failure && failureOutcome?.outcome === "failed" ? { at: failure.at, error: failureOutcome.error } : null,
    };
  }

  sendTest(receipt: UserActReceipt): Promise<AlertRouteView> {
    if (this.sending) return this.sending;
    this.sending = this.deliver("Tavern test alert", "If you see this, choose It arrived in Tavern Settings.").then(result => {
      this.k.store.event(this.k.now(), null, null, "alert.test", `Test alert ${result.outcome}`, { ...result, authority: receipt }, { kind: "user" });
      this.changed();
      return this.view();
    }).finally(() => { this.sending = null; });
    return this.sending;
  }

  confirm(id: number, arrived: boolean): AlertRouteView {
    const { lastTest } = this.view();
    if (this.sending || lastTest?.id !== id || lastTest.outcome !== "sent" || lastTest.response !== null)
      throw new Error("Only the latest test that was sent and has no answer can be confirmed.");
    const response = arrived ? "arrived" : "not-arrived";
    this.k.store.event(this.k.now(), null, null, "alert.test.responded", arrived ? "Test alert arrived" : "Test alert did not arrive", { id, response }, { kind: "user" });
    this.changed();
    return this.view();
  }

  private changed() { this.bb.rpc.experimental_invalidate([alertRouteTag]); }
}
