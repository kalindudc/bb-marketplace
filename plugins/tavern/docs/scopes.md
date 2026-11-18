# Tavern scopes

Every class, including the Keeper, may write temporary records under `/tmp/**`, `/private/tmp/**`, the host TMPDIR and its own `BB_THREAD_STORAGE`, using native write/edit tools or inspected shell writers and redirection. These paths are already granted and need no scope ask. Protected paths and symlink escapes remain blocked. The Keeper defaults to open access and may work directly anywhere except protected files; it delegates by default. These scratch and storage permissions are base grants: an explicit write-path narrowing retains exactly its requested paths, including a temporary subtree, rather than adding back all temporary or storage roots.

Tavern agents run at bb permission mode `full`. Scopes add guardrails against mistakes and overreach, not against an agent deliberately defeating them. A scope grant never replaces the user's approvals for sends, merges, deploys or production writes.

## Containment by effect

Newly computed class scopes show every tool, including Tool Gateway discovery, backend enabling and disabling, and calls nested in codemode. Existing members retain their saved availability until their scopes are explicitly regenerated. Availability is not permission to write outside the workspace or to perform a consequential act. Explicit policy narrowings still apply, and Tavern authorizes its own tools independently. The reviewed tool act catalogue and grants are a later slice; unknown tool effects are not proven safe by their names.

On a local Pi session on macOS, Tavern wraps guarded bash calls in the operating system sandbox in enforce mode. Rangers write to their own thread storage and temp; Smiths also write to their bound worktree and its Git metadata. Wardens retain their existing maker-worktree check policy: tracked files and Git metadata are protected, verified ignored check outputs are allowed, and check calls have no network. Protected SSH, Claude, Pi extension and Tavern policy paths remain denied. Interpreters, pipelines, loops, heredocs and unparsable commands can run because the sandbox checks the actual writes. Resolved writes outside the workspace are still refused before execution. Unknown paths and uncertain locations meet the sandbox instead of being refused merely because Tavern cannot parse them.

The guard resolves trusted environment variables, earlier literal assignments, mktemp captures and finite loop values without changing the command. A failed sandbox write reports `Operation not permitted`; the Pi result includes one workspace hint, not a scope flag. A Ranger or Warden may fetch a repository outside its workspace when the entire call consists of inspected reads and `git fetch`. Only that call gains the repository Git metadata roots, never its worktree; adding a writer or an opaque program removes that allowance.

A local Smith with an unresolved worktree runs as a Ranger until it is bound. It can read and use its thread storage and temp, but it cannot push or write to the repository. The Keeper sees the missing binding as a scope problem. The original scope template remains available for binding later; a known root mismatch or invalid policy still fails closed.

The sandbox is the containment on macOS. Without it, including Linux, other providers and placed members, this slice keeps the conservative shell checks for unresolved writes, opaque programs and uncertain locations rather than loosening what those checks caught. Placed members remain detection-only under Tavern in every mode, exactly as their posture label says; the outer machine boundary is separate from Tavern. Every class trusts cortex reads and its add, update, edit and memory commands, and bb reads and the member’s thread coordination commands, with and without a sandbox. This trusts the agent programs, not their filesystem destinations. Removing records, configuring tools, approving Loom work and changing LAN or machine settings remain guarded. Linux and placed members retain their conservative checks for other programs. Resolved shell redirects still obey the workspace boundary.

The existing push, GitHub, package, cluster and deployment rules remain active. Shell HTTP writes and the existing consequential bb and cloud commands retain conservative act denials while the shared act catalogue is built. Tavern cannot see a merge or a send performed inside an interpreter or a browser-automation script. The sandbox confines file writes, not those network acts. This accepted gap already existed for Smiths; this slice does not claim to close it or change the posture labels. Watch runs no sandbox. On local macOS Pi calls it records consequential shell acts using the same act checks as enforce, but it no longer flags writes whose destination cannot be resolved, including interpreter writes. It does not stop those acts. The user-only control and member thread-creation boundaries below are refused even in Watch. No setting or default mode changes here.

Members can see `spawn` and `bb_workflow_run`, but cannot call them or run `bb thread spawn`. Keepers keep those capabilities. Members also cannot run `bb thread archive`; Keepers keep archival authority. A spawn refusal says: “Members don't start threads; ask your Keeper to hire.” This prevents a member from delegating its work to a new unscoped thread.

Tavern’s own user controls are refused in every scoped shell, Keepers included, in enforce and Watch. This includes answering asks, resuming work, releasing holds, applying settings, installing the guard and restoring a backup. User-only Tavern RPC methods have the same boundary. The deny set combines client-guarded RPC handlers with named user controls, even when their handlers lack a client check. Named controls include rule creation, confirmation and widening, quest stops, decision undos, route corrections, and the user-facing resume, journal-edit and voice-save RPCs; agents retain their own journal and rule-proposal tools. Matching uses individual command tokens, not fixed option positions, including the commands recovered from wrappers and static shell payloads. A quoted message such as `bb thread tell thr_x 'tavern ask'` is one message token and remains allowed. Changing shell environment variables or adding a policy grant does not lift it. The refusal says: “Tavern's controls are the user's; ask the user.” Read commands and agent-facing Tavern RPC methods remain governed by the usual scope.

Cortex’s agent-facing writes depend on its daemon connection when the database is outside the member’s workspace. Without that connection, a direct database write meets the sandbox. Tavern does not widen the workspace to the database directory or start the daemon; the phase-gate live check must verify that connection. The workspace hint is based on an `Operation not permitted` result from a sandbox-wrapped bash call, not an authenticated sandbox audit event. TCC, process permissions and other causes can produce the same text, so the hint is advice rather than proof of an outside-workspace write.

The public replay fixture contains 30 hand-written synthetic command shapes and no log-derived identifiers. A private full replay is opt-in: set `TAVERN_SCOPE_REPLAY` to a scrubbed fixture file when running `test/scope/effect-containment.test.ts`. The test is skipped when the variable is unset. The test harness permits reading only that specified path; the real log must never be used.

## Personal repositories: let Smith push to main

Put this user-controlled policy in `~/.agents/tavern/scopes.yml`:

```yaml
v: 1
rules:
  - remote: github.com/kalindudc/*
    classes:
      smith:
        defaults:
          allowRules: [git-push-main]
```

The exception applies to the actual destination of a push, not to any matching remote in the checkout. A personal fork does not authorize `git push upstream main` to a company repository. The guard resolves named remotes with `git remote get-url --push --all`; every destination must match. Direct-URL commands do not currently receive a verified remote-qualified grant; use a named remote instead. The earlier temporary command-line remote lookup was not reliable with the user's Git build. Explicit human approval without a remote qualifier remains a separate decision. The destination ref is checked independently. `HEAD` is resolved when earlier commands are inspected reads or the approved branch-preserving operations: Git add, commit, fetch, stash push and tag, or an independently verified own-draft PR edit. Commit-then-push is allowed; npm test followed by a push of `HEAD` still requires an explicit branch destination. A preceding checkout, switch or arbitrary program leaves it unresolved, and the push is blocked as an unclear target. Facts are keyed per command, so an earlier safe push cannot authorize a later push after switching branches.

SSH, HTTPS, scp-style, token-bearing URLs, default SSH ports and mixed-case hosts normalize to `github.com/owner/repo` without `.git`. Credentials are not retained in policy keys. Force/deletion/mirror pushes, implicit destinations, explicit tag refs, bare version-like tags, merges, cluster writes and deploys remain blocked. Other bare ref names remain a heuristic; prefer `refs/heads/topic` or an explicit branch refspec.

To let the Keeper choose the exception per hire instead of applying it automatically:

