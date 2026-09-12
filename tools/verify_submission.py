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
import ledger

MAX_BODY_BYTES = 65536
# A compact range line fits millions of task claims inside a GitHub issue, but
# every task is independently replayed.  This ceiling is intentionally high;
# the Actions six-hour job limit is the practical upper bound.
MAX_TASKS_LIMIT = 5_000_000


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_report_body(body_text: str) -> dict:
    """Parses single report, range report, or batch report from markdown."""
    if len(body_text.encode("utf-8")) > MAX_BODY_BYTES:
        raise ValueError("Issue body exceeds maximum size limit (64KB)")

    # 1. Check for 114v2 compact format (ranges)
    v2_match = re.search(r"<!--\s*114v2\s*-->(.*?)<!--\s*(?:end-114v2|/114v2)\s*-->", body_text, re.DOTALL | re.IGNORECASE)
    if v2_match:
        content = v2_match.group(1)
        contributor = "Anonymous"
        github = ""
        solution = None
        ranges = []
        claimed_combos = 0

        for line in content.strip().splitlines():
            line = line.strip()
            if not line:
                continue
            lower = line.lower()
            if lower.startswith(("contributor:", "a=", "name:")):
                contributor = line.split(":", 1)[-1].split("=", 1)[-1].strip()
            elif lower.startswith(("github:", "g=", "user:")):
                github = line.split(":", 1)[-1].split("=", 1)[-1].strip().lstrip("@")
            elif lower.startswith(("solution:", "sol:", "hit:")):
                solution = line.split(":", 1)[-1].strip()
            elif lower.startswith(("combinations:", "combos:")):
                try:
                    claimed_combos = int(line.split(":", 1)[-1].strip().replace(",", ""))
                except Exception:
                    pass
            else:
                m = re.match(r"^(c\d{2}):(\d+):(\d+)(?::(\d+))?(?::([0-9a-fA-F]{64}))?", line)
                if m:
                    ctx, row_s, blk_s, count_s, digest = m.groups()
                    if ctx not in core.CONTEXT_BY_ID:
                        continue
                    c = core.CONTEXT_BY_ID[ctx]
                    row = int(row_s)
                    blk = int(blk_s)
                    count = int(count_s or 1)
                    if count > MAX_TASKS_LIMIT:
                        raise ValueError(f"Range exceeds maximum of {MAX_TASKS_LIMIT:,} tasks")
                    ranges.append((ctx, row, blk, count, digest, solution))

        if ranges:
            return {
                "schema": "114-report-v2",
                "contributor": {"name": contributor, "github": github},
                "ranges": ranges,
                "claimed_combinations": claimed_combos,
                "solution": solution,
            }

    # 2. Check for JSON bank format (including truncated JSON repair)
    json_match = re.search(r"```json\s*(\{.*)", body_text, re.DOTALL)
    if json_match:
        candidate = json_match.group(1)
        closing_match = re.search(r"```json\s*(\{.*?\})\s*```", body_text, re.DOTALL)
        if closing_match:
            candidate = closing_match.group(1)
        data = None
        try:
            data = json.loads(candidate)
        except json.JSONDecodeError:
            # Attempt truncated JSON repair by finding last complete task object
            pos = len(candidate)
            while pos > 0:
                last_brace = candidate.rfind("}", 0, pos)
                if last_brace == -1:
                    break
                attempt = candidate[:last_brace + 1] + "\n]}"
                try:
                    data = json.loads(attempt)
                    break
                except Exception:
                    pos = last_brace

        if data and data.get("schema") in ("114-report-v1", "114-report-v2", "math-gambling-bank-v1") and "tasks" in data:
            return data

    # 3. Check for delimited key-value report (legacy 114-report-v1)
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

    # 4. Direct fallback: parse raw JSON if the entire body is JSON
    try:
        data = json.loads(body_text.strip())
        if "tasks" in data:
            return data
    except Exception:
        pass

    raise ValueError("Could not find a valid report block (<!-- 114v2 -->, <!-- 114-report-v1 -->, or ```json) in issue body")


def iter_report_tasks(report_data: dict):
    """Yield compact v2 ranges lazily, avoiding a multi-million-item list."""
    if "tasks" in report_data:
        yield from report_data["tasks"]
        return
    for ctx, row, blk, count, digest, solution in report_data.get("ranges", []):
        c = core.CONTEXT_BY_ID[ctx]
        for i in range(count):
            yield {
                "task": core.make_task(ctx, str(row), blk),
                "digest": digest if i == count - 1 else None,
                "solution": solution if i == count - 1 else None,
            }
            blk += 1
            if blk >= c["blocks"]:
                blk = 0
                row = (row + core.ROWS_PER_TASK) % int(c["totalRows"])


def report_task_count(report_data: dict) -> int:
    if "tasks" in report_data:
        return len(report_data["tasks"])
    return sum(item[3] for item in report_data.get("ranges", []))


