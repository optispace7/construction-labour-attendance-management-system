'use client';

import { createTheme, alpha, Theme } from '@mui/material/styles';
import { ColorMode, SemanticTokens, tokensFor } from './tokens';

/**
 * Legacy flat token export.
 *
 * Predates the two-mode system and is still imported by the print artefacts
 * (ID cards, QR badges, safety seals), which are deliberately fixed to the light
 * palette — a badge comes out of a printer on white card whatever the operator's
 * screen is set to. New UI should read `useTheme().palette` or the semantic
 * tokens instead of reaching for these.
 */
export const tokens = {
  primary: '#3E5BA9',
  primaryDark: '#2F4685',
  accent: '#B7791F',
  bg: '#F4F5F7',
  paper: '#FFFFFF',
  border: '#E3E6EB',
  textPrimary: '#1C2430',
  textSecondary: '#5B6675',
  success: '#1E7F4F',
  warning: '#B7791F',
  error: '#C03434',
  info: '#2B6CB0',
  sidebarBg: '#151C28',
  sidebarText: '#9AA5B5',
  sidebarActive: '#FFFFFF',
};

const fontStack =
  'var(--font-plex), "IBM Plex Sans", "Segoe UI", system-ui, -apple-system, sans-serif';

/**
 * Extra fields hung off the MUI theme so components can reach the semantic
 * tokens without importing the mode separately. `theme.clams.surfaceSunken`
 * reads better at the call site than a second lookup, and it keeps the tokens
 * and the palette from drifting apart.
 */
declare module '@mui/material/styles' {
  interface Theme {
    clams: SemanticTokens;
  }
  interface ThemeOptions {
    clams?: SemanticTokens;
  }
}

