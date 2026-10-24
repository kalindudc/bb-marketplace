import { describe, expect, it } from "vitest";
import { PROMPT_VARIABLES } from "../../src/templates";
import { initials, keyLabel } from "../../src/ui/format";
import { formatRoute, parseRoute } from "../../src/ui/route";
import { sampleReviewVariables } from "../../src/ui/settings/prompt";

describe("page routes", () => {
  it("reads and writes sections, selected PRs, activity and looked-up PRs", () => {
    const key = "delta:shop/world#2261179";
    expect(parseRoute("")).toEqual({ view: "section", section: "needs", key: null });
    expect(parseRoute("team")).toEqual({ view: "section", section: "team", key: null });
    expect(parseRoute("activity")).toEqual({ view: "activity" });
    expect(parseRoute("nonsense")).toEqual({ view: "section", section: "needs", key: null });
    expect(formatRoute({ view: "section", section: "team", key })).toBe("team/delta/shop/world/2261179");
    expect(parseRoute(formatRoute({ view: "section", section: "team", key }))).toEqual({ view: "section", section: "team", key });
    expect(parseRoute(formatRoute({ view: "section", section: "needs", key }))).toEqual({ view: "section", section: "needs", key });
    expect(formatRoute({ view: "pr", key })).toBe("pr/delta/shop/world/2261179");
    expect(parseRoute(formatRoute({ view: "pr", key }))).toEqual({ view: "pr", key });
    expect(parseRoute("pr/github/a/%E0%A4%A/1")).toEqual({ view: "section", section: "needs", key: null });
    expect(parseRoute("requested/github/Shopify/cdn-detective/1494")).toEqual({ view: "section", section: "requested", key: "github:Shopify/cdn-detective#1494" });
    expect(parseRoute(formatRoute({ view: "pr", key: "gitlab:group/sub/proj#77" }))).toEqual({ view: "pr", key: "gitlab:group/sub/proj#77" });
    expect(formatRoute({ view: "section", section: "needs", key: null })).toBe("");
  });
});

describe("small formatting", () => {
  it("badges a server by its capitals, or its first two letters", () => {
    expect(initials("GitHub")).toBe("GH");
    expect(initials("GitLab (self-hosted)")).toBe("GL");
    expect(initials("delta")).toBe("De");
  });

  it("drops the server from a key", () => {
    expect(keyLabel("delta:shop/world#2261179")).toBe("shop/world#2261179");
  });

  it("fills every prompt variable the server offers in the preview's sample", () => {
    expect(Object.keys(sampleReviewVariables("")).sort()).toEqual([...PROMPT_VARIABLES].sort());
  });
});
