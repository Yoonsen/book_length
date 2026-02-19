import { useEffect, useMemo, useState } from 'react'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'
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
  femaleN: number
  maleN: number
  femaleMean: number | null
  maleMean: number | null
  meanDiffFemaleMinusMale: number | null
  femaleStd: number | null
  maleStd: number | null
  femaleSe: number | null
  maleSe: number | null
  diffSe: number | null
  zScore: number | null
  pValueTwoSided: number | null
  significance: string
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

function erfApprox(x: number): number {
  // Abramowitz and Stegun 7.1.26 approximation.
  const sign = x < 0 ? -1 : 1
  const absX = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * absX)
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const y =
    1 -
    (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) *
      t *
      Math.exp(-absX * absX))
  return sign * y
}

function normalCdf(x: number): number {
  return 0.5 * (1 + erfApprox(x / Math.sqrt(2)))
}

function twoSidedPValueFromZ(z: number): number {
  const p = 2 * (1 - normalCdf(Math.abs(z)))
  return Math.max(0, Math.min(1, p))
}

function significanceLabel(pValue: number | null): string {
  if (pValue === null || !Number.isFinite(pValue)) return 'ns'
  if (pValue < 0.001) return '***'
  if (pValue < 0.01) return '**'
  if (pValue < 0.05) return '*'
  return 'ns'
}

