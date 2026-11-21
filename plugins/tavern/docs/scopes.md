# Scopes and guardrails

Tavern scopes put guardrails on agent threads to catch mistakes and overreach—they are not a hostile-agent security boundary. Every agent runs at bb permission mode `full`; scopes constrain tools, file writes, shell commands, consequential acts, sends as you, and cluster writes on top.

## Scope modes

Set `scopes.mode` in **Settings → Guardrails** (or `bb tavern settings set scopes.mode=<mode> --apply` from a user terminal):

| Mode | Effect |
| --- | --- |
| `enforce` (default) | Prevents supported violations before execution on guarded local Pi sessions; stops and notifies on watched violations. |
| `watch` | Records what would have needed a grant (`would have needed a grant: …`) on the Member panel and Keeper view without stopping ordinary violations or running the macOS bash sandbox. |
| `off` | Disables ordinary scope enforcement and recording. |

**Always enforced regardless of mode (`enforce`, `watch`, or `off`):**
- **Send guard:** Agents with an active guard cannot send messages as you.
- **Tavern user-only controls:** Scoped shells (including Keepers) cannot run user-only Tavern CLI commands or RPCs (`ask`, `guard install`, `backup restore --apply`, `settings set --apply` on guardrails, rule confirmations, quest stops, or Resume).
- **Member spawn/archive boundaries:** Party members cannot start threads (`spawn`, `bb_workflow_run`, `bb thread spawn`) or run `bb thread archive`; they must ask their Keeper.

## Class presets

| Class | Preset | What it allows in `enforce` mode |
| --- | --- | --- |
| **Ranger** | `readonly` | All tools visible. Writes only to temp (`TMPDIR`, `/tmp`) and own `BB_THREAD_STORAGE`. May run `git fetch` with read-only metadata allowance. No pushes, GitHub writes, or cluster writes. |
| **Warden** | `checker` | `readonly` rules plus verified check runners (`npm/pnpm/yarn/bun run <script>`, `npx tsc`, direct or `node node_modules/…` project binaries) and verbatim done-when commands inside the maker's worktree. On macOS, check calls have no network and cannot write tracked files or Git metadata. |
| **Smith** | `worktree` | Writes to bound linked worktree, Git metadata, temp, and `BB_THREAD_STORAGE`. May push (including `--force-with-lease` + `--force-if-includes`) only to its hire-assigned branch, and open/edit/comment on its own draft PR on that branch. If the worktree is not yet bound, falls back to `readonly` until bound. |
| **Keeper** | `open` | Direct writes, network, and ordinary shell acts except protected files, Tavern user-only controls, cluster writes, and PR acts with a typed lane. |
| **Hired Wanderer** | `open` | No sandbox. Protects `~/.ssh`, `~/.pi/agent/extensions`, `~/.agents/tavern/scopes.yml`, `~/.claude/settings*.json`, and Tavern's scopes directory. Consequential shell acts require a grant after session restart. |
| **Direct Wanderer / untyped** | None | No Tavern scope file; runs as your ordinary bb thread. |

Every restrictive preset (`readonly`, `checker`, `worktree`) also protects `~/.ssh`, `~/.pi/agent/extensions`, `~/.claude`, `~/.agents/tavern/scopes.yml`, and Tavern's scopes directory.

## Prevention versus detection

| Guard surface | Guarded local Pi (macOS) | Guarded local Pi (Linux) | Claude Code / Codex / placed remote |
| --- | --- | --- | --- |
| Native tools & paths | Prevented before execution | Prevented before execution | Detection only (watcher stops after start) |
| Bash filesystem writes | OS sandbox (`sandbox-exec`) by effect | Conservative shell parser checks | Detection only |
| Consequential shell acts & sends | Prevented before execution | Prevented before execution | Detection only |
| Env speed bumps | Applied at launch | Applied at launch | Applied at launch |

- **Pi guard shim:** Required for pre-execution enforcement on local Pi. Manage it from a user terminal:
  ```sh
  bb tavern guard install
  bb tavern guard status
  bb tavern guard uninstall
  ```
