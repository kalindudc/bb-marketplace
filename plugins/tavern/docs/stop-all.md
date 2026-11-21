# Stop all

**Stop all** is Tavern's emergency brake. Pulling it sends bb a stop for every known live Keeper and party member—including members on separate machines—and holds all new ticks, briefs, hires, spawns, and pending cleanup until you press **Resume**.

## Pull the brake or check status

- **From the UI:** Click **Stop all** on the Common room.
- **From a terminal:**
  ```sh
  bb tavern stop-all
  bb tavern stop-all status
  ```

Pulling **Stop all** again while stopped sends fresh stops and records a new receipt without resuming first. Restarting bb or reloading Tavern does **not** lift the hold.

### Stop all versus Pause every Keeper

| Control | Running turns | New work & cleanup | Quest state & machines |
| --- | --- | --- | --- |
| **Stop all** | Sends stop to every live Keeper and member | Holds ticks, briefs, hires, spawns, and cleanup across restarts | Left intact (nothing released or archived) |
| **Pause every Keeper** (`tavern.paused`) | Lets running turns finish | Holds new Keeper ticks; asks remain answerable | Left intact |

## Confirmations and queued messages

- Each live thread gets a 5-second stop-and-confirmation window. A timeout is recorded as **still stopping** (not failed) and clears automatically when Tavern next observes the thread idle.
- Person-only messages can still pass while stopped. A user message queued in the same batch as Tavern's own automated work waits until Resume (bb's **Send now** bypasses that hold for the entire batch).
- Already-running hidden tale-renderer companions may finish; new companion spawns are held.

## Resuming and caller provenance

1. Click **Resume** on the Common room. On Resume, Tavern runs any deferred startup reconciliation once and sends each Keeper an event listing the members that were stopped so it can inspect reports and re-brief them.
2. **If the Common room page is unavailable:** From an ordinary user terminal (outside any agent thread), you can invoke the RPC directly:
   ```sh
   bb plugin rpc call tavern resumeAll --input '{}'
   ```
   Tavern has no `bb tavern resume` command and refuses plugin callers and any context carrying agent, thread, or CLI markers.

> **Provenance note:** bb's RPC context currently groups the desktop app, CLI, and unmarked client calls under the same `client` caller kind (see [host ask 2](host-asks.md#2-distinguish-human-driven-clients-from-agents)). Resume receipts therefore record that Tavern cannot prove a person pressed Resume. The live Stop all state is never captured in or restored from portable backups.
