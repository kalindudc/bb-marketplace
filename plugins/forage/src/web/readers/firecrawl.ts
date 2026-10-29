import { firecrawlScrape, parseFirecrawlScrape } from "../providers/firecrawl.ts";
import { assertRemoteForwardableUrl } from "./policy.ts";
import type { RemoteReaderAdapter, RemoteReaderResult } from "./types.ts";

export function parseFirecrawlReaderResponse(payload: unknown): RemoteReaderResult {
	const parsed = parseFirecrawlScrape(payload);
	return { content: parsed.markdown, title: parsed.title, finalUrl: parsed.finalUrl, statusCode: parsed.statusCode };
}

export const firecrawlReader: RemoteReaderAdapter = {
	id: "firecrawl",
	async read(request) {
		const parsed = await firecrawlScrape(request);
		const finalUrl = parsed.finalUrl || request.url;
		await assertRemoteForwardableUrl(finalUrl, { resolver: request.resolver, signal: request.context.deadline.signal, deadline: request.context.deadline });
		return { content: parsed.markdown, title: parsed.title, finalUrl, statusCode: parsed.statusCode };
	},
};
