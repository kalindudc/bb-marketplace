import type { PROMPT_VARIABLES } from "../../templates";

/** A sample PR for the preset editor's preview, shaped like the server's prompt variables. */
export function sampleReviewVariables(skill: string): Record<(typeof PROMPT_VARIABLES)[number], string> {
  return {
    url: "https://github.com/get-bb/bb/pull/4411",
    key: "github:get-bb/bb#4411",
    server: "GitHub",
    repo: "get-bb/bb",
    number: "4411",
    sep: "#",
    display: "get-bb/bb#4411",
    head: "4be81d0c2a91",
    base: "main",
    title: "Plugin SDK: a compact prop for thread header actions",
    author: "dana",
    skill,
    skill_line: skill === "" ? "" : `Use the \`${skill}\` skill for this review.\n`,
    view_command: "gh pr view 4411 -R get-bb/bb --comments",
    note: "",
  };
}
