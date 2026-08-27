// The starting structure for a brand-new budget.
//
// Deliberately generic and deliberately empty: category and line-item names
// from the standard annual-budget template, with no amounts. Real figures
// belong in the private data repo, never in this repository, which may be
// public so that GitHub Pages can serve it.
//
// Nothing here is fixed — every category and line item can be renamed, added
// to, reordered or deleted in the app.

import { makeCategory, makeItem, nowISO } from './model.js'

const EXPENSES = [
  ['Children', ['Activities', 'Allowance', 'Medical', 'Clothing', 'School', 'Toys']],
  ['Debt', ['Credit cards', 'Student loans', 'Auto loans', 'Personal loans', 'Life insurance']],
  ['Education', ['Tuition', 'Books', 'Music lessons', 'Other']],
  ['Entertainment', ['Travel', 'Concerts/shows', 'Games', 'Hobbies', 'Movies', 'Sports', 'Subscriptions']],
  ['Everyday', ['Groceries', 'Restaurants', 'Personal supplies', 'Clothes', 'Hair/beauty']],
  ['Gifts', ['Gifts', 'Donations (charity)', 'Other']],
  ['Health/medical', ['Doctors/dental/vision', 'Specialty care', 'Pharmacy', 'Emergency']],
  ['Home', ['Mortgage/rent', 'Property taxes', 'Furnishings', 'Lawn/garden', 'Supplies', 'Maintenance']],
  ['Insurance', ['Home insurance', 'Auto insurance', 'Health insurance', 'Life insurance']],
  ['Pets', ['Food', 'Vet/medical', 'Toys', 'Supplies']],
  ['Technology', ['Internet', 'Streaming', 'Hardware', 'Software', 'Other']],
  ['Transportation', ['Fuel', 'Car payments', 'Repairs', 'Registration/license', 'Public transit']],
  ['Travel', ['Airfare', 'Hotels', 'Food', 'Transportation', 'Entertainment']],
  ['Utilities', ['Phone', 'Electricity', 'Gas/heating', 'Water', 'Trash', 'Other']],
  ['Other', ['Gym', 'Other']],
]

const INCOME = [
  ['Wages', ['Paycheck 1', 'Paycheck 2', 'Bonus', 'Tips/commission']],
  ['Other', ['Rental income', 'Interest income', 'Dividends', 'Refunds', 'Other']],
]

/** Build the starter document. `at` is injected so tests get stable output. */
export function templateData(year, at = nowISO()) {
  const categories = []
  const items = []

  const add = (kind, source) => {
    source.forEach(([name, itemNames]) => {
      const cat = makeCategory({ kind, name, order: categories.length }, at)
      categories.push(cat)
      itemNames.forEach((itemName, i) => {
        items.push(makeItem({ categoryId: cat.id, name: itemName, order: i }, at))
      })
    })
  }

  add('income', INCOME)
  add('expense', EXPENSES)

  return {
    version: 1,
    year: Number(year),
    startingBalance: 0,
    startingBalanceAt: '',
    categories,
    items,
    deleted: [],
  }
}
