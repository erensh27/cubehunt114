#!/usr/bin/env python3
"""One-time migration from data/completed.json to data/completed/cNN.json."""
from __future__ import annotations

import json
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "data" / "completed.json"
DESTINATION = ROOT / "data" / "completed"
BLOCKS = ROOT / "data" / "blocks.json"
TASK_RE = re.compile(r"^[^:]+:(c\d{2}):(\d+):\d+$")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def main() -> None:
    source = json.loads(SOURCE.read_text(encoding="utf-8")) if SOURCE.exists() else None
    grouped: dict[str, list[str]] = defaultdict(list)
    high_water: dict[str, int] = {}
    task_ids = source.get("tasks", []) if source else [
        task_id
        for path in DESTINATION.glob("c??.json")
        for task_id in json.loads(path.read_text(encoding="utf-8")).get("tasks", [])
    ]
    for task_id in task_ids:
        match = TASK_RE.match(task_id)
        if not match:
            raise ValueError(f"Unexpected task ID: {task_id}")
        context, row = match.groups()
        grouped[context].append(task_id)
        high_water[context] = max(high_water.get(context, 0), int(row))

    DESTINATION.mkdir(exist_ok=True)
    updated = source.get("updated", now_iso()) if source else now_iso()
    for context, tasks in grouped.items():
        (DESTINATION / f"{context}.json").write_text(json.dumps({
            "version": 2, "context": context, "verified_count": len(tasks),
            "updated": updated, "tasks": sorted(tasks),
        }, indent=2) + "\n", encoding="utf-8")

    blocks = json.loads(BLOCKS.read_text(encoding="utf-8"))
    blocks["high_water_marks"] = {
        # Exclusive boundary: miners start at this row, never the last row
        # that has already been verified.
        context: high_water.get(context, -128) + 128
        for context in blocks.get("frontiers", {})
    }
    BLOCKS.write_text(json.dumps(blocks, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(grouped)} shards containing {sum(map(len, grouped.values()))} task IDs.")


if __name__ == "__main__":
    main()
