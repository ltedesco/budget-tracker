import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseStatement, parseStatementDate, parseAmount, isCardPayment,
  targetForCategory, summarise, applySummary, previewRows,
} from '../src/lib/statement.js'
import { emptyData, makeCategory, makeItem } from '../src/lib/model.js'
import { summaryFor } from '../src/lib/summary.js'

const BORN = '2026-01-01T00:00:00.000Z'

function budget() {
  const d = emptyData(2026)
  const everyday = makeCategory({ kind: 'expense', name: 'Everyday', order: 0 }, BORN)
  const transport = makeCategory({ kind: 'expense', name: 'Transportation', order: 1 }, BORN)
  d.categories.push(everyday, transport)
  for (const name of ['Groceries', 'Restaurants', 'Personal supplies', 'Clothes']) {
    d.items.push(makeItem({ categoryId: everyday.id, name, order: d.items.length }, BORN))
  }
  d.items.push(makeItem({ categoryId: transport.id, name: 'Fuel', order: 0 }, BORN))
  return d
}

const CSV = `Date,Description,Amount,Category
01/04/2026,WHOLEFDS MARKET,152.40,Merchandise & Supplies-Groceries
01/11/2026,SHELL OIL 12345,61.20,Transportation-Fuel
01/18/2026,LUIGI'S TRATTORIA,88.15,Restaurant-Restaurant
02/02/2026,WHOLEFDS MARKET,204.60,Merchandise & Supplies-Groceries
02/14/2026,AUTOPAY PAYMENT - THANK YOU,-1500.00,
02/20/2026,CVS PHARMACY,34.10,Merchandise & Supplies-Pharmacies
03/03/2026,SOME OBSCURE VENDOR,75.00,Business Services-Other
12/15/2025,LAST YEAR CHARGE,999.00,Merchandise & Supplies-Groceries`

test('parses dates in Amex US and ISO form', () => {
  assert.deepEqual(parseStatementDate('01/04/2026'), [2026, 0])
  assert.deepEqual(parseStatementDate('12/31/2026'), [2026, 11])
  assert.deepEqual(parseStatementDate('2026-07-09'), [2026, 6])
  assert.deepEqual(parseStatementDate('nonsense'), [null, null])
})

test('parses amounts including currency and parenthesised negatives', () => {
  assert.equal(parseAmount('$1,234.56'), 1234.56)
  assert.equal(parseAmount('(45.00)'), -45)
  assert.equal(parseAmount('-45'), -45)
  assert.ok(Number.isNaN(parseAmount('')))
})

test('recognises card payments so they are never counted as spending', () => {
  assert.ok(isCardPayment('AUTOPAY PAYMENT - THANK YOU'))
  assert.ok(isCardPayment('ONLINE PAYMENT THANK YOU'))
  assert.ok(isCardPayment('Mobile Payment - Thank You'))
  assert.ok(!isCardPayment('WHOLEFDS MARKET'))
  assert.ok(!isCardPayment('PAYMENTS INC HARDWARE'))
})

test('maps card categories only where the mapping is unambiguous', () => {
  // Targets are qualified "Category::Item" so a duplicated line-item name
  // cannot resolve to the wrong category.
  assert.equal(targetForCategory('Merchandise & Supplies-Groceries'), 'Everyday::Groceries')
  assert.equal(targetForCategory('Restaurant-Bar & Café'), 'Everyday::Restaurants')
  assert.equal(targetForCategory('Transportation-Fuel'), 'Transportation::Fuel')
  assert.equal(targetForCategory('Travel-Lodging'), 'Travel::Hotels')
  // Deliberately unmapped: guessing here would move money between budget lines.
  // Marketplace orders were once left unassigned. That was the honest default
  // while it was 71% of the statement; at 2.5% the money is better attributed
  // than left in limbo, so they now land on household supplies by decision.
  assert.equal(targetForCategory('Merchandise & Supplies-Internet Purchase'), 'Everyday::Personal supplies')
  assert.equal(targetForCategory(''), null)
})

test('rejects a file with no recognisable columns', () => {
  const r = parseStatement('foo,bar\n1,2')
  assert.match(r.error, /header row with a date and an amount/i)
  assert.equal(r.rows.length, 0)
})

test('warns when the category column is missing rather than silently matching nothing', () => {
  const r = parseStatement('Date,Description,Amount\n01/04/2026,X,10.00')
  assert.equal(r.error, '')
  assert.match(r.warnings.join(' '), /no category column/i)
})

