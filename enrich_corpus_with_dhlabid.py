#!/usr/bin/env python3
import argparse
import csv
import json
import sys
import time
from pathlib import Path
from typing import Dict, Iterable, List, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


DEFAULT_METADATA_URL = "https://api.nb.no/dhlab/get_metadata"


def chunked(values: List[str], size: int) -> Iterable[List[str]]:
    for i in range(0, len(values), size):
        yield values[i : i + size]


def extract_urn(row: dict) -> Optional[str]:
    urn = (row.get("urn") or row.get("new_urns") or "").strip()
    return urn or None


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


def parse_metadata_rows(raw: object) -> List[dict]:
    if isinstance(raw, list):
        return [row for row in raw if isinstance(row, dict)]
    if isinstance(raw, dict):
        # Handle "table" response where each field is an index-keyed object:
        # {"dhlabid":{"0":100...}, "urn":{"0":"URN:..."}}
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


def extract_dhlabid(row: dict) -> Optional[int]:
    for key in ("dhlabid", "dhlab_id", "docid", "doc_id"):
        value = row.get(key)
        if value is None or value == "":
            continue
        try:
            return int(value)
        except (TypeError, ValueError):
            continue
    return None


def build_urn_to_dhlabid(
    urns: List[str],
    metadata_url: str,
    timeout: int,
    batch_size: int,
    sleep_seconds: float,
) -> Dict[str, int]:
    mapping: Dict[str, int] = {}

    for idx, batch in enumerate(chunked(urns, batch_size), start=1):
        payload = {"urns": batch}
        try:
            raw = post_json(metadata_url, payload, timeout=timeout)
        except HTTPError as exc:
            raise RuntimeError(
                f"Metadata call failed for batch {idx} with HTTP {exc.code}"
            ) from exc
        except URLError as exc:
            raise RuntimeError(f"Metadata call failed for batch {idx}: {exc}") from exc

        rows = parse_metadata_rows(raw)
        for row in rows:
            urn = (row.get("urn") or row.get("new_urns") or "").strip()
            dhlabid = extract_dhlabid(row)
            if urn and dhlabid is not None:
                mapping[urn] = dhlabid

        if sleep_seconds > 0:
            time.sleep(sleep_seconds)

    return mapping


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Enrich a corpus CSV with dhlabid using get_metadata."
    )
    parser.add_argument(
        "--input",
        default="Helenes_korpusdata.csv",
        help="Input CSV path (default: Helenes_korpusdata.csv)",
    )
    parser.add_argument(
        "--output",
        default="Helenes_korpusdata_with_dhlabid.csv",
        help="Output CSV path (default: Helenes_korpusdata_with_dhlabid.csv)",
    )
    parser.add_argument(
        "--metadata-url",
        default=DEFAULT_METADATA_URL,
        help=f"Metadata endpoint (default: {DEFAULT_METADATA_URL})",
    )
    parser.add_argument("--timeout", type=int, default=30, help="HTTP timeout in seconds")
    parser.add_argument("--batch-size", type=int, default=50, help="URNs per metadata request")
    parser.add_argument(
        "--sleep-seconds",
        type=float,
        default=0.0,
        help="Optional pause between batch requests",
    )
    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)

    if not input_path.exists():
        print(f"Input file not found: {input_path}", file=sys.stderr)
        return 1

    with input_path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
        fieldnames = list(reader.fieldnames or [])

    urns = sorted({urn for row in rows if (urn := extract_urn(row))})
    if not urns:
        print("No urn/new_urns values found in input CSV.", file=sys.stderr)
        return 1

    urn_to_dhlabid = build_urn_to_dhlabid(
        urns=urns,
        metadata_url=args.metadata_url,
        timeout=args.timeout,
        batch_size=max(1, args.batch_size),
        sleep_seconds=max(0.0, args.sleep_seconds),
    )

    if "dhlabid" not in fieldnames:
        fieldnames.append("dhlabid")

    hits = 0
    missing_urns: List[str] = []
    for row in rows:
        urn = extract_urn(row)
        if urn and urn in urn_to_dhlabid:
            row["dhlabid"] = str(urn_to_dhlabid[urn])
            hits += 1
        else:
            row["dhlabid"] = row.get("dhlabid", "")
            if urn:
                missing_urns.append(urn)

    with output_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    print(f"Read rows: {len(rows)}")
    print(f"Unique URNs: {len(urns)}")
    print(f"Mapped URNs: {len(urn_to_dhlabid)}")
    print(f"Rows enriched with dhlabid: {hits}")
    if missing_urns:
        unique_missing = sorted(set(missing_urns))
        print(f"Missing URNs: {len(unique_missing)}")
        for urn in unique_missing[:20]:
            print(f"  - {urn}")
    print(f"Wrote output: {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
