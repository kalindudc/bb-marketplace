import { KEEPER_MIGRATIONS } from "./keeper/migrations";
import { QUESTLOG_MIGRATIONS as JOURNAL_MIGRATIONS } from "./journal/migrations";

// Installed live on 2026-11-14: bb.storage.migrate applies statements by position, so the two frozen lists below must
// never change. New statements from either subsystem go ONLY at the end of APPENDED, with a one-line comment.
const APPENDED: string[] = [
  // added by Builder B: durable dispatch receipts, hire reservations and tick outbox; indexes for bounded hot-path reads.
  `CREATE TABLE tavern_messages (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL,
    row_id TEXT UNIQUE, accepted INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX tavern_messages_pair ON tavern_messages(thread_id, text, at) WHERE row_id IS NULL;
  CREATE TABLE tavern_outbox (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX tavern_outbox_thread ON tavern_outbox(thread_id, state);
  CREATE INDEX tavern_records_keeper ON tavern_records(kind, json_extract(data, '$.keeperThreadId'));
  CREATE INDEX tavern_records_quest ON tavern_records(kind, json_extract(data, '$.boardQuestId'));
  CREATE INDEX tavern_records_member ON tavern_records(kind, json_extract(data, '$.memberThreadId'));
  CREATE INDEX tavern_events_type ON tavern_events(keeper_thread_id, type, id);
  CREATE INDEX tavern_events_ref ON tavern_events(type, json_extract(data, '$.askId'));
  INSERT INTO tavern_records(kind,id,data)
    SELECT 'askMeta', json_extract(data, '$.askId'), json_object('planVersion', json_extract(data, '$.planVersion'))
    FROM tavern_events WHERE type='ask.opened' AND json_extract(data, '$.planVersion') IS NOT NULL
    ON CONFLICT(kind,id) DO NOTHING;
  INSERT INTO tavern_records(kind,id,data)
    SELECT 'skips', board_quest_id || ':' || json_extract(data, '$.version') || ':' || json_extract(data, '$.waypointId'),
      json_object('boardQuestId', board_quest_id, 'version', json_extract(data, '$.version'), 'waypointId', json_extract(data, '$.waypointId'))
    FROM tavern_events WHERE type='waypoint.skipped'
    ON CONFLICT(kind,id) DO NOTHING;`,
  // added by Builder B: keep open-ask and active-quest sweeps independent of closed history size.
  `CREATE INDEX tavern_records_state ON tavern_records(kind, json_extract(data,'$.state'), json_extract(data,'$.keeperThreadId'));
   CREATE INDEX tavern_active_quests ON tavern_records(kind) WHERE kind='quests' AND json_extract(data,'$.phase') NOT IN ('done','stopped');`,
  // added by Builder A: track legacy baselines, preserve import overflow and repair previously unbounded change text.
  `CREATE TABLE questlog_imports (thread_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, snapshot TEXT NOT NULL);
   CREATE TABLE questlog_archive (thread_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(thread_id,id,reason));
   CREATE TABLE questlog_mirrors (thread_id TEXT PRIMARY KEY);
   UPDATE questlog_changes SET text = substr(text, 1, 997) || '...' WHERE length(text) > 1000;
   DELETE FROM questlog_changes WHERE seen = 1 AND id NOT IN (SELECT id FROM questlog_changes AS newer WHERE newer.thread_id = questlog_changes.thread_id ORDER BY id DESC LIMIT 500);`,
  // added by Builder B: retain returned quests in a paged archive without crowding the live room or Keeper summaries.
  `ALTER TABLE tavern_records ADD COLUMN archived_at INTEGER;
   UPDATE tavern_records SET archived_at=json_extract(data,'$.archivedAt'), data=json_set(data,'$.archivedAt',json_extract(data,'$.archivedAt')) WHERE kind='quests';
   CREATE INDEX tavern_quest_archive ON tavern_records(kind, archived_at DESC, id DESC);
   CREATE INDEX tavern_keeper_quest_archive ON tavern_records(kind, json_extract(data,'$.keeperThreadId'), archived_at, id);`,
  // added by Tim: audited settings, reversible tuning and timestamped Insights samples without changing installed migrations.
  `CREATE TABLE tavern_settings (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, data TEXT NOT NULL);
   CREATE TABLE tavern_setting_changes (id TEXT PRIMARY KEY, at INTEGER NOT NULL, by TEXT NOT NULL, reason TEXT NOT NULL, evidence TEXT, quest_id TEXT, thread_id TEXT, changes TEXT NOT NULL, undo_data TEXT NOT NULL, undone_at INTEGER);
   CREATE INDEX tavern_setting_changes_at ON tavern_setting_changes(at DESC);
   CREATE TABLE tavern_tuning_runs (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
   CREATE TABLE tavern_tuning_suggestions (key TEXT PRIMARY KEY, data TEXT NOT NULL);
   CREATE TABLE tavern_insight_samples (id TEXT PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, keeper_thread_id TEXT, board_quest_id TEXT, data TEXT NOT NULL);
   CREATE INDEX tavern_insight_samples_at ON tavern_insight_samples(at, kind);
   CREATE TABLE tavern_insight_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE INDEX tavern_events_at ON tavern_events(at, type);`,
  // added by Builder B: bounded Keeper memory, due promises and legacy steer receipt lookups.
  `CREATE INDEX tavern_keeper_notes_due ON tavern_records(kind,json_extract(data,\'$.keeperThreadId\'),json_extract(data,\'$.state\'),json_extract(data,\'$.dueAt\')) WHERE kind=\'notes\';
   CREATE INDEX tavern_keeper_steers ON tavern_records(kind,json_extract(data,\'$.keeperThreadId\'),json_extract(data,\'$.kind\')) WHERE kind=\'routes\';
   CREATE INDEX tavern_messages_time ON tavern_messages(thread_id,at);`,
  // added by Builder B: attention ignores acknowledged history; durable per-decision batch tokens make Undo conditional.
  `CREATE INDEX tavern_decision_attention ON tavern_records(kind,json_extract(data,'$.keeperThreadId'))
     WHERE kind='decisions' AND json_extract(data,'$.source')='keeper' AND json_extract(data,'$.reversible')=1
     AND json_extract(data,'$.undone')=0 AND json_extract(data,'$.seenAt') IS NULL;
   CREATE INDEX tavern_decision_seen_token ON tavern_records(json_extract(data,'$.token')) WHERE kind='decisionSeen';`,
  // added by Builder B: tale and legacy skip lookups must not scan the Keeper's event history.
  `CREATE INDEX tavern_events_quest_type ON tavern_events(board_quest_id,type,id);`,
  // added by Builder B: durable machine reservations fence late callbacks and count every nonreleased rule placement.
  `CREATE TABLE tavern_placements (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
   CREATE UNIQUE INDEX tavern_placement_hire ON tavern_placements(json_extract(data,'$.hireToken'));
   CREATE INDEX tavern_placement_slots ON tavern_placements(json_extract(data,'$.keeperThreadId'),json_extract(data,'$.slot'))
     WHERE json_extract(data,'$.rule') IS NOT NULL AND json_extract(data,'$.phase')<>'released';
   CREATE INDEX tavern_placement_active ON tavern_placements(id) WHERE json_extract(data,'$.phase')<>'released';
   CREATE TABLE tavern_source_snapshots (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));`,
  // added by Builder B: source-read discovery fences private metadata without reserving a member or machine slot.
  `CREATE TABLE tavern_placement_discoveries (
     keeper_thread_id TEXT PRIMARY KEY, generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 9007199254740991),
     record_json TEXT NOT NULL CHECK(json_valid(record_json)), updated_at INTEGER NOT NULL
   );
   CREATE INDEX tavern_discovery_host ON tavern_placement_discoveries(json_extract(record_json,'$.endpoint.hostId'));`,
  // Exact delivery bytes and native receipts are private authority, never portable backup state.
  `ALTER TABLE tavern_placements ADD COLUMN scope_delivery_json TEXT
     CHECK(scope_delivery_json IS NULL OR json_valid(scope_delivery_json));`,
  `CREATE TABLE tavern_snapshot_owners (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)));
   CREATE INDEX tavern_snapshot_descriptor_owner ON tavern_source_snapshots(json_extract(data,'$.ownerId'));`,
  // Opening receipt visibility must not scan every route when reading event history.
  `CREATE INDEX tavern_route_source ON tavern_records(json_extract(data,'$.sourceMessageId')) WHERE kind='routes';`,
  // The stop-time lookup must not sort or scan a quest's full phase history.
  `CREATE INDEX tavern_events_quest_phase_time ON tavern_events(board_quest_id,type,at DESC,id DESC);`,
  `CREATE INDEX tavern_events_phase_receipts ON tavern_events(board_quest_id,at DESC,id DESC) WHERE json_type(data,\'$.phase\')=\'object\';`,
  `CREATE INDEX tavern_handback_attention ON tavern_records(json_extract(data,\'$.keeperThreadId\'),json_extract(data,\'$.boardQuestId\')) WHERE kind=\'notes\' AND json_extract(data,\'$.state\')=\'open\' AND json_extract(data,\'$.kind\')=\'waiting-on-user\';
   CREATE INDEX tavern_rule_attention ON tavern_records(json_extract(data,\'$.keeperThreadId\'),json_extract(data,\'$.scopeId\')) WHERE kind=\'rules\' AND json_extract(data,\'$.active\')=0 AND json_extract(data,\'$.source\')=\'keeper-proposed\' AND json_extract(data,\'$.confirmedAt\') IS NULL;
   CREATE INDEX tavern_rule_origin ON tavern_events(json_extract(data,\'$.ruleId\'),id DESC) WHERE type=\'rule.added\';`,
  `DROP INDEX tavern_decision_attention;
   CREATE INDEX tavern_decision_attention ON tavern_records(kind,json_extract(data,'$.keeperThreadId'))
     WHERE kind='decisions' AND (json_extract(data,'$.source')='keeper' OR json_type(data,'$.checkChange')='object')
     AND json_extract(data,'$.reversible')=1 AND json_extract(data,'$.undone')=0 AND json_extract(data,'$.seenAt') IS NULL;
   CREATE INDEX tavern_undo_ask_decisions ON tavern_records(json_extract(data,'$.keeperThreadId'))
     WHERE kind='decisions' AND json_extract(data,'$.source')='keeper' AND json_extract(data,'$.reversible')=1 AND json_extract(data,'$.askId') IS NOT NULL;`,
];

export const MIGRATIONS: string[] = [
  ...JOURNAL_MIGRATIONS,
  ...KEEPER_MIGRATIONS,
  ...APPENDED,
];
