import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { prSettings } from "../src/repos";
import { dependencyCycle, globsOverlap, numberErrors, parseSpec, proposalErrorsOf, scopeOverlaps, specHash, ticketPatchSchema } from "../src/spec";
import { specToml, type Doc } from "./helpers";

function run(edit?: (doc: Doc) => void) {
  return parseSpec(specToml(edit));
}

// The base spec as it was before project.summary existed, for the hashes computed then.
const beforeSummaries = (doc: Doc) => delete doc.project.summary;

describe("parseSpec", () => {
  it("accepts a valid spec and fills the documented defaults", () => {
    const result = run();
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
    const spec = result.spec!;
    expect(spec.project).toMatchObject({ base: "main", non_goals: [], open_questions: [] });
    expect(spec.merge).toEqual({ strategy: "integration", branch: "loom/csv", remote: "origin", draft: true });
    expect(spec.checks).toEqual({ commands: ["npm test"], after_merge: [], timeout_minutes: 15 });
    expect(spec.scope).toEqual({ protected: [], enforce: "warn" });
    expect(spec.agents).toMatchObject({ max_workers: 2, max_reviewers: 2, ticket_timeout_minutes: 120, triage: true, worker: { permission_mode: "full" }, reviewer: { permission_mode: "full" } });
    expect(spec.review).toEqual({ approvals: 1, max_rounds: 3, rubric: [] });
    expect(spec.budget).toEqual({ max_attempts: 3, max_check_failures: 5 });
    expect(spec.ticket[0]).toMatchObject({ verify: [], depends_on: [], priority: 2 });
  });

  it("accepts a spec that leaves out every optional table", () => {
    const result = run((doc) => {
      delete doc.checks;
      delete doc.agents;
      doc.ticket[0].verify = ["npm test"];
      doc.ticket[1].verify = ["npm test"];
    });
    expect(result.errors).toEqual([]);
    expect(result.spec?.agents.max_workers).toBe(2);
  });

  it("reports a TOML syntax error with its line and column", () => {
    const result = parseSpec('[project]\nslug = = "x"\n');
    expect(result.ok).toBe(false);
    expect(result.spec).toBeNull();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^TOML: invalid value.*line 2, column \d+/);
  });

  it("names the TOML path of every schema error", () => {
    const result = run((doc) => {
      doc.project.slug = "Bad Slug";
      doc.project.key = "csv";
      doc.project.goal = "short";
      delete doc.merge.strategy;
      doc.checks.timeout_minutes = 30;
      doc.ticket[1].acceptance = [];
      doc.ticket[1].scope = [];
    });
    expect(result.ok).toBe(false);
    const text = result.errors.join("\n");
    expect(text).toContain("project.slug:");
    expect(text).toContain("project.key:");
    expect(text).toContain("project.goal:");
    expect(text).toContain("merge.strategy:");
    expect(text).toContain("checks.timeout_minutes:");
    expect(text).toContain("ticket[1].acceptance:");
    expect(text).toContain("ticket[1].scope:");
  });

  it("refuses unknown keys and says how to fix them", () => {
    const result = run((doc) => {
      doc.project.colour = "red";
      doc.ticket[0].estimate = 3;
    });
    expect(result.errors).toContain('project: unknown key "colour". Remove it or correct its spelling; the loom skill lists every key in references/spec.md.');
    expect(result.errors.join("\n")).toContain('ticket[0]: unknown key "estimate".');
  });

  it("refuses a spec with no tickets", () => {
    const result = run((doc) => delete doc.ticket);
    expect(result.errors.join("\n")).toContain("ticket:");
  });

  it("refuses out-of-range numbers and bad enum values", () => {
    const result = run((doc) => {
      doc.agents.max_workers = 9;
      doc.review = { approvals: 4 };
      doc.scope = { enforce: "loud" };
      doc.ticket[0].priority = 4;
      doc.merge.strategy = "squash";
    });
    const text = result.errors.join("\n");
    expect(text).toContain("agents.max_workers:");
    expect(text).toContain("review.approvals:");
    expect(text).toContain("scope.enforce:");
    expect(text).toContain("ticket[0].priority:");
    expect(text).toContain("merge.strategy:");
  });

  it("refuses refs and git names that could be unsafe", () => {
    const result = run((doc) => {
      doc.project.base = "main; rm -rf /";
      doc.merge.remote = "or igin";
      doc.ticket[0].ref = "Bad_Ref";
    });
    const text = result.errors.join("\n");
    expect(text).toContain("project.base:");
    expect(text).toContain("merge.remote:");
    expect(text).toContain("ticket[0].ref:");
  });

  it("accepts git names that git check-ref-format accepts", () => {
    for (const name of ["_release", "release/v1.2", "feature_x", "main", "user/feature-1", "v1.2.3", "a@b", "a./b", "ünï"]) {
      const result = run((doc) => {
        doc.project.base = name;
        doc.merge = { strategy: "integration", branch: name, remote: name };
      });
      expect(result.errors, name).toEqual([]);
      expect(result.spec?.project.base).toBe(name);
    }
  });

  it("refuses git names that git check-ref-format refuses", () => {
    const bad = ["", "-x", ".hidden", "a/.hidden", "trailing/", "/leading", "dot.", "x.lock", "a/x.lock/b", "a..b", "a//b", "a@{b", "@", "a b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "a\tb", "a\u0000b", "a\u007fb"];
    for (const name of bad) {
      const result = run((doc) => {
        doc.project.base = name;
        doc.merge = { strategy: "integration", branch: name, remote: name };
      });
      const text = result.errors.join("\n");
      expect(text, JSON.stringify(name)).toContain("project.base:");
      expect(text, JSON.stringify(name)).toContain("merge.branch:");
      expect(text, JSON.stringify(name)).toContain("merge.remote:");
    }
  });

  it("refuses a name longer than 200 characters", () => {
    expect(run((doc) => (doc.project.base = "a".repeat(201))).errors.join("\n")).toContain("project.base:");
    expect(run((doc) => (doc.project.base = "a".repeat(200))).errors).toEqual([]);
  });

  it("accepts a deadline as a TOML date or a string and refuses anything else", () => {
    expect(parseSpec(specToml().replace("[checks]", "[budget]\ndeadline = 2099-12-31\n\n[checks]")).spec?.budget.deadline).toBe("2099-12-31");
    expect(run((doc) => (doc.budget = { deadline: "2099-12-31" })).spec?.budget.deadline).toBe("2099-12-31");
    expect(run((doc) => (doc.budget = { deadline: "2099-02-30" })).errors.join("\n")).toContain("budget.deadline:");
    expect(run((doc) => (doc.budget = { deadline: "soon" })).errors.join("\n")).toContain("budget.deadline:");
  });

  it("gives the pr strategy no integration branch", () => {
    const result = run((doc) => (doc.merge = { strategy: "pr" }));
    expect(result.errors).toEqual([]);
    expect(result.spec?.merge).toEqual({ strategy: "pr", remote: "origin", draft: true });
    expect(run((doc) => (doc.merge = { strategy: "integration", branch: "release/csv" })).spec?.merge.branch).toBe("release/csv");
  });
});

