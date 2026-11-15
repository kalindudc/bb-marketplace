// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useCardShown, useCardShownRef } from "../../../src/ui/thread/card-shown";

afterEach(cleanup);

function Card({ threadId, hidden = false }: { threadId: string; hidden?: boolean }) {
  const ref = useCardShownRef(threadId);
  return <div data-thread-context-card="" hidden={hidden}><div ref={ref} /></div>;
}
const Shown = ({ threadId }: { threadId: string }) => <output data-testid="shown">{String(useCardShown(threadId))}</output>;
const flush = () => act(async () => {});

describe("the journal's card probe", () => {
  it("follows the card's hidden attribute", async () => {
    function Scene() { const [hidden, setHidden] = useState(false); return <><button onClick={() => setHidden(h => !h)}>toggle</button><Card threadId="a" hidden={hidden} /><Shown threadId="a" /></>; }
    const r = render(<Scene />);
    await flush();
    expect(r.getByTestId("shown").textContent).toBe("true");
    fireEvent.click(r.getByRole("button"));
    await waitFor(() => expect(r.getByTestId("shown").textContent).toBe("false"));
  });
  it("reads as not shown when the section unmounts", async () => {
    function Scene() { const [mounted, setMounted] = useState(true); return <><button onClick={() => setMounted(m => !m)}>toggle</button>{mounted ? <Card threadId="b" /> : null}<Shown threadId="b" /></>; }
    const r = render(<Scene />);
    await flush();
    expect(r.getByTestId("shown").textContent).toBe("true");
    fireEvent.click(r.getByRole("button"));
    await waitFor(() => expect(r.getByTestId("shown").textContent).toBe("false"));
  });
  it("reads as not shown when no card container is found", async () => {
    function Bare() { const ref = useCardShownRef("c"); return <div ref={ref} />; }
    const r = render(<><Bare /><Shown threadId="c" /></>);
    await flush();
    expect(r.getByTestId("shown").textContent).toBe("false");
  });
  it("keeps threads apart", async () => {
    const r = render(<><Card threadId="d" /><Shown threadId="e" /></>);
    await flush();
    expect(r.getByTestId("shown").textContent).toBe("false");
  });
});
