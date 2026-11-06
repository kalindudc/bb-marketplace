---
name: loom-pr-description
description: "How a Loom worker writes the title and description of its ticket's pull request (loom_submit's pr, loom_pr's title and body), and the rules a Loom reviewer judges that text by. Write for a human reviewer who has never seen Loom, its tickets or the agent's machine: a Summary with Why and What, Review guidance, Changed files, Technical details and Notes for reviewers, readable in under five minutes, with no ticket keys, no orchestration vocabulary and no sandbox details. Loom adds the merge and deploy section itself. Use whenever you write or review a Loom pull request's text."
---

# Loom pull request descriptions

Loom opens one pull request per ticket. Its worker writes the title and description, the reviewers judge them with the code, and Loom adds its own section at the end, between `<!-- loom:begin -->` and `<!-- loom:end -->`, with what must merge or deploy first, how the change deploys and how to roll it back. Do not write that section, its markers or a deploy order yourself.

The reader is a person on the team that owns the repository. They have never seen Loom, the spec, the ticket board or the machine you work on. Write so they can review the change on one read.

## Brevity

The whole description must be readable in under five minutes. Keep it short by leaving out what a reviewer does not need, not by compressing sentences.

- Use bullets for separate changes, and short, plain sentences for explanation.
- Leave out a section that adds nothing for this change rather than padding it.
- Define each acronym and internal name the first time it appears.
- The changed-files tree is often the longest section. That is fine: it is easy to scan.

## Write for the reviewer, not for the tooling

Every word must mean something to a reviewer who has never seen the tools, tickets or agents that produced the change.

- Refer to another change by its pull request link and a few words on what it does, for example "https://github.com/acme/shop/pull/2313 (the mobile bridge forwards the `X-Env` header)". Never by a ticket key, a ticket ref or a plan id, such as `ENV-11`, `core-env-header` or `@114`.
- Leave out how the change was produced: Loom and its vocabulary (planner, worker, reviewer agent, fix round, review round, brief, triage, the ticket, its scope, its greps, acceptance criterion numbers such as AC2), and the agent's machine or sandbox. When someone's decision shaped the design, state the decision and its reason, not who relayed it, and never "the human".
- State prerequisites as facts about systems, with links: what must be merged or deployed first, and what breaks if it is not. For example: "The core service must treat `X-Env: canary` as a forced canary in production first (https://github.com/acme/core/pull/2312); until then these jobs run on production queues." Loom's own section lists the merge and deploy order; mention a prerequisite in your text only where the reviewer needs it to understand the change.
- Testing: say what ran and what CI covers. Do not explain why something could not run on your machine ("the sandbox has no node_modules"); write "CI runs the unit and integration suites".
- Describe the change as it is now. Leave out earlier versions of the pull request, earlier review rounds and what an earlier attempt did.
- Every claim must match the diff. Check each one against the code before you hand the text in.
- Before you hand it in, scan the text for ticket keys (letters, a dash and a number, such as `ENV-11`) and for these words, and rewrite each hit for a reviewer: Loom, planner, worker, reviewer agent, round, brief, triage, sandbox, "the human", "the ticket", and AC followed by a number.

## Gathering what you need

Loom gives you the base branch in your brief. Read the change with `git diff <base>...HEAD` and the commit narrative with `git log --oneline <base>..HEAD`; on a stacked ticket, diff against the commit your brief says the work starts from, so the description covers only your change. Read the ticket's goal for the Why, and say it in the reviewer's terms: the problem, who it affects, and what breaks without the change.

For a change dominated by mechanical or generated edits, such as a rename across many files or output derived from a template, lead with the root change in the Summary and say in Review guidance that most of the diff is mechanical.

## Template

Highest-impact parts first. Omit any part that does not apply.

```markdown
## Summary

[An imperative one-liner: "Add X", "Fix Y", "Refactor Z". It must stand alone in git history.]

**Why:** [Two or three plain sentences: the problem, who or what it affects, and what breaks without this change.]

**What:** [Three to five bullets, each a short sentence that starts with a verb.]

## Review guidance

[Two to four bullets: what to focus on, where you are unsure, and what kind of feedback you want.]

## Changed files

[The changed files as a tree, with nothing but each file's insertions and deletions.]

## Technical details

- **Implementation:** [Key decisions and the approach, not a line-by-line walkthrough.]
- **Edge cases:** [The tricky cases it handles.]
- **Testing:** [What ran and what CI covers. Omit for a change with no source or test files.]

## Notes for reviewers

- **Migration:** [Only when the change needs a step besides its deploy, such as a data migration or a flag to flip.]
- **Related:** [Links to issues and pull requests that matter for review.]
- **Considerations:** [Compatibility, performance, known limits, planned follow-up.]
```

The changed-files tree looks like this:

```
src/
├── export/
│   ├── rows.ts                              (+100 -10)
│   └── rows.test.ts                         (+80 -0)
└── config.json                              (+2 -1)

3 files changed: 182 insertions, 11 deletions
```

The title is the Summary's one-liner, with no ticket key in front of it.

## For reviewers of the text

A Loom reviewer judges the title and description with the code, by the rules above. Request changes, with a finding, when the text:

- names a ticket key, a ticket ref or a plan id instead of a pull request link;
- uses Loom's vocabulary or talks about how the change was produced (planner, worker, round, brief, triage, "the ticket", "the human", acceptance criterion numbers);
- explains the agent's machine or sandbox instead of saying what ran and what CI covers;
- writes its own merge, deploy or rollout order section, or Loom's markers;
- claims something the diff does not do, or leaves out what the reviewer needs: the Why, the What, or a prerequisite that would break production.

Do not ask for Loom's own section: Loom writes it after the description.
