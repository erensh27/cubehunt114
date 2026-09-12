#!/usr/bin/env python3
"""Sync lightweight web deployment branch (web-deploy) for Vercel.

Packages only web application files and summary JSON files into an isolated,
lightweight Git tree under 500 KB, bypassing all raw ledger data (data/completed)
to eliminate Vercel disk space build errors.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

DEPLOY_FILES = [
    ".vercelignore",
    "app.mjs",
    "data/blocks.json",
    "data/leaderboard.json",
    "data/solutions.json",
    "data/stats.json",
    "engine.mjs",
    "index.html",
    "package.json",
    "search-session.mjs",
    "search-worker.mjs",
    "styles.css",
    "vercel.json",
    "web/app.mjs",
    "web/engine.mjs",
    "web/index.html",
    "web/search-session.mjs",
    "web/search-worker.mjs",
    "web/styles.css",
]


def sync_deploy_branch(branch_name: str = "web-deploy", push: bool = True) -> str:
    """Create a commit on branch_name containing only deployment files and push it."""
    tmp_index = Path(tempfile.gettempdir()) / f"git-deploy-index-{os.getpid()}"
    if tmp_index.exists():
        tmp_index.unlink()

    try:
        env = os.environ.copy()
        env["GIT_INDEX_FILE"] = str(tmp_index)

        existing_files = [f for f in DEPLOY_FILES if (ROOT / f).exists()]
        subprocess.run(["git", "-C", str(ROOT), "add"] + existing_files, env=env, check=True)

        tree_res = subprocess.run(
            ["git", "-C", str(ROOT), "write-tree"],
            env=env,
            capture_output=True,
            text=True,
            check=True,
        )
        tree_sha = tree_res.stdout.strip()

        parent_args: list[str] = []
        rev_local = subprocess.run(
            ["git", "-C", str(ROOT), "rev-parse", "--verify", f"refs/heads/{branch_name}"],
            capture_output=True,
            text=True,
        )
        if rev_local.returncode == 0 and rev_local.stdout.strip():
            parent_args = ["-p", rev_local.stdout.strip()]
        else:
            rev_remote = subprocess.run(
                ["git", "-C", str(ROOT), "rev-parse", "--verify", f"origin/{branch_name}"],
                capture_output=True,
                text=True,
            )
            if rev_remote.returncode == 0 and rev_remote.stdout.strip():
                parent_args = ["-p", rev_remote.stdout.strip()]

        commit_msg = "deploy: sync CubeHunt114 web application"
        commit_cmd = ["git", "-C", str(ROOT), "commit-tree", tree_sha] + parent_args + ["-m", commit_msg]
        commit_res = subprocess.run(commit_cmd, env=env, capture_output=True, text=True, check=True)
        commit_sha = commit_res.stdout.strip()

        subprocess.run(
            ["git", "-C", str(ROOT), "update-ref", f"refs/heads/{branch_name}", commit_sha],
            check=True,
        )

        if push:
            subprocess.run(
                ["git", "-C", str(ROOT), "push", "origin", f"{branch_name}:{branch_name}"],
                check=True,
            )

        return commit_sha
    finally:
        if tmp_index.exists():
            tmp_index.unlink()


if __name__ == "__main__":
    should_push = True
    if len(sys.argv) > 1 and sys.argv[1] == "no-push":
        should_push = False
    sha = sync_deploy_branch(push=should_push)
    print(f"Deployment branch synced successfully: {sha}")
