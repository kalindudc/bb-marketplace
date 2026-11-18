export type ForgeResult = { ok: true; url: string; state?: "open" | "merged" | "closed" } | { ok: false; failureClass: "temporary" | "lasting" | "broken contract"; lines: string };
export function forgeFailure(result: { code: number | null; stdout: string; stderr: string; timedOut: boolean }, broken = false): Extract<ForgeResult, { ok: false }> {
  const lines = [result.stdout, result.stderr].join("\n").trim().split("\n").slice(-12).join("\n").slice(-4000);
  const temporary = /(?:HTTP\s+(?:429|50[0234])\b|^\s*(?:429|50[0234])\b|network|connection (?:refused|reset|timed out)|could not resolve|failed to connect|TLS handshake|rate limit)/im.test(lines);
  return { ok: false, failureClass: result.timedOut ? "lasting" : broken ? "broken contract" : temporary ? "temporary" : "lasting", lines: `${result.timedOut ? "Timed out" : `Exit ${result.code}`}\n${lines}` };
}