describe("semantic errors", () => {
  it("refuses an unknown depends_on ref and lists the valid ones", () => {
    const result = run((doc) => (doc.ticket[1].depends_on = ["csv-ui"]));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['ticket[1].depends_on: "csv-ui" is not a ticket ref. Use one of: csv-model.']);
  });

  it("refuses a dependency cycle and shows one cycle path", () => {
    const result = run((doc) => {
      doc.ticket[0].depends_on = ["csv-export"];
      doc.ticket.push({ ref: "csv-ui", title: "UI", body: "b", acceptance: ["a"], scope: ["src/ui/**"], depends_on: ["csv-export"] });
    });
    expect(result.errors).toEqual(["ticket[0].depends_on: dependency cycle csv-model -> csv-export -> csv-model. Remove one depends_on entry to break the cycle."]);
  });

  it("refuses a ticket that depends on itself", () => {
    const result = run((doc) => (doc.ticket[0].depends_on = ["csv-model"]));
    expect(result.errors.join("\n")).toContain("dependency cycle csv-model -> csv-model");
  });

  it("refuses a duplicate ref", () => {
    const result = run((doc) => (doc.ticket[1].ref = "csv-model"));
    expect(result.errors).toContain('ticket[1].ref: "csv-model" is also the ref of ticket[0]. Give every ticket a unique ref.');
  });

  it("refuses open questions", () => {
    const result = run((doc) => (doc.project.open_questions = ["Which columns?", "Which delimiter?"]));
    expect(result.errors).toEqual(["project.open_questions: 2 open questions remain. Ask the human, write the answers into the spec, and leave this list empty."]);
  });

  it("refuses a NEEDS CLARIFICATION marker anywhere in the text", () => {
    const comment = parseSpec(`${specToml()}\n# [NEEDS CLARIFICATION: delimiter?]\n`);
    expect(comment.errors).toEqual(['spec: the text contains a "[NEEDS CLARIFICATION" marker. Settle it with the human and remove the marker before proposing.']);
    const inValue = run((doc) => (doc.ticket[0].body = "Export [NEEDS CLARIFICATION: which columns]"));
    expect(inValue.ok).toBe(false);
  });

  it("refuses a ticket scope that equals or sits inside a protected path", () => {
    const result = run((doc) => {
      doc.scope = { protected: ["docs/**", "package.json", "**/*.lock"] };
      doc.ticket[0].scope = ["docs/api/*.md"];
      doc.ticket[1].scope = ["package.json", "src/export/**"];
    });
    expect(result.errors).toEqual([
      'ticket[0].scope: "docs/api/*.md" falls under the protected path "docs/**". Remove it from the ticket, or take the path out of scope.protected.',
      'ticket[1].scope: "package.json" falls under the protected path "package.json". Remove it from the ticket, or take the path out of scope.protected.',
    ]);
  });

  it("a protected glob that starts with a wildcard does not block a wildcard scope that has no literal overlap", () => {
    const result = run((doc) => (doc.scope = { protected: ["**/*.lock"] }));
    expect(result.errors).toEqual([]);
  });

  it("refuses every ticket scope when the protected glob is a universal wildcard", () => {
    for (const universal of ["**", "**/*", "./**"]) {
      const result = run((doc) => {
        doc.scope = { protected: [universal] };
        doc.ticket[0].scope = ["src/model/**"];
      });
      expect(result.errors).toEqual([`ticket[0].scope: "src/model/**" falls under the protected path "${universal}". Remove it from the ticket, or take the path out of scope.protected.`, `ticket[1].scope: "src/export/**" falls under the protected path "${universal}". Remove it from the ticket, or take the path out of scope.protected.`]);
    }
  });

  it("refuses a literal ticket scope that a wildcard-first protected glob matches", () => {
    const result = run((doc) => {
      doc.scope = { protected: ["**/*.lock"] };
      doc.ticket[0].scope = ["deps/yarn.lock"];
    });
    expect(result.errors).toEqual(['ticket[0].scope: "deps/yarn.lock" falls under the protected path "**/*.lock". Remove it from the ticket, or take the path out of scope.protected.']);
  });

  it("still accepts a ticket scope that is outside a protected directory", () => {
    const result = run((doc) => {
      doc.scope = { protected: ["src/generated/**"] };
      doc.ticket[0].scope = ["src/app/**"];
    });
    expect(result.errors).toEqual([]);
  });

  it("refuses a ticket with no verify when no check commands exist", () => {
    const result = run((doc) => (doc.checks = { commands: [] }));
    expect(result.errors).toEqual([
      "ticket[0].verify: nothing would check this ticket, because it has no verify commands and checks.commands is empty. Add a verify command to the ticket or a command to [checks].",
      "ticket[1].verify: nothing would check this ticket, because it has no verify commands and checks.commands is empty. Add a verify command to the ticket or a command to [checks].",
    ]);
    expect(run((doc) => (doc.checks = { commands: [] }, doc.ticket.forEach((t: Doc) => (t.verify = ["npm test"])))).errors).toEqual([]);
  });

  it("refuses after_merge with the pr strategy", () => {
    const result = run((doc) => {
      doc.merge = { strategy: "pr" };
      doc.checks.after_merge = ["npm run build"];
    });
    expect(result.errors).toEqual(['checks.after_merge: these run on the merged integration branch, but merge.strategy is "pr". Remove after_merge, or use merge.strategy = "integration".']);
  });

  it("collects several semantic errors at once", () => {
    const result = run((doc) => {
      doc.project.open_questions = ["Q?"];
      doc.ticket[1].depends_on = ["nope"];
    });
    expect(result.errors).toHaveLength(2);
  });
});