```yaml
v: 1
rules:
  - remote: github.com/kalindudc/*
    classes:
      smith:
        keeperMayAllow: [git-push-main]
```

The Keeper requests `{ "allowRules": ["git-push-main"] }`. The resulting grant retains the remote constraint. Without authorization, resolution returns `widenings: ["git-push-main"]`; it does not grant the request. The backend opens a consequential `scope` ask with no timed default and waits for the user's yes.

## Defaults and scope files

| Class | Preset | Guardrails in enforce mode |
| --- | --- | --- |
| Ranger | `readonly` | Every tool. Scratch/storage writes only. Local macOS Pi shell commands are contained by effect; without that sandbox, conservative shell checks remain. No pushes, GitHub writes or cluster writes. |
| Warden | `checker` | Readonly permissions plus approved check runners and verbatim done-when commands, only from the maker worktree. On macOS, check calls cannot use the network and may write only verified ignored outputs and scratch; tracked files and Git metadata remain protected. |
| Smith | `worktree` | Linked worktree, scratch and storage writes; explicit feature-branch pushes; draft PR creation and verified edits to the member’s own draft. Main/master, force/deletion pushes, merges, cluster writes and deploys require separate decisions. |
| Keeper | `open` | All tools visible, direct writes, network and shell allowed. Only protected files are guarded, as for a hired Wanderer. Settings guardrails and consequential-action approvals still apply. |
| User-started Wanderer, untyped thread | No scope file | The user’s own general agent; Tavern adds no guard. |
| Keeper-hired Wanderer | `open` | No sandbox. Only the scope directory, pi extension roots and their real targets, SSH files, the trusted ~/.agents/tavern/scopes.yml policy and the user’s Claude settings files are protected. Claude skills and other ordinary files remain editable. |

Shipped presets allow every tool and hide none. A project or class can still explicitly narrow access. Unknown tool effects are not proven safe by a name, and Tavern’s backend must still authorize its own tools.

Class frontmatter can select a preset and narrow it:

```yaml
scope:
  preset: readonly
  tools:
    deny: [web_*, mcp__tool_gateway__slack_*]
```

Class files cannot widen the shipped preset. In particular, a project `ranger.md` with `scope: open` is ignored and returned as a problem. A same-preset narrowing, a restrictive preset for an otherwise open class, and readonly in place of worktree are supported. Invalid or widening class changes do not erase existing denies.

Versioned JSON lives at `<plugin data directory>/scopes/<threadId>.json`. `src/scope/schema.ts` defines:

- Identity: `v: 1`, `threadId`, `role`, `preset`, `issuedAt`, `failClosed: true`.
- `mode: enforce | watch | off`, defaulting to `enforce` for older files.
- `writes: { mode, allow, deny }`. Modes are `none`, `worktree`, `paths`, `any`. `none` permits listed scratch/storage roots, except for Keeper. Denies win, with root boundaries and `*` globs.
- `tools: { allow, deny, hide }`. Denies win. Native write/edit name variants are supported.
- `shell: { deny, allow }`. Rules have `id`, `why`, and `argv` and/or `regex`; argv strings are globs and arrays are exact alternatives. `requires` demands particular tokens. An exception affects only the same rule ID. A remote-scoped exception additionally checks the actual push destination.
- `commandTools`, defaulting to `bash` and `Bash`. Other tools with string `command` or `cmd` inputs are denied in restrictive presets unless explicitly added by trusted scope construction. Only native bash receives Tavern's sandbox wrapper; do not add another runner without its own guarded backend.
- Optional `expectedWorktree`, set when the backend knows the provisioned root.
- Checker-only `checks: { worktree?: string, commands: string[] }`. The backend supplies the maker\'s linked Git toplevel and explicit done-when command strings. This field is not an agent-facing override or project-policy widening.
- File metadata `bindingTemplate` retains the exact effective scope before path binding, including approved grants and narrowings. It is saved atomically with the bound scope, not applied as a separate policy. Optional `bindingError` makes the guard fail closed after a provider-launch rebind failure; successful rebinding clears it.
- `network: any | none`, `github: none | read | draft-pr-only`, `env: { poisonGh, blockGitPush, variables }`, `sandbox`, and `onViolation: block`.

`${tmp}`, `${threadStorage}`, `${scopesDir}` and HOME paths are bound when writing the scope. Missing optional storage roots are omitted. The scope file also stores trusted `env.variables`: `HOME`, `TMPDIR`, `BB_THREAD_STORAGE` when available, and other explicitly supplied scope environment values. Env contributors deliver those bindings to the child. Both guard and watcher expand them from the file, never from their different process environments. `PWD` follows the proven shell cwd. Without effect containment, an analysis pass collects recognized mutations across the whole call before the enforcing pass expands any path. This includes later loop/function assignments, printf `-v`, static nameref targets, arithmetic assignments and unset operations. Non-literal or subscripted mutation targets, dynamic eval and valueless namerefs invalidate all trusted path bindings instead of guessing their destination. Literal read/mapfile/readarray targets invalidate the named binding. Reassigned, unset, loop-controlled or unknown variables remain unresolved and block restrictive writes. Reassigned TMPDIR also makes an implicit mktemp destination unknown. Assigning IFS makes unquoted variable expansion unknown, while quoted bindings remain usable; single-quoted variables are not expanded. Hired Wanderers allow unresolved ordinary targets but still check known protected prefixes and resolved roots. On macOS scratch is `/private/tmp` and the real current `$TMPDIR`, not the entire `/private/var/folders` tree. `${worktree}` can remain literal until provisioning. Parent traversal is rejected in narrowings, including `${tmp}/..`.

Native paths follow pi's Unicode-space, leading `@`, HOME and `file://` conventions before checking real paths. Existing symlinks and symlinked parents of new files are resolved. Protected roots are checked against both the supplied path and its real target. Deny bindings retain both spellings and resolve immediate symlinked entries, including pi extensions stored in the user’s shell repository. Restrictive presets protect the scope directory, `~/.pi/agent/extensions`, `~/.claude`, SSH material and Tavern policy files. Hired Wanderers protect only the roots in the table, not all of `~/.claude` or project settings files.

Shell checks inspect compounds, substitutions, shell heredocs and inline shell strings. Arithmetic normalization preserves source lengths, and nested heredocs use their own source offsets. They track `cd`, known pushd/popd stacks, `cd "$(git rev-parse --show-toplevel)"` with optional path suffixes, child-process cwd options and statically known new symlinks. Child cwd changes never change the parent shell’s cwd. Unknown directory-stack state and unresolved symlink destinations fail closed for writes. Preparation checks directory existence and gives those facts to the pure engine. A preceding command that may remove or replace directories invalidates the success guarantee; reads and simple safe creation commands preserve it. `cd X || exit` and `|| return` leave a definite success location for subsequent commands. For `cd X && ...`, an existing checked directory leaves a definite location; otherwise the engine retains both the success and failure locations and checks writes against each. Alternative `||` locations are also all checked, so neither `cd /etc || cd <worktree>` nor adding a final `|| exit` authorizes an `/etc` write. Each directory fallback is resolved from the cwd before the failed cd, not from its successful location. A final exit/return removes only the all-failed path; it does not erase earlier successful locations. More than 32 alternate locations fails closed. Plain read alternatives do not invalidate the cwd. Simple arithmetic `for` headers are normalized without changing offsets; their bodies are still checked. Redirections use the shell's cwd, not a later `git -C` directory. Redirecting to scratch never authorizes the program itself. `/dev/null`, `/dev/stdout`, `/dev/stderr`, `/dev/fd/*` and terminal output are usable sinks.

