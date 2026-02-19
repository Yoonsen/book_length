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

type BinSummaryRow = {
  binIndex: number
  binLabel: string
  startYear: number
  endYear: number
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
  gender: 'male' | 'female' | 'unknown'
  binIndex: number
  binLabel: string
  count: number
  total: number
}

type BinGenderSummaryRow = {
  binIndex: number
  binLabel: string
  gender: 'male' | 'female' | 'unknown'
  documents: number
  mean: number | null
  std: number | null
}

type BinDifferenceRow = {
  binIndex: number
  binLabel: string
  femaleMean: number | null
  maleMean: number | null
  meanDiffFemaleMinusMale: number | null
  femaleStd: number | null
  maleStd: number | null
}

type TopLongestRow = {
  binIndex: number
  binLabel: string
  gender: 'male' | 'female'
  rank: number
  year: number
  dhlabid: number | null
  author: string
  title: string
  total: number
  count: number
}

const CSV_PATH = `${import.meta.env.BASE_URL}gendered_database.csv`
const FREQUENCIES_URL = 'https://api.nb.no/dhlab/frequencies'
const TRIGGER_WORD = 'og'
const URN_BATCH_SIZE = 500

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

function normalizeGender(value: string | number | undefined): 'male' | 'female' | 'unknown' {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (['male', 'masc', 'm', 'mann'].includes(normalized)) {
    return 'male'
  }
  if (['female', 'fem', 'f', 'kvinne', 'kvinner'].includes(normalized)) {
    return 'female'
  }
  return 'unknown'
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

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

async function fetchFrequencyRows(urns: string[], cutoff: number): Promise<unknown[][]> {
  const rows: unknown[][] = []
  const chunks = chunkArray(urns, URN_BATCH_SIZE)

  for (const batch of chunks) {
    const raw = await postJson(FREQUENCIES_URL, {
      cutoff,
      urns: batch,
      words: [TRIGGER_WORD],
    })
    const freqRows = Array.isArray(raw) ? raw.filter((row): row is unknown[] => Array.isArray(row)) : []
    rows.push(...freqRows)
  }

  return rows
}

type YearBin = {
  index: number
  startYear: number
  endYear: number
  label: string
}

function buildYearBins(startYear: number, endYear: number, binCount: number): YearBin[] {
  const totalYears = endYear - startYear + 1
  const safeBinCount = Math.max(1, Math.min(binCount, totalYears))
  const baseSize = Math.floor(totalYears / safeBinCount)
  const remainder = totalYears % safeBinCount

  const bins: YearBin[] = []
  let cursor = startYear
  for (let i = 0; i < safeBinCount; i += 1) {
    const size = baseSize + (i < remainder ? 1 : 0)
    const binStart = cursor
    const binEnd = cursor + size - 1
    bins.push({
      index: i + 1,
      startYear: binStart,
      endYear: binEnd,
      label: `${binStart}-${binEnd}`,
    })
    cursor = binEnd + 1
  }
  return bins
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

function GenderErrorBarPlot({ rows }: { rows: BinGenderSummaryRow[] }) {
  const width = 900
  const height = 280
  const padding = 36

  const genderRows = rows.filter((row) => row.gender === 'female' || row.gender === 'male')
  if (genderRows.length === 0) {
    return <p>Ingen datapunkter for kvinner/menn enda.</p>
  }

  const uniqueBins = [...new Set(genderRows.map((row) => row.binIndex))].sort((a, b) => a - b)
  const binToLabel = new Map<number, string>()
  genderRows.forEach((row) => {
    if (!binToLabel.has(row.binIndex)) {
      binToLabel.set(row.binIndex, row.binLabel)
    }
  })

  const yMax = Math.max(
    ...genderRows.map((row) => {
      const mean = row.mean ?? 0
      const std = row.std ?? 0
      return mean + std
    }),
    1,
  )
  const yScale = (value: number) => height - padding - (value / yMax) * (height - padding * 2)
  const xScale = (binIndex: number) => {
    if (uniqueBins.length <= 1) return width / 2
    const idx = uniqueBins.indexOf(binIndex)
    return padding + (idx / (uniqueBins.length - 1)) * (width - padding * 2)
  }

  const femaleRows = genderRows.filter((row) => row.gender === 'female')
  const maleRows = genderRows.filter((row) => row.gender === 'male')

  return (
    <div className="chartWrap">
      <svg viewBox={`0 0 ${width} ${height}`} className="chart">
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="#94a3b8" />
        <line x1={padding} y1={padding} x2={padding} y2={height - padding} stroke="#94a3b8" />

        {femaleRows.map((row) => {
          if (row.mean === null || row.std === null) return null
          const x = xScale(row.binIndex) - 10
          const yMean = yScale(row.mean)
          const yLow = yScale(Math.max(0, row.mean - row.std))
          const yHigh = yScale(row.mean + row.std)
          return (
            <g key={`female-${row.binIndex}`}>
              <line x1={x} y1={yLow} x2={x} y2={yHigh} stroke="#db2777" strokeWidth="2" />
              <line x1={x - 4} y1={yLow} x2={x + 4} y2={yLow} stroke="#db2777" strokeWidth="2" />
              <line x1={x - 4} y1={yHigh} x2={x + 4} y2={yHigh} stroke="#db2777" strokeWidth="2" />
              <circle cx={x} cy={yMean} r="3.5" fill="#db2777" />
            </g>
          )
        })}

        {maleRows.map((row) => {
          if (row.mean === null || row.std === null) return null
          const x = xScale(row.binIndex) + 10
          const yMean = yScale(row.mean)
          const yLow = yScale(Math.max(0, row.mean - row.std))
          const yHigh = yScale(row.mean + row.std)
          return (
            <g key={`male-${row.binIndex}`}>
              <line x1={x} y1={yLow} x2={x} y2={yHigh} stroke="#2563eb" strokeWidth="2" />
              <line x1={x - 4} y1={yLow} x2={x + 4} y2={yLow} stroke="#2563eb" strokeWidth="2" />
              <line x1={x - 4} y1={yHigh} x2={x + 4} y2={yHigh} stroke="#2563eb" strokeWidth="2" />
              <circle cx={x} cy={yMean} r="3.5" fill="#2563eb" />
            </g>
          )
        })}

        {uniqueBins.map((binIndex) => (
          <text
            key={`xlabel-${binIndex}`}
            x={xScale(binIndex)}
            y={height - 10}
            textAnchor="middle"
            fontSize="11"
            fill="#475569"
          >
            {binToLabel.get(binIndex)}
          </text>
        ))}
      </svg>
      <div className="legend">
        <span><i className="dot female" /> kvinner mean</span>
        <span><i className="dot male" /> menn mean</span>
        <span><i className="dot std" /> std (pinner)</span>
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
  const [binCount, setBinCount] = useState(3)

  const [genderFilter, setGenderFilter] = useState('all')
  const [subjectContains, setSubjectContains] = useState('')
  const [literaryformFilter, setLiteraryformFilter] = useState('')
  const [deweyPrefix, setDeweyPrefix] = useState('')

  const [summaryRows, setSummaryRows] = useState<BinSummaryRow[]>([])
  const [detailRows, setDetailRows] = useState<DetailRow[]>([])
  const [binGenderSummaryRows, setBinGenderSummaryRows] = useState<BinGenderSummaryRow[]>([])
  const [binDifferenceRows, setBinDifferenceRows] = useState<BinDifferenceRow[]>([])
  const [topLongestRows, setTopLongestRows] = useState<TopLongestRow[]>([])
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
        if (csvText.startsWith('version https://git-lfs.github.com/spec/v1')) {
          throw new Error('CSV-filen er en Git LFS-pointer i deploy. Workflow må sjekke ut LFS-innhold.')
        }
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
            const title = (raw.title || '').trim()
            const author = (raw.author || raw.authors || '').trim()
            return {
              ...raw,
              urn,
              title,
              author,
              year: parseYear(raw.year),
              dhlabid: parseDhlabid(raw.dhlabid),
              subject: (raw.subject || '').trim(),
              subjects: (raw.subjects || '').trim(),
              literaryform: (raw.literaryform || '').trim(),
              ddc: (raw.ddc || '').trim(),
            } as BookRow
          })
          .filter((row): row is BookRow => row !== null)
        if (rows.length === 0) {
          throw new Error('CSV ble lastet, men ga 0 rader. Sjekk separator/header eller deploy-fil.')
        }
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

  const corpusSummary = useMemo(() => {
    let male = 0
    let female = 0
    let unknown = 0

    books.forEach((book) => {
      const gender = normalizeGender(book.gender)
      if (gender === 'male') male += 1
      else if (gender === 'female') female += 1
      else unknown += 1
    })

    return {
      total: books.length,
      male,
      female,
      unknown,
    }
  }, [books])

  const runAnalysis = async () => {
    if (!csvLoaded) {
      return
    }
    setIsRunning(true)
    setError(null)
    setInfo('')
    setOverallStats(null)
    setBinGenderSummaryRows([])
    setBinDifferenceRows([])
    setTopLongestRows([])

    try {
      if (endYear < startYear) {
        throw new Error('Sluttår må være større enn eller lik startår.')
      }
      if (binCount < 1) {
        throw new Error('Antall bins må være minst 1.')
      }

      const filtered = books.filter((book) => {
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

      const summary: BinSummaryRow[] = []
      const details: DetailRow[] = []
      const byGenderSummary: BinGenderSummaryRow[] = []
      const differences: BinDifferenceRow[] = []
      const longestRows: TopLongestRow[] = []
      const allTotals: number[] = []
      const uniqueDocuments = new Set<string>()
      const bookByDhlabid = new Map<number, BookRow>()
      books.forEach((book) => {
        if (book.dhlabid !== undefined) {
          bookByDhlabid.set(book.dhlabid, book)
        }
      })

      const bins = buildYearBins(startYear, endYear, binCount)

      for (const bin of bins) {
        const binBooks = filtered.filter((book) => {
          const year = parseYear(book.year)
          return year !== undefined && year >= bin.startYear && year <= bin.endYear
        })
        const binUrns = binBooks.map((book) => book.urn)
        binBooks.forEach((book) => uniqueDocuments.add(book.urn))

        if (binUrns.length === 0) {
          summary.push({
            binIndex: bin.index,
            binLabel: bin.label,
            startYear: bin.startYear,
            endYear: bin.endYear,
            documents: 0,
            nCounts: 0,
            mean: null,
            median: null,
            std: null,
          })
          continue
        }

        const freqRows = await fetchFrequencyRows(binUrns, 1)
        const binDetails: DetailRow[] = []
        freqRows.forEach((row) => {
          if (row.length < 4) return
          const dhlabid = parseDhlabid(row[0] as string | number | undefined) ?? null
          const matchedBook = dhlabid !== null ? bookByDhlabid.get(dhlabid) : undefined
          const count = Number(row[2])
          const total = Number(row[3])
          const detail: DetailRow = {
            year: matchedBook?.year ? Number(matchedBook.year) : bin.startYear,
            dhlabid,
            author: String(matchedBook?.author ?? ''),
            title: String(matchedBook?.title ?? ''),
            gender: normalizeGender(matchedBook?.gender),
            binIndex: bin.index,
            binLabel: bin.label,
            count,
            total,
          }
          details.push(detail)
          binDetails.push(detail)
        })

        const values = freqRows
          .filter((row) => String(row[1]) === TRIGGER_WORD)
          .map((row) => Number(row[3]))
          .filter((value) => Number.isFinite(value))
        allTotals.push(...values)
        const stats = toStats(values)
        summary.push({
          binIndex: bin.index,
          binLabel: bin.label,
          startYear: bin.startYear,
          endYear: bin.endYear,
          documents: binUrns.length,
          nCounts: values.length,
          mean: stats.mean,
          median: stats.median,
          std: stats.std,
        })

        const statsByGender: Record<'male' | 'female' | 'unknown', { mean: number | null; std: number | null; documents: number }> = {
          female: { mean: null, std: null, documents: 0 },
          male: { mean: null, std: null, documents: 0 },
          unknown: { mean: null, std: null, documents: 0 },
        }

        ;(['female', 'male', 'unknown'] as const).forEach((gender) => {
          const groupRows = binDetails.filter((row) => row.gender === gender)
          const groupValues = groupRows.map((row) => row.total).filter((value) => Number.isFinite(value))
          const groupStats = toStats(groupValues)
          statsByGender[gender] = {
            mean: groupStats.mean,
            std: groupStats.std,
            documents: groupRows.length,
          }
          byGenderSummary.push({
            binIndex: bin.index,
            binLabel: bin.label,
            gender,
            documents: groupRows.length,
            mean: groupStats.mean,
            std: groupStats.std,
          })
        })

        differences.push({
          binIndex: bin.index,
          binLabel: bin.label,
          femaleMean: statsByGender.female.mean,
          maleMean: statsByGender.male.mean,
          meanDiffFemaleMinusMale:
            statsByGender.female.mean !== null && statsByGender.male.mean !== null
              ? statsByGender.female.mean - statsByGender.male.mean
              : null,
          femaleStd: statsByGender.female.std,
          maleStd: statsByGender.male.std,
        })

        ;(['female', 'male'] as const).forEach((gender) => {
          const top = [...binDetails]
            .filter((row) => row.gender === gender)
            .sort((a, b) => b.total - a.total || b.count - a.count)
            .slice(0, 10)
          top.forEach((row, index) => {
            longestRows.push({
              binIndex: bin.index,
              binLabel: bin.label,
              gender,
              rank: index + 1,
              year: row.year,
              dhlabid: row.dhlabid,
              author: row.author,
              title: row.title,
              total: row.total,
              count: row.count,
            })
          })
        })
      }

      const totalStats = toStats(allTotals)
      setOverallStats({
        documents: uniqueDocuments.size,
        nCounts: allTotals.length,
        mean: totalStats.mean,
        median: totalStats.median,
        std: totalStats.std,
      })

      const sortedDetails = [...details].sort((a, b) => {
        if (a.year !== b.year) return a.year - b.year
        if (b.total !== a.total) return b.total - a.total
        return a.title.localeCompare(b.title)
      })

      setSummaryRows(summary)
      setDetailRows(sortedDetails)
      setBinGenderSummaryRows(byGenderSummary)
      setBinDifferenceRows(differences)
      setTopLongestRows(longestRows)
      setInfo(`Klar: ${summary.length} bins, ${uniqueDocuments.size} dokumenter, ${details.length} frekvensrader.`)
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Analyse feilet')
    } finally {
      setIsRunning(false)
    }
  }

  return (
    <div className="page">
      <h1>Frekvensanalyse med bins</h1>
      <p className="lead">
        Henter metadata, filtrerer bokutvalg, og plotter dokumentlengde (`total`) over bins i valgt årsintervall. Triggerordet "{TRIGGER_WORD}" brukes kun for å hente dokumentradene.
      </p>

      {!csvLoaded && !error && <p className="status info">Laster korpus...</p>}

      {csvLoaded && (
        <section className="panel">
          <h2>Korpusoversikt</h2>
          <div className="summaryGrid">
            <div className="summaryCard">
              <div className="summaryLabel">Antall bøker</div>
              <div className="summaryValue">{corpusSummary.total}</div>
            </div>
            <div className="summaryCard">
              <div className="summaryLabel">Antall menn</div>
              <div className="summaryValue">{corpusSummary.male}</div>
            </div>
            <div className="summaryCard">
              <div className="summaryLabel">Antall kvinner</div>
              <div className="summaryValue">{corpusSummary.female}</div>
            </div>
            <div className="summaryCard">
              <div className="summaryLabel">Ukjent kjønn</div>
              <div className="summaryValue">{corpusSummary.unknown}</div>
            </div>
          </div>
        </section>
      )}

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
            Antall bins
            <input
              type="number"
              value={binCount}
              min={1}
              onChange={(event) => setBinCount(Number(event.target.value))}
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
        <h2>Kvinner mot menn (mean +- std)</h2>
        <GenderErrorBarPlot rows={binGenderSummaryRows} />
      </section>

      <section className="panel">
        <h2>Aggregert dokumentlengde for valgt intervall</h2>
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Dokumenter</th>
                <th>N</th>
                <th>Mean lengde</th>
                <th>Median lengde</th>
                <th>Std lengde</th>
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
        <h2>Summary per bin (dokumentlengde)</h2>
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Bin</th>
                <th>Årsintervall</th>
                <th>Dokumenter</th>
                <th>N</th>
                <th>Mean lengde</th>
                <th>Median lengde</th>
                <th>Std lengde</th>
              </tr>
            </thead>
            <tbody>
              {summaryRows.length === 0 && (
                <tr>
                  <td colSpan={7}>Ingen resultater enda.</td>
                </tr>
              )}
              {summaryRows.map((row, index) => (
                <tr key={`${row.binIndex}-${index}`}>
                  <td>{row.binIndex}</td>
                  <td>{row.binLabel}</td>
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
        <h2>Mean og std for dokumentlengde per kjønn i hver bin</h2>
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Bin</th>
                <th>Årsintervall</th>
                <th>Kjønn</th>
                <th>Dokumenter</th>
                <th>Mean lengde</th>
                <th>Std lengde</th>
              </tr>
            </thead>
            <tbody>
              {binGenderSummaryRows.length === 0 && (
                <tr>
                  <td colSpan={6}>Ingen resultater enda.</td>
                </tr>
              )}
              {binGenderSummaryRows.map((row, index) => (
                <tr key={`${row.binIndex}-${row.gender}-${index}`}>
                  <td>{row.binIndex}</td>
                  <td>{row.binLabel}</td>
                  <td>{row.gender}</td>
                  <td>{row.documents}</td>
                  <td>{row.mean === null ? '' : row.mean.toFixed(4)}</td>
                  <td>{row.std === null ? '' : row.std.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>Forskjell kvinner - menn per bin (dokumentlengde)</h2>
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Bin</th>
                <th>Årsintervall</th>
                <th>Kvinner mean lengde</th>
                <th>Menn mean lengde</th>
                <th>Diff (kvinner-menn)</th>
                <th>Kvinner std lengde</th>
                <th>Menn std lengde</th>
              </tr>
            </thead>
            <tbody>
              {binDifferenceRows.length === 0 && (
                <tr>
                  <td colSpan={7}>Ingen differanseberegning enda.</td>
                </tr>
              )}
              {binDifferenceRows.map((row, index) => (
                <tr key={`${row.binIndex}-${index}`}>
                  <td>{row.binIndex}</td>
                  <td>{row.binLabel}</td>
                  <td>{row.femaleMean === null ? '' : row.femaleMean.toFixed(4)}</td>
                  <td>{row.maleMean === null ? '' : row.maleMean.toFixed(4)}</td>
                  <td>{row.meanDiffFemaleMinusMale === null ? '' : row.meanDiffFemaleMinusMale.toFixed(4)}</td>
                  <td>{row.femaleStd === null ? '' : row.femaleStd.toFixed(4)}</td>
                  <td>{row.maleStd === null ? '' : row.maleStd.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>10 lengste dokumenter per bin (kvinner og menn)</h2>
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Bin</th>
                <th>Årsintervall</th>
                <th>Kjønn</th>
                <th>Rang</th>
                <th>År</th>
                <th>Forfatter</th>
                <th>Tittel</th>
                <th>dhlabid</th>
                <th>Total</th>
                <th>Count</th>
              </tr>
            </thead>
            <tbody>
              {topLongestRows.length === 0 && (
                <tr>
                  <td colSpan={10}>Ingen toppliste enda.</td>
                </tr>
              )}
              {topLongestRows.map((row, index) => (
                <tr key={`${row.binIndex}-${row.gender}-${row.rank}-${index}`}>
                  <td>{row.binIndex}</td>
                  <td>{row.binLabel}</td>
                  <td>{row.gender}</td>
                  <td>{row.rank}</td>
                  <td>{row.year}</td>
                  <td>{row.author}</td>
                  <td>{row.title}</td>
                  <td>{row.dhlabid ?? ''}</td>
                  <td>{row.total}</td>
                  <td>{row.count}</td>
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
