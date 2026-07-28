'use client';

import * as React from 'react';
import { ThemeProvider, CssBaseline, GlobalStyles } from '@mui/material';
import { ColorMode, globalThemeCss } from './tokens';
import { themeFor } from './theme';

const STORAGE_KEY = 'clams.colorMode';

/** Built once at module load — it never varies with the selected mode. */
const GLOBAL_THEME_CSS = globalThemeCss();

interface ColorModeContextValue {
  mode: ColorMode;
  /** What the user actually chose. 'system' follows the OS. */
  preference: ColorMode | 'system';
  setPreference: (p: ColorMode | 'system') => void;
  toggle: () => void;
}

const ColorModeContext = React.createContext<ColorModeContextValue>({
  mode: 'dark',
  preference: 'dark',
  setPreference: () => {},
  toggle: () => {},
});

export const useColorMode = () => React.useContext(ColorModeContext);

/**
 * The script that runs before React does.
 *
 * Without it the server renders the default mode, the browser paints it, and
 * only then does React read localStorage and repaint — a white flash on every
 * load for anyone using dark mode, which is exactly the audience that notices.
 * Being `dangerouslySetInnerHTML` in `<head>` is the point: it must execute
 * synchronously, before first paint.
 *
 * It sets `data-theme` and the page background on <html>, so even the area
 * outside React's root is already the right colour.
 */
export const colorModeScript = `
(function () {
  try {
    var stored = localStorage.getItem('${STORAGE_KEY}');
    var mode;
    if (stored === 'light' || stored === 'dark') {
      mode = stored;
    } else if (stored === 'system') {
      mode = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    } else {
      // Nothing stored at all: dark, whatever the operating system prefers.
      // This is a control-room product that spends its day on a wall display,
      // and it was specified to open dark for everyone. 'system' is still
      // available, but only if somebody chooses it. Must match resolve() below
      // exactly, or the first React render contradicts what was just painted.
      mode = 'dark';
    }
    var el = document.documentElement;
    el.setAttribute('data-theme', mode);
    el.style.colorScheme = mode;
    el.style.backgroundColor = mode === 'dark' ? '#0A1219' : '#F5F6F8';
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
`;

/**
 * An unset preference is dark, matching the pre-paint script exactly. Returning
 * 'system' here would let React resolve to light on a light OS and contradict
 * the dark the browser had already painted.
 */
function readPreference(): ColorMode | 'system' {
  if (typeof window === 'undefined') return 'dark';
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'dark';
}

/**
 * Layout effects run before the browser paints; plain effects run after. Syncing
 * the mode in a plain effect would let one frame of the SSR default through,
 * which is the flash this whole dance exists to avoid. On the server there is no
 * layout phase, so fall back to the passive one to keep React quiet.
 */
const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? React.useLayoutEffect : React.useEffect;

function resolve(preference: ColorMode | 'system'): ColorMode {
  if (preference !== 'system') return preference;
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/**
 * Holds the colour mode, persists it, and publishes the tokens as CSS variables
 * so raw SVG and CSS can use them alongside the MUI theme.
 *
 * Dark is the default for a first-time visitor whose OS expresses no preference
 * — this is a control room product that spends its day on a wall display.
 */
export function ColorModeProvider({ children }: { children: React.ReactNode }) {
  // Must match what the pre-paint script assumes, or the first React render
  // would disagree with the DOM and hydration would complain.
  const [preference, setPreferenceState] = React.useState<ColorMode | 'system'>('dark');
  const [mode, setMode] = React.useState<ColorMode>('dark');
  const [ready, setReady] = React.useState(false);

  useIsomorphicLayoutEffect(() => {
    const p = readPreference();
    setPreferenceState(p);
    setMode(resolve(p));
    setReady(true);
  }, []);

  // Follow the OS live, but only while the user is actually on 'system'.
  React.useEffect(() => {
    if (preference !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => setMode(mq.matches ? 'light' : 'dark');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [preference]);

  useIsomorphicLayoutEffect(() => {
    if (!ready) return;
    const el = document.documentElement;
    el.setAttribute('data-theme', mode);
    el.style.colorScheme = mode;
    el.style.backgroundColor = mode === 'dark' ? '#0A1219' : '#F5F6F8';
  }, [mode, ready]);

  const setPreference = React.useCallback((p: ColorMode | 'system') => {
    setPreferenceState(p);
    setMode(resolve(p));
    try {
      window.localStorage.setItem(STORAGE_KEY, p);
    } catch {
      // Private mode or a locked-down browser — the theme still applies for
      // this session, it just will not be remembered.
    }
  }, []);

  const toggle = React.useCallback(
    () => setPreference(mode === 'dark' ? 'light' : 'dark'),
    [mode, setPreference],
  );

  const value = React.useMemo(
    () => ({ mode, preference, setPreference, toggle }),
    [mode, preference, setPreference, toggle],
  );

  const theme = React.useMemo(() => themeFor(mode), [mode]);

  return (
    <ColorModeContext.Provider value={value}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {/* Both modes, always present, chosen by the data-theme attribute.
            Independent of `mode` on purpose: it injects once and never has to
            win an ordering fight with a server-rendered copy of itself. */}
        <GlobalStyles styles={GLOBAL_THEME_CSS} />
        {children}
      </ThemeProvider>
    </ColorModeContext.Provider>
  );
}
