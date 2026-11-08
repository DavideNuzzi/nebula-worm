// From behavior labels to body movement, ported from ElegansBot (elegansbot.py and utils.py):
//   Kymograph: utils.behavior_to_kymogram (eigenworm phase oscillator, smoothed turn mode), streamed frame by frame
//   Worm: elegansbot.Worm (Newtonian rod chain on agar), step_numba / cholSolver_banded line by line
//
// ElegansBot: https://github.com/TaegonChung/ElegansBot
// MIT License
//
// Copyright (c) 2023 Taegon Chung
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

const TWO_PI = 2 * Math.PI;

// ----------------------------------------------------------------------------------------------------------------- //
// behavior_to_kymogram, streamed. Python computes the turn mode with np.convolve(a, w, 'same') over the whole sequence:
// out[t] = sum_k a[t + 31 - k] w[k] (64-tap Gaussian, 2 s at 32 fps), which looks 31 frames ahead; here frame t is
// emitted once label t + 31 has been pushed, so the body runs 31 frames (0.97 s) behind the labels.
export class Kymograph {
  constructor(body) {
    this.fps = body.fps;
    this.E = body.eigen5;                     // 100 x 5
    this.M = body.interp;                     // 26 x 101
    const wf = Math.trunc(2 * this.fps);      // int(w_seconds * fps)
    const w = Array.from({ length: wf }, (_, i) => Math.exp(-((-3 + 6 * i / (wf - 1)) ** 2)));
    const s = w.reduce((a, b) => a + b, 0);
    this.w = w.map((v) => v / s);
    this.lead = Math.floor((wf - 1) / 2);     // 31: frames of look-ahead
    this.wf = wf;
    this.reset();
  }

  reset() {
    this.phi = 0;
    this.raw = [];                            // pushed frames: [mode0, mode1, turn target, label]
    this.t = 0;                               // next frame to emit
  }

  // one label at the kymogram rate (32 fps)
  push(label) {
    const amp = 7, f = this.fps;
    this.raw.push([amp * Math.cos(this.phi), amp * Math.cos(Math.PI / 2 + this.phi),
                   label === 5 ? 4 : label === 6 ? -4 : 0, label]);
    if (label === 0 || label === 5 || label === 6) this.phi += TWO_PI * 0.57 / f;     // forward, dorsal/ventral turn
    else if (label === 1) this.phi += TWO_PI * 0.3 / f;                               // slow
    else if (label >= 2 && label <= 4) this.phi += -TWO_PI * 0.5 / f;                 // reversals
  }

  ready() { return this.raw.length >= this.t + this.lead + 1; }

  // next frame: { theta: 24 joint angles, modes, label }
  next() {
    const t = this.t, w = this.w, raw = this.raw;
    let turn = 0;
    for (let k = 0; k < this.wf; k++) {
      const j = t + this.lead - k;
      if (j >= 0 && j < raw.length) turn += raw[j][2] * w[k];
    }
    const [m0, m1, , label] = raw[t];
    this.t++;
    if (this.t > 200) { raw.splice(0, 100); this.t -= 100; }        // keep the buffer short
    return { theta: this.angles(m0, m1, turn), modes: [m0, m1, turn], label };
  }

  // eigenmodes -> 100 segment angles -> 101 points (segment 0.01) -> cubic resampling to 26 points -> 24 joint angles
  angles(m0, m1, m2) {
    const E = this.E, M = this.M;
    const px = new Float64Array(101), py = new Float64Array(101);
    for (let i = 0; i < 100; i++) {
      const a = E[i][0] * m0 + E[i][1] * m1 + E[i][2] * m2;
      px[i + 1] = px[i] - 0.01 * Math.cos(a);
      py[i + 1] = py[i] - 0.01 * Math.sin(a);
    }
    const qx = new Float64Array(26), qy = new Float64Array(26);
    for (let r = 0; r < 26; r++) {
      let sx = 0, sy = 0;
      const row = M[r];
      for (let j = 0; j < 101; j++) { sx += row[j] * px[j]; sy += row[j] * py[j]; }
      qx[r] = sx; qy[r] = sy;
    }
    const th = new Float64Array(24);
    for (let i = 0; i < 24; i++) {
      const x1 = qx[i] - qx[i + 1], y1 = qy[i] - qy[i + 1], x2 = qx[i + 2] - qx[i + 1], y2 = qy[i + 2] - qy[i + 1];
      const a = Math.atan2(x1 * y2 - y1 * x2, x1 * x2 + y1 * y2);
      th[i] = Math.sign(a) * (Math.PI - Math.abs(a));
    }
    return th;
  }
}

