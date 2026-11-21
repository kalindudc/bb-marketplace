# Steer replay

Manual two-goal live replay referenced by `bb tavern steer-test` and paired with the automated test `test/server/steer.test.ts`.

## Automated check

From `plugins/tavern`:

```sh
node node_modules/vitest/vitest.mjs run test/server/steer.test.ts
```

## Live two-goal replay

Start a Keeper manually and give it two harmless, private goals named **Vault cutover** and **Proxy retry** (never use production work). Record their initial plan versions, then send these ten messages in order while the party works:

| # | Message | Expected read-as | Expected plan change |
| --- | --- | --- | --- |
| 1 | `Vault: stage first` | steer, Vault | Vault only |
| 2 | `What is waiting?` | question | Neither |
| 3 | `Look up lunch menus` | aside | Neither |
| 4 | `Proxy: retry only once` | steer, Proxy | Proxy only |
| 5 | `Which model checks it?` | question | Neither |
| 6 | `Vault: keep the rollback` | steer, Vault | Vault only |
| 7 | `Check the weather` | aside | Neither |
| 8 | `Proxy: stop the extra rollout` | steer, Proxy | Proxy only |
| 9 | `What is the ETA?` | question | Neither |
| 10 | `Vault: test staging again` | steer, Vault | Vault only |

## What to verify

- Every reply is concise and the routing tag names the right quest.
- Only steer messages create a new plan version, and only for the named quest.
- Questions and asides change neither plan; any aside helper thread has no board-quest or waypoint link.
