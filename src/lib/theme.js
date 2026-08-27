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
 * Validated in both modes on the adjacent pairlist, which is the one that
 * governs stacked bars: worst adjacent colour-vision separation is 9.1 light
 * and 8.4 dark against a target of 8, and worst normal-vision separation 19.6
 * and 19.3 against a floor of 15. The dark column is the same eight hues
 * re-stepped for the dark surface, not the light set inverted.
 *
 * Three light hues sit under 3:1 against the surface. That is allowed only
 * where something other than colour carries identity, so the breakdown always
 * ships a legend naming every series, a tooltip listing them by name, and the
 * monthly table underneath.
 */
const CATEGORY = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
}

/** Everything past the eighth series, folded together. Deliberately neutral. */
const OTHER = { light: '#94a3b8', dark: '#64748b' }

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