// ----------------------------------------------------------------------------------------------------------------- //
// elegansbot.Worm with the defaults of the paper's simulations: Worm(dt=0.00005, scale_friction=0.01)
export class Worm {
  constructor({ dt = 0.00005, n = 25, M = 2, L = 1, bT = 1.28e8, bII = 1.28e8 / 40, k = 1.75e5, c = 1.75e5 / 5.6,
                scaleFriction = 0.01, scaleMuscle = 1.0, angleInit = 0 } = {}) {
    this.dt = dt; this.n = n; this.M = M; this.L = L;
    this.m = M / n; this.r = L / (2 * n); this.I = (1 / 3) * this.m * this.r ** 2;
    this.bT = bT * scaleFriction; this.bII = bII * scaleFriction; this.k = k * scaleMuscle; this.c = c * scaleMuscle;
    this.angleInit = angleInit;
    const A = (len) => new Float64Array(len);
    this.s = A(n); this.omega = A(n); this.x = A(n); this.y = A(n); this.vx = A(n); this.vy = A(n);
    this.N2 = 2 * (n - 1);
    this.D = A(4 * this.N2); this.Q = A(this.N2);
    this.fx = A(n); this.fy = A(n); this.Fck0 = A(n); this.Fck1 = A(n); this.F0 = A(n - 1); this.F1 = A(n - 1);
    this.tau = A(n - 1); this.tauB = A(n); this.tauC = A(n); this.tauK = A(n); this.tauCK = A(n); this.tauJ = A(n);
    this.thetaCtrl = A(n - 1);
    this.cos = A(n); this.sin = A(n); this.theta = A(n - 1); this.omegaNext = A(n); this.u = A(n);
    this.IPinv = A(n * n);
    this.reset();
  }

  reset() {
    const { n, dt, bT, c, k, r, I } = this;
    this.i = 0; this.xc = 0; this.yc = 0; this.vxc = 0; this.vyc = 0;
    this.s.fill(this.angleInit + Math.PI); this.omega.fill(0);
    const P = new Float64Array(n * n), d = -(1 / 3) * (bT / n) * r * r;
    P[0] = d - c - k * dt; P[1] = c + k * dt;
    for (let j = 1; j < n - 1; j++) {
      P[j * n + j - 1] = c + k * dt; P[j * n + j] = d - 2 * c - 2 * k * dt; P[j * n + j + 1] = c + k * dt;
    }
    P[(n - 1) * n + n - 2] = c + k * dt; P[(n - 1) * n + n - 1] = d - c - k * dt;
    const A = new Float64Array(n * n);
    for (let i = 0; i < n * n; i++) A[i] = -P[i] * (dt / I);
    for (let i = 0; i < n; i++) A[i * n + i] += 1;
    this.IPinv.set(invert(A, n));
  }

  // initial body shape from a kymogram frame (Worm.theta setter; polarity_clockwise=False flips the sign)
  setTheta(kymo) {
    const n = this.n, s = this.s;
    let mean0 = 0;
    for (let j = 0; j < n; j++) mean0 += s[j];
    mean0 /= n;
    let acc = 0, mean1 = 0;
    const tmp = new Float64Array(n);
    for (let j = 0; j < n; j++) { if (j > 0) acc += -kymo[j - 1]; tmp[j] = acc; mean1 += acc; }
    mean1 /= n;
    for (let j = 0; j < n; j++) s[j] = tmp[j] - mean1 + mean0;
  }

  setControl(kymo) { for (let j = 0; j < this.n - 1; j++) this.thetaCtrl[j] = -kymo[j]; }

  // Worm.steps() for one kymogram frame: round(dt_snapshot / dt) steps
  advance(dtFrame) {
    const m = Math.round(dtFrame / this.dt);
    for (let j = 0; j < m; j++) this.step();
  }

