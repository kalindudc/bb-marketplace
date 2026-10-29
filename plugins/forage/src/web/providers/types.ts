import type { OperationContext } from "../contracts.ts";
import type { ConcreteSearchProvider, WebConfig } from "../config.ts";
import type { ProviderTransport } from "./http.ts";

export type SearchControl = "recency" | "domains" | "language" | "country" | "category" | "chunks";

export interface ProviderCapabilities {
	recency: boolean;
	domains: boolean;
	language: boolean;
	country: boolean;
	category: boolean;
	chunks: boolean;
}

export interface ProviderSearchResult {
	title: string;
	url: string;
	snippet: string;
	publishedDate?: string;
	age?: string;
	author?: string;
	score?: number;
	highlights?: string[];
}

export interface ProviderSearchRequest {
	query: string;
	numResults: number;
	recency?: "day" | "week" | "month" | "year";
	domains: { allow: string[]; deny: string[] };
	language?: string;
	country?: string;
	category?: string;
	content?: "snippets" | "chunks";
	startPublishedDate?: string;
	endPublishedDate?: string;
	context: OperationContext;
	config: WebConfig;
	explicitAccountApi: boolean;
	transport?: ProviderTransport;
}

export interface ProviderSearchResponse {
	results: ProviderSearchResult[];
	rawCount: number;
	appliedControls: SearchControl[];
	unsupportedControls: SearchControl[];
	notices: string[];
}

export interface SearchProviderAdapter {
	readonly id: ConcreteSearchProvider;
	readonly capabilities: ProviderCapabilities;
	search(request: ProviderSearchRequest): Promise<ProviderSearchResponse>;
}
