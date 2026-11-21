import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { fireEvent, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { CommonRoom } from "../../../src/ui/page/room";
import { moss, registry, richRoom, wren } from "./scenes";

const gone = { ...moss, threadId: "thr-gone", displayName: "Ada" };
const idle = { ...moss, threadId: "thr-idle", displayName: "An unselected Keeper" };
const room = { ...richRoom, keepers: [...richRoom.keepers, ...[gone, idle].map(member => ({ ...richRoom.keepers[1]!, member, errands: [], boardQuests: [] }))] };
const targets = room.keepers.map(k => ({ threadId: k.member.threadId, name: k.member.threadId === wren.threadId ? "Wren" : k.member.threadId === moss.threadId ? "Moss" : "Ada", status: k.member.threadId === gone.threadId ? "gone" as const : "ready" as const }));
function mount() {
  const prepare = vi.fn(async (input: unknown) => ({ targets: targets.filter(target => (input as { keeperIds: string[] }).keeperIds.includes(target.threadId)) }));
  const send = vi.fn(async (_: { threadId: string }) => ({ delivery: "sent" as const, ok: true as const }));
  const slot = renderSlot({ component: () => <div className="tavern tv-page"><CommonRoom room={room} registry={registry} /></div> }, {}, { rpc: { prepareTellKeepers: prepare }, sdk: { threads: { send } } });
  return { slot, send, prepare };
}

it("sends the unchanged message through the signed-in bb client and gives one result per selected Keeper", async () => {
  const { slot, send, prepare } = mount();
  try {
    fireEvent.click(slot.getByText("Tell selected Keepers"));
    for (const name of ["Wren", "Moss", "Ada"]) fireEvent.click(slot.getByRole("checkbox", { name }));
    const text = "  Use two columns.\nKeep `Quoted` exactly.  ";
    fireEvent.change(slot.getByRole("textbox", { name: "Message" }), { target: { value: text } });
    fireEvent.click(slot.getByRole("button", { name: "Send message" }));
    const receipts = await slot.findByRole("list", { name: "Message receipts" });
    expect(within(receipts).getAllByRole("listitem")).toHaveLength(3);
    expect(receipts.textContent).toContain("Ada: Skipped; the thread is gone.");
    expect(prepare).toHaveBeenCalledWith({ keeperIds: [wren.threadId, moss.threadId, gone.threadId] });
    expect(send.mock.calls.map(([args]) => args)).toEqual([wren.threadId, moss.threadId].map(threadId => ({
      threadId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }],
    })));
  } finally { slot.lifecycle.unmount(); }
});

it.runIf(process.env.TAVERN_UI_ITEMS_HARNESS === "1")("renders the tell form and message receipts", async () => {
  const { slot } = mount();
  try {
    fireEvent.click(slot.getByText("Tell selected Keepers"));
    for (const name of ["Wren", "Moss", "Ada"]) fireEvent.click(slot.getByRole("checkbox", { name }));
    fireEvent.change(slot.getByRole("textbox", { name: "Message" }), { target: { value: "Use two columns.\nKeep the header unchanged." } });
    const form = slot.container.querySelector(".tv-tell")!.outerHTML;
    fireEvent.click(slot.getByRole("button", { name: "Send message" }));
    const receipts = await slot.findByRole("list", { name: "Message receipts" });
    process.stdout.write("TELL_SELECTED=" + JSON.stringify({ form, receipts: receipts.outerHTML }) + "\n");
  } finally { slot.lifecycle.unmount(); }
});
