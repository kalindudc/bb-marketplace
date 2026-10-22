# Loom spec reference

A Loom spec is one TOML document. `loom_propose` parses it with a strict schema: an unknown key is an error, and every error names its TOML path and the fix. Tickets are numbered from 0 in the order of the `[[ticket]]` tables, so `ticket[2]` is the third one.

Workers, the plugin's checks, reviewers, merging, budgets and triage all use these settings.

A spec without `[[repo]]` tables is a single-repo project: every ticket runs in the repository of the bb project the planner thread belongs to. A spec with `[[repo]]` tables spans those repositories, and every ticket names the one it changes (see [[repo]] and the second example below).

## Tables and keys

### [project]

| Key | Type | Default | Rule |
|---|---|---|---|
| `slug` | string | required | `^[a-z][a-z0-9-]{1,39}$`; names the project and its sidebar section |
| `name` | string | required | 1 to 80 characters |
| `key` | string | required | `^[A-Z][A-Z0-9]{1,7}$`; the ticket key prefix (`CSV` gives `CSV-1`); unique across all projects, archived ones included |
| `goal` | string | required | 20 to 4000 characters |
| `non_goals` | string array | `[]` | at most 50, each up to 500 characters |
| `base` | string | `"main"` | the branch work starts from; a plain git name; the default `base` of every `[[repo]]` |
| `open_questions` | string array | `[]` | must be empty |

### [merge]

| Key | Type | Default | Rule |
|---|---|---|---|
| `strategy` | string | required | `"integration"` (approved work merges into one branch) or `"pr"` (one pull request per ticket) |
| `branch` | string | `loom/<slug>` | integration strategy only; a multi-repo project has an integration branch of this name in every repo |
| `remote` | string | `"origin"` | a plain remote name; the default `remote` of every `[[repo]]` |
| `draft` | boolean | `true` | whether pull requests open as drafts |

### [checks]

| Key | Type | Default | Rule |
|---|---|---|---|
| `commands` | string array | `[]` | at most 10; run on every submitted ticket, except in a repo whose `[[repo]]` table sets its own `checks` |
| `after_merge` | string array | `[]` | at most 10; run on the merged integration branch, which they must leave as they found it (no new commit, no edited tracked file) or the merge is rolled back; not allowed with strategy `"pr"`; a repo that sets its own `after_merge` runs that instead |
| `timeout_minutes` | integer | `15` | 1 to 29 |

### [scope]

| Key | Type | Default | Rule |
|---|---|---|---|
| `protected` | string array | `[]` | globs no ticket may change; at most 100; in a multi-repo project they apply in every repo, relative to its root |
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

### [[repo]]

Zero to 10 entries. Leave them out when the work stays in the planner thread's own repository. With one or more, the project spans exactly these repositories: list every repo the work changes, the planner thread's own project included when the work changes it too.

| Key | Type | Default | Rule |
|---|---|---|---|
| `name` | string | required | `^[a-z][a-z0-9-]{0,23}$`; unique among the `[[repo]]` tables; tickets name it in `repo` |
| `project` | string | required | the id of a standard bb project, such as `proj_abc123`, from `bb project list --json`; each bb project in one table only; it must have a checkout on the machine the planner runs on, where the workers run |
| `base` | string | `project.base` | the branch this repo's work starts from and lands on; a plain git name |
| `remote` | string | `merge.remote` | a plain remote name; where this repo's pull requests open and its land pushes |
| `checks` | string array | `checks.commands` | at most 10; replaces `checks.commands` for the tickets in this repo; an empty list runs no project checks there |
| `after_merge` | string array | `checks.after_merge` | at most 10; replaces `checks.after_merge` on this repo's integration branch; not allowed with strategy `"pr"` |
| `protected` | string array | `[]` | at most 100 globs, relative to this repo's root; added to `scope.protected` for the tickets in this repo |

