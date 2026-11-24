# Stop all reference

Anyone, including a Keeper or party member, may run `bb tavern stop-all`, including again while stopped. Read the stored state and last receipt with `bb tavern stop-all status`.

## What Stop all stops and holds

- Sends bb a stop for every known live Keeper and party member, including members on separate machines, without gating on a status read.
- Holds all new ticks, briefs, hires, spawns, and pending releases and archives across bb restarts and Tavern reloads until resumed.
- Leaves quest state, slots, and machines intact without releasing or archiving anyone.
- Gives each live thread a five-second stop-and-confirmation window. A timeout is recorded as still stopping (not failed) and clears automatically when Tavern next observes the thread idle.
- Already-running hidden tale-renderer companions are outside the stop scope and may finish; new companion spawns are held.
- A placed hire stopped before spawning may free its unstarted reservation because no member or machine exists to release.

## Queued messages and Send now

Person-only messages can pass while stopped. A user message queued in the same batch as Tavern's own automated work waits until Resume. Note that bb's Send now bypasses the dispatch hook and sends the entire batch, including held automated work; it is not a way to send only a user message while keeping the brake on.

## Resume caller limits

Resume is reserved for the user on the Common room. There is no `bb tavern resume` CLI command. Plugin callers and any exposed agent, thread, or CLI markers are refused. Because bb currently groups desktop, CLI, and unmarked client calls under one `client` caller kind without a thread ID or origin, Resume receipts note that Tavern cannot cryptographically prove a person clicked Resume. NEVER use a generic RPC call, shell command, or alternate send or spawn path to bypass the brake. Live Stop all state is never saved in or restored from portable backups.

Pause every Keeper (`tavern.paused`) is separate: it lets running turns finish while holding new Keeper ticks.