describe("warnings", () => {
  it("warns when the reviewer and worker use the same provider and model", () => {
    const same = run((doc) => (doc.agents.reviewer = { provider: "claude", model: "sonnet" }));
    expect(same.ok).toBe(true);
    expect(same.warnings).toEqual(["agents.reviewer: the reviewer uses the same provider and model as the worker, so it shares the worker's blind spots. Set agents.reviewer.provider and model to a different model."]);
    expect(run((doc) => delete doc.agents).warnings).toHaveLength(1);
  });

  it("counts the overlap warnings it leaves out, in the singular for one", () => {
    const result = run((doc) => {
      doc.ticket = Array.from({ length: 6 }, (_, index) => ({ ref: `t${index}`, title: `T${index}`, body: "Do it.", acceptance: ["WHEN it runs THE SYSTEM SHALL work"], scope: index === 5 ? ["src/b/**"] : ["src/a/**"] }));
      doc.ticket[0].scope = ["src/a/**", "src/b/**"];
    });
    expect(result.warnings).toHaveLength(11);
    expect(result.warnings.at(-1)).toBe("… and 1 more pair of tickets with overlapping scope.");
  });

  it("warns about overlapping scopes with no dependency path, and not when one exists", () => {
    const overlapping = run((doc) => {
      doc.ticket[1].scope = ["src/model/export.ts"];
      delete doc.ticket[1].depends_on;
    });
    expect(overlapping.ok).toBe(true);
    expect(overlapping.warnings).toEqual(["ticket[0] and ticket[1] have overlapping scope and no dependency between them, so they will run one at a time. Add depends_on if the order matters, or narrow their scope."]);
    expect(scopeOverlaps(overlapping.spec!.ticket)).toEqual([{ i: 0, j: 1, paths: ["src/model/**", "src/model/export.ts"] }]);
    const ordered = run((doc) => (doc.ticket[1].scope = ["src/model/export.ts"]));
    expect(ordered.warnings).toEqual([]);
    expect(scopeOverlaps(ordered.spec!.ticket)).toEqual([]);
  });

  it("follows depends_on through intermediate tickets", () => {
    const result = run((doc) => {
      doc.ticket = [
        { ref: "a", title: "A", body: "b", acceptance: ["x"], scope: ["src/**"] },
        { ref: "b", title: "B", body: "b", acceptance: ["x"], scope: ["lib/**"], depends_on: ["a"] },
        { ref: "c", title: "C", body: "b", acceptance: ["x"], scope: ["src/c.ts"], depends_on: ["b"] },
      ];
    });
    expect(result.warnings).toEqual([]);
  });
});

describe("specHash", () => {
  it("ignores key order and comments, and changes with content", () => {
    const first = run().spec!;
    const reordered = parseSpec(
      `# a comment\n[[ticket]]\nscope = ["src/model/**"]\nbody = "Build the row mapper."\nref = "csv-model"\ntitle = "Order rows"\nacceptance = ["WHEN an order is mapped THE SYSTEM SHALL return one row"]\n\n` +
        `[[ticket]]\ndepends_on = ["csv-model"]\nscope = ["src/export/**"]\nbody = "Serve the file."\nref = "csv-export"\ntitle = "Export endpoint"\nacceptance = ["WHEN the endpoint is called THE SYSTEM SHALL stream a CSV", "WHEN there are no orders THE SYSTEM SHALL return a header row"]\n\n` +
        `[agents.reviewer]\nmodel = "gpt"\nprovider = "codex"\n[agents.worker]\nmodel = "sonnet"\nprovider = "claude"\n[checks]\ncommands = ["npm test"]\n[merge]\nstrategy = "integration"\n` +
        `[project]\nsummary = "Let people export their orders as a CSV file from the admin page."\ngoal = "Let people export their orders as a CSV file from the admin page."\nkey = "CSV"\nname = "CSV export"\nslug = "csv"\n`,
    ).spec!;
    expect(specHash(reordered)).toBe(specHash(first));
    expect(specHash(first)).toMatch(/^[0-9a-f]{64}$/);
    const changed = run((doc) => (doc.ticket[0].title = "Row mapper")).spec!;
    expect(specHash(changed)).not.toBe(specHash(first));
  });
});

