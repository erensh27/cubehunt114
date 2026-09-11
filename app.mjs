/* Main UI controller, telemetry visualizer, and distributed miner client.
 * 100% client-side web application designed for Vercel deployment.
 */

import { SearchSession } from './search-session.mjs';
import { runTask, verifyTriple } from './engine.mjs';

// Configuration
const REPO_OWNER = 'erensh27';
const REPO_NAME = 'sum-of-three-cubes-114';

const $ = id => document.getElementById(id);
const fmt = n => (n != null ? Number(n).toLocaleString('en-US') : '—');

const NS = 'http://www.w3.org/2000/svg';
const compactFmt = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 2,
});
const fmtCompact = v => compactFmt.format(v || 0);

function node(tag, attrs = {}, value) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (value != null) e.textContent = value;
  return e;
}

class App {
  constructor() {
    this.session = new SearchSession('./');
    this.worker = null;
    this.workerAvailable = false;
    this.directTimer = null;
    this.isRunning = false;
    this.dutyThrottle = 0;
    this.recentRates = [];
    this.globalBaseCombinations = 0;
    this.globalBaseTasks = 0;

    // Measured rate telemetry (Math-Gambling pulse graph)
    this.graphPoints = [];
    this.startedTime = 0;
    this.lastSampleTime = 0;
    this.lastSampleCombos = 0;
    this.graphTimer = null;
    this.elapsedTimer = null;
    this.sessionStartTimestamp = null;
    this.GRAPH_INTERVAL_MS = 4500; // 4.5 second cadence

    this.initElements();
    this.loadSavedIdentity();
    this.bindEvents();
    this.initWorker();
    this.loadState();

    window.addEventListener('resize', () => this.renderPulseGraph());
  }

  initElements() {
    this.el = {
      statusIndicator: $('status-indicator'),
      statusText: $('status-text'),
      btnToggle: $('btn-toggle'),
      btnSubmit: $('btn-submit'),
      syncState: $('sync-state'),
      sessionElapsed: $('session-elapsed'),
      inputName: $('input-name'),
      inputGithub: $('input-github'),
      dutySelect: $('duty-select'),
      statContext: $('stat-context'),
      statBlocksMined: $('stat-blocks-mined'),
      statSessionCombos: $('stat-session-combos'),
      statRate: $('stat-rate'),
      statGraphRate: $('stat-graph-rate'),
      runPulse: $('run-pulse'),
      globalCounter: $('global-total-counter'),
      leaderboardBody: $('leaderboard-body'),
      modalReport: $('modal-report'),
      reportTitle: $('report-title'),
      reportBody: $('report-body'),
      reportCopyStatus: $('report-copy-status'),
      btnCopyReport: $('btn-copy-report'),
      btnGithubIssue: $('btn-github-issue'),
      btnCloseModal: $('btn-close-modal'),
    };
  }

  loadSavedIdentity() {
    const savedName = localStorage.getItem('114-contributor') || localStorage.getItem('114-name');
    const savedGh = localStorage.getItem('114-github');
    if (savedName && this.el.inputName) this.el.inputName.value = savedName;
    if (savedGh && this.el.inputGithub) this.el.inputGithub.value = savedGh;
  }

  saveIdentity() {
    const name = this.el.inputName ? this.el.inputName.value.trim() : '';
    const gh = this.el.inputGithub ? this.el.inputGithub.value.trim().replace(/^@/, '') : '';
    localStorage.setItem('114-contributor', name);
    localStorage.setItem('114-name', name);
    localStorage.setItem('114-github', gh);
  }

  initWorker() {
    this.workerAvailable = false;
    try {
      const workerUrl = new URL('./search-worker.mjs', import.meta.url);
      this.worker = new Worker(workerUrl, { type: 'module' });
      this.worker.onmessage = this.handleWorkerMessage.bind(this);
      this.worker.onerror = err => {
        console.warn('Web Worker error, falling back to direct runner:', err);
        this.workerAvailable = false;
        if (this.isRunning) {
          this.dispatchDirectTask();
        }
      };
      this.workerAvailable = true;
    } catch (err) {
      console.warn('Web Worker initialization failed, falling back to direct compute:', err);
      this.worker = null;
      this.workerAvailable = false;
    }
  }

