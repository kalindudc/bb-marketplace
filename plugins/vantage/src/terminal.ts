import type { BbNavigate, PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";

export function shellQuote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

export function terminalCommand(path: string): string {
  return `cd ${shellQuote(path)} && exec "\${SHELL:-/bin/sh}" -l`;
}

// The terminal belongs to the panel's thread: bb shows a thread only its own terminals.
export async function openWorktreeTerminal(
  sdk: Pick<PluginBrowserBbSdk, "terminals">,
  navigate: Pick<BbNavigate, "experimental_openTerminal">,
  input: { threadId: string; path: string; title: string },
): Promise<boolean> {
  const session = await sdk.terminals.create({
    cols: 120, rows: 32, scope: { kind: "thread", threadId: input.threadId }, title: input.title,
    start: { mode: "command", command: terminalCommand(input.path) },
  });
  return navigate.experimental_openTerminal({ terminalId: session.id });
}
