"""Bounded, hash-routed verified-task ledger storage.

Each task ID is routed to one of 256 buckets per context. Buckets are split
into numbered parts before 80 MiB, below GitHub's 100 MiB hard limit.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LEDGER_DIR = ROOT / "data" / "completed"
MAX_PART_BYTES = 80 * 1024 * 1024
_SAFETY_BYTES = 1024


def bucket_for(task_id: str) -> str:
    return hashlib.sha256(task_id.encode("utf-8")).hexdigest()[:2]


def bucket_dir(context: str) -> Path:
    return LEDGER_DIR / context


def part_paths(context: str, bucket: str) -> list[Path]:
    return sorted(bucket_dir(context).glob(f"{bucket}-*.json"))


def load_bucket(context: str, bucket: str) -> set[str]:
    tasks: set[str] = set()
    for path in part_paths(context, bucket):
        with path.open(encoding="utf-8") as f:
            tasks.update(json.load(f).get("tasks", []))
    return tasks


def _payload(context: str, bucket: str, part: int, tasks: list[str], updated: str) -> dict:
    return {"version": 3, "context": context, "bucket": bucket, "part": part,
            "verified_count": len(tasks), "updated": updated, "tasks": tasks}


def save_bucket(context: str, bucket: str, task_ids: set[str], updated: str) -> None:
    """Write bounded parts and remove only obsolete parts for this bucket."""
    directory = bucket_dir(context)
    directory.mkdir(parents=True, exist_ok=True)
    chunks: list[list[str]] = []
    chunk: list[str] = []
    # Conservative exact-on-disk budget: quoted JSON string + indent/comma.
    chunk_bytes = 512
    for task_id in sorted(task_ids):
        entry_bytes = len(json.dumps(task_id).encode("utf-8")) + 8
        if chunk and chunk_bytes + entry_bytes > MAX_PART_BYTES - _SAFETY_BYTES:
            chunks.append(chunk)
            chunk, chunk_bytes = [], 512
        chunk.append(task_id)
        chunk_bytes += entry_bytes
    if chunk:
        chunks.append(chunk)

    written: list[Path] = []
    for number, tasks in enumerate(chunks, start=1):
        path = directory / f"{bucket}-{number:06d}.json"
        tmp_path = path.with_suffix(".json.tmp")
        with tmp_path.open("w", encoding="utf-8") as f:
            json.dump(_payload(context, bucket, number, tasks, updated), f, indent=2)
            f.write("\n")
        if tmp_path.stat().st_size >= MAX_PART_BYTES:
            raise RuntimeError(f"Refusing to write oversized ledger part: {tmp_path}")
        tmp_path.replace(path)
        written.append(path)

    for old_path in part_paths(context, bucket):
        if old_path not in written:
            old_path.unlink()


def verified_counts_by_context() -> dict[str, int]:
    counts: dict[str, int] = {}
    for path in LEDGER_DIR.glob("c??/*-*.json"):
        ctx = path.parent.name
        with path.open(encoding="utf-8") as f:
            for _ in range(15):
                line = f.readline()
                if not line:
                    break
                if "verified_count" in line:
                    counts[ctx] = counts.get(ctx, 0) + int(line.split(":", 1)[1].strip().rstrip(","))
                    break
    return counts


def total_verified_count() -> int:
    return sum(verified_counts_by_context().values())

