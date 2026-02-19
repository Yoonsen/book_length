import { useEffect, useMemo, useState } from 'react'
import Papa from 'papaparse'
import './App.css'

type BookRow = {
  urn: string
  title: string
  year?: number
  dhlabid?: number
  [key: string]: string | number | undefined
}

type Period = {
  label: string
  start: number
  end: number
}

type SummaryRow = {
  period: string
  group: string
  word: string
  documents: number
  nCounts: number
  mean: number | null
  median: number | null
  std: number | null
}

type DetailRow = {
  period: string
  group: string
  dhlabid: number | null
  word: string
  count: number
  total: number
}

const CSV_PATH = '/Helenes_korpusdata.csv'
const METADATA_URL = 'https://api.nb.no/dhlab/get_metadata'
const FREQUENCIES_URL = 'https://api.nb.no/dhlab/frequencies'

const DEFAULT_PERIODS = '2010-2020,2020-2025'

function normalizeUrn(row: Record<string, string>): string {
  return (row.urn || row.new_urns || '').trim()
}

function parseYear(value: string | number | undefined): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  const year = Number(value)
  return Number.isFinite(year) ? year : undefined
}

function parseDhlabid(value: string | number | undefined): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  const id = Number(value)
  return Number.isFinite(id) ? id : undefined
}

function parsePeriods(raw: string): Period[] {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [left, right] = item.includes(':') ? item.split(':', 2) : [item, item]
      const label = left.trim()
      const years = right.trim()
      const [startRaw, endRaw] = years.split('-', 2)
      const start = Number(startRaw)
      const end = Number(endRaw)
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        throw new Error(`Ugyldig periode: ${item}`)
      }
      return { label, start, end }
    })
}

async function postJson(url: string, payload: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    throw new Error(`Kall feilet (${response.status}) mot ${url}`)
  }
  return response.json()
}

function parseMetadataRows(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
  }

  if (raw && typeof raw === 'object') {
    const objectRaw = raw as Record<string, unknown>
    const allColumnObjects = Object.values(objectRaw).every(
      (value) => value && typeof value === 'object' && !Array.isArray(value),
    )

    if (allColumnObjects) {
      const rowKeys = new Set<string>()
      Object.values(objectRaw).forEach((column) => {
        Object.keys(column as Record<string, unknown>).forEach((key) => rowKeys.add(key))
      })

      return [...rowKeys]
        .sort((a, b) => Number(a) - Number(b))
        .map((rowKey) => {
          const row: Record<string, unknown> = {}
          Object.entries(objectRaw).forEach(([field, column]) => {
            const value = (column as Record<string, unknown>)[rowKey]
            if (value !== undefined) {
              row[field] = value
            }
          })
          return row
        })
    }
  }

  return []
}

async function fetchMetadataMap(urns: string[]): Promise<Map<string, Record<string, unknown>>> {
  const batchSize = 50
  const map = new Map<string, Record<string, unknown>>()

  for (let i = 0; i < urns.length; i += batchSize) {
    const batch = urns.slice(i, i + batchSize)
    const raw = await postJson(METADATA_URL, { urns: batch })
    const rows = parseMetadataRows(raw)
    rows.forEach((row) => {
      const urn = String(row.urn ?? '').trim()
      if (urn) {
        map.set(urn, row)
      }
    })
  }

  return map
}