Without the local macOS Pi sandbox, readonly and the explicitly selected legacy keeper preset reject shell script files, heredoc-fed shells, pipe-fed shells and uninspectable inline shell input. Smith heredoc and here-string bodies, including a direct `cat <<EOF | bash`, are inspected. Other opaque pipe/redirect input to a shell, including process substitution that produces unproven script text, is blocked. Read programs include jq, checked sed ranges and substitutions to stdout, awk comparisons and quoted strings, diff, grep/rg, test/`[[`/simple arithmetic, head/tail/wc/sort/uniq/cut, env/printenv, whoami/id/ps, hostname inspection, tree, fd without executors, column, checksums, read loops, Git inspection (including tag/branch queries and remote show), node version, npm ls/view and read-only bb/Flare commands. A default `mktemp` or `mktemp -d` is a checked scratch writer, not an inspected read. Explicit templates and `-p`/`--tmpdir` destinations are write targets for Smith too; unclear template options fail closed. Bare assignments, set, local, declare and typeset count as reads, but their substitutions are separately inspected and their mutations still invalidate affected path bindings. Inspectable `bash -c` strings may appear in pipelines and use `-e`, `-u` and `-o pipefail`. `find -exec` is allowed only when its nested command passes the read-program checks. GraphQL queries may include variable fields; mutations, subscriptions, duplicate query fields and opaque query input are blocked. Explicit REST GET requests may use query fields; those fields do not authorize a POST. Write/execute variants such as `sed -i`, sed script files, awk `system()`/script files, `sort -o`, rg preprocessors and mutating bb commands are blocked. Curl write methods/data, package publication and GitHub API writes are not read-only. Git reflog inspection, ls-remote, show-ref, check-ignore, worktree list and version checks are reads; reflog expiry/deletion remains a write. Smith may apply/am patches, update submodules/LFS, format patches and bisect within its worktree. Unknown Git aliases, git-spice publication long/short forms (`gs ss`, `gs bs`, `gs dss`, related submit/sync commands and the `git-spice` binary), npm/yarn/pnpm/bun/cargo publication, gem push and twine upload are blocked rather than guessed safe.

Without effect containment, temporary output inference is deliberately limited. `tmp=$(mktemp -d) && cp source "$tmp/"` and direct `echo x > "$(mktemp)"` may use a symbolic scratch destination only when the scope permits the entire bound TMPDIR without conflicting child denies. The parser must identify a real command substitution, not quoted literal text. Captured names must have no other mutations and remain within one ordinary, non-negated `&&` chain. A following statement, `||`, pipeline, indirect target, custom template or `mktemp -u` is not inferred. This analysis never changes the command that executes or grants write permission.

## Policies and overrides

An override adds/removes specific rules, not an entire replacement scope:

```json
{
  "allowRules": ["git-push-main"],
  "denyRules": [{ "id": "no-webhook", "argv": ["curl"], "why": "Use the supplied evidence" }],
  "tools": { "deny": ["web_*"], "removeAllow": ["web_search"] },
  "writes": { "deny": ["${worktree}/vendor"] }
}
```

Adding denies or removing allows is narrowing. Named exceptions, added tool/path allows and removed tool denies are widening. IDs are a shell rule ID, `tool:<pattern>`, `tool-deny:<pattern>`, or `write:<path>`. Unknown shell IDs fail visibly. If any requested widening lacks approval, it is withheld; safe narrowing still applies. Independent restrictions and env speed bumps remain in place.

Precedence is deterministic:

1. The shipped class preset and validated class narrowing.
2. Shipped defaults, then the user's global `~/.agents/tavern/scopes.yml` in file order.
3. Project `<project>/.agents/tavern/scopes.yml` narrowing only. `allowRules`, added allows, removed denies and `keeperMayAllow` there are ignored with recorded problems. Empty defaults never erase global restrictions.
4. The per-hire/live override, gated by global policy or exact human approvals.

Only user-global policy may authorize discretionary widening. Denies compose instead of replacing whole class fields. A project can add a deny with a grant's ID to remove that automatic exception. `keeperMayAllow` never comes from project files. Global remote-scoped grants support Git push rules only; tool/path and non-push grants with remote qualifiers are ignored with a problem, rather than pretending their destination was verified. Other user-authorized capabilities need an explicit unqualified global policy or a per-request human approval.

`policy(context)` returns sources, ordered effective entries and problems for display. `resolve` also returns problems from class validation. Malformed policy fails visibly. Policy edits affect future resolutions; existing members change through the live API.

`rememberWidening(context, classId, ruleIds)` writes only `~/.agents/tavern/scopes.yml`, keyed to an unambiguous trusted push URL, never into the checkout. It preserves YAML comments, appends only the approved Git push grants, takes an exclusive writer lock and atomically renames the new document. A busy lock fails visibly without overwriting another writer. With multiple remotes the backend must supply `pushRemote` as one of the trusted URL values; otherwise remembering is rejected. The legacy fourth `project`/`global` argument is accepted but never changes the global destination. Remembering other capabilities requires a deliberate global policy edit. Persistence always needs the user's consent.

## Wiring for Ted

Register once after opening the plugin database:

```ts
const scopes = registerScopes(bb, {
  dataDir: pluginDataDirectory, // optional; defaults to the database's directory
  mode: settings.scopes ?? "enforce",
  pathsForThread: async (threadId) => {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) return {};
    return {
      worktree: await boundWorktreeRoot(threadId),
      threadStorage: await threadStorageRoot(threadId),
    };
  },
  cwdForThread: cachedWorkingDirectory,
  projectForThread: trustedProjectContext,
  classScope: (classId) => registryClass(classId)?.scope,
  onViolation: recordScopeBlocker,
});
```

The returned API is:

```ts
{
  shouldScope(classId, "direct" | "hire"),
  scopeForHire(classId, narrowing?),
  resolve(classId, context, override?),            // { scope, widenings, problems }
  writeScope(threadId, scope, options?),          // Promise<Scope>; options.binding is trusted host identity
  hostTemplate(threadId),                        // { template, templateDigest }; host-bound records only
  rebindScope(threadId),                          // Promise<Scope>; uses the persisted effective template
  applyOverride(threadId, override, approval?),    // Promise<{ scope, widenings, problems }>
  clearScope(threadId),
  policy(context),
  rememberWidening(context, classId, ruleIds, target?),
  setMode("enforce" | "watch" | "off"),
  mode(), status(), violations(threadId?), observationHolds(threadId?)
}
```

`context` is `{ projectRoot?, remotes?: string[], pushRemote?: string }`, from trusted backend facts. New hiring should use `resolve` with project context; the legacy `scopeForHire` is narrowing-only and also validates class-file trust. Surface `problems` in the member/policy UI instead of silently ignoring them.

Before direct startup/dispatch or hiring, call `scopes.shouldScope(classId, origin)`. Direct `wanderer` and untyped/null classes return false: do not write a scope file. A Keeper-hired Wanderer returns true: resolve and write its `open` scope before the first brief. Stop and release any old direct-Wanderer scope before restarting it unscoped. Ted owns this caller wiring; the helper does not itself know how the thread was started.

Keeper’s `tavern_note` and `tavern_gate` tools are covered by the existing `tavern_*` scope allow rule. The backend must still enforce Keeper ownership and validate their inputs.

Smith edits to a draft PR require fresh read-only GitHub facts: the authenticated user must be its author, it must still be a draft, and the head branch and repository must match the current checkout and its origin push URL. Repository flags and the PR selector are preserved wherever they occur in the command, skipping flag values rather than guessing that the fourth token is a number. Ambiguous or unsupported edit flags fail closed. A call that sets or exports `GH_REPO` or `GH_HOST` cannot receive a draft-edit grant. The branch lookup uses the same branch-preserving operation list as push `HEAD`; an explicit PR number does not excuse stale branch ownership facts. Missing facts, ready PRs, other authors, other branches or another head repository fail closed. `gh run watch` is a read. Two verified draft edits in the same call are supported. These checks can make read-only GitHub requests with a three-second timeout; they never perform the edit themselves.

