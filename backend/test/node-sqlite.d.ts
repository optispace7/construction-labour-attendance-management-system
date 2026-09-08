/**
 * The part of `node:sqlite` the D1 test harness uses.
 *
 * Declared here because @types/node is pinned at 20, which predates the
 * module; the runtime has it (Node 22). Only the surface actually called is
 * described, so this cannot drift into claiming more than it uses.
 */
declare module 'node:sqlite' {
  interface StatementSync {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