function toStats(values: number[]): { mean: number | null; median: number | null; std: number | null } {
  if (values.length === 0) {
    return { mean: null, median: null, std: null }
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  const std = Math.sqrt(variance)
  return { mean, median, std }
}

function App() {
  const [books, setBooks] = useState<BookRow[]>([])
  const [csvLoaded, setCsvLoaded] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string>('')

  const [wordsText, setWordsText] = useState('og')
  const [periodsText, setPeriodsText] = useState(DEFAULT_PERIODS)
  const [groupBy, setGroupBy] = useState('gender')
  const [cutoff, setCutoff] = useState(1)

  const [genderFilter, setGenderFilter] = useState('all')
  const [subjectContains, setSubjectContains] = useState('')
  const [literaryformFilter, setLiteraryformFilter] = useState('')
  const [deweyPrefix, setDeweyPrefix] = useState('')

  const [summaryRows, setSummaryRows] = useState<SummaryRow[]>([])
  const [detailRows, setDetailRows] = useState<DetailRow[]>([])

  useEffect(() => {
    const loadCsv = async () => {
      try {
        setError(null)
        const response = await fetch(CSV_PATH)
        if (!response.ok) {
          throw new Error(`Fant ikke CSV på ${CSV_PATH}`)
        }
        const csvText = await response.text()
        const parsed = Papa.parse<Record<string, string>>(csvText, {
          header: true,
          skipEmptyLines: true,
          transformHeader: (header) => header.trim(),
        })
        const rows = parsed.data
          .map((raw) => {
            const urn = normalizeUrn(raw)
            if (!urn) {
              return null
            }
            return {
              ...raw,
              urn,
              title: (raw.title || '').trim(),
              year: parseYear(raw.year),
              dhlabid: parseDhlabid(raw.dhlabid),
            } as BookRow
          })
          .filter((row): row is BookRow => row !== null)
        setBooks(rows)
        setCsvLoaded(true)
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Kunne ikke lese CSV')
      }
    }

    void loadCsv()
  }, [])

  const availableGenders = useMemo(() => {
    const values = new Set<string>()
    books.forEach((row) => {
      const value = String(row.gender ?? '').trim()
      if (value) {
        values.add(value)
      }
    })
    return [...values].sort()
  }, [books])

  const runAnalysis = async () => {
    if (!csvLoaded) {
      return
    }
    setIsRunning(true)
    setError(null)
    setInfo('')

    try {
      const periods = parsePeriods(periodsText)
      const words = wordsText
        .split(',')
        .map((word) => word.trim())
        .filter(Boolean)
      if (words.length === 0) {
        throw new Error('Skriv minst ett ord i ordfeltet.')
      }

      const urns = [...new Set(books.map((row) => row.urn))]
      const metadataByUrn = await fetchMetadataMap(urns)

      const enrichedBooks = books.map((book) => {
        const metadata = metadataByUrn.get(book.urn)
        if (!metadata) {
          return book
        }
        return {
          ...book,
          dhlabid: parseDhlabid(book.dhlabid ?? metadata.dhlabid as string | number | undefined),
          subjects: String(metadata.subjects ?? ''),
          subject: String(metadata.subject ?? ''),
          literaryform: String(metadata.literaryform ?? ''),
          ddc: String(metadata.ddc ?? ''),
        } as BookRow
      })

      const filtered = enrichedBooks.filter((book) => {
        if (genderFilter !== 'all' && String(book.gender ?? '').toLowerCase() !== genderFilter.toLowerCase()) {
          return false
        }
        if (subjectContains) {
          const subjectText = `${book.subject ?? ''} ${book.subjects ?? ''}`.toLowerCase()
          if (!subjectText.includes(subjectContains.toLowerCase())) {
            return false
          }
        }
        if (literaryformFilter) {
          if (String(book.literaryform ?? '').toLowerCase() !== literaryformFilter.toLowerCase()) {
            return false
          }
        }
        if (deweyPrefix) {
          if (!String(book.ddc ?? '').startsWith(deweyPrefix)) {
            return false
          }
        }
        return true
      })

      const summary: SummaryRow[] = []
      const details: DetailRow[] = []

      for (const period of periods) {
        const periodBooks = filtered.filter((book) => {
          const year = parseYear(book.year)
          return year !== undefined && year >= period.start && year <= period.end
        })

        const groups = [...new Set(periodBooks.map((book) => String(book[groupBy] ?? '').trim() || 'unknown'))].sort()

        for (const groupValue of groups) {
          const groupBooks = periodBooks.filter(
            (book) => (String(book[groupBy] ?? '').trim() || 'unknown') === groupValue,
          )
          const groupUrns = groupBooks.map((book) => book.urn)
          if (groupUrns.length === 0) {
            continue
          }

          const raw = await postJson(FREQUENCIES_URL, {
            cutoff,
            urns: groupUrns,
            words,
          })

          const freqRows = Array.isArray(raw) ? raw.filter((row): row is unknown[] => Array.isArray(row)) : []
          freqRows.forEach((row) => {
            if (row.length < 4) return
            details.push({
              period: period.label,
              group: groupValue,
              dhlabid: parseDhlabid(row[0] as string | number | undefined) ?? null,
              word: String(row[1]),
              count: Number(row[2]),
              total: Number(row[3]),
            })
          })

          words.forEach((word) => {
            const values = freqRows
              .filter((row) => String(row[1]) === word)
              .map((row) => Number(row[2]))
              .filter((value) => Number.isFinite(value))
            const stats = toStats(values)
            summary.push({
              period: period.label,
              group: groupValue,
              word,
              documents: groupUrns.length,
              nCounts: values.length,
              mean: stats.mean,
              median: stats.median,
              std: stats.std,
            })
          })
        }
      }

      setSummaryRows(summary)
      setDetailRows(details)
      setInfo(`Klar: ${summary.length} grupperader og ${details.length} frekvensrader.`)
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Analyse feilet')
    } finally {
      setIsRunning(false)
    }
  }

  return (
    <div className="page">
      <h1>Frekvensanalyse per periode</h1>
      <p className="lead">
        Henter metadata, filtrerer bokutvalg, og sammenligner dokumentfrekvens mellom perioder.
      </p>

      <section className="panel">
        <h2>Innstillinger</h2>
        <div className="grid">
          <label>
            Ord (kommaseparert)
            <input value={wordsText} onChange={(event) => setWordsText(event.target.value)} />
          </label>
          <label>
            Perioder
            <input
              value={periodsText}
              onChange={(event) => setPeriodsText(event.target.value)}
              placeholder="2010-2020,2020-2025"
            />
          </label>
          <label>
            Grupper på felt
            <input value={groupBy} onChange={(event) => setGroupBy(event.target.value)} />
          </label>
          <label>
            Cutoff
            <input
              type="number"
              value={cutoff}
              min={1}
              onChange={(event) => setCutoff(Number(event.target.value))}
            />
          </label>
          <label>
            Gender-filter
            <select value={genderFilter} onChange={(event) => setGenderFilter(event.target.value)}>
              <option value="all">Alle</option>
              {availableGenders.map((gender) => (
                <option key={gender} value={gender}>
                  {gender}
                </option>
              ))}
            </select>
          </label>
          <label>
            Subject inneholder
            <input
              value={subjectContains}
              onChange={(event) => setSubjectContains(event.target.value)}
            />
          </label>
          <label>
            Literaryform eksakt
            <input
              value={literaryformFilter}
              onChange={(event) => setLiteraryformFilter(event.target.value)}
            />
          </label>
          <label>
            Dewey prefix
            <input value={deweyPrefix} onChange={(event) => setDeweyPrefix(event.target.value)} />
          </label>
        </div>
        <button disabled={isRunning || !csvLoaded} onClick={() => void runAnalysis()}>
          {isRunning ? 'Kjorer...' : 'Kjor analyse'}
        </button>
      </section>

      {error && <p className="status error">{error}</p>}
      {info && <p className="status ok">{info}</p>}

      <section className="panel">
        <h2>Summary (mean, median, std)</h2>
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Periode</th>
                <th>Gruppe</th>
                <th>Ord</th>
                <th>Dokumenter</th>
                <th>N</th>
                <th>Mean</th>
                <th>Median</th>
                <th>Std</th>
              </tr>
            </thead>
            <tbody>
              {summaryRows.length === 0 && (
                <tr>
                  <td colSpan={8}>Ingen resultater enda.</td>
                </tr>
              )}
              {summaryRows.map((row, index) => (
                <tr key={`${row.period}-${row.group}-${row.word}-${index}`}>
                  <td>{row.period}</td>
                  <td>{row.group}</td>
                  <td>{row.word}</td>
                  <td>{row.documents}</td>
                  <td>{row.nCounts}</td>
                  <td>{row.mean === null ? '' : row.mean.toFixed(4)}</td>
                  <td>{row.median === null ? '' : row.median.toFixed(4)}</td>
                  <td>{row.std === null ? '' : row.std.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>Detaljrader (forste 200)</h2>
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Periode</th>
                <th>Gruppe</th>
                <th>dhlabid</th>
                <th>Ord</th>
                <th>Count</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {detailRows.slice(0, 200).map((row, index) => (
                <tr key={`${row.period}-${row.group}-${row.word}-${index}`}>
                  <td>{row.period}</td>
                  <td>{row.group}</td>
                  <td>{row.dhlabid ?? ''}</td>
                  <td>{row.word}</td>
                  <td>{row.count}</td>
                  <td>{row.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

export default App
