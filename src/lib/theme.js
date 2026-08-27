// Theme selection and the chart colours that go with it.
//
// Dark is not a flip of light. The chart hues are separately chosen steps,
// each validated against the surface it actually sits on — a pair that
// separates cleanly on white can collapse on near-black, and the usable
// lightness band is different in each mode. Both sets pass the same checks:
// lightness band, chroma floor, colour-vision separation, and contrast.

export const THEMES = ['system', 'light', 'dark']

/** Light and dark series colours, mirroring the CSS custom properties. */
const CHART = {
  light: { income: '#0d9488', expense: '#c2410c', balance: '#4338ca', grid: '#e2e5ea', axis: '#6b7480' },
  dark: { income: '#12a594', expense: '#e2650f', balance: '#7c7ff2', grid: '#2b323c', axis: '#9aa4b2' },
}

/**
 * Eight categorical hues for the per-category breakdown, in fixed order.
 *
 * Built rather than picked. One constant lightness and one constant chroma
 * (OKLCH L 0.62 light, 0.66 dark, C 0.145) with the hues evenly spaced, so the
 * eight read as one family instead of a set of unrelated crayons — the earlier
 * default varied lightness hue by hue, which is what made the chart look like
 * a pie of primaries.
 *
 * The spacing is anchored on the two hues the app already uses: burnt orange
 * at 40 for expenses and teal at 175 for income. Because expenses fill slots
 * upward from 0 and income downward from 7, the first expense band is orange
 * and the first income band is teal — the same reading the Totals view gives.
 *
 * Validated against this app's own surfaces (#ffffff and #1b2027), both modes,
 * every check passing with nothing resting on the relief clause:
 *
 *   colour-vision separation  12.9 light / 13.0 dark   (target 8)
 *   normal-vision separation  18.4 light / 18.9 dark   (floor 15)
 *   contrast vs surface       all 8 >= 3:1 in both modes
 *
 * The dark column is the same eight hues re-stepped one notch lighter for the
 * dark surface, never the light set inverted.
 */
const CATEGORY = {
  light: ['#cd633c', '#0095b5', '#68972b', '#a16ac7', '#a97f00', '#c75c8b', '#5b82dd', '#009d82'],
  dark: ['#db6f49', '#00a2c5', '#74a339', '#ad76d4', '#b88a00', '#d56897', '#668eeb', '#00aa8e'],
}

/**
 * Everything past the eighth series, folded together. Same lightness as the
 * hues so it sits level with them, but almost no chroma, so it reads as "the
 * rest" rather than competing as a ninth category.
 */
const OTHER = { light: '#7e8791', dark: '#8a939d' }

export const categoryColors = (resolved) => CATEGORY[resolved] || CATEGORY.light
export const otherColor = (resolved) => OTHER[resolved] || OTHER.light

/** What the browser is actually showing, resolving 'system' against the OS. */
export function resolveTheme(choice) {
  if (choice === 'light' || choice === 'dark') return choice
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export const chartColors = (resolved) => CHART[resolved] || CHART.light

/**
 * Put the choice on the document so CSS can act on it. 'system' removes the
 * attribute rather than setting one, which is what lets the media query take
 * over again.
 */
export function applyTheme(choice) {
  try {
    const root = document.documentElement
    if (choice === 'light' || choice === 'dark') root.setAttribute('data-theme', choice)
    else root.removeAttribute('data-theme')
  } catch {
    /* no document, e.g. under test */
  }
}
