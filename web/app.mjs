/* Main UI controller, telemetry visualizer, and distributed miner client.
 * 100% client-side web application designed for Vercel deployment.
 */

import { SearchSession } from './search-session.mjs';

// Configuration
const REPO_OWNER = 'erensh27';
const REPO_NAME = 'sum-of-three-cubes-114';

const $ = id => document.getElementById(id);
const fmt = n => (n != null ? Number(n).toLocaleString('en-US') : '—');

class App {
  constructor() {
    this.session = new SearchSession('./');
    this.worker = null;
    this.isRunning = false;
    this.dutyThrottle = 0; // 0ms throttle by default
    this.recentRates = [];
    this.lastTaskTime = performance.now();
    this.globalBaseCombinations = 0;
    this.globalBaseTasks = 0;

    // Visual telemetry buffer
    this.vizHistory = [];
    this.lastTaskStatus = 'STANDBY';
    this.activeFilterCounters = {
      generators: 0,
      quotient_points: 0,
      rejected_mod243: 0,
      rejected_parity: 0,
      rejected_prime: 0,
      exact_tests: 0,
    };
    this.sessionFilterCounters = {
      rejected_mod243: 0,
      rejected_parity: 0,
      rejected_prime: 0,
      exact_tests: 0,
    };

    this.initElements();
    this.initWorker();
    this.initCanvas();
    this.loadState();
    this.bindEvents();
  }

  initElements() {
    this.el = {
      statusIndicator: $('status-indicator'),
      statusText: $('status-text'),
      btnToggle: $('btn-toggle'),
      btnSubmit: $('btn-submit'),
      inputName: $('input-name'),
      inputGithub: $('input-github'),
      dutySelect: $('duty-select'),
      statContext: $('stat-context'),
      statRow: $('stat-row'),
      statSessionCombos: $('stat-session-combos'),
      statRate: $('stat-rate'),
      statBlocksMined: $('stat-blocks-mined'),
      statBestDelta: $('stat-best-delta'),
      globalCounter: $('global-total-counter'),
      leaderboardBody: $('leaderboard-body'),
      modalReport: $('modal-report'),
      reportTitle: $('report-title'),
      reportBody: $('report-body'),
      btnGithubIssue: $('btn-github-issue'),
      btnCopyReport: $('btn-copy-report'),
      btnCloseModal: $('btn-close-modal'),
      canvas: $('viz-canvas'),
    };

    // Load saved contributor handle
    const savedName = localStorage.getItem('114-name');
    const savedGh = localStorage.getItem('114-github');
    if (savedName) this.el.inputName.value = savedName;
    if (savedGh) this.el.inputGithub.value = savedGh;
  }

  initWorker() {
    try {
      const workerUrl = new URL('./search-worker.mjs', import.meta.url);
      this.worker = new Worker(workerUrl, { type: 'module' });
      this.worker.onmessage = this.handleWorkerMessage.bind(this);
    } catch (err) {
      console.error('Failed to initialize Web Worker:', err);
      this.el.statusText.textContent = 'WORKER INIT FAILED';
    }
  }

  async loadState() {
    const init = await this.session.loadInitialData();
    this.el.statContext.textContent = init.context;
    this.el.statRow.textContent = fmt(init.startRow);

    // Fetch and render leaderboard and stats
    await this.refreshLeaderboard();
  }

