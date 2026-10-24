import type { ServerConfig } from "../config";
import type { Adapter } from "./adapter";
import { CommandAdapter } from "./command";
import type { Runner } from "./exec";
import { GithubAdapter } from "./github";

export { AdapterError, type Adapter, type ListOptions, type ListResult } from "./adapter";

export function adapterFor(server: ServerConfig, run?: Runner): Adapter {
  return server.kind === "github" ? new GithubAdapter(server, run) : new CommandAdapter(server, run);
}