Each repo gets its own integration branch (`merge.branch`, from the repo's `base`) and its own Loom worktree. Tickets in different repos never share a file, so their scopes never overlap.

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
| `repo` | string | none | required when the spec has `[[repo]]` tables, and then one of their names; not allowed without them. The ticket changes only this repo: its `scope`, `verify` and protected paths are relative to the repo's root. `depends_on` may name a ticket in another repo. |

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

## Example: a project across two repos

An API change in one repository and the page that uses it in another. Each repo has its own toolchain, so each sets its own checks, and the web ticket depends on the API ticket across the two repos.

```toml
[project]
slug = "order-notes"
name = "Order notes"
key = "NOTE"
goal = "Let staff add a note to an order through the orders API, and show the note on the order page of the web app."
non_goals = ["Editing notes from the web app", "Notes on other resources"]
base = "main"

[merge]
strategy = "integration"

[scope]
protected = [".github/**"]

[agents.worker]
provider = "claude-code"
model = "sonnet"

[agents.reviewer]
provider = "codex"
model = "gpt"

[[repo]]
name = "api"
project = "proj_api7k2m9q"
checks = ["go test ./...", "go vet ./..."]
protected = ["go.sum"]

[[repo]]
name = "web"
project = "proj_web4x8n2r"
base = "trunk"
checks = ["npm test", "npm run typecheck"]
after_merge = ["npm test"]
protected = ["package-lock.json"]

[[ticket]]
ref = "notes-api"
repo = "api"
title = "Store and serve order notes"
body = "Add a nullable note column to orders (a migration in db/migrations), accept note in PATCH /orders/{id} and return it from GET /orders/{id}. Update api/openapi.yaml to match. Read internal/orders/handler.go first."
acceptance = [
  "WHEN a client sends PATCH /orders/{id} with a note THE SYSTEM SHALL store it and return it from GET /orders/{id}",
  "WHEN an order has no note THE SYSTEM SHALL return note as null",
]
scope = ["internal/orders/**", "db/migrations/**", "api/openapi.yaml"]
priority = 1

[[ticket]]
ref = "notes-page"
repo = "web"
title = "Show the note on the order page"
body = "Read note from GET /orders/{id} (api/openapi.yaml in the api repo describes it; read it, do not edit it) and show it under the order summary in src/orders/OrderPage.tsx. Show nothing when note is null."
acceptance = [
  "WHEN an order has a note THE SYSTEM SHALL show it under the order summary",
  "WHEN an order's note is null THE SYSTEM SHALL show no note section",
]
scope = ["src/orders/**", "test/orders/**"]
depends_on = ["notes-api"]
```

- No ticket has `verify` and `[checks]` is empty, which is allowed because each ticket's repo sets `checks`. A ticket in `api` runs the Go commands and a ticket in `web` runs the npm commands.
- `bb loom start` creates `loom/order-notes` in both repos: from `main` in `api`, and from `trunk` in `web`.
- `notes-page` starts only after `notes-api` is done, that is merged into `loom/order-notes` in `api`. Its worker works in a checkout of `web`, and its brief gives the path of the `api` checkout to read, not to edit.
- A ticket's protected paths are `.github/**` and its own repo's list: `go.sum` in `api`, `package-lock.json` in `web`.
- `bb loom land order-notes` opens one pull request in each repo, `bb loom land order-notes --repo api` lands only `api`, and the project is done when every repo with merged work has landed.

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

Repos add these errors:

- Two `[[repo]]` tables with the same `name`, or with the same `project`: list each bb project in one table only.
- A ticket sets `repo`, but the spec has no `[[repo]]` table. Add the table, or remove `repo` from the ticket.
- The spec has `[[repo]]` tables and a ticket has no `repo`, or names a repo that is not one of them. The error lists the repo names.
- A ticket scope glob equals, or sits under, a `protected` glob of its repo.
- A ticket has no `verify` command and its repo's `checks` is an empty list, or its repo sets no `checks` and `checks.commands` is empty.
- A `[[repo]]` sets `after_merge` with strategy `"pr"`.

Loom also checks every `[[repo]]` against bb when the spec is proposed:

- `project` is not a bb project, or is bb's personal project, which has no git checkout. The error lists bb's standard projects with their ids.
- The bb project has no checkout on the machine the planner runs on, where the workers run. The error gives the command that clones it there, `bb project source add <id> --clone --machine <host>`; run it once the human agrees, then propose again.
- bb's projects could not be read, or bb did not say which machine the planner runs on. Unlike an unreadable provider list, this refuses the spec, because the project could not start without a checkout of every repo. Propose again in a moment.

Refusals tied to existing projects come back the same way:

- `project.key` is used by another project, archived ones included.
- The slug already belongs to a project this thread does not plan, or this thread already plans a different slug.
- After approval, a revision that changes `project.key`, `merge.strategy` or `merge.branch`.
- After approval, a revision that adds `[[repo]]` tables to a project approved without them, removes or renames an approved repo, or changes an approved repo's `project`, `base` or `remote`, including through the `project.base` or `merge.remote` it inherits. Its tickets, branches and worktrees already use them. A revision may add new `[[repo]]` tables; the planner adds their tickets with `loom_add_tickets`.
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
