// Runs the simulation off the main thread. The page sends its display time; the worker keeps the body frames
// AHEAD seconds ahead of it and posts them in batches (tips as one Float32Array, 52 numbers per frame).
import { Simulation } from './sim.js';

const AHEAD = 0.35, SLICE_MS = 25;
let sim = null, epoch = 0, target = 0, busy = false;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    sim = new Simulation(m.manifest, m.buffer, m.meta, m.body);
    self.postMessage({ type: 'ready' });
  } else if (m.type === 'reset') {
    epoch = m.epoch; target = 0;
    sim.loop = m.loop; sim.silenced = m.silenced;
    sim.reset(m.start, m.seed);
    pump();
  } else if (m.type === 'clock') {
    target = m.t + AHEAD;
    pump();
  } else if (m.type === 'mode') {
    sim.loop = m.loop;
  } else if (m.type === 'silence') {
    sim.silenced = m.indices;
  }
};

function pump() {
  if (busy || !sim || !sim.state) return;
  busy = true;
  const t0 = performance.now(), frames = [], steps = [];
  while (sim.frame / sim.fps <= target && performance.now() - t0 < SLICE_MS) {
    const f = sim.nextFrame();
    frames.push(f);
    steps.push(...f.steps);
  }
  if (frames.length) {
    const tips = new Float32Array(frames.length * 52);
    frames.forEach((f, k) => { tips.set(f.x, k * 52); tips.set(f.y, k * 52 + 26); });
    self.postMessage({ type: 'frames', epoch, first: frames[0].j, labels: frames.map((f) => f.label), tips, steps,
                       compute: performance.now() - t0 }, [tips.buffer]);
  }
  busy = false;
  if (sim.frame / sim.fps <= target) setTimeout(pump, 0);
}
