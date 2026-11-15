// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { Decision } from "../../../src/shared/schema";
import { DecidedForYou } from "../../../src/ui/kit";

afterEach(cleanup);
const long = "Replanned to v2 within the same goal, because the second Vault instance was missed last time";
const why = "Otto's notes show vault-saturn was left out of the first cutover";
const d = (id: string, text: string): Decision => ({ id, keeperThreadId: "k", boardQuestId: null, text, why, source: "keeper", sourceRef: null, reversible: true, undone: false, createdAt: Date.now() - 60_000 }) as Decision;
const css = readFileSync("src/ui/kit/tavern.css", "utf8");

describe("a decision row", () => {
  it("closed: the title gets two lines before it is cut, with all of it and the reason in its tooltip, and the time under it", () => {
    const { container } = render(<DecidedForYou decisions={[d("a", long)]} onUndo={() => {}} />);
    const row = container.querySelector("li.di")!;
    const title = row.querySelector(".dt")!;
    expect(title.getAttribute("title")).toBe(`${long} · ${why}`);
    expect(row.querySelector(".di-meta time")).not.toBeNull();
    expect([...row.children].map(c => c.className.split(" ")[0])).toEqual(["dt", "di-acts", "di-meta"]);
    expect(css).toMatch(/\.tavern \.decided \.di \.dt b\.clamp \{[^}]*-webkit-line-clamp: 2;[^}]*overflow: hidden;/);
    expect(css).not.toMatch(/\.decided \.di \.dt b(\.clamp)? \{[^}]*white-space: nowrap/);
  });

  it("open: the whole title wraps above the reason, and Undo stays", () => {
    const { container, getByRole } = render(<DecidedForYou decisions={[d("a", long)]} onUndo={() => {}} onSeen={async ids => ({ ids, undoToken: null })} />);
    fireEvent.click(getByRole("button", { name: new RegExp(`^${long.slice(0, 20)}`) }));
    const row = container.querySelector("li.di")!;
    expect(row.classList.contains("open")).toBe(true);
    expect(row.querySelector(".dt b")!.textContent).toBe(long);
    expect(row.querySelector(".dt")!.hasAttribute("title")).toBe(false);
    expect(row.querySelector(".dwhy")!.textContent).toBe(why);
    expect(getByRole("button", { name: `Undo: ${long}` })).toBeTruthy();
    expect(getByRole("button", { name: `Mark seen: ${long}` })).toBeTruthy();
    expect(css).toMatch(/\.tavern \.decided \.di\.open \.dt b\.clamp \{ display: block; -webkit-line-clamp: unset; overflow: visible; \}/);
  });

  it("reads at the kit's body size", () => {
    expect(css).toMatch(/\.tavern \.decided \.di \{[^}]*font-size: 13px;/);
    expect(css).toMatch(/\.tavern \.decided \.di \.dwhy \{[^}]*font-size: 13px;/);
  });
});
