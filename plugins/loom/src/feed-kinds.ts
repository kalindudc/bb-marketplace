// The kinds Home's Since you looked shows and how many rows it asks for: a leaf, so the contract and the page can use
// them without the server's event reading.
export const FEED_KINDS = ["shipped", "sentBack", "blocked", "asks", "phase", "you"] as const;
export type FeedKind = (typeof FEED_KINDS)[number];

/** Rows sent by default, and at most whatever the page asks for. */
export const HOME_FEED_LIMIT = 60;
export const HOME_FEED_MAX = 600;
