import type { Adapter } from "./adapters";
import type { Runner } from "./adapters/exec";
import type { Config, ServerConfig } from "./config";
import type { Store } from "./db/store";
import type { BbPort, ProjectInfo } from "./ports";
import type { Settings } from "./settings";

/** Everything Shuttle's behavior modules share. */
export interface Ctx {
  store: Store;
  port: BbPort;
  now(): number;
  settings(): Settings;
  config(): Config;
  server(id: string): ServerConfig | null;
  adapter(serverId: string): Adapter;
  projects(): Promise<ProjectInfo[]>;
  /** Runs a user-configured command, such as a server workspace command. */
  run: Runner;
}

export class ShuttleError extends Error {
  override readonly name: string = "ShuttleError";
}

/** A PR or thread that does not exist (as opposed to a request Shuttle refuses). */
export class NotFoundError extends ShuttleError {
  override readonly name = "NotFoundError";
}

export const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));