### Warden check execution

Warden uses `checker`, not `readonly`. It keeps readonly tool permissions, push speed bumps and all existing consequential-action blocks. It does not gain native write/edit access to the maker worktree.

At hire, trusted backend code sets the effective scope before `writeScope`:

```ts
scope.checks = {
  worktree: trustedMakerEnvironment.path,
  commands: ["node --test test/unit.test.js"],
};
```

The root must be an absolute linked Git toplevel from the maker\'s server-host environment, not an agent-provided path or the Warden\'s own cwd. Binding canonicalizes and validates it. It need not match the Warden environment; the Warden can use `cd <maker-root> && <check>`. Missing maker bindings retain normal readonly access but block check execution with a binding explanation. `writeScope`, overrides and automatic rebinding preserve this field and the effective template.

Default check forms are package-manager `test` and `run test|check|lint|typecheck` for npm, pnpm, yarn and bun; `npx vitest run`; `npx tsc --noEmit`; `pytest`; `go test`; and `cargo test`. Ordinary runner arguments are supported. Package-manager directory/global/workspace redirection is not a default grant, and an overridden `--noEmit=false` does not qualify. Other commands require an exact entry in `checks.commands`; raw command spelling, arguments and quotes are retained for matching. A recorded simple command also works after an inspected `cd` prefix. A recorded compound command must match the whole source. Do not infer permissions from prose. Git writes, GitHub writes, package publication, explicit network writes and deployments remain denied even when named in done-when.

Ordinary byte inspection with `od`, `hexdump`, `xxd`, `file` and `stat` remains readonly and does not need checker cwd proof. Shell redirections are still checked. `xxd` may read stdin or one input file and write stdout or a device sink, but a regular output filename is not readonly; options after its first input filename count as output operands. `file -C` and abbreviated `--compile` forms are not readonly. Unknown cwd still blocks check runners and unproven writes.

Allowed check calls return `{ allow: true, check: true }` from the engine; ordinary allowed calls retain `{ allow: true }`. The pi guard uses the marker to deny network for the entire bash call containing a check. Ordinary readonly network inspection remains available. The watcher recognizes routine check execution as allowed rather than creating a scope violation or user blocker ask.

The macOS checker sandbox recomputes tracked paths and ignored outputs for each bash call. It permits Git-confirmed common output roots, literal ignore-file roots and existing ignored paths. Directory-only ignore rules allow creating a directory, not an unignored regular file of the same name. Tracked paths remain denied even inside ignored directories, and their ancestors cannot be renamed or removed. The maker\'s `.git` file, worktree Git directory and shared Git directory are denied. Existing hardlinked tracked files fail closed because path rules cannot safely isolate their aliases. Symlink escapes are not granted. Scratch allowances that overlap the maker worktree are omitted rather than exposing unignored or tracked paths. A new custom wildcard output that cannot be established conservatively may remain blocked.

Checks run offline. Dependencies must already be available; the sandbox does not install them. A runner that writes to a home-directory cache must be directed to permitted scratch or an ignored project output, for example `GOCACHE="$TMPDIR/go-cache" go test ./...`. No cache failure widens filesystem permissions. The tracked/ignored view is a command-start snapshot, so do not run the maker concurrently while verification is in progress.

Linux retains existing target checks but has no macOS filesystem or network sandbox: opaque test scripts are not contained there. Non-pi providers also do not receive this pi bash sandbox and retain their explicit detection-only admission requirement. Do not describe either case as equivalent containment.

### Settings modes

Expose a Tavern setting `scopes: enforce | watch | off`. Persist it in the backend settings store, pass it at registration, and call `setMode` when it changes. Do not expose the setter to agents.

- `enforce` is the default. Pi blocks and sandboxes; the watcher stops, records and calls `onViolation` for unprevented calls.
- `watch` does not hide tools, block calls, wrap bash or add env speed bumps. The watcher only records observations with `mode: watch`; it never stops or calls the blocker callback. Read `violations()` to display them.
- `off` disables guard action and watcher processing, while retaining scopes for later re-enablement.

The setter atomically rewrites mode in each scope file; pi re-reads it on every call and restores hidden tools before the next turn. Valid guards arm in every mode so an off-to-enforce switch does not look like a missing guard. Enforcement begins with the next tool call; its result includes an enforcement-enabled note. The watcher records the enablement boundary and does not retroactively stop calls that began while off. Corrupt scope records retain their error and original invalid content when mode is changed. In enforce mode they still fail closed. Env contributors expose `TAVERN_SCOPE_MODE` as well as `TAVERN_SCOPE_FILE`. Existing shell env speed bumps cannot be removed from an already-running process; restart the provider session to fully remove or add those. Restarting the plugin alone is not a substitute for persisting the setting.

### Hire, late binding and archive

1. Add optional `scope: ScopeOverride` to `tavern_hire`. Resolve policy before hiring; open a consequential, non-timed `scope` ask for returned widenings.
2. Spawn with `permissionMode: full` and no initial input. Bind membership and await `writeScope` before sending the first brief. Use the same ordering for typed dispatch threads.
3. A fresh pending child may have no `environmentId`. Return `{}` from `pathsForThread` before any environment/storage lookup; `storageLocation` returns 409 until provisioning, and waiting for it in dispatch deadlocks provisioning. Await `writeScope` with the valid effective preset before releasing dispatch: local protection roots are bound, `${worktree}` remains literal and unavailable storage allowances are omitted. Do not remove the worktree placeholder, write an empty object or call `restoreEnvironment` to warm the child. Without `TAVERN_SCOPE_FILE`, the pi guard is a no-op, not fail-closed.
   After provisioning, the provider env contributor awaits `rebindScope` before returning env entries. That restores storage paths and trusted variables from the exact persisted template, without reapplying policy or losing per-hire restrictions or approvals. Backend pinning must also use `rebindScope`, not `writeScope` with the already-bound scope. Core awaits contributors before building the provider start command, so successful binding precedes session startup.
   Scope writes, overrides and rebinding share a serialized per-thread queue with a two-second deadline including queue wait. Timeout releases its queue slot, and expired or released operations cannot commit late lookup results. A failed env rebind is logged and stored as `bindingError`; the contributor still returns `TAVERN_SCOPE_FILE` and the existing env entries rather than throwing, because core drops contributors that throw or exceed its five-second timeout. Pi blocks domain tools in enforce mode until a successful retry clears the error; reporting/journal remain available. Watch/off retain their non-blocking behavior. Rebinding errors appear in `status()`.
4. Pi resolves from `git -C process.cwd() rev-parse --show-toplevel`, not an agent path or event context. It requires a linked worktree (`.git` file), refuses `/`, HOME, missing roots and escaping allowances, and compares any expected root. Shared ordinary checkouts are rejected. The root is cached per session; policy is re-read on every call.
5. The watcher gets the environment via `threads.get` then `environments.get` on its first evaluated tool item. It requires `isWorktree` and a real linked Git root, caches it per scope record, and checks relative paths there. Lookup/binding failures stop and report in enforce mode. Known roots are written as `expectedWorktree` during binding. Once provisioning is observable, `rebindScope` pins that backend fact and retains it for subsequent rebinds; a deferred template has no exact expected-root attestation before that point. The watcher independently verifies the SDK environment.
6. Archive retains the scope and cursor, so unarchive remains scoped. Only delete or explicit `clearScope` releases it. Stop a running member before deliberate release. Changing environments requires reissuing the scope and restarting pi to discard its cached root.

### Live changes, asks, UI and CLI

