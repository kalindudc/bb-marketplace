/** How long one git fetch, ls-remote or push gets when the spec sets no git_network_timeout_seconds. */
export const GIT_NETWORK_TIMEOUT_MS = 120_000;

/** The bounds of git_network_timeout_seconds. Twice the most, plus 30 seconds, stays under bb's 30-minute host call cap. */
export const GIT_NETWORK_TIMEOUT_SECONDS = { min: 30, max: 600 } as const;

/**
 * How long the index and tree steps of one host call on the project's checkout may take together (read-tree, update-index,
 * write-tree, commit-tree and merge-tree), when the spec sets no git_index_timeout_seconds. A monorepo's whole index under
 * load takes well over the 30 seconds quick git calls get.
 */
export const GIT_INDEX_TIMEOUT_MS = 300_000;

/** The bounds of git_index_timeout_seconds. */
export const GIT_INDEX_TIMEOUT_SECONDS = { min: 30, max: 900 } as const;

/** The setting a host's timeout message names, so the post that carries it says what to raise. */
export const GIT_INDEX_SETTING = "git_index_timeout_seconds";
