#!/usr/bin/env python3
"""Migrate legacy data/completed/cNN.json files into bounded hash parts."""
from __future__ import annotations

import json
import shutil
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import ledger


def main() -> None:
    source = ROOT / "data" / "completed"
    destination = ROOT / "data" / "completed-v3"
    if destination.exists():
        raise RuntimeError(f"Temporary migration directory already exists: {destination}")

    groups: dict[tuple[str, str], set[str]] = defaultdict(set)
    updated = ""
    for path in source.glob("c??.json"):
        with path.open(encoding="utf-8") as f:
            payload = json.load(f)
        context = payload["context"]
        updated = max(updated, payload.get("updated", ""))
        for task_id in payload.get("tasks", []):
            groups[(context, ledger.bucket_for(task_id))].add(task_id)

    old_dir = ledger.LEDGER_DIR
    ledger.LEDGER_DIR = destination
    try:
        for (context, bucket), task_ids in groups.items():
            ledger.save_bucket(context, bucket, task_ids, updated)
        written_count = ledger.total_verified_count()
    finally:
        ledger.LEDGER_DIR = old_dir

    if written_count != sum(len(tasks) for tasks in groups.values()):
        raise RuntimeError("Source count mismatch before replacement")
    # Keep the original until all new parts exist and have passed the count
    # check, then replace it atomically within data/.
    backup = ROOT / "data" / "completed-v2-backup"
    source.rename(backup)
    destination.rename(source)
    shutil.rmtree(backup)
    print(f"Created {sum(1 for _ in source.glob('c??/*-*.json'))} bounded parts for {sum(len(v) for v in groups.values()):,} tasks.")


if __name__ == "__main__":
    main()
