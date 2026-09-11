/* Session manager and task distributor for 114 distributed search.
 * Loads verified completed data to prevent duplicate computation and
 * assigns contiguous lattice blocks across the 81 cubic contexts.
 */

import { CONTEXTS, makeTask, taskId, ROWS_PER_TASK } from './engine.mjs';

export class SearchSession {
  // Max tasks per report batch (for verification safety in GitHub Actions)
  static MAX_TASKS_PER_REPORT = 25000;

  constructor(baseUrl = './') {
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    this.completedTasks = new Set();
    this.frontiers = {};
    this.activeContext = 'c00';
    this.currentRow = '0';
    this.currentBlock = 0;
    // Segments array: stores contiguous mined blocks efficiently in O(1) memory
    // [{ context, startRow, startBlock, lastRow, lastBlock, count, combinations, digest }]
    this.segments = [];
    this.totalMinedBlocks = 0;
    this.totalSessionCombinations = 0;
    this.bestSessionCandidate = null;
    this.sessionId = Math.random().toString(36).substring(2, 10);
  }

  // Compatibility getter/setter for code expecting sessionBank
  get sessionBank() {
    return this.segments;
  }

  set sessionBank(val) {
    if (Array.isArray(val)) {
      if (val.length > 0 && val[0].count !== undefined) {
        this.segments = val;
        this.totalMinedBlocks = val.reduce((s, seg) => s + (seg.count || 1), 0);
      } else if (val.length > 0 && val[0].task) {
        // Migrate legacy flat task array to a segment
        this.segments = [{
          context: val[0].task.context,
          startRow: String(val[0].task.row),
          startBlock: val[0].task.block,
          lastRow: String(val[val.length - 1].task.row),
          lastBlock: val[val.length - 1].task.block,
          count: val.length,
          combinations: this.totalSessionCombinations || (val.length * 2048),
          digest: val[val.length - 1].digest || '',
        }];
        this.totalMinedBlocks = val.length;
      } else {
        this.segments = [];
        this.totalMinedBlocks = 0;
      }
    } else {
      this.segments = [];
      this.totalMinedBlocks = 0;
    }
  }

  isRowCompleted(context, row) {
    try {
      const tid = taskId(makeTask(context, String(row), 0));
      return this.completedTasks.has(tid);
    } catch {
      return false;
    }
  }

  async loadInitialData() {
    const tryFetch = async filename => {
      const paths = [
        `./data/${filename}`,
        `/data/${filename}`,
        `../data/${filename}`,
        `data/${filename}`
      ];
      for (const p of paths) {
        try {
          const res = await fetch(p, { cache: 'no-cache' });
          if (res.ok) return await res.json();
        } catch {}
      }
      return null;
    };

    try {
      const [completedData, blocksData] = await Promise.all([
        tryFetch('completed.json'),
        tryFetch('blocks.json')
      ]);

      if (completedData && Array.isArray(completedData.tasks)) {
        this.completedTasks = new Set(completedData.tasks);
      }

      if (blocksData && blocksData.frontiers) {
        this.frontiers = blocksData.frontiers;
      }
    } catch (err) {
      console.warn('Notice: Could not load remote state files, falling back to local session state:', err);
    }

    // Select initial context: find context with lowest current frontier
    let bestCtx = 'c00';
    let minFrontier = Infinity;

    for (const ctx of CONTEXTS) {
      const f = this.frontiers[ctx.id] || 0;
      if (f < minFrontier) {
        minFrontier = f;
        bestCtx = ctx.id;
      }
    }

    this.activeContext = bestCtx;
    // Session salt to stagger concurrent workers in the same context
    const saltOffset = (parseInt(this.sessionId, 36) % 8) * ROWS_PER_TASK;
    let candidateRow = (this.frontiers[bestCtx] || 0) + saltOffset;

    let attempts = 0;
    while (this.isRowCompleted(bestCtx, candidateRow) && attempts++ < 500) {
      candidateRow += ROWS_PER_TASK;
    }

    const activeCtxObj = CONTEXTS.find(c => c.id === bestCtx) || CONTEXTS[0];
    if (BigInt(candidateRow) >= BigInt(activeCtxObj.totalRows)) {
      candidateRow = 0;
    }
    this.currentRow = String(candidateRow);
    this.currentBlock = 0;

    return {
      context: this.activeContext,
      startRow: this.currentRow,
      verifiedCount: this.completedTasks.size,
    };
  }

