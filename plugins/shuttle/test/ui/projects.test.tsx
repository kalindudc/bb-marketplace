import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, waitFor, screen } from "@testing-library/react";
import { ReviewDialog } from "../../src/ui/review-dialog";
import { ProjectSelect } from "../../src/ui/link-dialog";
import { callsTo, config, handlers, mount, page, pr, unmountAll, type Handlers } from "./helpers";

afterEach(unmountAll);

describe("review projects", () => {
  it("refreshes BB projects beside the picker and keeps the note and explicit project choice", async () => {
    let projects = { projects: [{ id: "prj_bb", name: "bb" }], suggested: "prj_bb" };
    const slot = mount(ReviewDialog, { pr: pr(), presets: config().presets, onClose() {} }, handlers({
      projects: () => projects,
      refreshProjects: () => {
        projects = { projects: [...projects.projects, { id: "proj_new", name: "New repository" }], suggested: "proj_new" };
        return { count: 2, fetchedAt: Date.now() };
      },
    }));
    const picker = slot.getByRole("combobox", { name: "Project" }) as HTMLSelectElement;
    await waitFor(() => expect(picker.value).toBe("prj_bb"));
    fireEvent.change(picker, { target: { value: "prj_bb" } });
    const note = slot.getByRole("textbox", { name: "Note for the reviewer" }) as HTMLTextAreaElement;
    fireEvent.change(note, { target: { value: "Keep this note" } });
    fireEvent.click(slot.getByRole("button", { name: "Refresh projects" }));
    await waitFor(() => expect(callsTo(slot, "refreshProjects")).toEqual([{}]));
    await slot.behavior.experimental_invalidateRpc(["projects"], "shuttle");
    await waitFor(() => expect(picker.options).toHaveLength(3));
    expect(picker.value).toBe("prj_bb");
    expect(note.value).toBe("Keep this note");
    expect(callsTo(slot, "refreshProjects")).toEqual([{}]);
    expect(callsTo(slot, "sync")).toEqual([]);
    expect(callsTo(slot, "review")).toEqual([]);
  });

  it.each(["automatic", "manual"])("requires a new choice when a selected review project disappears after %s refresh", async (mode) => {
    let projects = { projects: [{ id: "chosen", name: "Chosen project" }, { id: "suggested", name: "Suggested project" }], suggested: "suggested" };
    const slot = mount(ReviewDialog, { pr: pr(), presets: config().presets, onClose() {} }, handlers({
      projects: () => projects,
      review: () => ({ threadId: "thr_review", revived: false }),
    }));
    const picker = slot.getByRole("combobox", { name: "Project" }) as HTMLSelectElement;
    await waitFor(() => expect(picker.value).toBe("suggested"));
    fireEvent.change(picker, { target: { value: "chosen" } });
    projects = { projects: [{ id: "suggested", name: "Suggested project" }], suggested: "suggested" };
    if (mode === "manual") {
      fireEvent.click(slot.getByRole("button", { name: "Refresh projects" }));
      await waitFor(() => expect(callsTo(slot, "refreshProjects")).toEqual([{}]));
    }
    await slot.behavior.experimental_invalidateRpc(["projects"], "shuttle");
    expect(await slot.findByText(/Selected project is no longer available/u)).toBeTruthy();
    const start = slot.getByRole("button", { name: "Start review" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(picker.value).toBe("chosen");
    fireEvent.click(start);
    expect(callsTo(slot, "review")).toEqual([]);
    fireEvent.change(picker, { target: { value: "suggested" } });
    fireEvent.click(start);
    await waitFor(() => expect(callsTo(slot, "review")).toMatchObject([{ projectId: "suggested" }]));
  });

  it.each(["automatic", "manual"])("requires a new choice when a new-thread project disappears after %s refresh", async (mode) => {
    const pull = pr();
    let projects = { projects: [{ id: "chosen", name: "Chosen project" }, { id: "suggested", name: "Suggested project" }], suggested: "suggested" };
    const { slot } = await page("pr/github/get-bb/bb/4411", {
      detail: () => ({ pr: pull, events: [], body: null, draft: null, drafts: 0 }),
      projects: () => projects,
      newThread: () => ({ threadId: "thr_new" }),
    });
    fireEvent.keyDown(await slot.findByRole("button", { name: /^More for/u }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Link a thread…" }));
    fireEvent.click(await screen.findByRole("tab", { name: "A new thread" }));
    const picker = await screen.findByRole("combobox", { name: "Project" }) as HTMLSelectElement;
    await waitFor(() => expect(picker.value).toBe("suggested"));
    fireEvent.change(picker, { target: { value: "chosen" } });
    projects = { projects: [{ id: "suggested", name: "Suggested project" }], suggested: "suggested" };
    if (mode === "manual") {
      fireEvent.click(screen.getByRole("button", { name: "Refresh projects" }));
      await waitFor(() => expect(callsTo(slot, "refreshProjects")).toEqual([{}]));
    }
    await slot.behavior.experimental_invalidateRpc(["projects"], "shuttle");
    expect(await screen.findByText(/Selected project is no longer available/u)).toBeTruthy();
    const start = screen.getByRole("button", { name: "Start thread" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.click(start);
    expect(callsTo(slot, "newThread")).toEqual([]);
    fireEvent.change(picker, { target: { value: "suggested" } });
    fireEvent.click(start);
    await waitFor(() => expect(callsTo(slot, "newThread")).toMatchObject([{ projectId: "suggested" }]));
  });

  it("shows loading and failure inline without losing the previous project list", async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, no) => { reject = no; });
    const slot = mount(ProjectSelect, { projects: { projects: [{ id: "prj_bb", name: "bb" }], suggested: null }, value: "prj_bb", onChange() {} }, handlers({ refreshProjects: () => pending }));
    fireEvent.click(slot.getByRole("button", { name: "Refresh projects" }));
    await waitFor(() => expect((slot.getByRole("button", { name: "Refreshing projects" }) as HTMLButtonElement).disabled).toBe(true));
    reject(new Error("BB unavailable"));
    expect(await slot.findByText(/Could not refresh projects: BB unavailable/u)).toBeTruthy();
    expect((slot.getByRole("combobox", { name: "Project" }) as HTMLSelectElement).value).toBe("prj_bb");
    expect((slot.getByRole("button", { name: "Refresh projects" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("updates an open project's picker and suggestion when BB projects change", async () => {
    const pull = pr();
    let projects: ReturnType<Handlers["projects"]> = { projects: [], suggested: null };
    const slot = mount(ReviewDialog, { pr: pull, presets: config().presets, onClose() {} }, handlers({
      projects: () => projects,
      review: () => ({ threadId: "thr_review", revived: false }),
    }));
    const picker = slot.getByRole("combobox", { name: "Project" }) as HTMLSelectElement;
    await waitFor(() => expect(picker.disabled).toBe(false));
    expect(picker.options).toHaveLength(1);

    projects = { projects: [{ id: "proj_new", name: "New repository" }], suggested: "proj_new" };
    await slot.behavior.experimental_invalidateRpc(["projects"], "shuttle");
    await waitFor(() => expect(picker.value).toBe("proj_new"));
    expect(picker.options[1]!.textContent).toContain("New repository");
    fireEvent.click(slot.getByRole("button", { name: "Start review" }));
    await waitFor(() => expect(callsTo(slot, "review")).toMatchObject([{ key: pull.key, projectId: "proj_new" }]));
  });
});