function buildTheme(mode: ColorMode): Theme {
  const t = tokensFor(mode);
  const dark = mode === 'dark';

  return createTheme({
    clams: t,
    palette: {
      mode,
      primary: { main: t.brand, dark: t.brandHover, contrastText: t.textOnBrand },
      secondary: { main: t.warning },
      background: { default: t.bg, paper: t.surface },
      divider: t.border,
      text: { primary: t.textPrimary, secondary: t.textSecondary, disabled: t.textMuted },
      success: { main: t.positive },
      warning: { main: t.warning },
      error: { main: t.critical },
      info: { main: t.info },
      action: {
        hover: t.surfaceHover,
        selected: t.surfaceSelected,
        // MUI's defaults are tuned for light; on charcoal they vanish.
        disabled: t.textMuted,
        disabledBackground: dark ? 'rgba(255,255,255,0.06)' : 'rgba(16,24,40,0.06)',
      },
    },
    shape: { borderRadius: 12 },
    typography: {
      fontFamily: fontStack,
      // Metric values and table figures line up column-wise only with tabular
      // numerals; without this a changing KPI jitters as digits change width.
      h1: { fontWeight: 700, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums' },
      h2: { fontWeight: 700, letterSpacing: '-0.028em', fontVariantNumeric: 'tabular-nums' },
      h3: { fontWeight: 700, letterSpacing: '-0.025em', fontVariantNumeric: 'tabular-nums' },
      h4: { fontWeight: 680, letterSpacing: '-0.022em', fontVariantNumeric: 'tabular-nums' },
      h5: { fontWeight: 660, letterSpacing: '-0.018em' },
      h6: { fontWeight: 620, letterSpacing: '-0.012em' },
      subtitle1: { fontWeight: 620, letterSpacing: '-0.008em' },
      subtitle2: { fontWeight: 600 },
      body1: { lineHeight: 1.6 },
      body2: { lineHeight: 1.55 },
      button: { fontWeight: 600 },
      caption: { letterSpacing: 0, lineHeight: 1.45 },
      overline: { fontWeight: 650, letterSpacing: '0.08em', lineHeight: 1.4 },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          // The page background, text colour and CSS variables deliberately do
          // NOT live here — see globalThemeCss() in tokens.ts for why. Anything
          // in this block is regenerated per theme and is subject to the
          // server/client injection-order problem described there, so only
          // mode-independent rules belong in it.
          '*::-webkit-scrollbar': { width: 10, height: 10 },
          '*::-webkit-scrollbar-track': { background: 'transparent' },
          '*::-webkit-scrollbar-thumb': {
            backgroundColor: t.borderStrong,
            borderRadius: 8,
            border: '2px solid transparent',
            backgroundClip: 'content-box',
          },
          '*::-webkit-scrollbar-thumb:hover': { backgroundColor: t.textMuted },
          // One place to switch every entrance animation off for people who
          // asked their OS not to move things.
          '@media (prefers-reduced-motion: reduce)': {
            '*, *::before, *::after': {
              animationDuration: '0.01ms !important',
              animationIterationCount: '1 !important',
              transitionDuration: '0.01ms !important',
              scrollBehavior: 'auto !important',
            },
          },
        },
      },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: { textTransform: 'none', borderRadius: 9, paddingInline: 14 },
          containedPrimary: { '&:hover': { backgroundColor: t.brandHover } },
          outlined: { borderColor: t.border, '&:hover': { borderColor: t.borderStrong } },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: { backgroundImage: 'none', transition: 'background-color 220ms ease' },
          outlined: { borderColor: t.border },
        },
      },
      MuiCard: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: {
            backgroundColor: t.surface,
            border: `1px solid ${t.border}`,
            boxShadow: t.shadowCard,
            transition: 'background-color 220ms ease, border-color 220ms ease',
          },
        },
      },
      MuiTableHead: {
        styleOverrides: {
          root: {
            '& .MuiTableCell-head': {
              backgroundColor: t.surfaceSunken,
              color: t.textSecondary,
              fontSize: '0.72rem',
              fontWeight: 650,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              borderBottom: `1px solid ${t.border}`,
              whiteSpace: 'nowrap',
            },
          },
        },
      },
      MuiTableCell: {
        styleOverrides: { root: { borderBottom: `1px solid ${t.border}` } },
      },
      MuiTableRow: {
        styleOverrides: {
          root: {
            '&:last-child td': { borderBottom: 0 },
            '&.MuiTableRow-hover:hover': { backgroundColor: t.surfaceHover },
          },
        },
      },
      MuiChip: {
        styleOverrides: {
          root: { fontWeight: 600 },
          sizeSmall: { height: 22, fontSize: '0.72rem' },
          outlined: { borderColor: t.border },
        },
      },
      MuiDialog: {
        styleOverrides: {
          paper: {
            backgroundColor: t.surfaceElevated,
            borderRadius: 16,
            border: `1px solid ${t.border}`,
            boxShadow: t.shadowElevated,
          },
        },
      },
      MuiDialogTitle: { styleOverrides: { root: { fontWeight: 650 } } },
      MuiMenu: {
        styleOverrides: {
          paper: {
            backgroundColor: t.surfaceElevated,
            border: `1px solid ${t.border}`,
            boxShadow: t.shadowElevated,
          },
        },
      },
      MuiPopover: {
        styleOverrides: {
          paper: {
            backgroundColor: t.surfaceElevated,
            border: `1px solid ${t.border}`,
            boxShadow: t.shadowElevated,
          },
        },
      },
      MuiMenuItem: {
        styleOverrides: {
          root: {
            '&:hover': { backgroundColor: t.surfaceHover },
            '&.Mui-selected': {
              backgroundColor: t.surfaceSelected,
              '&:hover': { backgroundColor: t.surfaceSelected },
            },
          },
        },
      },
      MuiTextField: { defaultProps: { size: 'small' } },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            backgroundColor: t.surfaceSunken,
            '& .MuiOutlinedInput-notchedOutline': { borderColor: t.border },
            '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: t.borderStrong },
          },
        },
      },
      MuiTooltip: {
        styleOverrides: {
          tooltip: {
            backgroundColor: t.chartTooltipBg,
            color: t.chartTooltipText,
            border: `1px solid ${t.chartTooltipBorder}`,
            fontSize: '0.75rem',
            borderRadius: 9,
            boxShadow: t.shadowElevated,
            padding: '8px 10px',
          },
          arrow: { color: t.chartTooltipBg },
        },
      },
      MuiAlert: {
        styleOverrides: {
          root: { borderRadius: 11 },
          standardWarning: {
            backgroundColor: t.warningSubtle,
            color: t.textPrimary,
            border: `1px solid ${alpha(t.warning, 0.35)}`,
            '& .MuiAlert-icon': { color: t.warning },
          },
          standardError: {
            backgroundColor: t.criticalSubtle,
            color: t.textPrimary,
            border: `1px solid ${alpha(t.critical, 0.3)}`,
            '& .MuiAlert-icon': { color: t.critical },
          },
          standardSuccess: {
            backgroundColor: t.positiveSubtle,
            color: t.textPrimary,
            border: `1px solid ${alpha(t.positive, 0.3)}`,
            '& .MuiAlert-icon': { color: t.positive },
          },
          standardInfo: {
            backgroundColor: t.infoSubtle,
            color: t.textPrimary,
            border: `1px solid ${alpha(t.info, 0.3)}`,
            '& .MuiAlert-icon': { color: t.info },
          },
        },
      },
      MuiSkeleton: {
        styleOverrides: {
          root: { backgroundColor: dark ? 'rgba(255,255,255,0.06)' : 'rgba(16,24,40,0.07)' },
        },
      },
      MuiDivider: { styleOverrides: { root: { borderColor: t.border } } },
      MuiTabs: {
        styleOverrides: {
          root: { minHeight: 40 },
          indicator: { backgroundColor: t.brand },
        },
      },
      MuiTab: {
        styleOverrides: {
          root: {
            textTransform: 'none',
            fontWeight: 600,
            minHeight: 40,
            color: t.textSecondary,
            '&.Mui-selected': { color: t.textPrimary },
          },
        },
      },
      MuiLinearProgress: {
        styleOverrides: {
          root: { backgroundColor: t.surfaceSunken, borderRadius: 999 },
          bar: { borderRadius: 999 },
        },
      },
    },
  });
}

export const darkTheme = buildTheme('dark');
export const lightTheme = buildTheme('light');

/** Default export kept so existing imports of `theme` keep working. */
export const theme = darkTheme;

export const themeFor = (mode: ColorMode): Theme => (mode === 'dark' ? darkTheme : lightTheme);