- **Detection-only exception:** Scoped hires prefer Pi whenever it offers the configured model. If Pi does not offer it, the hire refuses unless the Keeper requests an explicit one-use `scope` ask (`requestDetectionOnly: true`) and you approve it. Approved non-Pi members are labelled **Detection only (not prevented)**—a watcher can stop a turn after ~1–2 s, never undo a completed push or send.
- **Restarting older sessions:** Changes to the Pi guard or send guard require restarting already-open provider sessions; the Member panel flags when a session needs a restart.

## Consequential shell acts, sends and cluster writes

Tavern classifies shell commands through one shared catalogue (`src/scope/acts.ts`): `merge`, `publish`, `ready`, `close`, `review`, `deploy`, `cluster-write`, `send`, `draft`, `delete`, `configure`, `credential`, `tavern-control`, and `allocate`.

- **Ordinary work stays ordinary:** Plugin validation, read-only queries, `git diff`, `gcloud auth login`, `gcloud config set`, `bb secrets request`, bb machine reads, cortex reads/updates, and HTTP writes strictly targeting loopback (`localhost`, `127.0.0.0/8`, `::1`) are not blocked as consequential acts.
- **Machine provider commands:** Tavern classifies bb command groups ending in `-machines` by their verb, not by the provider name. `rotate`, `park` and `remove` are configuration acts; `create` and `enroll` are allocation acts.
- **Exact shell grants:** On the Member panel, you can grant a member one literal command in its directory once or for the quest, and revoke it at any time. Grants never cover Tavern user-only controls or cluster writes, and restoring a backup keeps grant history without restoring live permission.
- **Send guard (`scopes.send_tools`):** Add tool-name patterns (with optional `target_key`) or literal shell command prefixes with `act: "send"` or `"draft"` in Settings. Blocked sends leave a single handoff with the visible recipient and message text. Named-target quest delegation lets a Keeper approve one exact draft call; only you send.
- **Cluster writes (`cluster-write`):** Kubernetes writes (`kubectl apply`, `patch`, `delete`, `scale`, `exec`, `cp`, `port-forward`, `helm install/upgrade`, `kapp deploy`, including `--dry-run`), Terraform applies, and similar cluster mutations can never be granted by scope or quest delegation. Each run requires your approval plus a separate immediate confirmation on the same card (valid for one run by the named thread, expiring after `keepers.cluster_grant_minutes`, default `15` min).
- **macOS Git sandbox:** Git invoked directly by Tavern runs inside a macOS OS sandbox that restricts writes to the target checkout and required Git metadata and allows network only for fetch, push, and remote discovery. Forge profile commands and `gh` run outside that sandbox while inheriting Tavern's Git safety config overrides.

## Policy files (`scopes.yml`) and overrides

Precedence is strictly ordered:
1. Shipped class preset and validated class frontmatter narrowing (`scope:` in a class Markdown file can only narrow, never widen).
2. User-global `~/.agents/tavern/scopes.yml` (trusted; may narrow or authorize Git push widenings).
3. Project `<project>/.agents/tavern/scopes.yml` (untrusted; **narrowing only**—any widening or `keeperMayAllow` entry is ignored and surfaced as a policy problem).
4. Per-hire or live `tavern_scope` override (narrowings apply immediately; widenings require global policy or an explicit user `scope` ask).

### Example: allow Smith to push to `main` on personal repos

Put this in `~/.agents/tavern/scopes.yml` (the remote is checked against the push target's actual normalized URL, never just any remote in the checkout):

```yaml
v: 1
rules:
  - remote: github.com/your-user/*
    classes:
      smith:
        defaults:
          allowRules: [git-push-main]
```

To let the Keeper opt in per hire instead of enabling it by default, use `keeperMayAllow`:

```yaml
v: 1
rules:
  - remote: github.com/your-user/*
    classes:
      smith:
        keeperMayAllow: [git-push-main]
```

Remote-qualified grants apply only to Git push rules (`git-push-main`, `git-push-force`, `git-push-target`). Force/delete/mirror pushes, merges, deploys, and cluster writes stay blocked unless explicitly granted separately.

## Inspecting scopes and violations

```sh
bb tavern scope <thread-id>       # Effective scope, guard posture, and arming state
bb tavern violations [thread-id]  # Recorded violations with evidence, stop results, and latency
bb tavern guard status            # Local Pi guard shim state
```