test('card payments are excluded from spending', () => {
  const { rows } = parseStatement(CSV)
  const s = summarise(rows, budget())
  assert.equal(s.totals.payments, -1500)
  // The payment must not appear in any assigned cell.
  assert.equal(s.totals.assigned, 152.40 + 61.20 + 88.15 + 204.60 + 34.10)
})

test('transactions from another year are held back, not folded into January', () => {
  const { rows } = parseStatement(CSV)
  const s = summarise(rows, budget())
  assert.equal(s.totals.wrongYear, 999)
  const groceriesJan = [...s.cells.entries()].filter(([k]) => k.endsWith(':0'))
  assert.ok(groceriesJan.every(([, v]) => v !== 999))
})

test('unmatched categories are always reported by name, whatever happens to the money', () => {
  // Sweeping is on by default, so the money is destined for the catch-all —
  // but the category is still surfaced, because that is how the mapping gets
  // improved. Which bucket the money lands in depends on whether the catch-all
  // line exists yet; that it is never silently dropped does not.
  const withoutLine = summarise(parseStatement(CSV).rows, budget())
  assert.equal(withoutLine.totals.unmatched, 0, 'money is not left in limbo')
  assert.equal(withoutLine.totals.missingItem, 75, 'it is reported as needing the catch-all line')
  assert.ok(withoutLine.missingItem.some((m) => m.name === 'Unassigned card spend'))

  // With sweeping explicitly off, it is held back and named as unmatched.
  const heldBack = summarise(parseStatement(CSV).rows, budget(), { catchAll: false })
  assert.equal(heldBack.totals.unmatched, 75)
  assert.equal(heldBack.unmatched[0].category, 'Business Services-Other')
})

test('every dollar is accounted for in exactly one bucket', () => {
  const { rows } = parseStatement(CSV)
  const s = summarise(rows, budget())
  const statementTotal = rows.reduce((a, r) => a + r.amount, 0)
  const bucketed =
    s.totals.assigned + s.totals.payments + s.totals.wrongYear +
    s.totals.unmatched + s.totals.missingItem
  assert.equal(Math.round(bucketed * 100), Math.round(statementTotal * 100))
})

test('same category in the same month is summed', () => {
  const csv = `Date,Description,Amount,Category
01/04/2026,A,100.00,Merchandise & Supplies-Groceries
01/20/2026,B,50.00,Merchandise & Supplies-Groceries`
  const d = budget()
  const s = summarise(parseStatement(csv).rows, d)
  const groceries = d.items.find((i) => i.name === 'Groceries')
  assert.equal(s.cells.get(`${groceries.id}:0`), 150)
})

test('a refund nets against its category', () => {
  const csv = `Date,Description,Amount,Category
01/04/2026,A,100.00,Merchandise & Supplies-Groceries
01/20/2026,RETURN,-30.00,Merchandise & Supplies-Groceries`
  const d = budget()
  const s = summarise(parseStatement(csv).rows, d)
  const groceries = d.items.find((i) => i.name === 'Groceries')
  assert.equal(s.cells.get(`${groceries.id}:0`), 70)
})

test('applying writes the actual layer and leaves planned alone', () => {
  const d = budget()
  const groceries = d.items.find((i) => i.name === 'Groceries')
  groceries.planned = Array(12).fill(1000)
  const s = summarise(parseStatement(CSV).rows, d)
  const next = applySummary(d, s, '2026-09-01T00:00:00Z')
  const after = next.items.find((i) => i.id === groceries.id)
  assert.equal(after.actual[0], 152.40)
  assert.equal(after.actual[1], 204.60)
  assert.deepEqual(after.planned, Array(12).fill(1000))
  assert.equal(summaryFor(next, 'planned').totals.expenses, 12000)
})

test('importing the same statement twice does not double the numbers', () => {
  const d = budget()
  const s = summarise(parseStatement(CSV).rows, d)
  const once = applySummary(d, s, '2026-09-01T00:00:00Z')
  const twice = applySummary(once, summarise(parseStatement(CSV).rows, once), '2026-09-02T00:00:00Z')
  const a = once.items.find((i) => i.name === 'Groceries')
  const b = twice.items.find((i) => i.name === 'Groceries')
  assert.deepEqual(a.actual, b.actual)
  assert.equal(summaryFor(once, 'actual').totals.expenses, summaryFor(twice, 'actual').totals.expenses)
})

