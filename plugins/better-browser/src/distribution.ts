/**
 * Setting defaults that a marketplace redistributing this plugin may change for its users. They live apart from the
 * rest of the code so that every copy of the plugin can share all other files unchanged.
 */
export const DISTRIBUTION_DEFAULTS: Readonly<{ gatewayPages: string }> = {
  /** Access gateway pages, one pattern per line, as the gatewayPages setting takes them. */
  gatewayPages: "",
};
