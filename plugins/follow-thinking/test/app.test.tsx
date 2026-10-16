import { afterEach, describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import {
  loadPluginApp,
  mountPluginContentScripts,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import { ENABLED_STORAGE_KEY } from "../src/preference";
import { flush, thoughtRow } from "./fake-timeline";

afterEach(() => {
  window.localStorage.clear();
  document.body.replaceChildren();
});

const headerProps = {
  threadId: "thr_1",
  projectId: "proj_1",
  isCompactViewport: false,
};

describe("plugin app", () => {
  it("registers the content script and the thread header toggle", async () => {
    const app = await loadPluginApp(() => import("../app"));

    expect(app.contentScripts.map((script) => script.id)).toEqual([
      "follow-thinking",
    ]);
    expect(app.threadHeaderActions.map((action) => action.id)).toEqual([
      "toggle",
    ]);
  });

  it("expands thinking rows once the content script mounts and stops on dispose", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const first = thoughtRow("row-1");
    document.body.append(first.element);

    const scripts = await mountPluginContentScripts(app, {
      pluginId: "follow-thinking",
    });
    expect(first.isExpanded()).toBe(true);

    await scripts.lifecycle.dispose();
    const second = thoughtRow("row-2");
    document.body.append(second.element);
    await flush();

    expect(scripts.inspection.disposed).toBe(true);
    expect(second.isExpanded()).toBe(false);
  });

  it("shows whether it is on in the thread header and toggles on click", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(app.threadHeaderActions[0]!, headerProps, {
      pluginId: "follow-thinking",
    });
    const button = slot.getByRole("button", { name: "Follow thinking" });

    expect(button.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(button);

    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(window.localStorage.getItem(ENABLED_STORAGE_KEY)).toBe("false");
    slot.lifecycle.unmount();
  });
});
