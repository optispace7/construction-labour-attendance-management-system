import { TapSource } from '@prisma/client';

/**
 * What moved a session, in the words the person reading it uses.
 *
 * "Already logged out" is not enough to act on: the reviewer needs to know it
 * was the man's own badge that did it, and when, before they can be sure a
 * typed entry is safe to throw away. A tap says how it was read; when there is
 * no tap the session was moved from an office screen, and the closed reason
 * says which one.
 *
 * Lives here so the review queue and the scan path say it the same way — the
 * sentence a Safety Officer is refused with and the note left on the entry a
 * scan overtook are describing the same event.
 */
export function describeMovement(
  tap: { tapSource: TapSource; isManualBackup: boolean } | null,
  closedReason?: string | null,
): string {
  if (tap) {
    if (tap.isManualBackup || tap.tapSource === 'MANUAL') return 'an accepted manual entry';
    if (tap.tapSource === 'QR') return 'a QR badge scan';
    return 'an NFC badge scan';
  }
  switch (closedReason) {
    case 'CORRECTION':
      return 'an approved correction';
    case 'ADMIN_EDIT':
      return 'an edit in Fix attendance';
    case 'ADMIN_BULK_LOGOUT':
      return 'a bulk logout in Fix attendance';
    case 'MANUAL_APPROVED':
      return 'an accepted manual entry';
    default:
      return 'an administrator';
  }
}

/** Sentence-case for a phrase that has to start a sentence. */
export function capitalise(phrase: string): string {
  return phrase ? `${phrase[0].toUpperCase()}${phrase.slice(1)}` : phrase;
}
