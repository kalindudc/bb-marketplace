import { execFile } from "node:child_process";
import { deriveMacKey } from "./chromium";
import { SyncError } from "./errors";

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type RunCommand = (file: string, args: readonly string[]) => Promise<CommandResult>;

export const runCommand: RunCommand = (file, args) =>
  new Promise((resolve) => {
    execFile(file, [...args], { encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout, stderr });
      const code = (error as { code?: unknown }).code;
      resolve({ code: typeof code === "number" ? code : null, stdout: stdout ?? "", stderr: stderr || error.message });
    });
  });

/** How long one RPC call waits for the Keychain prompt before reporting that it is still waiting. */
export const KEYCHAIN_WAIT_MS = 20_000;

/**
 * Reads each browser's "Safe Storage" password once per worker. macOS shows a Keychain prompt the first time; the
 * prompt can outlive one RPC call, so the request stays pending and the next call picks up its answer instead of
 * opening a second prompt.
 */
export function createKeychain(run: RunCommand = runCommand, waitMs = KEYCHAIN_WAIT_MS) {
  const keys = new Map<string, Buffer>();
  const pending = new Map<string, Promise<Buffer>>();

  async function read(service: string, account: string): Promise<Buffer> {
    const result = await run("/usr/bin/security", ["find-generic-password", "-w", "-s", service, "-a", account]);
    if (result.code === 0) {
      const password = result.stdout.replace(/\r?\n$/, "");
      if (password) return deriveMacKey(password);
      throw new SyncError("keychainMissing", `The Keychain item "${service}" is empty`);
    }
    if (result.code === 44 || /could not be found/i.test(result.stderr)) {
      throw new SyncError("keychainMissing", `The Keychain has no "${service}" item; open the browser once so it creates one`);
    }
    throw new SyncError(
      "keychainDenied",
      `Keychain access to "${service}" was refused. Sync again and choose Always Allow in the Keychain prompt.`,
    );
  }

  return {
    async key(service: string, account: string): Promise<Buffer> {
      const id = `${service}\u0000${account}`;
      const known = keys.get(id);
      if (known) return known;
      let request = pending.get(id);
      if (!request) {
        request = read(service, account).then(
          (key) => {
            keys.set(id, key);
            pending.delete(id);
            return key;
          },
          (error: unknown) => {
            pending.delete(id);
            throw error;
          },
        );
        pending.set(id, request);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiting = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SyncError("keychainPending", `Waiting for you to allow "${service}" in the Keychain prompt`)),
          waitMs,
        );
      });
      try {
        return await Promise.race([request, waiting]);
      } finally {
        clearTimeout(timer);
      }
    },
    forget(): void {
      keys.clear();
    },
  };
}

export type Keychain = ReturnType<typeof createKeychain>;