Add `tavern_scope { memberThreadId, override, reason }`; check Keeper membership and ownership in the backend. Apply safe narrowing immediately. Keep any requested widening alongside the non-timed ask. Only the trusted human-answer handler may call `applyOverride(threadId, originalOverride, { approvedRuleIds: exactIds })`. Never put that argument in the agent-facing schema or trust a prompt's claim of approval. On a yes with “remember”, call the global persistence method with the chosen trusted push remote.

A trusted local backend may supply `ScopesDeps.narrowBoundScope?(scope: Scope): Scope` for a temporary away window. It receives a defensive copy after local path/check binding, immediately before the final write/no-op comparison. It may only append `tools.deny` and `shell.deny` entries; removing original denies or changing grants, identity, mode, roots or other fields rejects the update. The persisted original template is unchanged. A no-window identity function is inert; await `rebindScope` on close and return to add or remove the temporary overlay while retaining approved grants. A failed contributor-side overlay keeps the local restrictive pointer and records a binding error rather than pretending it applied. The hook is NEVER called for host-bound templates. It supplies no native intent revision, applied-state receipt or prevention proof; native away restrictions need their own desired revision, delivery acknowledgment and session posture, with unacknowledged policy remaining watched/pending.

Show the resolved preset, grants, pending asks, policy problems, mode and guard status in the UI. Wire the existing `bb tavern scope <thread>`, `violations [thread]` and `guard status|install|uninstall` commands to these APIs. `status()` includes the configured mode, arming and whether macOS sandbox-exec is available. Install helpers in `src/scope/install.ts` refuse unmarked files and remove only their own marked loader and an empty loader directory. Do not clear scopes on archive in backend lifecycle code.

Registration installs/re-points a small marked loader only if the pi agent directory exists. Without `TAVERN_SCOPE_FILE` it imports no scope implementation and registers no hooks. Missing targets or failed imports in a scoped enforce session install an emergency fail-closed guard, keeping only report, journal, the deprecated quest alias and authenticated `tavern_ready`. The loader reads live mode even on that failure path. Tests use temporary agent directories or `installGuard: false`; this builder does not install or reload the live plugin. Supply `guard.entryPath` for unusual bundle layouts.

### Upgrading existing live members

On plugin load, live Keepers without presetProvenance, saved with the legacy keeper preset or a known Keeper allowlist, are re-derived as open once, retaining their tool, path and shell grants. An atomic write records the scope, and a scope event says "Keeper scope widened to open by Tavern 0.1.2". Any open scope missing the trusted ~/.agents/tavern/scopes.yml deny gains only that protection in a queued write, including scopes with provenance. This narrowing records a scope event and a log line. Member scopes gain only check_ui and ui_examples when their allowlist exactly matches one of the two known previous preset lists; wildcard allowlists are already current, and other allowlists stay untouched and are logged as skipped. Member grants, denies and narrowings are unchanged. The legacy keeper preset remains selectable by custom class files and readable for migration. Newly resolved or changed policies record presetProvenance with the preset id and a SHA-256 hash of its contents, excluding class identity and timestamps. Binding-only and mode-only writes preserve the existing provenance, including its absence for legacy policies. A deliberate new keeper-preset policy is not migrated. There is no generic refresh from that fingerprint yet.

Apart from these migrations, a reload updates the installer, watcher and future scope resolutions; it does not reconstruct every previously resolved JSON policy or replace extension code already loaded in a pi process. Before resuming members created under the earlier trust model, reissue each scope with `resolve` and `writeScope` from its trusted class/project context, retaining extra grants only when the backend has a real human-approval record. Do not copy old project-origin allow entries into the new scope. Preserve intentional narrowings and ask again where their provenance cannot be reconstructed. Reissue scope files to populate the new `env.variables` bindings; older files parse with an empty map and restrictive variable writes fail closed until rebound. Restart the provider sessions to load the new guard and env contributions. The coordinator owns that live migration; these checks do not reload or rewrite the user’s live scopes.

Files predating `bindingTemplate` remain readable, and automatic `rebindScope` leaves their effective scope unchanged. It cannot infer an omitted storage allowance or its original narrowing; `status().threads[].hasTemplate` identifies these records. Reissue them only from the trusted effective template and approval provenance, not bare class defaults. Already-loaded older guards reject the new file metadata fail-closed; restart those provider sessions when rolling out this format.

## Machine workspace bindings

A trusted controller can set `workspaceKind: dedicated-machine` and pin `expectedWorktree` to a registered member checkout's canonical root. This allows its primary Git directory as well as a linked worktree. The kind is binding metadata, not an agent-facing scope override or proof that an arbitrary checkout belongs to Tavern. Without it, the guard retains its linked-worktree-only behavior. Removing or changing the kind invalidates the cached root check.

Dedicated checkers must bind `checks.worktree` to that same trusted root: their own carried checkout, not a path on the maker's host. Existing local, unruled checkers keep their current maker-worktree behavior.

`tavern_ready` stays available while worktree binding is pending or the scope/guard artifact fails closed. Other tools remain restricted. The backend must authenticate the caller and validate the current placement, generation and assignment before carrying or publishing readiness. Tool availability is neither content readiness nor an armed-session receipt.

Native `inspect.sourceBase` optionally reports `{ outcome: "ok", via, base, remoteName, remoteUrl, trackingRef, fetchRef }` or an explicit `{ outcome: "unavailable", code, message, retryable }`. The host chooses the merge base of the pinned inspected HEAD and the configured branch upstream. Only when no upstream is configured may it use the sole remote's existing symbolic remote HEAD. Missing refs, several/no remotes, unrelated history, ambiguous merge bases or an unprovable fetch ref block instead of guessing. Stale local tracking refs remain usable facts; inspection never fetches, updates refs, commits or changes the source index/worktree. Existing Git wrappers disable lazy object fetches. Old workers omitting the field mean unavailable, not an invented base.

Fetch provenance comes from that remote's actual fetch URL after Git rewrites, not a push URL or matching identity. HTTP(S) URLs lose all userinfo, query and fragment. SSH keeps its required transport username but loses password, query and fragment; there is no guessed username or protocol conversion. File remotes retain their transport spelling and are not resolved on the controller. Pass the safe URL and full `fetchRef` verbatim in the legacy-named host input `baseBranch`; do not strip `refs/heads/`. Import and full-ref carry may retrieve that advertised ref, then try the pinned SHA if needed, but materialization always uses the registered exact base, never the fetched branch tip. Full-ref fetches write neither FETCH_HEAD nor tracking refs. Full-ref carry retains the preservation fence: HEAD must already be the pinned base or its tree must equal a trusted previously-known `replaces` tree; otherwise it holds without guessing a tracking namespace from the URL. Never pass an unknown current/agent-provided tree merely to bypass that hold. The destination must have the exact pinned base SHA with the same Git object format; unavailable/access-denied fetches block, never substitute a different commit. No-remote object bundles remain follow-up work. Exact-root export restrictions still apply independently of these read-only facts.

## Host-bound templates and provider env

The controller can persist a host-bound scope without interpreting any guest path on the server:

```ts
await scopes.writeScope(threadId, effectiveScope, {
  binding: { kind: "host", placementId, generation },
});
const { template, templateDigest } = scopes.hostTemplate(threadId);
```

This option is private controller metadata, not an agent-facing widening or ownership proof. It is sticky across overrides, mode changes, rebinding and reload. A lower generation or a different placement is rejected; release the original scope before assigning another placement. Known host lookups and lookup failures also bypass local binding. An unavailable lookup without a trusted owner produces an unresolved host classification; repair it with the explicit trusted option before accepting an acknowledgment.

