# Machines and snapshots

Use **Settings → Where work runs** to place newly hired working members onto their own new machines through bb's environment and machine providers. Tavern has no machine provider of its own and stays provider-agnostic; it uses whatever providers bb exposes on your host.

## How machine placement works

- **Rule matching:** Enabled rules under `machines.rules` are evaluated in order against project IDs, repository remotes, Keeper path globs, Keeper environment providers, class IDs, and quest IDs.
- **Who moves:** Matching rules place newly hired Rangers, Smiths, Wardens, and Wanderers. Keepers stay where you started them unless a rule explicitly includes `keeper` (or names no classes). A child Keeper lead runs where its hiring Keeper runs unless the hiring Keeper selects a matching enabled rule with `placement`.
- **Supported target in 0.2.0:** Only rules requesting a **new machine with a dedicated checkout** execute today. Other target shapes save, preview, and block hires with a plain reason.
- **Slot limits:** `machines.max_makers` (default `2`) and `machines.max_checkers` (default `2`) cap active remote machines per Keeper. Waiting for a slot is a visible hold—Tavern never silently falls back to your local machine.
- **Cross-repo hires:** A Keeper can name a target repo (`repo`, a bb project ID) on a hire. Cross-repo hires start from that repo's pushed default-branch tip without your local uncommitted changes. A Warden defaults to its maker's repo.
- **Posture:** Placed members are labelled **Detection only (remote)** under Tavern. When a placed member's scope changes, Tavern delivers the updated scope to the machine and shows **Scope update pending** until the machine acknowledges it.

## Per-class model overrides on rules

Each rule can override `provider`, `model`, and `reasoning` per matching class (`class_models`):

1. Open the rule in **Settings → Where work runs** and choose models under **Models on these machines**. Changes stage locally until you click **Save rule**.
2. Choose **Use the class's model** to remove an override; saving also cleans up overrides for classes the rule no longer matches.
3. Tavern checks the effective model before hiring and records first-turn model-resolution failures for that machine, environment, and provider. A later hire with the same failing model refuses before allocating a machine (clear the record on the rule card once fixed). Temporary provider overloads are not recorded as model failures, and Tavern never silently substitutes a fallback model.

## How source code travels (snapshots)

Tavern carries work between your home checkout and remote machines using porcelain Git on member machines and verified object/tree assembly at home. Your local index, worktree, `HEAD`, refs, branches, and stash are never touched.

1. **Hire capture (home → member):** For the Keeper's own repo, Tavern captures the pushed base, unpushed commits, and any changed tracked or untracked files via a temporary index. The member's first turn calls `tavern_ready`, which binds the machine, carries the source in as `Tavern carried snapshot`, and delivers its scope. The hire result's first line names the repo, rule, target, and whether uncommitted files came along.
2. **Submission capture (Smith → Warden):** When a Warden is hired to check a placed Smith, Tavern waits for the Smith's turn to go idle (never interrupting it), carries the Smith's committed and uncommitted work home under a private ref, and carries that exact tree into the Warden's own separate machine.
   - A verify or reject verdict counts only while the Warden's checkout is clean on the submitted tree and the maker's submission, waypoint, and journal entries have not changed.
   - A placed Smith whose Warden rule gives it no separate machine blocks the hire and names the rule to add.
3. **Preservation before release:** Before releasing, wrapping, stopping, or archiving a placed member, Tavern saves its checkout state and declared file evidence home, then archives the thread so bb removes the machine.
   - A failed save keeps the thread and machine alive with a visible blocker and **Retry**.
   - Declared files outside the checkout and thread storage (or already deleted) are reported as not saved with the reason.
   - If a machine or thread vanished outside Tavern, release records that work was **not saved** rather than claiming preservation.

## Private snapshot refs and backups

Every verified home import is content-addressed by its immutable tree and transport provenance (`tavern-snapshot-owner/1`) and pinned in the home repository under:

```text
refs/tavern/snapshots/<64-char-owner-hash>
```

Inspect retained private refs at any time with:

```sh
git for-each-ref --format="%(refname) %(objectname)" refs/tavern/snapshots/
```

- **Not a backup:** Portable Tavern backups (`bb tavern backup save` and `bb tavern backup export`) deliberately exclude private placement tables (`tavern_placements`, `tavern_source_snapshots`, `tavern_placement_discoveries`, `tavern_snapshot_owners`) because they hold live allocation authority and host-local refs. Use preservation or ordinary Git/file backups for code bytes.
- **Inspecting placement state:** Check every class's matching rule and active slots with `tavern_status section=placement` or on the Keeper's Ledger.