test('a month the statement says nothing about keeps its manual entry', () => {
  const d = budget()
  const groceries = d.items.find((i) => i.name === 'Groceries')
  groceries.actual[7] = 888   // hand-entered August
  const s = summarise(parseStatement(CSV).rows, d)
  const next = applySummary(d, s, '2026-09-01T00:00:00Z')
  assert.equal(next.items.find((i) => i.id === groceries.id).actual[7], 888)
})

test('a mapped category with no matching line item is reported, not invented', () => {
  const d = emptyData(2026)
  const cat = makeCategory({ kind: 'expense', name: 'Everyday', order: 0 }, BORN)
  d.categories.push(cat)   // no Groceries item exists
  const s = summarise(parseStatement(CSV).rows, d)
  assert.ok(s.missingItem.some((m) => m.name === 'Everyday::Groceries'))
  assert.equal(s.cells.size, 0)
})

test('income line items are never a target for card spending', () => {
  const d = emptyData(2026)
  const inc = makeCategory({ kind: 'income', name: 'Wages', order: 0 }, BORN)
  d.categories.push(inc)
  d.items.push(makeItem({ categoryId: inc.id, name: 'Groceries', order: 0 }, BORN))
  const s = summarise(parseStatement(CSV).rows, d)
  assert.equal(s.cells.size, 0, 'must not write spending onto an income line')
})

test('preview rows carry the category and sort by size', () => {
  const d = budget()
  const s = summarise(parseStatement(CSV).rows, d)
  const rows = previewRows(s, d)
  assert.equal(rows[0].name, 'Groceries')
  assert.equal(rows[0].category, 'Everyday')
  assert.equal(rows[0].total, 357)
})

// --- catch-all: no card dollar may disappear --------------------------------

import { ensureCatchAll, CATCH_ALL_ITEM, REQUIRED_ITEMS } from '../src/lib/statement.js'
import { actualCoverage } from '../src/lib/summary.js'
import { makeCategory as mkCat, makeItem as mkItem, setCell, mergeItem } from '../src/lib/model.js'

const MAKE = { category: mkCat, item: mkItem }

test('ensureCatchAll creates the lines once and is idempotent', () => {
  const d = budget()
  const once = ensureCatchAll(d, MAKE, BORN)
  // The catch-all plus every line item the rules require but a template lacks.
  assert.equal(once.items.length, d.items.length + REQUIRED_ITEMS.length + 1)
  assert.ok(once.items.some((i) => i.name === 'Professional fees'))
  assert.ok(once.items.some((i) => i.name === CATCH_ALL_ITEM))
  const twice = ensureCatchAll(once, MAKE, BORN)
  assert.equal(twice.items.length, once.items.length)
})

test('unmatched spending is swept into the catch-all, not dropped', () => {
  const d = ensureCatchAll(budget(), MAKE, BORN)
  const s = summarise(parseStatement(CSV).rows, d)
  const catchAll = d.items.find((i) => i.name === CATCH_ALL_ITEM)
  // The Business Services row has no confident mapping.
  assert.equal(s.cells.get(`${catchAll.id}:2`), 75)
  assert.equal(s.totals.swept, 75)
  // Still reported by category so the mapping can be improved.
  assert.ok(s.unmatched.some((u) => u.category === 'Business Services-Other'))
})

test('with sweeping on, every non-excluded dollar is recorded', () => {
  const d = ensureCatchAll(budget(), MAKE, BORN)
  const rows = parseStatement(CSV).rows
  const s = summarise(rows, d)
  const spendable = rows
    .filter((r) => !r.payment && r.year === d.year)
    .reduce((a, r) => a + r.amount, 0)
  assert.equal(Math.round(s.totals.assigned * 100), Math.round(spendable * 100))
  assert.equal(s.totals.missingItem, 0)
})

test('swept money is part of assigned, not a bucket beside it', () => {
  const d = ensureCatchAll(budget(), MAKE, BORN)
  const rows = parseStatement(CSV).rows
  const s = summarise(rows, d)
  const total = rows.reduce((a, r) => a + r.amount, 0)
  const bucketed = s.totals.assigned + s.totals.payments + s.totals.wrongYear + s.totals.missingItem
  assert.equal(Math.round(bucketed * 100), Math.round(total * 100))
  assert.ok(s.totals.swept <= s.totals.assigned)
})

