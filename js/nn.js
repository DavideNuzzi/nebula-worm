// The paper's model (NEBULA) one frame at a time: encoder (GRU -> MLP -> Gaussian), transition (MLP, bounded
// residual step, Gaussian), neural decoder (GRU -> MLP -> linear) and behavior decoder (GRU -> linear).
// Port of models/layers.py; weights from build/export_model.py. Activations in float64, weights in float32.

const LN_EPS = 1e-5;
const LOGVAR_LIMS = [-12.0, -3.0];

// erf with |error| < 1.2e-7 (Numerical Recipes erfc), for the exact GELU of torch.nn.GELU()
function erf(x) {
  const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
    t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? 1 - r : r - 1;
}
const gelu = (x) => 0.5 * x * (1 + erf(x / Math.SQRT2));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const softplus = (x) => (x > 30 ? x : Math.log1p(Math.exp(x)));
const softclamp = (x, lo, hi) => x + softplus(lo - x) - softplus(x - hi);

function linear(W, b, x, nOut, nIn, out) {
  for (let i = 0; i < nOut; i++) {
    let s = b[i];
    const row = i * nIn;
    for (let j = 0; j < nIn; j++) s += W[row + j] * x[j];
    out[i] = s;
  }
  return out;
}

function layerNorm(x, g, b, n, out) {
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (x[i] - mean) ** 2;
  const inv = 1 / Math.sqrt(v / n + LN_EPS);
  for (let i = 0; i < n; i++) out[i] = (x[i] - mean) * inv * g[i] + b[i];
  return out;
}

export class Model {
  constructor(manifest, buffer, meta) {
    this.F = meta.n_neurons; this.C = meta.n_classes; this.D = meta.latent_dim; this.H = meta.hidden;
    this.w = {};
    for (const [name, [off, shape]] of Object.entries(manifest.tensors)) {
      const size = shape.reduce((a, b) => a * b, 1);
      this.w[name] = new Float32Array(buffer, off * 4, size);
    }
    this.residualScale = this.w['transition.residual_scale'][0];
    const H = this.H;
    this.tmp = { a: new Float64Array(4 * H), b: new Float64Array(4 * H), c: new Float64Array(H), d: new Float64Array(H),
                 gi: new Float64Array(3 * H), gh: new Float64Array(3 * H), h: new Float64Array(H) };
  }

  // Linear -> ResidualBlock x k -> LayerNorm (torch Sequential indices 0, 1..k, k+1); x: input of size nIn
  body(prefix, k, x, nIn, out) {
    const H = this.H, w = this.w, t = this.tmp;
    const h = linear(w[`${prefix}.0.weight`], w[`${prefix}.0.bias`], x, H, nIn, t.c);
    for (let r = 1; r <= k; r++) {
      const p = `${prefix}.${r}.block`;
      linear(w[`${p}.0.weight`], w[`${p}.0.bias`], h, 4 * H, H, t.a);
      layerNorm(t.a, w[`${p}.1.weight`], w[`${p}.1.bias`], 4 * H, t.b);
      for (let i = 0; i < 4 * H; i++) t.b[i] = gelu(t.b[i]);
      linear(w[`${p}.3.weight`], w[`${p}.3.bias`], t.b, H, 4 * H, t.d);
      for (let i = 0; i < H; i++) h[i] += t.d[i];
    }
    return layerNorm(h, w[`${prefix}.${k + 1}.weight`], w[`${prefix}.${k + 1}.bias`], H, out);
  }

  // torch.nn.GRU, one step; h updated in place
  gru(prefix, x, nIn, h) {
    const H = this.H, w = this.w, t = this.tmp;
    linear(w[`${prefix}.weight_ih_l0`], w[`${prefix}.bias_ih_l0`], x, 3 * H, nIn, t.gi);
    linear(w[`${prefix}.weight_hh_l0`], w[`${prefix}.bias_hh_l0`], h, 3 * H, H, t.gh);
    for (let i = 0; i < H; i++) {
      const r = sigmoid(t.gi[i] + t.gh[i]);
      const z = sigmoid(t.gi[H + i] + t.gh[H + i]);
      const n = Math.tanh(t.gi[2 * H + i] + r * t.gh[2 * H + i]);
      h[i] = (1 - z) * n + z * h[i];
    }
    return h;
  }

