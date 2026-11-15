// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Clamp } from "../../../src/ui/kit/primitives";

afterEach(cleanup);

describe("Clamp", () => {
  it.each([1, 2, 3] as const)("clamps to %i lines, with a rule in the kit's CSS", lines => {
    const { container } = render(<Clamp text="The audience check is off the staging test." lines={lines} />);
    expect(container.querySelector(".lg-clamp")!.classList.contains(`l${lines}`)).toBe(true);
    const css = readFileSync("src/ui/kit/components.css", "utf8");
    expect(css).toContain(`.tavern .lg-clamp.l${lines} .ct { -webkit-line-clamp: ${lines}; }`);
  });
});
