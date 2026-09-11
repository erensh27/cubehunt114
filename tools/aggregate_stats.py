#!/usr/bin/env python3
"""Daily aggregation and leaderboard updater for 114 project.

Executed by GitHub Actions schedule (every 24 hours) or workflow_dispatch.
Ensures consistency across data files and recalculates rankings.
"""
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def main():
    completed_path   = ROOT / "data/completed.json"
    leaderboard_path = ROOT / "data/leaderboard.json"
    stats_path       = ROOT / "data/stats.json"
    blocks_path      = ROOT / "data/blocks.json"

    with open(completed_path,   "r", encoding="utf-8") as f: completed   = json.load(f)
    with open(leaderboard_path, "r", encoding="utf-8") as f: leaderboard = json.load(f)
    with open(stats_path,       "r", encoding="utf-8") as f: stats       = json.load(f)
    with open(blocks_path,      "r", encoding="utf-8") as f: blocks      = json.load(f)

    contributors = leaderboard.get("contributors", [])

    # Re-sort by verified_tasks desc, then combinations desc
    contributors.sort(
        key=lambda c: (c.get("verified_tasks", 0), c.get("combinations", 0)),
        reverse=True,
    )
    leaderboard["contributors"] = contributors

    total_tasks  = len(completed.get("tasks", []))
    # Always recompute as authoritative sum – this self-heals any drift
    # between individual verify runs and the running total.
    total_combos = sum(c.get("combinations", 0) for c in contributors)

    stats["total_combinations"]  = total_combos
    stats["total_verified_tasks"] = total_tasks
    stats["active_contexts"]     = len(blocks.get("frontiers", {}))
    stats["updated"]             = now_iso()

    leaderboard["total_combinations"]  = total_combos
    leaderboard["total_verified_tasks"] = total_tasks
    leaderboard["updated"]             = stats["updated"]

    with open(leaderboard_path, "w", encoding="utf-8") as f:
        json.dump(leaderboard, f, indent=2)
    with open(stats_path, "w", encoding="utf-8") as f:
        json.dump(stats, f, indent=2)

    print(f"Aggregation complete: {total_tasks} verified tasks, "
          f"{total_combos:,} total combinations, {len(contributors)} contributors.")


if __name__ == "__main__":
    main()