Host-bound writes retain the original effective template, including approved grants, narrowings, literal guest paths and checker roots. They never invoke controller `pathsForThread`, `bindPaths`, `bindChecks` or Git worktree preparation. Local two-argument writes retain their existing behavior and two-second queue deadline. A host-bound mark fences an already-awaited local update before it can overwrite the host template.

`hostTemplate` returns a defensive copy. `templateDigest` is SHA-256 of the UTF-8 bytes of `JSON.stringify(template)`, using the validated template returned by that accessor. It is a policy-provenance fingerprint, NOT `scopeDigest`. The latter remains SHA-256 of the exact outgoing `scopeFileJson` delivery bytes, including their whitespace. The controller owns outgoing serialization, desired revisions and exact delivery-byte persistence. It must pin the template fingerprint used for that delivery alongside the native acknowledgment. A new override or mode change makes an older template acknowledgment unusable immediately.

The canonical incoming parser is `scopeDeliveryFileSchema` (`ScopeDeliveryFile`), exported directly from `src/scope/schema.ts` and the scope index. Its strict shape is `{ ...template, bindingTemplate: template, workspaceBinding, bindingEndpoints? }`; all outer core fields must equal the validated original unbound template. `workspaceBinding` has `{ kind, hostId, environmentId, root, placementId, generation, snapshotId, expectedTree }`. Member environment IDs are required and nonnull. Snapshot/tree must be pinned together; makers may initially use null, while checkers require a real pair. Optional `bindingEndpoints.threadStorage` is an endpoint ID, never a path. Incoming bytes forbid `controllerBinding`, `bindingError`, `hostBinding` and embedded digests. This validates a DTO, not ownership: the native binder compares the trusted binding against the current registered endpoint and actual native filesystem/Git facts. Delivery digest stays in the RPC/ACK; only a rendered native file and its separate marker receive the authoritative host-binding tuple. Validation must not replace the exact persisted delivery bytes with a parse/reserialize cycle.

`ScopesDeps.hostScopeForThread` is an independent synchronous private lookup. It does not activate the remote watcher callback:

```ts
type HostScopeState =
  | { kind: "unavailable"; reason: string }
  | {
      kind: "ready";
      templateDigest: string;
      expected: ScopeObservationBinding;
      acknowledged: {
        binding: ScopeObservationBinding;
        scopeFile: string;
        variables: Record<string, string>;
      };
    };
```

`ScopeObservationBinding` contains `placementId`, `generation`, `endpointId`, `revision`, delivery `scopeDigest`, actual `hostId` and canonical endpoint `cwd`. Derive these from current private records and native results, never agent arguments. Return `undefined` only for definitely legacy/local threads. A persisted host-bound record stays host-bound even if its lookup is missing after restart. Throwing, asynchronous, invalid, pending or stale lookups do not trigger local probing or a server-path fallback.

For a host-bound provider start, the contributor checks the persisted owner, current template fingerprint, all expected/acknowledged binding fields and the SDK provider context's actual host. Only then does it emit the acknowledged absolute host `scopeFile`. Variables come exclusively from the bounded native-rendered map, not the server template's HOME, TMPDIR or core storage bindings. The host map allows at most 30 uppercase env names and 64 KiB encoded JSON; names cannot replace scope routing, thread identity or PWD. The complete contribution, including mode and enabled Git/GitHub speed bumps, must fit the SDK's 32-entry limit without duplicate names. Invalid or oversized contributions return no scope env; they are never truncated. SDK env values appear in diagnostics, so this map is not a secret transport.

Before an acknowledgment, the accepted detection-only bootstrap deliberately receives no scope env. This is not a startup veto or pre-execution protection. Guard preparation or `tavern_ready` cannot retroactively arm a process that started without the scope env; a subsequent real session needs its own current observed marker. No host RPC, installation or carry runs inside the contributor. Existing local rejection/hang handling still retains its restrictive file pointer rather than dropping the contribution.

The controller template file carries `controllerBinding` and is NOT a native scope. Pi rejects it before any path/Git probing or arming, leaving emergency tools available in enforce mode. A private `.json.host` marker is written before the template, so interrupted or corrupt template writes cannot silently restore local classification. Missing templates remain unresolved; `clearScope` removes both files. `status().threads[]` exposes `binding`, `hostScope: unresolved | acknowledged`, and `armed: false` for host-bound records. An acknowledged delivery is not a session-loaded receipt.

The remote watcher branches before local cwd, filesystem, PID, Git and checker preparation. It validates private binding state before and after awaiting the host-evaluated decision. Unavailable or stale inspection retains its event and records a separate durable observation hold, exposed by `observationHolds(threadId?)`; it does not fabricate a policy violation. The optional `onObservationHold` callback notifies only in enforce mode. Watch mode records without stopping or notifying; off is inert. Known denied host decisions retain detection-only stop/ledger behavior, with the checked binding passed as the second `onViolation` argument for controller-side fencing. A host-bound record with no remote watcher callback stays held, never locally evaluated.

Keep controller callbacks and provider routing unactivated until the complete fake-host chain passes. The native services below implement rendering, session receipts, portable guard preparation and the SDK host entry in source. Controller routing and live use remain unactivated until the complete fake-host chain and coordinator's build gate pass.

### Native scope service

`NativeScopes` is exported from `src/host/scopes.ts`. Construct it only on the native host with that host's `HostRegistry`; its optional `NativeScopeOptions.paths` is trusted host/test-fixture construction, never an RPC or agent input. Production defaults read native HOME, temporary roots and Pi's configured agent directory. Each method accepts an optional `AbortSignal`:

```ts
const native = new NativeScopes(registry);
await native.bindScope(input, signal);
await native.prepareCall(input, signal);
await native.sessionStatus(input, signal);
await native.releaseScope(authority, signal);
```

Inputs and outputs are the matching `HostInput<M>` and `HostOutput<M>` from `src/host-contract.ts`. `bindScope` returns required `{ revision, scopeDigest, scopeFile, variables }`; `variables` uses `nativeScopeVariablesSchema`. The service validates the complete environment budget including routing and speed bumps, not just the variable map. It derives HOME/TMPDIR locally, removes any controller storage value, and substitutes core storage only through a declared, currently registered artifact-read endpoint owned by the same member on the same host. A declared missing or foreign endpoint fails rather than disappearing.

The incoming effective template is retained unchanged. Native binding substitutes only trusted workspace, checker, home, temporary, core-storage and protected-root facts. Approved shell grants and tool restrictions remain intact; literal policy paths are not rewritten into guessed guest equivalents. The whole native Tavern data directory and actual Pi extension directory are protected. Both registered linked worktrees and dedicated machine checkouts are supported. The endpoint must have been inspected, use its registered private branch and remain the same canonical root/inode, Git metadata and object format. Binding a policy is not source snapshot verification: the controller must separately verify the carried HEAD/tree and current assignment before and after acknowledging content readiness.

The SDK host request context does not expose a native `hostId` property. `HostPort` instead checks that endpoint registration and delivery host metadata match its explicit authenticated target before dispatch, without rewriting delivery bytes or probing guest paths on the server. The native service then checks the binding against its private registered host/environment/owner/root/generation. These are authenticated routing and native filesystem checks, not hardware attestation.

Scope data lives under the native registry's private `scopes/<hashed-placement-generation-endpoint>/` directory. `binding.json` pins exact delivery bytes, their delivery digest, rendered bytes, a separate rendered digest and native variables. `scope.json` uses `scopeRenderedFileSchema` (`ScopeRenderedFile`): bound core fields, original `bindingTemplate` and authoritative `hostBinding`. The incoming schema forbids that host binding; the service creates it from the current authority and delivery pair. The ordinary controller `scopeFileSchema` intentionally still rejects rendered files.

