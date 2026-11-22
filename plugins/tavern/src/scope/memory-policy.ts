import { normalizeToolPath } from "./paths";
import type { Scope } from "./schema";
import type { ShellCommand } from "./shell";

export const MEMORY_COMMAND_RULE = "memory-profile-command";
const why = "Use tavern_memory instead of running a configured memory command directly";
const interpreters = /^(?:ba|da|z)?sh$|^(?:python(?:3(?:\.\d+)?)?|node|ruby|perl|bun)$/;
const hasPath = (value: string) => /[\\/]/.test(value);

export function withMemoryCommandPolicy(scope: Scope, paths: readonly string[]): Scope {
  const deny = scope.shell.deny.filter(rule => rule.id !== MEMORY_COMMAND_RULE);
  const commands = [...new Set(paths)].sort();
  if (commands.length) deny.push({ id: MEMORY_COMMAND_RULE, argv: [commands], why });
  return { ...scope, shell: { ...scope.shell, deny } };
}

export function memoryCommandRule(scope: Scope) {
  return scope.shell.deny.find(rule => rule.id === MEMORY_COMMAND_RULE);
}

export function memoryCommandCandidates(command: ShellCommand): string[] {
  const { executable, argv } = command;
  const script = interpreters.test(argv[0] ?? "") ? argv[1] === "--" ? argv[2] : argv[1] : undefined;
  return [executable, script && !script.startsWith("-") && hasPath(script) ? script : undefined]
    .filter((candidate): candidate is string => !!candidate);
}

export const memoryExecutableKey = (cwd: string, name: string) => `memory-exec:${cwd}/${name}`;

export function runsMemoryCommand(paths: readonly string[], command: ShellCommand, resolvedPaths: Readonly<Record<string, string>> | undefined) {
  return memoryCommandCandidates(command).some(executable => {
    if (!hasPath(executable)) return paths.includes(resolvedPaths?.[memoryExecutableKey(command.cwd, executable)] ?? "");
    const path = normalizeToolPath(executable, command.cwd);
    const target = command.aliases?.[path] ?? resolvedPaths?.[path] ?? path;
    return paths.includes(executable) || paths.includes(path) || paths.includes(target);
  });
}
