/**
 * Worker document downloads, in groups the server can build.
 *
 * The server builds each zip whole in memory and refuses one past its ceiling
 * (HTTP 413). Everyone's photos and ID cards together run to hundreds of MB, so
 * a big selection comes down as several zips rather than one that can never be
 * made.
 */

/**
 * People per zip. Stored documents average about 0.6 MB a person and reach
 * about 1.2 MB, so 25 people stay inside the server's 30 MB ceiling even at the
 * heaviest.
 */
export const PEOPLE_PER_ZIP = 25;

/** A download the server refused, with its HTTP status and what to tell the user. */
export class DownloadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

export function chunkIds(ids: string[], size = PEOPLE_PER_ZIP): string[][] {
  const groups: string[][] = [];
  for (let i = 0; i < ids.length; i += size) groups.push(ids.slice(i, i + size));
  return groups;
}

/**
 * Fetches `ids` as zips of at most `size` people and hands each to `save`.
 *
 * A group the server still finds too large is split in half and asked for
 * again, down to a single person — the size limit is on bytes, and a few people
 * with unusually large scans can pass it in fewer than `size`. Any other
 * refusal stops the download and is thrown.
 *
 * `save` is told whether this download is one of several, so a lone zip keeps
 * a plain name. Returns how many zips were saved.
 */
export async function downloadInGroups(
  ids: string[],
  fetchZip: (group: string[]) => Promise<Blob>,
  save: (blob: Blob, part: number, multiple: boolean) => void,
  size = PEOPLE_PER_ZIP,
): Promise<number> {
  const queue = chunkIds(ids, size);
  let saved = 0;
  while (queue.length > 0) {
    const group = queue.shift()!;
    try {
      const blob = await fetchZip(group);
      saved += 1;
      save(blob, saved, saved > 1 || queue.length > 0);
    } catch (e) {
      if (e instanceof DownloadError && e.status === 413 && group.length > 1) {
        const half = Math.ceil(group.length / 2);
        queue.unshift(group.slice(0, half), group.slice(half));
        continue;
      }
      throw e;
    }
  }
  return saved;
}
