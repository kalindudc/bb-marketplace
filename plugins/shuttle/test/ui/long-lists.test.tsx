import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { find, mine, next, page, pr, unmountAll } from "./helpers";

afterEach(unmountAll);

const many = Array.from({ length: 130 }, (_, i) => pr({ number: 100 + i, title: i % 20 === 0 ? `Router change ${i}` : `Change ${i}`, next: next({ kind: "not_reviewed", label: "Not reviewed" }) }));

describe("long lists", () => {
  it("draws the first rows of a long list at once, then every row", async () => {
    const { slot } = await page("reviews", { list: ({ area }) => ({ prs: area === "reviews" ? many : [] }) });
    await find(slot.container, "[data-pr]");
    await waitFor(() => expect(slot.container.querySelectorAll("[data-pr]")).toHaveLength(130));
  });

  it("draws every row of a long flat list, and filters them all", async () => {
    const yours = many.map((item) => mine({ ...item, key: item.key.replace("#", "#9"), number: item.number + 9000 }));
    const { slot } = await page("mine", { list: ({ area }) => ({ prs: area === "mine" ? yours : [] }) });
    await find(slot.container, "[data-pr]");
    fireEvent.click(slot.getByRole("radio", { name: "List" }));
    await waitFor(() => expect(slot.container.querySelectorAll("[data-pr]")).toHaveLength(130));
    fireEvent.change(slot.getByRole("searchbox", { name: "Filter your PRs" }), { target: { value: "router" } });
    await waitFor(() => expect(slot.container.querySelectorAll("[data-pr]")).toHaveLength(7));
  });
});
