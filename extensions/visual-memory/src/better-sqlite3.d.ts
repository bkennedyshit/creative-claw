// Local, minimal type declaration for `better-sqlite3`.
//
// This plugin lives as an untracked workspace package, so pnpm does not
// materialize its `node_modules` (including `@types/better-sqlite3`) in this
// checkout. Rather than depend on an un-linkable `@types` package, we declare
// the narrow surface `store.ts` actually uses. Keep this in sync if store.ts
// starts calling additional better-sqlite3 APIs.
declare module "better-sqlite3" {
  namespace Database {
    interface RunResult {
      changes: number;
      lastInsertRowid: number | bigint;
    }

    interface Statement {
      run(...params: unknown[]): RunResult;
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    }

    interface Database {
      pragma(source: string): unknown;
      exec(source: string): Database;
      prepare(source: string): Statement;
      close(): void;
    }

    interface DatabaseConstructor {
      new (filename: string, options?: Record<string, unknown>): Database;
      (filename: string, options?: Record<string, unknown>): Database;
    }
  }

  const Database: Database.DatabaseConstructor;
  export = Database;
}
