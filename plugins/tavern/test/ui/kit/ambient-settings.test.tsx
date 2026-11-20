// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import { useState } from "react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { PartyPicture } from "../../../src/ui/kit";
import { motion } from "../../../src/ui/kit/motion";
import { ThreadWidget } from "../../../src/ui/thread/composer";
import { fixtureDecor, fixtureRegistry, fixtureMember } from "../../../src/ui/thread/fixtures";
import { clearThreadState } from "../../../src/ui/thread/state";
import { SettingAuthor } from "../../../src/ui/page/settings";
import { installAnimations } from "./motion-fakes";
let animations: ReturnType<typeof installAnimations>;
beforeEach(() => { motion.reset(); animations=installAnimations(); });

afterEach(() => { cleanup(); animations.uninstall(); vi.useRealTimers(); vi.restoreAllMocks(); motion.reset(); clearThreadState(); });
it("road repeats survive unrelated rerenders, stop at rest, and dispose on unmount", () => {
  vi.useFakeTimers({toFake:["setInterval","clearInterval"]});
  const spy = vi.spyOn(motion,"cue");
  let update!: (state: typeof fixtureMember.state | "done") => void;
  let redraw!: () => void;
  const slot=renderSlot({component:()=>{
    const [state,setState]=useState<typeof fixtureMember.state | "done">("working"); update=setState;
    const [,setVersion]=useState(0); redraw=()=>setVersion(v=>v+1);
    return <div className="tavern"><PartyPicture members={[{...fixtureMember,state: state === "done" ? "idle" : state, engagement: state === "done" ? "resting" : undefined}]} registry={fixtureRegistry} ambientMotion="lively" repeatSeconds={3} /></div>;
  }},{},{});
  act(()=>vi.advanceTimersByTime(2000));
  act(()=>redraw());
  act(()=>vi.advanceTimersByTime(1000));
  expect(spy.mock.calls.filter(c=>c[2]==="road repeat")).toHaveLength(1);
  act(()=>update("done"));
  const calls=spy.mock.calls.length;
  act(()=>vi.advanceTimersByTime(6000)); expect(spy.mock.calls).toHaveLength(calls);
  expect(vi.getTimerCount()).toBe(0);
  act(()=>update("working")); expect(vi.getTimerCount()).toBe(1);
  slot.lifecycle.unmount(); expect(vi.getTimerCount()).toBe(0);
});
it.each(["calm","off"] as const)("starts no road timer in %s",mode=>{
 vi.useFakeTimers({toFake:["setInterval","clearInterval"]});
 const slot=renderSlot({component:()=> <PartyPicture members={[{...fixtureMember,state:"working"}]} registry={fixtureRegistry} ambientMotion={mode} />},{},{});
 expect(vi.getTimerCount()).toBe(0); slot.lifecycle.unmount();
});
it.each(["lively","calm"] as const)("busy widget repeat follows condition and disposes in %s",async mode=>{
 const spy=vi.spyOn(motion,"cue");
 let busy=true;
 const slot=renderSlot({component:ThreadWidget},{threadId:"keeper-1"},{rpc:{registry:()=>fixtureRegistry,decor:()=>({...fixtureDecor,ambientMotion:mode,repeatSeconds:3,keeperView:{...fixtureDecor.keeperView!,status:busy ? "busy" : "listening",openAsks:[],boardQuests:[]}})}});
 await waitFor(()=>expect(slot.container.querySelector(".tw-dot")).not.toBeNull());
 vi.useFakeTimers({toFake:["setInterval","clearInterval"]});
 await act(async()=>{await slot.experimental_invalidateRpc(["tavern:thread:keeper-1"]);});
 // Remount installs the interval under the fake clock.
 slot.lifecycle.unmount();
 const second=renderSlot({component:ThreadWidget},{threadId:"keeper-1"},{rpc:{registry:()=>fixtureRegistry,decor:()=>({...fixtureDecor,ambientMotion:mode,repeatSeconds:3,keeperView:{...fixtureDecor.keeperView!,status:busy ? "busy" : "listening",openAsks:[],boardQuests:[]}})}});
 await waitFor(()=>expect(second.container.querySelector(".tw-dot")).not.toBeNull());
 act(()=>vi.advanceTimersByTime(3000));
 expect(spy.mock.calls.filter(c=>c[2]==="busy repeat")).toHaveLength(mode==="lively" ? 1 : 0);
 busy=false; await act(async()=>{await second.experimental_invalidateRpc(["tavern:thread:keeper-1"]);});
 await waitFor(()=>expect(second.container.querySelector(".tw-id.st-listening")).not.toBeNull());
 const calls=spy.mock.calls.length; act(()=>vi.advanceTimersByTime(6000)); expect(spy.mock.calls).toHaveLength(calls);
 second.lifecycle.unmount(); expect(vi.getTimerCount()).toBe(0);
});
it("names an agent's thread as a link without exposing its id",async()=>{
 const slot=renderSlot({component:()=> <span>by <SettingAuthor threadId="thr_private" by="user" label="Moss II" /></span>},{},{rpc:{crests:()=>({crests:[{threadId:"thr_private",classId:"keeper",characterId:null,label:"Moss II"}]})}});
 await slot.findByRole("button",{name:"Moss II"});
 expect(slot.container.textContent).toBe("by an agent in Moss II");
 expect(slot.container.textContent).not.toContain("thr_private"); slot.lifecycle.unmount();
});
