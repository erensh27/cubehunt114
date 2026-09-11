#!/usr/bin/env python3
"""Local multi-threaded Python runner for 114 distributed search.

Provides volunteer contributors with high-throughput native search capabilities.
Produces verified reports directly compatible with GitHub Actions ingestion.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import search_core as core


def fetch_remote_or_local_json(path_rel: str, repo_raw: str | None = None):
    local_p = ROOT / path_rel
    if local_p.exists():
        try:
            return json.loads(local_p.read_text(encoding="utf-8"))
        except Exception:
            pass

    if repo_raw:
        url = f"{repo_raw.rstrip('/')}/{path_rel}"
        try:
            with urlopen(url, timeout=10) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            print(f"Warning: Failed to fetch {url}: {e}", file=sys.stderr)

    return None


def main():
    parser = argparse.ArgumentParser(description="Volunteer runner for x^3 + y^3 + z^3 = 114")
    parser.add_argument("--name", type=str, default="Anonymous", help="Your contributor alias")
    parser.add_argument("--github", type=str, default="", help="Your GitHub username")
    parser.add_argument("--context", type=str, default=None, help="Target context (e.g. c00 to c80)")
    parser.add_argument("--tasks", type=int, default=4, help="Number of tasks to complete in this batch")
    parser.add_argument("--repo-raw", type=str, default=None, help="Base URL for raw repository data")
    args = parser.parse_args()

    blocks = fetch_remote_or_local_json("data/blocks.json", args.repo_raw) or {"frontiers": {}}
    completed = fetch_remote_or_local_json("data/completed.json", args.repo_raw) or {"tasks": []}
    verified_set = set(completed.get("tasks", []))

    # Pick context
    ctx = args.context
    if not ctx or ctx not in core.CONTEXT_BY_ID:
        # Pick context with lowest explored frontier
        frontiers = blocks.get("frontiers", {})
        ctx = min(core.CONTEXT_BY_ID.keys(), key=lambda c: frontiers.get(c, 0))

    start_row = blocks.get("frontiers", {}).get(ctx, 0)
    print(f"Starting runner on context [{ctx}] at row {start_row}...")
    print(f"Contributor: {args.name} (@{args.github or 'anonymous'})")

    finished_reports = []
    current_row = start_row
    tasks_done = 0

    while tasks_done < args.tasks:
        task = core.make_task(ctx, str(current_row), 0)
        tid = core.task_id(task)

        if tid in verified_set:
            current_row += core.ROWS_PER_TASK
            continue

        print(f"[{tasks_done + 1}/{args.tasks}] Running task {tid}...", end="", flush=True)
        t0 = time.perf_counter()
        result = core.run_task(task)
        elapsed = time.perf_counter() - t0

        combos = result["counters"]["generators"] + result["counters"]["quotient_points"]
        print(f" done ({elapsed:.2f}s, {combos:,} combos, digest: {result['digest'][:12]}...)")

        finished_reports.append({
            "task": task,
            "digest": result["digest"],
            "combinations": combos,
            "best_delta": None,
            "solution": None
        })

        if result.get("hits"):
            for hit in result["hits"]:
                print(f"\n🎉 SOLUTION CANDIDATE FOUND: {hit['xyz']}\n")
                finished_reports[-1]["solution"] = str(hit["xyz"])

        current_row += core.ROWS_PER_TASK
        tasks_done += 1

    # Format report
    report_envelope = {
        "schema": "114-report-v1",
        "contributor": {"name": args.name, "github": args.github},
        "tasks": finished_reports
    }

    out_file = Path.cwd() / f"report_{ctx}_{int(time.time())}.json"
    out_file.write_text(json.dumps(report_envelope, indent=2), encoding="utf-8")

    print("\nBatch Complete!")
    print(f"Report saved to: {out_file.name}")
    print("\nSubmit this result by creating an issue on GitHub titled:")
    print(f"  [REPORT] Batch {ctx} ({len(finished_reports)} tasks)")
    print("\nWith body containing the contents of the report file.")


if __name__ == "__main__":
    main()
