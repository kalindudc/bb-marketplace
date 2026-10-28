// Forage: web search and fetch as bb's own agent tools, for every provider.
// Wiring only; behavior lives in src/.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createCli } from "./src/cli.ts";
import { configFromSettings, SETTINGS } from "./src/settings.ts";
import { registerTools } from "./src/tools.ts";
import { cacheClear } from "./src/web/fetch.ts";

export default function foragePlugin(bb: BbPluginApi): void {
	const settings = bb.settings.define(SETTINGS);
	const getConfig = async () => configFromSettings(await settings.get());

	const reportWarnings = (warnings: string[], reason: string) => {
		for (const warning of warnings) bb.log.warn(`${reason}: ${warning}`);
	};

	void getConfig().then((config) => reportWarnings(config.warnings, "settings"));
	settings.onChange(() => {
		void getConfig().then((config) => reportWarnings(config.warnings, "settings changed"));
	});

	registerTools(bb, { getConfig });
	bb.cli.register(createCli({ getConfig }));

	bb.onDispose(() => cacheClear());
}
