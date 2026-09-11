# Project 114 — Distributed Search for x³ + y³ + z³ = 114

A collaborative, decentralized computational project to search for integer solutions to:

$$x^3 + y^3 + z^3 = 114, \qquad x, y, z \in \mathbb{Z}$$

114 is one of the smallest unresolved integers under 1,000 in the Diophantine sum-of-three-cubes problem. Because $114 \equiv 6 \pmod 9$, integer solutions are conjectured to exist by Heath-Brown's conjecture, but none has ever been found.

This repository implements a **zero-backend, serverless volunteer computing architecture**:
- **Browser-Based Compute**: Contributors run the sieve directly in their browsers using Web Workers and `BigInt` arithmetic.
- **Hosted on Vercel**: 100% static frontend with zero backend server maintenance or hosting costs.
- **Verification on GitHub Actions**: Contributors submit mined blocks via GitHub Issues. GitHub Actions automatically re-evaluates the mathematical tasks, checks deterministic SHA-256 digests, credits contributors, and commits verified updates back to the repository.
- **Daily Automated Aggregations**: Leaderboards and global combination counts are automatically aggregated and synchronized every 24 hours via scheduled GitHub workflows.

---

## The Mathematical Engine

A naive brute-force cube scan requires $O(N^3)$ operations and is mathematically futile for the expected coordinate magnitudes ($|x|, |y|, |z| > 10^{15}$).

This project utilizes the **Booker–Sutherland cubic-field norm sieve**:
1. **Cubic-Field Norm**:
   Setting $\alpha^3 = 114$ and $\gamma = a + b\alpha + c\alpha^2$ in $K = \mathbb{Q}(\sqrt[3]{114})$:
   $$N(\gamma) = a^3 + 114b^3 + 12996c^3 - 342abc$$
2. **Adjoint Modular Roots**:
   Using adjoint coefficients $B = 114c^2 - ab$ and $C = b^2 - ac$, whenever $\gcd(C, D) = 1$, the value:
   $$r \equiv B \cdot C^{-1} \pmod D$$
   yields an exact modular cube root of 114 modulo $D$ ($r^3 \equiv 114 \pmod D$) without factoring large integers.
3. **Cascading Sieve Pipeline**:
   - **Shell Bounds**: Analytical bounds on $N(a)$ prune off-shell generators via derivative monotonicity.
   - **Signed Constraints Modulo 8 and 361**: Eliminate impossible residue combinations.
   - **Modulo 243 Filter**: Eliminates $>95\%$ of all candidate quotient points $q$ instantly.
   - **Parity Check**: Enforces $114 - S - z \equiv 0 \pmod 2$.
   - **Quadratic Residue Prime Sieve**: Evaluates 15 small primes $\{5, 7, 11, 13, 17, 19, 23, 31, 37, 41, 43, 47, 53, 59, 61\}$.
   - **Exact Integer Square Root**: Checks whether $V^2 = \frac{4(114 - z^3) - S^3}{3S}$ is a non-negative perfect square. If true:
     $$x = \frac{S + V}{2}, \quad y = \frac{S - V}{2}$$
   - **Canonical Ordering**: Verifies $|z| \le \min(|x|, |y|)$.
   - **Identity Confirmation**: Confirms $(x)^3 + (y)^3 + (z)^3 == 114$.

---

## How to Contribute

### 1. In Your Browser (Easiest)
Visit the deployed web application on Vercel:
1. Enter your contributor name and GitHub username.
2. Select compute intensity (100% is recommended if your machine can handle it).
3. Click **Start Mining**. The Web Worker runs entirely in the background — you can keep using other tabs.
4. When you've mined some blocks, click **Bank Work ↗** to open a pre-filled GitHub Issue. Copy the report and paste it into the issue body. GitHub Actions will automatically verify and credit you.

> **Your progress is saved in your browser.** If you close the tab and come back, your mined blocks and already-completed task list are restored from `localStorage` — you won't re-mine work you've already done.