  async loadState() {
    try {
      const init = await this.session.loadInitialData();
      if (this.el.statContext && init?.context) {
        this.el.statContext.textContent = init.context;
      }
    } catch (err) {
      console.warn('Notice: Failed loading initial state, continuing with defaults:', err);
    }
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
    if (!tbody) return;
    tbody.innerHTML = '';

    if (!contributors || contributors.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="4" class="empty-state">No verified blocks recorded yet. Be the first to mine.</td>`;
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
      `;
      tbody.appendChild(tr);
    });
  }

  updateGlobalCounter() {
    if (!this.el.globalCounter) return;
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

    const onIdentityInput = () => this.saveIdentity();
    this.el.inputName.addEventListener('input', onIdentityInput);
    this.el.inputGithub.addEventListener('input', onIdentityInput);
    this.el.inputName.addEventListener('change', onIdentityInput);
    this.el.inputGithub.addEventListener('change', onIdentityInput);

    this.el.btnSubmit.addEventListener('click', () => {
      this.openSubmitModal();
    });

    this.el.btnCloseModal.addEventListener('click', () => {
      this.el.modalReport.classList.add('hidden');
    });

    this.el.btnCopyReport.addEventListener('click', async () => {
      const text = this.el.reportBody.value;
      try {
        await navigator.clipboard.writeText(text);
        this.el.reportCopyStatus.textContent = 'Copied to clipboard! Now click "2. Open GitHub Issue ↗" and paste (Ctrl+V) into the issue description.';
        this.el.btnCopyReport.textContent = 'Copied!';
        setTimeout(() => {
          this.el.btnCopyReport.textContent = '1. Copy Report';
        }, 2000);
      } catch {
        this.el.reportBody.focus();
        this.el.reportBody.select();
        this.el.reportCopyStatus.textContent = 'Report selected! Press Ctrl+C (or Cmd+C) to copy, then click "Open GitHub Issue ↗".';
      }
    });

    // Native link navigation for GitHub issues (avoids browser popup blockers)
    this.el.btnGithubIssue.addEventListener('pointerdown', () => {
      const text = this.el.reportBody.value;
      if (text) {
        navigator.clipboard?.writeText?.(text).catch(() => {});
      }
    });
  }

  start() {
    this.isRunning = true;
    this.saveIdentity();
    if (this.el.statusIndicator) this.el.statusIndicator.className = 'indicator running';
    if (this.el.statusText) this.el.statusText.textContent = 'MINING ACTIVE';
    if (this.el.btnToggle) {
      this.el.btnToggle.textContent = 'PAUSE COMPUTE';
      this.el.btnToggle.classList.add('active');
    }

    const now = Date.now();
    if (!this.sessionStartTimestamp) {
      this.sessionStartTimestamp = now;
    }
    this.startedTime = now;
    this.lastSampleTime = now;
    this.lastSampleCombos = this.session.totalSessionCombinations;

    if (this.graphPoints.length === 0) {
      this.graphPoints.push({ at: now, rate: 0 });
    }

    this.renderPulseGraph();

    // Start cadence timers
    clearInterval(this.graphTimer);
    this.graphTimer = setInterval(() => this.sampleGraphPoint(), this.GRAPH_INTERVAL_MS);

    clearInterval(this.elapsedTimer);
    this.elapsedTimer = setInterval(() => this.updateElapsed(), 1000);

    if (!this.worker) this.initWorker();
    if (this.worker && this.workerAvailable) {
      try {
        this.worker.postMessage({ cmd: 'start', throttleMs: this.dutyThrottle });
      } catch {}
    }
    this.dispatchNextTask();
  }

  stop() {
    this.isRunning = false;
    if (this.directTimer) {
      clearTimeout(this.directTimer);
      this.directTimer = null;
    }
    if (this.el.statusIndicator) this.el.statusIndicator.className = 'indicator idle';
    if (this.el.statusText) this.el.statusText.textContent = 'MINING PAUSED';
    if (this.el.btnToggle) {
      this.el.btnToggle.textContent = 'RESUME MINING';
      this.el.btnToggle.classList.remove('active');
    }

    clearInterval(this.graphTimer);
    this.graphTimer = null;

    clearInterval(this.elapsedTimer);
    this.elapsedTimer = null;

    this.sampleGraphPoint(true);
    if (this.el.statGraphRate) this.el.statGraphRate.textContent = 'Paused';
    if (this.el.statRate) this.el.statRate.textContent = '0 combos/s';

    if (this.worker && this.workerAvailable) {
      try {
        this.worker.postMessage({ cmd: 'stop' });
      } catch {}
    }
  }

  updateElapsed() {
    if (!this.sessionStartTimestamp || !this.el.sessionElapsed) return;
    const sec = Math.floor((Date.now() - this.sessionStartTimestamp) / 1000);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    this.el.sessionElapsed.textContent = `${m}:${s.toString().padStart(2, '0')}`;
  }

  dispatchNextTask() {
    if (!this.isRunning) return;
    if (this.worker && this.workerAvailable) {
      try {
        const task = this.session.getNextTask();
        if (this.el.statContext && task?.context) {
          this.el.statContext.textContent = task.context;
        }
        this.worker.postMessage({ cmd: 'run_task', task });
        return;
      } catch (err) {
        console.warn('Worker dispatch error, falling back to direct compute runner:', err);
        this.workerAvailable = false;
      }
    }
    this.dispatchDirectTask();
  }

  async dispatchDirectTask() {
    if (!this.isRunning) return;
    try {
      const task = this.session.getNextTask();
      if (this.el.statContext && task?.context) {
        this.el.statContext.textContent = task.context;
      }
      const t0 = performance.now();
      const result = await runTask(task, {
        onHit: hit => {
          if (verifyTriple(hit?.xyz, 114)) {
            console.warn('MATHEMATICAL SOLUTION FOUND:', hit);
            alert(`MATHEMATICAL SOLUTION IDENTIFIED: (${hit.xyz.join(', ')})`);
          }
        },
      });
      const elapsedMs = performance.now() - t0;
      this.handleTaskCompleted(result, elapsedMs);
    } catch (err) {
      console.error('Direct task compute error:', err);
    }

    if (this.isRunning) {
      const delay = this.dutyThrottle > 0 ? this.dutyThrottle : 0;
      this.directTimer = setTimeout(() => this.dispatchNextTask(), delay);
    }
  }

  handleWorkerMessage({ data }) {
    if (data.type === 'task_completed') {
      this.handleTaskCompleted(data.result, data.elapsedMs);
    } else if (data.type === 'request_next_task') {
      this.dispatchNextTask();
    } else if (data.type === 'solution_found') {
      console.warn('MATHEMATICAL SOLUTION FOUND:', data.hit);
      alert(`MATHEMATICAL SOLUTION IDENTIFIED: (${data.hit.xyz.join(', ')})`);
    } else if (data.type === 'error') {
      console.warn('Worker error received, switching to direct compute runner:', data.message);
      this.workerAvailable = false;
      this.dispatchDirectTask();
    }
  }

  handleTaskCompleted(result, elapsedMs) {
    if (!result) return;
    const recorded = this.session.recordTaskResult(result);

    // Instantaneous rate
    const elapsed = Math.max(elapsedMs || 100, 10) / 1000;
    const rate = Math.round(recorded.combinations / elapsed);
    this.recentRates.push(rate);
    if (this.recentRates.length > 20) this.recentRates.shift();
    const avgRate = Math.round(
      this.recentRates.reduce((a, b) => a + b, 0) / this.recentRates.length
    );

    if (this.el.statSessionCombos) {
      this.el.statSessionCombos.textContent = fmt(this.session.totalSessionCombinations);
    }
    if (this.el.statBlocksMined) {
      this.el.statBlocksMined.textContent = fmt(recorded.bankSize);
    }
    if (this.el.statRate) {
      this.el.statRate.textContent = `${fmt(avgRate)} combos/s`;
    }

    this.updateGlobalCounter();

    // Immediate first graph point so SVG chart renders on first completed block
    if (this.graphPoints.length < 2) {
      this.graphPoints.push({ at: Date.now(), rate: Math.max(1, avgRate) });
      this.renderPulseGraph();
    }

    // Update submit/bank UI once at least 1 block is mined
    const count = recorded.bankSize;
    if (count > 0) {
      if (this.el.btnSubmit) {
        this.el.btnSubmit.disabled = false;
        this.el.btnSubmit.textContent = `Bank Work (${count} block${count > 1 ? 's' : ''}) ↗`;
      }
      if (this.el.syncState) {
        this.el.syncState.textContent = `${count} block${count > 1 ? 's' : ''} mined · ready to submit to GitHub`;
      }

      const repoOwner = localStorage.getItem('114-repo-owner') || REPO_OWNER;
      const repoName = localStorage.getItem('114-repo-name') || REPO_NAME;
      const defaultTitle = `[REPORT] ${result.task.context} (${count} block${count > 1 ? 's' : ''})`;
      if (this.el.btnGithubIssue) {
        this.el.btnGithubIssue.href = `https://github.com/${repoOwner}/${repoName}/issues/new?template=report.yml&title=${encodeURIComponent(defaultTitle)}`;
      }
    }

    // Check if sample cadence reached
    const now = Date.now();
    if (now - this.lastSampleTime >= this.GRAPH_INTERVAL_MS) {
      this.sampleGraphPoint();
    }
  }

  sampleGraphPoint(force = false) {
    const now = Date.now();
    const dt = (now - this.lastSampleTime) / 1000;
    if (!force && dt < 3.5) return;

    const currentCombos = this.session.totalSessionCombinations;
    const combosDelta = currentCombos - this.lastSampleCombos;
    const rate = dt > 0 ? combosDelta / dt : 0;

    this.graphPoints.push({ at: now, rate: Math.max(0, rate) });
    if (this.graphPoints.length > 80) this.graphPoints.shift();

    this.lastSampleTime = now;
    this.lastSampleCombos = currentCombos;

    if (this.el.statGraphRate) {
      this.el.statGraphRate.textContent = this.isRunning ? fmtCompact(Math.round(rate)) : 'Paused';
    }

    this.renderPulseGraph();
  }

  // ── Math-Gambling Pulse SVG Throughput Graph ──────────────────────────────
  renderPulseGraph() {
    const el = this.el.runPulse;
    if (!el) return;

    if (this.graphPoints.length < 2) {
      el.innerHTML = this.isRunning
        ? '<p class="empty-state" style="color: var(--accent-cyan);">Mining active. Plotting measured throughput (4.5s cadence)...</p>'
        : '<p class="empty-state">Compute standby. Click "Start Mining" to begin distributed search.</p>';
      return;
    }

    const W = Math.max(280, Math.min(1060, el.clientWidth || 800));
    const H = 190;
    const pl = 55;
    const pb = 27;
    const max = Math.max(...this.graphPoints.map(p => p.rate), 1);
    const first = this.graphPoints[0].at;
    const last = this.graphPoints[this.graphPoints.length - 1].at;

    const X = x => pl + ((x - first) / Math.max(1, last - first)) * (W - pl - 12);
    const Y = y => 10 + (1 - y / max) * (H - pb - 10);

    const svg = node('svg', {
      viewBox: `0 0 ${W} ${H}`,
      role: 'img',
      'aria-label': 'Measured combinations per wall-clock second across completed batches. Zero-based vertical axis.',
    });

    // 4 Horizontal Grid Lines & Y-axis labels
    for (let i = 0; i < 4; i++) {
      const y = (max * i) / 3;
      svg.append(
        node('line', {
          x1: pl,
          y1: Y(y),
          x2: W - 12,
          y2: Y(y),
          class: 'chart-grid',
        })
      );
      svg.append(
        node(
          'text',
          {
            x: pl - 8,
            y: Y(y) + 4,
            'text-anchor': 'end',
            class: 'chart-label',
          },
          fmtCompact(y)
        )
      );
    }

    // Curve Line & Shaded Area
    const path = this.graphPoints
      .map((p, i) => `${i ? 'L' : 'M'}${X(p.at).toFixed(1)},${Y(p.rate).toFixed(1)}`)
      .join(' ');

    svg.append(
      node('path', {
        d: path + ` L${X(last)},${H - pb} L${X(first)},${H - pb} Z`,
        class: 'pulse-area',
      })
    );
    svg.append(node('path', { d: path, class: 'pulse-line' }));

    // X-axis Time stamps
    const elapsedStart = this.sessionStartTimestamp ? (first - this.sessionStartTimestamp) / 1000 : 0;
    const elapsedEnd = this.sessionStartTimestamp ? (last - this.sessionStartTimestamp) / 1000 : 0;

    svg.append(
      node(
        'text',
        { x: X(first), y: H - 6, 'text-anchor': 'start', class: 'chart-label' },
        `${Math.max(0, elapsedStart).toFixed(1)}s`
      )
    );
    svg.append(
      node(
        'text',
        { x: X(last), y: H - 6, 'text-anchor': 'end', class: 'chart-label' },
        `${Math.max(0, elapsedEnd).toFixed(1)}s`
      )
    );

    el.replaceChildren(svg);
  }

  openSubmitModal() {
    this.saveIdentity();

    const contributor = this.el.inputName.value.trim() || 'Anonymous';
    const github = this.el.inputGithub.value.trim().replace(/^@/, '');
    const repoOwner = localStorage.getItem('114-repo-owner') || REPO_OWNER;
    const repoName = localStorage.getItem('114-repo-name') || REPO_NAME;
    const repoBase = `https://github.com/${repoOwner}/${repoName}`;

    const report = this.session.formatReportBlock(contributor, github);

    if (!report) {
      this.el.reportTitle.value = '[REPORT] Session Ready';
      this.el.reportBody.value = 'No mined blocks in current session yet. Click "Start Mining" to compute blocks, or visit GitHub Issues to view community submissions.';
      this.el.reportCopyStatus.textContent = 'No blocks mined yet. Start compute to generate verifiable blocks.';
      this.el.btnGithubIssue.href = `${repoBase}/issues`;
      this.el.modalReport.classList.remove('hidden');
      return;
    }

    this.el.reportTitle.value = report.title;
    this.el.reportBody.value = report.body;
    this.el.reportCopyStatus.textContent = '1. Click "Copy Report" (or it auto-copies). 2. Click "Open GitHub Issue ↗" and paste (Ctrl+V) into the issue description.';

    // Construct issue URL with template and title (payload is copied via clipboard to avoid HTTP 414 length limits)
    const issueUrl = `${repoBase}/issues/new?template=report.yml&title=${encodeURIComponent(report.title)}`;
    this.el.btnGithubIssue.href = issueUrl;

    // Auto-copy report to clipboard immediately upon opening modal
    navigator.clipboard?.writeText?.(report.body).then(() => {
      this.el.reportCopyStatus.textContent = 'Copied to clipboard! Now click "2. Open GitHub Issue ↗" and paste (Ctrl+V) into the issue description.';
    }).catch(() => {});

    this.el.modalReport.classList.remove('hidden');
  }

  escape(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}

const initApp = () => {
  if (!window.app) {
    window.app = new App();
  }
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
