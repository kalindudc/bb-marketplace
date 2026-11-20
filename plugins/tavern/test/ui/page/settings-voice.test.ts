import { describe, expect, it } from "vitest";
import { registrySchema } from "../../../src/shared/contract";
import { settingLabel } from "../../../src/ui/page/settings-label";

describe("the settings page", () => {
  it("labels the voice setting as Speech bubbles without changing the registry field", () => {
    expect(registrySchema.shape.voice).toBeDefined();
    expect(settingLabel("tavern.voice")).toBe("Speech bubbles");
  });
});
