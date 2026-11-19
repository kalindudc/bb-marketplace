// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { LedgerTab } from "../../../src/ui/thread/tabs";
import { fixtureLedger, fixtureDecor, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { withAttention } from "../attention-fixture";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it.each(["need", "new"])("opens the Ledger at its %s group", async group => {
  const targets: string[] = [];
  const previous = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: function(this: Element) { targets.push(this.getAttribute("data-attention-group")!); } });
  try {
    const slot = renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null, params: { attentionGroup: group } }, { rpc: { ledger: () => withAttention(fixtureLedger), decor: () => fixtureDecor, registry: () => fixtureRegistry } });
    await waitFor(() => expect(targets).toEqual([group]));
    slot.lifecycle.unmount();
  } finally {
    if (previous) Object.defineProperty(Element.prototype, "scrollIntoView", previous);
    else delete (Element.prototype as Partial<Element>).scrollIntoView;
  }
});
