# Loom spec reference

A Loom spec is one TOML document. `loom_propose` parses it with a strict schema: an unknown key is an error, and every error names its TOML path and the fix. Tickets are numbered from 0 in the order of the `[[ticket]]` tables, so `ticket[2]` is the third one.

Workers, the plugin's checks, reviewers, merging, budgets and triage all use these settings.

## Tables and keys

### [project]

| Key | Type | Default | Rule |
|---|---|---|---|
| `slug` | string | required | `^[a-z][a-z0-9-]{1,39}$`; names the project and its sidebar section |
| `name` | string | required | 1 to 80 characters |
| `key` | string | required | `^[A-Z][A-Z0-9]{1,7}$`; the ticket key prefix (`CSV` gives `CSV-1`); unique across all projects, archived ones included |
| `goal` | string | required | 20 to 4000 characters |
| `non_goals` | string array | `[]` | at most 50, each up to 500 characters |
| `base` | string | `"main"` | the branch work starts from; a plain git name |
| `open_questions` | string array | `[]` | must be empty |

### [merge]

| Key | Type | Default | Rule |
|---|---|---|---|
| `strategy` | string | required | `"integration"` (approved work merges into one branch) or `"pr"` (one pull request per ticket) |
| `branch` | string | `loom/<slug>` | integration strategy only |
| `remote` | string | `"origin"` | a plain remote name |
| `draft` | boolean | `true` | whether pull requests open as drafts |

### [checks]

| Key | Type | Default | Rule |
|---|---|---|---|
| `commands` | string array | `[]` | at most 10; run on every submitted ticket |
| `after_merge` | string array | `[]` | at most 10; run on the merged integration branch, which they must leave as they found it (no new commit, no edited tracked file) or the merge is rolled back; not allowed with strategy `"pr"` |
| `timeout_minutes` | integer | `15` | 1 to 29 |

### [scope]

| Key | Type | Default | Rule |
|---|---|---|---|
| `protected` | string array | `[]` | globs no ticket may change; at most 100 |
| `enforce` | string | `"warn"` | `"warn"` or `"reject"`: what happens to files a submit changes outside its ticket's scope |

### [agents]

| Key | Type | Default | Rule |
|---|---|---|---|
| `max_workers` | integer | `2` | 1 to 8 |
| `max_reviewers` | integer | `2` | 1 to 8 |
| `ticket_timeout_minutes` | integer | `120` | 10 to 1440 |
| `triage` | boolean | `true` | |

`[agents.worker]` and `[agents.reviewer]` each take `provider`, `model` and `reasoning` (optional strings) and `permission_mode` (`"accept-edits"`, `"auto"` or `"full"`, default `"full"`). Some providers, such as pi, accept only `"full"`.

`provider` must be the id of a provider bb has, such as `claude-code`, `codex` or `pi`; a model or product name such as `claude` is not a provider id. Loom checks each provider against bb's list when the spec is proposed and refuses an unknown one with the ids bb has. When bb's list cannot be read, the spec is accepted unchecked.

### [review]

| Key | Type | Default | Rule |
|---|---|---|---|
| `approvals` | integer | `1` | 1 to 3 |
| `max_rounds` | integer | `3` | 1 to 10 |
| `rubric` | string array | `[]` | at most 20, each up to 500 characters |

### [budget]

| Key | Type | Default | Rule |
|---|---|---|---|
| `max_attempts` | integer | `3` | 1 to 10; failed worker attempts before a ticket blocks |
| `max_check_failures` | integer | `5` | 1 to 20; failed check runs on one ticket before it blocks |
| `max_tokens` | integer | none | positive; for the whole project |
| `deadline` | date | none | a real date such as `2026-12-31`, as a TOML date or a string |

### [[ticket]]

One to 200 entries.

| Key | Type | Default | Rule |
|---|---|---|---|
| `ref` | string | required | `^[a-z0-9][a-z0-9-]{0,39}$`; unique; other tickets name it in `depends_on` |
| `title` | string | required | 1 to 120 characters |
| `body` | string | required | 1 to 8000 characters; what a worker who has seen nothing else needs |
| `acceptance` | string array | required | 1 to 20 items; EARS form is recommended: "WHEN ... THE SYSTEM SHALL ..." |
| `verify` | string array | `[]` | at most 10 commands |
| `scope` | string array | required | 1 to 50 globs |
| `depends_on` | string array | `[]` | at most 20 refs |
| `priority` | integer | `2` | 0 (highest) to 3 |

