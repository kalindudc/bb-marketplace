import type { OperationContext } from "../contracts.ts";
import type { ReaderProviderName, WebConfig } from "../config.ts";
import type { Resolver } from "../net.ts";
import type { ProviderTransport } from "../providers/http.ts";

export interface RemoteReaderResult {
	content: string;
	title: string;
	finalUrl: string;
	statusCode: number;
}

export interface RemoteReaderRequest {
	url: string;
	focus?: string;
	context: OperationContext;
	config: WebConfig;
	resolver?: Resolver;
	transport?: ProviderTransport;
}

export interface RemoteReaderAdapter {
	readonly id: Exclude<ReaderProviderName, "direct">;
	read(request: RemoteReaderRequest): Promise<RemoteReaderResult>;
}
