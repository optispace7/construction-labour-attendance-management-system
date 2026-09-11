import { AppException } from './app.exception';

/**
 * Turns a SQLite constraint failure into an answer a person can act on.
 *
 * Adding a vendor with a code another vendor already had came back as
 * "Internal server error". Underneath was
 *
 *   UNIQUE constraint failed: vendors.organization_id, vendors.code
 *
 * which says exactly what is wrong, and stopped at the server log. The panel
 * has no way to show which field to change, so the person retypes the same
 * code and gets the same nothing.
 *
 * Every table with a unique index has this problem, not just vendors, so the
 * translation lives here and the exception filter applies it to whatever comes
 * past. It reads the message rather than an error number because that is what
 * D1 gives us: the driver reports its own code for anything that went wrong,
 * and only the text says which constraint it was.
 */

/** The column that scopes almost every unique key here; naming it helps nobody. */
const SCOPE_COLUMNS = new Set(['organization_id', 'site_id']);

/** "worker_site_assignments" -> "worker site assignment" */
function label(table: string): string {
  const words = table.replace(/_/g, ' ').trim();
  // Crude but right for every table here: they are all plain plurals.
  return words.endsWith('ies')
    ? `${words.slice(0, -3)}y`
    : words.endsWith('s')
      ? words.slice(0, -1)
      : words;
}

/** "worker_code" -> "worker code" */
const field = (column: string) => column.replace(/_/g, ' ');

/**
 * Every message in the chain — Drizzle wraps the real one as `cause`.
 *
 * Matched on shape rather than `instanceof Error`, which is not reliable here:
 * the error that carries the constraint text is raised by the SQLite binding,
 * and an Error built in another realm fails the instanceof check while being an
 * Error in every way that matters. Written the other way, this walked one level
 * and found nothing.
 */
function messages(error: unknown): string[] {
  const out: string[] = [];
  let e: unknown = error;
  for (let i = 0; i < 6; i++) {
    if (typeof e !== 'object' || e === null) break;
    const message = (e as { message?: unknown }).message;
    if (typeof message === 'string') out.push(message);
    e = (e as { cause?: unknown }).cause;
  }
  return out;
}

export function constraintFailure(error: unknown): AppException | null {
  const text = messages(error).join(' | ');

  const unique = /UNIQUE constraint failed: ([^|\n]+)/.exec(text);
  if (unique) {
    const columns = unique[1]
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    const table = columns[0]?.split('.')[0] ?? '';
    const named = columns
      .map((c) => c.split('.')[1] ?? c)
      .filter((c) => !SCOPE_COLUMNS.has(c));
    // A key made only of scope columns means one row per site or organization.
    const what = named.length ? named.map(field).join(' and ') : 'these details';
    return new AppException({
      status: 409,
      code: 'DUPLICATE',
      title: 'Already in use',
      detail: `Another ${label(table)} already uses this ${what}. Choose a different one.`,
      meta: { table, columns: named },
    });
  }

  if (/FOREIGN KEY constraint failed/.test(text)) {
    return new AppException({
      status: 409,
      code: 'IN_USE',
      title: 'Still referenced',
      detail:
        'Something else in the system still refers to this record, so it cannot be ' +
        'changed or removed yet.',
    });
  }

  if (/NOT NULL constraint failed: ([^|\n]+)/.test(text)) {
    const m = /NOT NULL constraint failed: ([^|\n]+)/.exec(text)!;
    const column = m[1].trim().split('.')[1] ?? m[1].trim();
    // Not a validation failure the caller can fix by resending — the request
    // was accepted and the write was still short a column. Said plainly rather
    // than blamed on the person.
    return new AppException({
      status: 500,
      code: 'MISSING_COLUMN',
      title: 'Internal server error',
      detail: `The record could not be saved because ${field(column)} had no value.`,
      meta: { column },
    });
  }

  return null;
}
