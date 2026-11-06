/** How long one git fetch, ls-remote or push gets when the spec sets no git_network_timeout_seconds. */
export const GIT_NETWORK_TIMEOUT_MS = 120_000;

/** The bounds of git_network_timeout_seconds. Twice the most, plus 30 seconds, stays under bb's 30-minute host call cap. */
export const GIT_NETWORK_TIMEOUT_SECONDS = { min: 30, max: 600 } as const;

/**
 * How long the index and tree steps of one host call on the project's checkout may take together (ls-tree, mktree,
 * commit-tree and merge-tree). A monorepo's trees under load take well over the 30 seconds quick git calls get.
 */
export const GIT_INDEX_TIMEOUT_MS = 300_000;

/** What a host's index timeout message says, in this version and the ones that still named a spec key after it. */
export const GIT_INDEX_TIMED_OUT = "the index and tree steps on the project's checkout ran past";
