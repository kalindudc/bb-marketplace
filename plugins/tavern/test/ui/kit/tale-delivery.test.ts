import { expect, it } from "vitest";
import { taleDeliveryBlocks } from "../../../src/ui/kit/tale-delivery";
it("preserves other fences including directive-like text inside code", () => {
  const code = "\x60\x60\x60sh\n::other{source=\"x\"}\necho ok\n\x60\x60\x60";
  expect(taleDeliveryBlocks(code, "q")).toEqual([{ kind: "markdown", source: code + "\n" }]);
});
it("recognizes tilde visual fences and strips only the quest's own leaf line", () => {
  const blocks = taleDeliveryBlocks('~~~app\nwidget\n~~~\n::tavern-tale{quest="other"}\n::tavern-tale{quest="q"}', "q");
  expect(blocks).toEqual([{ kind: "visual", source: "~~~app\nwidget\n~~~" }, { kind: "visual", source: '::tavern-tale{quest="other"}' }]);
});
it("keeps longer fence closures and unclosed visual source without evaluation", () => {
  expect(taleDeliveryBlocks("\x60\x60\x60\x60ui\nLoad('/tmp/results')\n\x60\x60\x60\nmore", "q")).toEqual([{ kind: "visual", source: "\x60\x60\x60\x60ui\nLoad('/tmp/results')\n\x60\x60\x60\nmore" }]);
});
