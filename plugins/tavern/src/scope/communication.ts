import { createHash } from "node:crypto";
import { messageTargetSchema, type CommunicationPreview, type SendTools } from "../shared/communication";
import type { ScopeCall } from "./engine";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export const sendRulesDigest = (rules: SendTools | undefined) => digest(JSON.stringify(rules ?? []));
function match(pattern: string, name: string) {
  const text = name.toLowerCase(), [start, ...parts] = pattern.toLowerCase().split("*");
  if (!parts.length) return text === start;
  const end = parts.pop()!;
  if (!text.startsWith(start) || !text.endsWith(end) || text.length < start.length + end.length) return false;
  let offset = start.length;
  const limit = text.length - end.length;
  for (const part of parts) {
    const index = text.indexOf(part, offset);
    if (index < 0 || index + part.length > limit) return false;
    offset = index + part.length;
  }
  return true;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
const own = (input: Record<string, unknown>, key: string) => Object.hasOwn(input, key) ? input[key] : undefined;
const bodyText = (value: unknown) => typeof value === "string" && value.length <= 256 * 1024 ? value : null;
export function readableTarget(value: unknown) {
  const parsed = messageTargetSchema.safeParse(value);
  return parsed.success && parsed.data === value ? parsed.data : null;
}
export const readableBody = (value: unknown) => bodyText(value);
export function namedCommunication(rules: SendTools | undefined, call: Pick<ScopeCall, "toolName" | "input">): CommunicationPreview | undefined {
  if (!rules?.length) return;
  const proxies = (input: ScopeCall["input"], nested: boolean): { tool: string; input: ScopeCall["input"] }[] => {
    const args = own(input, "arguments"), params = own(input, "params");
    const wrapped = object(args) ? args : undefined;
    const envelope = own(input, "method") === "tools/call" && object(params);
    const mcpName = envelope ? own(params, "name") : undefined;
    const mcpArgs = envelope ? own(params, "arguments") : undefined;
    const found = ["toolName", "tool", ...(wrapped ? ["name"] : [])].flatMap(key => {
      const tool = own(input, key);
      return typeof tool === "string" ? [{ tool, input: wrapped ?? input }] : [];
    });
    if (typeof mcpName === "string") found.push({ tool: mcpName, input: object(mcpArgs) ? mcpArgs : {} });
    if (nested) for (const inner of new Set([wrapped, object(mcpArgs) ? mcpArgs : undefined])) if (inner) found.push(...proxies(inner, false));
    return found;
  };
  const matched = [{ tool: call.toolName, input: call.input }, ...proxies(call.input, true)]
    .flatMap(candidate => rules.flatMap(rule => rule.pattern && match(rule.pattern, candidate.tool) ? [{ ...candidate, rule }] : []));
  const first = matched.find(item => item.rule.act === "send") ?? matched[0];
  if (!first) return;
  const sameAct = matched.filter(item => item.rule.act === first.rule.act);
  const targets = sameAct.map(item => item.rule.targetKey === undefined ? null : readableTarget(own(item.input, item.rule.targetKey)));
  const body = ["message", "text", "body"].map(key => own(first.input, key)).find(value => typeof value === "string");
  return { act: first.rule.act, tool: first.tool.slice(0, 200), target: targets.every(target => target === targets[0]) ? targets[0] ?? null : null, body: bodyText(body) };
}
function canonical(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new Error("Tool arguments are too deeply nested for an exact receipt");
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return ["array", value.map(item => canonical(item, depth + 1))];
  if (object(value)) return ["object", Object.keys(value).sort().map(key => [key, canonical(value[key], depth + 1)])];
  throw new Error("Tool arguments cannot be matched as JSON");
}
export function communicationCallDigest(call: Pick<ScopeCall, "toolName" | "input" | "cwd">): string | null {
  try { return digest(JSON.stringify([call.toolName, ["bash", "Bash"].includes(call.toolName) ? call.cwd : null, canonical(call.input)])); }
  catch { return null; }
}
