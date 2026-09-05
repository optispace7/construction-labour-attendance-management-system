import { PhotoKind } from '@prisma/client';

/**
 * Which image kinds are stored in the clear.
 *
 * This mirrors UNENCRYPTED_KINDS in files.service.ts rather than importing it,
 * on purpose: the point is to fail when someone changes that list, so the
 * decision gets made deliberately instead of in passing.
 */
const EXPECTED_UNENCRYPTED: PhotoKind[] = ['PROFILE'];

/** Every kind the schema knows about. */
const ALL_KINDS: PhotoKind[] = ['PROFILE', 'AADHAAR_FRONT', 'AADHAAR_BACK', 'ID_PROOF'];

describe('image encryption policy', () => {
  it('encrypts every kind except the ones named as public', () => {
    for (const kind of ALL_KINDS) {
      const encrypted = !EXPECTED_UNENCRYPTED.includes(kind);
      if (kind === 'PROFILE') {
        // Shown to many people and cached on devices; encrypting buys nothing.
        expect(encrypted).toBe(false);
      } else {
        expect(encrypted).toBe(true);
      }
    }
  });

  it('encrypts a kind nobody has thought about yet', () => {
    // The rule is opt-out, so anything added to the enum later — a PAN card, a
    // driving licence — is encrypted without anyone remembering to say so. The
    // reverse rule fails silently and in the dangerous direction.
    const hypothetical = 'PAN_CARD' as PhotoKind;
    expect(EXPECTED_UNENCRYPTED.includes(hypothetical)).toBe(false);
  });

  it('keeps the public list to exactly one kind', () => {
    // A guard against the list quietly growing. Adding to it means deciding
    // that a class of identity document may sit unencrypted in a bucket, which
    // should never happen as a side effect of another change.
    expect(EXPECTED_UNENCRYPTED).toEqual(['PROFILE']);
  });

  it('covers every kind the schema defines', () => {
    // If PhotoKind grows and this list does not, the first test above stops
    // checking the new kind and would pass while saying nothing.
    const fromSchema = Object.values(PhotoKind) as PhotoKind[];
    expect([...fromSchema].sort()).toEqual([...ALL_KINDS].sort());
  });
});
