import { memoryConfig, memoryNote, type MemoryConfigInput, type MemoryListInput, type MemoryNote, type MemoryProfile, type MemoryReviewRow } from "../shared/memory";
import type { Database } from "./ports";

export type StoredMemory = { note: MemoryNote; reference: string | null };
type Config = { active: string; profiles: MemoryProfile[] };
export class MemoryStore {
  constructor(private readonly db: Database) {}

  config() {
    const row = this.db.prepare("SELECT revision,data FROM tavern_memory_config WHERE id=1").get() as { revision: number; data: string } | undefined;
    return row ? { revision: row.revision, config: memoryConfig.parse(JSON.parse(row.data)) }
      : { revision: 0, config: { active: "builtin", profiles: [] } satisfies Config } as { revision: number; config: Config };
  }
  configure(revision: number, config: Config) {
    if (this.config().revision !== revision) throw new Error("Memory settings changed. Reload them before saving.");
    this.db.prepare(`INSERT INTO tavern_memory_config(id,revision,data) VALUES(1,?,?)
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data`).run(revision + 1, JSON.stringify(memoryConfig.parse(config)));
  }
  settingsView() {
    const { revision, config } = this.config();
    const draft: MemoryConfigInput = { active: config.active, profiles: config.profiles.map(({ hostId: _, ...profile }) => profile) };
    return { revision, config: draft };
  }
  get(store: string, id: string): StoredMemory | null {
    const row = this.db.prepare("SELECT data,reference FROM tavern_memory_notes WHERE id=? AND store=?").get(id, store) as { data: string; reference: string | null } | undefined;
    return row ? { note: memoryNote.parse(JSON.parse(row.data)), reference: row.reference } : null;
  }
  save(store: string, note: MemoryNote, reference: string | null) {
    this.db.prepare("INSERT INTO tavern_memory_notes(id,store,reference,data) VALUES(?,?,?,?)").run(note.id, store, reference, JSON.stringify(memoryNote.parse(note)));
  }
  update(store: string, note: MemoryNote, expectedUpdatedAt: number) {
    if (!this.db.prepare("UPDATE tavern_memory_notes SET data=? WHERE id=? AND store=? AND updated_at=?")
      .run(JSON.stringify(memoryNote.parse(note)), note.id, store, expectedUpdatedAt).changes)
      throw new Error("The note changed. Read the current note before curating it.");
  }
  list(store: string, { project, kind, status, memory, text, limit, offset }: MemoryListInput) {
    const filters = ["store=?", "project=?"], values: (string | number)[] = [store, project];
    for (const [key, value] of [["kind", kind], ["status", status], ["memory", memory]] as const) {
      if (value) { filters.push(`${key}=?`); values.push(value); }
    }
    for (const term of new Set(text.trim().split(/\s+/).filter(Boolean))) {
      filters.push("instr(lower(json_extract(data,'$.title') || ' ' || json_extract(data,'$.body') || ' ' || json_extract(data,'$.tags')),lower(?))>0");
      values.push(term);
    }
    const rows = this.db.prepare(`SELECT data FROM tavern_memory_notes WHERE ${filters.join(" AND ")} ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?`)
      .all(...values, limit + 1, offset) as { data: string }[];
    return { notes: rows.slice(0, limit).map(row => memoryNote.parse(JSON.parse(row.data))), more: rows.length > limit };
  }
  titles(store: string, project: string, ids: readonly string[]) {
    if (!ids.length) return {};
    const rows = this.db.prepare("SELECT id,json_extract(data,'$.title') AS title FROM tavern_memory_notes WHERE store=? AND project=? AND id IN (SELECT value FROM json_each(?))")
      .all(store, project, JSON.stringify(ids)) as { id: string; title: string }[];
    return Object.fromEntries(rows.map(row => [row.id, row.title]));
  }
  unreviewed(store: string, project: string, offset = 0, limit = 6, keeper?: string): MemoryReviewRow[] {
    const within = keeper ? "(project=? OR json_extract(data,'$.curator')=?)" : "project=?";
    const scope = keeper ? [project, keeper] : [project];
    return this.db.prepare(`SELECT id,json_extract(data,'$.title') AS title,json_extract(data,'$.author.thread') AS author,
      json_extract(data,'$.curator') AS curator,json_extract(data,'$.createdAt') AS createdAt,updated_at AS updatedAt
      FROM tavern_memory_notes WHERE store=? AND ${within} AND reviewed_at IS NULL AND status='accepted'
      ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?`).all(store, ...scope, limit, offset) as MemoryReviewRow[];
  }
}
