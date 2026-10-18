import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NameEditor } from "../src/name-editor";

afterEach(cleanup);
const field = () => screen.getByRole("textbox", { name: "Section name" }) as HTMLInputElement;
const settle = () => act(async () => { await Promise.resolve(); });

describe("section name editor", () => {
  it("starts empty with a placeholder, or with the old name selected", async () => {
    const first = render(<NameEditor placeholder="Section name" action="create" onSubmit={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => expect(document.activeElement).toBe(field()));
    expect(field().value).toBe("");
    expect(field().placeholder).toBe("Section name");
    expect(screen.getByText("↵ create")).toBeTruthy();
    first.unmount();
    render(<NameEditor initial="Review" action="save" onSubmit={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => expect(document.activeElement).toBe(field()));
    expect([field().selectionStart, field().selectionEnd]).toEqual([0, 6]);
  });

  it("submits the trimmed name once and stays read-only while saving", async () => {
    const submit = vi.fn(() => new Promise<void>(() => undefined));
    render(<NameEditor action="create" onSubmit={submit} onCancel={vi.fn()} />);
    fireEvent.change(field(), { target: { value: "  Infra  " } });
    fireEvent.keyDown(field(), { key: "Enter" });
    fireEvent.keyDown(field(), { key: "Enter" });
    fireEvent.blur(field());
    expect(submit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith("Infra");
    expect(field().readOnly).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Creating…");
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(field()).toBeTruthy();
  });

  it("cancels on Escape, on an empty name and on an unchanged name", () => {
    const submit = vi.fn(async () => undefined), cancel = vi.fn();
    const first = render(<NameEditor action="create" onSubmit={submit} onCancel={cancel} />);
    fireEvent.keyDown(field(), { key: "Escape" });
    fireEvent.blur(field());
    expect(cancel).toHaveBeenCalledOnce();
    first.unmount();
    const second = render(<NameEditor action="create" onSubmit={submit} onCancel={cancel} />);
    fireEvent.change(field(), { target: { value: "   " } });
    fireEvent.keyDown(field(), { key: "Enter" });
    second.unmount();
    render(<NameEditor initial="Review" action="save" onSubmit={submit} onCancel={cancel} />);
    fireEvent.blur(field());
    expect(cancel).toHaveBeenCalledTimes(3);
    expect(submit).not.toHaveBeenCalled();
  });

  it("ignores Enter while an input method is composing", () => {
    const submit = vi.fn(async () => undefined);
    render(<NameEditor action="create" onSubmit={submit} onCancel={vi.fn()} />);
    fireEvent.change(field(), { target: { value: "日本" } });
    fireEvent.compositionStart(field());
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(submit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(field());
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(submit).toHaveBeenCalledWith("日本");
  });

  it("shows a failure under the field, retries after an edit, and gives up when left unedited", async () => {
    const submit = vi.fn(async (name: string) => { if (name === "Taken") throw new Error("Section name already exists"); });
    const cancel = vi.fn();
    render(<NameEditor action="create" onSubmit={submit} onCancel={cancel} />);
    fireEvent.change(field(), { target: { value: "Taken" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await settle();
    expect(screen.getByRole("alert").textContent).toBe("Section name already exists");
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(field().readOnly).toBe(false);
    fireEvent.change(field(), { target: { value: "Free" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.keyDown(field(), { key: "Enter" });
    await settle();
    expect(submit).toHaveBeenLastCalledWith("Free");
    cleanup();
    render(<NameEditor action="create" onSubmit={submit} onCancel={cancel} />);
    fireEvent.change(field(), { target: { value: "Taken" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await settle();
    fireEvent.blur(field());
    expect(cancel).toHaveBeenCalledOnce();
  });
});