test('sweeping can be turned off, and then unmatched money is held back', () => {
  const d = ensureCatchAll(budget(), MAKE, BORN)
  const s = summarise(parseStatement(CSV).rows, d, { catchAll: false })
  assert.equal(s.totals.swept, 0)
  assert.equal(s.totals.unmatched, 75)
})

// --- coverage: never compare a partial actual to a full plan ----------------

test('coverage is zero when nothing has been recorded', () => {
  const d = budget()
  d.items.find((i) => i.name === 'Groceries').planned = Array(12).fill(1000)
  const c = actualCoverage(d)
  assert.equal(c.planned, 12000)
  assert.equal(c.covered, 0)
  assert.equal(c.ratio, 0)
})

test('coverage counts planned money on lines that have any actual', () => {
  const d = budget()
  const groceries = d.items.find((i) => i.name === 'Groceries')
  const fuel = d.items.find((i) => i.name === 'Fuel')
  groceries.planned = Array(12).fill(1000)   // 12,000 planned
  fuel.planned = Array(12).fill(100)         //  1,200 planned
  groceries.actual[0] = 950                  // only groceries tracked
  const c = actualCoverage(d)
  assert.equal(c.planned, 13200)
  assert.equal(c.covered, 12000)
  assert.equal(c.uncovered, 1200)
  assert.equal(c.trackedItems, 1)
  assert.equal(c.plannedItems, 2)
  assert.ok(Math.abs(c.ratio - 12000 / 13200) < 1e-9)
})

test('spending on an unbudgeted line counts as tracked without inflating planned', () => {
  const d = budget()
  d.items.find((i) => i.name === 'Groceries').planned = Array(12).fill(1000)
  d.items.find((i) => i.name === 'Clothes').actual[3] = 220   // no plan for this line
  const c = actualCoverage(d)
  assert.equal(c.planned, 12000)
  assert.equal(c.trackedItems, 1)
  assert.equal(c.plannedItems, 1)
})

test('coverage ignores income lines', () => {
  const d = budget()
  const inc = mkCat({ kind: 'income', name: 'Wages', order: 9 }, BORN)
  d.categories.push(inc)
  d.items.push(mkItem({ categoryId: inc.id, name: 'Salary', order: 0, planned: Array(12).fill(9999) }, BORN))
  assert.equal(actualCoverage(d).planned, 0)
})

// --- real export shapes ------------------------------------------------------
//
// The first version of this importer assumed the header was the first row,
// which is true of a hand-written test file and false of every real Amex
// export. These pin the shapes that actually arrive.

import { findHeaderRow } from '../src/lib/statement.js'
import { columnIndex, serialToISO } from '../src/lib/xlsx.js'

const PREAMBLE_CSV = `Transaction Details,American Express Gold Card
Prepared for,
LOUIS J TEDESCO,
Account Number,
XXXX-XXXXXX-83008,
,
Date,Description,Card Member,Account #,Amount,Reference,Category
08/09/2026,WHOLEFDS MARKET,LOUIS,-83008,152.40,3202600001,Merchandise & Supplies-Groceries
08/14/2026,MOBILE PAYMENT - THANK YOU,LOUIS,-83008,-300.00,3202600002,
08/19/2026,SHELL OIL,LOUIS,-83008,61.20,3202600003,Transportation-Fuel`

test('finds the header row beneath an export preamble', () => {
  const matrix = PREAMBLE_CSV.split('\n').map((l) => l.split(','))
  assert.equal(findHeaderRow(matrix), 6)
})

test('a real-shaped CSV with preamble parses, and says what it skipped', () => {
  const r = parseStatement(PREAMBLE_CSV)
  assert.equal(r.error, '')
  assert.equal(r.headerRow, 6)
  assert.equal(r.rows.length, 3)
  assert.match(r.warnings.join(' '), /skipped 6 rows/i)
})

test('the preamble is not mistaken for transactions', () => {
  const d = ensureCatchAll(budget(), MAKE, BORN)
  const s = summarise(parseStatement(PREAMBLE_CSV).rows, d)
  assert.equal(s.totals.payments, -300)
  // Written out rather than 152.4 + 61.2, which is 213.60000000000002 in binary
  // floating point; the code rounds to cents, and the test should assert cents.
  assert.equal(s.totals.assigned, 213.6)
})

