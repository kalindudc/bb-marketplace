import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

// The host's sidebar and settings change while the overlay stays mounted, which renderSlot cannot drive.
const state = vi.hoisted(() => ({
  threads: [] as unknown[],
  values: undefined as Record<string, boolean> | undefined,
  threadId: null as string | null,
}));
const toast = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast }));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_useSidebarThreads: () => ({ threads: state.threads, status: "ready" }),
  useBbContext: () => ({ threadId: state.threadId }),
  useBbNavigate: () => ({ toThread: () => {} }),
  useSettings: () => ({ values: state.values, isLoading: state.values === undefined }),
}));

import { AttentionToasts } from "../src/notify";

const thread = (id: string, indicator: string) => ({ id, displayTitle: id, indicator, isArchived: false, isHidden: false, parentThreadId: null });

describe("the attention toasts", () => {
  it("toast only threads that start waiting while toasts are on, never a burst when turned on, never the thread on screen", () => {
    state.threads = [thread("a", "waiting-for-input")];
    const view = render(<AttentionToasts />);
    state.values = { badge: true, toasts: false };
    view.rerender(<AttentionToasts />);
    state.threads = [thread("a", "waiting-for-input"), thread("b", "unread-error")];
    view.rerender(<AttentionToasts />);
    expect(toast).not.toHaveBeenCalled();
    state.values = { badge: true, toasts: true };
    view.rerender(<AttentionToasts />);
    expect(toast).not.toHaveBeenCalled();
    state.threads = [...state.threads, thread("c", "waiting-for-input")];
    view.rerender(<AttentionToasts />);
    expect(toast.mock.calls.map((call) => call[0])).toEqual(["c needs you"]);
    state.threadId = "d";
    state.threads = [...state.threads, thread("d", "waiting-for-input")];
    view.rerender(<AttentionToasts />);
    state.threadId = null;
    view.rerender(<AttentionToasts />);
    expect(toast).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});
