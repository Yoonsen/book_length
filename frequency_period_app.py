#!/usr/bin/env python3
"""
Generalized period comparison app for DH-Lab frequencies.

Workflow:
1) Read base corpus CSV (must include at least urn/new_urns, year, gender).
2) Optionally enrich rows with metadata from get_metadata (subject, literaryform, ddc...).
3) Filter books by metadata criteria.
4) Split by period(s) and group field (default: gender).
5) Query /dhlab/frequencies for one or more words (default: "og").
6) Compute mean/median/std over document frequency counts (3rd element in response row).
"""

from __future__ import annotations

import argparse
import csv
import json
import statistics
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


DEFAULT_METADATA_URL = "https://api.nb.no/dhlab/get_metadata"
DEFAULT_FREQUENCIES_URL = "https://api.nb.no/dhlab/frequencies"


@dataclass
class Period:
    name: str
    start: int
    end: int


def chunked(values: List[str], size: int) -> Iterable[List[str]]:
    for i in range(0, len(values), size):
        yield values[i : i + size]


def parse_periods(raw: str) -> List[Period]:
    periods: List[Period] = []
    for item in raw.split(","):
        segment = item.strip()
        if not segment:
            continue

        if ":" in segment:
            name, years = segment.split(":", 1)
            years = years.strip()
            label = name.strip()
        else:
            years = segment
            label = segment

        if "-" not in years:
            raise ValueError(f"Invalid period '{segment}'. Expected YYYY-YYYY.")

        start_s, end_s = years.split("-", 1)
        start = int(start_s.strip())
        end = int(end_s.strip())
        if end < start:
            raise ValueError(f"Invalid period '{segment}'. End year before start year.")
        periods.append(Period(name=label, start=start, end=end))
    if not periods:
        raise ValueError("No periods provided.")
    return periods


