import { describe, expect, it } from "vitest";
import {
  MAX_LINEUP,
  modelName,
  moveModel,
  nativeRowTitle,
  normalizeLineup,
  resolveModel,
  rowTitleIndex,
  searchCatalog,
  setPinned,
  timeAgo,
  type CatalogProvider,
} from "../src/lineup";

const codex: CatalogProvider = {
  id: "codex",
  displayName: "Codex",
  brandPrefix: "GPT-",
  models: [
    { model: "gpt-6.1-sol", displayName: "GPT-6.1-Sol" },
    { model: "gpt-5.5", displayName: "GPT-5.5" },
  ],
};
const pi: CatalogProvider = {
  id: "pi",
  displayName: "Pi",
  models: [
    { model: "anthropic/claude-opus-5-5", displayName: "Claude Opus 5.5", routeProviderId: "anthropic" },
    { model: "anthropic-1m/claude-opus-5-5", displayName: "Claude Opus 5.5", routeProviderId: "anthropic-1m" },
    { model: "openai/gpt-5.5", displayName: "GPT-5.5", routeProviderId: "openai" },
    { model: "dup/a", displayName: "Twin" },
    { model: "dup/b", displayName: "Twin" },
  ],
};

describe("lineup", () => {
  it("pins at the end and unpins, idempotently, keeping one copy", () => {
    const a = { providerId: "pi", model: "openai/gpt-5.5" };
    const b = { providerId: "codex", model: "gpt-5.5" };
    let lineup = setPinned([], a, true);
    lineup = setPinned(lineup, b, true);
    expect(lineup).toEqual([a, b]);
    expect(setPinned(lineup, a, true)).toEqual([a, b]);
    expect(setPinned(lineup, a, false)).toEqual([b]);
    expect(setPinned([b], a, false)).toEqual([b]);
    expect(normalizeLineup([a, a, b])).toEqual([a, b]);
  });

  it("caps the lineup", () => {
    const many = Array.from({ length: MAX_LINEUP + 3 }, (_, n) => ({ providerId: "pi", model: `m${n}` }));
    expect(normalizeLineup(many)).toHaveLength(MAX_LINEUP);
  });

  it("moves a model and ignores moves past either end", () => {
    const a = { providerId: "pi", model: "a" };
    const b = { providerId: "pi", model: "b" };
    expect(moveModel([a, b], b, -1)).toEqual([b, a]);
    expect(moveModel([a, b], a, -1)).toEqual([a, b]);
  });

  it("names models the way bb's menu does", () => {
    expect(modelName(codex.models[0]!, codex.brandPrefix)).toBe("6.1-Sol");
    expect(nativeRowTitle(pi.models[0]!)).toBe("Claude Opus 5.5 · anthropic");
    expect(modelName({ model: "x", displayName: "GPT-" }, "GPT-")).toBe("GPT-");
  });

  it("maps row titles to model ids and leaves shared titles out", () => {
    const index = rowTitleIndex(pi);
    expect(index.get("Claude Opus 5.5 · anthropic-1m")).toBe("anthropic-1m/claude-opus-5-5");
    expect(index.has("Twin")).toBe(false);
    expect(rowTitleIndex(codex).get("6.1-Sol")).toBe("gpt-6.1-sol");
  });

  it("resolves only models the catalog offers", () => {
    expect(resolveModel([pi, codex], { providerId: "codex", model: "gpt-5.5" })).toEqual({
      providerId: "codex",
      model: "gpt-5.5",
      name: "5.5",
      providerName: "Codex",
    });
    expect(resolveModel([pi], { providerId: "codex", model: "gpt-5.5" })).toBeNull();
  });

  it("searches every provider by name, id, route and provider, minus excluded models", () => {
    const hits = searchCatalog([pi, codex], "5.5", [{ providerId: "pi", model: "openai/gpt-5.5" }], 10);
    expect(hits.map((hit) => `${hit.providerId}:${hit.model}`)).toEqual([
      "pi:anthropic/claude-opus-5-5",
      "pi:anthropic-1m/claude-opus-5-5",
      "codex:gpt-5.5",
    ]);
    expect(searchCatalog([pi, codex], "codex 5.5", [], 10).map((hit) => hit.model)).toEqual(["gpt-5.5"]);
    expect(searchCatalog([pi, codex], "  ", [], 10)).toEqual([]);
    expect(searchCatalog([pi, codex], "opus", [], 1)).toHaveLength(1);
  });

  it("formats elapsed time compactly", () => {
    const now = 1_000_000_000_000;
    expect(timeAgo(now - 30_000, now)).toBe("now");
    expect(timeAgo(now - 4 * 60_000, now)).toBe("4m");
    expect(timeAgo(now - 5 * 3_600_000, now)).toBe("5h");
    expect(timeAgo(now - 3 * 86_400_000, now)).toBe("3d");
  });
});
