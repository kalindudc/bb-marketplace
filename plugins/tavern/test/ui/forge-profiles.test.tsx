import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ForgeProfiles } from "../../src/ui/page/machines-forges";
import { MemberIdentity } from "../../src/ui/kit/member-identity";
import { registry, detail } from "../../src/ui/page/fixtures";
afterEach(cleanup);
it("adds a command forge through the existing form parts", async () => {
  const save = vi.fn(async () => true);
  render(<ForgeProfiles profiles={[]} pending={false} save={save} />);
  fireEvent.click(screen.getByRole("button", { name: "Add forge profile" }));
  fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "command" } });
  fireEvent.change(screen.getByLabelText("Open command"), { target: { value: "forge open" } });
  fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith([{ id: "forge", name: "Forge", enabled: true, kind: "command", open: "forge open" }]));
});
it("shows a draft URL, state, owner and verification on a member card", () => {
  const member = detail.quest.members.find(member => member.classId === "smith")!;
  render(<MemberIdentity member={{ ...member, pullRequests: [{ id: "pr", keeperThreadId: "keeper", boardQuestId: "quest", projectId: "project", memberThreadId: member.threadId, url: "https://forge.example/pr/12", forge: null, head: "work", base: "main", owner: "keeper", memberHead: "a".repeat(40), pushedHead: "b".repeat(40), verifiedCommit: null, state: "draft" }] }} registry={registry} />);
  expect(screen.getByRole("link", { name: "https://forge.example/pr/12" })).toBeTruthy();
  expect(screen.getByText(/draft; owner: keeper; head not verified/)).toBeTruthy();
});