describe("[[repo]]", () => {
  const twoRepos = (doc: Doc) => {
    doc.repo = [
      { name: "web", project: "proj_web" },
      { name: "api", project: "proj_api", base: "trunk", remote: "upstream", checks: ["make test"], protected: ["vendor/**"] },
    ];
    doc.ticket[0].repo = "web";
    doc.ticket[1].repo = "api";
  };
  const multi = (edit?: (doc: Doc) => void) =>
    run((doc) => {
      twoRepos(doc);
      edit?.(doc);
    });

  it("parses a spec without [[repo]] to the object and the hash it had before repos existed", () => {
    const spec = run(beforeSummaries).spec!;
    expect(Object.keys(spec)).not.toContain("repo");
    for (const ticket of spec.ticket) expect(Object.keys(ticket)).not.toContain("repo");
    // Computed by the spec.ts that came before [[repo]]; it changes only if the base spec or the schema's output does.
    expect(specHash(spec)).toBe("975e726bf34c40a6b5becf170f1eb25e6dc3f7a8e6818724e1ea96d69bf2808f");
  });

  it("accepts repos that every ticket names, keeps each ticket's repo and fills in nothing", () => {
    const result = multi();
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.spec?.repo).toStrictEqual([
      { name: "web", project: "proj_web" },
      { name: "api", project: "proj_api", base: "trunk", remote: "upstream", checks: ["make test"], protected: ["vendor/**"] },
    ]);
    expect(result.spec?.ticket.map((ticket) => ticket.repo)).toEqual(["web", "api"]);
  });

  it("names the TOML path of a bad repo entry or ticket repo", () => {
    const result = multi((doc) => {
      doc.repo[0].name = "Web";
      doc.repo[1].project = "";
      doc.repo[1].base = "a..b";
      doc.repo[1].colour = "red";
      doc.ticket[0].repo = "a".repeat(25);
    });
    const text = result.errors.join("\n");
    expect(text).toContain("repo[0].name: must be 1-24 lowercase letters, digits or dashes, starting with a letter (for example web).");
    expect(text).toContain("repo[1].project:");
    expect(text).toContain("repo[1].base:");
    expect(text).toContain('repo[1]: unknown key "colour".');
    expect(text).toContain("ticket[0].repo:");
    expect(multi((doc) => (doc.repo[0].name = "w".repeat(24))).errors.join("\n")).not.toContain("repo[0].name:");
    expect(multi((doc) => delete doc.repo[1].project).errors).toContain("repo[1].project: is required. Add it.");
  });

  it("refuses more than 10 repos", () => {
    const result = multi((doc) => (doc.repo = Array.from({ length: 11 }, (_, index) => ({ name: `r${index}`, project: `proj_${index}` }))));
    expect(result.errors.join("\n")).toContain("repo: Too big");
  });

  it("refuses two repos with the same name or the same project", () => {
    const result = multi((doc) => doc.repo.push({ name: "web", project: "proj_api" }));
    expect(result.errors).toEqual([
      'repo[2].name: "web" is also the name of repo[0]. Give every repo a unique name.',
      'repo[2].project: "proj_api" is also the project of repo[1]. List each bb project in one [[repo]] table only.',
    ]);
  });

  it("refuses a ticket of a multi-repo spec that names no repo or an unknown one, and lists the names", () => {
    const result = multi((doc) => {
      delete doc.ticket[0].repo;
      doc.ticket[1].repo = "docs";
    });
    expect(result.errors).toEqual(["ticket[0].repo: is required, because the spec lists [[repo]] tables. Set it to one of: web, api.", 'ticket[1].repo: "docs" is not the name of a [[repo]] table. Use one of: web, api.']);
  });

  it("refuses a ticket that sets repo when the spec has no [[repo]]", () => {
    const result = run((doc) => (doc.ticket[1].repo = "api"));
    expect(result.errors).toEqual(['ticket[1].repo: "api" names a repo, but the spec has no [[repo]] table, so every ticket runs in the project\'s own repository. Add a [[repo]] table named "api", or remove repo from the ticket.']);
  });

  it("refuses a repo's after_merge with the pr strategy, and accepts it with integration", () => {
    const result = multi((doc) => {
      doc.merge = { strategy: "pr" };
      doc.repo[1].after_merge = ["make build"];
    });
    expect(result.errors).toEqual(['repo[1].after_merge: these run on the merged integration branch, but merge.strategy is "pr". Remove after_merge, or use merge.strategy = "integration".']);
    expect(multi((doc) => (doc.repo[1].after_merge = ["make build"])).errors).toEqual([]);
  });

  it("refuses a scope under its own repo's protected globs, and accepts one under another repo's only", () => {
    const own = multi((doc) => (doc.ticket[1].scope = ["vendor/lib/**"]));
    expect(own.errors).toEqual(['ticket[1].scope: "vendor/lib/**" falls under the protected path "vendor/**" of repo "api". Remove it from the ticket, or take the path out of repo[1].protected.']);
    const other = multi((doc) => (doc.ticket[0].scope = ["vendor/lib/**"]));
    expect(other.errors).toEqual([]);
  });

  it("still refuses a scope under the top-level protected globs in every repo", () => {
    const result = multi((doc) => {
      doc.scope = { protected: ["src/model/**"] };
      doc.ticket[1].scope = ["src/model/x.ts"];
    });
    expect(result.errors).toEqual([
      'ticket[0].scope: "src/model/**" falls under the protected path "src/model/**". Remove it from the ticket, or take the path out of scope.protected.',
      'ticket[1].scope: "src/model/x.ts" falls under the protected path "src/model/**". Remove it from the ticket, or take the path out of scope.protected.',
    ]);
  });

  it("judges whether anything checks a ticket by its repo's effective checks", () => {
    const replaced = multi((doc) => (doc.checks = { commands: [] }));
    expect(replaced.errors).toEqual([
      "ticket[0].verify: nothing would check this ticket, because it has no verify commands and checks.commands is empty. Add a verify command to the ticket or a command to [checks].",
    ]);
    const emptied = multi((doc) => (doc.repo[1].checks = []));
    expect(emptied.errors).toEqual([
      'ticket[1].verify: nothing would check this ticket, because it has no verify commands and repo[1].checks, which replaces checks.commands for repo "api", is empty. Add a verify command to the ticket or a command to repo[1].checks.',
    ]);
    expect(multi((doc) => ((doc.repo[1].checks = []), (doc.ticket[1].verify = ["make lint"]))).errors).toEqual([]);
  });

  it("reports no overlap between tickets in different repos with the same scope", () => {
    const result = multi((doc) => {
      doc.ticket[1].scope = ["src/model/**"];
      delete doc.ticket[1].depends_on;
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(scopeOverlaps(result.spec!.ticket)).toEqual([]);
    const sameRepo = multi((doc) => {
      doc.ticket[1].repo = "web";
      doc.ticket[1].scope = ["src/model/**"];
      delete doc.ticket[1].depends_on;
    });
    expect(scopeOverlaps(sameRepo.spec!.ticket)).toEqual([{ i: 0, j: 1, paths: ["src/model/**"] }]);
  });

  it("lets a ticket patch set repo, and leaves it out of a patch that does not", () => {
    expect(ticketPatchSchema.parse({ repo: "api" })).toStrictEqual({ repo: "api" });
    expect(ticketPatchSchema.parse({ title: "New" })).toStrictEqual({ title: "New" });
    expect(ticketPatchSchema.safeParse({ repo: "" }).success).toBe(false);
  });
});

describe("dependencyCycle", () => {
  const t = (ref: string, ...depends_on: string[]) => ({ ref, depends_on });

  it("returns null for an acyclic graph, ignoring unknown refs", () => {
    expect(dependencyCycle([t("a"), t("b", "a"), t("c", "a", "b"), t("d", "ghost")])).toBeNull();
  });

  it("returns one closed cycle path", () => {
    expect(dependencyCycle([t("a", "b"), t("b", "c"), t("c", "a")])).toEqual(["a", "b", "c", "a"]);
  });

  it("does not report tickets that merely depend on a cycle", () => {
    expect(dependencyCycle([t("tail", "a"), t("a", "b"), t("b", "a")])).toEqual(["a", "b", "a"]);
  });
});

describe("globsOverlap", () => {
  it("compares literal prefixes", () => {
    expect(globsOverlap("src/foo*.ts", "src/foobar.ts")).toBe(true);
    expect(globsOverlap("./src/a/**", "src/a/x.ts")).toBe(true);
    expect(globsOverlap("src/a/**", "src/b/**")).toBe(false);
    expect(globsOverlap("**/*.ts", "src/a.ts")).toBe(true);
    expect(globsOverlap("src/a?.ts", "src/b.ts")).toBe(false);
  });
});

describe("numberErrors", () => {
  it("numbers errors and caps the list at 20", () => {
    expect(numberErrors(["a", "b"])).toBe("1. a\n2. b");
    const many = Array.from({ length: 23 }, (_, i) => `e${i + 1}`);
    const lines = numberErrors(many).split("\n");
    expect(lines).toHaveLength(21);
    expect(lines[19]).toBe("20. e20");
    expect(lines[20]).toBe("… and 3 more");
  });
});

describe("skills/loom/references/spec.md", () => {
  it("its example spec is accepted without warnings", () => {
    const reference = readFileSync(new URL("../skills/loom/references/spec.md", import.meta.url), "utf8");
    const example = /```toml\n([\s\S]*?)```/.exec(reference)?.[1];
    expect(example).toBeDefined();
    const result = parseSpec(example!);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.spec?.ticket.map((ticket) => ticket.ref)).toEqual(["row-mapper", "export-endpoint"]);
  });
});

