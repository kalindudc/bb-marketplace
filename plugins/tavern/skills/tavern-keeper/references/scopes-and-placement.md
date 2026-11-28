# Keeper reference: scopes and placement

Use this reference for scoped hire rules, detection-only exceptions, scope adjustments, and cross-repo machine placement.

## Pi preference and detection-only hires

- Scoped hires prefer Pi whenever Pi offers the configured model.
- If Pi does not offer that model, the hire is refused unless you repeat the exact hire with `requestDetectionOnly: true`, which opens a never-defaulting `scope` ask. After the user approves, repeat the hire with the approved `detectionOnlyAskId`.
- Always label non-Pi and remote members as detection-only: watchers stop a turn roughly one to two seconds after dispatch and cannot undo completed writes or sends.

## Scope rules and violations

- Act guard (`enforce`) holds recognized merges, publishes, deploys, sends, deletions, credential disclosures and cluster writes. Ordinary calls are recorded, not refused. Do not ask to widen a member's tool or path scope for ordinary work. Legacy presets are not widened at startup.
- Scoped Pi threads start with class tool lists and every discoverable skill's name and location. Rangers already have web search and fetch if installed. Use `tavern_hire`'s `loadout` to add exact installed names for other tools or full skill descriptions. Pi checks tool names against your session; check that the tools are also installed on the member's host. This is not a scope grant or an approval.
- Do not write home or project class or character overrides from a party member thread. Class loadouts and saved override files never authorize a held act.
- Use the existing typed decision for a held act. NEVER route around it with another interpreter or tool.
- Repair a bad maker binding instead of widening a checker's scope. Ask the user to restart a missing Pi guard only when prevention is needed.

## Cross-repo machine placement

- Call `tavern_placements` with `repo`, `classId`, and optional `boardQuestId` before hiring.
- Name the target bb project ID with `repo` (defaults to your own project, or the maker's project for a Warden) and pass a matching enabled rule ID with `placement: { ruleId }` (or `{ kind: "current" }` for your own repository only).
- Inspect active rules and remote slot usage via `tavern_status` with `section: "placement"`.
- NEVER invent target inputs: consent switches, environment inputs, per-class model overrides, and forge selection come strictly from the chosen rule.
- Cross-repo hires carry only the target repository's pushed default-branch tip, never local uncommitted files.