  // xy_tip_log of the current state: 26 points (x, y), from tail to head
  tips(out = { x: new Float64Array(this.n + 1), y: new Float64Array(this.n + 1) }) {
    const { n, r, s } = this;
    out.x[0] = 0; out.y[0] = 0;
    for (let j = 0; j < n; j++) { out.x[j + 1] = out.x[j] + 2 * r * Math.cos(s[j]); out.y[j + 1] = out.y[j] + 2 * r * Math.sin(s[j]); }
    let mx = 0, my = 0;
    for (let j = 0; j < n; j++) { mx += (out.x[j + 1] + out.x[j]) / 2; my += (out.y[j + 1] + out.y[j]) / 2; }
    mx /= n; my /= n;
    for (let j = 0; j <= n; j++) { out.x[j] += -mx + this.xc; out.y[j] += -my + this.yc; }
    return out;
  }

  step() {
    const { n, r, dt, I, m, M, bT, bII, k, c, N2 } = this;
    const { s, omega, x, y, vx, vy, fx, fy, Fck0, Fck1, F0, F1, tau, tauB, tauC, tauK, tauCK, tauJ, thetaCtrl, D, Q,
            theta, omegaNext, u, IPinv } = this;
    let cs = this.cos, sn = this.sin;
    let { xc, yc, vxc, vyc } = this;

    const shift = Math.floor((s[0] + TWO_PI) / (2 * TWO_PI)) * TWO_PI;     // preventing overflow
    for (let j = 0; j < n; j++) s[j] -= shift;
    for (let j = 0; j < n - 1; j++) theta[j] = s[j + 1] - s[j];
    for (let j = 0; j < n; j++) { cs[j] = Math.cos(s[j]); sn[j] = Math.sin(s[j]); }

    // friction
    vx[0] = 0; vy[0] = 0;
    for (let j = 0; j < n - 1; j++) {
      vx[j + 1] = vx[j] - r * omega[j] * sn[j] - r * omega[j + 1] * sn[j + 1];
      vy[j + 1] = vy[j] + r * omega[j] * cs[j] + r * omega[j + 1] * cs[j + 1];
    }
    centre(vx, vxc); centre(vy, vyc);
    for (let j = 0; j < n; j++) {
      const vII = cs[j] * vx[j] + sn[j] * vy[j], vT = -sn[j] * vx[j] + cs[j] * vy[j];
      const fII = -(bII / n) * vII, fT = -(bT / n) * vT;
      fx[j] = cs[j] * fII - sn[j] * fT;
      fy[j] = sn[j] * fII + cs[j] * fT;
      tauB[j] = -(bT * r * r / 3 / n) * omega[j];
    }

    // muscle (damped torsion spring)
    tauC.fill(0); tauK.fill(0); Fck0.fill(0); Fck1.fill(0);
    for (let j = 0; j < n - 1; j++) {
      const tc = c * (omega[j + 1] - omega[j]), tk = k * (theta[j] - thetaCtrl[j]);
      tauC[j] += tc; tauC[j + 1] -= tc;
      tauK[j] += tk; tauK[j + 1] -= tk;
      tau[j] = tc + tk;
    }
    for (let j = 0; j < n; j++) tauCK[j] = tauC[j] + tauK[j];
    for (let j = 0; j < n - 1; j++) {
      const tmp = tau[j] * Math.sin(theta[j] / 2) / (r * Math.cos(theta[j] / 2) ** 2);
      const phi = (s[j + 1] + s[j]) / 2, tcp = tmp * Math.cos(phi), tsp = tmp * Math.sin(phi);
      Fck0[j] -= tcp; Fck1[j] -= tsp; Fck0[j + 1] += tcp; Fck1[j + 1] += tsp;
    }

    // chain dynamics: banded system D F = Q for the joint forces
    D.fill(0);
    let si = sn[0], ci = cs[0], sii = sn[1], cii = cs[1];
    D[0] = 3 * si * si + 3 * sii * sii + 2;
    D[N2] = -3 * si * ci - 3 * sii * cii;
    D[1] = 3 * ci * ci + 3 * cii * cii + 2;
    const q = (j) => {
      const a = tauB[j] + tauCK[j], b = tauB[j + 1] + tauCK[j + 1];
      Q[2 * j] = -fx[j] - Fck0[j] + fx[j + 1] + Fck0[j + 1] - (3 / r) * (a * -si + b * -sii) +
                 m * r * (omega[j] ** 2 * ci + omega[j + 1] ** 2 * cii);
      Q[2 * j + 1] = -fy[j] - Fck1[j] + fy[j + 1] + Fck1[j + 1] - (3 / r) * (a * ci + b * cii) +
                     m * r * (omega[j] ** 2 * si + omega[j + 1] ** 2 * sii);
    };
    q(0);
    for (let j = 1; j < n - 1; j++) {
      si = sii; ci = cii; sii = sn[j + 1]; cii = cs[j + 1];
      D[2 * N2 + 2 * j - 2] = 3 * si * si - 1;
      D[3 * N2 + 2 * j - 2] = -3 * si * ci;
      D[N2 + 2 * j - 1] = -3 * si * ci;
      D[2 * N2 + 2 * j - 1] = 3 * ci * ci - 1;
      D[2 * j] = 3 * si * si + 3 * sii * sii + 2;
      D[N2 + 2 * j] = -3 * si * ci - 3 * sii * cii;
      D[2 * j + 1] = 3 * ci * ci + 3 * cii * cii + 2;
      q(j);
    }
    cholSolverBanded(D, Q, N2);
    for (let j = 0; j < n - 1; j++) { F0[j] = Q[2 * j]; F1[j] = Q[2 * j + 1]; }
    tauJ.fill(0);
    for (let j = 0; j < n - 1; j++) {
      tauJ[j] += r * (-sn[j] * F0[j] + cs[j] * F1[j]);
      tauJ[j + 1] += -r * (-sn[j + 1] * -F0[j] + cs[j + 1] * -F1[j]);
    }

    // correction
    positions(x, y, cs, sn, r, n, xc, yc);
    let Ibody = 0, tauBody = 0, Lbody = 0;
    for (let j = 0; j < n; j++) {
      const xb = x[j] - xc, yb = y[j] - yc;
      Ibody += xb * xb + yb * yb; tauBody += xb * fy[j] - yb * fx[j]; Lbody += xb * vy[j] - yb * vx[j];
    }
    Ibody = m * Ibody + I * n; tauBody /= 1 + bT * dt / M; Lbody *= m;

    for (let j = 0; j < n; j++) u[j] = omega[j] + (dt / I) * (tauK[j] + tauJ[j]);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let j = 0; j < n; j++) acc += IPinv[i * n + j] * u[j];
      omegaNext[i] = acc;
    }

    let sfx = 0, sfy = 0;
    for (let j = 0; j < n; j++) { sfx += fx[j]; sfy += fy[j]; }
    vxc += sfx / M / (1 + bT * dt / M) * dt;
    vyc += sfy / M / (1 + bT * dt / M) * dt;
    xc += vxc * dt; yc += vyc * dt;

    for (let j = 0; j < n; j++) { const sNext = s[j] + omegaNext[j] * dt; cs[j] = Math.cos(sNext); sn[j] = Math.sin(sNext); }
    positions(x, y, cs, sn, r, n, xc, yc);
    vx[0] = 0; vy[0] = 0;
    for (let j = 0; j < n - 1; j++) {
      vx[j + 1] = vx[j] - r * omegaNext[j] * sn[j] - r * omegaNext[j + 1] * sn[j + 1];
      vy[j + 1] = vy[j] + r * omegaNext[j] * cs[j] + r * omegaNext[j + 1] * cs[j + 1];
    }
    centre(vx, vxc); centre(vy, vyc);
    let IbodyNext = 0, LbodyNext = 0;
    for (let j = 0; j < n; j++) {
      const xb = x[j] - xc, yb = y[j] - yc;
      IbodyNext += xb * xb + yb * yb; LbodyNext += xb * vy[j] - yb * vx[j];
    }
    IbodyNext = m * IbodyNext + I * n; LbodyNext *= m;

    const Imean = (IbodyNext + Ibody) / 2;
    for (let j = 0; j < n; j++) {
      omega[j] = omegaNext[j] + (-(LbodyNext - Lbody) + tauBody * dt) / Imean;
      s[j] += omega[j] * dt;
    }
    this.xc = xc; this.yc = yc; this.vxc = vxc; this.vyc = vyc;
    this.i++;
  }
}

