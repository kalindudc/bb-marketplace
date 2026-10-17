// Plugin Tailwind utilities are scoped to elements carrying these attributes, and portalled
// menus and dialogs render outside the plugin root, so each one must carry them itself.
// `bb plugin build` defines `__BB_PLUGIN_ID__`; tests run without it.
declare const __BB_PLUGIN_ID__: string | undefined;

export function portalScopeProps(): { "data-bb-portaled-overlay": ""; "data-bb-plugin-root": ""; "data-bb-plugin"?: string } {
  const pluginId = typeof __BB_PLUGIN_ID__ === "string" ? __BB_PLUGIN_ID__ : undefined;
  return { "data-bb-portaled-overlay": "", "data-bb-plugin-root": "", ...(pluginId === undefined ? {} : { "data-bb-plugin": pluginId }) };
}
