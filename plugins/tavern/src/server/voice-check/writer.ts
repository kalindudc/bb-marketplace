import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ClassDef } from "../../shared/schema";
import { resolveHireExecution } from "../execution";
import type { VoiceModel } from "./run";

/**
 * The model a character really works on: its first class's, resolved by the same code that hires use, so settings and class
 * overrides apply. A Keeper isn't hired, so it takes its class's model or bb's default provider and model. The model is always
 * named, because the editor shows it and the judge needs its family.
 */
export async function resolveWriter(bb: Pick<BbPluginApi, "sdk">, classes: readonly ClassDef[], characterId: string, projectId: string): Promise<VoiceModel> {
  const role = classes.find((c) => c.characters.includes(characterId));
  if (!role) throw new Error(`no class lists the character ${characterId}`);
  const fallback = (await bb.sdk.system.config()).serverAccess.defaultProviderId;
  const chosen: VoiceModel = role.id === "keeper"
    ? { providerId: role.provider ?? fallback, ...(role.model ? { model: role.model } : {}) }
    : await resolveHireExecution(bb as BbPluginApi, role, { providerId: fallback, environmentId: null, projectId }).then(({ providerId, model, reasoningLevel }) => ({ providerId, ...(model ? { model } : {}), ...(reasoningLevel ? { reasoningLevel } : {}) }));
  if (chosen.model) return chosen;
  const catalog = await bb.sdk.providers.models({ providerId: chosen.providerId, projectId });
  const model = catalog.models.find((m) => m.isDefault)?.model;
  if (!model) throw new Error(`${chosen.providerId} names no default model`);
  return { ...chosen, model };
}