Equal-revision retries require identical incoming bytes/digest and return the same native path/map across worker restart. An acknowledged retry checks the existing executable bytes rather than silently repairing tampering. Interrupted replacements replay the persisted rendering, not new host values. Lower revisions and equal-revision conflicts reject. An in-progress record is persisted before executable replacement, and authority/cancellation are checked immediately before atomic rename and after the final await before returning an ACK or decision. `releaseScope` writes a terminal tombstone and removes only owned scope/marker files. Its cleanup-only registry accessor also works after revocation or workspace loss, but cannot reach another endpoint or newer generation. Release, timeout or unknown revocation never proves remote writes stopped.

`prepareCall` ignores all caller-supplied resolved paths, push targets/heads, Git roots, directory facts and pull-request ownership. It recomputes them natively against the exact acknowledged rendered policy and returns the engine `Decision` with the acknowledged revision/delivery digest. Git/GitHub read queries are cancellable, with at most 32 queries, eight dependency passes, a ten-second aggregate abort budget and three-second per-read budget, plus the bounded child-process drain. Timeout, stale revision, release or changed rendered bytes is an explicit unavailable/stale error, not an allow or invented executed violation. Revalidate the controller's seven-field observation binding around the awaited reply as before.

The Pi guard explicitly parses a rendered native file, re-reads it on each call/refresh and records `hostBinding` plus the SHA-256 of the exact loaded rendered bytes in its marker, alongside thread identity, issue identity and native PID. `sessionStatus` checks the current private tuple, exact on-disk rendering and marker, then probes that PID on the native host only. A prepared file is `not-observed`; malformed, mismatched, dead or copied receipts are `stale`. Off/watch mode never reports an armed pre-exec gate. A new policy revision removes the old marker until a real loaded guard reads that revision. Local controller arming explicitly rejects native markers, even if path and PID strings coincide. Native tuple/digest identity avoids relying on controller-host wall-clock ordering; legacy local timestamp checks are unchanged.

### Native endpoint slots and snapshot-ref cleanup

The host contract adds three methods. They are also wired through the SDK host entry and typed `HostPort`; none is an agent-facing tool or an activation of controller routing.

```ts
registerEndpoints({ placementId, generation, operationId, endpoints });
// { outcome: "registered", generation, endpointIds }
// or { outcome: "waiting", generation, active, required, limit: 32 }
releaseSnapshotRef({ placementId, generation, endpointId, operationId, transferId });
// { released: true }
releaseEndpoint({ placementId, generation, endpointId, operationId });
// { released: true }
```

Each batch contains one to 32 distinct endpoint registrations for its exact placement and generation. The limit is 32 active endpoints per placement and generation, not per host. An immutable existing registration consumes no new slot. `active` counts that generation's nonreleased grants; `required` counts only the batch's new endpoint IDs. If they do not fit, the whole batch returns `waiting` without registering any endpoint or changing a prior grant. No eviction or machine fallback occurs. Render that as a visible hold, for example: “Waiting for transfer slots: this placement and generation has 31 endpoints in use and needs two more (limit 32).” Retry the same batch when owned grants become terminal. All roots and ownership claims are prepared before one atomic placement-record publication. A disk error can retain private ownership claims without publishing grants; reconcile by retrying the same authority and batch, never by allocating a replacement identity. The old single-endpoint method keeps its retryable `endpoint-limit` error.

`releaseEndpoint` requires known current-generation authority. It refuses an active carry, an undrained native operation on that endpoint, or pending snapshot-ref cleanup. Another endpoint's operation does not block it. A terminal tombstone survives worker restart and prevents ID reuse within that generation. Releasing it frees only its active slot: no worktree, scope file, upload, Git ref, ownership claim, machine or process is implicitly deleted. Cleanup can acknowledge a known revoked endpoint after root loss, but stale and unknown authority is an error, not a successful no-op. Histories retain up to 100,000 endpoint rows within the existing 64 MiB private-record bound; exhaustion is an explicit reconciliation error, never tombstone eviction. Advance a generation only after the controller has reconciled its preceding resources.

`releaseSnapshotRef` derives its only ref and expected old SHA from the registered single-ref `home-import` transfer and the native completed-import receipt. No caller ref, SHA or path is accepted. Imports now retain their exact written refs in that receipt. Missing, legacy-without-ref-proof, empty-ref, multi-ref, foreign or inconsistent proof blocks cleanup visibly. The controller decides when no live descriptor references remain and serializes that decision with its private import operation; the host does not infer controller reference counts.

Before any wait or Git call, cleanup persists an immutable intent and closes ordinary access to that home-import grant. Inspect, transfer registration and import cannot reopen it. A changed ref holds that intent for exact reconciliation; the endpoint cannot be released while it is pending. Git deletes only the private ref using its expected old SHA and `--no-deref`, never a symbolic target or another active home-import grant's alias. Native authority, root, repository format and ref ownership are checked around awaits and before mutation. Completion is durable before its own ref claims are removed. An interrupted or cancelled call retries the same intent; an already completed retry does not delete a later owner's ref and can finish claim cleanup after root loss. A generation change always refuses old authority, including a completed retry. Neither release is proof that a remote member process or its writes stopped.

### Portable native guard and host entry

`host.ts` default-exports `createTavernHostEntry({ artifactPath: fileURLToPath(import.meta.url) })` and separately exports the Pi adapter as `tavernGuard`. The manifest declares only the implemented `bb.host: "./host.ts"`. The SDK builder bundles that entry directly as a self-contained Node 22 ESM artifact, preserving its named exports. No server checkout path or second Pi package is copied to the native machine.

`NativeGuard` in `src/host/guard.ts` takes a native registry and trusted constructor options `{ artifactPath, agentDir? }`. `prepareGuard(input, signal?)` uses the existing authority, rule ID and private controller-approved `allowMarkedInstall` flag. That flag comes from the user's once-per-rule consent, not an agent argument or fresh hire prompt. No consent means no new installation or update; an already identical installation may be observed without writing it. The constructor's path overrides are fixture/native construction only and are not RPC fields.

Preparation accepts only a regular built `.js` or `.mjs` host artifact, hashes and copies its exact bytes to the native private `guard-artifacts/<sha256>.mjs`, and imports that copy to verify its named guard export. Source TypeScript is explicitly unavailable, never a pretend portable artifact. The Pi loader points only at that immutable native copy, verifies its checksum before importing `tavernGuard`, and preserves the existing emergency fail-closed loader and unscoped no-op. Old copies remain for already loaded sessions.

Only an absent or Tavern-marked shim can be installed or updated. Unmarked files, symlinked shim/installation directories and altered immutable copies are left alone with a visible result. Checks after module import, immediately before atomic replacement and after the final promise boundary prevent a newly introduced user shim from being overwritten or a stale preparation from being acknowledged. Files are private. `prepared` means artifact/loader preparation only: it creates no armed receipt, cannot load a running Pi session retroactively and never grants permission to an invalid scope. Filesystem/installation failures are warnings under approved detection-only consent; wrong member ownership, stale authority, revocation and cancellation still fail.

`createTavernHostEntry` is exported from `src/host/entry.ts`. Its optional `paths` construction override uses `NativeScopePaths`; production uses the actual native defaults. It lazily creates its registry/services only from `context.experimental_paths.dataDir` on the first valid handler invocation, and rejects a changed directory or worker lifecycle. Importing the artifact registers no source paths, guard, hooks, watchers, machines or background activity. Every declared contract method is wired; every async method receives request/worker/dispose cancellation. Official SDK server-client and host-entry harnesses test the actual native register/inspect/bind/prepare/session/release path, separately from the unfinished whole-controller readiness flow.

