// Bank-account import: what it refuses to count, and what it refuses to
// count twice.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  parseBank, summariseBank, excludedBy, matchBankRule, resolveBankTarget, rulesFor, BANK_SOURCE,
} from '../src/lib/bank.js'
import { applySummary } from '../src/lib/statement.js'
import { emptyData, makeCategory, makeItem } from '../src/lib/model.js'

const HEAD = 'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #'
const csv = (...lines) => [HEAD, ...lines].join('\n')
const row = (date, desc, amount, type = 'ACH_DEBIT') =>
  `${amount < 0 ? 'DEBIT' : 'CREDIT'},${date},"${desc}",${amount},${type}, ,,`

/** A budget with one income line and one expense line to aim at. */
function budget(year = 2026) {
  const d = emptyData(year)
  const inc = makeCategory({ kind: 'income', name: 'Wages', order: 0 }); inc.id = 'c-inc'
  const exp = makeCategory({ kind: 'expense', name: 'Debt', order: 1 }); exp.id = 'c-exp'
  d.categories = [inc, exp]
  const pay = makeItem({ categoryId: 'c-inc', name: 'Paycheck 1', order: 0 }); pay.id = 'i-pay'
  const loan = makeItem({ categoryId: 'c-exp', name: 'Student loans', order: 0 }); loan.id = 'i-loan'
  d.items = [pay, loan]
  return d
}
const run = (text, d, existing = []) => {
  const { rows } = parseBank(text)
  return summariseBank(rows, d, {
    year: d.year, existing, resolve: (spec) => resolveBankTarget(d, spec),
  })
}
const bucket = (r, key) => r.excluded.find((e) => e.key === key)

// --- parsing ---
test('reads the Chase shape, signs and all', () => {
  const { rows, error } = parseBank(csv(
    row('01/09/2026', 'ACME CORP PAYROLL', 5000.00, 'ACH_CREDIT'),
    row('01/10/2026', 'T-MOBILE PCS SVC', -152.55),
  ))
  assert.equal(error, '')
  assert.equal(rows.length, 2)
  assert.equal(rows[0].amount, 5000.00, 'a credit stays positive')
  assert.equal(rows[1].amount, -152.55, 'a debit stays negative')
  assert.equal(rows[0].iso, '2026-01-09')
  assert.equal(rows[0].month, 0)
})

test('"Posting Date" is a date column', () => {
  // Chase writes it this way; before, header detection failed and the whole
  // file was rejected as unreadable.
  assert.equal(parseBank(csv(row('01/09/2026', 'X', -1))).error, '')
})

test('rows with no readable date or amount are counted, not silently dropped', () => {
  const { rows, warnings } = parseBank(csv(
    row('01/09/2026', 'GOOD', -10), 'DEBIT,,"NO DATE",-5,ACH_DEBIT, ,,',
  ))
  assert.equal(rows.length, 1)
  assert.match(warnings[0], /1 row/)
})

// --- exclusions ---
test('a payment to a credit card is never spending', () => {
  for (const d of ['AMERICAN EXPRESS ACH PMT', 'CAPITAL ONE MOBILE PMT', 'DISCOVER E-PAYMENT',
                   'Payment to Chase card ending in 1234', 'SYNCHRONY BANK CC PYMT', 'CITI AUTOPAY PAYMENT']) {
    assert.equal(excludedBy(d)?.key, 'card', d)
  }
})

test('moving your own money is never spending', () => {
  assert.equal(excludedBy('Online Transfer to SAV ...3651')?.key, 'transfer')
  assert.equal(excludedBy('ROBINHOOD DEBITS')?.key, 'brokerage')
  assert.equal(excludedBy('COINBASE INC.')?.key, 'brokerage')
  assert.equal(excludedBy('Zelle payment to Lexie')?.key, 'person')
})

test('an ordinary bill is not excluded', () => {
  for (const d of ['T-MOBILE PCS SVC', 'LOAN SERVICER PPD STUDNTLOAN', 'ACME CORP PAYROLL']) {
    assert.equal(excludedBy(d), null, d)
  }
})

