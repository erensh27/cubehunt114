/* Web Worker background compute thread for 114 distributed search.
 * Executes cubic-field norm tasks and reports real-time telemetry.
 */

import { runTask, verifyTriple, ENGINE } from './engine.mjs';

let running = false;
let busy = false;
let throttleMs = 0; // Delay between tasks for duty-cycle regulation

self.onmessage = async ({ data }) => {
  if (data?.cmd === 'start') {
    running = true;
    throttleMs = data.throttleMs || 0;
    self.postMessage({ type: 'status', status: 'running' });
    return;
  }
  if (data?.cmd === 'stop') {
    running = false;
    busy = false;
    self.postMessage({ type: 'status', status: 'idle' });
    return;
  }
  if (data?.cmd === 'set_duty') {
    throttleMs = data.throttleMs || 0;
    return;
  }
  if (data?.cmd === 'run_task') {
    if (busy) {
      self.postMessage({ type: 'error', message: 'Worker already executing a task' });
      return;
    }
    running = true;
    busy = true;

    const task = data.task;
    const t0 = performance.now();

    try {
      // Execute the task with live hit observer
      const result = await runTask(task, {
        onHit: hit => {
          if (verifyTriple(hit?.xyz, 114)) {
            self.postMessage({ type: 'solution_found', hit });
          }
        },
      });

      const elapsedMs = performance.now() - t0;

      self.postMessage({
        type: 'task_completed',
        result,
        elapsedMs,
      });
    } catch (err) {
      console.error('Worker task error:', err);
      self.postMessage({ type: 'error', message: String(err?.message || err) });
    } finally {
      busy = false;
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

self.postMessage({ type: 'worker_ready', engine: ENGINE });
