# Tavern documentation

Tavern is a bb plugin that lets you hand a goal to a lead agent, called a Keeper, and keep the decisions that matter. These guides are for people using Tavern and for contributors working on the plugin.

## Guides

- [How Tavern works](design.md): Start here for the architecture diagram, key concepts, and the path a quest takes from start to finish.
- [Quests, party, and characters](quests-and-party.md): Learn to steer quests, delegate through side quests, set budgets, and manage quest controls, classes, and service records.
- [Safety and controls](safety-and-controls.md): See how scopes, the Pi guard, the send guard, cluster writes, `scopes.yml`, Closing time, and Stop all protect your work.
- [Machines and forges](machines-and-forges.md): Set machine rules and per-class models, and see how clean Git snapshots and draft pull requests work from home.
- [Settings, memory, backups, and CLI](settings-and-data.md): Find guided setup, contextual speech, Durable memory, backups, and `bb tavern` commands.

## Contributing

- [Development and testing](contributing/development.md): Find the architecture layout, core invariants, and how to build and test Tavern.
- [SDK and backend contracts](contributing/contracts.md): See which bb interfaces Tavern uses and how its settings, tuning, and public calls work.
- [Open bb host requests](contributing/host-asks.md): See which changes Tavern needs from bb and how it works around those gaps today.

Agent instructions live in the skills for [Tavern](../skills/tavern/SKILL.md), [Journal](../skills/journal/SKILL.md), and [Tavern Keeper](../skills/tavern-keeper/SKILL.md), not here.
