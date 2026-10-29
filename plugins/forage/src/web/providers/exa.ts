import { providerHttp, providerJson } from "./http.ts";
import type { ProviderSearchRequest, ProviderSearchResponse, ProviderSearchResult, SearchProviderAdapter } from "./types.ts";

const EXA_MCP_URL = "https://mcp.exa.ai/mcp?tools=web_search_advanced_exa";
const EXA_API_URL = "https://api.exa.ai/search";
const EXA_ORIGINS = ["https://mcp.exa.ai", "https://api.exa.ai"];
const EXA_MCP_CATEGORIES = new Set(["company", "publication", "news", "pdf", "github", "personal site", "people", "financial report"]);

interface ExaResult {
	url?: string;
	title?: string;
	publishedDate?: string;
	author?: string;
	score?: number;
	highlights?: string[];
	text?: string;
}

interface ExaPayload {
	results?: ExaResult[];
}

function resultFromExa(result: ExaResult): ProviderSearchResult | null {
	if (!result.url) return null;
	const highlights = result.highlights?.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
	return {
		title: result.title?.trim() || result.url,
		url: result.url,
		snippet: highlights?.join(" ").replace(/\s+/g, " ").slice(0, 1200) || result.text?.replace(/\s+/g, " ").slice(0, 1200) || "",
		publishedDate: result.publishedDate,
		author: result.author,
		score: result.score,
		highlights,
	};
}

function parsePayload(payload: ExaPayload): ProviderSearchResult[] {
	return (payload.results ?? []).map(resultFromExa).filter((result): result is ProviderSearchResult => Boolean(result));
}

export interface ExaArgumentsInput {
	query: string;
	numResults: number;
	domains?: { allow: string[]; deny: string[] };
	startPublishedDate?: string;
	endPublishedDate?: string;
	category?: string;
	content?: "snippets" | "chunks";
}

function baseArguments(input: ExaArgumentsInput): Record<string, unknown> {
	return {
		query: input.query,
		numResults: Math.min(20, input.numResults),
		...(input.domains?.allow.length ? { includeDomains: input.domains.allow } : {}),
		...(input.domains?.deny.length ? { excludeDomains: input.domains.deny } : {}),
		...(input.startPublishedDate ? { startPublishedDate: input.startPublishedDate } : {}),
		...(input.endPublishedDate ? { endPublishedDate: input.endPublishedDate } : {}),
	};
}

function mcpCategory(category: string | undefined): string | undefined {
	if (!category) return undefined;
	const normalized = category.trim().toLowerCase();
	return EXA_MCP_CATEGORIES.has(normalized) ? normalized : undefined;
}

function directCategory(category: string | undefined): string | undefined {
	if (!category) return undefined;
	return category.trim().toLowerCase() === "research" ? "research paper" : category.trim().toLowerCase();
}

export function buildExaMcpArguments(input: ExaArgumentsInput): Record<string, unknown> {
	const category = mcpCategory(input.category);
	return {
		...baseArguments(input),
		...(category ? { category } : {}),
		...(input.content === "chunks" ? { enableHighlights: true, highlightsMaxCharacters: 6000 } : {}),
	};
}

export function buildExaDirectRequest(input: ExaArgumentsInput): Record<string, unknown> {
	const category = directCategory(input.category);
	return {
		...baseArguments(input),
		...(category ? { category } : {}),
		contents: input.content === "chunks"
			? { text: true, highlights: { maxCharacters: 6000 } }
			: { text: true },
	};
}

function parseRpcBody(body: string): unknown {
	for (const line of body.split("\n")) {
		if (!line.startsWith("data:")) continue;
		try { return JSON.parse(line.slice(5).trim()) as unknown; } catch { /* continue */ }
	}
	try { return JSON.parse(body) as unknown; } catch { throw new Error("Exa MCP returned an unrecognized response"); }
}

export function parseExaMcpResponse(payload: unknown): { results: ProviderSearchResult[]; notices: string[] } {
	const rpc = payload as { error?: { message?: string }; result?: { isError?: boolean; content?: Array<{ type?: string; text?: string }> } };
	if (rpc.error) throw new Error(`Exa MCP error: ${rpc.error.message ?? "unknown"}`);
	const text = rpc.result?.content?.find((part) => part.type === "text" && typeof part.text === "string")?.text ?? "";
	if (rpc.result?.isError) throw new Error(text.trim().slice(0, 300) || "Exa MCP returned an error");
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end < start) return { results: [], notices: text.trim() ? [text.trim()] : [] };
	let data: ExaPayload;
	try {
		data = JSON.parse(text.slice(start, end + 1)) as ExaPayload;
	} catch {
		throw new Error("Exa MCP returned invalid structured JSON");
	}
	const notices = text.slice(0, start).split("\n").map((line) => line.trim().replace(/^Notice:\s*/i, "")).filter(Boolean);
	return { results: parsePayload(data), notices };
}

export function parseExaDirectResponse(payload: unknown): { results: ProviderSearchResult[]; notices: string[] } {
	return { results: parsePayload(payload as ExaPayload), notices: [] };
}

export const exaProvider: SearchProviderAdapter = {
	id: "exa",
	capabilities: { recency: true, domains: true, language: false, country: false, category: true, chunks: true },
	async search(request: ProviderSearchRequest): Promise<ProviderSearchResponse> {
		let parsed: { results: ProviderSearchResult[]; notices: string[] };
		const direct = request.explicitAccountApi && Boolean(request.config.exaApiKey);
		if (direct) {
			const body = buildExaDirectRequest(request);
			const { data } = await providerJson<unknown>({
				provider: "exa",
				url: EXA_API_URL,
				method: "POST",
				headers: { "Content-Type": "application/json", "x-api-key": request.config.exaApiKey! },
				body: JSON.stringify(body),
				context: request.context,
				config: request.config,
				allowedRedirectOrigins: EXA_ORIGINS,
			}, request.transport);
			parsed = parseExaDirectResponse(data);
		} else {
			const arguments_ = buildExaMcpArguments(request);
			const response = await providerHttp({
				provider: "exa",
				url: EXA_MCP_URL,
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-exa-source": "forage" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "web_search_advanced_exa", arguments: arguments_ } }),
				context: request.context,
				config: request.config,
				allowedRedirectOrigins: EXA_ORIGINS,
			}, request.transport);
			parsed = parseExaMcpResponse(parseRpcBody(response.text));
		}
		const categoryApplied = Boolean(request.category && (direct || mcpCategory(request.category)));
		const appliedControls = [
			...(request.recency ? ["recency" as const] : []),
			...(request.domains.allow.length || request.domains.deny.length ? ["domains" as const] : []),
			...(categoryApplied ? ["category" as const] : []),
			...(request.content === "chunks" ? ["chunks" as const] : []),
		];
		return {
			results: parsed.results,
			rawCount: parsed.results.length,
			appliedControls,
			unsupportedControls: request.category && !categoryApplied ? ["category"] : [],
			notices: parsed.notices,
		};
	},
};
