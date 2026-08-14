/**
 * Semantic design tokens for the CLAMS admin, in both colour modes.
 *
 * Every token is named for the *job it does*, never for the colour it happens to
 * be — `surfaceCard`, not `slate800`. That is what makes two themes possible
 * without a second set of components: a card asks for `surfaceCard` and gets the
 * right answer in either mode.
 *
 * The dark set is the default and was designed first: deep charcoal rather than
 * black, so shadows and elevation still read; surfaces that step up in small,
 * even increments; and status colours lifted in lightness to survive on a dark
 * ground, where the light-mode versions would look muddy. The light set is a
 * separate design rather than an inversion — light UIs carry contrast with
 * shadow and hairline borders, dark UIs carry it with surface lightness.
 */

export type ColorMode = 'light' | 'dark';

export interface SemanticTokens {
  /** The page itself, behind everything. */
  bg: string;
  /** A faint wash that gives the page depth without a visible gradient. */
  bgAccent: string;
  /** Cards, panels — the default raised surface. */
  surface: string;
  /** One step up: popovers, dropdowns, tooltips, sticky headers. */
  surfaceElevated: string;
  /** Insets: table heads, code, chart plot backgrounds. */
  surfaceSunken: string;
  /** Row/card hover. */
  surfaceHover: string;
  /** The current row, tab or filter chip. */
  surfaceSelected: string;

  /** Hairlines between things. */
  border: string;
  /** A stronger rule where a hairline disappears. */
  borderStrong: string;

  /** Headings, metric values — the text you read first. */
  textPrimary: string;
  /** Labels, descriptions, axis text. */
  textSecondary: string;
  /** Units, placeholders, disabled — present but quiet. */
  textMuted: string;
  /** Text on a filled brand/status surface. */
  textOnBrand: string;

  /** House colour. Actions, the primary series, focus rings. */
  brand: string;
  brandHover: string;
  /** A tint of brand for fills and selected backgrounds. */
  brandSubtle: string;

  /** Present, on time, healthy. */
  positive: string;
  positiveSubtle: string;
  /** Needs a look: missed logouts, pending review. */
  warning: string;
  warningSubtle: string;
  /** Absent, failed, over limit. */
  critical: string;
  criticalSubtle: string;
  /** Neutral information: visitors, counts, "for context". */
  info: string;
  infoSubtle: string;

  /** Chart furniture. */
  chartGrid: string;
  chartAxis: string;
  chartLabel: string;
  chartTooltipBg: string;
  chartTooltipBorder: string;
  chartTooltipText: string;
  /** A series with no meaning of its own — comparisons, "other". */
  chartNeutral: string;

  /** Card and popover shadows. */
  shadowCard: string;
  shadowElevated: string;
}

/**
 * Dark first. Charcoal, not black: #0D1117 leaves room for surfaces to step up
 * three times and still stay below pure white text, which is what makes a dark
 * UI feel deep rather than flat.
 */
export const darkTokens: SemanticTokens = {
  // Deep blue-teal navy rather than neutral charcoal. #141F29 is the card
  // surface; the page sits well below it so panels lift off the background
  // instead of dissolving into it.
  //
  // The step from page to card used to be about seven points per channel, which
  // is under the threshold most screens in a site office resolve at all — the
  // cards read as very slightly different rectangles rather than as raised
  // surfaces. It is roughly doubled here: the page drops, the card rises, and
  // the gap between them is what carries the elevation. Everything above the
  // card keeps a smaller, even step so the hierarchy stays legible rather than
  // turning into stripes.
  bg: '#060D13',
  bgAccent: '#0A131A',
  surface: '#141F29',
  surfaceElevated: '#1C2A35',
  surfaceSunken: '#0E1821',
  surfaceHover: '#1A2733',
  surfaceSelected: '#223746',

  border: '#2A3A46',
  borderStrong: '#3C505E',

  textPrimary: '#E9EFF2',
  textSecondary: '#95A8B3',
  textMuted: '#697E8A',
  textOnBrand: '#FFFFFF',

  // Lifted from the light-mode indigo: #3E5BA9 goes muddy on charcoal.
  brand: '#6E8FE8',
  brandHover: '#89A4EE',
  brandSubtle: 'rgba(110, 143, 232, 0.14)',

  positive: '#3FBF87',
  positiveSubtle: 'rgba(63, 191, 135, 0.14)',
  warning: '#E0A438',
  warningSubtle: 'rgba(224, 164, 56, 0.14)',
  critical: '#EE6A6A',
  criticalSubtle: 'rgba(238, 106, 106, 0.14)',
  info: '#57B6D9',
  infoSubtle: 'rgba(87, 182, 217, 0.14)',

  chartGrid: 'rgba(255, 255, 255, 0.06)',
  chartAxis: '#354854',
  chartLabel: '#8B9EAA',
  chartTooltipBg: '#17242E',
  chartTooltipBorder: '#354854',
  chartTooltipText: '#E9EFF2',
  chartNeutral: '#5A6C79',

  // Three layers, not two: a contact shadow that seats the card on the page, a
  // mid spread that gives it thickness, and a wide soft one that reads as the
  // room it sits in. A single 1–3px shadow is invisible on a dark ground, which
  // is why the old cards relied entirely on surface lightness to be seen.
  shadowCard:
    '0 1px 2px rgba(0,0,0,0.6), 0 6px 16px -4px rgba(0,0,0,0.55), 0 16px 32px -12px rgba(0,0,0,0.45)',
  shadowElevated: '0 20px 48px -16px rgba(0,0,0,0.75)',
};

