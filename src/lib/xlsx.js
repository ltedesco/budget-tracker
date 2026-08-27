// Minimal XLSX reader — enough for a bank or card export, and no more.
//
// A card statement is one flat sheet of strings and numbers. SheetJS would do
// this too, but it is a large dependency whose npm-published build carries
// known advisories, and the whole surface needed here is: unzip, read the
// shared string table, walk the cells of one sheet. That is small enough to
// own outright.
//
// Returns a matrix (array of row arrays), which is the same shape the CSV path
// produces, so everything downstream is identical whichever format arrived.

import { unzipSync, strFromU8 } from 'fflate'

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

const decodeXml = (s) =>
  String(s).replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(lt|gt|amp|quot|apos));/g, (m, dec, hex, name) => {
    if (dec) return String.fromCodePoint(Number(dec))
    if (hex) return String.fromCodePoint(parseInt(hex, 16))
    return ENTITIES[name] ?? m
  })

/** "BC" -> 54. Column refs are base-26 with no zero. */
export function columnIndex(ref) {
  let n = 0
  for (const ch of String(ref).toUpperCase()) {
    const code = ch.charCodeAt(0)
    if (code < 65 || code > 90) break
    n = n * 26 + (code - 64)
  }
  return n - 1
}

/** All <t> text inside a chunk, concatenated — rich text arrives as runs. */
const textOf = (chunk) => {
  const out = []
  const re = /<t[^>]*>([\s\S]*?)<\/t>/g
  let m
  while ((m = re.exec(chunk))) out.push(decodeXml(m[1]))
  return out.join('')
}

function sharedStrings(files) {
  const raw = files['xl/sharedStrings.xml']
  if (!raw) return []
  const xml = strFromU8(raw)
  const out = []
  const re = /<si[^>]*>([\s\S]*?)<\/si>/g
  let m
  while ((m = re.exec(xml))) out.push(textOf(m[1]))
  return out
}

/**
 * The first sheet in workbook order, which is the one an export writes to.
 * Falls back to any worksheet present rather than failing on an unusual layout.
 */
function firstSheetPath(files) {
  const wb = files['xl/workbook.xml']
  const rels = files['xl/_rels/workbook.xml.rels']
  if (wb && rels) {
    const sheet = strFromU8(wb).match(/<sheet[^>]*r:id="([^"]+)"[^>]*\/?>/)
    if (sheet) {
      const relXml = strFromU8(rels)
      const rel = relXml.match(new RegExp(`<Relationship[^>]*Id="${sheet[1]}"[^>]*Target="([^"]+)"`))
        || relXml.match(new RegExp(`<Relationship[^>]*Target="([^"]+)"[^>]*Id="${sheet[1]}"`))
      if (rel) {
        const target = rel[1].replace(/^\//, '').replace(/^xl\//, '')
        if (files[`xl/${target}`]) return `xl/${target}`
      }
    }
  }
  const any = Object.keys(files).find((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))
  if (!any) throw new Error('That file has no worksheet in it.')
  return any
}

// Excel keeps dates as a serial number counting from 1900, with a deliberate
// bug: it believes 1900 was a leap year. Serial 60 is the phantom 29 Feb, so
// anything at or below it is shifted by a day relative to the real calendar.
const EPOCH = Date.UTC(1899, 11, 30)

export function serialToISO(serial) {
  const n = Number(serial)
  if (!Number.isFinite(n) || n <= 0) return null
  const days = Math.floor(n < 61 ? n + 1 : n)
  const d = new Date(EPOCH + days * 86400000)
  if (Number.isNaN(d.getTime())) return null
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

/**
 * Read the first worksheet into a matrix of strings and numbers.
 *
 * `dateColumns` names cell styles that should be read as dates; without a
 * style table to consult, a numeric cell is returned as a number and the
 * caller decides. Card exports in practice write dates as text.
 */
export function readWorkbook(buffer) {
  let files
  try {
    files = unzipSync(new Uint8Array(buffer))
  } catch {
    throw new Error('That file is not a readable .xlsx workbook.')
  }

  const strings = sharedStrings(files)
  const xml = strFromU8(files[firstSheetPath(files)])

  const matrix = []
  const rowRe = /<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>|<row[^>]*\br="(\d+)"[^>]*\/>/g
  let rowMatch
  while ((rowMatch = rowRe.exec(xml))) {
    const rowNumber = Number(rowMatch[1] ?? rowMatch[3])
    const body = rowMatch[2] || ''
    const cells = []

    const cellRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g
    let cellMatch
    while ((cellMatch = cellRe.exec(body))) {
      const attrs = cellMatch[1] || ''
      const inner = cellMatch[2] || ''
      const ref = (attrs.match(/\br="([A-Z]+)\d+"/) || [])[1]
      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || 'n'
      const col = ref ? columnIndex(ref) : cells.length

      let value = null
      if (type === 's') {
        const idx = Number((inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1])
        value = strings[idx] ?? ''
      } else if (type === 'inlineStr') {
        value = textOf(inner)
      } else if (type === 'str') {
        value = decodeXml((inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '')
      } else if (type === 'b') {
        value = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] === '1'
      } else {
        const raw = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1]
        value = raw === undefined || raw === '' ? null : Number(raw)
      }

      // Cells are sparse: an empty column emits no <c> at all, so index by ref.
      while (cells.length < col) cells.push(null)
      cells[col] = value
    }

    while (matrix.length < rowNumber - 1) matrix.push([])
    matrix[rowNumber - 1] = cells
  }

  return matrix
}