def verify_and_apply(report_data: dict, submitter_login: str) -> dict:
    blocks_path = ROOT / "data/blocks.json"
    leaderboard_path = ROOT / "data/leaderboard.json"
    stats_path = ROOT / "data/stats.json"
    solutions_path = ROOT / "data/solutions.json"

    with open(blocks_path, "r", encoding="utf-8") as f:
        blocks_data = json.load(f)
    with open(leaderboard_path, "r", encoding="utf-8") as f:
        leaderboard_data = json.load(f)
    with open(stats_path, "r", encoding="utf-8") as f:
        stats_data = json.load(f)
    with open(solutions_path, "r", encoding="utf-8") as f:
        solutions_data = json.load(f)

    # Load only the hash bucket that owns each validated task. A growing
    # context can never force an entire context ledger into memory.
    verified_by_bucket = {}
    contributor_claim = report_data.get("contributor", {})
    name = (contributor_claim.get("name") or submitter_login or "Anonymous").strip()[:64]
    gh_handle = (contributor_claim.get("github") or submitter_login or "").strip()[:64]

    task_count = report_task_count(report_data)
    if not task_count:
        raise ValueError("Report contains no tasks")
    if task_count > MAX_TASKS_LIMIT:
        raise ValueError(f"Report exceeds maximum task limit of {MAX_TASKS_LIMIT}")

    accepted_count = 0
    duplicate_tasks = []
    duplicate_count = 0
    failed_tasks = []
    failed_count = 0
    found_solutions = []
    total_new_combinations = 0
    best_delta_in_report = None

    for item in iter_report_tasks(report_data):
        task_def = item.get("task")
        claimed_digest = item.get("digest")

        try:
            validated_task = core.validate_task(task_def)
            tid = core.task_id(validated_task)
        except Exception as e:
            failed_count += 1
            if len(failed_tasks) < 100:
                failed_tasks.append((str(task_def), f"Validation error: {e}"))
            continue

        ctx = validated_task["context"]
        bucket = ledger.bucket_for(tid)
        context_verified = verified_by_bucket.setdefault(
            (ctx, bucket), ledger.load_bucket(ctx, bucket)
        )
        if tid in context_verified:
            duplicate_count += 1
            if len(duplicate_tasks) < 100:
                duplicate_tasks.append(tid)
            continue

        # Replay the task independently
        try:
            replay_result = core.run_task(validated_task)
        except Exception as e:
            failed_count += 1
            if len(failed_tasks) < 100:
                failed_tasks.append((tid, f"Replay error: {e}"))
            continue

        computed_digest = replay_result["digest"]
        if claimed_digest and claimed_digest != computed_digest:
            failed_count += 1
            if len(failed_tasks) < 100:
                failed_tasks.append((tid, f"Digest mismatch: claimed {claimed_digest}, got {computed_digest}"))
            continue

        # Replay matched!
        context_verified.add(tid)
        accepted_count += 1

        # Advance frontier if row aligns with current frontier
        r = int(validated_task["row"])
        current_frontier = blocks_data["frontiers"].get(ctx, 0)
        if r == current_frontier:
            blocks_data["frontiers"][ctx] = r + core.ROWS_PER_TASK
        blocks_data.setdefault("high_water_marks", {})[ctx] = max(
            blocks_data.get("high_water_marks", {}).get(ctx, 0), r + core.ROWS_PER_TASK
        )

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

    if not accepted_count and duplicate_count:
        return {
            "success": False,
            "reason": f"All {duplicate_count} submitted tasks were already completed by another contributor.",
            "duplicates": duplicate_tasks,
        }

    if not accepted_count and failed_count:
        return {
            "success": False,
            "reason": f"Verification failed on submitted tasks: {failed_tasks[:3]}",
            "failed": failed_tasks,
        }

    timestamp = now_iso()
    for (ctx, bucket), task_ids in verified_by_bucket.items():
        ledger.save_bucket(ctx, bucket, task_ids, timestamp)
    total_verified = ledger.total_verified_count()

    # Update stats
    stats_data["total_combinations"] = stats_data.get("total_combinations", 0) + total_new_combinations
    stats_data["total_verified_tasks"] = total_verified
    stats_data["updated"] = timestamp

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

    if name and name != "Anonymous":
        entry["name"] = name
    if gh_handle:
        entry["github"] = gh_handle
    entry["verified_tasks"] += accepted_count
    entry["combinations"] += total_new_combinations
    entry["last_active"] = now_iso()

    leaderboard_data["total_combinations"] = stats_data["total_combinations"]
    leaderboard_data["total_verified_tasks"] = total_verified
    leaderboard_data["updated"] = timestamp
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

    # Save public coordination and attribution state.  Task IDs are saved in
    # context shards above and are never downloaded by normal clients.
    # This is written in the same accepted-report transaction as the shard, so
    # every verified mining batch immediately publishes fresh scheduling data.
    blocks_data["updated"] = timestamp
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
        "accepted_count": accepted_count,
        "duplicate_count": duplicate_count,
        "total_new_combinations": total_new_combinations,
        "found_solutions": found_solutions,
        "contributor": name,
        "total_verified": total_verified
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
        comment += f"\n\n### MATHEMATICAL DISCOVERY: x\u00b3+y\u00b3+z\u00b3=114 verified: `{result['found_solutions']}`"

    gh_out = os.environ.get("GITHUB_OUTPUT")
    if gh_out:
        # GitHub Actions requires the heredoc format for multiline output values.
        # Plain `key=value\n` silently truncates at the first embedded newline.
        with open(gh_out, "a") as f:
            f.write("verified=true\n")
            f.write(f"has_solution={has_sol}\n")
            f.write("comment_body<<GHEOF\n")
            f.write(comment)
            f.write("\nGHEOF\n")


if __name__ == "__main__":
    main()
