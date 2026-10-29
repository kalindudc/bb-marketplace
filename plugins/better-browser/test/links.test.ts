import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LINK_HANDLER_OFF, SIGN_IN_FORM_PROBE, linkHandlerExpression, parseOpenMessage } from "../src/links";

type Win = Window & { __betterBrowserLinksUntil?: number };

let messages: unknown[] = [];
const bb = { postMessage: (data: unknown) => messages.push(data) };
const evaluate = (expression: string): unknown => new Function("bb", `return ${expression}`)(bb);
let firstInstall: unknown;
let secondInstall: unknown;

// jsdom keeps one window for the file, like a page that is never reloaded: install once, then renew.
beforeAll(() => {
  Object.defineProperty(window.navigator, "platform", { value: "MacIntel", configurable: true });
  firstInstall = evaluate(linkHandlerExpression(Date.now() + 5_000));
  secondInstall = evaluate(linkHandlerExpression(Date.now() + 5_000));
});

beforeEach(() => {
  messages = [];
  document.body.innerHTML = `<a id="plain" href="/docs?x=1">docs</a><a id="mail" href="mailto:a@b.test">mail</a><div id="host"></div>`;
});

afterEach(() => {
  (window as Win).__betterBrowserLinksUntil = 0;
});

/** Whether the handler cancelled the click; a click it let through is cancelled afterwards so jsdom does not navigate. */
function click(target: Element, init: MouseEventInit): { defaultPrevented: boolean } {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, button: 0, ...init });
  let seen: boolean | undefined;
  const after = (late: Event) => {
    seen = late.defaultPrevented;
    late.preventDefault();
  };
  document.addEventListener("click", after);
  target.dispatchEvent(event);
  document.removeEventListener("click", after);
  return { defaultPrevented: seen ?? event.defaultPrevented };
}

describe("the Cmd+click handler", () => {
  it("installs once and hands Cmd+click on an http link to the toolbar", () => {
    expect([firstInstall, secondInstall]).toEqual([true, false]);
    evaluate(linkHandlerExpression(Date.now() + 5_000));
    const link = document.getElementById("plain")!;
    expect(click(link, { metaKey: true }).defaultPrevented).toBe(true);
    expect(messages).toEqual([{ type: "better-browser:open", url: new URL("/docs?x=1", document.baseURI).href }]);
  });

  it("leaves plain clicks, Ctrl+click on macOS, other schemes and other buttons alone", () => {
    evaluate(linkHandlerExpression(Date.now() + 5_000));
    expect(click(document.getElementById("plain")!, {}).defaultPrevented).toBe(false);
    expect(click(document.getElementById("plain")!, { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(click(document.getElementById("mail")!, { metaKey: true }).defaultPrevented).toBe(false);
    expect(click(document.getElementById("plain")!, { metaKey: true, button: 1 }).defaultPrevented).toBe(false);
    expect(messages).toEqual([]);
  });

  it("finds a link inside an open shadow root", () => {
    evaluate(linkHandlerExpression(Date.now() + 5_000));
    const root = document.getElementById("host")!.attachShadow({ mode: "open" });
    root.innerHTML = `<a href="https://shadow.test/page"><span id="inner">x</span></a>`;
    click(root.getElementById("inner")!, { metaKey: true });
    expect(messages).toEqual([{ type: "better-browser:open", url: "https://shadow.test/page" }]);
  });

  it("stops intercepting when the toolbar stops renewing it or turns it off", () => {
    evaluate(linkHandlerExpression(Date.now() - 1));
    expect(click(document.getElementById("plain")!, { metaKey: true }).defaultPrevented).toBe(false);
    evaluate(linkHandlerExpression(Date.now() + 5_000));
    evaluate(LINK_HANDLER_OFF);
    expect(click(document.getElementById("plain")!, { metaKey: true }).defaultPrevented).toBe(false);
    expect(messages).toEqual([]);
  });
});

describe("parseOpenMessage", () => {
  it("accepts only this plugin's http(s) messages", () => {
    expect(parseOpenMessage({ type: "better-browser:open", url: "https://a.test/" })).toBe("https://a.test/");
    expect(parseOpenMessage({ type: "better-browser:open", url: "javascript:alert(1)" })).toBeNull();
    expect(parseOpenMessage({ type: "other", url: "https://a.test/" })).toBeNull();
    expect(parseOpenMessage("https://a.test/")).toBeNull();
  });
});

describe("the sign-in form probe", () => {
  it("does not treat an unfinished document as a completed sign-in", () => {
    const ready = vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    try {
      expect(evaluate(SIGN_IN_FORM_PROBE)).toBeNull();
    } finally {
      ready.mockRestore();
    }
  });

  it("is false for a page without a sign-in field", () => {
    expect(evaluate(SIGN_IN_FORM_PROBE)).toBe(false);
  });

  it("ignores a hidden password field", () => {
    document.body.innerHTML = `<input type="password" style="display:none">`;
    expect(evaluate(SIGN_IN_FORM_PROBE)).toBe(false);
  });
});
