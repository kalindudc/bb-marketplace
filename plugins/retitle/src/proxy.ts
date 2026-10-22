import { execFile } from "node:child_process";
import { promisify } from "node:util";

const PROXY_URL = "https://proxy.shopify.ai";
const TOKEN_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_MODEL = "accounts/fireworks/models/glm-5p3-flash";

export type Complete = (model: string, prompt: string, signal: AbortSignal) => Promise<string>;

export interface ProxyDeps {
  fetch: typeof fetch;
  printToken: () => Promise<string>;
}

// Only chat-completions routes are spoken here; shopify-ai's Claude and GPT
// models use other APIs, so those fall back to the default model.
export function chatModel(model: string): { model: string; url: string } {
  if (model.startsWith("accounts/fireworks/")) {
    return { model, url: `${PROXY_URL}/vendors/fireworks/inference/v1/chat/completions` };
  }
  if (model.startsWith("gemini-")) return { model, url: `${PROXY_URL}/v1/chat/completions` };
  return chatModel(DEFAULT_MODEL);
}

async function devxToken(): Promise<string> {
  const { stdout } = await promisify(execFile)("devx", ["llm-gateway", "print-token", "--key"], {
    timeout: 10_000,
  });
  return stdout.trim();
}

export function createProxy(deps: ProxyDeps = { fetch: (...args) => fetch(...args), printToken: devxToken }): Complete {
  let cached: { token: string; at: number } | null = null;

  async function token(refresh: boolean): Promise<string> {
    const fromEnv = process.env.SHOPIFY_PROXY_KEY;
    if (fromEnv) return fromEnv;
    if (!refresh && cached && Date.now() - cached.at < TOKEN_TTL_MS) return cached.token;
    const value = await deps.printToken();
    if (!value) throw new Error("`devx llm-gateway print-token --key` printed no token; export SHOPIFY_PROXY_KEY");
    cached = { token: value, at: Date.now() };
    return value;
  }

  return async (requested, prompt, signal) => {
    const { model, url } = chatModel(requested);
    const body = JSON.stringify({
      model,
      max_tokens: 1024,
      reasoning_effort: "low",
      messages: [{ role: "user", content: prompt }],
    });
    for (const refresh of [false, true]) {
      const response = await deps.fetch(url, {
        method: "POST",
        signal,
        body,
        headers: {
          authorization: `Bearer ${await token(refresh)}`,
          "content-type": "application/json",
          "Shopify-Usage-Tag": JSON.stringify(["bb", "retitle"]),
        },
      });
      if ((response.status === 401 || response.status === 403) && !refresh) continue;
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 200);
        throw new Error(`Shopify AI proxy answered ${response.status}: ${detail}`);
      }
      const reply = (await response.json()) as { choices?: { message?: { content?: string | null } }[] };
      const text = reply.choices?.[0]?.message?.content;
      if (!text) throw new Error("Shopify AI proxy returned no text");
      return text;
    }
    throw new Error("Shopify AI proxy refused a fresh token");
  };
}
