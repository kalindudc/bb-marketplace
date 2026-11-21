import { statSync } from "node:fs";
import { CHARACTER_PRESENTATION_PROBLEM_PREFIX, characterReportVoiceSchema, type CharacterAuthorship, type CharacterReportVoices } from "../shared/character-presentation";
import type { KeeperStore } from "./keeper/store";
import type { Registry, RegistryFile, RegistrySnapshot } from "./registry";

const whitespace = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

export function readCharacterPresentation(registry: Registry, snapshot: RegistrySnapshot, store: KeeperStore) {
  const problems = [...snapshot.problems];
  const problem = (path: string, error: unknown) => problems.push({ path, message: `${CHARACTER_PRESENTATION_PROBLEM_PREFIX}${error instanceof Error ? error.message : String(error)}` });
  const characterAuthorship: CharacterAuthorship[] = [];
  for (const character of snapshot.characters) {
    let file: RegistryFile | null = null, changedAt: number | null = null;
    try {
      file = registry.characterFile(character);
      if (file.source !== "shipped") {
        if (!file.path) throw new Error(`The character ${character.id} has no source file path`);
        const stat = statSync(file.path);
        if (!stat.isFile()) throw new Error("The character source is not a file");
        const at = Math.trunc(stat.mtimeMs);
        if (!Number.isSafeInteger(at)) throw new Error("The character file modification time is invalid");
        changedAt = at;
      }
    } catch (error) {
      problem(file?.path ?? character.source, error);
    }
    if (file) characterAuthorship.push({ characterId: character.id, source: file.source, changedAt });
  }
  const grouped = new Map<string, CharacterReportVoices>();
  if (snapshot.characters.length) try {
    const rows = store.db.prepare(`WITH voice_reports AS (
      SELECT r.id AS reportId, json_extract(m.data,'$.characterId') AS characterId,
        ROW_NUMBER() OVER (PARTITION BY json_extract(m.data,'$.characterId')
          ORDER BY json_extract(r.data,'$.createdAt') DESC, r.id DESC) AS position
      FROM tavern_records r
      JOIN tavern_records m ON m.kind='members' AND m.id=json_extract(r.data,'$.memberThreadId')
      WHERE r.kind='reports' AND json_extract(r.data,'$.status')='done'
        AND json_type(r.data,'$.voice')='text' AND length(trim(json_extract(r.data,'$.voice'),?))>0
        AND json_extract(m.data,'$.characterId') IN (SELECT value FROM json_each(?))
    ) SELECT ranked.characterId, r.id AS reportId, json_extract(r.data,'$.voice') AS line,
      json_extract(r.data,'$.createdAt') AS at, q.id AS questId,
      CASE WHEN COALESCE(json_extract(t.data,'$.memberEngagement.host.deletedAt'), json_extract(t.data,'$.deletedAt')) IS NOT NULL THEN NULL
        ELSE json_extract(r.data,'$.memberThreadId') END AS threadId
    FROM voice_reports ranked
    JOIN tavern_records r ON r.kind='reports' AND r.id=ranked.reportId
    LEFT JOIN tavern_runtime t ON t.thread_id=json_extract(r.data,'$.memberThreadId')
    LEFT JOIN tavern_records q ON q.kind='quests' AND q.id=json_extract(r.data,'$.boardQuestId')
    WHERE ranked.position<=3 ORDER BY ranked.characterId, ranked.position`)
      .all(whitespace, JSON.stringify(snapshot.characters.map(character => character.id))) as (CharacterReportVoices["voices"][number] & { characterId: string })[];
    for (const { characterId, ...voice } of rows) {
      let group = grouped.get(characterId);
      if (!group) { group = { characterId, voices: [] }; grouped.set(characterId, group); }
      group.voices.push(characterReportVoiceSchema.parse(voice));
    }
  } catch (error) {
    grouped.clear();
    problem("reports", error);
  }
  return { characterAuthorship, characterReportVoices: [...grouped.values()], problems };
}
