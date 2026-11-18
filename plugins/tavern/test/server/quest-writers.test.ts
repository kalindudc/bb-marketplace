// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";

function writers(source: string, file: string): string[] {
  if (file === "src/server/migrations.ts") return [];
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const sql = (node: ts.Node): string | null => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = sql(node.left), right = sql(node.right);
      return left !== null || right !== null ? (left ?? "?") + (right ?? "?") : null;
    }
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => "?" + span.literal.text).join("");
    return null;
  };
  const allowed = (node: ts.Node) => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (!ts.isMethodDeclaration(parent) || !parent.name || !ts.isClassDeclaration(parent.parent)) continue;
      const name = parent.name.getText(tree), owner = parent.parent.name?.text;
      return file === "src/server/keeper/store.ts" && owner === "KeeperStore" && name === "put" ||
        file === "src/server/backup/records.ts" && owner === "BackupRecords" && name === "insert";
    }
    return false;
  };
  const visit = (node: ts.Node) => {
    const value = sql(node);
    if (value !== null && /\b(?:SET|VALUES)\b/i.test(value) && /(?:UPDATE(?: OR \w+)?|(?:INSERT(?: OR \w+)?|REPLACE) INTO)\s+(?:["`]?tavern_records\b|\?)/i.test(value) && !allowed(node)) {
      const kinds = [...value.matchAll(/\bkind\s*=\s*'([^']+)'/gi)].map(match => match[1]);
      const inserted = /VALUES\s*\(\s*'([^']+)'/i.exec(value)?.[1];
      if (inserted) kinds.push(inserted);
      if (!kinds.length || kinds.includes("quests") || /\bkind\s*=\s*\?/i.test(value) || /(?:UPDATE(?: OR \w+)?|(?:INSERT(?: OR \w+)?|REPLACE) INTO)\s+\?/i.test(value)) {
        found.push(`${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}`);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}
it.each([
  `db.prepare("UPDATE tavern_records SET data=? WHERE kind='quests'").run(data)`,
  `db.prepare("INSERT INTO tavern_records(kind,id,data) VALUES('que" + "sts',?,?)").run(id,data)`,
  `db.prepare("UPDATE tavern_records SET data=json_set(data,'$.ph\\u0061se','held') WHERE kind='quests'").run()`,
  `db.prepare("UPDATE tavern_records SET data=? WHERE kind=?").run(data, ['que','sts'].join(''))`,
  `db.prepare("UPDATE " + table + " SET data=? WHERE kind=?").run(data, kind)`,
  `db.prepare("REPLACE INTO tavern_records(kind,id,data) VALUES('quests',?,?)").run(id,data)`,
  `db.prepare("UPDATE OR REPLACE tavern_records SET data=? WHERE kind='quests'").run(data)`,

  'db.prepare(`UPDATE ${table} SET data=? WHERE kind=?`).run(data, kind)',

])("L1 rejects raw quest SQL, including computed spelling: %s", source => {
  expect(writers(source, "src/server/keeper/other.ts")).toHaveLength(1);
});
it("L1 finds no quest SQL writer outside the lifecycle store and migrations", () => {
  const files = readdirSync("src", { recursive: true }).map(String).filter(file => /\.tsx?$/.test(file));
  expect(files.flatMap(file => writers(readFileSync(`src/${file}`, "utf8"), `src/${file}`))).toEqual([]);
});
