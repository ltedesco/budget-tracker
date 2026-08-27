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
