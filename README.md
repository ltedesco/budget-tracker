# Budget Tracker

An annual expense-and-income budget: fifteen expense categories and two income
categories, each with line items carrying twelve monthly values. Every line item
holds both a **plan** and an **actual**, so the tracker shows what you expected,
what really happened, and the variance between them.

Built to the same shape as the 1099 tracker: a static site on GitHub Pages, with
the data in a **private** repository rather than in browser storage.

```
npm install
npm run dev      # http://localhost:5173
npm test         # merge, summary, sync and crypto suites
npm run build    # static bundle in dist/
```

## Layout

The app repo holds no financial data. It ships a generic starter template —
category and line-item names, no amounts — because the repository serving
GitHub Pages is public on a free account.

| Where | What |
| --- | --- |
| this repo | the app: React + Vite, deployed to Pages by `.github/workflows/deploy-pages.yml` |
| a **private** repo | `data/budget-data.json` — the real numbers, written through the GitHub Contents API |

`data/budget-data.json` is gitignored here so the data file can never be
committed from the app side by accident.

## Getting your spreadsheet in

`scripts/seed-from-xlsx.py` converts a standard annual-budget workbook into a
document this app can import:

```
pip install openpyxl
python3 scripts/seed-from-xlsx.py Annual_budget_2026.xlsx 2026 > seed.json
```

Then open the app → **Setup & Sync → Import** → choose the file. Import replaces
everything currently loaded and is undoable from the toast for eight seconds.

Blank cells stay blank and zeros stay zero: "not recorded yet" and "spent
nothing" are different facts, and the variance figures depend on the difference.

Nothing forces you through the importer — categories and line items can be
added, renamed, reordered by category, and deleted entirely by hand, and a fresh
budget can start from **Load starter categories** or from nothing at all.

## Using it

**Planned / Actual / Variance** switches which numbers the grid shows. Only one
layer is editable at a time, which keeps the table twelve columns wide instead
of twenty-four — a 24-column grid is unusable on a phone.

Variance is signed so that **positive always means better than planned**:
earning more than budgeted, or spending less. Without the flip, a green number
would mean opposite things on the Income and Expenses tabs.

In the grid: click any cell to edit it, **Enter** commits and moves down,
**Tab** moves right, **Escape** cancels. **fill →** copies January across all
twelve months, which is how most recurring line items get entered.

The Summary tab carries the ending balance forward month to month from the
starting balance set on Setup & Sync, exactly as the source workbook does.

## Where data is stored

Every change is written to `localStorage` immediately. That alone keeps the
budget on one device in one browser. For it to survive a cleared cache and
follow you between devices, turn on **GitHub sync**.

## GitHub sync

The app reads and writes one JSON file through the GitHub Contents API, so the
repository is the source of truth.

1. Use a **private** repository for the data, with a file at
   `data/budget-data.json`. An empty repo also works — the first push creates
   the file.
2. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new):
   - **Repository access:** only that one repository.
   - **Permissions:** Contents → *Read and write*. Nothing else.
3. In the app, open **Setup & Sync**, fill in owner / repo / branch / path /
   token, then **Pull from GitHub** (or **Push** if the file does not exist yet).

**Push automatically after edits** commits three seconds after you stop typing,
so a burst of entries becomes one commit rather than one per keystroke.

### Why a separate repository

Do not point sync at the repo serving the site. Pages needs that repo public on
a free account, and a committed `data/budget-data.json` would publish your
salary, mortgage balance and account balances to anyone who looks.

### About the token

The token is **encrypted with a passphrase**, and only the encrypted envelope is
stored, under `budget:sync`. The token itself is never written to
`localStorage`; while unlocked it lives in `sessionStorage`, which the browser
drops when it closes. It is sent only to `api.github.com`, and never written
into the data file or committed.

Paste the token and pick a passphrase once per device. After the browser closes
the app shows **Locked** and sync stays disabled — including auto-push — until
the passphrase is entered. **Lock now** clears it early; **Forget saved token**
removes it from the device entirely.

Why bother, given there is no backend: every GitHub Pages project site on an
account shares one origin (`<user>.github.io`), and `localStorage` is scoped to
the origin, not the path. Any other Pages site under the same account could read
a plaintext token sitting there. Encrypted at rest, what leaks is useless
without the passphrase.

This is not perfect and is not meant to look like it. While unlocked the token
is in memory, so anyone who can run script in the page can still use it. It
raises the cost of a casual leak; it does not defeat someone already running
code on the device. Use a fine-grained token limited to the one data repo, with
an expiry, so the worst case stays small.

### Adding another device (or another person)

Rather than retyping the token, open **Setup & Sync → Setup code for another
device…** and copy the one line it produces. On the new device paste it into
**Setup code from another device**, then enter the passphrase. It carries the
repo settings and the encrypted token, so the new device lands *locked* and
still needs the passphrase to do anything.

Treat the code like a password. It holds your encrypted token, so send it the
way you would send a password — AirDrop, a message to yourself, a password
manager — and do not post it anywhere public.

### Two people, two devices

The file is shared, so a push never writes "whatever this device holds". Every
push reads the file, merges, and writes the union — and every pull merges into
what is already here rather than replacing it.

The unit of conflict is the **cell**, not the row. Each line item carries a
sparse map of per-field timestamps, so editing January on a phone while someone
edits March on a laptop keeps both numbers. Only two edits to *the same cell*
can conflict, and there the later one wins.

A delete leaves a tombstone, so a deleted line item does not come back from the
other device's copy on the next merge — unless it was edited after the delete,
which counts as a deliberate resurrection. Deleting a category takes its line
items with it, since an item with no category could not be displayed.

`test/merge.test.mjs` and `test/sync.test.mjs` cover this, including a real
409-during-push race. CI runs them before every deploy.
