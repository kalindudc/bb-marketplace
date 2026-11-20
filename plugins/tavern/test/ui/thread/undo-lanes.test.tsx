// @vitest-environment jsdom
import { fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { expect, it, vi } from "vitest";
import { LedgerTab } from "../../../src/ui/thread/tabs";
import { fixtureDecor, fixtureLedger, fixtureRegistry } from "../../../src/ui/thread/fixtures";

it("shows the Ledger's undo count and invokes the explicit Reset for that kind", async () => {
  const reset = vi.fn((_input: unknown) => ({ ok: true }));
  const slot = renderSlot({ component: LedgerTab }, { threadId: "keeper-1", environment: null }, { rpc: {
    ledger: () => ({ ...fixtureLedger, boardQuests: [], asks: [], undoLanes: [{ kind: "credential", undone: 2, recent: 10 }] }),
    decor: () => fixtureDecor, registry: () => fixtureRegistry, resetUndoLane: reset,
  } });
  try {
    expect(await slot.findByText(/You undid 2 of my last 10 credential decisions/i)).toBeTruthy();
    const button = await slot.findByRole("button", { name: "Reset credential decisions" });
    expect(button.textContent).toBe("Reset");
    if (process.env.TAVERN_UNDO_LAYOUT === "1") {
      const panel = slot.container.querySelector('[aria-label="Decisions that now ask you"]')!;
      process.stdout.write("UNDO_LAYOUT=" + JSON.stringify(`<div class="tavern ledger"><main class="lg-body">${panel.outerHTML}</main></div>`) + "\n");
    }
    fireEvent.click(button);
    await waitFor(() => expect(reset.mock.calls[0]?.[0]).toMatchObject({ threadId: "keeper-1", kind: "credential" }));
  } finally { slot.lifecycle.unmount(); }
});
