#!/usr/bin/env python3
"""Daily aggregation and leaderboard updater for 114 project.

Executed by GitHub Actions schedule (every 24 hours) or workflow_dispatch.
Ensures consistency across data files and recalculates rankings.
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import ledger


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def main():
    leaderboard_path = ROOT / "data/leaderboard.json"
    stats_path       = ROOT / "data/stats.json"
    blocks_path      = ROOT / "data/blocks.json"

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

    counts_by_ctx = ledger.verified_counts_by_context()
    total_tasks = sum(counts_by_ctx.values())
    # Always recompute as authoritative sum – this self-heals any drift
    # between individual verify runs and the running total.
    total_combos = sum(c.get("combinations", 0) for c in contributors)

    import search_core as core
    all_contexts = sorted(list(core.CONTEXT_BY_ID.keys()))
    total_blocks_by_ctx = {}
    total_combos_by_ctx = {}
    for cid in all_contexts:
        cnt = counts_by_ctx.get(cid, 0)
        total_blocks_by_ctx[cid] = cnt
        c_info = core.CONTEXT_BY_ID[cid]
        band = c_info.get("band", 0)
        total_combos_by_ctx[cid] = cnt * 2048 if band == 0 else cnt * 43256

    blocks["total_blocks"] = total_blocks_by_ctx
    blocks["total_combinations"] = total_combos_by_ctx
    blocks["updated"] = now_iso()

    stats["total_combinations"]  = total_combos
    stats["total_verified_tasks"] = total_tasks
    stats["active_contexts"]     = len(blocks.get("frontiers", {}))
    stats["updated"]             = blocks["updated"]

    leaderboard["total_combinations"]  = total_combos
    leaderboard["total_verified_tasks"] = total_tasks
    leaderboard["updated"]             = blocks["updated"]

    with open(blocks_path, "w", encoding="utf-8") as f:
        json.dump(blocks, f, indent=2)
        f.write("\n")
    with open(leaderboard_path, "w", encoding="utf-8") as f:
        json.dump(leaderboard, f, indent=2)
        f.write("\n")
    with open(stats_path, "w", encoding="utf-8") as f:
        json.dump(stats, f, indent=2)
        f.write("\n")

    print(f"Aggregation complete: {total_tasks} verified tasks, "
          f"{total_combos:,} total combinations, {len(contributors)} contributors across {len(all_contexts)} contexts.")


if __name__ == "__main__":
    main()
