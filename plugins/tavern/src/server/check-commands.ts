const bareCheck = /^(?:(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+(?:test|check|lint|typecheck|verify)(?::[\w-]+)?|node\s+--(?:test|check)|npx\s+tsc\s+--noEmit)$/;
const executablePath = /^(?:\.{1,2}\/|\/)[^\s`]+(?:\s+[^\n]*)?$/;
const commandName = /^[\w./-]+(?:\s|$)/;

export function doneWhenCommands(fields: readonly (string | null | undefined)[]): string[] {
  const commands = new Set<string>();
  for (const field of fields) {
    if (!field) continue;
    const withoutFences = field.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_fence, language: string, source: string) => {
      if (/^(?:sh|bash|shell)$/i.test(language.trim()) && source.trim()) commands.add(source.trim());
      return "";
    });
    for (const match of withoutFences.matchAll(/(^|[^`])`([^`\n]+)`(?!`)/g)) {
      const source = match[2]!.trim();
      const prefix = withoutFences.slice(0, match.index! + match[1]!.length);
      if (commandName.test(source) && (
        /^(?:npm|pnpm|yarn|bun|node|npx|tsc|eslint|pytest|python|python3|ruby|bundle|rspec|cargo|go|make|mvn|gradle|dotnet)(?:\s|$)/.test(source) ||
        executablePath.test(source) || /(?:\brun|\bexecute|\bcommand)\s*:?\s*$/i.test(prefix)
      )) commands.add(source);
    }
    const whole = field.trim();
    if (bareCheck.test(whole) || executablePath.test(whole)) commands.add(whole);
  }
  return [...commands];
}
