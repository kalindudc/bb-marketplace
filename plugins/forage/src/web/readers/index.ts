import type { ReaderProviderName } from "../config.ts";
import { resolvePolicy } from "../../profiles.ts";
import { firecrawlReader } from "./firecrawl.ts";
import { jinaReader } from "./jina.ts";
import { tavilyReader } from "./tavily.ts";
import type { RemoteReaderAdapter, RemoteReaderRequest, RemoteReaderResult } from "./types.ts";

const READERS: Record<Exclude<ReaderProviderName, "direct">, RemoteReaderAdapter> = {
	tavily: tavilyReader,
	firecrawl: firecrawlReader,
	jina: jinaReader,
};

export async function readWithRemoteReader(input: RemoteReaderRequest & {
	reader: Exclude<ReaderProviderName, "direct">;
}): Promise<RemoteReaderResult> {
	resolvePolicy(input.config, { reader: input.reader }, "retrieval");
	return READERS[input.reader].read(input);
}

export type { RemoteReaderAdapter, RemoteReaderResult } from "./types.ts";