describe("forges, integration worktrees and environments", () => {
  it("leaves them out of a spec that does not set them, so its hash is the one it had before", () => {
    const spec = run(beforeSummaries).spec!;
    expect(Object.keys(spec.merge)).not.toContain("forge");
    expect(Object.keys(spec.merge)).not.toContain("worktree");
    expect(Object.keys(spec)).not.toContain("environment");
    expect(specHash(spec)).toBe("975e726bf34c40a6b5becf170f1eb25e6dc3f7a8e6818724e1ea96d69bf2808f");
  });

  it("parses a command forge, a plugin worktree and an environment with placeholders, top level and per repo", () => {
    const result = run((doc) => {
      doc.merge.forge = { kind: "command", open: "review create", state: "review state", after_open: ["ci run"] };
      doc.merge.worktree = { plugin: "trees", command: "prepare loom" };
      doc.environment = { provider: "trees", inputs: { pool: { branch: "{branch}", base: "{base}", paths: ["a"] } } };
      doc.repo = [
        { name: "web", project: "proj_web", forge: { kind: "none" }, environment: { provider: "git-worktree" }, worktree: { command: "prep" } },
        { name: "api", project: "proj_api" },
      ];
      doc.ticket[0].repo = "web";
      doc.ticket[1].repo = "api";
    });
    expect(result.errors).toEqual([]);
    expect(result.spec!.merge.forge).toEqual({ kind: "command", open: "review create", state: "review state", after_open: ["ci run"] });
    expect(result.spec!.repo![0]!.forge).toEqual({ kind: "none" });
  });

  it("refuses a command forge without its commands, commands on another kind, and after_open with none", () => {
    expect(run((doc) => (doc.merge.forge = { kind: "command" })).errors).toEqual([
      expect.stringMatching(/^merge\.forge\.open: is required when merge\.forge\.kind is "command"\. Add the command that opens a pull request/u),
      expect.stringMatching(/^merge\.forge\.state: is required when merge\.forge\.kind is "command"\./u),
    ]);
    expect(run((doc) => (doc.merge.forge = { kind: "gh", open: "x" })).errors).toEqual(['merge.forge.open: only kind = "command" runs it, and merge.forge.kind is "gh". Remove it, or set kind = "command".']);
    expect(run((doc) => (doc.merge.forge = { kind: "none", after_open: ["x"] })).errors).toEqual([expect.stringMatching(/^merge\.forge\.after_open: kind = "none" opens no pull request/u)]);
    expect(run((doc) => (doc.merge.forge = { kind: "none", after_push: ["x"] })).errors).toEqual([expect.stringMatching(/^merge\.forge\.after_push: kind = "none" opens no pull request/u)]);
    expect(run((doc) => (doc.merge.forge = { kind: "gh", retarget: "x" })).errors).toEqual(['merge.forge.retarget: only kind = "command" runs it, and merge.forge.kind is "gh". Remove it, or set kind = "command".']);
  });

  it("parses a command forge's retarget command and after_push commands, and gh's after_push", () => {
    const command = run((doc) => (doc.merge.forge = { kind: "command", open: "review create", state: "review state", retarget: "review edit", after_push: ["ci run", "review ready"] }));
    expect(command.errors).toEqual([]);
    expect(command.spec!.merge.forge).toMatchObject({ retarget: "review edit", after_push: ["ci run", "review ready"] });
    expect(run((doc) => (doc.merge.forge = { kind: "gh", after_push: ["ci run"] })).errors).toEqual([]);
  });

  it("refuses a worktree on the pull request strategy, an unknown placeholder, and malformed ids", () => {
    expect(run((doc) => (doc.merge = { strategy: "pr", worktree: { command: "prep" } })).errors).toEqual(['merge.worktree: only the integration strategy has an integration worktree, and merge.strategy is "pr". Remove merge.worktree, or use merge.strategy = "integration".']);
    expect(run((doc) => (doc.environment = { provider: "trees", inputs: { tree: "{ticket}" } })).errors).toEqual(["environment.inputs: {ticket} is not a Loom placeholder. Use {branch} or {base}, or write the value out."]);
    expect(run((doc) => (doc.environment = { provider: "Trees!" })).errors[0]).toMatch(/^environment\.provider: must be a bb environment provider id/u);
    expect(run((doc) => (doc.merge.worktree = { plugin: "bad id", command: "x" })).errors[0]).toMatch(/^merge\.worktree\.plugin: must be a bb plugin id/u);
  });

  it("parses who writes each pull request, squashing and the fix-round limit on the pr strategy, and a forge's feedback command", () => {
    const result = run((doc) => (doc.merge = { strategy: "pr", describe: "loom", squash: false, max_fix_rounds: 2, forge: { kind: "command", open: "o", state: "s", feedback: "f --json" } }));
    expect(result.errors).toEqual([]);
    expect(result.spec!.merge).toMatchObject({ describe: "loom", squash: false, max_fix_rounds: 2, forge: { feedback: "f --json" } });
    const plain = run((doc) => (doc.merge = { strategy: "pr" })).spec!;
    expect(Object.keys(plain.merge)).not.toContain("describe");
    expect(Object.keys(plain.merge)).not.toContain("squash");
    expect(Object.keys(plain.merge)).not.toContain("max_fix_rounds");
  });

  it("refuses the pull request keys on the integration strategy, a feedback command on another forge kind, and a limit out of range", () => {
    expect(run((doc) => (doc.merge = { strategy: "integration", describe: "worker", squash: true })).errors).toEqual([
      'merge.describe: it applies to the pull request Loom opens for each ticket, but merge.strategy is "integration". Remove it, or use merge.strategy = "pr".',
      'merge.squash: it applies to the pull request Loom opens for each ticket, but merge.strategy is "integration". Remove it, or use merge.strategy = "pr".',
    ]);
    expect(run((doc) => (doc.merge = { strategy: "pr", forge: { kind: "gh", feedback: "f" } })).errors).toEqual(['merge.forge.feedback: only kind = "command" runs it, and merge.forge.kind is "gh". Remove it, or set kind = "command".']);
    expect(run((doc) => (doc.merge = { strategy: "pr", max_fix_rounds: 21 })).errors[0]).toMatch(/^merge\.max_fix_rounds: /u);
    expect(run((doc) => (doc.merge = { strategy: "pr", describe: "planner" })).errors[0]).toMatch(/^merge\.describe: /u);
  });

  it("parses how long queued checks and how far running checks hold the failed ones on the pr strategy, and refuses them elsewhere or out of range", () => {
    const set = run((doc) => (doc.merge = { strategy: "pr", checks_queued_minutes: 0, checks_near_done_percent: 90 }));
    expect(set.errors).toEqual([]);
    expect(set.spec!.merge).toMatchObject({ checks_queued_minutes: 0, checks_near_done_percent: 90 });
    const plain = run((doc) => (doc.merge = { strategy: "pr" })).spec!;
    expect(Object.keys(plain.merge)).not.toContain("checks_queued_minutes");
    expect(Object.keys(plain.merge)).not.toContain("checks_near_done_percent");
    expect(run((doc) => (doc.merge = { strategy: "integration", checks_queued_minutes: 5, checks_near_done_percent: 75 })).errors).toEqual([
      'merge.checks_queued_minutes: it applies to the pull request Loom opens for each ticket, but merge.strategy is "integration". Remove it, or use merge.strategy = "pr".',
      'merge.checks_near_done_percent: it applies to the pull request Loom opens for each ticket, but merge.strategy is "integration". Remove it, or use merge.strategy = "pr".',
    ]);
    expect(run((doc) => (doc.merge = { strategy: "pr", checks_near_done_percent: 101 })).errors[0]).toMatch(/^merge\.checks_near_done_percent: /u);
    expect(run((doc) => (doc.merge = { strategy: "pr", checks_queued_minutes: 2.5 })).errors[0]).toMatch(/^merge\.checks_queued_minutes: /u);
  });

  it("stacks pull requests on the pr strategy unless merge.stack = false, and refuses the key on the integration strategy", () => {
    const plain = run((doc) => (doc.merge = { strategy: "pr" })).spec!;
    expect(Object.keys(plain.merge)).not.toContain("stack");
    expect(prSettings(plain).stack).toBe(true);
    expect(prSettings(run((doc) => (doc.merge = { strategy: "pr", stack: false })).spec!).stack).toBe(false);
    expect(run((doc) => (doc.merge = { strategy: "integration", stack: true })).errors).toEqual([
      'merge.stack: it applies to the pull request Loom opens for each ticket, but merge.strategy is "integration". Remove it, or use merge.strategy = "pr".',
    ]);
  });
});

