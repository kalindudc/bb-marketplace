# Safety and controls

Use this guide to configure guardrails, step away with Closing time, and pull Stop all. See [How Tavern works](design.md) for the architecture and term definitions.

Scopes guard against agent mistakes and overreach rather than hostile attacks: every agent runs at bb permission mode `full`, and scopes constrain tools, file writes, shell commands, consequential acts, sends as you, and cluster writes on top.

## Scope modes and always-on boundaries

Set `scopes.mode` in **Settings** under **Scopes**, or via `bb tavern settings set scopes.mode=<mode> --apply`:

- **`enforce` (default):** Prevents supported violations before execution on guarded local Pi sessions and stops watched sessions after detection.
- **`watch`:** Records what would have needed a grant without blocking ordinary violations or running the macOS bash sandbox.
- **`off`:** Disables ordinary scope enforcement and recording.

Open **Guardrails** in a Keeper's Ledger to see its scope posture and recorded violations. On hover, the highlight spans the entire header to the card border.

Three boundaries stay on in every mode: guarded agents cannot send messages as you; scoped shells (including Keepers) cannot run user-only Tavern controls (such as `ask`, `guard install`, `backup restore --apply`, guardrail settings edits, rule confirmations, quest stops, or Resume); and party members cannot spawn or archive threads.

## Class presets

| Class | Preset | Allowed in `enforce` mode |
| --- | --- | --- |
| Ranger | `readonly` | Runs local programs, pipes, and input redirects; checked writes stay in temp and `BB_THREAD_STORAGE`. Git, GitHub, and cluster writes keep their own checks. |
| Warden | `checker` | Runs local programs without an allowlist; check runners and verbatim done-when commands must run in the maker's bound worktree. On macOS, checks may write to verified ignored outputs and scratch, not tracked files, Git metadata, or the network. |
| Smith | `worktree` | Writes to its bound worktree, Git metadata, temp, and `BB_THREAD_STORAGE`; pushes and opens or edits drafts only on its assigned branch. Falls back to `readonly` until bound. |
| Keeper | `open` | Direct writes and ordinary shell acts except protected paths, user-only Tavern controls, cluster writes, and typed pull request acts. |
| Hired Wanderer | `open` | No sandbox; protects sensitive paths and gates consequential shell acts behind a grant after restart. |
| Direct Wanderer or plain thread | None | Ordinary bb thread with no Tavern scope file. |

Members can use their own `BB_THREAD_STORAGE` and the configured temporary roots. For shared quest scratch on the same local host, use `scratch/<quest id>` under the Keeper's thread storage. Other folders in the Keeper's storage and storage on other hosts aren't implicitly shared. An explicit deny still applies inside any of these locations.

All restrictive presets and hired Wanderers protect `~/.ssh`, `~/.pi/agent/extensions`, `~/.claude`, `~/.agents/tavern/scopes.yml`, and Tavern's scopes directory. Without the macOS sandbox, Tavern cannot see writes inside a running program.

## Prevention versus detection

| Surface | Guarded local Pi (macOS) | Guarded local Pi (Linux) | Claude Code, Codex, or remote |
| --- | --- | --- | --- |
| Native tools and paths | Prevented before execution | Prevented before execution | Detection only (stopped after start) |
| Bash filesystem writes | OS sandbox (`sandbox-exec`) | Shell parser checks | Detection only |
| Consequential acts and sends | Prevented before execution | Prevented before execution | Detection only |
| Environment speed bumps | At launch | At launch | At launch |

Local Pi prevention requires the Pi guard shim (`bb tavern guard install`, `status`, or `uninstall` from a terminal). Scoped hires prefer Pi whenever it offers the model; otherwise the Keeper must request an explicit one-use detection-only ask. Approved non-Pi and remote members carry a **Detection only (not prevented)** label—watchers stop turns roughly one to two seconds after start and cannot undo completed pushes or sends. Guard changes require restarting open sessions, which the Member panel flags.

## Consequential acts, sends, and cluster writes

Tavern classifies shell commands through one catalogue covering merges, publishes, marking ready, closing, reviewing, deploys, cluster writes, sends, drafts, deletes, configuration changes, credentials, Tavern controls, and allocations. Ordinary commands—plugin validation, read-only queries, `git diff`, auth login and config, `bb secrets request`, read-only machine checks, and loopback HTTP writes—are not blocked. Commands ending in `-machines` classify by verb (`rotate`, `park`, and `remove` as configuration; `create` and `enroll` as allocation).