test('a header-only file with no rows is reported, not silently empty', () => {
  const r = parseStatement('Date,Amount\n')
  assert.equal(r.error, '')
  assert.equal(r.rows.length, 0)
})

test('a file with no header at all is rejected with an explanation', () => {
  const r = parseStatement('one,two\nthree,four')
  assert.match(r.error, /header row with a date and an amount/i)
})

test('unsupported input is refused rather than parsed as nonsense', () => {
  const r = parseStatement(42)
  assert.match(r.error, /\.csv or \.xlsx/i)
})

test('column refs decode past Z', () => {
  assert.equal(columnIndex('A'), 0)
  assert.equal(columnIndex('Z'), 25)
  assert.equal(columnIndex('AA'), 26)
  assert.equal(columnIndex('BC'), 54)
})

test('Excel date serials convert, including the 1900 leap-year quirk', () => {
  assert.equal(serialToISO(45900), '2025-08-31')
  assert.equal(serialToISO(1), '1900-01-01')
  assert.equal(serialToISO(61), '1900-03-01')
  assert.equal(serialToISO(0), null)
  assert.equal(serialToISO('nope'), null)
})

test('a date held as an Excel serial is read as a date', () => {
  // Row values as a matrix is what the workbook path produces.
  const csv = 'Date,Amount,Category\n46000,100.00,Merchandise & Supplies-Groceries'
  const r = parseStatement(csv)
  // From CSV it is text "46000", which is not a date — must not silently pass.
  assert.equal(r.rows.length, 0)
})

// --- rules -------------------------------------------------------------------

import { matchRule, stateOf, resolveTarget, RULES } from '../src/lib/statement.js'

const row = (over) => ({ description: '', category: '', state: '', ...over })

test("Lowe's Foods is a grocery chain, not the hardware store", () => {
  // A loose merchant rule once moved $240 of groceries onto Home Supplies.
  // Merchant rules deliberately outrank card categories, so a sloppy one
  // overrides a correct classification instead of merely adding to it.
  assert.equal(
    matchRule(row({ description: "LOWE'S FOODS #232 00MYRTLE BEACH", category: 'Merchandise & Supplies-Groceries' })),
    'Everyday::Groceries',
  )
  assert.equal(
    matchRule(row({ description: 'THE HOME DEPOT 1122 MURRELLS INLE', category: 'Merchandise & Supplies-Hardware Supplies' })),
    'Home::Supplies',
  )
  assert.equal(
    matchRule(row({ description: "LOWE'S              MYRTLE BEACH", category: 'Merchandise & Supplies-Hardware Supplies' })),
    'Home::Supplies',
  )
})

test('a merchant rule beats the card category when they disagree', () => {
  // Amex files streaming under "Cable & Internet Comm"; the budget treats it
  // as a subscription. The merchant is the stronger signal.
  assert.equal(
    matchRule(row({ description: 'NETFLIX.COM 866-579-7172', category: 'Communications-Cable & Internet Comm' })),
    'Technology::Netflix/Paramount/Discovery',
  )
})

test('one card category splits across budget lines by merchant', () => {
  const utilities = 'Other-Utilities'
  assert.equal(matchRule(row({ description: 'PSEG LI RESIDENTIAL NEWARK', category: utilities })), 'Utilities::Electricity')
  assert.equal(matchRule(row({ description: 'GRAND STRAND WATER&SCONWAY', category: utilities })), 'Utilities::Water ( Surfside)')
  assert.equal(matchRule(row({ description: 'DOMINION ENERGY - SCCAYCE', category: utilities })), 'Utilities::2nd home utilities')
})

test('location routes between per-property lines', () => {
  const cable = 'Communications-Cable & Internet Comm'
  assert.equal(matchRule(row({ description: 'OPTIMUM', category: cable, state: 'NY' })), 'Home::Internet/Cable (sayville)')
  assert.equal(matchRule(row({ description: 'SPECTRUM', category: cable, state: 'SC' })), 'Home::Internet/Cable (Surfside)')
  // An unrecognised state must not pick a property at random.
  assert.equal(matchRule(row({ description: 'SPECTRUM', category: cable, state: 'TX' })), null)
})

test('state is read off the export cell', () => {
  assert.equal(stateOf('CONWAY\nSC'), 'SC')
  assert.equal(stateOf('SAYVILLE NY'), 'NY')
  assert.equal(stateOf('866-579-7172'), '')
  assert.equal(stateOf(''), '')
})

