import { experimental_useRpcMutation } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { rpcContract } from "../../shared/contract";
import type { CharacterDef } from "../../shared/schema";
import { CharacterAvatar } from "../engine/avatar";
import type { MotionMode } from "../engine/rules";

export function AvatarRoll({ character, mode, projectId, target, revision }: { character: CharacterDef; mode: MotionMode | undefined; projectId: string | null; target: "global" | "project"; revision?: string }) {
  const seed = character.avatar ?? character.id;
  const [receipt, setReceipt] = useState<{ from: string; kept: string } | null>(null);
  const [rolled, setRolled] = useState<{ seed: string; revision: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = experimental_useRpcMutation({ contract: rpcContract, method: "saveCharacterAvatar" });
  const saved = receipt?.from === seed ? receipt.kept : seed;
  if (receipt && receipt.from !== seed) setReceipt(null);
  const shown = rolled?.seed ?? saved;
  const pins = Object.entries(character.look ?? {})
    .filter(([, value]) => value !== undefined)
    .map(([trait]) => trait === "hairColour" ? "hair colour" : trait);
  const roll = () => {
    if (!revision) return;
    let next: string;
    do { next = crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36); } while (next === shown || next === saved);
    setRolled({ seed: next, revision });
    setError(null);
  };
  const keep = async () => {
    if (rolled === null) return;
    setError(null);
    try {
      await save.mutate({ characterId: character.id, avatar: rolled.seed, target, projectId, revision: rolled.revision });
      setReceipt({ from: seed, kept: rolled.seed });
      setRolled(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  return <fieldset className="tv-avatar-roll tv-grpbox" disabled={save.isPending || !revision}>
    <legend className="sr">Avatar</legend>
    <CharacterAvatar character={character} seed={shown} {...(mode === undefined ? {} : { mode })} />
    <div className="tv-avatar-info">
      <b>Avatar</b>
      <div className="tv-avatar-actions">
        <button className="btn" type="button" onClick={roll}>Roll</button>
        <button className="btn pri" type="button" disabled={rolled === null} onClick={() => void keep()}>{save.isPending ? "Keeping…" : "Keep"}</button>
        <button className="btn" type="button" disabled={rolled === null} onClick={() => { setRolled(null); setError(null); }}>Put back</button>
      </div>
      <p className="m small" role="status">{rolled !== null ? "This roll is not saved." : saved === character.id && !character.avatar ? "Roll to try a new look." : "Avatar kept."}</p>
      {error && <p className="tv-problem" role="alert">Avatar not kept: {error}</p>}
      {pins.length > 0 && <p className="m small">Pinned in the file: {pins.join(", ")}</p>}
    </div>
  </fieldset>;
}
