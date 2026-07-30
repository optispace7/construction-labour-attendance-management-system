import { describe, it, expect } from 'vitest';
import { isRevealChord, isTypingTarget } from './hiddenNav';
import { navForRole, NAV_ITEMS } from './rbac';

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

describe('hidden nav items', () => {
  it('keeps the safety pages out of every role\'s visible nav', () => {
    // navForRole still returns them — the shell filters on `hidden` — so the
    // guarantee being checked is that they are flagged, for all three roles.
    for (const role of ['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR'] as const) {
      const visible = navForRole(role).filter((i) => !i.hidden).map((i) => i.href);
      expect(visible).not.toContain('/safety');
      expect(visible).not.toContain('/safety/daily');
    }
  });

  it('flags exactly the two safety pages as hidden', () => {
    const hidden = NAV_ITEMS.filter((i) => i.hidden).map((i) => i.href).sort();
    expect(hidden).toEqual(['/safety', '/safety/daily']);
  });

  it('leaves the everyday pages visible', () => {
    const visible = navForRole('SUPERVISOR').filter((i) => !i.hidden).map((i) => i.href);
    expect(visible).toContain('/');
    expect(visible).toContain('/attendance');
    expect(visible).toContain('/reports');
  });
});