/**
 * Hues for the vendor donut, kept apart from the general categorical palette.
 *
 * A donut sets slices directly against one another with no axis to separate
 * them, so it needs more hue distance than a bar chart does — these are picked
 * to stay apart on the navy ground and to survive the common colour-vision
 * deficiencies. Lifted from the panel this chart was modelled on.
 */
export const donutPalette = [
  '#19C7D4',
  '#FF7A00',
  '#F4C430',
  '#3887D7',
  '#EF5B3E',
  '#A5D84E',
  '#B79CE8',
  '#E7EDF0',
];

/**
 * Light, designed on its own terms. Contrast here comes from shadow and
 * hairlines, so surfaces stay close together and the status colours drop back to
 * their deeper, more saturated versions.
 */
export const lightTokens: SemanticTokens = {
  bg: '#F5F6F8',
  bgAccent: '#EFF1F5',
  surface: '#FFFFFF',
  surfaceElevated: '#FFFFFF',
  surfaceSunken: '#FAFBFC',
  surfaceHover: '#F4F6F9',
  surfaceSelected: '#EAF0FB',

  border: '#E3E6EB',
  borderStrong: '#CFD5DE',

  textPrimary: '#161D28',
  textSecondary: '#5B6675',
  textMuted: '#8792A2',
  textOnBrand: '#FFFFFF',

  brand: '#3E5BA9',
  brandHover: '#2F4685',
  brandSubtle: 'rgba(62, 91, 169, 0.09)',

  positive: '#1E7F4F',
  positiveSubtle: 'rgba(30, 127, 79, 0.10)',
  warning: '#B7791F',
  warningSubtle: 'rgba(183, 121, 31, 0.11)',
  critical: '#C03434',
  criticalSubtle: 'rgba(192, 52, 52, 0.09)',
  info: '#2B6CB0',
  infoSubtle: 'rgba(43, 108, 176, 0.09)',

  chartGrid: 'rgba(22, 29, 40, 0.07)',
  chartAxis: '#CFD5DE',
  chartLabel: '#5B6675',
  chartTooltipBg: '#1C2431',
  chartTooltipBorder: '#33404F',
  chartTooltipText: '#F2F5F9',
  chartNeutral: '#98A2B3',

  // Light mode carries elevation with shadow rather than surface lightness —
  // white cards on a near-white page have nowhere to go. Two layers so the card
  // has a contact edge as well as a soft spread.
  shadowCard: '0 1px 2px rgba(16,24,40,0.06), 0 4px 12px -4px rgba(16,24,40,0.10)',
  shadowElevated: '0 16px 40px -12px rgba(16,24,40,0.22)',
};

export const tokensFor = (mode: ColorMode): SemanticTokens =>
  mode === 'dark' ? darkTokens : lightTokens;

/**
 * Categorical hues for series that stand for *things* (vendors, trades) rather
 * than states. Ordered so neighbours alternate warm and cool, which is what
 * keeps adjacent bars and slices apart for the colour-blind as well.
 *
 * Status never comes from here — present is always `positive`, absent always
 * `critical`, wherever it appears.
 */
export const categoricalPalette = (mode: ColorMode): string[] =>
  mode === 'dark'
    ? ['#6E8FE8', '#E0A438', '#4FC3D9', '#E88A6E', '#A98AE8', '#3FBF87', '#E88AB8', '#7FA9F0']
    : ['#3E5BA9', '#B7791F', '#0091AD', '#A8452B', '#7C4DBE', '#1E7F4F', '#9B2C6F', '#2B6CB0'];