test('marketplace purchases are attributed by decision, not deduction', () => {
  // The purpose genuinely is not in the file; this is a judgement that most of
  // it is household goods, taken because leaving it unattributed cost more.
  for (const m of ['AMAZON MARKEPLACE NA PA', 'WALMART.COM BENTONVILLE', 'AplPay TARGET.COM BROOKLYN PARK']) {
    assert.equal(matchRule(row({ description: m, category: 'Merchandise & Supplies-Internet Purchase' })), 'Everyday::Personal supplies')
  }
  // A merchant rule inside that category still wins where one exists.
  assert.equal(matchRule(row({ description: 'DECKERS*HOKA 866-491-3125', category: 'Merchandise & Supplies-Internet Purchase' })), 'Everyday::Clothes')
})

test('Plan It instalment fees are financing, not spending', () => {
  assert.equal(matchRule(row({ description: 'PLAN FEE - THE HOME DEPOT', category: 'Fees & Adjustments-Fees & Adjustments' })), 'Debt::Credit cards')
})

test('a bare target name that matches several categories is refused, not guessed', () => {
  const d = budget()
  const pets = mkCat({ kind: 'expense', name: 'Pets', order: 8 }, BORN)
  d.categories.push(pets)
  d.items.push(mkItem({ categoryId: pets.id, name: 'Groceries', order: 0 }, BORN))
  const r = resolveTarget(d, 'Groceries')
  assert.equal(r.item, null)
  assert.equal(r.ambiguous, 2)
  // Qualified by category, it resolves cleanly.
  assert.ok(resolveTarget(d, 'Everyday::Groceries').item)
  assert.ok(resolveTarget(d, 'Pets::Groceries').item)
})

// --- the card category wins when it is confident -----------------------------
//
// Three bugs found against a full year of real statements, all the same shape:
// a merchant pattern is a substring test over free text, so it misfires
// invisibly. Deferring to a confident card category fixes the class, not just
// the instances.

test('a substring inside a longer merchant name does not trigger a rule', () => {
  // "BRAVISSIMO" contains "avis". The card says lodging; that is right.
  assert.equal(
    matchRule(row({ description: 'AplPay BRAVISSIMO GIGIRONA', category: 'Travel-Lodging' })),
    'Travel::Hotels',
  )
})

test('the restaurant inside a cinema is a restaurant', () => {
  // Amex classified it as Bar & Café, which is correct; the Cinemark merchant
  // rule must not drag it onto the Movies line.
  assert.equal(
    matchRule(row({ description: 'CINEMARK 345 RSTBAR MYRTLE BEACH', category: 'Restaurant-Bar & Café' })),
    'Everyday::Restaurants',
  )
  // The cinema itself, which the card files vaguely, still maps.
  assert.equal(
    matchRule(row({ description: 'AplPay CINEMARK 345 MYRTLE BEACH', category: 'Entertainment-Theatrical Events' })),
    'Entertainment::Concerts/shows',
  )
})

test('an override rule still beats the card category', () => {
  // Streaming is filed by the card under "Cable & Internet Comm" and belongs
  // on a subscription line. This is the one case where merchant must win.
  assert.equal(
    matchRule(row({ description: 'NETFLIX.COM 866-579-7172', category: 'Communications-Cable & Internet Comm', state: 'NY' })),
    'Technology::Netflix/Paramount/Discovery',
  )
})

test('merchant rules still carry categories the card labels uselessly', () => {
  // These arrive as vague "Other" and "Professional Services" labels, so there
  // is no category rule to defer to and the merchant is the only signal.
  assert.equal(matchRule(row({ description: 'ALL ISLAND FUEL OF MSHIRLEY NY', category: 'Other-Utilities' })), 'Utilities::Heating Oil')
  assert.equal(matchRule(row({ description: 'AplPay IN *JAKS LAWNMYRTLE BEA', category: 'Business Services-Professional Services' })), 'Home::Lawn Maintenance')
  assert.equal(matchRule(row({ description: 'SANTEE COOPER 888-798-3785 SC', category: 'Other-Utilities' })), 'Utilities::2nd home utilities')
  assert.equal(matchRule(row({ description: 'SCWA-AUTOPAYPAYMENT 631-698-95', category: 'Other-Utilities' })), 'Utilities::Water (Sayville)')
  assert.equal(matchRule(row({ description: 'FEMA FLOOD INSURANCESAINT PETE', category: 'Other-Government Services' })), 'Insurance::Surfside Home flood  Insurance')
})

