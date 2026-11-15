import { experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { rpcContract, type registrySchema } from "../../shared/contract";
import type { z } from "zod";
import { memberName } from "../../shared/member-name";
export type Registry = z.infer<typeof registrySchema>;
export function useRegistry() {
    return experimental_useRpcQuery({ contract: rpcContract, method: "registry", input: {} });
}
/** A character for a member who has none (its class's pool was empty): the name is the class label, and Crest draws the class's plain shape. */
export type MemberCharacter = Registry["characters"][number] & { plain?: true };
function plainCharacter(cls: Registry["classes"][number], name: string): MemberCharacter {
    return { id: "", name, classes: [cls.id], hue: "ink", charge: "chevron", temper: "", style: "", quirks: [], lines: { hired: "", row: "", done: "", wrap: "", empty: "" }, body: "", source: "none", plain: true };
}
/**
 * A member's class and character. `character.name` is the member's display name ("Lark II") when the party repeats a name. A member with
 * no character, or one the registry no longer knows, gets its class's plain crest and the shared name (the class label). Null only when
 * the registry doesn't know the class.
 */
/**
 * Whether character lines are drawn: Character voice in Settings, with a missing field (an older server) meaning on. Off hides every
 * character line (hired lines, report voices) and keeps their history. While the registry is unknown nothing is drawn, so a line the
 * user turned off never flashes in.
 */
export const voiceShown = (registry: Pick<Registry, "voice"> | null | undefined): boolean => registry != null && registry.voice !== "off";
export function memberIdentity(registry: Registry, member: {
    classId: string;
    characterId: string | null;
    displayName?: string | null;
}): { cls: Registry["classes"][number]; character: MemberCharacter } | null {
    const cls = registry.classes.find(c => c.id === member.classId);
    if (!cls) return null;
    const found = member.characterId ? registry.characters.find(c => c.id === member.characterId) : undefined;
    if (found) return { cls, character: member.displayName ? { ...found, name: member.displayName } : found };
    return { cls, character: plainCharacter(cls, memberName(member, registry)) };
}
