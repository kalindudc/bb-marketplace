import { describe, expect, it } from "vitest";
import { compareSemver, refFromDisplay, semverFromRef, versionLabel } from "../src/versions";

const GENUI = "https://github.com/acme/bb-plugins.git@genui/v0.2.7 (f1fb0e872fb2)";
const BURN = "https://github.com/kalindudc/burn@HEAD (eed869846b8e)";
const SHA = "f1fb0e872fb287da2ffb49363bbf81513825cc29";

describe("source displays", () => {
  it("reads the ref bb resolved", () => {
    expect(refFromDisplay(GENUI)).toBe("genui/v0.2.7");
    expect(refFromDisplay(BURN)).toBe("HEAD");
    expect(refFromDisplay("builtin:composer")).toBeNull();
  });

  it("reads a release version only from a release tag", () => {
    expect(semverFromRef("genui/v0.2.7")).toBe("0.2.7");
    expect(semverFromRef("v1.3.0")).toBe("1.3.0");
    expect(semverFromRef("loom/v0.30.0-rc.1")).toBe("0.30.0-rc.1");
    expect(semverFromRef("HEAD")).toBeNull();
  });

  it("labels a tagged release by its version and anything else by its short commit", () => {
    expect(versionLabel(SHA, GENUI)).toBe("0.2.7");
    expect(versionLabel(SHA, BURN)).toBe("f1fb0e8");
    expect(versionLabel(SHA, null)).toBe("f1fb0e8");
    expect(versionLabel("1.4.0", null)).toBe("1.4.0");
  });
});

describe("compareSemver", () => {
  it("orders by number, not by text", () => {
    expect(compareSemver("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareSemver("0.2.6", "0.2.6")).toBe(0);
  });

  it("puts a prerelease before its release", () => {
    expect(compareSemver("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareSemver("1.0.0-rc.2", "1.0.0-rc.10")).toBeLessThan(0);
  });

  it("refuses something that is not a version", () => {
    expect(() => compareSemver("HEAD", "1.0.0")).toThrow(/not a semver/u);
  });
});
