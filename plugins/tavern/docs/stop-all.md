# Stop all

Stop all sends bb a stop for every known live Keeper and member, including members on another machine. It sends the stop even when a status read would fail or the thread looks idle. It then holds new ticks, briefs, hires and spawns, and pending release, archive and quest-stop cleanup. Restarting Tavern does not lift that hold. No Keeper turn or model is involved, and no quest state, party or machine is released by the brake.

Anyone may pull it from the common room or with `bb tavern stop-all`. Pulling it again while stopped sends fresh stops and records a new receipt without resuming first. The original stop time and caller stay unchanged. Concurrent pulls share the in-flight collection. Read the state and last receipt with `bb tavern stop-all status`.

On restart, registry preparation, thread observation, worktree pinning, tick recovery and scope preset refresh still run. Hire recovery, archive repair, quest stops and cleanup wait until Resume. Resume runs those deferred startup steps once and records a `tavern.startup-reconciled` event; it does not rerun the setup steps.

## Messages while stopped

Person-only messages pass. A message queued together with Tavern's own work waits until you resume. bb's dispatch hook decides for the whole queued group and cannot admit only your message. Send now bypasses that hook and can send the held automated work too; it does not preserve the brake for those rows.

## Confirmations

Each thread has one five-second bound for the stop and its confirmation together. A timeout is still stopping, not a failed stop. The stop request can still be reaching a remote machine. A failed stop call retains its error. A failed confirmation read is still stopping because the stop was already sent.

A still-stopping entry becomes stopped when an existing thread-status observation reports that it is no longer running. There is no polling timer and observations never send another stop. A restart closes an interrupted collection so the receipt does not say collecting forever. The receipt retains the request time, confirmation times, errors and calling surface. Its elapsed time is from the request to the last confirmed stop, not an assertion that every thread stopped.

bb's public stop response is only `{ ok: true }`; it does not say that there was nothing to stop. Tavern therefore counts a confirmed idle result as stopped, not already idle. It does not infer already idle from a possibly stale status read. That counter remains zero unless bb provides such proof in a future SDK.

On Resume each Keeper receives an event listing the members to which Stop all sent stops. It can check their reports and issue fresh briefs. The event does not claim that each member completed its assignment.

## Resume and caller provenance

Resume is intended for the user on the common room. Tavern has no CLI resume command. It refuses plugin callers and any agent, thread or CLI markers exposed on the RPC context. It records the available surface in the Resume receipt and event, without recording an unverified client call as the user's act.

Tavern can't prove a person pressed Resume. The public RPC context exposes a caller kind, either plugin with a plugin id or client, and an abort signal. Its documentation explicitly puts the app, bb CLI, agents and bb itself into client. It supplies no CLI surface, thread id or origin for those client calls. An unmarked generic RPC call from an agent shell is therefore indistinguishable from the page. The UI and receipt say so. Denying Tavern control commands in member and Keeper shells is a separate layer of protection, not caller attestation.

The live brake record is excluded from portable backup capture and cannot be restored. A backup must not flip it without a transition.

## Scope

Already-running hidden tale-renderer companions are outside the Keeper-and-member stop scope and may finish. New companion spawns are held. A held placed hire can free an unstarted reservation, but that reservation owns no spawned member or machine. Pause every Keeper is separate: it pauses new Keeper work while running turns finish.
