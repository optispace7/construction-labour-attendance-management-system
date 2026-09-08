/**
 * A stand-in for the Drizzle query builder, for unit tests.
 *
 * Drizzle is a fluent builder: `.select().from(t).where(c).limit(1)` and the
 * result only appears when the chain is awaited. Mocking each method
 * separately, as a Prisma double did, gives a test that breaks whenever a
 * clause is added — so this returns itself from every call and decides what to
 * resolve to at the end, from the table that was asked for.
 *
 * Rows are keyed by table so a test says what the database holds rather than
 * what the query looks like:
 *
 *   const db = drizzleDouble([[devices, [aDevice]], [users, [anAdmin]]]);
 *
 * Writes resolve to whatever `returning()` should produce, or to an empty
 * result, and every call is recorded so a test can assert on what was bound.
 */

type Table = unknown;
type Rows = unknown[];

export interface DrizzleDouble {
  db: Record<string, jest.Mock> & { batch: jest.Mock };
  /** Every value bound into a where(), flattened — for scoping assertions. */
  boundValues(): string[];
  /** Tables written to, in order, so a test can assert a batch happened. */
  writes: { kind: 'insert' | 'update' | 'delete'; table: Table }[];
}

/** Every string anywhere in a condition, however deeply it is nested. */
export function stringsIn(value: unknown, found: string[] = [], seen = new Set<unknown>()): string[] {
  if (typeof value === 'string') found.push(value);
  else if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const v of Object.values(value as Record<string, unknown>)) stringsIn(v, found, seen);
  }
  return found;
}

export function drizzleDouble(
  tableRows: [Table, Rows][] = [],
  opts: { onWrite?: (kind: string, table: Table, values?: unknown) => Rows } = {},
): DrizzleDouble {
  const rowsFor = new Map<Table, Rows>(tableRows);
  const writes: { kind: 'insert' | 'update' | 'delete'; table: Table }[] = [];
  const whereCalls: unknown[] = [];

  let table: Table = null;
  let mode: 'read' | 'insert' | 'update' | 'delete' = 'read';
  let values: unknown;

  const resolveRows = (): Rows => {
    if (mode === 'read') return rowsFor.get(table) ?? [];
    return opts.onWrite?.(mode, table, values) ?? rowsFor.get(table) ?? [];
  };

  const chain: Record<string, jest.Mock> & { batch: jest.Mock } = {
    select: jest.fn(() => {
      mode = 'read';
      return chain;
    }),
    from: jest.fn((t: Table) => {
      table = t;
      return chain;
    }),
    insert: jest.fn((t: Table) => {
      mode = 'insert';
      table = t;
      writes.push({ kind: 'insert', table: t });
      return chain;
    }),
    update: jest.fn((t: Table) => {
      mode = 'update';
      table = t;
      writes.push({ kind: 'update', table: t });
      return chain;
    }),
    delete: jest.fn((t: Table) => {
      mode = 'delete';
      table = t;
      writes.push({ kind: 'delete', table: t });
      return chain;
    }),
    values: jest.fn((v: unknown) => {
      values = v;
      return chain;
    }),
    set: jest.fn((v: unknown) => {
      values = v;
      return chain;
    }),
    where: jest.fn((c: unknown) => {
      whereCalls.push(c);
      return chain;
    }),
    leftJoin: jest.fn(() => chain),
    innerJoin: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    offset: jest.fn(() => chain),
    returning: jest.fn(() => chain),
    onConflictDoUpdate: jest.fn(() => chain),
    onConflictDoNothing: jest.fn(() => chain),
    // A batch resolves to one result per statement, shaped like D1's.
    batch: jest.fn((stmts: unknown[]) =>
      Promise.resolve((stmts ?? []).map(() => ({ meta: { changes: 1 } }))),
    ),
    then: jest.fn((resolve: (rows: Rows) => unknown) => Promise.resolve(resolveRows()).then(resolve)),
  } as Record<string, jest.Mock> & { batch: jest.Mock };

  return {
    db: chain,
    boundValues: () => whereCalls.flatMap((c) => stringsIn(c)),
    writes,
  };
}
