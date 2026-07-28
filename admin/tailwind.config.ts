import type { Config } from 'tailwindcss';

/**
 * Tailwind, deliberately scoped so it can live beside MUI.
 *
 * Two settings make the coexistence safe:
 *
 *  - `preflight: false`. Tailwind's reset is aggressive — it strips heading
 *    sizes, list markers and button styling globally. Every other page in this
 *    panel is MUI and expects its own baseline, so turning the reset on would
 *    quietly damage pages nobody touched.
 *  - `darkMode` keyed to the `data-theme` attribute the colour-mode provider
 *    already writes onto <html>, so `dark:` variants follow the same switch as
 *    the MUI theme instead of a second, competing one.
 *
 * Colours are not literals: they point at the `--clams-*` custom properties
 * published from theme/tokens.ts. One source of truth, whichever styling system
 * a component happens to use.
 */
const config: Config = {
  darkMode: ['class', "[data-theme='dark']"],
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        // `rgb(var(--x-rgb) / <alpha-value>)`, not `var(--x)`. Tailwind can only
        // fold an opacity modifier into a colour it can take apart, and a bare
        // `var()` is opaque to it — `ring-brand/25` and `border-line/60` then
        // compile to nothing at all, with the classes still sitting in the DOM
        // looking correct. theme/tokens.ts publishes the channel form for every
        // hex token specifically so this works.
        //
        // The `subtle` tints stay as whole `var()`s: they are already rgba with
        // their alpha chosen deliberately, and nothing applies a modifier on
        // top of them.
        page: 'rgb(var(--clams-bg-rgb) / <alpha-value>)',
        'page-accent': 'rgb(var(--clams-bg-accent-rgb) / <alpha-value>)',
        surface: {
          DEFAULT: 'rgb(var(--clams-surface-rgb) / <alpha-value>)',
          elevated: 'rgb(var(--clams-surface-elevated-rgb) / <alpha-value>)',
          sunken: 'rgb(var(--clams-surface-sunken-rgb) / <alpha-value>)',
          hover: 'rgb(var(--clams-surface-hover-rgb) / <alpha-value>)',
          selected: 'rgb(var(--clams-surface-selected-rgb) / <alpha-value>)',
        },
        line: {
          DEFAULT: 'rgb(var(--clams-border-rgb) / <alpha-value>)',
          strong: 'rgb(var(--clams-border-strong-rgb) / <alpha-value>)',
        },
        ink: {
          DEFAULT: 'rgb(var(--clams-text-primary-rgb) / <alpha-value>)',
          muted: 'rgb(var(--clams-text-secondary-rgb) / <alpha-value>)',
          faint: 'rgb(var(--clams-text-muted-rgb) / <alpha-value>)',
          onBrand: 'rgb(var(--clams-text-on-brand-rgb) / <alpha-value>)',
        },
        brand: {
          DEFAULT: 'rgb(var(--clams-brand-rgb) / <alpha-value>)',
          hover: 'rgb(var(--clams-brand-hover-rgb) / <alpha-value>)',
          subtle: 'var(--clams-brand-subtle)',
        },
        positive: {
          DEFAULT: 'rgb(var(--clams-positive-rgb) / <alpha-value>)',
          subtle: 'var(--clams-positive-subtle)',
        },
        warning: {
          DEFAULT: 'rgb(var(--clams-warning-rgb) / <alpha-value>)',
          subtle: 'var(--clams-warning-subtle)',
        },
        critical: {
          DEFAULT: 'rgb(var(--clams-critical-rgb) / <alpha-value>)',
          subtle: 'var(--clams-critical-subtle)',
        },
        info: {
          DEFAULT: 'rgb(var(--clams-info-rgb) / <alpha-value>)',
          subtle: 'var(--clams-info-subtle)',
        },
      },
      borderRadius: {
        card: '14px',
        panel: '18px',
      },
      boxShadow: {
        card: 'var(--clams-shadow-card)',
        elevated: 'var(--clams-shadow-elevated)',
      },
      fontFamily: {
        sans: ['var(--font-plex)', 'IBM Plex Sans', 'Segoe UI', 'system-ui', 'sans-serif'],
      },
      keyframes: {
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        shimmer: 'shimmer 1.6s infinite',
      },
    },
  },
  plugins: [],
};

export default config;
