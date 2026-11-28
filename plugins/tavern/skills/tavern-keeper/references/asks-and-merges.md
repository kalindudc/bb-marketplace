# Keeper reference: asks, notes, and merge approvals

Tool descriptions carry the calling contract. This reference holds the detailed ask, note, consent, attribution, and merge approval rules for Keepers.

## Asks, notes, and consent

- **Clarifications:** Open a `decision` ask with no default for unresolved ambiguities so it survives compaction in Needs you.
- **Your moves:** Open an untimed `decision` ask with `waypointId` and `completeOn`, the option IDs that finish the move. Offer **Done** for a task. An answer outside `completeOn` leaves the move open. Never send the user to the Journal.
- **Notes (`tavern_note`):** Pass `{"op":"add","kind":"fact","text":"Verbatim fact"}` as one flat object. Use `kind: "commitment"` with `dueAt` (Unix milliseconds), or `kind: "waiting-on-user"` with `action` and `need` (one sentence, at most 120 characters). Close a note with `{"op":"done","noteId":"ID"}`. Wrapping or stopping closes that quest's open promises and hand-backs.
- **Member waits:** A member can declare `wait: { condition, dueAt }` in `tavern_report`; it earns no stale strikes before `dueAt`, and Tavern wakes you when due.
- **Outside gates (`tavern_gate`):** Record actual outside contact (who, when, channel, answer). Never sends a message or grants approval. Ticks warn only when a gate becomes ready or its warning changes.
- **Defaults and consequential asks:** Only `decision` with explicit `reversible: true` may default at a stated time. `greenlight`, `merge`, `destructive`, `production`, `cluster-write`, `sends-as-you`, `drafts-as-you`, `credential`, `scope`, and `blocker` NEVER default.
- **Cluster writes (`cluster-write`):** Provide the exact command, known context and namespace, what changes, undo steps when available, and `runThreadId` if a member will execute it. The first answer approves; the second confirms one run by that guarded thread before `keepers.cluster_grant_minutes` expires (default 15 minutes). Neither answer executes anything.
- **Decision fields:** Provide `text`, `why`, `reversible`, `unsure: false`, `change`, `audience`, and `undo`. For your own decision, list `options` and cite `coverageKind` with `coverageId` (route, rule, or answer), or cite `planVersion` and `waypointId` for plan coverage.
- **Attribution:** For an already-answered ask, `tavern_decide` uses `source: "ask"`, the exact `askId`, and the option the user chose, recording the choice without answering again. Tools cannot claim `source: "user"`. A `tavern_rule` with `source: "message"` copies a user message verbatim. Cite its `sourceMessageId` from a routed user message in this Keeper thread, within the quest the route names, or cite an accepted party member’s `user.told-member` receipt. A correction can name the old active rule with `supersedesRuleId` in the same scope. A Keeper proposal stays inactive until confirmed.
- **Stale asks (`tavern_ask`):** Open the new card with `replaces` listing open asks you created for the same quest. Tavern-owned cards, such as greenlight, quest placement, scope changes and held messages, cannot be replaced or withdrawn. If any ID is not eligible, nothing changes. Specify any holds the new card still needs. If no new card is needed, use `operation: "withdraw"`, `askId` and a one-line `reason`. Neither action answers the card or gives consent.
- **Plain merge asks (`tavern_ask`):** To hand an existing ask to the user, pass its `mergeAskId`, `action: "ask-user"`, and a reason. The target stays unchanged and the user answers on its card, not in chat. Pass `action: "withdraw"` when the request is moot; withdrawal records the reason without recording approval.
- **After Stop:** Route retained unrouted messages in order before new quest writes. Never replay an unconfirmed send after an interrupted tool.

## Merge approvals

On a pull request the quest created, push fixes and manage replies, review threads, edits, readiness, reviewers and closure without asking about each act. Use `tavern_pull_request` for readiness or reviewers so the Warden’s check still applies. Use inline text for shell replies so the Ledger can record it. For `tavern_pull_request`, use the recorded pull request ID; `reply` needs the review comment ID and text, and `resolve` needs the review thread ID and whether to resolve or reopen it. Other pull requests keep their usual send and approval rules.

Open a `merge` ask with `target.command`, the full head object ID in `target.commit`, and `target.merge: { repository, targetBranch, sourceBranch }` (or `pullRequest` instead of `sourceBranch`). Use `host/owner/repository` for a network repository, the real path for a local repository, and a full pull request URL.

The exact command must pin the revision: `gh pr merge` uses `--match-head-commit`, GitHub's REST merge uses `sha`, and `git push` uses the full object ID in a single destination refspec. Run any local `git merge` separately, then ask on the resulting revision. Bulk, ambiguous, and forced updates never receive a merge receipt.

For Git pushes, Tavern checks the destination's locally recorded `refs/remotes/<remote>/HEAD` plus `main` and `master` without performing a network lookup; without a locally recorded default, only `main` and `master` are protected. Git source checks inspect the local branch and any fetched tracking ref.

A card approval, or a Keeper decision in the delegated lane with a current Warden verdict, authorizes one attempt within ten minutes. Chat, a routed steer, and an unanswered handoff do not authorize it. A changed head requires fresh approval. If the merge happened outside Tavern, withdraw the ask with reason `done outside Tavern` to record what happened without granting a run. Quest history records the attempt.

Local armed Pi runs pre-execution checks only for these recognized writes. In a detection-only session, the watcher records an exact approved command after dispatch and cannot claim prevention. Tavern does not expand Git or GitHub CLI aliases, read GraphQL request files, or scan scripts and interpreter code.
