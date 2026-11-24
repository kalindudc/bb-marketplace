import { notifyManager } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";

it("schedules batched query notifications on the test window so closing it cancels them", async () => {
  const schedule = vi.spyOn(document.defaultView!, "setTimeout");
  try {
    const notify = vi.fn();
    const listener = notifyManager.batchCalls(notify);
    notifyManager.batch(() => listener("updated"));
    expect(notify).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 0);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(notify).toHaveBeenCalledExactlyOnceWith("updated");
  } finally {
    schedule.mockRestore();
  }
});
