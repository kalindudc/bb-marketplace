# Test filesystem isolation

Run `node node_modules/vitest/vitest.mjs run` from the plugin directory to avoid npm launcher logs. `npx vitest run` also works, but npm starts before this isolation and may write its own debug log to the caller’s npm cache. Vitest creates one temporary suite root before it starts workers. HOME, PI_CODING_AGENT_DIR, the XDG directories, npm and Git configuration paths, and TMPDIR/TMP/TEMP point inside that root. Vite's cache stays there too; the root is removed when the runner exits.

The worker setup blocks Node filesystem writes outside the suite root and reads of the real home outside the checkout and explicitly allowed node_modules. It checks sync, callback, promise, stream and descriptor APIs, follows symlinks, and rejects content writes through hard links. An attempted escape fails the test even if application code catches the immediate error. Standard input/output descriptors remain available for test-runner communication.

Use `tmpdir()` for ordinary fixtures. Use `TAVERN_TEST_FIXTURES` for project fixtures that must be outside the scope engine's scratch roots; it is a sibling of the suite's temporary directory, not part of the checkout. Optional capture/report output paths must also be inside the suite root. The actual pi jiti dependency is read-only; it does not use the fake home to locate installed code.

This is a Node filesystem tripwire, not an OS sandbox. It does not police native child-process or better-sqlite3 filesystem syscalls. Git, shell/sandbox and SQLite fixtures must therefore use paths inside the suite root; child processes inherit the temporary home/configuration/cache paths. Do not use native code as a bypass, and do not treat these checks as an adversarial security boundary.
