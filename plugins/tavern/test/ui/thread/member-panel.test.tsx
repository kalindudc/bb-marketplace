// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { ThreadWidget } from "../../../src/ui/thread/composer";
import { clearThreadState } from "../../../src/ui/thread/state";
import { fixtureDecor, fixtureQuest, fixtureRegistry } from "../../../src/ui/thread/fixtures";
import { threadDecorSchema, type ThreadDecor } from "../../../src/shared/contract";
import { motion } from "../../../src/ui/kit/motion";
import { glowVars } from "../../../src/ui/kit/primitives";
import { HUE_CSS } from "../../../src/shared/heraldry";
import { installAnimations, flush } from "../kit/motion-fakes";

export const longMemberBrief = { outcome: "Verify the parser without changing its public API. This second sentence belongs only in the full outcome.\n\n1. Read the existing checks.\n2. Run the independent trial.\n\n- Keep the fixture small.\n- Retain the failure evidence.", mode: "make-it-work" as const, doneWhen: "The independent tests pass. Keep their complete output in the report.", outOfScope: "No production deploy.", context: [...Array.from({ length: 6 }, (_, i) => `Hire-time note ${i + 1}: Read the parser and its tests.`), `Follow-up v2: Check the negative case. ${"Keep this context available. ".repeat(45)}`, `Follow-up v3: Compare the failure output. ${"Read the whole follow-up before changing the check. ".repeat(45)}`], questions: [], timeboxMinutes: 15 };
const registry = { ...fixtureRegistry, classes: [{ ...fixtureRegistry.classes[0]!, id: "warden", label: "Warden", plain: "checker", description: "Checks the work independently." }] };
export const memberPanelDecor = threadDecorSchema.parse({ ...fixtureDecor, member: { ...fixtureDecor.member!, classId: "warden", role: "member", displayName: "Vex III", boardQuestId: "vault", checkerWaypointId: "w1", guardPosture: { providerId: "codex", mode: "pre-exec", label: "Scope guard", approvalAskId: null } }, boardQuest: fixtureQuest, keeperView: null, brief: JSON.stringify(longMemberBrief), briefFields: longMemberBrief, scope: { threadId: "keeper-1", scope: null, armed: false, error: null, pendingAskId: null } });
let fx: ReturnType<typeof installAnimations>;
beforeEach(() => { clearThreadState(); motion.reset(); motion.activate(); fx = installAnimations({}); });
afterEach(() => { cleanup(); fx.uninstall(); motion.reset(); clearThreadState(); document.documentElement.removeAttribute("data-motion"); });
async function panel(decor: ThreadDecor = memberPanelDecor) {
  const slot = renderSlot({ component: ThreadWidget }, { threadId: decor.threadId }, { rpc: { decor: () => decor, registry: () => registry } });
  const trigger = await slot.findByRole("button", { name: /Member(?:,.*)?: show/ });
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  return slot;
}
it("shows the rest duration and keep reason in the Member panel", async () => {
  const restNote = "resting 40 min; machine held; work settled. kept until 13:00: expect a follow-up.";
  const slot = await panel({ ...memberPanelDecor, member: { ...memberPanelDecor.member!, restNote } });
  expect(slot.getByText(restNote)).toBeTruthy();
});
it("draws identity chips, a glance card and collapsed counted sections", async () => {
  const slot = await panel();
  expect(slot.container.querySelector('[data-part="MemberIdentity"].chips')).not.toBeNull();
  const glance = slot.getByRole("region", { name: "At a glance" });
  expect(glance.textContent).toContain("Verify the parser without changing its public API.");
  expect(glance.textContent).not.toContain("This second sentence");
  expect(glance.textContent).toContain("6 context notes · 2 follow-ups · time box 15 min");
  fireEvent.click(within(glance).getByRole("button", { name: "Open the quest page at waypoint 1" }));
  expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel" });
  for (const label of ["Outcome", "Done when", "Out of scope", "Context", "Follow-ups", "Scope and guardrails"]) expect(slot.getByRole("button", { name: new RegExp(`^${label}`) }).getAttribute("aria-expanded")).toBe("false");
  expect(slot.getByText("Compare the failure output.")).toBeTruthy();
  expect(slot.queryByText("Check the negative case.")).toBeNull();
});
it.each(["member","keeper","plain"] as const)("gives the %s row its static glow seed and identity edge", async kind => {
  const decor = kind === "member" ? memberPanelDecor : kind === "keeper" ? {...fixtureDecor,boardQuest:null} : {...memberPanelDecor,member:null,brief:null,classNotice:{message:"Started as a plain thread.",settings:true,switchExecution:null}};
  const slot = renderSlot({component:ThreadWidget},{threadId:decor.threadId},{rpc:{decor:()=>decor,registry:()=>kind === "member" ? registry : fixtureRegistry}});
  await slot.findByText(kind === "plain" ? "Started as a plain thread." : kind === "keeper" ? "Wren" : "Vex III");
  const root = slot.container.querySelector<HTMLElement>(".twidget")!;
  expect(root.classList.contains("glow")).toBe(kind !== "plain");
  if (kind !== "plain") {
    const expected = glowVars(kind === "member" ? "quest:vault" : `keeper:${decor.threadId}`);
    for (const [key,value] of Object.entries(expected)) expect(root.style.getPropertyValue(key)).toBe(value);
    const character = fixtureRegistry.characters.find(c => c.id === decor.member!.characterId)!;
    expect(root.style.getPropertyValue("--widget-edge")).toBe(HUE_CSS[character.hue]);
  } else expect(root.style.getPropertyValue("--glow-x")).toBe("");
});
it("separates glance labels and values with a definition list", async () => {
  const slot = await panel();
  const dl = slot.container.querySelector(".tw-glance dl");
  expect(dl).not.toBeNull();
  expect([...dl!.querySelectorAll("dt")].map(e => e.textContent)).toEqual(["Outcome", "Done when"]);
  expect([...dl!.querySelectorAll("dt")].every(e => e.classList.contains("lbl"))).toBe(true);
  expect(dl!.querySelectorAll("dd")).toHaveLength(2);
});
it("gives fold titles the same small label treatment", async () => {
  const slot = await panel();
  for (const label of ["Outcome", "Done when", "Context", "Follow-ups"]) expect(slot.getByRole("button", {name:new RegExp(`^${label}`)}).querySelector(".lbl")).not.toBeNull();
});
it("keeps the widget wash subtle and restores shared row line boxes", () => {
 const css=readFileSync("src/ui/kit/components.css","utf8");
 expect(css).toContain("var(--tavern-glow) 50%");
 expect(css).toMatch(/\.tw-row \.who-t[^}]*padding-top: 0/);
 expect(css).toMatch(/\.tw-row :is\([^}]*text-box: normal/);
});
it("restores visible numbered and bulleted markers inside brief prose", () => {
 const css=readFileSync("src/ui/thread/member-brief.css","utf8");
 expect(css).toMatch(/\.tw-prose ol > li[^}]*list-style: decimal/);
 expect(css).toMatch(/\.tw-prose ul > li[^}]*list-style: disc/);
});
it.each(["1. ", "1) ", "- ", "* ", "• ", ""])("skips a leading %s marker and short punctuation in summaries", async marker => {
 const sentence="Dr. Vale verifies the independent parser check.";
 const slot=await panel({...memberPanelDecor,briefFields:{...longMemberBrief,outcome:`${marker}${sentence} A second sentence stays in the fold.`}});
 expect(slot.container.querySelector('[data-summary="outcome"]')!.textContent).toBe(sentence);
});
it("uses kit surfaces and keeps the counts rule outside its capped text", async () => {
 const slot=await panel();
 expect(slot.container.querySelector(".tw-glance-counts > span")).not.toBeNull();
 const css=readFileSync("src/ui/thread/member-brief.css","utf8");
 expect(css).toMatch(/\.tw-glance \{[^}]*border: 1px solid var\(--tavern-line\)[^}]*background: var\(--tavern-raised\)/);
 expect(css).toMatch(/\.tw-glance \.tw-glance-counts \{[^}]*var\(--tavern-line\)[^}]*max-width: none/);
 expect(css).toMatch(/\.tw-glance-counts > span[^}]*max-width: 72ch/);
 expect(css).toMatch(/\.tw-member-fold \{[^}]*var\(--tavern-line\)/);
});
it("names the waypoint action and avoids generic chip names and fold landmarks", async () => {
 const slot=await panel();
 expect(slot.getByRole("button",{name:"Open the quest page at waypoint 1"})).toBeTruthy();
 expect(slot.container.querySelector(".mi-chip[aria-label]:not(button)")).toBeNull();
 expect(slot.container.querySelector(".tw-fold-body[role]")).toBeNull();
});
it("cuts a long first sentence at a whole word, with an ellipsis", async () => {
  const text = `${"Read the independent parser check ".repeat(12)}. Do not show this sentence.`;
  const slot = await panel({ ...memberPanelDecor, briefFields: { ...longMemberBrief, outcome: text } });
  const summary = slot.container.querySelector('[data-summary="outcome"]')!.textContent!;
  expect(summary.length).toBeLessThanOrEqual(160);
  expect(summary.endsWith("…")).toBe(true);
  expect(text.startsWith(summary.slice(0, -1))).toBe(true);
  expect(text[summary.length - 1]).toBe(" ");
});
it("remembers folds per member and renders full numbered and bulleted prose", async () => {
  let slot = await panel();
  fireEvent.click(slot.getByRole("button", { name: /^Outcome/ }));
  const outcome = slot.container.querySelector(`#${slot.getByRole("button", { name: /^Outcome/ }).getAttribute("aria-controls")}`)! as HTMLElement;
  expect(within(outcome).getAllByRole("list").map(l => l.tagName)).toEqual(["OL", "UL"]);
  fireEvent.click(slot.getByRole("button", { name: /^Context/ }));
  slot.lifecycle.unmount();
  slot = await panel();
  expect(slot.getByRole("button", { name: /^Outcome/ }).getAttribute("aria-expanded")).toBe("true");
  expect(slot.getByRole("button", { name: /^Context/ }).getAttribute("aria-expanded")).toBe("true");
  slot.lifecycle.unmount();
  slot = await panel({ ...memberPanelDecor, threadId: "another", member: { ...memberPanelDecor.member!, threadId: "another" } });
  expect(slot.getByRole("button", { name: /^Outcome/ }).getAttribute("aria-expanded")).toBe("false");
});
it("shows follow-ups newest first, with a still new mark only after a later visit", async () => {
  let slot = await panel({ ...memberPanelDecor, briefFields: { ...longMemberBrief, context: longMemberBrief.context.slice(0, 7) } });
  expect(slot.queryByText("new", { exact: true })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: /Member: show/ }));
  slot.lifecycle.unmount();
  slot = await panel();
  expect(slot.getByText("new", { exact: true })).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: /^Follow-ups/ }));
  expect([...slot.container.querySelectorAll("[data-follow-up]")].map(e => e.getAttribute("data-follow-up"))).toEqual(["3", "2"]);
});
it.each(["ended", "done", "released", "archived", "deleted", "failed"] as const)("uses historical guard words for an %s member", async kind => {
  const decor = { ...memberPanelDecor, member: { ...memberPanelDecor.member!, state: kind === "done" ? "done" as const : kind === "ended" ? "idle" as const : kind === "failed" ? "failed" as const : "stopped" as const }, boardQuest: { ...fixtureQuest, phase: kind === "ended" ? "done" as const : "build" as const } };
  const slot = await panel(decor);
  expect(slot.getByText("enforced during the run")).toBeTruthy();
  expect(slot.container.querySelector(".tw-member-id")?.getAttribute("title")).not.toContain("not armed yet");
  fireEvent.click(slot.getByRole("button", { name: /^Scope and guardrails/ }));
  expect(slot.container.querySelector(".tw-brief")!.textContent).not.toContain("not armed yet");
});
it("animates only the fold box once on an explicit open and close", async () => {
  const slot = await panel();
  expect(fx.all).toHaveLength(0);
  const fold = slot.getByRole("button", {name:/^Outcome/});
  fireEvent.click(fold);
  expect(motion.snapshot().running.some(c => c.kind === "member fold")).toBe(true);
  expect(fx.all).toHaveLength(1);
  expect(fx.all[0]!.target.classList.contains("tw-fold-body")).toBe(true);
  expect(fx.all[0]!.duration).toBeLessThanOrEqual(180);
  expect(fx.all[0]!.keyframes.every(k => !k.transform)).toBe(true);
  await act(async () => { fx.tick(180); await flush(); });
  fireEvent.click(fold);
  expect(fx.all).toHaveLength(2);
  await act(async () => { fx.tick(180); await flush(); });
  expect(motion.snapshot().running).toHaveLength(0);
});
it.each(["off","reduced","typing","hidden","alert","pending"] as const)("keeps folds usable without motion while %s", async state => {
  let decor = memberPanelDecor;
  if (state === "off") decor = {...decor, ambientMotion:"off"};
  if (state === "alert") decor = {...decor, scope:{...decor.scope!,error:"Scope refused"}};
  if (state === "pending") decor = {...decor, scope:{...decor.scope!,pendingAskId:"wider"}};
  if (state === "reduced") await act(async () => { document.documentElement.dataset.motion = "reduced"; await flush(); });
  if (state === "hidden") motion.setPaused(true);
  const slot = await panel(decor);
  const input = document.createElement("textarea"); document.body.append(input);
  if (state === "typing") fireEvent.keyDown(input, {key:"a"});
  fireEvent.click(slot.getByRole("button", {name:/^Outcome/}));
  expect(slot.getByRole("button", {name:/^Outcome/}).getAttribute("aria-expanded")).toBe("true");
  expect(fx.all).toHaveLength(0);
  input.remove();
});
it("restores an open fold without replaying its cue on mount", async () => {
  let slot = await panel();
  fireEvent.click(slot.getByRole("button", {name:/^Outcome/}));
  expect(fx.all).toHaveLength(1);
  await act(async () => {fx.tick(180);await flush();});
  slot.lifecycle.unmount(); slot = await panel();
  expect(slot.getByRole("button", {name:/^Outcome/}).getAttribute("aria-expanded")).toBe("true");
  expect(fx.all).toHaveLength(1);
});
it("underlines a newly seen follow-up once, leaving the new word after the stroke", async () => {
  let slot = await panel({...memberPanelDecor,briefFields:{...longMemberBrief,context:longMemberBrief.context.slice(0,7)}});
  expect(fx.all).toHaveLength(0);
  fireEvent.click(slot.getByRole("button", {name:/Member: show/})); slot.lifecycle.unmount();
  slot = await panel();
  expect(motion.snapshot().running.some(c => c.kind === "member follow-up")).toBe(true);
  expect(fx.all).toHaveLength(1);
  expect(fx.all[0]!.target.tagName.toLowerCase()).toBe("path");
  await act(async () => {fx.tick(180);await flush();});
  expect(slot.getByText("new", {exact:true})).toBeTruthy();
  expect(slot.container.querySelector(".tw-follow-up-chalk")).toBeNull();
  slot.lifecycle.unmount(); slot = await panel();
  expect(slot.getByText("new", {exact:true})).toBeTruthy();
  expect(fx.all).toHaveLength(1);
});
it("keeps the new word with Motion Off and never replays its stroke later", async () => {
  let slot = await panel({...memberPanelDecor,briefFields:{...longMemberBrief,context:longMemberBrief.context.slice(0,7)}});
  fireEvent.click(slot.getByRole("button", {name:/Member: show/})); slot.lifecycle.unmount();
  slot = await panel({...memberPanelDecor,ambientMotion:"off"});
  expect(slot.getByText("new", {exact:true})).toBeTruthy(); expect(fx.all).toHaveLength(0);
  slot.lifecycle.unmount(); slot = await panel();
  expect(slot.getByText("new", {exact:true})).toBeTruthy(); expect(fx.all).toHaveLength(0);
});
it("keeps an actionable alert chip visible and opens the scope fold without motion", async () => {
  const slot = await panel({ ...memberPanelDecor, scope: { ...memberPanelDecor.scope!, error: "The scope was refused." } });
  fireEvent.click(slot.getByRole("button", { name: /1 scope alert.*Open scope details/ }));
  expect(slot.getByRole("button", { name: /^Scope and guardrails/ }).getAttribute("aria-expanded")).toBe("true");
  expect(slot.getByRole("alert").textContent).toContain("scope was refused");
  expect(fx.all).toHaveLength(0);
});
