/* Session manager and task distributor for 114 distributed search.
 * Loads small public high-water marks and distributes workers across all 81
 * contexts. Exact completed IDs remain in server-side context shards.
 */

import { CONTEXTS, makeTask, taskId, ROWS_PER_TASK } from './engine.mjs';

export class SearchSession {
  // Max tasks per report batch (for verification safety in GitHub Actions)
  static MAX_TASKS_PER_REPORT = 5000000;

  constructor(baseUrl = './') {
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    this.completedTasks = new Set();
    this.frontiers = {};
    this.highWaterMarks = {};
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
        // Migrate legacy flat task array: condense contiguous chunks into segments
        const segs = [];
        for (const item of val) {
          const t = item.task;
          const d = item.digest || '';
          const combos = item.combinations || 2048;
          const c = CONTEXTS.find(x => x.id === t.context) || CONTEXTS[0];
          const last = segs[segs.length - 1];
          if (last && last.context === t.context && this._isNextTask(c, last.lastRow, last.lastBlock, t.row, t.block)) {
            last.count++;
            last.combinations += combos;
            last.lastRow = String(t.row);
            last.lastBlock = t.block;
            last.digest = d;
          } else {
            segs.push({
              context: t.context,
              startRow: String(t.row),
              startBlock: t.block,
              lastRow: String(t.row),
              lastBlock: t.block,
              count: 1,
              combinations: combos,
              digest: d,
            });
          }
        }
        this.segments = segs;
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

  async loadInitialData() {
    const tryFetch = async filename => {
      const paths = [
        `https://raw.githubusercontent.com/erensh27/cubehunt114/main/data/${filename}`,
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
      const blocksData = await tryFetch('blocks.json');

      if (blocksData && blocksData.frontiers) {
        this.frontiers = blocksData.frontiers;
        this.highWaterMarks = blocksData.high_water_marks || {};
      }
    } catch (err) {
      console.warn('Notice: Could not load remote state files, falling back to local session state:', err);
    }

    // Randomized context and block starts spread simultaneous visitors over
    // the whole search space instead of repeatedly filling c01/c02 first.
    const seed = parseInt(this.sessionId, 36) || 0;
    const bestCtx = CONTEXTS[seed % CONTEXTS.length].id;
    this.activeContext = bestCtx;
    const saltOffset = ((seed >>> 7) % 1024) * ROWS_PER_TASK;
    let candidateRow = (this.highWaterMarks[bestCtx] || this.frontiers[bestCtx] || 0) + saltOffset;

    const activeCtxObj = CONTEXTS.find(c => c.id === bestCtx) || CONTEXTS[0];
    if (BigInt(candidateRow) >= BigInt(activeCtxObj.totalRows)) {
      candidateRow = 0;
    }
    this.currentRow = String(candidateRow);
    this.currentBlock = (seed >>> 17) % activeCtxObj.blocks;

    return {
      context: this.activeContext,
      startRow: this.currentRow,
      verifiedCount: 0,
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

      if (!this.completedTasks.has(tid)) return candidate;
    }

    // Advance to next context if this context is heavily covered
    const nextIdx = (CONTEXTS.findIndex(x => x.id === this.activeContext) + 1) % CONTEXTS.length;
    this.activeContext = CONTEXTS[nextIdx].id;
    this.currentRow = String(this.highWaterMarks[this.activeContext] || this.frontiers[this.activeContext] || 0);
    this.currentBlock = Math.floor(Math.random() * (CONTEXTS.find(c => c.id === this.activeContext)?.blocks || 1));
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

    // A worker can finish just after a pause/restart transition.  Never add
    // the same completed task twice: apart from inflating the block counter,
    // a duplicate here makes the compact range report invalid.
    if (this.completedTasks.has(tid)) {
      return {
        taskId: tid,
        combinations: 0,
        bankSize: this.totalMinedBlocks,
        totalCombinations: this.totalSessionCombinations,
        duplicate: true,
      };
    }
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
