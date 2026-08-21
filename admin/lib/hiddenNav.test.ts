import { describe, it, expect } from 'vitest';
import { isRevealChord, isTypingTarget } from './hiddenNav';
import { isHiddenFor, isPathHiddenFor, navForRole, NAV_ITEMS } from './rbac';

/** A KeyboardEvent-shaped object; the real class needs a DOM. */
const chord = (over: Partial<KeyboardEvent>) =>
  ({ key: 'h', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over }) as KeyboardEvent;

describe('isRevealChord', () => {
  it('accepts Ctrl+H', () => {
    expect(isRevealChord(chord({ ctrlKey: true }))).toBe(true);
  });

  it('accepts Cmd+H, for the Mac', () => {
    expect(isRevealChord(chord({ metaKey: true }))).toBe(true);
  });

  it('accepts the Shift variant, since a browser may eat plain Ctrl+H', () => {
    expect(isRevealChord(chord({ ctrlKey: true, shiftKey: true, key: 'H' }))).toBe(true);
  });

  it('ignores H on its own — people type it constantly', () => {
    expect(isRevealChord(chord({}))).toBe(false);
  });

  it('ignores other modified keys', () => {
    expect(isRevealChord(chord({ ctrlKey: true, key: 'k' }))).toBe(false);
    expect(isRevealChord(chord({ ctrlKey: true, key: 's' }))).toBe(false);
  });

  it('ignores Alt combinations, which belong to the OS menus', () => {
    expect(isRevealChord(chord({ ctrlKey: true, altKey: true }))).toBe(false);
  });
});

describe('isTypingTarget', () => {
  it('is true for the fields a comment box is made of', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(isTypingTarget({ tagName, isContentEditable: false } as unknown as EventTarget)).toBe(
        true,
      );
    }
  });

  it('is true for a contenteditable region', () => {
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(
      true,
    );
  });

  it('is false for ordinary elements and for nothing at all', () => {
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: false } as unknown as EventTarget)).toBe(
      false,
    );
    expect(isTypingTarget(null)).toBe(false);
  });
});

const visibleFor = (role: Parameters<typeof navForRole>[0]) =>
  navForRole(role)
    .filter((i) => !isHiddenFor(i, role))
    .map((i) => i.href);

describe('hidden nav items', () => {
  it('gives every role that carries the safety pages an ordinary sidebar entry', () => {
    // They were concealed from the admin roles while the board was in progress.
    // It has shipped, so the chord is no longer between anyone and the page.
    for (const role of ['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR'] as const) {
      const visible = visibleFor(role);
      expect(visible).toContain('/safety');
      expect(visible).toContain('/safety/daily');
    }
  });

  it('conceals nothing from anyone', () => {
    // The machinery stays for the next page that needs shaping in production;
    // what it must not do is keep hiding a board that is finished.
    expect(NAV_ITEMS.filter((i) => i.hiddenFor?.length)).toEqual([]);
    for (const role of ['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR'] as const) {
      for (const path of ['/', '/attendance', '/reports', '/workers', '/safety', '/safety/daily']) {
        expect(isPathHiddenFor(role, path)).toBe(false);
      }
    }
  });

  it('leaves the everyday pages visible', () => {
    const visible = visibleFor('SUPERVISOR');
    expect(visible).toContain('/');
    expect(visible).toContain('/attendance');
    expect(visible).toContain('/reports');
  });
});
