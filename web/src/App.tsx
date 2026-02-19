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

type YearSummaryRow = {
  year: number
  documents: number
  nCounts: number
  mean: number | null
  median: number | null
  std: number | null
}

type DetailRow = {
  year: number
  dhlabid: number | null
  author: string
  title: string
  count: number
  total: number
}

const CSV_PATH = `${import.meta.env.BASE_URL}Helenes_korpusdata.csv`
const METADATA_URL = 'https://api.nb.no/dhlab/get_metadata'
const FREQUENCIES_URL = 'https://api.nb.no/dhlab/frequencies'
const TRIGGER_WORD = 'og'

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

function StatsPlot({ rows }: { rows: YearSummaryRow[] }) {
  const width = 900
  const height = 280
  const padding = 32

  const yValues = rows.flatMap((row) => [row.mean, row.median, row.std]).filter((value): value is number => value !== null)
  if (rows.length === 0 || yValues.length === 0) {
    return <p>Ingen datapunkter for plott enda.</p>
  }

  const minYear = rows[0].year
  const maxYear = rows[rows.length - 1].year
  const yMax = Math.max(...yValues)
  const yScale = (value: number) => height - padding - (value / (yMax || 1)) * (height - padding * 2)
  const xScale = (year: number) => {
    if (maxYear === minYear) return width / 2
    return padding + ((year - minYear) / (maxYear - minYear)) * (width - padding * 2)
  }

  const lineFor = (field: 'mean' | 'median' | 'std') =>
    rows
      .filter((row) => row[field] !== null)
      .map((row) => `${xScale(row.year)},${yScale(row[field] as number)}`)
      .join(' ')

  return (
    <div className="chartWrap">
      <svg viewBox={`0 0 ${width} ${height}`} className="chart">
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="#94a3b8" />
        <line x1={padding} y1={padding} x2={padding} y2={height - padding} stroke="#94a3b8" />
        <polyline fill="none" stroke="#2563eb" strokeWidth="2" points={lineFor('mean')} />
        <polyline fill="none" stroke="#16a34a" strokeWidth="2" points={lineFor('median')} />
        <polyline fill="none" stroke="#dc2626" strokeWidth="2" points={lineFor('std')} />
      </svg>
      <div className="legend">
        <span><i className="dot mean" /> mean</span>
        <span><i className="dot median" /> median</span>
        <span><i className="dot std" /> std</span>
      </div>
    </div>
  )
}