describe("relying on the pull request's CI", () => {
  const command = { kind: "command", open: "review-cli create", state: "review-cli status" };

  it("parses ci in [checks] and in a [[repo]] table, and leaves it out of a spec that does not set it", () => {
    const result = run((doc) => {
      doc.merge = { strategy: "pr" };
      doc.checks = { commands: ["npm test"], ci: false };
      doc.repo = [{ name: "web", project: "proj_web", ci: true }, { name: "api", project: "proj_api" }];
      doc.ticket[0].repo = "web";
      doc.ticket[1].repo = "api";
    });
    expect(result.errors).toEqual([]);
    expect(result.spec!.checks.ci).toBe(false);
    expect(result.spec!.repo![0]!.ci).toBe(true);
    expect(Object.keys(run((doc) => (doc.merge = { strategy: "pr" })).spec!.checks)).not.toContain("ci");
  });

  it("refuses ci on the integration strategy, where no pull request runs CI", () => {
    expect(run((doc) => (doc.checks = { commands: ["npm test"], ci: false })).errors).toEqual([
      'checks.ci: it says whether Loom relies on the CI of the pull request it opens for each ticket, but merge.strategy is "integration". Remove it, or use merge.strategy = "pr".',
    ]);
  });

  it("refuses a repo that relies on CI through a forge that reports no checks, naming both fixes", () => {
    expect(run((doc) => (doc.merge = { strategy: "pr", forge: command })).errors).toEqual([
      'merge.forge: the repo relies on its pull requests\' CI (checks.ci is not false), but this forge reports no checks, so Loom could never send a failed one back. Add a feedback command to merge.forge, or set checks.ci = false so the plugin checks are the whole bar.',
    ]);
    expect(run((doc) => (doc.merge = { strategy: "pr", forge: { kind: "none" } })).errors).toEqual([
      'merge.forge: the repo relies on its pull requests\' CI (checks.ci is not false), but kind = "none" opens no pull request and reports no checks. Use kind = "gh", or kind = "command" with a feedback command, or set checks.ci = false so the plugin checks are the whole bar.',
    ]);
    expect(run((doc) => ((doc.merge = { strategy: "pr", forge: command }), (doc.checks = { commands: ["npm test"], ci: false }))).errors).toEqual([]);
    expect(run((doc) => (doc.merge = { strategy: "pr", forge: { ...command, feedback: "review-cli checks" } })).errors).toEqual([]);
  });

  it("names the repo's own paths on a multi-repo spec, once per repo that relies on CI", () => {
    const errors = run((doc) => {
      doc.merge = { strategy: "pr", forge: command };
      doc.repo = [
        { name: "web", project: "proj_web", ci: false },
        { name: "api", project: "proj_api" },
        { name: "docs", project: "proj_docs", forge: { kind: "gh" } },
      ];
      doc.ticket[0].repo = "web";
      doc.ticket[1].repo = "api";
    }).errors;
    expect(errors).toEqual([
      'merge.forge: the repo "api" relies on its pull requests\' CI (repo[1].ci is not false), but this forge reports no checks, so Loom could never send a failed one back. Add a feedback command to merge.forge, or set repo[1].ci = false so the plugin checks are the whole bar.',
    ]);
  });
});

