import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL, chatModel, createProxy } from "../src/proxy";

const ok = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

afterEach(() => vi.unstubAllEnvs());

describe("createProxy", () => {
  it("sends the prompt to the model's route with a devx token", async () => {
    vi.stubEnv("SHOPIFY_PROXY_KEY", "");
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ok("A title"));
    const complete = createProxy({ fetch: fetch as typeof globalThis.fetch, printToken: async () => "tok-1" });
    expect(await complete(DEFAULT_MODEL, "Task: x", AbortSignal.timeout(1000))).toBe("A title");
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://proxy.shopify.ai/vendors/fireworks/inference/v1/chat/completions");
    expect(init?.headers).toMatchObject({ authorization: "Bearer tok-1" });
    expect(JSON.parse(init?.body as string)).toMatchObject({ model: DEFAULT_MODEL, messages: [{ role: "user", content: "Task: x" }] });
  });

  it("fetches a fresh token once when the proxy refuses the cached one", async () => {
    vi.stubEnv("SHOPIFY_PROXY_KEY", "");
    const tokens = ["stale", "fresh"];
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(ok("Retried"));
    const complete = createProxy({ fetch, printToken: async () => tokens.shift()! });
    expect(await complete(DEFAULT_MODEL, "p", AbortSignal.timeout(1000))).toBe("Retried");
    expect(fetch.mock.calls[1]![1].headers.authorization).toBe("Bearer fresh");
  });

  it("reports the proxy's status and body on failure", async () => {
    vi.stubEnv("SHOPIFY_PROXY_KEY", "env-token");
    const fetch = vi.fn().mockResolvedValue(new Response("overloaded", { status: 503 }));
    const complete = createProxy({ fetch, printToken: async () => "unused" });
    await expect(complete(DEFAULT_MODEL, "p", AbortSignal.timeout(1000))).rejects.toThrow(
      "Shopify AI proxy answered 503: overloaded",
    );
  });
});

describe("chatModel", () => {
  it("routes Fireworks and Gemini models and falls back for other APIs", () => {
    expect(chatModel("gemini-3.8-flash").url).toBe("https://proxy.shopify.ai/v1/chat/completions");
    expect(chatModel("claude-haiku-5-5").model).toBe(DEFAULT_MODEL);
  });
});