/**
 * A hex colour as the bare `r g b` channels Tailwind needs, or null if the
 * value is not a plain hex (the `*Subtle` tints are already rgba, the shadows
 * are whole declarations).
 */
function channels(value: string): string | null {
  const m = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

/**
 * The CSS custom properties the tokens are published as, for SVG and raw CSS.
 *
 * Every hex token is published twice: once whole (`--clams-brand: #6E8FE8`),
 * which is what SVG attributes and hand-written CSS want, and once as bare
 * channels (`--clams-brand-rgb: 110 143 232`), which is the only form Tailwind
 * can fold an opacity into.
 *
 * That second form is not a nicety. With `brand: 'var(--clams-brand)'` in the
 * config, Tailwind cannot build `ring-brand/25` at all and silently emits
 * nothing for it — so the emphasis cards were drawing Tailwind's *default*
 * ring, a stock #3B82F6 blue that belongs to no palette in this product. Every
 * `token/opacity` class in the panel was failing the same quiet way.
 */
export function cssVariables(mode: ColorMode): Record<string, string> {
  const t = tokensFor(mode);
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(t)) {
    // camelCase -> --clams-kebab-case
    const name = `--clams-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    vars[name] = value;
    const rgb = channels(value);
    if (rgb) vars[`${name}-rgb`] = rgb;
  }
  // The categorical hues too, as `--clams-series-1` … `-8`.
  //
  // Recharts needs a concrete value for an SVG *attribute* — `stroke="var(…)"`
  // does not resolve — so charts keep reading the palette through `useTokens`.
  // Plain DOM in those panels (legend dots, share bars, a hand-drawn dial) must
  // not: the server renders in dark mode, and React 18 reports a hydration
  // mismatch on a colour prop without ever patching the attribute, so a light
  // page keeps whatever hue the server picked. A `var()` is the same string in
  // both renders and lets CSS choose the value.
  categoricalPalette(mode).forEach((hex, i) => {
    vars[`--clams-series-${i + 1}`] = hex;
  });
  return vars;
}

/**
 * Page-level styling for BOTH modes in one static block, selected by the
 * `data-theme` attribute the pre-paint script writes onto <html>.
 *
 * This deliberately does not live in the theme's `MuiCssBaseline` overrides.
 * Those are generated per theme object, so the server renders the default
 * mode's globals into the HTML and the client then injects the other mode's —
 * two rules of equal specificity whose winner is decided by insertion order.
 * The observable result was a light-mode page that kept a charcoal body behind
 * white cards. Emitting both rules once, and letting an attribute choose, has
 * no ordering to get wrong and needs no re-injection when the mode flips.
 */
export function globalThemeCss(): string {
  const block = (mode: ColorMode) => {
    const t = tokensFor(mode);
    const vars = Object.entries(cssVariables(mode))
      .map(([k, v]) => `  ${k}: ${v};`)
      .join('\n');
    /**
     * Dark mode gets a fine engineering grid over two very wide, very faint
     * washes. The grid is what stops a large dark surface reading as a flat
     * void — at 2.2% white on a 28px pitch it is barely a texture, felt more
     * than seen, and it mostly shows in the gutters between cards where it
     * cannot compete with any text.
     *
     * Light mode gets the wash only. A grid on a near-white page reads as
     * graph paper, not as depth.
     */
    const grid = `linear-gradient(rgba(255,255,255,0.022) 1px, transparent 1px),
       linear-gradient(90deg, rgba(255,255,255,0.022) 1px, transparent 1px)`;
    const wash =
      mode === 'dark'
        ? `${grid},
       radial-gradient(1200px 600px at 12% -10%, rgba(25,199,212,0.05), transparent 60%),
       radial-gradient(1000px 520px at 100% 0%, rgba(110,143,232,0.05), transparent 55%)`
        : `radial-gradient(1100px 560px at 10% -12%, rgba(62,91,169,0.05), transparent 60%)`;
    // The two grid layers are sized; the washes stay at their natural size.
    const size = mode === 'dark' ? '28px 28px, 28px 28px, auto, auto' : 'auto';

    return `
html[data-theme='${mode}'] {
${vars}
  color-scheme: ${mode};
  background-color: ${t.bg};
}
html[data-theme='${mode}'] body {
  background-color: ${t.bg};
  color: ${t.textPrimary};
  background-image: ${wash};
  background-size: ${size};
  background-attachment: fixed;
}`;
  };

  return `${block('dark')}\n${block('light')}
body {
  /* Only colours cross-fade on a mode change. Leaving layout and transform out
     keeps the switch from animating the whole page. */
  transition: background-color 220ms ease, color 220ms ease;
}`;
}
