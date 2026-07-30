'use client';

import * as React from 'react';

/**
 * Pages that stay out of the sidebar until someone asks for them.
 *
 * The safety board is being built while a client has a login to this panel, and
 * a half-finished page they can see is a page they will ask about. Hiding it
 * keeps it out of the way without branching the deployment.
 *
 * This is CONCEALMENT, NOT ACCESS CONTROL. Anyone who reaches the reveal
 * shortcut, or who already knows a URL, gets in; the API happily serves the data
 * to any user whose role holds the safety permissions. If the client must be
 * unable to reach it at all, that is a permissions change on the server, not
 * this flag.
 */
const KEY = 'clams:reveal-hidden';

/** Fired on the window when the flag flips, so every listener in the tab syncs. */
const EVENT = 'clams:reveal-hidden-changed';

export function isRevealed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    // Private browsing with storage denied — treat as hidden.
    return false;
  }
}

export function setRevealed(next: boolean): void {
  try {
    if (next) window.localStorage.setItem(KEY, '1');
    else window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to persist to; the in-memory state below still flips for this view.
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
}

export function toggleRevealed(): boolean {
  const next = !isRevealed();
  setRevealed(next);
  return next;
}

/**
 * Whether hidden pages are currently showing.
 *
 * Starts false on both server and client so the first paint matches the markup
 * React rendered on the server, then corrects itself in an effect — reading
 * localStorage during render is a hydration mismatch waiting to happen.
 */
export function useRevealedState(): { revealed: boolean; ready: boolean } {
  const [state, setState] = React.useState({ revealed: false, ready: false });

  React.useEffect(() => {
    setState({ revealed: isRevealed(), ready: true });
    const onCustom = (e: Event) =>
      setState({ revealed: (e as CustomEvent<boolean>).detail, ready: true });
    // `storage` covers the other tabs; the custom event covers this one.
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY || e.key === null) setState({ revealed: isRevealed(), ready: true });
    };
    window.addEventListener(EVENT, onCustom);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(EVENT, onCustom);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return state;
}

export function useRevealed(): boolean {
  return useRevealedState().revealed;
}

/**
 * True when the event is the reveal chord.
 *
 * Ctrl/Cmd+H is what was asked for, but it is the browser's History shortcut and
 * some browsers claim it before a page ever sees it. Ctrl/Cmd+Shift+H is
 * accepted as well so there is always a combination that works.
 */
export function isRevealChord(e: KeyboardEvent): boolean {
  if (!(e.ctrlKey || e.metaKey)) return false;
  if (e.altKey) return false;
  return e.key === 'h' || e.key === 'H';
}

/**
 * Ignore the chord while someone is typing — a comment box on the daily sheet
 * should never have a keystroke swallowed by a shortcut.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
