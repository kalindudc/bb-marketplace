# Safety and controls

Use this guide to configure guardrails, step away with Closing time, and pull Stop all. See [How Tavern works](design.md) for the architecture and term definitions.

Tavern's guard catches recognized acts before they run where the provider supports it. It is not a general shell or filesystem sandbox. Review any old custom tool, shell, or path rule you relied on: those rules are kept as data, but no longer block ordinary work.

## Scope modes and always-on boundaries

Set `scopes.mode` in **Settings** under **Scopes**, or via `bb tavern settings set scopes.mode=<mode> --apply`:

- **Act guard (`enforce`, default):** Holds applicable recognized sensitive acts. Ordinary calls are recorded without interruptions.
- **Watch (`watch`):** Records calls without discretionary holds.
- **Off (`off`):** Turns off ordinary audit and discretionary holds.

Open **Guardrails** in the Keeper's Ledger or open a member's scope details to see the call count and recent observations. The activity list has no commands, arguments, paths, or payloads and does not claim a call succeeded. Older violations remain marked as legacy scope rules.

Named sends, user-only Tavern controls, member hiring and archival restrictions, and cluster and shared-state policy are separate boundaries. Tavern settings, rules, scope receipts, and guard files have a narrow write protection rather than a general path grant. Members also cannot write class or character overrides in the home or project `.agents/tavern/` directories. Keepers can still edit these overrides, and you can still save them from the Classes page. On macOS the Pi shell overlay protects those files even inside an ordinary script. On hosts without that overlay, known write targets can be checked, but an arbitrary program running under the same account can still modify them.

A Warden cannot edit or commit in the bound maker checkout. On macOS the ordinary shell overlay also protects the checkout and its Git metadata from child processes. Guarded check commands can write to verified ignored outputs and scratch, not to tracked files, Git metadata, or the network. Checks on a host without that containment are not described as sandboxed. Smiths keep their assigned-branch and draft ownership conditions; they don't need a path grant for an ordinary file edit. Own storage and quest scratch are conventions, not confinement.

## Prevention versus detection

| Surface | Guarded local Pi (macOS) | Guarded local Pi (Linux) | Claude Code, Codex, or remote |
| --- | --- | --- | --- |
| Known Tavern control-file writes | Known targets checked; shell overlay (`sandbox-exec`) | Known targets checked, not arbitrary program effects | Detection only |
| Warden check isolation | Guarded maker checks are sandboxed | No filesystem or network sandbox | No filesystem or network sandbox |
| Consequential acts and sends | Prevented before execution | Prevented before execution | Detection only |
| Environment speed bumps | At launch | At launch | At launch |

Local Pi prevention requires the Pi guard shim (`bb tavern guard install`, `status`, or `uninstall` from a terminal). If the shim cannot load the guard in Act guard mode, it admits only reporting, journal and readiness tools until the guard is repaired. Scoped hires prefer Pi whenever it offers the model; otherwise the Keeper must request an explicit one-use detection-only ask. Approved non-Pi and remote members carry a **Detection only (not prevented)** label—watchers stop turns roughly one to two seconds after start and cannot undo completed pushes or sends. Guard changes require restarting open sessions, which the Member panel flags.

## Consequential acts, sends, and cluster writes

Tavern holds recognized merges, publishes, deployments, sends, deletions, credential disclosures, and cluster writes. A Keeper’s supported edits, review replies, thread resolutions and other maintenance on the quest’s own verified GitHub pull request are recorded work, not sends as you. Readiness and reviewer requests go through `tavern_pull_request` with a current Warden check. Unverified records and other forges keep their previous rules. Merging, including sending a pull request to the merge queue, still follows the exact merge guard and approval settings. Generic configuration and machine creation are not held during ordinary work, but still wait during Closing time when its stop list applies.

- **Exact shell grants:** Grant a member one literal command in its directory on the Member panel (once or for the quest, revocable anytime). Grants never cover user-only controls or cluster writes, and backup restores keep history without restoring live grants.
- **Send guard:** Configure tool patterns or literal shell prefixes marked `send` or `draft` in **Settings** under **Scopes**. Blocked sends leave one handoff with recipient and message text; named-target delegation lets a Keeper approve an exact draft, never a send.
- **Cluster writes:** Kubernetes mutations (`kubectl apply`, `patch`, `delete`, `scale`, `exec`, `cp`, `port-forward`, `helm install`, `helm upgrade`, `kapp deploy`, including `--dry-run`) and Terraform applies can never be granted by scope or delegation. Each run needs approval plus a separate immediate confirmation for the exact command. Follow stricter production rules where they apply. Terraform, OpenTofu, and Terragrunt plans must set `TF_CLI_ARGS_plan=-lock=false` and pass `-lock=false`. On a locked state, report the lock ID and holder rather than running force-unlock.
- **macOS Git sandbox:** Tavern's own Git calls run inside an OS sandbox restricting writes to the target checkout and Git metadata and allowing network only for fetch, push, and remote discovery. Forge commands and `gh` run outside it while inheriting Tavern's Git safety overrides.

## Policy files (`scopes.yml`)

Remote-qualified Git push rules remain available in user-global `~/.agents/tavern/scopes.yml`. Tavern no longer runs a startup migration to widen an older preset or update its tool list. Saved class, project, and per-hire rules stay readable. On Pi, Tavern's class loadout hides tools from the model and refuses calls to them, including calls through another tool. Saved tool deny lists do not change the Pi class loadout. The loadout does not grant permission for any act or shell command. Path rules can still affect the Warden check sandbox and the verified checkout requirement for a Smith's assigned-branch push, but do not restrict ordinary edits.

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

Excluded quests and unattached errands hold. Side quests and any attached errands follow their parent. Guarded local Pi members work under the stop list in Drafts-ready quests, and locally guarded permanent members can be exempted from Pause. Solo threads keep running, with guarded solos receiving the stop list. The stop list applies to recognized shell commands and named tools such as pull request merge or deployment tools. It matches tool names regardless of capitalization.

**Back at** never reopens Tavern automatically; once passed, it shows **Due back**. Closing time ends only when you click **Return**, send a new message in a Tavern thread, or answer an ask—never on ticks, agent messages, or page reads. Returning gives you a digest of reports, decisions, open asks, and quests that returned while away, and Keepers issue fresh briefs on their next tick. Consequential blockers wake you by default (respecting notifications and quiet hours); production and cluster-write wakes are opt-in after two hours.

## Stop all and Pause every Keeper

Click **Stop all** on the Common room (or run `bb tavern stop-all`) to send a stop to every live Keeper and member, including remote machines, and hold new ticks, briefs, hires, spawns, and cleanup across restarts without changing quest state or releasing machines. By contrast, **Pause every Keeper** lets running turns finish while holding new Keeper ticks.

Live threads get a five-second stop confirmation window; unconfirmed stops show **still stopping** until observed idle. Already-running hidden tale renderers may finish while new spawns wait. Person-only messages pass while stopped, but a message queued with Tavern's automated work waits until Resume (bb's **Send now** bypasses that hold for the whole batch).

Click **Resume** on the Common room to lift the brake and notify Keepers which members were stopped. If the page is unavailable, run `bb plugin rpc call tavern resumeAll --input '{}'` from an ordinary terminal; there is no `bb tavern resume` command, and plugin or agent callers are refused. Because bb groups desktop, CLI, and unmarked calls under one `client` kind, Resume receipts note that Tavern cannot cryptographically prove a person clicked the button. Live Stop all state is excluded from portable backups.
