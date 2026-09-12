# Contributing to CubeHunt114

Thank you for your interest in contributing compute power to CubeHunt114. This project relies entirely on distributed, volunteer computing to search for integer solutions to $x^3 + y^3 + z^3 = 114$.

Whether you have a web browser or a dedicated multi-core server, you can directly contribute verified search work to the collective effort.

## Methods to Participate

You can contribute in two ways:

1. In your browser (recommended for everyday devices, laptops, and casual mining).
2. Using the local Python engine (recommended for high throughput, servers, and continuous mining).

## 1. Browser Mining

The simplest way to contribute is directly through the web client.

1. Open the project web page.
2. Enter your Contributor Alias and your GitHub username for public attribution.
3. Select your desired compute intensity:
   - Maximum throughput (100 percent): Uses all available worker threads.
   - Balanced background (50 percent): Throttles execution slightly so you can work normally.
   - Power save (25 percent): Gentle background mode suitable for laptops on battery.
4. Click Start Mining. The mathematical search runs locally in your browser using Web Workers and native BigInt arithmetic. It does not send unverified work over the network.
5. Your progress is saved automatically in your browser localStorage. If you close the tab or reload, your mined blocks and completed task registry are restored so you never repeat work.
6. When you wish to deposit your completed blocks, click Bank Work. This prepares a verified batch report and provides a direct link to open a GitHub Issue with your results.

## 2. Local Python Runner

For users with dedicated workstations, multi-core machines, or servers, the Python runner provides much higher block throughput.

Clone the repository:

```bash
git clone https://github.com/erensh27/sum-of-three-cubes-114.git
cd sum-of-three-cubes-114
```

To run a single batch of 32 tasks using the standard runner:

```bash
python3 tools/runner.py -n "YourName" -g "yourhandle" -t 32
```

The runner automatically inspects the public coordination file to select the least explored context and applies a session salt to avoid collisions.

### Running on Multiple Machines Simultaneously

If you are running across multiple computers, you can pin each machine to a separate context between c00 and c80 using the context flag:

- Machine 1: python3 tools/runner.py -n "YourName" -g "yourhandle" -c c00 -t 64
- Machine 2: python3 tools/runner.py -n "YourName" -g "yourhandle" -c c09 -t 64
- Machine 3: python3 tools/runner.py -n "YourName" -g "yourhandle" -c c18 -t 64
- Machine 4: python3 tools/runner.py -n "YourName" -g "yourhandle" -c c27 -t 64

Because the search space is divided into 81 distinct algebraic contexts, up to 81 nodes can run concurrently with mathematically zero overlap.

## How Verification and Attribution Work

1. Reporting Mined Blocks:
   Every batch generates a compact verification report containing your name, GitHub handle, context identifier, start row, count of blocks, and the deterministic SHA-256 digest of the ending task.

2. GitHub Actions Automated Replay:
   When an issue titled with `[REPORT]` is submitted, GitHub Actions automatically executes the verification workflow. It replays the reported tasks independently from scratch using the canonical search core to verify the SHA-256 digest.

3. Ledger Sharding and Credit:
   Upon successful verification, the action commits the verified task identifiers directly into the appropriate context shard under data/completed, advances the context frontier in data/blocks.json, and credits your account on the public leaderboard.

4. If a Solution is Discovered:
   If an exact integer triple $(x, y, z)$ satisfying $x^3 + y^3 + z^3 = 114$ is encountered during task execution, the verifier records an official milestone entry in data/solutions.json, credits your name in the discovery log, and publishes an announcement.

## Local Test Suite

Before modifying any algorithm code or submitting pull requests, run the test suite to ensure mathematical consistency:

```bash
python3 -m unittest discover -s tests -p test_search.py
```

The tests verify:
- Exact canonical context initialization across all 81 channels.
- Historical solution vectors for k = 30, 39, 69, 75, and 84.
- Exact arithmetic validation on cube sum identities.
- Deterministic SHA-256 digest reproducibility and generator conservation laws.
