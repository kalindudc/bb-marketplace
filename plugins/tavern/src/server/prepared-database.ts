import type { Database } from "./ports";

const connections = new WeakMap<Database, Database>();
export const databaseConnection = (db: Database) => connections.get(db) ?? db;

export function preparedDatabase(db: Database): Database {
  const statements = new Map<string, ReturnType<Database["prepare"]>>();
  const prepare = (sql: string) => {
    let statement = statements.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  };
  const wrapped = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return prepare;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  connections.set(wrapped, databaseConnection(db));
  return wrapped;
}
