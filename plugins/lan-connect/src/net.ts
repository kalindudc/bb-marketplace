import { execFileSync } from "node:child_process";
import { BlockList, isIP } from "node:net";
import os from "node:os";

export const HOSTNAME_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

const HOST_HEADER_PATTERN = /^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::[0-9]{1,5})?$/i;

// Tailscale reaches beyond the home network: its IPv4 100.64.0.0/10 is not listed, and its IPv6 range sits inside fc00::/7.
const excluded = new BlockList();
excluded.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");
const lan = new BlockList();
for (const [network, prefix] of [["127.0.0.0", 8], ["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["169.254.0.0", 16]] as const) {
  lan.addSubnet(network, prefix, "ipv4");
}
lan.addAddress("::1", "ipv6");
lan.addSubnet("fe80::", 10, "ipv6");
lan.addSubnet("fc00::", 7, "ipv6");

export function isLanAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const bare = address.split("%", 1)[0] ?? "";
  const family = isIP(bare);
  if (family === 0) return false;
  const type = family === 6 ? "ipv6" : "ipv4";
  return !excluded.check(bare, type) && lan.check(bare, type);
}

interface System {
  platform: string;
  hostname(): string;
  run(command: string, args: string[]): string;
}

const realSystem: System = {
  platform: process.platform,
  hostname: () => os.hostname(),
  run: (command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 2000 }),
};

export function bonjourName(system: System = realSystem): string {
  if (system.platform === "darwin") {
    try {
      const name = system.run("scutil", ["--get", "LocalHostName"]).trim();
      if (name.length > 0) return `${name.toLowerCase()}.local`;
    } catch {
      // Fall through to the hostname, which macOS also derives the Bonjour name from.
    }
  }
  const label = system.hostname().split(".", 1)[0]?.toLowerCase() ?? "";
  return `${label.length > 0 ? label : "localhost"}.local`;
}

export function parseHostHeader(host: string | undefined): string | null {
  if (host === undefined || !HOST_HEADER_PATTERN.test(host)) return null;
  const name = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.replace(/:[0-9]+$/, "");
  const normalized = name.toLowerCase().replace(/\.$/, "");
  return normalized.length > 0 ? normalized : null;
}

export function isAllowedHost(host: string | undefined, names: ReadonlySet<string>): boolean {
  const name = parseHostHeader(host);
  if (name === null) return false;
  return isIP(name) !== 0 || names.has(name);
}

export function parseHostnames(value: string): string[] {
  const names = value
    .split(/[\s,]+/)
    .map((name) => name.toLowerCase().replace(/\.$/, ""))
    .filter((name) => name.length > 0);
  return [...new Set(names)];
}

function interfaceAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
}

// IP addresses come before the .local name: many phones and some Wi-Fi networks cannot resolve .local names.
export function lanUrls(args: {
  scheme: "http" | "https";
  port: number;
  hostnames: readonly string[];
  localName: string;
  addresses?: readonly string[];
}): string[] {
  const defaultPort = args.scheme === "http" ? 80 : 443;
  const suffix = args.port === defaultPort ? "" : `:${args.port}`;
  const addresses = (args.addresses ?? interfaceAddresses()).filter((address) => isIP(address) === 4 && isLanAddress(address));
  const hosts = [...new Set([...args.hostnames, ...addresses, args.localName])];
  return hosts.map((host) => `${args.scheme}://${host}${suffix}`);
}