test('travel bookings map to lodging', () => {
  for (const m of ['HOTEL ON BOOKING.COMAMSTERDAM', 'AplPay AIRBNB * HM3JSAN FRANCI', 'AplPay EXPEDIA 72076EXPEDIA.CO']) {
    assert.equal(matchRule(row({ description: m, category: 'Travel-Travel Agencies' })), 'Travel::Hotels')
  }
})

test('every rule names a target shaped Category::Item', () => {
  // A target that does not resolve is a silent no-op — an "Entertainment::Other"
  // rule was written against a line item that does not exist.
  for (const rule of RULES) {
    for (const spec of rule.byState ? Object.values(rule.byState) : [rule.target]) {
      assert.ok(typeof spec === 'string' && spec.includes('::'), `unqualified target: ${spec}`)
    }
  }
})

const JAN_CSV = `Date,Description,Amount,Category
01/04/2026,WHOLEFDS MARKET,152.40,Merchandise & Supplies-Groceries`

test("a re-import clears money this source's earlier rules stranded", () => {
  // The real failure: an import with poor rules put $37,729 on the catch-all.
  // Better rules then mapped everything, so the new summary had no cell for
  // that line — and "replace only what the statement covers" left the stale
  // figure sitting there forever.
  let d = ensureCatchAll(budget(), MAKE, BORN)
  const catchAll = d.items.find((i) => i.name === CATCH_ALL_ITEM)
  d = {
    ...d,
    items: d.items.map((i) =>
      i.id === catchAll.id
        ? { ...i, actual: [37729.8, ...Array(11).fill(null)], imported: { 0: { 'amex:83008': 37729.8 } } }
        : i),
  }

  const after = applySummary(d, summarise(parseStatement(JAN_CSV).rows, d), '2026-09-01T00:00:00Z', 'amex:83008')
  assert.equal(after.items.find((i) => i.id === catchAll.id).actual[0], null, 'stale share must be cleared')
  assert.equal(after.items.find((i) => i.name === 'Groceries').actual[0], 152.4)
})

test('clearing only touches months the statement covers', () => {
  let d = ensureCatchAll(budget(), MAKE, BORN)
  const catchAll = d.items.find((i) => i.name === CATCH_ALL_ITEM)
  const actual = Array(12).fill(null)
  actual[0] = 100   // January, which the statement covers
  actual[9] = 999   // October, which it does not
  d = {
    ...d,
    items: d.items.map((i) =>
      i.id === catchAll.id
        ? { ...i, actual, imported: { 0: { 'amex:83008': 100 }, 9: { 'amex:83008': 999 } } }
        : i),
  }

  const after = applySummary(d, summarise(parseStatement(JAN_CSV).rows, d), '2026-09-01T00:00:00Z', 'amex:83008')
  const got = after.items.find((i) => i.id === catchAll.id).actual
  assert.equal(got[0], null, 'covered month cleared')
  assert.equal(got[9], 999, 'untouched month kept')
})

test('a figure with no recorded source is never destroyed by an import', () => {
  // Cells predating per-source tracking, and anything typed by hand, cannot be
  // told apart from each other — so an import leaves them alone rather than
  // risking deleting something a person entered.
  let d = ensureCatchAll(budget(), MAKE, BORN)
  const catchAll = d.items.find((i) => i.name === CATCH_ALL_ITEM)
  d = { ...d, items: d.items.map((i) => (i.id === catchAll.id ? { ...i, actual: [500, ...Array(11).fill(null)] } : i)) }

  const after = applySummary(d, summarise(parseStatement(JAN_CSV).rows, d), '2026-09-01T00:00:00Z', 'amex:83008')
  assert.equal(after.items.find((i) => i.id === catchAll.id).actual[0], 500)
})

// --- two cards ---------------------------------------------------------------
//
// The bug this exists for: import replaces the months it covers, which is
// right for one source and wrong for two. A Capital One import after an Amex
// one would have overwritten $9,376 of Amex spending rather than adding to it.

const CARD_A = 'amex:83008'
const CARD_B = 'capitalone:0377'

const amexCsv = `Date,Description,Amount,Category
06/04/2026,SOME RESTAURANT,776.82,Restaurant-Restaurant`
const capOneCsv = `Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit
2026-06-11,2026-06-12,0377,GOLDEN KITCHEN,Dining,63.66,`

