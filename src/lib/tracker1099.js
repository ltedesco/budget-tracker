// Reading the 1099 tracker as an income source.
//
// The 1099 tracker already records every payment from a self-employment payer,
// dated and itemised. Re-typing its monthly totals into a budget line is
// copying by hand from one app you own into another, which is exactly the
// transcription that goes wrong quietly — a month missed, a figure fat-
// fingered, and the budget disagrees with the tax record with nothing to say
// which is right.
//
// So the tracker's file is treated as another importable source, alongside the
// card statements: same per-source shares, same deterministic transaction ids,
// same replace-only-my-own-share behaviour.

export const SOURCE_1099 = '1099'

const MONTH_OF = (iso) => Number(String(iso).slice(5, 7)) - 1

/** Parse a 1099 tracker export. Returns { entries } or { error }. */
export function parse1099(text) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return { error: 'That file is not valid JSON.' }
  }
  if (!raw || !Array.isArray(raw.income)) {
    return { error: 'That file has no "income" array — it does not look like a 1099 tracker export.' }
  }
  const entries = raw.income
    .map((e) => ({
      id: String(e?.id ?? ''),
      date: String(e?.date ?? ''),
      amount: Number(e?.amount) || 0,
      payer: String(e?.payer ?? '').trim(),
      note: String(e?.note ?? '').trim(),
    }))
    .filter((e) => e.id && /^\d{4}-\d{2}-\d{2}$/.test(e.date))
  return { entries }
}

/** Every payer in the file with its entry count, for the picker. */
export function payersIn(entries, year = null) {
  const counts = new Map()
  for (const e of entries) {
    if (year && e.date.slice(0, 4) !== String(year)) continue
    counts.set(e.payer, (counts.get(e.payer) || 0) + 1)
  }
  return [...counts.entries()]
    .map(([payer, count]) => ({ payer, count }))
    .sort((a, b) => b.count - a.count || a.payer.localeCompare(b.payer))
}

/**
 * Turn the tracker's entries into the same summary shape a card statement
 * produces, so it goes through exactly the same apply path.
 *
 * Every month is reported as covered even where nothing landed. That is what
 * lets a payment deleted in the 1099 tracker clear the share it left behind
 * here — applySummary only touches a month that has something incoming or a
 * stale share of its own, so covering all twelve cannot invent a figure.
 */
export function summarize1099(entries, { year, itemId, payers = null }) {
  if (!itemId) return { error: 'Choose which income line the payments belong to.' }

  const wanted = payers && payers.length ? new Set(payers) : null
  const cells = new Map()
  const transactions = []
  const months = Array(12).fill(0)
  let outsideYear = 0
  let otherPayer = 0

  for (const e of entries) {
    if (e.date.slice(0, 4) !== String(year)) { outsideYear += 1; continue }
    if (wanted && !wanted.has(e.payer)) { otherPayer += 1; continue }
    const month = MONTH_OF(e.date)
    if (!(month >= 0 && month <= 11)) continue

    months[month] += e.amount
    transactions.push({
      // Derived from the tracker's own id, so re-importing produces the same
      // rows rather than doubling them, and two devices converge.
      id: `${SOURCE_1099}:${e.id}`,
      itemId,
      date: e.date,
      month,
      amount: e.amount,
      desc: e.note ? `${e.payer} — ${e.note}` : e.payer,
      cardCategory: '1099 income',
    })
  }

  for (let m = 0; m < 12; m++) {
    if (months[m]) cells.set(`${itemId}:${m}`, Math.round(months[m] * 100) / 100)
  }

  return {
    cells,
    transactions,
    coveredMonths: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    months,
    totals: {
      amount: Math.round(months.reduce((a, b) => a + b, 0) * 100) / 100,
      entries: transactions.length,
      outsideYear,
      otherPayer,
    },
  }
}