test('excluded money is reported with its reason, not dropped', () => {
  const s = run(csv(
    row('02/02/2026', 'AMERICAN EXPRESS ACH PMT', -4000),
    row('02/03/2026', 'Online Transfer to SAV ...3651', -500),
  ), budget())
  assert.equal(bucket(s.report, 'card').amount, 4000)
  assert.equal(bucket(s.report, 'transfer').amount, 500)
  assert.equal(s.transactions.length, 0)
  assert.ok(bucket(s.report, 'card').why.length > 20, 'the reason travels with the number')
})

// --- rules ---
test('payroll lands on the wages line, a student loan on its own', () => {
  const rules = rulesFor(budget())
  assert.equal(matchBankRule('ACME CORP PAYROLL', rules), 'Wages::Paycheck 1')
  assert.equal(matchBankRule('LOAN SERVICER PPD STUDNTLOAN', rules), 'Debt::Student loans')
})

test('a rule in the document beats a default, and never ships in the app', () => {
  // Rules naming your own billers and line items live in the private data
  // document; the public repository carries only generic defaults.
  const d = budget()
  d.bankRules = [{ match: 'acme corp', target: 'Debt::Student loans' }]
  assert.equal(matchBankRule('ACME CORP PAYROLL', rulesFor(d)), 'Debt::Student loans')
  assert.equal(matchBankRule('ACME CORP PAYROLL', rulesFor(budget())), 'Wages::Paycheck 1')
})

test('a mistyped rule is ignored rather than taking the import down', () => {
  const d = budget()
  d.bankRules = [{ match: '[unclosed', target: 'Debt::Student loans' }]
  assert.doesNotThrow(() => rulesFor(d))
  assert.equal(matchBankRule('ACME CORP PAYROLL', rulesFor(d)), 'Wages::Paycheck 1')
})

test('an income line can be aimed at — the card resolver only sees expenses', () => {
  const d = budget()
  assert.equal(resolveBankTarget(d, 'Wages::Paycheck 1'), 'i-pay')
  assert.equal(resolveBankTarget(d, 'Debt::Student loans'), 'i-loan')
  assert.equal(resolveBankTarget(d, 'Nowhere::Nothing'), null)
})

test('a row with no rule is left out and counted, never guessed at', () => {
  const s = run(csv(row('03/03/2026', 'SOMETHING NOBODY HAS SEEN', -80)), budget())
  assert.equal(s.transactions.length, 0)
  assert.equal(s.report.unassigned.rows, 1)
  assert.equal(s.report.unassigned.amount, 80)
})

// --- the money itself ---
test('a credit files as income and a debit as spending, both positive', () => {
  const s = run(csv(
    row('01/09/2026', 'ACME CORP PAYROLL', 5000.00, 'ACH_CREDIT'),
    row('01/15/2026', 'LOAN SERVICER PPD STUDNTLOAN', -1200.00),
  ), budget())
  assert.equal(s.cells.get('i-pay:0'), 5000.00)
  assert.equal(s.cells.get('i-loan:0'), 1200.00, 'stored as a positive expense')
})

test('another year is held back rather than folded into January', () => {
  const s = run(csv(row('12/30/2025', 'ACME CORP PAYROLL', 900, 'ACH_CREDIT')), budget())
  assert.equal(s.report.wrongYear.rows, 1)
  assert.equal(s.transactions.length, 0)
})

test('every row lands in exactly one bucket, and they reconcile', () => {
  const s = run(csv(
    row('01/09/2026', 'ACME CORP PAYROLL', 5000, 'ACH_CREDIT'),
    row('01/10/2026', 'AMERICAN EXPRESS ACH PMT', -4000),
    row('01/11/2026', 'Online Transfer to SAV ...1', -500),
    row('01/12/2026', 'MYSTERY MERCHANT', -80),
    row('12/30/2025', 'ACME CORP PAYROLL', -900),
  ), budget())
  const r = s.report
  const total = r.excluded.reduce((a, e) => a + e.amount, 0)
    + r.duplicates.amount + r.splits.amount + r.assigned.amount + r.unassigned.amount + r.wrongYear.amount
  assert.equal(total, 5000 + 4000 + 500 + 80 + 900)
})

