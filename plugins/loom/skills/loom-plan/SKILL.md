---
name: loom-plan
description: "Turn a goal into a Loom project: a validated spec with tickets, acceptance criteria, check commands, a review policy and a merge plan, proposed with loom_propose. Use when the user wants agents to build something as a project, says \"loom\", \"start a project\" or \"plan tickets\"."
---

# Plan a Loom project

You turn the user's loose goal into a Loom project spec (TOML). Loom's plugin runs the project afterwards: it hands tickets to worker agents, sends finished work to separate reviewers and merges approved work. You do not run any of that and you do not decide when a ticket is done. Your job ends when `loom_propose` accepts the spec and the human knows the next commands.

Read the spec reference first: the `loom` skill's `references/spec.md` lists every table and key, its default and an example spec.

## 1. Interview (one short round)

Ask only what you cannot find in the repository:

- Outcome: what should exist when the project is done, and how the human will tell.
- Non-goals: what is explicitly out of scope.
- Base branch: where work starts (default `main`).
- Merge plan: an integration branch that collects all approved tickets (`strategy = "integration"`), or one pull request per ticket (`strategy = "pr"`).
- Check commands: the commands that must pass on every submitted ticket (tests, type checks, lint).
- Models: ask for a reviewer model that differs from the worker's, so the reviewer does not share the worker's blind spots.
- Protected paths: files no ticket may change, such as lockfiles, CI config or generated code.

Anything the human cannot answer yet goes in `project.open_questions`; Loom refuses a spec while that list is not empty, so settle every question before you propose.

## 2. Read the code and run the checks once

Read the parts of the repository the goal touches. Run each check command once and note whether it passes on the base branch. A check that already fails will fail every ticket; tell the human before you propose.

## 3. Write the tickets

- One ticket fits one worker's context window: a change a person could review in one sitting.
- Acceptance criteria are testable statements, preferably in EARS form: "WHEN <event> THE SYSTEM SHALL <response>". Every ticket needs at least one.
- Scope lists the exact files or directories the ticket may change, as globs. A ticket outside its scope is flagged.
- Tickets whose scopes overlap must depend on each other with `depends_on`; otherwise Loom warns that they will run one at a time.
- `verify` lists commands that check this ticket alone. A ticket with no `verify` needs commands in `[checks]`.
- Do not copy ticket text from the goal; write what a worker who has not seen this conversation needs to start: the files to read, the behavior to build, what to leave alone.
- Never write `[NEEDS CLARIFICATION]` markers. Ask the human instead.

## 4. Propose

Call `loom_propose` with the whole spec. Fix every numbered error it returns and call it again; a refused spec creates nothing. Calling it again from this thread with the same slug revises the draft. Read any warnings and fix the ones that matter.

After the human approves the project, a revision is held as a pending version until they approve it, and its ticket list is ignored.

## 5. Hand over

Tell the human, in plain words, what you proposed and the next commands:

- `bb loom spec <slug>` to read the spec.
- `bb loom approve <slug>` to approve it and create the tickets.
- `bb loom start <slug>` to start the project.

## Rules

- NEVER approve, start, pause, resume or archive a project, and never post on a ticket as the human. Those commands refuse Loom threads, and they are the human's decisions.
- NEVER propose a project for another thread's slug. This thread plans one project.
- The plugin owns every state change. You can propose a spec; you cannot move a ticket.