- **Exact shell grants:** Grant a member one literal command in its directory on the Member panel (once or for the quest, revocable anytime). Grants never cover user-only controls or cluster writes, and backup restores keep history without restoring live grants.
- **Send guard:** Configure tool patterns or literal shell prefixes marked `send` or `draft` in **Settings** under **Scopes**. Blocked sends leave one handoff with recipient and message text; named-target delegation lets a Keeper approve an exact draft, never a send.
- **Cluster writes:** Kubernetes mutations (`kubectl apply`, `patch`, `delete`, `scale`, `exec`, `cp`, `port-forward`, `helm install`, `helm upgrade`, `kapp deploy`, including `--dry-run`) and Terraform applies can never be granted by scope or delegation. Each run needs your approval plus a separate immediate confirmation on the same card for one run within 15 minutes by default.
- **macOS Git sandbox:** Tavern's own Git calls run inside an OS sandbox restricting writes to the target checkout and Git metadata and allowing network only for fetch, push, and remote discovery. Forge commands and `gh` run outside it while inheriting Tavern's Git safety overrides.

## Policy files (`scopes.yml`)

Rules resolve in order: shipped class preset and class file narrowings, user-global `~/.agents/tavern/scopes.yml` (trusted; may narrow or authorize remote-qualified Git push widenings), project `<project>/.agents/tavern/scopes.yml` (narrowing only; widenings are ignored and flagged), and per-hire updates.

To let a Smith push to `main` on personal repositories, add a rule to `~/.agents/tavern/scopes.yml` (checked against the actual normalized push target):

```yaml
v: 1
rules:
  - remote: github.com/your-user/*
    classes:
      smith:
        defaults:
          allowRules: [git-push-main]
```

Use `keeperMayAllow` instead of `defaults` to let Keepers opt in per hire. Remote-qualified grants cover only Git push rules (`git-push-main`, `git-push-force`, `git-push-target`). Inspect effective scopes and violations with `bb tavern scope <thread-id>` and `bb tavern violations [thread-id]`.

## Closing time

Open **Closing time** from the Common room when stepping away. Set a **Back at** reminder (default 8:00 local time), an optional 500-character note, each quest's end state (**Drafts-ready** to allow guarded local work under a temporary stop list and even finish internally while archival waits, or **Pause** to interrupt members and hold new work without releasing machines), the temporary stop list (default blocks merges, deploys, production, sends as you, deletes, and broad other writes), and whether watched members may continue (off by default).

Excluded quests and unattached errands hold; side quests follow their parent. Guarded local Pi members work under the stop list in Drafts-ready quests, and locally guarded permanent members can be exempted from Pause. Solo threads keep running, with guarded solos receiving the stop list.

**Back at** never reopens Tavern automatically; once passed, it shows **Due back**. Closing time ends only when you click **Return**, send a new message in a Tavern thread, or answer an ask—never on ticks, agent messages, or page reads. Returning gives you a digest of reports, decisions, open asks, and quests that returned while away, and Keepers issue fresh briefs on their next tick. Consequential blockers wake you by default (respecting notifications and quiet hours); production and cluster-write wakes are opt-in after two hours.

## Stop all and Pause every Keeper

Click **Stop all** on the Common room (or run `bb tavern stop-all`) to send a stop to every live Keeper and member, including remote machines, and hold new ticks, briefs, hires, spawns, and cleanup across restarts without changing quest state or releasing machines. By contrast, **Pause every Keeper** lets running turns finish while holding new Keeper ticks.

Live threads get a five-second stop confirmation window; unconfirmed stops show **still stopping** until observed idle. Already-running hidden tale renderers may finish while new spawns wait. Person-only messages pass while stopped, but a message queued with Tavern's automated work waits until Resume (bb's **Send now** bypasses that hold for the whole batch).

Click **Resume** on the Common room to lift the brake and notify Keepers which members were stopped. If the page is unavailable, run `bb plugin rpc call tavern resumeAll --input '{}'` from an ordinary terminal; there is no `bb tavern resume` command, and plugin or agent callers are refused. Because bb groups desktop, CLI, and unmarked calls under one `client` kind, Resume receipts note that Tavern cannot cryptographically prove a person clicked the button. Live Stop all state is excluded from portable backups.
