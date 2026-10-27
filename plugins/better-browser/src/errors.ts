export type SyncErrorCode =
  | "unsupportedPlatform"
  | "unsupportedBrowser"
  | "notInstalled"
  | "noProfile"
  | "keychainPending"
  | "keychainDenied"
  | "keychainMissing"
  | "readFailed"
  | "noDesktop"
  | "noBrowserTab"
  | "writeFailed";

/** A failure the user can act on; its code travels to the toolbar and settings page. */
export class SyncError extends Error {
  constructor(readonly code: SyncErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SyncError";
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
