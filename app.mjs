/* Main UI controller, telemetry visualizer, and distributed miner client.
 * 100% client-side web application designed for Vercel deployment.
 */

import { SearchSession } from './search-session.mjs';
import { runTask, verifyTriple } from './engine.mjs';

// Configuration
const REPO_OWNER = 'erensh27';
const REPO_NAME = 'cubehunt114';

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

// localStorage keys for session persistence
const LS_COMPLETED = '114-completed-tasks';
const LS_BANK      = '114-session-bank';
const LS_COMBOS    = '114-session-combos';

class App {
  constructor() {
    this.session = new SearchSession('./');
    this.worker = null;
    this.workerAvailable = false;   // true only after worker sends 'worker_ready'
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

    // Gate mining until remote state is loaded (so we don't re-mine done tasks)
    this._stateLoaded = false;
    this._pendingStart = false;

    this.initElements();
    this.loadSavedIdentity();
    this.bindEvents();
    this.initWorker();
    this.restoreLocalSession();  // load localStorage data first
    this.loadState();            // async – resolves _stateLoaded flag

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
      btnDownloadReport: $('btn-download-report'),
      btnClearBank: $('btn-clear-bank'),
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

  // ── Local session persistence (avoid re-mining on reload) ─────────────────

  restoreLocalSession() {
    try {
      const savedCompleted = localStorage.getItem(LS_COMPLETED);
      if (savedCompleted) {
        const ids = JSON.parse(savedCompleted);
        if (Array.isArray(ids)) {
          ids.forEach(id => this.session.completedTasks.add(id));
        }
      }
      const savedBank   = localStorage.getItem(LS_BANK);
      const savedCombos = localStorage.getItem(LS_COMBOS);
      if (savedBank) {
        const parsed = JSON.parse(savedBank);
        if (Array.isArray(parsed)) {
          this.session.sessionBank = parsed;
          this.session.totalSessionCombinations = Number(savedCombos) || 0;
        }
      }
      this.refreshSessionUI();
    } catch (e) {
      console.warn('Could not restore local session:', e);
    }
  }

  saveLocalSession() {
    try {
      const ids = [...this.session.completedTasks];
      const trimmed = ids.length > 2000 ? ids.slice(ids.length - 2000) : ids;
      localStorage.setItem(LS_COMPLETED, JSON.stringify(trimmed));
      localStorage.setItem(LS_BANK, JSON.stringify(this.session.segments));
      localStorage.setItem(LS_COMBOS, String(this.session.totalSessionCombinations));
    } catch (e) {
      // quota exceeded, silently fail
    }
  }

  // ── Worker lifecycle ───────────────────────────────────────────────────────

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
          // Only kick off direct task if one isn't already scheduled/running
          if (!this.directTimer) this.dispatchDirectTask();
        }
      };
      // NOTE: workerAvailable stays false until 'worker_ready' is received.
      // This prevents race conditions where tasks are sent before the worker
      // module has finished loading engine.mjs.
    } catch (err) {
      console.warn('Web Worker initialization failed, falling back to direct compute:', err);
      this.worker = null;
      this.workerAvailable = false;
    }
  }

  // ── State loading ──────────────────────────────────────────────────────────

  async loadState() {
    // loadInitialData replaces its completed-task set with the remote ledger.
    // Keep local completions too, so a reload cannot mine a just-finished task
    // again before it has been banked and verified remotely.
    const localCompleted = new Set(this.session.completedTasks);
    try {
      const init = await this.session.loadInitialData();
      for (const id of localCompleted) this.session.completedTasks.add(id);
      if (this.el.statContext && init?.context) {
        this.el.statContext.textContent = init.context;
      }
    } catch (err) {
      for (const id of localCompleted) this.session.completedTasks.add(id);
      console.warn('Notice: Failed loading initial state, continuing with defaults:', err);
    }

    this._stateLoaded = true;

    // Fetch and render leaderboard and stats (non-blocking for mining)
    this.refreshLeaderboard().catch(() => {});

    // If user already clicked Start while state was loading, kick off now
    if (this._pendingStart) {
      this._pendingStart = false;
      this._startMining();
    }
  }

  async refreshLeaderboard() {
    const tryFetch = async filename => {
      const paths = [
        `/data/${filename}`,
        `./data/${filename}`,
        `../data/${filename}`,
        `data/${filename}`,
        `https://raw.githubusercontent.com/erensh27/cubehunt114/main/data/${filename}`
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

      if (this.worker && this.workerAvailable) {
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

    if (this.el.btnDownloadReport) {
      this.el.btnDownloadReport.addEventListener('click', () => {
        const text = this.el.reportBody.value;
        if (!text) return;
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `project114_report_${Date.now()}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        this.el.reportCopyStatus.textContent = 'Report file downloaded! You can attach or copy from it.';
      });
    }

    if (this.el.btnClearBank) {
      this.el.btnClearBank.addEventListener('click', () => {
        if (confirm('Reset and clear banked blocks for a fresh mining batch?')) {
          this.session.clearBank();
          this.saveLocalSession();
          this._updateBankUI();
          this.el.modalReport.classList.add('hidden');
        }
      });
    }
  }

  // ── Mining control ─────────────────────────────────────────────────────────

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.saveIdentity();

    // Update UI immediately for instant feedback
    if (this.el.statusIndicator) this.el.statusIndicator.className = 'indicator running';
    if (this.el.statusText) this.el.statusText.textContent = 'MINING ACTIVE';
    if (this.el.btnToggle) {
      this.el.btnToggle.textContent = 'PAUSE COMPUTE';
      this.el.btnToggle.classList.add('active');
    }
    if (this.el.syncState && this.session.sessionBank.length === 0) {
      this.el.syncState.textContent = 'Loading search state…';
    }

    // If remote state hasn't loaded yet, wait for it before dispatching tasks
    // so we don't duplicate work already recorded in this browser session
    if (!this._stateLoaded) {
      this._pendingStart = true;
      return;
    }

    this._startMining();
  }

  _startMining() {
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
      // Worker is ready – send start signal and first task
      try {
        this.worker.postMessage({ cmd: 'start', throttleMs: this.dutyThrottle });
      } catch {}
      this.dispatchNextTask();
    } else {
      // Worker not ready yet (still loading) OR unavailable.
      // Fall back to direct main-thread runner.
      // If the worker loads later, handleWorkerMessage('worker_ready') will
      // seamlessly take over.
      this.dispatchDirectTask();
    }
  }

  stop() {
    this.isRunning = false;
    this._pendingStart = false;

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

    // Persist session state on pause
    this.saveLocalSession();
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
    if (data.type === 'worker_ready') {
      // Worker finished loading engine.mjs – now safe to send tasks
      this.workerAvailable = true;
      console.log('Search worker ready:', data.engine);

      // If we're already running (user clicked Start while worker was loading,
      // so we fell back to direct mode), switch to worker mode now by stopping
      // the direct-timer loop and kicking off worker dispatch instead.
      if (this.isRunning) {
        if (this.directTimer) {
          clearTimeout(this.directTimer);
          this.directTimer = null;
        }
        try {
          this.worker.postMessage({ cmd: 'start', throttleMs: this.dutyThrottle });
        } catch {}
        this.dispatchNextTask();
      }
    } else if (data.type === 'task_completed') {
      this.handleTaskCompleted(data.result, data.elapsedMs);
    } else if (data.type === 'request_next_task') {
      this.dispatchNextTask();
    } else if (data.type === 'solution_found') {
      console.warn('MATHEMATICAL SOLUTION FOUND:', data.hit);
      alert(`MATHEMATICAL SOLUTION IDENTIFIED: (${data.hit.xyz.join(', ')})`);
    } else if (data.type === 'error') {
      console.warn('Worker error received, switching to direct compute runner:', data.message);
      this.workerAvailable = false;
      if (this.isRunning && !this.directTimer) {
        this.dispatchDirectTask();
      }
    }
  }

  handleTaskCompleted(result, elapsedMs) {
    if (!result) return;
    const recorded = this.session.recordTaskResult(result);
    if (recorded.duplicate) return;

    // Instantaneous rate
    const elapsed = Math.max(elapsedMs || 100, 10) / 1000;
    const rate = Math.round(recorded.combinations / elapsed);
    this.recentRates.push(rate);
    if (this.recentRates.length > 20) this.recentRates.shift();
    const avgRate = Math.round(
      this.recentRates.reduce((a, b) => a + b, 0) / this.recentRates.length
    );

    this.refreshSessionUI();
    if (this.el.statRate) {
      this.el.statRate.textContent = `${fmt(avgRate)} combos/s`;
    }

    this.updateGlobalCounter();

    // Immediate first graph point so SVG chart renders on first completed block
    if (this.graphPoints.length < 2) {
      this.graphPoints.push({ at: Date.now(), rate: Math.max(1, avgRate) });
      this.renderPulseGraph();
    }

    // Update submit/bank UI
    this._updateBankUI();

    // Throttle disk writes to localStorage: at most once every 3.5 seconds
    const now = Date.now();
    if (!this._lastSaveTime || now - this._lastSaveTime >= 3500) {
      this._lastSaveTime = now;
      this.saveLocalSession();
    }

    // Check if sample cadence reached
    if (now - this.lastSampleTime >= this.GRAPH_INTERVAL_MS) {
      this.sampleGraphPoint();
    }
  }

  _updateBankUI() {
    const count = this.session.totalMinedBlocks;
    if (count > 0) {
      if (this.el.btnSubmit) {
        this.el.btnSubmit.disabled = false;
        this.el.btnSubmit.textContent = `Bank Work (${count.toLocaleString()} block${count > 1 ? 's' : ''}) ↗`;
      }
      if (this.el.syncState) {
        this.el.syncState.textContent = `${count.toLocaleString()} block${count > 1 ? 's' : ''} mined · ready to submit to GitHub`;
      }

      const repoOwner = localStorage.getItem('114-repo-owner') || REPO_OWNER;
      const repoName  = localStorage.getItem('114-repo-name') || REPO_NAME;
      const ctx = this.session.segments[0]?.context || this.session.activeContext || '';
      const defaultTitle = `[REPORT] ${ctx} (${count.toLocaleString()} block${count > 1 ? 's' : ''})`;
      if (this.el.btnGithubIssue) {
        this.el.btnGithubIssue.href = `https://github.com/${repoOwner}/${repoName}/issues/new?template=report.yml&title=${encodeURIComponent(defaultTitle)}`;
      }
    } else {
      if (this.el.btnSubmit) {
        this.el.btnSubmit.disabled = true;
        this.el.btnSubmit.textContent = 'Bank Work ↗';
      }
      if (this.el.syncState) {
        this.el.syncState.textContent = '0 blocks mined · ready to mine';
      }
    }
  }

  // Keep the visible counters and the actionable Bank Work state in sync.
  // This is also called after restoring localStorage, before any new task
  // completes, which fixes banked work appearing as zero after a reload.
  refreshSessionUI() {
    if (this.el.statSessionCombos) {
      this.el.statSessionCombos.textContent = fmt(this.session.totalSessionCombinations);
    }
    if (this.el.statBlocksMined) {
      this.el.statBlocksMined.textContent = fmt(this.session.totalMinedBlocks);
    }
    this.updateGlobalCounter();
    this._updateBankUI();
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

    const report = this.session.formatReport(contributor, github);

    if (!report) {
      this.el.reportTitle.value = '[REPORT] Session Ready';
      this.el.reportBody.value = 'No mined blocks in current session yet. Click "Start Mining" to compute blocks.';
      this.el.reportCopyStatus.textContent = 'No blocks mined yet.';
      this.el.btnGithubIssue.href = `${repoBase}/issues`;
      this.el.modalReport.classList.remove('hidden');
      return;
    }

    this.el.reportTitle.value = report.title;
    this.el.reportBody.value = report.body;

    const issueUrl = `${repoBase}/issues/new?template=report.yml&title=${encodeURIComponent(report.title)}`;
    this.el.btnGithubIssue.href = issueUrl;

    const nextBtn = document.getElementById('btn-next-part');
    if (nextBtn) nextBtn.remove();

    navigator.clipboard?.writeText?.(report.body).then(() => {
      this.el.reportCopyStatus.textContent =
        `Copied ${report.blocks.toLocaleString()} blocks to clipboard! Click "2. Open GitHub Issue ↗" and paste (Ctrl+V).`;
    }).catch(() => {
      this.el.reportCopyStatus.textContent =
        'Click "1. Copy Report", then click "2. Open GitHub Issue ↗" and paste (Ctrl+V).';
    });

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
