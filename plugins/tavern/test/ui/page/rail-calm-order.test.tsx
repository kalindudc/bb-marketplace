// @vitest-environment jsdom
import { render, act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Rail } from "../../../src/ui/page/rail";
let width=1200;
const observers: (()=>void)[]=[];
beforeEach(()=>{
  vi.stubGlobal("ResizeObserver",class {constructor(cb:()=>void){observers.push(cb);}observe(){}disconnect(){}});
  vi.spyOn(HTMLElement.prototype,"clientWidth","get").mockImplementation(function(this:HTMLElement){return this.classList.contains("tv-page")?width:0;});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();observers.length=0;width=1200;});
function mount(calm:boolean) {
  return render(<div className="tv-page"><Rail calm={calm} attention={<button>Calm</button>} board={<button>Board</button>} lists={<button>Lists</button>} events={<button>History</button>} cellar={<button>Cellar</button>}/></div>);
}
it("swaps history and side lists in wide calm JSX, including keyboard order",()=>{
  const view=mount(true);
  expect([...view.container.querySelectorAll(".rm-a-rail button")].map(n=>n.textContent)).toEqual(["Calm","History","Lists"]);
  width=390;act(()=>{for(const cb of observers)cb();});
  expect([...view.container.querySelectorAll(".rm-a-rail button")].map(n=>n.textContent)).toEqual(["Calm","Lists","History"]);
});
it("does not swap populated attention",()=>{
  const view=mount(false);
  expect([...view.container.querySelectorAll(".rm-a-rail button")].map(n=>n.textContent)).toEqual(["Calm","Lists","History"]);
});
