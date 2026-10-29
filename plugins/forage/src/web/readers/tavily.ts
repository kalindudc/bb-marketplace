import { tavilyExtract } from "../providers/tavily.ts";
import { assertRemoteForwardableUrl } from "./policy.ts";
import type { RemoteReaderAdapter, RemoteReaderResult } from "./types.ts";

export function parseTavilyReaderResponse(payload: unknown, requestedUrl: string): RemoteReaderResult {
	const data = payload as { results?: Array<{ url?: string; raw_content?: string }>; failed_results?: Array<{ url?: string; error?: string }> };
	const result = data.results?.find((entry) => typeof entry.raw_content === "string");
	if (!result?.raw_content) {
		const failure = data.failed_results?.[0];
		throw new Error(failure?.error ?? "Tavily extract returned no content");
	}
	return { content: result.raw_content, title: "", finalUrl: result.url ?? requestedUrl, statusCode: 200 };
}

export const tavilyReader: RemoteReaderAdapter = {
	id: "tavily",
	async read(request) {
		const url = await assertRemoteForwardableUrl(request.url, { resolver: request.resolver, signal: request.context.deadline.signal, deadline: request.context.deadline });
		const parsed = await tavilyExtract([url.href], { query: request.focus, context: request.context, config: request.config, transport: request.transport });
		const result = parseTavilyReaderResponse({
			results: parsed.results.map((entry) => ({ url: entry.url, raw_content: entry.content })),
			failed_results: parsed.failures,
		}, url.href);
		await assertRemoteForwardableUrl(result.finalUrl, { resolver: request.resolver, signal: request.context.deadline.signal, deadline: request.context.deadline });
		return result;
	},
};