Commands are up to 2000 characters each, globs up to 200, acceptance items up to 1000.

## Example: a two-ticket project

```toml
[project]
slug = "csv-export"
name = "CSV export"
key = "CSV"
goal = "Let admins export the orders table as a CSV file from the orders page, with the same columns as the screen."
non_goals = ["Scheduled exports", "Other file formats"]
base = "main"

[merge]
strategy = "integration"

[checks]
commands = ["npm test", "npm run typecheck"]
timeout_minutes = 15

[scope]
protected = ["package-lock.json", ".github/**"]

[agents]
max_workers = 2

[agents.worker]
provider = "claude-code"
model = "sonnet"

[agents.reviewer]
provider = "codex"
model = "gpt"

[review]
approvals = 1
max_rounds = 3
rubric = ["Every acceptance criterion has a test", "No change outside the ticket's scope"]

[[ticket]]
ref = "row-mapper"
title = "Map an order to a CSV row"
body = "Add src/export/rows.ts with orderToRow(order), which returns the visible columns in screen order. Read src/orders/columns.ts for the column list. Do not touch the orders page."
acceptance = [
  "WHEN an order is mapped THE SYSTEM SHALL return one value per visible column, in screen order",
  "WHEN a value contains a comma or a quote THE SYSTEM SHALL quote and escape it",
]
verify = ["npx vitest run test/export/rows.test.ts"]
scope = ["src/export/rows.ts", "test/export/rows.test.ts"]
priority = 1

[[ticket]]
ref = "export-endpoint"
title = "Serve the export"
body = "Add GET /orders/export, which streams the CSV using orderToRow from src/export/rows.ts, and an Export button on the orders page."
acceptance = [
  "WHEN an admin opens /orders/export THE SYSTEM SHALL stream a CSV with a header row and one row per order",
  "WHEN there are no orders THE SYSTEM SHALL return only the header row",
]
scope = ["src/export/**", "src/orders/page.tsx"]
depends_on = ["row-mapper"]
```

## Errors

A spec with any error is refused and nothing is saved. Errors are numbered, at most 20 shown.

- TOML that does not parse: one error with the line and column.
- A key the schema does not know, a missing required key, or a value outside its range.
- `depends_on` names a ref that is not a ticket.
- A dependency cycle; the error shows one cycle path.
- Two tickets with the same `ref`.
- `project.open_questions` is not empty.
- The text `[NEEDS CLARIFICATION` appears anywhere in the TOML, even in a comment or a string.
- A ticket scope glob equals, or sits under, a protected glob (the text before the first `*` is compared).
- A ticket has no `verify` command and `checks.commands` is empty.
- `checks.after_merge` is set with strategy `"pr"`.

Refusals tied to existing projects come back the same way:

- `project.key` is used by another project, archived ones included.
- The slug already belongs to a project this thread does not plan, or this thread already plans a different slug.
- After approval, a revision that changes `project.key`, `merge.strategy` or `merge.branch`.
- bb already has a sidebar section named `Loom · <name> (<slug>)`.
- Workers and reviewers cannot propose projects.

## Warnings

Warnings are returned but do not block a proposal.

- The reviewer and the worker use the same provider and model (including both left unset), so review shares the worker's blind spots.
- Two tickets have overlapping scope and no dependency path between them, so they will run one at a time. Add `depends_on` or narrow the scope.
- After approval, a revision's ticket list is ignored: "Ticket changes after approval go through the planner's board tools."

## Revisions

- Before approval, proposing again from the planner thread with the same slug adds a new draft version; older drafts are kept as superseded, and approving takes the newest.
- After approval, a revision becomes a pending version; `bb loom approve <slug>` applies it. Tickets are not recreated.
- Proposing a spec identical to the latest one changes nothing and returns the existing version.
