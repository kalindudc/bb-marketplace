import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { RPC_TAGS } from "../src/rpc-tags";
import { REWOUND_REASON, guardWrite, rewind } from "../src/ui/dispatch";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

// Every RPC that changes something invalidates what it changed; the reads carry tags instead.
const writes = Object.entries(RPC_TAGS)
  .filter(([, tags]) => "invalidates" in tags)
  .map(([method]) => method);
// Forge profiles are Settings, apart from any project, so a rewound page leaves them alone.
const settings = (method: string) => /ForgeProfile/.test(method);

afterEach(() => {
  rewind.set(null);
  vi.mocked(toast.error).mockClear();
});

describe("the rewind guard", () => {
  it("refuses every write that changes a project while the page is rewound, with one toast each", () => {
    expect(writes.filter((method) => !settings(method)).length).toBeGreaterThan(10);
    rewind.set({ slug: "csv", at: 12 });
    for (const method of writes.filter((method) => !settings(method))) expect(() => guardWrite(method), method).toThrow(REWOUND_REASON);
    expect(toast.error).toHaveBeenCalledTimes(writes.filter((method) => !settings(method)).length);
  });

  it("lets the forge profiles and every read through while rewound, and every write once back at now", () => {
    rewind.set({ slug: "csv", at: 12 });
    for (const method of writes.filter(settings)) expect(() => guardWrite(method), method).not.toThrow();
    for (const method of ["project", "ticket", "home", "timeline"]) expect(() => guardWrite(method), method).not.toThrow();
    rewind.set(null);
    for (const method of writes) expect(() => guardWrite(method), method).not.toThrow();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
