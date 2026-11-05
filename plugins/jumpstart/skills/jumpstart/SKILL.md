---
name: jumpstart
description: Resume bb threads that stopped on an error, such as a dropped connection or a provider timeout, with the Jumpstart plugin. `bb jumpstart list` shows every failed thread with the error that stopped it; `bb jumpstart kick <thread-id...>`, `--network` or `--all` retries their failed turns. Use when the user asks to resume, kick, continue or retry threads that failed, for example after a network blip.
---

# Jumpstart

Jumpstart retries the failed turn on threads in bb's failed (`error`) state. It uses bb's own retry: a turn the agent had started continues with "Please continue.", and a turn it never received is sent again, with the same model and reasoning level. When the error says the agent's process died or stopped answering, Jumpstart stops the thread first so bb starts a fresh agent on the same conversation.

The user also has a Resume failed threads button in the sidebar footer and the palette command `Jumpstart: resume failed threads`.

## Commands

    bb jumpstart list                  # failed threads, newest failure first
    bb jumpstart list --json           # { threads: [{ id, title, projectId, queued, reason, failedAt, network, restart }] }
    bb jumpstart kick <thread-id>...   # retry these threads
    bb jumpstart kick --network        # every failed thread whose error looks like a network failure
    bb jumpstart kick --all            # every failed thread
    bb jumpstart kick --network --json # { results: [{ threadId, outcome: "sent" | "queued" | "failed", ... }] }

`list` prints two lines per thread: `<thread-id>  network|other  <title>`, then the error and when it happened. `network` marks a dropped connection, a timeout or an unavailable or overloaded provider, which a retry can get past.

`kick` prints one line per thread: `resuming`, `queued: <what it waits for>`, or `failed: <why>`, and exits 1 when any thread failed to resume. `--network` and `--all` leave out threads that already have a message queued; name such a thread to retry it anyway.

## Rules

- Do not kick threads the user did not ask about. Prefer `--network`, or name the threads, over `--all`: a failure such as a missing model or a bad request fails again on retry.
- Read `bb jumpstart list` before kicking, and report the errors that are not network failures instead of retrying them.
- Archived and hidden threads are never listed or kicked in bulk.
