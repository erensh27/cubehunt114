/* Session manager and task distributor for 114 distributed search.
 * Loads verified completed data to prevent duplicate computation and
 * assigns contiguous lattice blocks across the 81 cubic contexts.
 */

import { CONTEXTS, makeTask, taskId, ROWS_PER_TASK } from './engine.mjs';

export class SearchSession {
  constructor(baseUrl = './') {
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    this.completedTasks = new Set();
    this.frontiers = {};
    this.activeContext = 'c00';
    this.currentRow = 0;
    this.sessionBank = [];
    this.totalSessionCombinations = 0;
    this.bestSessionCandidate = null;
    this.sessionId = Math.random().toString(36).substring(2, 10);
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
    // Apply session salt to stagger concurrent uncoordinated workers in the same context
    const saltOffset = (parseInt(this.sessionId, 36) % 8) * ROWS_PER_TASK;
    let candidateRow = (this.frontiers[bestCtx] || 0) + saltOffset;

    // Ensure we start on an uncompleted row
    while (this.isRowCompleted(bestCtx, candidateRow)) {
      candidateRow += ROWS_PER_TASK;
    }
    this.currentRow = candidateRow;

    return {
      context: this.activeContext,
      startRow: this.currentRow,
      verifiedCount: this.completedTasks.size,
    };
  }

  getNextTask() {
    // Sample tasks across the 81 contexts and full lattice domain (matching math-gambling protocol)
    for (let attempt = 0; attempt < 50; attempt++) {
      const c = CONTEXTS[Math.floor(Math.random() * CONTEXTS.length)];
      const totalTasks = BigInt(c.rowTasks);
      // Uniform random 53-bit integer scaled to total row tasks
      const rFraction = Math.random();
      const rowTaskIdx = BigInt(Math.floor(rFraction * Number(totalTasks > 1000000000n ? 1000000000 : Number(totalTasks))));
      const row = (rowTaskIdx * BigInt(c.rowStride)).toString();
      const block = Math.floor(Math.random() * c.blocks);

      const candidate = makeTask(c.id, row, block);
      const tid = taskId(candidate);

      if (!this.completedTasks.has(tid)) {
        this.activeContext = c.id;
        this.currentRow = row;
        return candidate;
      }
    }

    // Fallback: sequential search in active context
    const c = CONTEXTS.find(x => x.id === this.activeContext) || CONTEXTS[0];
    const task = makeTask(c.id, String(this.currentRow), 0);
    this.currentRow = (BigInt(this.currentRow) + BigInt(ROWS_PER_TASK)).toString();
    return task;
  }

  recordTaskResult(result) {
    const tid = result.id;
    this.completedTasks.add(tid);

    const combos =
      (result.counters.generators || 0) + (result.counters.quotient_points || 0);
    this.totalSessionCombinations += combos;

    let solString = null;
    if (result.hits && result.hits.length > 0) {
      solString = JSON.stringify(result.hits[0].xyz);
      this.bestSessionCandidate = {
        xyz: result.hits[0].xyz,
        delta: 0,
      };
    }

    this.sessionBank.push({
      task: result.task,
      digest: result.digest,
      combinations: combos,
      solution: solString,
      best_delta: this.bestSessionCandidate?.delta || null,
    });

    return {
      taskId: tid,
      combinations: combos,
      bankSize: this.sessionBank.length,
      totalCombinations: this.totalSessionCombinations,
    };
  }

  formatReportBlock(contributorName = 'Anonymous', githubHandle = '') {
    if (this.sessionBank.length === 0) return null;

    const reportObj = {
      schema: '114-report-v1',
      contributor: {
        name: contributorName.trim() || 'Anonymous',
        github: githubHandle.replace('@', '').trim(),
      },
      tasks: this.sessionBank,
    };

    const firstTask = this.sessionBank[0].task;
    const taskCount = this.sessionBank.length;
    const totalCombos = this.sessionBank.reduce((acc, t) => acc + t.combinations, 0);

    const issueTitle = `[REPORT] ${firstTask.context} (row ${firstTask.row}, ${taskCount} block${taskCount > 1 ? 's' : ''})`;

    const compactBody = [
      `### Search Verification Report`,
      `- Contributor: **${reportObj.contributor.name}** (@${reportObj.contributor.github || 'anonymous'})`,
      `- Verified Blocks Mined: \`${taskCount}\``,
      `- Total Combinations Evaluated: \`${totalCombos.toLocaleString()}\``,
      ``,
      `<!-- 114-report-v1 -->`,
      `contributor: ${reportObj.contributor.name}`,
      `github: ${reportObj.contributor.github}`,
      `context: ${firstTask.context}`,
      `row: ${firstTask.row}`,
      `block: ${firstTask.block}`,
      `digest: ${this.sessionBank[0].digest}`,
      `combinations: ${totalCombos}`,
      `<!-- end-114-report -->`,
    ].join('\n');

    const markdownBody = [
      compactBody,
      ``,
      `\`\`\`json`,
      JSON.stringify(reportObj, null, 2),
      `\`\`\``,
    ].join('\n');

    return {
      title: issueTitle,
      body: markdownBody,
      compactBody: compactBody,
      json: reportObj,
    };
  }

  clearBank() {
    this.sessionBank = [];
  }
}
