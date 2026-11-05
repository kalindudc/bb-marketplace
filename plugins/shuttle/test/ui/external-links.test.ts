import { afterEach, describe, expect, it, vi } from "vitest";
import type { BbNavigate } from "@get-bb/plugin-sdk/app";
import { isWebUrl, openExternal } from "../../src/ui/data";

afterEach(() => vi.restoreAllMocks());

describe("links from servers", () => {
  const navigate = (handled: boolean) => ({ openUrl: vi.fn(() => handled) }) as unknown as BbNavigate & { openUrl: ReturnType<typeof vi.fn> };

  it("opens http(s) links, through bb when it takes them and the ordinary way when it declines", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const bb = navigate(true);
    openExternal(bb, "https://ci.example.com/run/7");
    expect(bb.openUrl).toHaveBeenCalledWith("https://ci.example.com/run/7");
    expect(open).not.toHaveBeenCalled();
    openExternal(navigate(false), "http://ci.example.com/run/8");
    expect(open).toHaveBeenCalledWith("http://ci.example.com/run/8", "_blank", "noopener,noreferrer");
  });

  it("never opens another scheme, which a check's details URL or a command server could carry", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const bb = navigate(false);
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "vscode://open?x", "ssh://host", "data:text/html,hi", "not a url", ""]) {
      expect(isWebUrl(url)).toBe(false);
      openExternal(bb, url);
    }
    expect(bb.openUrl).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(isWebUrl(null)).toBe(false);
    expect(isWebUrl("HTTPS://CI.example.com/x")).toBe(true);
  });
});