function App() {
  const [books, setBooks] = useState<BookRow[]>([])
  const [csvLoaded, setCsvLoaded] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string>('')

  const [startYear, setStartYear] = useState(2010)
  const [endYear, setEndYear] = useState(2025)
  const [cutoff, setCutoff] = useState(1)

  const [genderFilter, setGenderFilter] = useState('all')
  const [subjectContains, setSubjectContains] = useState('')
  const [literaryformFilter, setLiteraryformFilter] = useState('')
  const [deweyPrefix, setDeweyPrefix] = useState('')

  const [summaryRows, setSummaryRows] = useState<YearSummaryRow[]>([])
  const [detailRows, setDetailRows] = useState<DetailRow[]>([])
  const [overallStats, setOverallStats] = useState<{
    documents: number
    nCounts: number
    mean: number | null
    median: number | null
    std: number | null
  } | null>(null)

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
        const years = rows
          .map((row) => parseYear(row.year))
          .filter((value): value is number => value !== undefined)
        if (years.length > 0) {
          setStartYear(Math.min(...years))
          setEndYear(Math.max(...years))
        }
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
    setOverallStats(null)

    try {
      if (endYear < startYear) {
        throw new Error('Sluttår må være større enn eller lik startår.')
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
          dhlabid: parseDhlabid(book.dhlabid ?? (metadata.dhlabid as string | number | undefined)),
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

      const summary: YearSummaryRow[] = []
      const details: DetailRow[] = []
      const allCounts: number[] = []
      const uniqueDocuments = new Set<string>()
      const bookByDhlabid = new Map<number, BookRow>()
      enrichedBooks.forEach((book) => {
        if (book.dhlabid !== undefined) {
          bookByDhlabid.set(book.dhlabid, book)
        }
      })

      for (let year = startYear; year <= endYear; year += 1) {
        const yearBooks = filtered.filter((book) => parseYear(book.year) === year)
        const yearUrns = yearBooks.map((book) => book.urn)
        yearBooks.forEach((book) => uniqueDocuments.add(book.urn))
        if (yearUrns.length === 0) {
          summary.push({
            year,
            documents: 0,
            nCounts: 0,
            mean: null,
            median: null,
            std: null,
          })
          continue
        }

        const raw = await postJson(FREQUENCIES_URL, {
          cutoff,
          urns: yearUrns,
          words: [TRIGGER_WORD],
        })

        const freqRows = Array.isArray(raw) ? raw.filter((row): row is unknown[] => Array.isArray(row)) : []
        freqRows.forEach((row) => {
          if (row.length < 4) return
          const dhlabid = parseDhlabid(row[0] as string | number | undefined) ?? null
          const matchedBook = dhlabid !== null ? bookByDhlabid.get(dhlabid) : undefined
          const count = Number(row[2])
          const total = Number(row[3])
          details.push({
            year,
            dhlabid,
            author: String(matchedBook?.author ?? ''),
            title: String(matchedBook?.title ?? ''),
            count,
            total,
          })
        })

        const values = freqRows
          .filter((row) => String(row[1]) === TRIGGER_WORD)
          .map((row) => Number(row[2]))
          .filter((value) => Number.isFinite(value))
        allCounts.push(...values)
        const stats = toStats(values)
        summary.push({
          year,
          documents: yearUrns.length,
          nCounts: values.length,
          mean: stats.mean,
          median: stats.median,
          std: stats.std,
        })
      }

      const totalStats = toStats(allCounts)
      setOverallStats({
        documents: uniqueDocuments.size,
        nCounts: allCounts.length,
        mean: totalStats.mean,
        median: totalStats.median,
        std: totalStats.std,
      })

      const sortedDetails = [...details].sort((a, b) => {
        if (a.year !== b.year) return a.year - b.year
        if (b.count !== a.count) return b.count - a.count
        return a.title.localeCompare(b.title)
      })

      setSummaryRows(summary)
      setDetailRows(sortedDetails)
      setInfo(`Klar: ${summary.length} årsrader, ${uniqueDocuments.size} dokumenter, ${details.length} frekvensrader.`)
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Analyse feilet')
    } finally {
      setIsRunning(false)
    }
  }

  return (
    <div className="page">
      <h1>Frekvensanalyse per år</h1>
      <p className="lead">
        Henter metadata, filtrerer bokutvalg, og plotter dokumentfrekvens (triggerord: {TRIGGER_WORD}) over år.
      </p>

      <section className="panel">
        <h2>Innstillinger</h2>
        <div className="grid">
          <label>
            Startår
            <input type="number" value={startYear} onChange={(event) => setStartYear(Number(event.target.value))} />
          </label>
          <label>
            Sluttår
            <input type="number" value={endYear} onChange={(event) => setEndYear(Number(event.target.value))} />
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
        <h2>Plott</h2>
        <StatsPlot rows={summaryRows} />
      </section>

      <section className="panel">
        <h2>Aggregert for valgt intervall</h2>
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Dokumenter</th>
                <th>N</th>
                <th>Mean</th>
                <th>Median</th>
                <th>Std</th>
              </tr>
            </thead>
            <tbody>
              {!overallStats && (
                <tr>
                  <td colSpan={5}>Ingen aggregert statistikk enda.</td>
                </tr>
              )}
              {overallStats && (
                <tr>
                  <td>{overallStats.documents}</td>
                  <td>{overallStats.nCounts}</td>
                  <td>{overallStats.mean === null ? '' : overallStats.mean.toFixed(4)}</td>
                  <td>{overallStats.median === null ? '' : overallStats.median.toFixed(4)}</td>
                  <td>{overallStats.std === null ? '' : overallStats.std.toFixed(4)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>Summary per år (mean, median, std)</h2>
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>År</th>
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
                  <td colSpan={6}>Ingen resultater enda.</td>
                </tr>
              )}
              {summaryRows.map((row, index) => (
                <tr key={`${row.year}-${index}`}>
                  <td>{row.year}</td>
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
        <h2>Sorterte dokumentrader per år (forste 300)</h2>
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>År</th>
                <th>Forfatter</th>
                <th>Tittel</th>
                <th>dhlabid</th>
                <th>Count</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {detailRows.slice(0, 300).map((row, index) => (
                <tr key={`${row.year}-${row.dhlabid}-${index}`}>
                  <td>{row.year}</td>
                  <td>{row.author}</td>
                  <td>{row.title}</td>
                  <td>{row.dhlabid ?? ''}</td>
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
