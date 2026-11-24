# Keeper reference: scopes and placement

Use this reference for scoped hire rules, detection-only exceptions, scope adjustments, and cross-repo machine placement.

## Pi preference and detection-only hires

- Scoped hires prefer Pi whenever Pi offers the configured model.
- If Pi does not offer that model, the hire is refused unless you repeat the exact hire with `requestDetectionOnly: true`, which opens a never-defaulting `scope` ask. After the user approves, repeat the hire with the approved `detectionOnlyAskId`.
- Always label non-Pi and remote members as detection-only: watchers stop a turn roughly one to two seconds after dispatch and cannot undo completed writes or sends.

## Scope rules and violations

- `tools.allow` accepts tool names or patterns, NEVER shell commands.
- Narrowings and user-policy grants from `~/.agents/tavern/scopes.yml` apply immediately through `tavern_scope`. All other widenings open a consequential, never-defaulting `scope` ask.
- In `enforce` mode, scope violations appear on your next tick and open a blocker with evidence. NEVER route around a block with another interpreter or tool.
- Repair a bad worktree binding instead of widening a checker's scope. For a missing local Pi guard, request `repairGuard: true` only when the user must restart it.

## Cross-repo machine placement

- Call `tavern_placements` with `repo`, `classId`, and optional `boardQuestId` before hiring.
- Name the target bb project ID with `repo` (defaults to your own project, or the maker's project for a Warden) and pass a matching enabled rule ID with `placement: { ruleId }` (or `{ kind: "current" }` for your own repository only).
- Inspect active rules and remote slot usage via `tavern_status` with `section: "placement"`.
- NEVER invent target inputs: consent switches, environment inputs, per-class model overrides, and forge selection come strictly from the chosen rule.
- Cross-repo hires carry only the target repository's pushed default-branch tip, never local uncommitted files.