describe("threads on new machines", () => {
  const pr = { strategy: "pr", stack: false };

  it("parses a machine for workers and one for reviewers on the pr strategy without stacking", () => {
    const result = run((doc) => {
      doc.merge = pr;
      doc.environment = { provider: "git-worktree", machine: { provider: "x" }, reviewer: { machine: { provider: "y", inputs: { size: "small" } } } };
    });
    expect(result.errors).toEqual([]);
    expect(result.spec!.environment).toEqual({ provider: "git-worktree", machine: { provider: "x" }, reviewer: { machine: { provider: "y", inputs: { size: "small" } } } });
    const plain = run((doc) => (doc.environment = { provider: "git-worktree" })).spec!;
    expect(Object.keys(plain.environment!)).not.toContain("machine");
  });

  it("refuses the integration strategy for a repo whose workers or reviewers use a machine, naming the path, and accepts stacking", () => {
    const why = 'a thread on a new machine needs merge.strategy = "pr", because Loom does not carry the integration branch, which lives only on the project\'s machine, to other machines. Set merge.strategy = "pr", or remove';
    expect(run((doc) => (doc.environment = { provider: "git-worktree", machine: { provider: "x" } })).errors).toEqual([`environment.machine: ${why} environment.machine.`]);
    expect(run((doc) => {
      doc.merge = { strategy: "integration" };
      doc.environment = { provider: "git-worktree", reviewer: { machine: { provider: "x" } } };
    }).errors).toEqual([`environment.reviewer.machine: ${why} environment.reviewer.machine.`]);
    expect(run((doc) => {
      doc.merge = { strategy: "pr" };
      doc.environment = { provider: "git-worktree", reviewer: { machine: { provider: "x" } } };
    }).errors).toEqual([]);
    expect(run((doc) => {
      doc.merge = { strategy: "integration" };
      doc.repo = [
        { name: "web", project: "proj_web", environment: { provider: "git-worktree", machine: { provider: "x" } } },
        { name: "api", project: "proj_api" },
      ];
      doc.ticket[0].repo = "web";
      doc.ticket[1].repo = "api";
    }).errors).toEqual([`repo[0].environment.machine: ${why} repo[0].environment.machine.`]);
    expect(run((doc) => {
      doc.merge = { strategy: "pr", stack: true };
      doc.environment = { provider: "git-worktree", machine: { provider: "x" } };
    }).errors).toEqual([]);
  });

  it("refuses a malformed machine provider id and an unknown placeholder in machine inputs", () => {
    expect(run((doc) => ((doc.merge = pr), (doc.environment = { provider: "git-worktree", machine: { provider: "Big Box" } }))).errors[0]).toMatch(/^environment\.machine\.provider: must be a bb machine provider id/u);
    expect(run((doc) => ((doc.merge = pr), (doc.environment = { provider: "git-worktree", machine: { provider: "x", inputs: { name: "{ticket}" } } }))).errors).toEqual([
      "environment.machine.inputs: {ticket} is not a Loom placeholder. Use {branch} or {base}, or write the value out.",
    ]);
  });
});