def post_json(url: str, payload: dict, timeout: int) -> object:
    data = json.dumps(payload).encode("utf-8")
    req = Request(
        url=url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def parse_table_or_rows(raw: object) -> List[dict]:
    if isinstance(raw, list):
        return [row for row in raw if isinstance(row, dict)]
    if isinstance(raw, dict):
        if raw and all(isinstance(v, dict) for v in raw.values()):
            row_keys = set()
            for field_values in raw.values():
                row_keys.update(field_values.keys())

            rows: List[dict] = []
            for key in sorted(row_keys, key=lambda x: int(x) if str(x).isdigit() else str(x)):
                row = {}
                for field, field_values in raw.items():
                    if key in field_values:
                        row[field] = field_values[key]
                rows.append(row)
            return rows

        for key in ("data", "rows", "result", "results"):
            value = raw.get(key)
            if isinstance(value, list):
                return [row for row in value if isinstance(row, dict)]
    return []


def normalize_urn(row: dict) -> Optional[str]:
    urn = (row.get("urn") or row.get("new_urns") or "").strip()
    return urn or None


def normalize_year(row: dict) -> Optional[int]:
    value = str(row.get("year", "")).strip()
    if not value:
        return None
    try:
        return int(float(value))
    except ValueError:
        return None


def normalize_dhlabid(value: object) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def merge_metadata_into_rows(
    rows: List[dict],
    metadata_url: str,
    timeout: int,
    batch_size: int,
) -> Dict[str, dict]:
    urns = sorted({urn for row in rows if (urn := normalize_urn(row))})
    metadata_by_urn: Dict[str, dict] = {}

    for batch in chunked(urns, batch_size):
        raw = post_json(metadata_url, {"urns": batch}, timeout=timeout)
        meta_rows = parse_table_or_rows(raw)
        for meta in meta_rows:
            urn = (meta.get("urn") or meta.get("new_urns") or "").strip()
            if not urn:
                continue
            metadata_by_urn[urn] = meta

    for row in rows:
        urn = normalize_urn(row)
        if not urn or urn not in metadata_by_urn:
            continue
        meta = metadata_by_urn[urn]
        for key in ("dhlabid", "subject", "subjects", "literaryform", "ddc", "genres"):
            if key in meta and (row.get(key, "") in ("", None)):
                row[key] = meta[key]

    return metadata_by_urn


def split_words(raw: str) -> List[str]:
    words = [w.strip() for w in raw.split(",")]
    return [w for w in words if w]


def row_matches_criteria(
    row: dict,
    required_gender: Optional[str],
    subject_contains: Optional[str],
    literaryform_equals: Optional[str],
    dewey_prefix: Optional[str],
) -> bool:
    if required_gender:
        if str(row.get("gender", "")).strip().lower() != required_gender.lower():
            return False

    if subject_contains:
        subjects_value = str(row.get("subjects") or row.get("subject") or "")
        if subject_contains.lower() not in subjects_value.lower():
            return False

    if literaryform_equals:
        literary_value = str(row.get("literaryform", "")).strip().lower()
        if literary_value != literaryform_equals.lower():
            return False

    if dewey_prefix:
        dewey = str(row.get("ddc", "")).strip()
        if not dewey.startswith(dewey_prefix):
            return False

    return True


def call_frequencies(
    frequencies_url: str,
    urns: Sequence[str],
    words: Sequence[str],
    cutoff: int,
    timeout: int,
) -> List[list]:
    payload = {
        "cutoff": cutoff,
        "urns": list(urns),
        "words": list(words),
    }
    raw = post_json(frequencies_url, payload, timeout=timeout)
    if isinstance(raw, list):
        return [row for row in raw if isinstance(row, list)]
    return []


def stats_for_counts(values: Sequence[int]) -> Tuple[Optional[float], Optional[float], Optional[float]]:
    if not values:
        return None, None, None
    if len(values) == 1:
        value = float(values[0])
        return value, value, 0.0
    mean_value = statistics.mean(values)
    median_value = statistics.median(values)
    std_value = statistics.pstdev(values)
    return float(mean_value), float(median_value), float(std_value)


def write_csv(path: Path, fieldnames: Sequence[str], rows: Sequence[dict]) -> None:
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(fieldnames))
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Compare frequencies across periods and metadata groups."
    )
    parser.add_argument("--input", default="Helenes_korpusdata.csv")
    parser.add_argument("--metadata-url", default=DEFAULT_METADATA_URL)
    parser.add_argument("--frequencies-url", default=DEFAULT_FREQUENCIES_URL)
    parser.add_argument("--periods", default="2010-2020,2020-2025")
    parser.add_argument("--group-by", default="gender", help="Metadata field used for grouping")
    parser.add_argument("--words", default="og", help="Comma-separated words")
    parser.add_argument("--cutoff", type=int, default=1)
    parser.add_argument("--gender", default=None, help="Optional fixed gender filter")
    parser.add_argument("--subject-contains", default=None)
    parser.add_argument("--literaryform", default=None)
    parser.add_argument("--dewey-prefix", default=None)
    parser.add_argument("--batch-size", type=int, default=50)
    parser.add_argument("--timeout", type=int, default=45)
    parser.add_argument("--skip-metadata-enrichment", action="store_true")
    parser.add_argument("--out-prefix", default="frequency_period")
    args = parser.parse_args()

    periods = parse_periods(args.periods)
    words = split_words(args.words)
    if not words:
        raise ValueError("No words provided.")

    input_path = Path(args.input)
    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    with input_path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        corpus_rows = list(reader)

    if not args.skip_metadata_enrichment:
        try:
            merge_metadata_into_rows(
                rows=corpus_rows,
                metadata_url=args.metadata_url,
                timeout=args.timeout,
                batch_size=max(1, args.batch_size),
            )
        except (HTTPError, URLError, ValueError) as exc:
            raise RuntimeError(f"Metadata enrichment failed: {exc}") from exc

    enriched_fields = sorted({key for row in corpus_rows for key in row.keys()})
    books_out = Path(f"{args.out_prefix}_books.csv")
    write_csv(books_out, enriched_fields, corpus_rows)

    results_rows: List[dict] = []
    summary_rows: List[dict] = []

    for period in periods:
        period_books = [
            row
            for row in corpus_rows
            if (year := normalize_year(row)) is not None and period.start <= year <= period.end
        ]

        filtered_books = [
            row
            for row in period_books
            if row_matches_criteria(
                row=row,
                required_gender=args.gender,
                subject_contains=args.subject_contains,
                literaryform_equals=args.literaryform,
                dewey_prefix=args.dewey_prefix,
            )
        ]

        groups = sorted({str(row.get(args.group_by, "")).strip() or "unknown" for row in filtered_books})
        for group_value in groups:
            group_rows = [
                row
                for row in filtered_books
                if (str(row.get(args.group_by, "")).strip() or "unknown") == group_value
            ]
            urns = [urn for row in group_rows if (urn := normalize_urn(row))]
            if not urns:
                summary_rows.append(
                    {
                        "period": period.name,
                        "group": group_value,
                        "word": "",
                        "documents": 0,
                        "n_counts": 0,
                        "mean": "",
                        "median": "",
                        "std": "",
                    }
                )
                continue

            try:
                freq_rows = call_frequencies(
                    frequencies_url=args.frequencies_url,
                    urns=urns,
                    words=words,
                    cutoff=args.cutoff,
                    timeout=args.timeout,
                )
            except (HTTPError, URLError, ValueError) as exc:
                raise RuntimeError(
                    f"Frequencies call failed for period '{period.name}', group '{group_value}': {exc}"
                ) from exc

            for freq_row in freq_rows:
                if len(freq_row) < 4:
                    continue
                dhlabid = normalize_dhlabid(freq_row[0])
                word = str(freq_row[1])
                count = int(freq_row[2])
                total = int(freq_row[3])
                results_rows.append(
                    {
                        "period": period.name,
                        "group": group_value,
                        "dhlabid": dhlabid if dhlabid is not None else "",
                        "word": word,
                        "count": count,
                        "total": total,
                    }
                )

            for word in words:
                counts = [
                    int(row["count"])
                    for row in results_rows
                    if row["period"] == period.name and row["group"] == group_value and row["word"] == word
                ]
                mean_value, median_value, std_value = stats_for_counts(counts)
                summary_rows.append(
                    {
                        "period": period.name,
                        "group": group_value,
                        "word": word,
                        "documents": len(urns),
                        "n_counts": len(counts),
                        "mean": "" if mean_value is None else f"{mean_value:.4f}",
                        "median": "" if median_value is None else f"{median_value:.4f}",
                        "std": "" if std_value is None else f"{std_value:.4f}",
                    }
                )

    details_out = Path(f"{args.out_prefix}_details.csv")
    summary_out = Path(f"{args.out_prefix}_summary.csv")
    write_csv(details_out, ["period", "group", "dhlabid", "word", "count", "total"], results_rows)
    write_csv(
        summary_out,
        ["period", "group", "word", "documents", "n_counts", "mean", "median", "std"],
        summary_rows,
    )

    print(f"Read books: {len(corpus_rows)}")
    print(f"Words: {', '.join(words)}")
    print(f"Periods: {', '.join(f'{p.name}({p.start}-{p.end})' for p in periods)}")
    print(f"Wrote enriched books: {books_out}")
    print(f"Wrote frequency details: {details_out}")
    print(f"Wrote summary stats: {summary_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
