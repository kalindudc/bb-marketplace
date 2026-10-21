import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dependencyCycle, globsOverlap, numberErrors, parseSpec, scopeOverlaps, specHash } from "../src/spec";
import { specToml, type Doc } from "./helpers";

function run(edit?: (doc: Doc) => void) {
  return parseSpec(specToml(edit));
}

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
        `[project]\ngoal = "Let people export their orders as a CSV file from the admin page."\nkey = "CSV"\nname = "CSV export"\nslug = "csv"\n`,
    ).spec!;
    expect(specHash(reordered)).toBe(specHash(first));
    expect(specHash(first)).toMatch(/^[0-9a-f]{64}$/);
    const changed = run((doc) => (doc.ticket[0].title = "Row mapper")).spec!;
    expect(specHash(changed)).not.toBe(specHash(first));
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
