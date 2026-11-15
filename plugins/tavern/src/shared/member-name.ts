type Identity = { classId: string; characterId: string | null; displayName?: string | null };
type Names = { characters: readonly { id: string; name: string }[]; classes: readonly { id: string; label: string }[] };

export function memberName(member: Identity, registry: Names): string {
  return member.displayName ||
    registry.characters.find(character => character.id === member.characterId)?.name ||
    registry.classes.find(role => role.id === member.classId)?.label ||
    member.classId.charAt(0).toUpperCase() + member.classId.slice(1);
}