function linearTrend(points: Array<{ x: number; y: number }>): {
  slope: number
  intercept: number
  r2: number
} | null {
  if (points.length < 2) return null

  const n = points.length
  const sumX = points.reduce((acc, p) => acc + p.x, 0)
  const sumY = points.reduce((acc, p) => acc + p.y, 0)
  const meanX = sumX / n
  const meanY = sumY / n

  let sxx = 0
  let sxy = 0
  let syy = 0
  for (const p of points) {
    const dx = p.x - meanX
    const dy = p.y - meanY
    sxx += dx * dx
    sxy += dx * dy
    syy += dy * dy
  }

  if (sxx === 0 || syy === 0) return null
  const slope = sxy / sxx
  const intercept = meanY - slope * meanX
  const r2 = (sxy * sxy) / (sxx * syy)

  return { slope, intercept, r2 }
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

function DiffTrendPlot({ rows }: { rows: BinDifferenceRow[] }) {
  const width = 900
  const height = 280
  const padding = 36

  const points = rows
    .filter((row) => row.meanDiffFemaleMinusMale !== null)
    .map((row) => ({
      binIndex: row.binIndex,
      binLabel: row.binLabel,
      diff: row.meanDiffFemaleMinusMale as number,
      diffSe: row.diffSe,
    }))

  if (points.length === 0) {
    return <p>Ingen diff-data å plotte enda.</p>
  }

  const uniqueBins = [...new Set(points.map((p) => p.binIndex))].sort((a, b) => a - b)
  const yCandidates = points.flatMap((p) =>
    p.diffSe !== null ? [p.diff - p.diffSe, p.diff, p.diff + p.diffSe] : [p.diff],
  )
  const rawMinY = Math.min(...yCandidates, 0)
  const rawMaxY = Math.max(...yCandidates, 0)
  const rawSpan = rawMaxY - rawMinY || 1
  const margin = rawSpan * 0.08
  const minY = rawMinY - margin
  const maxY = rawMaxY + margin
  const ySpan = maxY - minY || 1

  const xScale = (binIndex: number) => {
    if (uniqueBins.length <= 1) return width / 2
    const idx = uniqueBins.indexOf(binIndex)
    return padding + (idx / (uniqueBins.length - 1)) * (width - padding * 2)
  }
  const yScale = (value: number) =>
    height - padding - ((value - minY) / ySpan) * (height - padding * 2)
  const yTicks = 5
  const yTickValues = Array.from({ length: yTicks + 1 }, (_, i) => minY + (ySpan * i) / yTicks)
  const formatTick = (value: number) =>
    new Intl.NumberFormat('nb-NO', { maximumFractionDigits: 0 }).format(value)

  const linePoints = points
    .map((p) => `${xScale(p.binIndex)},${yScale(p.diff)}`)
    .join(' ')

  return (
    <div className="chartWrap">
      <svg viewBox={`0 0 ${width} ${height}`} className="chart">
        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="#94a3b8" />
        <line x1={padding} y1={padding} x2={padding} y2={height - padding} stroke="#94a3b8" />
        {yTickValues.map((tick) => {
          const y = yScale(tick)
          return (
            <g key={`ytick-${tick.toFixed(2)}`}>
              <line x1={padding} y1={y} x2={width - padding} y2={y} stroke="#e5e7eb" />
              <text x={padding - 8} y={y + 4} textAnchor="end" fontSize="11" fill="#475569">
                {formatTick(tick)}
              </text>
            </g>
          )
        })}
        <line
          x1={padding}
          y1={yScale(0)}
          x2={width - padding}
          y2={yScale(0)}
          stroke="#ef4444"
          strokeDasharray="4 4"
        />
        <polyline fill="none" stroke="#7c3aed" strokeWidth="2" points={linePoints} />

        {points.map((p) => {
          const x = xScale(p.binIndex)
          const y = yScale(p.diff)
          return (
            <g key={`diff-${p.binIndex}`}>
              {p.diffSe !== null && (
                <>
                  <line x1={x} y1={yScale(p.diff - p.diffSe)} x2={x} y2={yScale(p.diff + p.diffSe)} stroke="#7c3aed" strokeWidth="2" />
                  <line x1={x - 4} y1={yScale(p.diff - p.diffSe)} x2={x + 4} y2={yScale(p.diff - p.diffSe)} stroke="#7c3aed" strokeWidth="2" />
                  <line x1={x - 4} y1={yScale(p.diff + p.diffSe)} x2={x + 4} y2={yScale(p.diff + p.diffSe)} stroke="#7c3aed" strokeWidth="2" />
                </>
              )}
              <circle cx={x} cy={y} r="3.5" fill="#7c3aed" />
            </g>
          )
        })}

        {points.map((p) => (
          <text
            key={`xlabel-${p.binIndex}`}
            x={xScale(p.binIndex)}
            y={height - 10}
            textAnchor="middle"
            fontSize="11"
            fill="#475569"
          >
            {p.binLabel}
          </text>
        ))}
      </svg>
      <div className="legend">
        <span><i className="dot diff" /> diff (kvinner - menn)</span>
        <span><i className="dot std" /> diff SE (pinner)</span>
      </div>
      <p className="plotNote">
        Stiplet linje er null (ingen forskjell). Punkt under linjen betyr at kvinner har kortere dokumentlengde enn menn i den binen.
      </p>
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
  const [minLength, setMinLength] = useState(10000)
  const [maxLength, setMaxLength] = useState('')

  const [genderFilter, setGenderFilter] = useState('all')
  const [subjectContains, setSubjectContains] = useState('')

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

  const exportWorkbook = () => {
    const workbook = XLSX.utils.book_new()

    const corpusSheetRows = [
      {
        metric: 'Antall bøker',
        value: corpusSummary.total,
      },
      {
        metric: 'Antall menn',
        value: corpusSummary.male,
      },
      {
        metric: 'Antall kvinner',
        value: corpusSummary.female,
      },
      {
        metric: 'Ukjent kjønn',
        value: corpusSummary.unknown,
      },
    ]
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(corpusSheetRows), 'Korpusoversikt')

    if (overallStats) {
      const overallRows = [
        {
          documents: overallStats.documents,
          n: overallStats.nCounts,
          mean_length: overallStats.mean,
          median_length: overallStats.median,
          std_length: overallStats.std,
        },
      ]
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(overallRows), 'Aggregert')
    }

    if (summaryRows.length > 0) {
      const summarySheet = summaryRows.map((row) => ({
        bin: row.binIndex,
        year_range: row.binLabel,
        start_year: row.startYear,
        end_year: row.endYear,
        documents: row.documents,
        n: row.nCounts,
        mean_length: row.mean,
        median_length: row.median,
        std_length: row.std,
      }))
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summarySheet), 'Summary_bin')
    }

    if (binGenderSummaryRows.length > 0) {
      const genderSheet = binGenderSummaryRows.map((row) => ({
        bin: row.binIndex,
        year_range: row.binLabel,
        gender: row.gender,
        documents: row.documents,
        mean_length: row.mean,
        std_length: row.std,
      }))
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(genderSheet), 'Gender_bin')
    }

    if (binDifferenceRows.length > 0) {
      const diffSheet = binDifferenceRows.map((row) => ({
        bin: row.binIndex,
        year_range: row.binLabel,
        female_n: row.femaleN,
        male_n: row.maleN,
        female_mean_length: row.femaleMean,
        male_mean_length: row.maleMean,
        diff_female_minus_male: row.meanDiffFemaleMinusMale,
        female_std: row.femaleStd,
        male_std: row.maleStd,
        female_se: row.femaleSe,
        male_se: row.maleSe,
        diff_se: row.diffSe,
        z: row.zScore,
        p_two_sided: row.pValueTwoSided,
        significance: row.significance,
      }))
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(diffSheet), 'Diff_bin')

      const trendPoints = binDifferenceRows
        .filter((row) => row.meanDiffFemaleMinusMale !== null)
        .map((row) => ({
          x: row.binIndex,
          y: row.meanDiffFemaleMinusMale as number,
          label: row.binLabel,
        }))
      const trend = linearTrend(trendPoints)
      if (trend) {
        const trendSummary = [
          {
            metric: 'n_bins',
            value: trendPoints.length,
          },
          {
            metric: 'slope_diff_per_bin',
            value: trend.slope,
          },
          {
            metric: 'intercept',
            value: trend.intercept,
          },
          {
            metric: 'r_squared',
            value: trend.r2,
          },
        ]

        const trendRows = trendPoints.map((p) => ({
          bin: p.x,
          year_range: p.label,
          observed_diff: p.y,
          fitted_diff: trend.intercept + trend.slope * p.x,
          residual: p.y - (trend.intercept + trend.slope * p.x),
        }))

        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(trendSummary), 'Trend_summary')
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(trendRows), 'Trend_diff')
      }
    }

    if (topLongestRows.length > 0) {
      const topSheet = topLongestRows.map((row) => ({
        bin: row.binIndex,
        year_range: row.binLabel,
        gender: row.gender,
        rank: row.rank,
        year: row.year,
        author: row.author,
        title: row.title,
        dhlabid: row.dhlabid,
        total: row.total,
        count_og: row.count,
      }))
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(topSheet), 'Top10_longest')
    }

    if (detailRows.length > 0) {
      const detailSheet = detailRows.map((row) => ({
        year: row.year,
        bin: row.binIndex,
        year_range: row.binLabel,
        gender: row.gender,
        author: row.author,
        title: row.title,
        dhlabid: row.dhlabid,
        total: row.total,
        count_og: row.count,
      }))
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(detailSheet), 'Details')
    }

    const filename = `dokumentlengde_bins_${startYear}_${endYear}.xlsx`
    XLSX.writeFile(workbook, filename)
  }

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
      const maxLengthValue = maxLength.trim() === '' ? null : Number(maxLength)
      if (!Number.isFinite(minLength) || minLength < 0) {
        throw new Error('Min lengde må være 0 eller høyere.')
      }
      if (maxLengthValue !== null && (!Number.isFinite(maxLengthValue) || maxLengthValue < minLength)) {
        throw new Error('Maks lengde må være tom eller større enn/lik min lengde.')
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
        const binDetailsRaw: DetailRow[] = []
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
          binDetailsRaw.push(detail)
        })

        const binDetails = binDetailsRaw.filter(
          (row) => row.total >= minLength && (maxLengthValue === null || row.total <= maxLengthValue),
        )
        details.push(...binDetails)
        binDetails.forEach((row) => {
          uniqueDocuments.add(row.dhlabid !== null ? String(row.dhlabid) : `${row.year}:${row.author}:${row.title}`)
        })

        const values = binDetails
          .map((row) => row.total)
          .filter((value) => Number.isFinite(value))
        allTotals.push(...values)
        const stats = toStats(values)
        summary.push({
          binIndex: bin.index,
          binLabel: bin.label,
          startYear: bin.startYear,
          endYear: bin.endYear,
          documents: binDetails.length,
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
          femaleN: statsByGender.female.documents,
          maleN: statsByGender.male.documents,
          femaleMean: statsByGender.female.mean,
          maleMean: statsByGender.male.mean,
          meanDiffFemaleMinusMale:
            statsByGender.female.mean !== null && statsByGender.male.mean !== null
              ? statsByGender.female.mean - statsByGender.male.mean
              : null,
          femaleStd: statsByGender.female.std,
          maleStd: statsByGender.male.std,
          femaleSe:
            statsByGender.female.std !== null && statsByGender.female.documents > 0
              ? statsByGender.female.std / Math.sqrt(statsByGender.female.documents)
              : null,
          maleSe:
            statsByGender.male.std !== null && statsByGender.male.documents > 0
              ? statsByGender.male.std / Math.sqrt(statsByGender.male.documents)
              : null,
          diffSe:
            statsByGender.female.std !== null &&
            statsByGender.male.std !== null &&
            statsByGender.female.documents > 0 &&
            statsByGender.male.documents > 0
              ? Math.sqrt(
                  (statsByGender.female.std ** 2) / statsByGender.female.documents +
                    (statsByGender.male.std ** 2) / statsByGender.male.documents,
                )
              : null,
          zScore:
            statsByGender.female.mean !== null &&
            statsByGender.male.mean !== null &&
            statsByGender.female.std !== null &&
            statsByGender.male.std !== null &&
            statsByGender.female.documents > 0 &&
            statsByGender.male.documents > 0
              ? (() => {
                  const se = Math.sqrt(
                    (statsByGender.female.std ** 2) / statsByGender.female.documents +
                      (statsByGender.male.std ** 2) / statsByGender.male.documents,
                  )
                  if (!Number.isFinite(se) || se === 0) return null
                  return (statsByGender.female.mean - statsByGender.male.mean) / se
                })()
              : null,
          pValueTwoSided:
            statsByGender.female.mean !== null &&
            statsByGender.male.mean !== null &&
            statsByGender.female.std !== null &&
            statsByGender.male.std !== null &&
            statsByGender.female.documents > 0 &&
            statsByGender.male.documents > 0
              ? (() => {
                  const se = Math.sqrt(
                    (statsByGender.female.std ** 2) / statsByGender.female.documents +
                      (statsByGender.male.std ** 2) / statsByGender.male.documents,
                  )
                  if (!Number.isFinite(se) || se === 0) return null
                  const z = (statsByGender.female.mean - statsByGender.male.mean) / se
                  return twoSidedPValueFromZ(z)
                })()
              : null,
          significance:
            statsByGender.female.mean !== null &&
            statsByGender.male.mean !== null &&
            statsByGender.female.std !== null &&
            statsByGender.male.std !== null &&
            statsByGender.female.documents > 0 &&
            statsByGender.male.documents > 0
              ? (() => {
                  const se = Math.sqrt(
                    (statsByGender.female.std ** 2) / statsByGender.female.documents +
                      (statsByGender.male.std ** 2) / statsByGender.male.documents,
                  )
                  if (!Number.isFinite(se) || se === 0) return 'ns'
                  const z = (statsByGender.female.mean - statsByGender.male.mean) / se
                  return significanceLabel(twoSidedPValueFromZ(z))
                })()
              : 'ns',
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
      setInfo(`Klar: ${summary.length} bins, ${uniqueDocuments.size} dokumenter, ${details.length} frekvensrader (etter lengdefilter).`)
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
        Henter metadata, filtrerer bokutvalg, og plotter dokumentlengde (`total`) over bins i valgt årsintervall.
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
            Min lengde
            <input
              type="number"
              value={minLength}
              min={0}
              onChange={(event) => setMinLength(Number(event.target.value))}
            />
          </label>
          <label>
            Maks lengde (valgfri)
            <input
              type="number"
              value={maxLength}
              min={0}
              placeholder="tom = ingen øvre grense"
              onChange={(event) => setMaxLength(event.target.value)}
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
        </div>
        <button disabled={isRunning || !csvLoaded} onClick={() => void runAnalysis()}>
          {isRunning ? 'Kjører...' : 'Kjør analyse'}
        </button>
        <button
          disabled={!csvLoaded || (summaryRows.length === 0 && detailRows.length === 0)}
          onClick={exportWorkbook}
          style={{ marginLeft: '0.6rem' }}
        >
          Last ned Excel
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
        <DiffTrendPlot rows={binDifferenceRows} />
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Bin</th>
                <th>Årsintervall</th>
                <th>Kvinner N</th>
                <th>Menn N</th>
                <th>Kvinner mean lengde</th>
                <th>Menn mean lengde</th>
                <th>Signifikans</th>
                <th>Diff (kvinner-menn)</th>
                <th>Kvinner std lengde</th>
                <th>Menn std lengde</th>
                <th>Kvinner SE</th>
                <th>Menn SE</th>
                <th>Diff SE</th>
                <th>z</th>
                <th>p (tosidig)</th>
              </tr>
            </thead>
            <tbody>
              {binDifferenceRows.length === 0 && (
                <tr>
                  <td colSpan={15}>Ingen differanseberegning enda.</td>
                </tr>
              )}
              {binDifferenceRows.map((row, index) => (
                <tr key={`${row.binIndex}-${index}`}>
                  <td>{row.binIndex}</td>
                  <td>{row.binLabel}</td>
                  <td>{row.femaleN}</td>
                  <td>{row.maleN}</td>
                  <td>{row.femaleMean === null ? '' : row.femaleMean.toFixed(4)}</td>
                  <td>{row.maleMean === null ? '' : row.maleMean.toFixed(4)}</td>
                  <td>{row.significance}</td>
                  <td>{row.meanDiffFemaleMinusMale === null ? '' : row.meanDiffFemaleMinusMale.toFixed(4)}</td>
                  <td>{row.femaleStd === null ? '' : row.femaleStd.toFixed(4)}</td>
                  <td>{row.maleStd === null ? '' : row.maleStd.toFixed(4)}</td>
                  <td>{row.femaleSe === null ? '' : row.femaleSe.toFixed(4)}</td>
                  <td>{row.maleSe === null ? '' : row.maleSe.toFixed(4)}</td>
                  <td>{row.diffSe === null ? '' : row.diffSe.toFixed(4)}</td>
                  <td>{row.zScore === null ? '' : row.zScore.toFixed(4)}</td>
                  <td>{row.pValueTwoSided === null ? '' : row.pValueTwoSided.toExponential(3)}</td>
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
