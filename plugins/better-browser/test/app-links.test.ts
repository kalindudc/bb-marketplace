import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { interceptAppLinks } from "../src/app-links";

const trusted = () => true;
let opened: string[] = [];
let stop: () => void = () => undefined;

function setPlatform(platform: string) {
  Object.defineProperty(window.navigator, "platform", { value: platform, configurable: true });
}

beforeEach(() => {
  opened = [];
  setPlatform("MacIntel");
  document.body.innerHTML = `
    <a id="web" href="https://github.com/kalindudc/bb-marketplace/pull/1"><span id="inner">PR</span></a>
    <a id="thread" href="/projects/p/threads/thr_1">thread</a>
    <a id="app" href="${window.location.origin}/settings">settings</a>
    <a id="mail" href="mailto:a@b.test">mail</a>
    <a id="bare">no href</a>`;
});

afterEach(() => {
  stop();
  document.body.replaceChildren();
});

/** Clicks like bb's own link handlers see it: `reached` is false when the click never got past the window. */
function click(id: string, init: MouseEventInit): { prevented: boolean; reached: boolean } {
  let reached = false;
  const appHandler = (event: Event) => {
    reached = true;
    event.preventDefault();
  };
  document.body.addEventListener("click", appHandler);
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, button: 0, ...init });
  const prevented = !document.getElementById(id)!.dispatchEvent(event) && !reached;
  document.body.removeEventListener("click", appHandler);
  return { prevented, reached };
}

describe("Cmd+click on a link in bb's window", () => {
  it("opens a web link in the real browser instead of letting bb handle it", () => {
    stop = interceptAppLinks(window, { open: (url) => opened.push(url), isTrusted: trusted });
    expect(click("inner", { metaKey: true })).toEqual({ prevented: true, reached: false });
    expect(opened).toEqual(["https://github.com/kalindudc/bb-marketplace/pull/1"]);
  });

  it("leaves plain clicks, Ctrl+click on macOS and other buttons to bb", () => {
    stop = interceptAppLinks(window, { open: (url) => opened.push(url), isTrusted: trusted });
    expect(click("web", {}).reached).toBe(true);
    expect(click("web", { ctrlKey: true }).reached).toBe(true);
    expect(click("web", { metaKey: true, button: 1 }).reached).toBe(true);
    expect(opened).toEqual([]);
  });

  it("leaves links to bb itself, other schemes and anchors without an address to bb", () => {
    stop = interceptAppLinks(window, { open: (url) => opened.push(url), isTrusted: trusted });
    for (const id of ["thread", "app", "mail", "bare"]) expect(click(id, { metaKey: true }).reached).toBe(true);
    expect(opened).toEqual([]);
  });

  it("uses Ctrl+click off macOS", () => {
    setPlatform("Linux x86_64");
    stop = interceptAppLinks(window, { open: (url) => opened.push(url), isTrusted: trusted });
    expect(click("web", { metaKey: true }).reached).toBe(true);
    expect(click("web", { ctrlKey: true }).reached).toBe(false);
    expect(opened).toEqual(["https://github.com/kalindudc/bb-marketplace/pull/1"]);
  });

  it("ignores a click a script dispatched", () => {
    const open = vi.fn();
    stop = interceptAppLinks(window, { open });
    expect(click("web", { metaKey: true }).reached).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("stops intercepting once removed", () => {
    interceptAppLinks(window, { open: (url) => opened.push(url), isTrusted: trusted })();
    expect(click("web", { metaKey: true }).reached).toBe(true);
    expect(opened).toEqual([]);
  });
});
