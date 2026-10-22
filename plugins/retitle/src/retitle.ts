import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Complete } from "./proxy";
import { DEFAULT_MODEL } from "./proxy";
import { type InputPart, type TitleSource, cleanTitle, titlePrompt, titleSource } from "./title";

// bb leaves prompts shorter than this untitled on purpose; automatic retitling does too.
const MIN_WORDS = 5;
const REQUEST_TIMEOUT_MS = 20_000;

type BbSdk = BbPluginApi["sdk"];

export type Outcome =
  | { threadId: string; status: "titled"; title: string }
  | { threadId: string; status: "skipped" | "failed"; reason: string };

export interface RetitleDeps {
  sdk: BbSdk;
  complete: Complete;
}

export function worthTitling(source: TitleSource): boolean {
  return source.commands.length > 0 || source.task.split(/\s+/u).filter(Boolean).length >= MIN_WORDS;
}

async function firstPrompt(sdk: BbSdk, threadId: string): Promise<InputPart[] | null> {
  const [row] = await sdk.threads.events.list({
    threadId,
    types: ["client/turn/requested"],
    order: "asc",
    limit: "1",
  });
  const input = (row?.data as { input?: unknown } | undefined)?.input;
  return Array.isArray(input) ? (input as InputPart[]) : null;
}

// Follows the title model chosen in the shopify-ai plugin, so both titlers agree.
async function titleModel(sdk: BbSdk): Promise<string> {
  try {
    const { values } = await sdk.plugins.getSettings({ pluginId: "shopify-ai" });
    return typeof values.model === "string" ? values.model : DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

/** Titles one thread. Without `force` it leaves titled threads and short prompts alone, as bb does. */
export async function retitle(deps: RetitleDeps, threadId: string, force: boolean): Promise<Outcome> {
  const thread = await deps.sdk.threads.get({ threadId });
  if (!force && thread.title) return { threadId, status: "skipped", reason: "already titled" };
  const input = await firstPrompt(deps.sdk, threadId);
  const source = input === null ? null : titleSource(input);
  if (source === null) return { threadId, status: "skipped", reason: "no typed first message" };
  if (!force && !worthTitling(source)) return { threadId, status: "skipped", reason: "first message too short" };

  let reply: string;
  try {
    reply = await deps.complete(await titleModel(deps.sdk), titlePrompt(source), AbortSignal.timeout(REQUEST_TIMEOUT_MS));
  } catch (error) {
    return { threadId, status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
  const title = cleanTitle(reply);
  if (title === null) return { threadId, status: "failed", reason: "the model returned an empty title" };

  if (!force && (await deps.sdk.threads.get({ threadId })).title) {
    return { threadId, status: "skipped", reason: "titled while the model was answering" };
  }
  await deps.sdk.threads.update({ threadId, title });
  return { threadId, status: "titled", title };
}
