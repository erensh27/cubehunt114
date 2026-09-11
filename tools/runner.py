#!/usr/bin/env python3
"""Local multi-threaded Python runner for 114 distributed search.

Provides volunteer contributors with high-throughput native search capabilities.
Produces verified reports directly compatible with GitHub Actions ingestion.

Usage:
    python3 tools/runner.py --name "YourName" --github "yourhandle" --tasks 32

The runner automatically downloads the latest completed-task ledger from GitHub
so you never duplicate work already verified by another contributor.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import search_core as core

# Default raw URL for the live repository data – allows any fresh clone to
# immediately know which tasks are already verified without needing a local
# up-to-date data/ directory.
DEFAULT_REPO_RAW = "https://raw.githubusercontent.com/erensh27/sum-of-three-cubes-114/main"


def fetch_remote_or_local_json(path_rel: str, repo_raw: str | None = None):
    """Try local file first, then fall back to remote raw URL."""
    local_p = ROOT / path_rel
    if local_p.exists():
        try:
            return json.loads(local_p.read_text(encoding="utf-8"))
        except Exception:
            pass

    if repo_raw:
        url = f"{repo_raw.rstrip('/')}/{path_rel}"
        try:
            with urlopen(url, timeout=15) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            print(f"Warning: Failed to fetch {url}: {e}", file=sys.stderr)

    return None


def pick_starting_point(verified_set: set, frontiers: dict, ctx_override: str | None):
    """
    Pick a context and starting row that minimises overlap with other concurrent
    contributors.

    Strategy:
    - If a context is forced via --context, use it.
    - Otherwise pick the context with the lowest explored frontier (most virgin
      territory).
    - Apply a random session salt so two friends who start at the same time
      land on different rows within the same context.
    """
    if ctx_override and ctx_override in core.CONTEXT_BY_ID:
        ctx_id = ctx_override
    else:
        # Prefer the context with the least verified progress
        ctx_id = min(
            core.CONTEXT_BY_ID.keys(),
            key=lambda c: frontiers.get(c, 0),
        )

    c = core.CONTEXT_BY_ID[ctx_id]
    base_row = frontiers.get(ctx_id, 0)

    # Salt: jump ahead by a random multiple of ROWS_PER_TASK so concurrent
    # runners in the same context land on different rows.
    salt_steps = random.randint(0, 63)
    start_row = base_row + salt_steps * core.ROWS_PER_TASK

    # Wrap around if we've gone past the end of the context
    total_rows = int(c["totalRows"])
    if start_row >= total_rows:
        start_row = 0

    # Skip over any rows already in the verified set
    attempts = 0
    while attempts < 1000:
        task = core.make_task(ctx_id, str(start_row), 0)
        if core.task_id(task) not in verified_set:
            break
        start_row += core.ROWS_PER_TASK
        if start_row >= total_rows:
            start_row = 0
        attempts += 1

    return ctx_id, start_row


def main():
    parser = argparse.ArgumentParser(
        description="Volunteer runner for x³ + y³ + z³ = 114",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Run 32 tasks (browser-equivalent session):
  python3 tools/runner.py --name "Alice" --github "alice" --tasks 32

  # Pin to a specific context (useful to split friends across channels):
  python3 tools/runner.py --name "Bob" --github "bob" --context c05 --tasks 64

  # High-throughput batch (mine 256 tasks then submit):
  python3 tools/runner.py --name "Carol" --github "carol" --tasks 256
""",
    )
    parser.add_argument("--name", type=str, default="Anonymous", help="Your contributor alias")
    parser.add_argument("--github", type=str, default="", help="Your GitHub username")
    parser.add_argument(
        "--context", type=str, default=None,
        help="Force a specific context (c00–c80). Default: auto-picks least explored.",
    )
    parser.add_argument(
        "--tasks", type=int, default=16,
        help="Number of tasks (row×block pairs) to complete in this batch. Default: 16.",
    )
    parser.add_argument(
        "--repo-raw", type=str, default=DEFAULT_REPO_RAW,
        help="Base URL for raw repository data (to fetch live completed ledger).",
    )
    args = parser.parse_args()

    print("Fetching live verified-task ledger from GitHub…", flush=True)
    blocks    = fetch_remote_or_local_json("data/blocks.json",    args.repo_raw) or {"frontiers": {}}
    completed = fetch_remote_or_local_json("data/completed.json", args.repo_raw) or {"tasks": []}
    verified_set = set(completed.get("tasks", []))
    frontiers    = blocks.get("frontiers", {})

    print(f"Ledger loaded: {len(verified_set)} tasks already verified globally.", flush=True)

    ctx_id, start_row = pick_starting_point(verified_set, frontiers, args.context)
    c = core.CONTEXT_BY_ID[ctx_id]

    print(f"\nContributor : {args.name} (@{args.github or 'anonymous'})")
    print(f"Context     : {ctx_id}  (frontier={frontiers.get(ctx_id, 0)}, blocks={c['blocks']})")
    print(f"Starting row: {start_row}")
    print(f"Batch size  : {args.tasks} tasks\n")

    finished_reports = []
    current_row  = start_row
    total_rows   = int(c["totalRows"])
    tasks_done   = 0
    total_combos = 0
    batch_start  = time.perf_counter()

    while tasks_done < args.tasks:
        if current_row >= total_rows:
            current_row = 0  # wrap around

        # Iterate all blocks for this row, not just block 0
        for block in range(c["blocks"]):
            if tasks_done >= args.tasks:
                break

            task = core.make_task(ctx_id, str(current_row), block)
            tid  = core.task_id(task)

            if tid in verified_set:
                continue  # skip already-verified task

            label = f"[{tasks_done + 1}/{args.tasks}] {ctx_id} row={current_row} blk={block}"
            print(f"{label}…", end="", flush=True)

            t0     = time.perf_counter()
            result = core.run_task(task)
            elapsed = time.perf_counter() - t0

            combos = (
                result["counters"]["generators"]
                + result["counters"]["quotient_points"]
            )
            total_combos += combos
            verified_set.add(tid)

            print(
                f" {elapsed:.2f}s  {combos:,} combos  digest={result['digest'][:16]}…",
                flush=True,
            )

            finished_reports.append({
                "task": task,
                "digest": result["digest"],
                "combinations": combos,
                "best_delta": None,
                "solution": None,
            })

            if result.get("hits"):
                for hit in result["hits"]:
                    xyz = hit["xyz"]
                    print(f"\n{'='*60}")
                    print(f"  🎉  SOLUTION FOUND: x={xyz[0]}, y={xyz[1]}, z={xyz[2]}")
                    print(f"{'='*60}\n")
                    finished_reports[-1]["solution"] = json.dumps(xyz)

            tasks_done += 1

        current_row += core.ROWS_PER_TASK

    # ── Format and save report ────────────────────────────────────────────────
    report_envelope = {
        "schema": "114-report-v1",
        "contributor": {"name": args.name, "github": args.github},
        "tasks": finished_reports,
    }

    out_file = Path.cwd() / f"report_{ctx_id}_{int(time.time())}.json"
    out_file.write_text(json.dumps(report_envelope, indent=2), encoding="utf-8")

    elapsed_total = time.perf_counter() - batch_start
    rate = total_combos / elapsed_total if elapsed_total > 0 else 0

    print(f"\n{'─'*60}")
    print(f"  Batch complete!")
    print(f"  Tasks completed : {len(finished_reports)}")
    print(f"  Combinations    : {total_combos:,}")
    print(f"  Wall time       : {elapsed_total:.1f}s  ({rate:,.0f} combos/s)")
    print(f"  Report saved    : {out_file.name}")
    print(f"{'─'*60}")
    print()
    print("To submit, open a GitHub Issue titled:")
    print(f"  [REPORT] {ctx_id} ({len(finished_reports)} tasks)")
    print()
    print("And paste the full contents of the report JSON into the issue body.")
    print(f"URL: https://github.com/erensh27/sum-of-three-cubes-114/issues/new")


if __name__ == "__main__":
    main()