function centre(v, c) {
  let mean = 0;
  for (let j = 0; j < v.length; j++) mean += v[j];
  mean /= v.length;
  for (let j = 0; j < v.length; j++) v[j] += -mean + c;
}

function positions(x, y, cs, sn, r, n, xc, yc) {
  x[0] = 0; y[0] = 0;
  for (let j = 0; j < n - 1; j++) { x[j + 1] = x[j] + r * cs[j] + r * cs[j + 1]; y[j + 1] = y[j] + r * sn[j] + r * sn[j + 1]; }
  centre(x, xc); centre(y, yc);
}

// cholSolver_banded: A (4 x N2, row-major) holds the lower bands of a symmetric matrix; solves A x = b in place
function cholSolverBanded(A, b, N2) {
  const n = N2 / 2;
  const a = (r, c) => A[r * N2 + c];
  const set = (r, c, v) => { A[r * N2 + c] = v; };
  set(0, 0, Math.sqrt(a(0, 0)));
  set(1, 0, a(1, 0) / a(0, 0));
  set(0, 1, Math.sqrt(a(0, 1) - a(1, 0) ** 2));
  for (let i = 0; i < n - 1; i++) {
    const k = 2 * i;
    set(2, k, a(2, k) / a(0, k));
    set(1, k + 1, (a(1, k + 1) - a(2, k) * a(1, k)) / a(0, k + 1));
    set(0, k + 2, Math.sqrt(a(0, k + 2) - a(2, k) ** 2 - a(1, k + 1) ** 2));
    set(3, k, a(3, k) / a(0, k));
    set(2, k + 1, (a(2, k + 1) - a(3, k) * a(1, k)) / a(0, k + 1));
    set(1, k + 2, (a(1, k + 2) - a(3, k) * a(2, k) - a(2, k + 1) * a(1, k + 1)) / a(0, k + 2));
    set(0, k + 3, Math.sqrt(a(0, k + 3) - a(3, k) ** 2 - a(2, k + 1) ** 2 - a(1, k + 2) ** 2));
  }
  b[0] /= a(0, 0);
  b[1] = (b[1] - a(1, 0) * b[0]) / a(0, 1);
  for (let i = 0; i < n - 1; i++) {
    const k = 2 * i;
    b[k + 2] = (b[k + 2] - a(2, k) * b[k] - a(1, k + 1) * b[k + 1]) / a(0, k + 2);
    b[k + 3] = (b[k + 3] - a(3, k) * b[k] - a(2, k + 1) * b[k + 1] - a(1, k + 2) * b[k + 2]) / a(0, k + 3);
  }
  const L = N2;
  b[L - 1] /= a(0, L - 1);
  b[L - 2] = (b[L - 2] - a(1, L - 2) * b[L - 1]) / a(0, L - 2);
  for (let i = 0; i < n - 1; i++) {
    const k = 2 * i;
    b[L - 3 - k] = (b[L - 3 - k] - a(2, L - 3 - k) * b[L - 1 - k] - a(1, L - 3 - k) * b[L - 2 - k]) / a(0, L - 3 - k);
    b[L - 4 - k] = (b[L - 4 - k] - a(3, L - 4 - k) * b[L - 1 - k] - a(2, L - 4 - k) * b[L - 2 - k] -
                    a(1, L - 4 - k) * b[L - 3 - k]) / a(0, L - 4 - k);
  }
  return b;
}

// Gauss-Jordan inverse with partial pivoting (np.linalg.inv of the 25 x 25 implicit-step matrix, once per reset)
function invert(A0, n) {
  const A = Float64Array.from(A0), B = new Float64Array(n * n);
  for (let i = 0; i < n; i++) B[i * n + i] = 1;
  for (let col = 0; col < n; col++) {
    let p = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r * n + col]) > Math.abs(A[p * n + col])) p = r;
    if (p !== col) for (let j = 0; j < n; j++) {
      [A[col * n + j], A[p * n + j]] = [A[p * n + j], A[col * n + j]];
      [B[col * n + j], B[p * n + j]] = [B[p * n + j], B[col * n + j]];
    }
    const d = A[col * n + col];
    for (let j = 0; j < n; j++) { A[col * n + j] /= d; B[col * n + j] /= d; }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r * n + col];
      if (f === 0) continue;
      for (let j = 0; j < n; j++) { A[r * n + j] -= f * A[col * n + j]; B[r * n + j] -= f * B[col * n + j]; }
    }
  }
  return B;
}