  getNextTask() {
    const c = CONTEXTS.find(x => x.id === this.activeContext) || CONTEXTS[0];
    const totalRows = BigInt(c.totalRows);
    const rowStride = BigInt(ROWS_PER_TASK);

    // Mine sequentially across blocks and rows in activeContext
    for (let attempts = 0; attempts < 1000; attempts++) {
      let r = BigInt(this.currentRow || 0);
      let b = this.currentBlock;

      const candidate = makeTask(c.id, r.toString(), b);
      const tid = taskId(candidate);

      // Advance block and row for subsequent task
      b++;
      if (b >= c.blocks) {
        b = 0;
        r += rowStride;
        if (r >= totalRows) {
          r = 0n;
        }
      }
      this.currentRow = r.toString();
      this.currentBlock = b;

      if (!this.completedTasks.has(tid)) {
        return candidate;
      }
    }

    // Advance to next context if this context is heavily covered
    const nextIdx = (CONTEXTS.findIndex(x => x.id === this.activeContext) + 1) % CONTEXTS.length;
    this.activeContext = CONTEXTS[nextIdx].id;
    this.currentRow = String(this.frontiers[this.activeContext] || 0);
    this.currentBlock = 0;
    return makeTask(this.activeContext, this.currentRow, 0);
  }

  _isNextTask(c, prevRow, prevBlock, nextRow, nextBlock) {
    const prevR = BigInt(prevRow);
    const nextR = BigInt(nextRow);
    if (prevBlock + 1 < c.blocks) {
      return prevBlock + 1 === nextBlock && prevR === nextR;
    } else {
      const totalRows = BigInt(c.totalRows);
      const expectedR = (prevR + BigInt(ROWS_PER_TASK)) % totalRows;
      return nextBlock === 0 && nextR === expectedR;
    }
  }

  recordTaskResult(result) {
    const task = result.task;
    const tid = result.id;
    this.completedTasks.add(tid);

    const combos =
      (result.counters.generators || 0) + (result.counters.quotient_points || 0);
    this.totalSessionCombinations += combos;
    this.totalMinedBlocks++;

    if (result.hits && result.hits.length > 0) {
      this.bestSessionCandidate = { xyz: result.hits[0].xyz, delta: 0 };
    }

    const c = CONTEXTS.find(x => x.id === task.context) || CONTEXTS[0];
    const lastSeg = this.segments[this.segments.length - 1];

    if (
      lastSeg &&
      lastSeg.context === task.context &&
      this._isNextTask(c, lastSeg.lastRow, lastSeg.lastBlock, task.row, task.block)
    ) {
      // Extend contiguous segment in O(1) time
      lastSeg.count++;
      lastSeg.combinations += combos;
      lastSeg.lastRow = String(task.row);
      lastSeg.lastBlock = task.block;
      lastSeg.digest = result.digest;
    } else {
      // Start a new segment
      this.segments.push({
        context: task.context,
        startRow: String(task.row),
        startBlock: task.block,
        lastRow: String(task.row),
        lastBlock: task.block,
        count: 1,
        combinations: combos,
        digest: result.digest,
      });
    }

    return {
      taskId: tid,
      combinations: combos,
      bankSize: this.totalMinedBlocks,
      totalCombinations: this.totalSessionCombinations,
    };
  }

  /**
   * Generates an ultra-compact 114v2 verification report.
   * Compresses millions of consecutive blocks into concise range lines.
   * Payload size is O(1) ~300 bytes regardless of block count.
   */
  formatReport(contributorName = 'Anonymous', githubHandle = '') {
    if (this.totalMinedBlocks === 0 && this.segments.length === 0) return null;

    const name = (contributorName.trim() || 'Anonymous').slice(0, 64);
    const gh = githubHandle.replace(/^@/, '').trim().slice(0, 64);

    const rangeLines = this.segments
      .map(s => `${s.context}:${s.startRow}:${s.startBlock}:${s.count}:${s.digest}`)
      .join('\n');

    const firstCtx = this.segments[0]?.context || 'c00';
    const title = `[REPORT] ${firstCtx} (${this.totalMinedBlocks.toLocaleString()} blocks)`;

    const body = [
      `### Search Verification Report`,
      `- Contributor: **${name}** (@${gh || 'anonymous'})`,
      `- Total Blocks Mined: \`${this.totalMinedBlocks.toLocaleString()}\``,
      `- Total Combinations Evaluated: \`${this.totalSessionCombinations.toLocaleString()}\``,
      ``,
      `<!-- 114v2 -->`,
      `contributor: ${name}`,
      `github: ${gh}`,
      `blocks: ${this.totalMinedBlocks}`,
      `combinations: ${this.totalSessionCombinations}`,
      this.bestSessionCandidate ? `solution: ${JSON.stringify(this.bestSessionCandidate.xyz)}` : '',
      `ranges:`,
      rangeLines,
      `<!-- end-114v2 -->`,
    ].filter(Boolean).join('\n');

    return {
      title,
      body,
      blocks: this.totalMinedBlocks,
      combinations: this.totalSessionCombinations,
    };
  }

  formatReportBlock(contributorName = 'Anonymous', githubHandle = '') {
    return this.formatReport(contributorName, githubHandle);
  }

  clearBank() {
    this.segments = [];
    this.totalMinedBlocks = 0;
    this.totalSessionCombinations = 0;
  }
}
