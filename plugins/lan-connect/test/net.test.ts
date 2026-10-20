import { describe, expect, it } from "vitest";
import { bonjourName, isAllowedHost, isLanAddress, lanUrls, parseHostHeader, parseHostnames } from "../src/net";

describe("isLanAddress", () => {
  it.each([
    "192.168.10.21", "10.1.2.3", "172.16.0.1", "172.31.255.255", "127.0.0.1", "169.254.3.4",
    "::1", "fe80::1c1f:ec8b:1633:8adf%en0", "fd00::1", "::ffff:192.168.10.21", "::ffff:127.0.0.1",
  ])("accepts %s", (address) => {
    expect(isLanAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "::ffff:8.8.8.8", "100.99.90.87", "fd7a:115c:a1e0::1", "172.32.0.1", "2001:4860::8888", "not-an-ip", "", undefined])(
    "refuses %s",
    (address) => {
      expect(isLanAddress(address)).toBe(false);
    },
  );
});

describe("bonjourName", () => {
  it("uses scutil's LocalHostName on macOS", () => {
    const system = { platform: "darwin", hostname: () => "ignored", run: () => "MacBook-Pro-58\n" };
    expect(bonjourName(system)).toBe("macbook-pro-58.local");
  });

  it("falls back to the first label of the hostname when scutil fails", () => {
    const system = { platform: "darwin", hostname: () => "Studio.lan", run: () => { throw new Error("no scutil"); } };
    expect(bonjourName(system)).toBe("studio.local");
  });

  it("uses the hostname on other platforms", () => {
    const system = { platform: "linux", hostname: () => "pi4", run: () => "unused" };
    expect(bonjourName(system)).toBe("pi4.local");
  });
});

describe("parseHostHeader", () => {
  it.each([
    ["Bb.Home.Arpa.:80", "bb.home.arpa"],
    ["macbook-pro-58.local:38890", "macbook-pro-58.local"],
    ["[::1]:80", "::1"],
    ["[fe80::1]", "fe80::1"],
    ["192.168.10.21", "192.168.10.21"],
  ])("reads %s as %s", (header, host) => {
    expect(parseHostHeader(header)).toBe(host);
  });

  it.each([undefined, "", "bad host:80", "a/b", "[::1"])("refuses %s", (header) => {
    expect(parseHostHeader(header)).toBeNull();
  });
});

describe("isAllowedHost", () => {
  const names = new Set(["bb.home.arpa", "macbook-pro-58.local"]);

  it("accepts known names and IP literals", () => {
    expect(isAllowedHost("BB.home.arpa:38890", names)).toBe(true);
    expect(isAllowedHost("192.168.10.21:38890", names)).toBe(true);
    expect(isAllowedHost("[::1]:38890", names)).toBe(true);
  });

  it("refuses unknown names and a missing header", () => {
    expect(isAllowedHost("evil.example:38890", names)).toBe(false);
    expect(isAllowedHost(undefined, names)).toBe(false);
  });
});

describe("parseHostnames", () => {
  it("splits on commas and whitespace, lowercases and dedupes", () => {
    expect(parseHostnames(" bb.home.arpa, BB.home.arpa\nlab.lan ,, ")).toEqual(["bb.home.arpa", "lab.lan"]);
  });
});

describe("lanUrls", () => {
  it("lists extra hostnames, then LAN IPv4 addresses, then the .local name", () => {
    const urls = lanUrls({
      scheme: "http", port: 38890, hostnames: ["bb.home.arpa"], localName: "mac.local", addresses: ["192.168.10.21", "100.99.90.87", "192.168.10.7"],
    });
    expect(urls).toEqual(["http://bb.home.arpa:38890", "http://192.168.10.21:38890", "http://192.168.10.7:38890", "http://mac.local:38890"]);
  });

  it("puts a LAN IP first when there are no extra hostnames, because phones often cannot resolve .local", () => {
    expect(lanUrls({ scheme: "http", port: 38890, hostnames: [], localName: "mac.local", addresses: ["192.168.10.21"] })[0]).toBe("http://192.168.10.21:38890");
  });

  it("drops the default port for each scheme", () => {
    expect(lanUrls({ scheme: "http", port: 80, hostnames: [], localName: "mac.local", addresses: [] })).toEqual(["http://mac.local"]);
    expect(lanUrls({ scheme: "https", port: 443, hostnames: [], localName: "mac.local", addresses: [] })).toEqual(["https://mac.local"]);
    expect(lanUrls({ scheme: "https", port: 80, hostnames: [], localName: "mac.local", addresses: [] })).toEqual(["https://mac.local:80"]);
  });
});
