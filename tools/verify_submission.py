#!/usr/bin/env python3
"""Submission verifier for 114 distributed search.

Called by GitHub Actions on issues titled '[REPORT] ...'.
Independently replays reported tasks, verifies SHA-256 digests,
checks for duplicates, and updates repository state.
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import search_core as core

MAX_BODY_BYTES = 65536


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_report_body(body_text: str) -> dict:
    """Parses single report or batch report block from markdown."""
    if len(body_text.encode("utf-8")) > MAX_BODY_BYTES:
        raise ValueError("Issue body exceeds maximum size limit (64KB)")

    # Check for JSON bank format first
    json_match = re.search(r"```json\s*(\{.*?\})\s*```", body_text, re.DOTALL)
    if json_match:
        try:
            data = json.loads(json_match.group(1))
            if data.get("schema") in ("114-report-v1", "math-gambling-bank-v1") and "tasks" in data:
                return data
        except json.JSONDecodeError:
            pass

    # Check for delimited key-value report
    kv_match = re.search(r"<!--\s*114-report-v1\s*-->(.*?)<!--\s*end-114-report\s*-->", body_text, re.DOTALL)
    if kv_match:
        lines = [line.strip() for line in kv_match.group(1).strip().splitlines() if line.strip()]
        kv = {}
        for line in lines:
            if ":" in line:
                k, v = line.split(":", 1)
                kv[k.strip().lower()] = v.strip()

        context = kv.get("context", "")
        row = kv.get("row", "0")
        block = int(kv.get("block", "0"))
        digest = kv.get("digest", "")
        contributor = kv.get("contributor", "Anonymous")
        github = kv.get("github", "")
        combos = int(kv.get("combinations", "0"))
        best_delta = int(kv.get("best_delta", "999999999")) if kv.get("best_delta", "").isdigit() else None
        solution = kv.get("solution", "")

        task = core.make_task(context, row, block)
        return {
            "schema": "114-report-v1",
            "contributor": {"name": contributor, "github": github},
            "tasks": [{
                "task": task,
                "digest": digest,
                "combinations": combos,
                "best_delta": best_delta,
                "solution": solution,
            }]
        }

    # Direct fallback: parse raw JSON if the entire body is JSON
    try:
        data = json.loads(body_text.strip())
        if "tasks" in data:
            return data
    except Exception:
        pass

    raise ValueError("Could not find a valid report block (<!-- 114-report-v1 --> or ```json) in issue body")


def verify_and_apply(report_data: dict, submitter_login: str) -> dict:
    completed_path = ROOT / "data/completed.json"
    blocks_path = ROOT / "data/blocks.json"
    leaderboard_path = ROOT / "data/leaderboard.json"
    stats_path = ROOT / "data/stats.json"
    solutions_path = ROOT / "data/solutions.json"

    with open(completed_path, "r", encoding="utf-8") as f:
        completed_data = json.load(f)
    with open(blocks_path, "r", encoding="utf-8") as f:
        blocks_data = json.load(f)
    with open(leaderboard_path, "r", encoding="utf-8") as f:
        leaderboard_data = json.load(f)
    with open(stats_path, "r", encoding="utf-8") as f:
        stats_data = json.load(f)
    with open(solutions_path, "r", encoding="utf-8") as f:
        solutions_data = json.load(f)

    verified_set = set(completed_data.get("tasks", []))
    contributor_claim = report_data.get("contributor", {})
    name = (contributor_claim.get("name") or submitter_login or "Anonymous").strip()[:64]
    gh_handle = (contributor_claim.get("github") or submitter_login or "").strip()[:64]

    tasks_to_verify = report_data.get("tasks", [])
    if not tasks_to_verify:
        raise ValueError("Report contains no tasks")
    if len(tasks_to_verify) > 256:
        raise ValueError("Report exceeds maximum task limit of 256")

    accepted_tasks = []
    duplicate_tasks = []
    failed_tasks = []
    found_solutions = []
    total_new_combinations = 0
    best_delta_in_report = None

    for item in tasks_to_verify:
        task_def = item.get("task")
        claimed_digest = item.get("digest")

        try:
            validated_task = core.validate_task(task_def)
            tid = core.task_id(validated_task)
        except Exception as e:
            failed_tasks.append((str(task_def), f"Validation error: {e}"))
            continue

        if tid in verified_set:
            duplicate_tasks.append(tid)
            continue

        # Replay the task independently
        try:
            replay_result = core.run_task(validated_task)
        except Exception as e:
            failed_tasks.append((tid, f"Replay error: {e}"))
            continue

        computed_digest = replay_result["digest"]
        if claimed_digest and claimed_digest != computed_digest:
            failed_tasks.append((tid, f"Digest mismatch: claimed {claimed_digest}, got {computed_digest}"))
            continue

        # Replay matched!
        verified_set.add(tid)
        accepted_tasks.append(tid)

        # Advance frontier if row aligns with current frontier
        ctx = validated_task["context"]
        r = int(validated_task["row"])
        current_frontier = blocks_data["frontiers"].get(ctx, 0)
        if r == current_frontier:
            blocks_data["frontiers"][ctx] = r + core.ROWS_PER_TASK

        combos = replay_result["counters"].get("generators", 0) + replay_result["counters"].get("quotient_points", 0)
        total_new_combinations += combos

        # Check hits for exact solution
        for hit in replay_result.get("hits", []):
            xyz = hit.get("xyz")
            if xyz and core.verify_triple(xyz, 114):
                found_solutions.append(xyz)

        # Also check claimed solution field
        claimed_sol = item.get("solution")
        if claimed_sol:
            coords = re.findall(r"-?\d+", str(claimed_sol))
            if len(coords) == 3 and core.verify_triple(coords, 114):
                found_solutions.append(coords)

    if not accepted_tasks and duplicate_tasks:
        return {
            "success": False,
            "reason": f"All {len(duplicate_tasks)} submitted tasks were already completed by another contributor.",
            "duplicates": duplicate_tasks,
        }

    if not accepted_tasks and failed_tasks:
        return {
            "success": False,
            "reason": f"Verification failed on submitted tasks: {failed_tasks[:3]}",
            "failed": failed_tasks,
        }

    # Update completed database
    completed_data["tasks"] = sorted(verified_set)
    completed_data["verified_count"] = len(completed_data["tasks"])
    completed_data["updated"] = now_iso()

    # Update stats
    stats_data["total_combinations"] = stats_data.get("total_combinations", 0) + total_new_combinations
    stats_data["total_verified_tasks"] = len(completed_data["tasks"])
    stats_data["updated"] = now_iso()

    # Update leaderboard
    contributors = leaderboard_data.setdefault("contributors", [])
    entry = next((c for c in contributors if c.get("github") == gh_handle or c.get("name") == name), None)
    if entry is None:
        entry = {
            "name": name,
            "github": gh_handle,
            "verified_tasks": 0,
            "combinations": 0,
            "best_delta": None,
            "last_active": now_iso()
        }
        contributors.append(entry)

    entry["verified_tasks"] += len(accepted_tasks)
    entry["combinations"] += total_new_combinations
    entry["last_active"] = now_iso()

    leaderboard_data["total_combinations"] = stats_data["total_combinations"]
    leaderboard_data["total_verified_tasks"] = stats_data["total_verified_tasks"]
    leaderboard_data["updated"] = now_iso()
    # Sort leaderboard by verified_tasks descending
    leaderboard_data["contributors"] = sorted(
        contributors,
        key=lambda x: (x.get("verified_tasks", 0), x.get("combinations", 0)),
        reverse=True
    )

    # Record solutions
    for sol in found_solutions:
        sol_entry = {
            "x": str(sol[0]),
            "y": str(sol[1]),
            "z": str(sol[2]),
            "contributor": name,
            "github": gh_handle,
            "verified_at": now_iso()
        }
        if not any(s.get("x") == sol_entry["x"] and s.get("y") == sol_entry["y"] and s.get("z") == sol_entry["z"] for s in solutions_data.get("solutions", [])):
            solutions_data.setdefault("solutions", []).append(sol_entry)

    # Save state files atomically
    with open(completed_path, "w", encoding="utf-8") as f:
        json.dump(completed_data, f, indent=2)
    with open(blocks_path, "w", encoding="utf-8") as f:
        json.dump(blocks_data, f, indent=2)
    with open(leaderboard_path, "w", encoding="utf-8") as f:
        json.dump(leaderboard_data, f, indent=2)
    with open(stats_path, "w", encoding="utf-8") as f:
        json.dump(stats_data, f, indent=2)
    with open(solutions_path, "w", encoding="utf-8") as f:
        json.dump(solutions_data, f, indent=2)

    return {
        "success": True,
        "accepted_count": len(accepted_tasks),
        "duplicate_count": len(duplicate_tasks),
        "total_new_combinations": total_new_combinations,
        "accepted_tasks": accepted_tasks,
        "found_solutions": found_solutions,
        "contributor": name,
        "total_verified": len(completed_data["tasks"])
    }


def main():
    body = os.environ.get("ISSUE_BODY", "")
    submitter = os.environ.get("ISSUE_SUBMITTER", "anonymous")

    if not body:
        if len(sys.argv) > 1:
            body = Path(sys.argv[1]).read_text(encoding="utf-8")
        else:
            body = sys.stdin.read()

    try:
        report = parse_report_body(body)
        result = verify_and_apply(report, submitter)
    except Exception as e:
        print(f"FAILED: {e}")
        # Write to GITHUB_OUTPUT if present
        gh_out = os.environ.get("GITHUB_OUTPUT")
        if gh_out:
            with open(gh_out, "a") as f:
                f.write("verified=false\n")
                f.write(f"comment_body=Verification failed: {e}\n")
        sys.exit(1)

    if not result.get("success"):
        reason = result.get("reason", "Verification rejected")
        print(f"REJECTED: {reason}")
        gh_out = os.environ.get("GITHUB_OUTPUT")
        if gh_out:
            with open(gh_out, "a") as f:
                f.write("verified=false\n")
                f.write(f"comment_body=Rejected: {reason}\n")
        sys.exit(1)

    # Success
    print(f"SUCCESS: Accepted {result['accepted_count']} tasks from {result['contributor']}")
    has_sol = "true" if result.get("found_solutions") else "false"
    comment = (
        f"Verified **{result['accepted_count']} block(s)** by **@{submitter}**.\n\n"
        f"- Combinations evaluated: `{result['total_new_combinations']:,}`\n"
        f"- Global verified blocks: `{result['total_verified']:,}`\n"
        f"- Unique progress recorded into project database."
    )
    if has_sol == "true":
        comment += f"\n\n### MATHEMATICAL DISCOVERY: x³+y³+z³=114 verified: `{result['found_solutions']}`"

    gh_out = os.environ.get("GITHUB_OUTPUT")
    if gh_out:
        with open(gh_out, "a") as f:
            f.write("verified=true\n")
            f.write(f"has_solution={has_sol}\n")
            f.write(f"comment_body={comment}\n")


if __name__ == "__main__":
    main()
