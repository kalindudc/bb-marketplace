import type { ExperimentalHostSignals } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { defineContract } from "./define-contract";

const id = z.string().min(1).max(64).regex(/^[a-z0-9-]+$/);
const profile = z.string().min(1).max(4096);
const url = z.string().max(8192).refine((value) => /^https?:\/\//i.test(value), "Only http and https links open externally");

export const errorCode = z.enum([
  "unsupportedPlatform", "unsupportedBrowser", "notInstalled", "noProfile", "keychainPending", "keychainDenied",
  "keychainMissing", "readFailed", "noDesktop", "noBrowserTab", "writeFailed",
]);
const failure = z.object({ ok: z.literal(false), code: errorCode, message: z.string().max(2000) }).strict();

export const browserInfo = z.object({
  id,
  name: z.string(),
  engine: z.enum(["chromium", "firefox", "safari"]),
  installed: z.boolean(),
  /** False for a browser bb can only open links in, such as Safari. */
  syncable: z.boolean(),
  profiles: z.array(z.object({ directory: profile, name: z.string(), account: z.string().optional() }).strict()),
  lastUsedProfile: profile.optional(),
}).strict();
export type BrowserInfo = z.infer<typeof browserInfo>;

const source = z.object({ browserId: id, profile: profile.optional() }).strict();

/** Hostnames, lower case and without a leading dot or port. */
export const mirrorHosts = z.array(z.string().min(1).max(253).regex(/^[a-z0-9.-]+$/)).min(1).max(10);

const readCounts = {
  /** The profile directory that was read, after resolving the default. */
  profile,
  cookies: z.number().int(),
  undecryptable: z.number().int(),
  partitioned: z.number().int(),
};

export const hostContract = defineContract({
  browsers: {
    input: z.object({}).strict(),
    output: z.object({
      supported: z.boolean(),
      defaultBrowserId: id.nullable(),
      browsers: z.array(browserInfo),
    }).strict(),
  },
  inspect: {
    input: source,
    output: z.union([z.object({ ok: z.literal(true), changed: z.boolean(), ...readCounts }).strict(), failure]),
  },
  apply: {
    input: source.extend({ wsEndpoint: z.string().min(1).max(4096), mode: z.enum(["changes", "full"]), mirrorHosts: mirrorHosts.optional() }).strict(),
    output: z.union([
      z.object({
        ok: z.literal(true), set: z.number().int(), removed: z.number().int(), rejected: z.number().int(),
        /** The sites whose cookies this sync wrote or removed, without a leading dot, at most MAX_CHANGED_HOSTS. */
        hosts: z.array(z.string().max(255)).max(100),
        ...readCounts,
      }).strict(),
      failure,
    ]),
  },
  watch: {
    input: source,
    output: z.union([z.object({ ok: z.literal(true), profile }).strict(), failure]),
  },
  openUrl: {
    input: z.object({ url, browserId: id, profile: profile.optional() }).strict(),
    output: z.union([z.object({ ok: z.literal(true) }).strict(), failure]),
  },
});

export const MAX_CHANGED_HOSTS = 100;

export const hostSignals = {
  changed: { payload: z.object({ browserId: id, profile }).strict() },
} satisfies ExperimentalHostSignals;

export type HostContract = typeof hostContract;
