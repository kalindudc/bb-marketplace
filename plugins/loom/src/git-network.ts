/** How long one git fetch, ls-remote or push gets when the spec sets no git_network_timeout_seconds. */
export const GIT_NETWORK_TIMEOUT_MS = 120_000;

/** The bounds of git_network_timeout_seconds. Twice the most, plus 30 seconds, stays under bb's 30-minute host call cap. */
export const GIT_NETWORK_TIMEOUT_SECONDS = { min: 30, max: 600 } as const;
