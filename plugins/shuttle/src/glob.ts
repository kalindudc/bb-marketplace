/** A glob with * and ?, matched whole; case-insensitive unless asked, since repository names and logins ignore case and paths do not. */
export function globMatch(glob: string, value: string, caseSensitive = false): boolean {
  const re = new RegExp(`^${glob.trim().replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*").replace(/\?/gu, ".")}$`, caseSensitive ? "u" : "iu");
  return re.test(value);
}
