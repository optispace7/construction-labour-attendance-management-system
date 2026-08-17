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
  it('keeps the safety pages out of the two admin roles’ visible nav', () => {
    // navForRole still returns them — the shell filters on `hiddenFor` — so the
    // guarantee being checked is that they are flagged for those roles.
    for (const role of ['SUPER_ADMIN', 'SITE_ADMIN'] as const) {
      const visible = visibleFor(role);
      expect(visible).not.toContain('/safety');
      expect(visible).not.toContain('/safety/daily');
    }
  });

  it('gives the safety officer the board without the chord — it is their record', () => {
    const visible = visibleFor('SUPERVISOR');
    expect(visible).toContain('/safety');
    expect(visible).toContain('/safety/daily');
    expect(isPathHiddenFor('SUPERVISOR', '/safety')).toBe(false);
    expect(isPathHiddenFor('SUPERVISOR', '/safety/daily')).toBe(false);
  });

  it('flags exactly the two safety pages, and only against the admin roles', () => {
    const hidden = NAV_ITEMS.filter((i) => i.hiddenFor?.length).map((i) => i.href).sort();
    expect(hidden).toEqual(['/safety', '/safety/daily']);
    for (const role of ['SUPER_ADMIN', 'SITE_ADMIN'] as const) {
      expect(isPathHiddenFor(role, '/safety')).toBe(true);
      // Resolved by the most specific rule, not by '/safety' swallowing it.
      expect(isPathHiddenFor(role, '/safety/daily')).toBe(true);
    }
  });

  it('conceals nothing else', () => {
    for (const role of ['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR'] as const) {
      for (const path of ['/', '/attendance', '/reports', '/workers']) {
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
