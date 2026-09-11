/* Session manager and task distributor for 114 distributed search.
 * Loads verified completed data to prevent duplicate computation and
 * assigns contiguous lattice blocks across the 81 cubic contexts.
 */

import { CONTEXTS, makeTask, taskId, ROWS_PER_TASK } from './engine.mjs';

export class SearchSession {
  // Max tasks per GitHub issue – keeps body well under the 64 KB hard limit.
  static MAX_TASKS_PER_REPORT = 40;

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
    // Apply session salt to stagger concurrent uncoordinated workers in the same context
    const saltOffset = (parseInt(this.sessionId, 36) % 8) * ROWS_PER_TASK;
    let candidateRow = (this.frontiers[bestCtx] || 0) + saltOffset;

    let attempts = 0;
    // Ensure we start on an uncompleted row
    while (this.isRowCompleted(bestCtx, candidateRow) && attempts++ < 500) {
      candidateRow += ROWS_PER_TASK;
    }

    const activeCtxObj = CONTEXTS.find(c => c.id === bestCtx) || CONTEXTS[0];
    if (BigInt(candidateRow) >= BigInt(activeCtxObj.totalRows)) {
      candidateRow = 0;
    }
    this.currentRow = String(candidateRow);

    return {
      context: this.activeContext,
      startRow: this.currentRow,
      verifiedCount: this.completedTasks.size,
    };
  }

  getNextTask() {
    // Sample tasks across the 81 contexts and full lattice domain
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const c = CONTEXTS[Math.floor(Math.random() * CONTEXTS.length)];
        const totalTasks = BigInt(c.rowTasks);
        const maxIdx = totalTasks > 1000000000n ? 1000000000n : totalTasks;
        const rowTaskIdx = BigInt(Math.floor(Math.random() * Number(maxIdx)));
        const row = (rowTaskIdx * BigInt(c.rowStride)).toString();
        const block = Math.floor(Math.random() * c.blocks);

        const candidate = makeTask(c.id, row, block);
        const tid = taskId(candidate);

        if (!this.completedTasks.has(tid)) {
          this.activeContext = c.id;
          this.currentRow = row;
          return candidate;
        }
      } catch {}
    }

    // Fallback: sequential search in active context
    const c = CONTEXTS.find(x => x.id === this.activeContext) || CONTEXTS[0];
    let r = BigInt(this.currentRow || 0);
    r = (r / BigInt(ROWS_PER_TASK)) * BigInt(ROWS_PER_TASK);
    if (r >= BigInt(c.totalRows)) r = 0n;
    const task = makeTask(c.id, r.toString(), 0);
    this.currentRow = (r + BigInt(ROWS_PER_TASK)).toString();
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
    });

    return {
      taskId: tid,
      combinations: combos,
      bankSize: this.sessionBank.length,
      totalCombinations: this.totalSessionCombinations,
    };
  }

  /**
   * Formats the session bank into one or more report objects ready to be
   * pasted into GitHub Issues.
   *
   * Returns an array (always). Each element is one GitHub issue's worth of
   * data: { title, body, partIndex, totalParts, chunkSize }.
   *
   * The body contains ONLY what the verifier needs: task definition + digest.
   * All other fields (combinations, solution) are recomputed server-side from
   * the canonical Python replay, so omitting them shrinks the payload
   * dramatically without losing any information.
   */
  formatReportBlock(contributorName = 'Anonymous', githubHandle = '') {
    if (this.sessionBank.length === 0) return null;

    const contributor = {
      name: (contributorName.trim() || 'Anonymous').slice(0, 64),
      github: githubHandle.replace(/^@/, '').trim().slice(0, 64),
    };
    const totalCombos = this.sessionBank.reduce((acc, t) => acc + t.combinations, 0);
    const bank = this.sessionBank;
    const chunkSize = SearchSession.MAX_TASKS_PER_REPORT;

    // Split into chunks of chunkSize
    const chunks = [];
    for (let i = 0; i < bank.length; i += chunkSize) {
      chunks.push(bank.slice(i, i + chunkSize));
    }
    const totalParts = chunks.length;

    return chunks.map((chunk, partIdx) => {
      const firstTask = chunk[0].task;
      const chunkCombos = chunk.reduce((a, t) => a + t.combinations, 0);
      const partSuffix = totalParts > 1 ? ` part ${partIdx + 1}/${totalParts}` : '';
      const title = `[REPORT] ${firstTask.context} (${chunk.length} block${chunk.length > 1 ? 's' : ''}${partSuffix})`;

      // Compact tasks: only the fields the verifier needs.
      // combinations and solution are recomputed server-side from the replay.
      const compactTasks = chunk.map(t => ({ task: t.task, digest: t.digest }));

      const reportObj = {
        schema: '114-report-v1',
        contributor,
        tasks: compactTasks,
      };

      // Single-line (minified) JSON keeps the body as small as possible.
      const jsonStr = JSON.stringify(reportObj);

      const header = [
        `### Search Verification Report`,
        `- Contributor: **${contributor.name}** (@${contributor.github || 'anonymous'})`,
        `- Blocks: \`${chunk.length}\`` + (totalParts > 1 ? ` (part ${partIdx + 1} of ${totalParts})` : ''),
        `- Combinations in this batch: \`${chunkCombos.toLocaleString()}\``,
        totalParts > 1 ? `- Total session combinations: \`${totalCombos.toLocaleString()}\`` : '',
      ].filter(Boolean).join('\n');

      const body = [
        header,
        '',
        '```json',
        jsonStr,
        '```',
      ].join('\n');

      return { title, body, partIndex: partIdx, totalParts, chunkSize: chunk.length };
    });
  }

  clearBank() {
    this.sessionBank = [];
  }
}
