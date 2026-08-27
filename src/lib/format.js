export const money = (n) =>
  (n < 0 ? '-' : '') +
  '$' +
  Math.abs(Number(n) || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

/** Whole dollars — the grid is dense enough without cents everywhere. */
export const moneyShort = (n) => {
  const v = Math.round(Number(n) || 0)
  return (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US')
}

/** Blank cells stay blank rather than rendering as $0. */
export const cellText = (v) => (v === null || v === undefined ? '' : moneyShort(v))

export const signed = (n) => (n > 0 ? '+' : '') + moneyShort(n)

/** Trigger a real file download. */
export function downloadFile(filename, text, mime = 'application/json') {
  try {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return true
  } catch {
    return false
  }
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
