/**
 * A stand-in for the Drizzle query builder, for unit tests.
 *
 * Drizzle is a fluent builder: `.select().from(t).where(c).limit(1)` and the
 * result only appears when the chain is awaited. Mocking each method
 * separately, as a Prisma double did, gives a test that breaks whenever a
 * clause is added — so this returns a chain from every call and decides what to
 * resolve to at the end, from the table that was asked for.
 *
 * Rows are keyed by table so a test says what the database holds rather than
 * what the query looks like:
 *
 *   const db = drizzleDouble([[devices, [aDevice]], [users, [anAdmin]]]);
 *
 * A table's entry may also be a function, which is given how many times that
 * table has been read so far. Some services read one table several times for
 * different reasons — attendance checks the taps table for a replay, then again
 * for the worker's last tap — and a fixed row list cannot tell those apart:
 *
 *   [attendanceTaps, (n) => (n === 0 ? [] : [lastTap])]
 *
 * Each select/insert/update/delete starts its own chain, so two queries built
 * before either is awaited — the `Promise.all` a dashboard does — cannot
 * overwrite each other's table. Writes resolve to whatever `returning()` should
 * produce, or to an empty result, and every call is recorded so a test can
 * assert on what was bound.
 */

type Table = unknown;
type Rows = unknown[];
type RowsFor = Rows | ((readCount: number) => Rows);
type Kind = 'insert' | 'update' | 'delete';

export interface DrizzleDouble {
  db: Record<string, jest.Mock> & { batch: jest.Mock };
  /** Every value bound into a where(), flattened — for scoping assertions. */
  boundValues(): string[];
  /**
   * Every write, in order, with the values it carried — so a test can name the
   * write it means rather than counting calls to `set()` or `values()`.
   */
  writes: { kind: Kind; table: Table; values?: unknown }[];
  /** The values of the first write against `table`, or null if there was none. */
  wrote(table: Table): Record<string, unknown> | null;
}

/** Every string anywhere in a condition, however deeply it is nested. */
export function stringsIn(
  value: unknown,
  found: string[] = [],
  seen = new Set<unknown>(),
): string[] {
  if (typeof value === 'string') found.push(value);
  else if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const v of Object.values(value as Record<string, unknown>)) stringsIn(v, found, seen);
  }
  return found;
}

/** The clauses that only narrow a query — they change nothing the double reads. */
const PASSTHROUGH = [
  'leftJoin',
  'innerJoin',
  'groupBy',
  'orderBy',
  'limit',
  'offset',
  'returning',
  'onConflictDoUpdate',
  'onConflictDoNothing',
];

export function drizzleDouble(
  tableRows: [Table, RowsFor][] = [],
  opts: { onWrite?: (kind: string, table: Table, values?: unknown) => Rows } = {},
): DrizzleDouble {
  const rowsFor = new Map<Table, RowsFor>(tableRows);
  const readCounts = new Map<Table, number>();
  const writes: { kind: Kind; table: Table; values?: unknown }[] = [];
  const whereCalls: unknown[] = [];

  /** What this table holds, for this read of it. */
  const rowsOf = (t: Table): Rows => {
    const entry = rowsFor.get(t);
    if (typeof entry !== 'function') return entry ?? [];
    const n = readCounts.get(t) ?? 0;
    readCounts.set(t, n + 1);
    return entry(n);
  };

  /**
   * Shared jest.fn()s, so `db.set.mock.calls` still sees every call across
   * every query even though the chains themselves are separate.
   */
  const recorders: Record<string, jest.Mock> = {};
  for (const name of ['from', 'values', 'set', 'where', 'then', ...PASSTHROUGH]) {
    recorders[name] = jest.fn();
  }

  /** One query's own state: which table, what kind, and the values written. */
  interface State {
    table: Table;
    mode: 'read' | Kind;
    values?: unknown;
    write?: { kind: Kind; table: Table; values?: unknown };
  }

  function makeChain(state: State) {
    const chain: Record<string, unknown> = {};
    const step = (name: string, fn?: (arg: unknown) => void) => {
      chain[name] = (arg: unknown) => {
        recorders[name](arg);
        fn?.(arg);
        return chain;
      };
    };

    step('from', (t) => {
      state.table = t;
    });
    const remember = (v: unknown) => {
      state.values = v;
      if (state.write) state.write.values = v;
    };
    step('values', remember);
    step('set', remember);
    step('where', (c) => {
      whereCalls.push(c);
    });
    for (const name of PASSTHROUGH) step(name);

    chain.then = (resolve: (rows: Rows) => unknown) => {
      recorders.then(resolve);
      const rows =
        state.mode === 'read'
          ? rowsOf(state.table)
          : (opts.onWrite?.(state.mode, state.table, state.values) ?? rowsOf(state.table));
      return Promise.resolve(rows).then(resolve);
    };
    return chain;
  }

  const start = (mode: 'read' | Kind, table: Table) => {
    const state: State = { table, mode };
    if (mode !== 'read') {
      state.write = { kind: mode, table };
      writes.push(state.write);
    }
    return makeChain(state);
  };

  const db = {
    ...recorders,
    select: jest.fn(() => start('read', null)),
    insert: jest.fn((t: Table) => start('insert', t)),
    update: jest.fn((t: Table) => start('update', t)),
    delete: jest.fn((t: Table) => start('delete', t)),
    // A batch resolves to one result per statement, shaped like D1's.
    batch: jest.fn((stmts: unknown[]) =>
      Promise.resolve((stmts ?? []).map(() => ({ meta: { changes: 1 } }))),
    ),
  } as unknown as Record<string, jest.Mock> & { batch: jest.Mock };

  return {
    db,
    boundValues: () => whereCalls.flatMap((c) => stringsIn(c)),
    writes,
    wrote: (t: Table) =>
      (writes.find((w) => w.table === t)?.values as Record<string, unknown>) ?? null,
  };
}
