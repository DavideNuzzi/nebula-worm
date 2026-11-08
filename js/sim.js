// The virtual worm: the model produces one behavior label every 1/2.905 s (one recording frame), the labels drive
// the kymograph at 32 fps, and the kymograph drives the ElegansBot body (as ElegansBot/simulate_from_behavior.py,
// but frame by frame). Generative mode: transition only (the decoders read the transition samples). Closed loop: the
// decoded activity, with the silenced neurons held at their floor, is encoded back into the latent space.
import { Model } from './nn.js';
import { Kymograph, Worm } from './body.js';

// mulberry32 uniforms -> standard normals (Box-Muller)
export function normals(seed) {
  let a = seed >>> 0, spare = null;
  const u = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) + 1) / 4294967297;
  };
  return () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    const r = Math.sqrt(-2 * Math.log(u())), th = 2 * Math.PI * u();
    spare = r * Math.sin(th);
    return r * Math.cos(th);
  };
}

export class Simulation {
  constructor(manifest, buffer, meta, body) {
    this.meta = meta;
    this.model = new Model(manifest, buffer, meta);
    this.floor = Float64Array.from(meta.floor);
    this.fpsL = meta.fps_labels;
    this.fps = body.fps;
    this.ky = new Kymograph(body);
    this.worm = new Worm({ dt: body.dt, scaleFriction: body.scale_friction });
    this.loop = true;
    this.silenced = [];
  }

  reset(start, seed) {
    this.state = this.model.newState(this.meta.starts[start]);
    this.randn = normals(seed);
    this.labels = [];        // label of every model step so far
    this.pushed = 0;         // kymograph frames pushed
    this.frame = 0;          // body frames produced
    this.ctrl = null;        // kymogram frame driving the next physics interval
    this.ky.reset();
    this.worm.reset();
  }

  modelStep() {
    const eps = [this.randn(), this.randn(), this.randn()];
    const silenced = this.loop ? this.silenced : [];
    const o = this.model.step(this.state, eps, this.loop, silenced, this.floor);
    const i = this.labels.length;
    this.labels.push(o.label);
    const x = Float32Array.from(o.x);
    for (const j of silenced) x[j] = this.floor[j];          // the activity the encoder reads
    const mx = Math.max(...o.logits), e = Array.from(o.logits, (v) => Math.exp(v - mx)), s = e.reduce((a, b) => a + b);
    return { i, x, p: e.map((v) => v / s), z: Array.from(o.zs), label: o.label, loop: this.loop, silenced: silenced.slice() };
  }

  // the next body frame (26 tip positions, head = tip 0) and the model steps computed to get it
  nextFrame() {
    const steps = [];
    while (!this.ky.ready()) {
      const i = Math.floor(this.pushed * this.fpsL / this.fps + 1e-9);   // label at this frame (interp1d 'previous')
      while (this.labels.length <= i) steps.push(this.modelStep());
      this.ky.push(this.labels[i]);
      this.pushed++;
    }
    const k = this.ky.next();
    if (this.ctrl === null) this.worm.setTheta(k.theta);
    else { this.worm.setControl(this.ctrl); this.worm.advance(1 / this.fps); }
    this.ctrl = k.theta;
    const tips = this.worm.tips();
    return { j: this.frame++, label: k.label, x: tips.x, y: tips.y, steps };
  }
}