  gaussian(prefix, h, mu, lv) {
    const w = this.w, D = this.D, H = this.H;
    linear(w[`${prefix}.mean_layer.weight`], w[`${prefix}.mean_layer.bias`], h, D, H, mu);
    linear(w[`${prefix}.logvar_layer.weight`], w[`${prefix}.logvar_layer.bias`], h, D, H, lv);
    for (let i = 0; i < D; i++) lv[i] = softclamp(lv[i], LOGVAR_LIMS[0], LOGVAR_LIMS[1]);
  }

  // A state: the three GRU states and the current latent z (from meta.starts)
  newState(start) {
    return { h_e: Float64Array.from(start.h_e), h_n: Float64Array.from(start.h_n), h_b: Float64Array.from(start.h_b),
             z: Float64Array.from(start.z) };
  }

  // p(z_{t+1} | z_t): mean z + tanh(delta) * scale, log-variance
  transition(z, mu, lv) {
    const h = this.body('transition.body_module', 3, z, this.D, this.tmp.h);
    this.gaussian('transition.gaussian_module', h, mu, lv);
    for (let i = 0; i < this.D; i++) mu[i] = z[i] + Math.tanh(mu[i]) * this.residualScale;
  }

  // decoders: neural prediction (F) and behavior logits (C); advance the decoder GRU states
  decode(state, z, x, logits) {
    const H = this.H, w = this.w;
    this.gru('target_decoders.neural.recurrent_module', z, this.D, state.h_n);
    const hn = this.body('target_decoders.neural.body_module', 2, state.h_n, H, this.tmp.h);
    linear(w['target_decoders.neural.decoder_head.weight'], w['target_decoders.neural.decoder_head.bias'], hn, this.F, H, x);
    this.gru('target_decoders.behavior.recurrent_module', z, this.D, state.h_b);
    linear(w['target_decoders.behavior.decoder_head.weight'], w['target_decoders.behavior.decoder_head.bias'], state.h_b,
           this.C, H, logits);
  }

  // encoder posterior mean of one neural frame; advances the encoder GRU state
  encode(state, x, mu) {
    this.gru('encoder.recurrent_module', x, this.F, state.h_e);
    const h = this.body('encoder.body_module', 3, state.h_e, this.H, this.tmp.h);
    this.gaussian('encoder.gaussian_module', h, mu, new Float64Array(this.D));
  }

  // One model step (as experiments/analysis_for_review/build/silence_short.py):
  //   z_s = transition sample from z;  decoders read z_s -> x_hat, logits
  //   closed loop: z <- encoder mean of x_hat, silenced neurons held at `floor`;  rollout: z <- z_s
  step(state, eps, loop, silenced, floor) {
    const D = this.D, mu = new Float64Array(D), lv = new Float64Array(D), zs = new Float64Array(D);
    this.transition(state.z, mu, lv);
    for (let i = 0; i < D; i++) zs[i] = mu[i] + Math.exp(0.5 * lv[i]) * eps[i];
    const x = new Float64Array(this.F), logits = new Float64Array(this.C);
    this.decode(state, zs, x, logits);
    if (loop) {
      const xin = Float64Array.from(x);
      for (const i of silenced) xin[i] = floor[i];
      this.encode(state, xin, state.z);
    } else {
      state.z.set(zs);
    }
    let label = 0;
    for (let k = 1; k < this.C; k++) if (logits[k] > logits[label]) label = k;
    return { x, logits, label, zs, z: Float64Array.from(state.z), mu, lv };
  }
}
