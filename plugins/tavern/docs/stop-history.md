# Quest stop history

A user can leave a short reason when stopping a board quest. The reason and the asks withdrawn by that stop stay with the quest record. This is additive: old callers can still send only the quest id, and old records need no migration.

## Stop input and detail

`stopBoardQuest` accepts:

```ts
{ id: string; reason?: string | null }
```

The server trims the reason and permits at most 500 characters after trimming. Missing, null or blank means no recorded reason. Invalid input is rejected before the quest or its asks change. The runtime applies the same validation for internal callers.

The saved quest exposes `stopReason?: string | null`, inherited by `boardQuest` detail at `detail.quest.stopReason`. A newly recorded stop writes a string or null. Historical records can lack the field; absence means unknown, not an inferred reason.

The existing `quest.stopped` event keeps its user actor and stop-request wording. Its data now contains:

```ts
{ reason: string | null; withdrawnAskIds: string[] }
```

The event ids list exactly the open asks that this stop withdrew. Answered asks, another quest's asks and the Keeper's unattached asks are not included. The stop drains indexed pages, so the receipt is not limited to the usual 500-row read page. Its id count can therefore exceed the asks visible in a single detail response.

There is no dedicated `bb tavern stop` command. A CLI caller using the core RPC command uses the same input contract:

```sh
bb plugin rpc call tavern stopBoardQuest --input-file stop.json
```

No new CLI command or automatic stop was added.

## Withdrawal history

Ask rows have two optional, nullable additions:

```ts
withdrawnAt?: number | null
withdrawnCause?:
  | "quest-stopped"
  | "plan-superseded"
  | "keeper-archived"
  | "turn-recovered"
  | "scope-cleared"
  | null
```

`withdrawnAt` is epoch milliseconds when the server changed the ask to withdrawn. `withdrawnCause` describes why, not who. Existing events retain their actors.

All six existing withdrawal sites use `Keeper.withdrawAsk`: the stop path, two plan-replacement paths, Keeper archival, successful-turn recovery and scope cleanup. It only changes an open ask. Repeated cleanup does not replace a timestamp or cause, and answered/defaulted history is not rewritten.

Only `quest-stopped`, or an id explicitly present in a stop receipt, supports “withdrawn when it stopped.” Other causes and old asks without metadata remain simply withdrawn. No timestamps or causes are backfilled by guessing from the quest's final phase.

## Failure and retry

`Keeper.recordStop` validates and commits the phase, reason, memory closure, ask withdrawals and stop event in one database transaction. A failure before commit leaves those records unchanged. It does not call a provider or start a model turn.

`TavernRuntime.stop` then uses the existing party-only stop and host-status confirmation. It still throws and records `quest.stop-failed` if a stop cannot be confirmed. A retry still attempts to stop the party, but preserves the first stop reason, end time, withdrawn-ask receipt and event rather than replacing them with an empty retry.

This slice does not change machine preservation or lifecycle policy. The placement owner adds any preserve-before-stop gate separately, before `recordStop` and the controlled party stop.

## Verification

`test/server/quest-stop-history.test.ts` covers old RPC input, reason trimming and bounds, exact ask ids, all five causes, record schema compatibility, repeated cleanup, more than one ask page, transaction rollback, an unconfirmed stop followed by a successful retry, turn recovery and scope cleanup. Existing Keeper, archival, recovery, scope, JSON-RPC and backup tests remain part of the focused regression gate.