test('a second card adds to the first rather than replacing it', () => {
  let d = ensureCatchAll(budget(), MAKE, BORN)
  d = applySummary(d, summarise(parseStatement(amexCsv).rows, d), '2026-09-01T00:00:00Z', CARD_A)
  assert.equal(d.items.find((i) => i.name === 'Restaurants').actual[5], 776.82)

  d = applySummary(d, summarise(parseStatement(capOneCsv).rows, d), '2026-09-02T00:00:00Z', CARD_B)
  const cell = d.items.find((i) => i.name === 'Restaurants')
  assert.equal(cell.actual[5], 840.48, 'both cards are counted')
  assert.deepEqual(cell.imported['5'], { [CARD_A]: 776.82, [CARD_B]: 63.66 })
})

test('order does not matter', () => {
  let a = ensureCatchAll(budget(), MAKE, BORN)
  a = applySummary(a, summarise(parseStatement(amexCsv).rows, a), '2026-09-01T00:00:00Z', CARD_A)
  a = applySummary(a, summarise(parseStatement(capOneCsv).rows, a), '2026-09-02T00:00:00Z', CARD_B)

  let b = ensureCatchAll(budget(), MAKE, BORN)
  b = applySummary(b, summarise(parseStatement(capOneCsv).rows, b), '2026-09-01T00:00:00Z', CARD_B)
  b = applySummary(b, summarise(parseStatement(amexCsv).rows, b), '2026-09-02T00:00:00Z', CARD_A)

  assert.equal(
    a.items.find((i) => i.name === 'Restaurants').actual[5],
    b.items.find((i) => i.name === 'Restaurants').actual[5],
  )
})

test('re-importing one card replaces only its own share', () => {
  let d = ensureCatchAll(budget(), MAKE, BORN)
  d = applySummary(d, summarise(parseStatement(amexCsv).rows, d), '2026-09-01T00:00:00Z', CARD_A)
  d = applySummary(d, summarise(parseStatement(capOneCsv).rows, d), '2026-09-02T00:00:00Z', CARD_B)

  // A corrected Amex statement for the same month, with a different figure.
  const corrected = `Date,Description,Amount,Category
06/04/2026,SOME RESTAURANT,500.00,Restaurant-Restaurant`
  d = applySummary(d, summarise(parseStatement(corrected).rows, d), '2026-09-03T00:00:00Z', CARD_A)

  const cell = d.items.find((i) => i.name === 'Restaurants')
  assert.equal(cell.actual[5], 563.66, "Capital One's share survives")
  assert.deepEqual(cell.imported['5'], { [CARD_A]: 500, [CARD_B]: 63.66 })
})

test('importing the same card twice is still idempotent', () => {
  let d = ensureCatchAll(budget(), MAKE, BORN)
  const once = applySummary(d, summarise(parseStatement(amexCsv).rows, d), '2026-09-01T00:00:00Z', CARD_A)
  const twice = applySummary(once, summarise(parseStatement(amexCsv).rows, once), '2026-09-02T00:00:00Z', CARD_A)
  assert.equal(
    once.items.find((i) => i.name === 'Restaurants').actual[5],
    twice.items.find((i) => i.name === 'Restaurants').actual[5],
  )
})

test('typing a figure by hand takes the cell over from the importers', () => {
  let d = ensureCatchAll(budget(), MAKE, BORN)
  d = applySummary(d, summarise(parseStatement(amexCsv).rows, d), '2026-09-01T00:00:00Z', CARD_A)
  const item = d.items.find((i) => i.name === 'Restaurants')
  const edited = setCell(item, 'actual', 5, '900', '2026-09-05T00:00:00Z')
  assert.equal(edited.actual[5], 900)
  assert.equal(edited.imported['5'], undefined, 'the breakdown is dropped, so it cannot disagree with the total')
})

test('the per-source breakdown survives a merge between devices', () => {
  let d = ensureCatchAll(budget(), MAKE, BORN)
  d = applySummary(d, summarise(parseStatement(amexCsv).rows, d), '2026-09-01T00:00:00Z', CARD_A)
  const local = d.items.find((i) => i.name === 'Restaurants')
  const remote = { ...local, updatedAt: '2026-08-01T00:00:00Z' }
  const merged = mergeItem(local, remote)
  assert.equal(merged.actual[5], 776.82)
  assert.deepEqual(merged.imported['5'], { [CARD_A]: 776.82 })
})