### 2. Local Python Runner (High Throughput)
For maximum throughput on a dedicated machine or server:
```bash
git clone https://github.com/erensh27/sum-of-three-cubes-114.git
cd sum-of-three-cubes-114

# Run a 32-task batch (auto-picks the least-explored context):
python3 tools/runner.py --name "YourName" --github "yourhandle" --tasks 32
```
The runner automatically fetches the live verified-task ledger from GitHub so it never duplicates work already claimed by another contributor.

### Running With Friends Simultaneously

Each person should **pin a different context** using `--context` to guarantee zero overlap:

| Friend | Command |
|--------|---------|
| You    | `python3 tools/runner.py --name "Alice" --github "alice" --context c00 --tasks 64` |
| Friend 1 | `python3 tools/runner.py --name "Bob" --github "bob" --context c09 --tasks 64` |
| Friend 2 | `python3 tools/runner.py --name "Carol" --github "carol" --context c18 --tasks 64` |
| Friend 3 | `python3 tools/runner.py --name "Dave" --github "dave" --context c27 --tasks 64` |

There are **81 contexts** (`c00`–`c80`) so you can have up to 81 people working with guaranteed no overlap. If you don't pin a context, the runner applies a random session salt to stagger your starting row automatically.

After each batch, submit a GitHub Issue titled `[REPORT] <context> (<N> tasks)` with the contents of the generated `report_*.json` file. GitHub Actions will replay your tasks, verify the SHA-256 digests, credit you on the leaderboard, and commit the verified blocks to the shared ledger.

---

## Zero-Duplicate Progress Architecture

To ensure no two contributors mine the same search space:
- **Prior Knowledge Ingestion**: On load, every web and CLI client downloads `data/completed.json` and `data/blocks.json`. All already verified tasks are loaded into memory and permanently skipped.
- **81 Parallel Channels**: The search space is partitioned across 81 distinct cubic contexts (`c00` to `c80`). Clients are automatically assigned to channels with the lowest explored frontier.
- **Session Salting**: If multiple contributors access the same context concurrently, a session salt staggers their starting lattice rows, preventing race collisions.
- **Atomic Replay & Deduplication**: GitHub Actions checks every incoming task against the verified ledger. If a task was already claimed by another contributor, it is flagged as duplicate and safely skipped.

---

## GitHub Actions Automated Ingestion

1. **On Issue Opened (`[REPORT]`)**:
   - Triggers `.github/workflows/process-report.yml`.
   - Parses the report block and replays the task from scratch using canonical Python `search_core.py`.
   - Verifies the SHA-256 digest and checks for duplicates.
   - If valid, commits the verified tasks to `data/completed.json`, credits the contributor, and closes the issue with a verification checkmark.
   - If an exact solution is discovered, an official solution record is created in `data/solutions.json` and a milestone issue is published.
2. **Every 24 Hours (`daily-aggregate.yml`)**:
   - Triggers `.github/workflows/daily-aggregate.yml` via cron (`0 0 * * *`).
   - Recalculates leaderboard rankings, aggregates total worldwide combinations, and updates `data/leaderboard.json` and `data/stats.json`.

---

## Vercel Deployment

1. Import this repository into **Vercel**.
2. Set the framework preset to **Other** (pure static).
3. The included `vercel.json` automatically manages clean URL routing and static caching headers.
4. Deployment completes instantly with zero backend configurations.

---

## Verification & Tests

Run the test suite locally:
```bash
python3 -m unittest discover -s tests -p test_search.py
```
This verifies:
- Mathematical accuracy against known historical solutions ($k = 30, 39, 69, 75, 84$).
- Exact arithmetic and triple verification.
- Deterministic SHA-256 digest parity and conservation laws.

---

## License

Original software is released under the **GPL-2.0-or-later** license.
Mathematical foundations credited to Andrew Booker, Andrew Sutherland, and researchers in Diophantine number theory.