  async refreshLeaderboard() {
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
      const [lb, stats] = await Promise.all([
        tryFetch('leaderboard.json'),
        tryFetch('stats.json')
      ]);

      if (stats) {
        this.globalBaseCombinations = stats.total_combinations || 0;
        this.globalBaseTasks = stats.total_verified_tasks || 0;
        this.updateGlobalCounter();
      }

      if (lb) {
        this.renderLeaderboard(lb.contributors || []);
      }
    } catch (err) {
      console.warn('Could not fetch leaderboard data:', err);
    }
  }

  renderLeaderboard(contributors) {
    const tbody = this.el.leaderboardBody;
    tbody.innerHTML = '';

    if (!contributors || contributors.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="5" class="empty-state">No verified blocks recorded yet. Be the first to mine.</td>`;
      tbody.appendChild(tr);
      return;
    }

    contributors.forEach((c, idx) => {
      const tr = document.createElement('tr');
      const ghLink = c.github
        ? `<a href="https://github.com/${c.github}" target="_blank" rel="noopener">@${c.github}</a>`
        : '—';
      tr.innerHTML = `
        <td class="col-rank">${idx + 1}</td>
        <td class="col-name"><strong>${this.escape(c.name || 'Anonymous')}</strong> <span class="gh-tag">${ghLink}</span></td>
        <td class="col-blocks">${fmt(c.verified_tasks || 0)}</td>
        <td class="col-combos">${fmt(c.combinations || 0)}</td>
        <td class="col-delta">${c.best_delta != null ? fmt(c.best_delta) : '—'}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  updateGlobalCounter() {
    const total = this.globalBaseCombinations + this.session.totalSessionCombinations;
    this.el.globalCounter.textContent = total.toLocaleString('en-US');
  }

  bindEvents() {
    this.el.btnToggle.addEventListener('click', () => {
      if (this.isRunning) {
        this.stop();
      } else {
        this.start();
      }
    });

    this.el.dutySelect.addEventListener('change', e => {
      const val = e.target.value;
      if (val === 'gentle') this.dutyThrottle = 150;
      else if (val === 'balanced') this.dutyThrottle = 50;
      else this.dutyThrottle = 0;

      if (this.worker) {
        this.worker.postMessage({ cmd: 'set_duty', throttleMs: this.dutyThrottle });
      }
    });

    this.el.inputName.addEventListener('change', e => {
      localStorage.setItem('114-name', e.target.value.trim());
    });

    this.el.inputGithub.addEventListener('change', e => {
      localStorage.setItem('114-github', e.target.value.trim());
    });

    this.el.btnSubmit.addEventListener('click', () => {
      this.openSubmitModal();
    });

    this.el.btnCloseModal.addEventListener('click', () => {
      this.el.modalReport.classList.add('hidden');
    });

    this.el.btnCopyReport.addEventListener('click', () => {
      const text = this.el.reportBody.value;
      navigator.clipboard.writeText(text).then(() => {
        const orig = this.el.btnCopyReport.textContent;
        this.el.btnCopyReport.textContent = 'COPIED TO CLIPBOARD';
        setTimeout(() => {
          this.el.btnCopyReport.textContent = orig;
        }, 2000);
      });
    });
  }

  start() {
    this.isRunning = true;
    this.el.statusIndicator.className = 'indicator running';
    this.el.statusText.textContent = 'MINING ACTIVE';
    this.el.btnToggle.textContent = 'PAUSE COMPUTE';
    this.el.btnToggle.classList.add('active');

    this.worker.postMessage({ cmd: 'start', throttleMs: this.dutyThrottle });
    this.dispatchNextTask();
  }

  stop() {
    this.isRunning = false;
    this.el.statusIndicator.className = 'indicator idle';
    this.el.statusText.textContent = 'MINING PAUSED';
    this.el.btnToggle.textContent = 'START MINING';
    this.el.btnToggle.classList.remove('active');
    this.el.statRate.textContent = '0 combos/s';

    this.worker.postMessage({ cmd: 'stop' });
  }

  dispatchNextTask() {
    if (!this.isRunning) return;
    const task = this.session.getNextTask();
    this.el.statContext.textContent = task.context;
    this.el.statRow.textContent = fmt(task.row);
    this.lastTaskTime = performance.now();
    this.worker.postMessage({ cmd: 'run_task', task });
  }

  handleWorkerMessage({ data }) {
    if (data.type === 'task_completed') {
      const result = data.result;
      const recorded = this.session.recordTaskResult(result);

      // Update rate calculation
      const elapsed = (data.elapsedMs || 100) / 1000;
      const rate = Math.round(recorded.combinations / elapsed);
      this.recentRates.push(rate);
      if (this.recentRates.length > 20) this.recentRates.shift();
      const avgRate = Math.round(
        this.recentRates.reduce((a, b) => a + b, 0) / this.recentRates.length
      );

      this.el.statSessionCombos.textContent = fmt(this.session.totalSessionCombinations);
      this.el.statBlocksMined.textContent = fmt(recorded.bankSize);
      this.el.statRate.textContent = `${fmt(avgRate)} combos/s`;

      if (this.session.bestSessionCandidate) {
        this.el.statBestDelta.textContent = `0 (SOLUTION FOUND)`;
        this.el.statBestDelta.style.color = '#10b981';
      }

      this.updateGlobalCounter();

      // Enable submit button once at least 1 block is mined
      if (recorded.bankSize > 0) {
        this.el.btnSubmit.disabled = false;
      }

      // Update visual telemetry buffer
      this.activeFilterCounters = { ...result.counters };
      for (const k of ['rejected_mod243', 'rejected_parity', 'rejected_prime', 'exact_tests']) {
        this.sessionFilterCounters[k] += result.counters[k] || 0;
      }
      if (result.counters.curves > 0) {
        this.lastTaskStatus = `ACTIVE CURVE (${result.counters.quotient_points.toLocaleString()} PTS)`;
      } else {
        this.lastTaskStatus = `SHELL EXCLUSION (${result.counters.generators.toLocaleString()} GEN)`;
      }
      this.vizHistory.push({
        time: performance.now(),
        rate: avgRate,
        combos: recorded.combinations,
        context: result.task.context,
      });
      if (this.vizHistory.length > 100) this.vizHistory.shift();
    } else if (data.type === 'request_next_task') {
      this.dispatchNextTask();
    } else if (data.type === 'solution_found') {
      console.warn('MATHEMATICAL SOLUTION FOUND:', data.hit);
      alert(`MATHEMATICAL SOLUTION IDENTIFIED: (${data.hit.xyz.join(', ')})`);
    } else if (data.type === 'error') {
      console.error('Worker error:', data.message);
    }
  }

  openSubmitModal() {
    const contributor = this.el.inputName.value.trim() || 'Anonymous';
    const github = this.el.inputGithub.value.trim();

    const report = this.session.formatReportBlock(contributor, github);
    if (!report) {
      alert('No mined blocks in session yet. Start compute to mine blocks first.');
      return;
    }

    this.el.reportTitle.value = report.title;
    this.el.reportBody.value = report.body;

    // Build GitHub Issues new URL
    const url = new URL(`https://github.com/${REPO_OWNER}/${REPO_NAME}/issues/new`);
    url.searchParams.set('title', report.title);
    url.searchParams.set('body', report.body);
    url.searchParams.set('labels', 'report');

    this.el.btnGithubIssue.href = url.toString();
    this.el.modalReport.classList.remove('hidden');
  }

  // ── High-Performance Telemetry Canvas ────────────────────────────────────
  initCanvas() {
    const canvas = this.el.canvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
    };

    window.addEventListener('resize', resize);
    resize();

    // Render loop
    const draw = () => {
      this.renderCanvasFrame(ctx, canvas.getBoundingClientRect());
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  }

  renderCanvasFrame(ctx, rect) {
    const w = rect.width;
    const h = rect.height;
    ctx.clearRect(0, 0, w, h);

    // Background grid lines
    ctx.strokeStyle = '#12161f';
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y < h; y += 30) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // Top: Sieve Filter Waterfall Breakdown (Session Cumulative)
    const topH = h * 0.45;
    const padding = 20;
    const barWidth = (w - padding * 2) / 4 - 10;
    const filters = [
      { label: 'MOD-243 SIEVE', val: this.sessionFilterCounters.rejected_mod243, color: '#38bdf8' },
      { label: 'PARITY FILTER', val: this.sessionFilterCounters.rejected_parity, color: '#818cf8' },
      { label: 'PRIME QR SIEVE', val: this.sessionFilterCounters.rejected_prime, color: '#f59e0b' },
      { label: 'EXACT SQRT', val: this.sessionFilterCounters.exact_tests, color: '#10b981' },
    ];

    const maxVal = Math.max(1, ...filters.map(f => f.val));

    // Status banner at top right of canvas
    ctx.fillStyle = '#64748b';
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`STATUS: ${this.lastTaskStatus}`, w - padding, 18);

    filters.forEach((f, i) => {
      const bx = padding + i * (barWidth + 10);
      const barH = (f.val / maxVal) * (topH - 52);
      const by = topH - barH - 8;

      // Label
      ctx.fillStyle = '#64748b';
      ctx.font = '10px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(f.label, bx, 18);

      // Value
      ctx.fillStyle = '#cbd5e1';
      ctx.font = 'bold 12px monospace';
      ctx.fillText(fmt(f.val), bx, 32);

      // Bar
      ctx.fillStyle = f.color;
      ctx.fillRect(bx, by, barWidth, Math.max(2, barH));
    });

    // Divider Line
    ctx.strokeStyle = '#1e293b';
    ctx.beginPath();
    ctx.moveTo(0, topH);
    ctx.lineTo(w, topH);
    ctx.stroke();

    // Bottom: Throughput Waveform (combos / sec)
    const waveH = h - topH;
    ctx.fillStyle = '#64748b';
    ctx.font = '10px monospace';
    ctx.fillText('LIVE THROUGHPUT (COMBINATIONS / SEC)', padding, topH + 20);

    const history = this.vizHistory;
    if (history.length > 1) {
      const maxRate = Math.max(1000, ...history.map(p => p.rate));
      const stepX = (w - padding * 2) / Math.max(history.length - 1, 10);

      ctx.beginPath();
      history.forEach((p, idx) => {
        const px = padding + idx * stepX;
        const normalized = p.rate / maxRate;
        const py = h - 20 - normalized * (waveH - 50);
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });

      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Glowing dot at cursor
      const last = history[history.length - 1];
      const lastX = padding + (history.length - 1) * stepX;
      const lastY = h - 20 - (last.rate / maxRate) * (waveH - 50);

      ctx.beginPath();
      ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#34d399';
      ctx.fill();
    } else {
      ctx.fillStyle = '#334155';
      ctx.font = '11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(this.isRunning ? 'CALIBRATING SIGNAL...' : 'ENGINE STANDBY', w / 2, topH + waveH / 2);
    }
  }

  escape(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
