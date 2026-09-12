"""Small, per-context verified-task ledger helpers.

The public scheduler only needs data/blocks.json.  Detailed task IDs stay in
these shards so verification can reject duplicates without serving a growing
global ledger to every miner.
"""
from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LEDGER_DIR = ROOT / "data" / "completed"


def shard_path(context: str) -> Path:
    return LEDGER_DIR / f"{context}.json"


def load_context(context: str) -> dict:
    path = shard_path(context)
    if not path.exists():
        return {"version": 2, "context": context, "verified_count": 0, "tasks": []}
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def save_context(context: str, task_ids: set[str], updated: str) -> None:
    LEDGER_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 2,
        "context": context,
        "verified_count": len(task_ids),
        "updated": updated,
        "tasks": sorted(task_ids),
    }
    with shard_path(context).open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