// --- not counting the same money twice ---
test('a paycheck already typed in is skipped, not added again', () => {
  const existing = [{ id: 'm1', itemId: 'i-pay', date: '2026-01-09', month: 0,
    amount: 5000.00, desc: 'Paycheck', source: 'manual' }]
  const s = run(csv(row('01/09/2026', 'ACME CORP PAYROLL', 5000.00, 'ACH_CREDIT')), budget(), existing)
  assert.equal(s.report.duplicates.rows, 1)
  assert.equal(s.transactions.length, 0)
  assert.equal(s.cells.size, 0)
})

test('one deposit typed as two entries is recognised by the day adding up', () => {
  // A paycheck entered as base plus bonus. Matching on amount alone misses it
  // and re-imports the whole deposit on top of both.
  const existing = [
    { id: 'a', itemId: 'i-pay', date: '2026-03-06', month: 2, amount: 4000.00, desc: 'Paycheck', source: 'manual' },
    { id: 'b', itemId: 'i-pay', date: '2026-03-06', month: 2, amount: 1000.00, desc: 'Paycheck - Bonus', source: 'manual' },
  ]
  const s = run(csv(row('03/06/2026', 'ACME CORP PAYROLL', 5000.50, 'ACH_CREDIT')), budget(), existing)
  assert.equal(s.report.splits.rows, 1, 'the day adds up to the deposit')
  assert.equal(s.transactions.length, 0)
  assert.equal(s.report.splits.samples[0].parts.length, 2)
})

test('a day of card purchases is not mistaken for a split deposit', () => {
  // Only hand-typed rows are summed. Card rows on the same day happening to
  // total the deposit must not make it look already recorded.
  const existing = [
    { id: 'a', itemId: 'i-loan', date: '2026-03-06', month: 2, amount: 5000, desc: 'Shop', source: 'amex' },
    { id: 'b', itemId: 'i-loan', date: '2026-03-06', month: 2, amount: 1000.50, desc: 'Shop', source: 'amex' },
  ]
  const s = run(csv(row('03/06/2026', 'ACME CORP PAYROLL', 5000.50, 'ACH_CREDIT')), budget(), existing)
  assert.equal(s.report.splits.rows, 0)
  assert.equal(s.transactions.length, 1, 'the deposit is genuinely new')
})

test('a paycheck NOT yet typed in is imported', () => {
  const existing = [{ id: 'm1', itemId: 'i-pay', date: '2026-01-09', month: 0,
    amount: 5000.00, desc: 'Paycheck', source: 'manual' }]
  const s = run(csv(row('01/22/2026', 'ACME CORP PAYROLL', 700.00, 'ACH_CREDIT')), budget(), existing)
  assert.equal(s.transactions.length, 1)
  assert.equal(s.cells.get('i-pay:0'), 700.00)
})

test('re-importing the same file lands on the same numbers', () => {
  const d = budget()
  const text = csv(row('01/09/2026', 'ACME CORP PAYROLL', 5000, 'ACH_CREDIT'))
  const once = applySummary(d, run(text, d), '2026-08-28T00:00:00Z', BANK_SOURCE)
  const twice = applySummary(once, run(text, once, once.transactions), '2026-08-28T00:00:00Z', BANK_SOURCE)
  assert.deepEqual(twice.items.find((i) => i.id === 'i-pay').actual,
                   once.items.find((i) => i.id === 'i-pay').actual)
  assert.equal(twice.transactions.filter((t) => t.source === BANK_SOURCE).length, 1)
})

test('a card share and a bank share can hold the same month together', () => {
  const d = budget()
  const withCard = applySummary(d, {
    cells: new Map([['i-loan:0', 200]]), transactions: [], coveredMonths: [0],
  }, '2026-08-28T00:00:00Z', 'amex')
  const next = applySummary(withCard, run(csv(row('01/15/2026', 'LOAN SERVICER PPD STUDNTLOAN', -300)), d),
    '2026-08-28T00:00:00Z', BANK_SOURCE)
  const loan = next.items.find((i) => i.id === 'i-loan')
  assert.equal(loan.actual[0], 500, 'the two sources sum')
  assert.equal(loan.imported['0'].amex, 200)
  assert.equal(loan.imported['0'][BANK_SOURCE], 300)
})
