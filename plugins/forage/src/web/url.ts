export function canonicalUrlKey(input: string): string {
	const url = new URL(input);
	url.protocol = url.protocol.toLowerCase();
	url.hostname = url.hostname.toLowerCase();
	if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
	url.hash = "";
	return url.href;
}