describe("project.summary, done_when and merge_after", () => {
  it("parses a spec without a summary, as the specs stored before it existed, but a proposal needs one", () => {
    const old = run(beforeSummaries);
    expect(old.ok).toBe(true);
    expect(Object.keys(old.spec!.project)).not.toContain("summary");
    expect(proposalErrorsOf(old.spec!)).toEqual([expect.stringMatching(/^project\.summary: required\./)]);
    expect(proposalErrorsOf(run().spec!)).toEqual([]);
  });

  it("keeps the summary between 20 and 300 characters, and done_when as a list of lines", () => {
    expect(run((doc) => (doc.project.summary = "Too short.")).errors.join("\n")).toMatch(/project\.summary/);
    expect(run((doc) => (doc.project.summary = "x".repeat(301))).errors.join("\n")).toMatch(/project\.summary/);
    const spec = run((doc) => (doc.project.done_when = ["People can download the file", "Empty exports have a header row"])).spec!;
    expect(spec.project.done_when).toEqual(["People can download the file", "Empty exports have a header row"]);
    expect(Object.keys(run().spec!.project)).not.toContain("done_when");
  });

  const docs = (merge_after?: string[]) => ({ ref: "csv-docs", title: "Docs", body: "Write them.", acceptance: ["WHEN built THE SYSTEM SHALL list it"], scope: ["docs/**"], ...(merge_after === undefined ? {} : { merge_after }) });

  it("keeps merge_after, and leaves it out of a ticket that does not set it", () => {
    const spec = run((doc) => doc.ticket.push(docs(["csv-export"]))).spec!;
    expect(spec.ticket[2]!.merge_after).toEqual(["csv-export"]);
    expect(Object.keys(spec.ticket[0]!)).not.toContain("merge_after");
  });

  it("refuses a merge_after ref that is unknown or the ticket's own, and warns about one depends_on already orders", () => {
    expect(run((doc) => doc.ticket.push(docs(["nope"]))).errors).toEqual([expect.stringMatching(/^ticket\[2\]\.merge_after: "nope" is not a ticket ref\. Use one of: csv-model, csv-export\./)]);
    expect(run((doc) => doc.ticket.push(docs(["csv-docs"]))).errors).toEqual([expect.stringMatching(/^ticket\[2\]\.merge_after: "csv-docs" is this ticket's own ref/)]);
    const twice = run((doc) => (doc.ticket[1].merge_after = ["csv-model"]));
    expect(twice.ok).toBe(true);
    expect(twice.warnings).toEqual([expect.stringMatching(/^ticket\[1\]\.merge_after: "csv-model" is in depends_on too/)]);
  });

  it("refuses a merge order cycle through depends_on and merge_after", () => {
    // csv-export depends on csv-model, so csv-model merging after csv-export would never merge.
    expect(run((doc) => (doc.ticket[0].merge_after = ["csv-export"])).errors).toEqual([
      expect.stringMatching(/^ticket\[0\]\.merge_after: merge order cycle csv-model -> csv-export -> csv-model through depends_on and merge_after/),
    ]);
    const through = run((doc) => {
      doc.ticket.push(docs(["csv-export"]));
      doc.ticket[0].merge_after = ["csv-docs"];
    });
    expect(through.errors.join("\n")).toMatch(/merge order cycle .* through depends_on and merge_after/);
  });

  it("lets a ticket patch set merge_after", () => {
    expect(ticketPatchSchema.parse({ merge_after: ["CSV-1"] })).toEqual({ merge_after: ["CSV-1"] });
  });
});
