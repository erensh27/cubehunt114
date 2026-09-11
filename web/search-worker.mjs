/* Web Worker background compute thread for 114 distributed search.
 * Executes cubic-field norm tasks and reports real-time telemetry.
 */

import { runTaskCore, canonicalJSON, verifyTriple } from './engine.mjs';

let running = false;
let throttleMs = 0; // Delay between tasks for duty-cycle regulation

self.onmessage = async ({ data }) => {
  if (data.cmd === 'start') {
    running = true;
    throttleMs = data.throttleMs || 0;
    self.postMessage({ type: 'status', status: 'running' });
  } else if (data.cmd === 'stop') {
    running = false;
    self.postMessage({ type: 'status', status: 'idle' });
  } else if (data.cmd === 'set_duty') {
    throttleMs = data.throttleMs || 0;
  } else if (data.cmd === 'run_task') {
    running = true;

    const task = data.task;
    const t0 = performance.now();

    try {
      // Execute the task with live hit observer
      const coreResult = runTaskCore(task, {
        onHit: hit => {
          if (verifyTriple(hit?.xyz, 114)) {
            self.postMessage({ type: 'solution_found', hit });
          }
        },
      });

      // Compute WebCrypto SHA-256 digest
      const encoded = new TextEncoder().encode(canonicalJSON(coreResult));
      const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
      const digest = Array.from(new Uint8Array(hashBuffer), b =>
        b.toString(16).padStart(2, '0')
      ).join('');

      const elapsedMs = performance.now() - t0;
      const fullResult = { ...coreResult, digest };

      self.postMessage({
        type: 'task_completed',
        result: fullResult,
        elapsedMs,
      });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err?.message || err) });
    }

    // Duty-cycle throttle pause
    if (throttleMs > 0) {
      await new Promise(r => setTimeout(r, throttleMs));
    }

    if (running) {
      self.postMessage({ type: 'request_next_task' });
    }
  }
};

self.postMessage({ type: 'worker_ready' });
