import { providerJson } from "../providers/http.ts";
import { assertRemoteForwardableUrl } from "./policy.ts";
import type { RemoteReaderAdapter, RemoteReaderResult } from "./types.ts";

const JINA_ORIGINS = ["https://r.jina.ai"];

export function parseJinaReaderResponse(payload: unknown): RemoteReaderResult {
	const data = payload as { code?: number; data?: { title?: string; url?: string; content?: string } };
	if (!data.data || typeof data.data.content !== "string") throw new Error("Jina Reader response did not include content");
	return {
		content: data.data.content,
		title: data.data.title ?? "",
		finalUrl: data.data.url ?? "",
		statusCode: data.code ?? 200,
	};
}

export const jinaReader: RemoteReaderAdapter = {
	id: "jina",
	async read(request) {
		const url = await assertRemoteForwardableUrl(request.url, { resolver: request.resolver, signal: request.context.deadline.signal, deadline: request.context.deadline });
		const { data } = await providerJson<unknown>({
			provider: "jina",
			url: `https://r.jina.ai/${url.href}`,
			headers: {
				Accept: "application/json",
				"X-Respond-With": "markdown",
				...(request.config.jinaApiKey ? { Authorization: `Bearer ${request.config.jinaApiKey}` } : {}),
			},
			context: request.context,
			config: request.config,
			allowedRedirectOrigins: JINA_ORIGINS,
		}, request.transport);
		const parsed = parseJinaReaderResponse(data);
		await assertRemoteForwardableUrl(parsed.finalUrl || url.href, { resolver: request.resolver, signal: request.context.deadline.signal, deadline: request.context.deadline });
		return parsed;
	},
};