The process runner already terminates process groups to avoid orphaned Git descendants. Native operations now additionally own an asynchronous process scope: early failure or cancellation aborts sibling subprocesses and drains all of them before the operation leaves the registry. A one-second kill grace leaves room inside the SDK's five-second worker-disposal budget. `revokePlacement` closes authority and waits for registered operations to drain; entry disposal aborts and awaits all handlers. Those guarantees cover Tavern-owned host RPC subprocesses only, not an arbitrary member process or remote writes. No workspace deletion is implied. Tests use actual SIGTERM-ignoring fixture children and require them dead before replies. Entry fixtures additionally record every child separately and SIGKILL all surviving owned process groups in `afterEach`, including assertion-failure paths; PID command identity is checked before killing a possibly reused PID.

The production host bundle has not been built or installed by this builder. The coordinator must build it and smoke-test importing its copied artifact outside the source/package tree before claiming production portability or loading. Remote controller routing, ready activation and the remote watcher callback remain off.

`armed` is a point-in-time loaded-guard observation, not a startup barrier, sandbox guarantee or proof that execution has stopped. It NEVER gates approved remote detection-only content readiness and never changes the remote detection-only label. A bootstrap process that did not load the extension cannot be armed retroactively by writing policy or running `tavern_ready`. The guard preparation and SDK entry below have in-process checks. Complete controller transport/ready integration, the production artifact build and actual live loading remain separate checks; constructing this service activates none of them.

## Prevention, detection and limitations

| At `full`, in enforce mode | pi | Claude Code and Codex |
| --- | --- | --- |
| Native tools/paths and recognized shell rules | Prevented before execution | Detected after start only |
| Bash filesystem writes | macOS sandbox plus heuristics | Detected where event paths expose them |
| Env speed bumps | Applied at provider launch | Applied at provider launch |
| An unprevented violating call | Stop, record, notify | Stop, record, notify |

Claude Code hooks are phase 2; nothing is installed under `~/.claude`. The armed-marker handshake applies only to pi. Valid pi sessions arm at startup/turn refresh. Missing/dead/mismatched markers stop domain calls, but never emergency `tavern_report`, `journal`, its deprecated `quest` alias or authenticated `tavern_ready`.

Pi emits a started item before its preflight hook. Therefore the watcher evaluates armed pi calls at `item/completed`, skipping results with `[Tavern scope blocked]`, including native write/edit failures carried in `fileChange.error`. It also recognizes failed results beginning with bash-guard's `[CRITICAL] Command blocked automatically` or `[HIGH] Command blocked in non-interactive mode`, its exact `Blocked by user` result, and pi's default `Tool execution was blocked` result. Successful output, quoted log lines and ordinary command failures do not establish a preflight block. A recognized guard-blocked call is not an executed violation and does not stop the thread. Arbitrary custom guard reasons require an explicit marker or a provider-level blocked signal; the current pi item has no universal preflight-block flag. Other providers are evaluated at `item/started`. Split MCP `server`/`tool` names are rebuilt as `mcp__server__tool`, except native workspace tools.

The watcher reads only scoped threads, serializes each thread, persists its cursor before notification, and caps a notification at three pages of 100 rows. A later notification continues replay. Restart, resume and callback failure do not replay old violations. Stop failures persist a retry flag and are retried on the next event; callback failures are logged. The JSONL ledger survives scope release. Watch observations do not invoke a callback that could mark members blocked.

The fake-host tests exclude IPC and bb's up-to-one-second event coalescing. Expected live detection/stop latency remains roughly one to two seconds, not a measured guarantee. Armed pi completion checks also wait for the call to finish; the unarmed handshake is checked at start. No watcher can undo a completed push or send.

The macOS sandbox uses real paths, glob regexes, device sinks and corrected policy-file regexes. For Smith it also allows the linked Git directory and common Git directory, so index, objects, refs, logs, commit, branch and stash work. This intentionally grants shared Git metadata access, not the shared checkout's working files. Common `.git/config` and `.git/hooks` remain writable: `git config core.hooksPath`, Husky or hook installers can affect the user's main checkout and later commands outside this sandbox. This is not isolated or rolled back by Tavern. User hooks or Git instrumentation that write elsewhere may still fail; the user's worktrail/monobus spool warning is an example, even when the commit itself succeeds. The sandbox is only the bash child; it does not contain native tools, launchd/Apple Events, or an agent actively trying to bypass it. `network: none` constrains that child, not every plugin tool.

Branch-preserving Git operations are a deliberate heuristic: arbitrary Git hooks are not proven unable to switch branches. Without the local macOS Pi sandbox, readonly has no arbitrary-script exemption. Smith/open programs can still make indirect network calls; shell heuristics do not prove Python/API clients or every plugin safe. Linux has no sandbox-exec backstop. Git aliases are blocked but shell obfuscation is not a security boundary. Remote/Aquifer hosts need the scope and loader on that host. The source now declares a native SDK host entry and explicit consented guard preparation, but no controller routing or remote watcher callback is activated. The coordinator's production artifact build and reload remain required; source tests are not live-session proof. Env `GH_TOKEN` poisoning and Git `pushInsteadOf` are speed bumps, not authorization, and can be bypassed or replaced deliberately.

## Verification

From the plugin directory:

```sh
node node_modules/vitest/vitest.mjs run test/scope
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc -p . --noEmit
```

Regression tests cover the review probes: pi path forms/Unicode and symlinks; scratch redirection bypasses, scripts, network writes and realistic Ranger inspection; linked-worktree validation and expected-root mismatch; actual push URLs, URL rewrites, forks and HEAD; global-only trust and comment/lock-safe persistence; pi event ordering, cursor restart, throwing callbacks, stop retry, bounded replay, MCP names and archive/unarchive; live modes and corrupt scope records; protected globs, settings, policy files and devices; and loader failures and load cost.

Real sandbox-exec probes run only under `/private/tmp` and clean up. They verify allowed/denied writes, Claude/Tavern policy regexes, devices, linked-worktree commits, branches and stashes. `test/scope/transcripts.test.ts` replays Billy’s unchanged 88 Ranger, 79 Smith, 11 Keeper and 8 regression entries from the checked-in JSON fixture. It creates a linked worktree outside every scratch root. The own-draft PR case supplies explicit verified GitHub metadata; no transcript command contacts GitHub or executes a publication. Separate tests reject mismatched or missing ownership facts. The jiti probe uses pi's installed loader when available: the unscoped loader registers zero hooks, a missing target fails closed, and the real implementation imports for a scoped session. The observed standalone run measured 4.2–5.3 ms warm versus 1.1–1.6 ms for a trivial module, with a 100 ms median warm budget.

Not verified live here: env reaching newly launched provider sessions, the user's actual live loader after reload, real Claude/Codex event samples, live stop latency or remote-host delivery. The pi event-ordering regressions cover bb's translator sequence and the external bash-guard start/completion captured from Vex (`thr_t7zqtmwfgx`, events 47–48), with paths and IDs anonymized. Round-5 tests cover dynamic assignment targets, array writes, valueless namerefs, chained cd fallbacks, explicit mktemp targets and bounded scratch inference, including guard/watcher agreement and skipped/negated/quoted-literal negative cases. Round-4 tests cover assignment builtins, whole-call mutation collection, IFS quoting, mktemp destinations, defensive cd, checked directories and candidate write locations, commit-then-push and repeated draft edits. Round-3 tests also cover selectors after flags, redirected GitHub environment, stale per-command branch facts, variable expansion shared by guard/watcher despite different process environments, symlinked storage, branch-changing and/or lists, shell-fed inputs, read-program negative cases and Keeper’s memory tools. No live shim installation, plugin reload or repository commit is performed by these checks. Disposable Git commits occur only inside the sandbox probe fixtures.
