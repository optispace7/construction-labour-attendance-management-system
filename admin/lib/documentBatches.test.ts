import { describe, expect, it, vi } from 'vitest';
import { chunkIds, DownloadError, downloadInGroups } from './documentBatches';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `w${i + 1}`);
const zip = new Blob(['zip']);

describe('chunkIds', () => {
  it('splits into groups of the given size, keeping order', () => {
    expect(chunkIds(ids(5), 2)).toEqual([['w1', 'w2'], ['w3', 'w4'], ['w5']]);
    expect(chunkIds([], 2)).toEqual([]);
  });
});

describe('downloadInGroups', () => {
  it('saves a small selection as one plainly named zip', async () => {
    const save = vi.fn();
    const n = await downloadInGroups(ids(3), async () => zip, save, 25);
    expect(n).toBe(1);
    expect(save).toHaveBeenCalledWith(zip, 1, false);
  });

  it('asks for a large selection in groups and numbers every part', async () => {
    const asked: string[][] = [];
    const save = vi.fn();
    const n = await downloadInGroups(
      ids(60),
      async (group) => {
        asked.push(group);
        return zip;
      },
      save,
      25,
    );
    expect(asked.map((g) => g.length)).toEqual([25, 25, 10]);
    expect(n).toBe(3);
    expect(save.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [1, true],
      [2, true],
      [3, true],
    ]);
  });

  it('splits a group the server finds too large and asks again', async () => {
    const asked: number[] = [];
    const n = await downloadInGroups(
      ids(8),
      async (group) => {
        asked.push(group.length);
        if (group.length > 2) throw new DownloadError(413, 'too large');
        return zip;
      },
      () => {},
      8,
    );
    // 8 → 4 + 4 → each 4 → 2 + 2.
    expect(asked).toEqual([8, 4, 2, 2, 4, 2, 2]);
    expect(n).toBe(4);
  });

  it('names the parts of a split even when it began as one group', async () => {
    const save = vi.fn();
    await downloadInGroups(
      ids(2),
      async (group) => {
        if (group.length > 1) throw new DownloadError(413, 'too large');
        return zip;
      },
      save,
      25,
    );
    expect(save.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [1, true],
      [2, true],
    ]);
  });

  it('gives up on one person who is still too large, and on any other refusal', async () => {
    await expect(
      downloadInGroups(
        ids(1),
        async () => {
          throw new DownloadError(413, 'too large');
        },
        () => {},
      ),
    ).rejects.toThrow('too large');

    const save = vi.fn();
    await expect(
      downloadInGroups(
        ids(30),
        async () => {
          throw new DownloadError(403, 'no permission');
        },
        save,
        25,
      ),
    ).rejects.toThrow('no permission');
    expect(save).not.toHaveBeenCalled();
  });
});
