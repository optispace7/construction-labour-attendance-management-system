/**
 * D1 allows 100 bound parameters per query.
 *
 * That is easy to forget, because it only bites at real data volumes: a list
 * that holds three ids in a test holds three hundred in production, and the
 * query fails there and nowhere else. Anywhere an `IN (...)` is built from a
 * list whose length the code does not control, the list is read in chunks and
 * the results concatenated.
 *
 *   const items = await chunked(requestIds, (ids) =>
 *     db.select().from(correctionItems).where(inArray(correctionItems.requestId, ids)),
 *   );
 *
 * The chunk is smaller than the cap so a query is free to bind a few values of
 * its own alongside the list.
 */
const CHUNK = 80;

export async function chunked<T, R>(
  values: T[],
  read: (chunk: T[]) => Promise<R[]>,
): Promise<R[]> {
  if (values.length === 0) return [];
  if (values.length <= CHUNK) return read(values);
  const out: R[] = [];
  for (let i = 0; i < values.length; i += CHUNK) {
    out.push(...(await read(values.slice(i, i + CHUNK))));
  }
  return out;
}

/** The same, for a write that takes a list — a delete of many keys. */
export async function chunkedWrite<T>(
  values: T[],
  write: (chunk: T[]) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < values.length; i += CHUNK) {
    await write(values.slice(i, i + CHUNK));
  }
}
