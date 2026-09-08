import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * A real SQLite behind D1's API, for tests a double cannot tell the truth to.
 *
 * The correction apply is raw SQL against D1 — prepare/bind/batch, and a
 * guarded UPDATE whose reported `changes` count is the entire safety mechanism
 * standing in for the transaction D1 does not have. A hand-written fake of that
 * API would only ever assert that the code calls the methods the fake expects,
 * which is worth nothing here.
 *
 * So the SQL, the schema, the constraints and the change counts are real —
 * Node's own SQLite, the same engine D1 runs on. What is ours is the thin shim
 * below that puts D1's method names on it, plus one behaviour worth stating:
 * `batch` runs inside a SQLite transaction, which is what D1 documents and what
 * was measured against the real service — a statement that fails part-way rolls
 * the whole batch back.
 *
 * (Miniflare would give the actual D1 binding, but the version pinned here is
 * an alpha whose constructor no longer accepts bindings in any shape its own
 * types describe.)
 *
 * The schema is the same migration D1 was created from, so a column that
 * exists here exists there.
 */
export interface TestD1 {
  db: D1Database;
  dispose(): Promise<void>;
}

const SCHEMA = join(__dirname, '..', 'drizzle', '0000_blue_magus.sql');

type Row = Record<string, unknown>;

/** D1's result shape for a write. */
const meta = (changes: number) => ({
  success: true,
  meta: { changes, duration: 0, rows_read: 0, rows_written: changes },
});

export async function createTestD1(): Promise<TestD1> {
  const sqlite = new DatabaseSync(':memory:');
  // Off by default in SQLite, on in D1 — a test relying on a foreign key would
  // otherwise pass here and fail in production.
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const stmt of readFileSync(SCHEMA, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean)) {
    sqlite.exec(stmt);
  }

  const prepare = (sql: string) => {
    const stmt = sqlite.prepare(sql);
    let bound: unknown[] = [];
    const api = {
      bind: (...args: unknown[]) => {
        // D1 takes null/number/string/ArrayBuffer; booleans reach it from code
        // treating an integer column as one, so they are narrowed as the
        // driver narrows them.
        bound = args.map((a) => (typeof a === 'boolean' ? (a ? 1 : 0) : a));
        return api;
      },
      first: async (col?: string) => {
        const row = stmt.get(...(bound as never[])) as Row | undefined;
        if (!row) return null;
        return col ? (row[col] ?? null) : { ...row };
      },
      all: async () => ({
        ...meta(0),
        results: (stmt.all(...(bound as never[])) as Row[]).map((r) => ({ ...r })),
      }),
      run: async () => meta(stmt.run(...(bound as never[])).changes as number),
      raw: async () => (stmt.all(...(bound as never[])) as Row[]).map((r) => Object.values(r)),
      /** What the batch runner needs to replay this statement. */
      __exec: () => meta(stmt.run(...(bound as never[])).changes as number),
    };
    return api;
  };

  const db = {
    prepare,
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },
    // Atomic, as D1's is: a failure part-way rolls back what came before it.
    batch: async (stmts: { __exec(): unknown }[]) => {
      sqlite.exec('BEGIN');
      try {
        const out = stmts.map((s) => s.__exec());
        sqlite.exec('COMMIT');
        return out;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  } as unknown as D1Database;

  return {
    db,
    dispose: async () => {
      sqlite.close();
    },
  };
}

/** Insert a row from a plain object, so fixtures read as data. */
export async function insert(db: D1Database, table: string, row: Record<string, unknown>) {
  const cols = Object.keys(row);
  await db
    .prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .bind(...cols.map((c) => row[c]))
    .run();
}

/** One row by id, as stored — no conversion, so a test sees what D1 holds. */
export async function rowById(db: D1Database, table: string, id: string) {
  return (await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first()) as Row | null;
}
