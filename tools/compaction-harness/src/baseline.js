// baseline: build two reference contexts for the same span with no model.
//  - 'none': empty context
//  - 'pi-native-serialisation': pi's own serializeConversation(), ported from
//    packages/coding-agent/src/core/compaction/utils.ts (observed on this
//    machine in @earendil-works/pi-coding-agent dist): [User]/[Assistant]/
//    [Assistant tool calls]/[Tool result], thinking omitted, tool results
//    truncated to 2000 chars.
import { rowText, rowToolCalls } from './session.js';

const TOOL_RESULT_MAX_CHARS = 2000;

export function truncateForSummary(text, maxChars = TOOL_RESULT_MAX_CHARS) {
  if (text.length <= maxChars) return text;
  const truncatedChars = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

export function serializeConversation(rows) {
  const parts = [];
  for (const msg of rows) {
    if (msg.role === 'user') {
      const content = rowText(msg).trim();
      if (content) parts.push(`[User]: ${content}`);
    } else if (msg.role === 'assistant') {
      const toolCalls = [];
      for (const block of rowToolCalls(msg)) {
        const args = Object.entries(block.arguments ?? {})
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(', ');
        toolCalls.push(`${block.name}(${args})`);
      }
      const text = rowText(msg).trim();
      if (text) parts.push(`[Assistant]: ${text}`);
      if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join('; ')}`);
    } else if (msg.role === 'toolResult') {
      const content = rowText(msg).trim();
      if (content) parts.push(`[Tool result]: ${truncateForSummary(content)}`);
    }
  }
  return parts.join('\n\n');
}

export function buildBaseline(kind, session) {
  if (kind === 'none') {
    return { kind, label: 'none (empty)', text: '' };
  }
  if (kind === 'pi-native-serialisation') {
    return { kind, label: 'pi-native-serialisation', text: serializeConversation(session.messages) };
  }
  throw new Error(`unknown baseline kind: ${kind}`);
}