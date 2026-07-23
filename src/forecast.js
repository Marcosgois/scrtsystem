'use strict';

/**
 * Projeção de consumo (capacity planning) por dois métodos:
 *
 *  - `linear`: regressão linear por mínimos quadrados sobre o índice do mês,
 *    com intervalo de predição clássico (cresce ao se afastar da média).
 *  - `sarima`: SARIMA(p,d,q)(P,D,Q)[12] estimado por soma de quadrados
 *    condicional (CSS) com Nelder-Mead, escolhendo a ordem por AICc.
 *
 * A sazonalidade só é estimada com histórico suficiente: com menos de dois
 * ciclos completos os termos sazonais não são identificáveis, então são
 * desligados e o fato é reportado em `notes` — projeção apresentada a cliente
 * não pode carregar precisão que os dados não sustentam.
 */

const PT_MONTH_ABBR = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

const SEASON = 12;
const MIN_FOR_SEASONAL = 24; // dois ciclos completos
const MIN_FOR_SARIMA = 6;
const MIN_FOR_LINEAR = 3;

/** "2026-06" + 3 -> "2026-09" */
function addMonths(periodKey, n) {
  const [y, m] = periodKey.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  const year = Math.floor(idx / 12);
  const month = idx % 12;
  return { periodKey: `${year}-${String(month + 1).padStart(2, '0')}`, label: `${PT_MONTH_ABBR[month]}/${year}`, year };
}

/* ── Álgebra de polinômios em B ─────────────────────────────────────────────
   Convenção: polinômio [1, a1, a2, …] representa (1 + a1·B + a2·B² + …).
   O modelo é A(B)·y_t = M(B)·ε_t. */

function polyMul(a, b) {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
  }
  return out;
}

/** [φ1, φ2] -> [1, -φ1, -φ2] (AR) ou [θ1] -> [1, θ1] (MA). */
function toPoly(coefs, isAr) {
  return [1, ...coefs.map((c) => (isAr ? -c : c))];
}

/** Coeficientes sazonais viram potências de B^s. */
function toSeasonalPoly(coefs, s, isAr) {
  const out = [1];
  for (let k = 0; k < coefs.length; k++) {
    const pos = (k + 1) * s;
    while (out.length <= pos) out.push(0);
    out[pos] = isAr ? -coefs[k] : coefs[k];
  }
  return out;
}

/** (1 - B)^d  e  (1 - B^s)^D */
function differencePoly(d, s, D) {
  let p = [1];
  for (let i = 0; i < d; i++) p = polyMul(p, [1, -1]);
  const seas = [1];
  while (seas.length <= s) seas.push(0);
  seas[s] = -1;
  for (let i = 0; i < D; i++) p = polyMul(p, seas);
  return p;
}

/** Diferencia a série: lag 1 (d vezes) e lag s (D vezes). */
function differenceSeries(values, d, s, D) {
  let w = values.slice();
  for (let i = 0; i < D; i++) w = w.slice(s).map((v, k) => v - w[k]);
  for (let i = 0; i < d; i++) w = w.slice(1).map((v, k) => v - w[k]);
  return w;
}

/** Resíduos por soma de quadrados condicional. */
function cssResiduals(w, arPoly, maPoly) {
  const n = w.length;
  const eps = new Array(n).fill(0);
  const p = arPoly.length - 1;
  const q = maPoly.length - 1;
  const start = Math.max(p, q);
  for (let t = start; t < n; t++) {
    let v = w[t];
    for (let i = 1; i <= p; i++) v += arPoly[i] * w[t - i];
    for (let j = 1; j <= q; j++) v -= maPoly[j] * eps[t - j];
    eps[t] = v;
  }
  return { eps, start };
}

/** Estacionaridade/invertibilidade: raízes de A(B) fora do círculo unitário. */
function isStable(poly) {
  const deg = poly.length - 1;
  if (deg === 0) return true;
  // Companion matrix de y_t = -a1 y_{t-1} - … ; autovalores por iteração de potência
  // é impreciso; para as ordens pequenas usadas aqui, testa |A(z)| em z do círculo.
  const steps = 64;
  for (let k = 0; k < steps; k++) {
    const th = (2 * Math.PI * k) / steps;
    let re = 0;
    let im = 0;
    for (let i = 0; i <= deg; i++) {
      re += poly[i] * Math.cos(i * th);
      im += poly[i] * Math.sin(i * th);
    }
    if (Math.hypot(re, im) < 1e-6) return false; // raiz sobre o círculo unitário
  }
  // Soma dos coeficientes ≈ raiz unitária em z=1
  const sum = poly.reduce((a, b) => a + b, 0);
  return Math.abs(sum) > 1e-8;
}

/** Nelder-Mead (sem dependências externas). */
function nelderMead(fn, x0, { maxIter = 800, tol = 1e-8 } = {}) {
  const n = x0.length;
  if (n === 0) return { x: [], fx: fn([]) };
  const alpha = 1;
  const gamma = 2;
  const rho = 0.5;
  const sigma = 0.5;

  let simplex = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const x = x0.slice();
    x[i] += x[i] !== 0 ? 0.1 * Math.abs(x[i]) : 0.1;
    simplex.push(x);
  }
  let fvals = simplex.map(fn);

  for (let iter = 0; iter < maxIter; iter++) {
    const order = fvals.map((f, i) => i).sort((a, b) => fvals[a] - fvals[b]);
    simplex = order.map((i) => simplex[i]);
    fvals = order.map((i) => fvals[i]);
    if (Math.abs(fvals[n] - fvals[0]) < tol) break;

    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) centroid[j] += simplex[i][j] / n;
    }
    const worst = simplex[n];
    const reflected = centroid.map((c, j) => c + alpha * (c - worst[j]));
    const fr = fn(reflected);

    if (fr < fvals[0]) {
      const expanded = centroid.map((c, j) => c + gamma * (reflected[j] - c));
      const fe = fn(expanded);
      if (fe < fr) { simplex[n] = expanded; fvals[n] = fe; } else { simplex[n] = reflected; fvals[n] = fr; }
    } else if (fr < fvals[n - 1]) {
      simplex[n] = reflected; fvals[n] = fr;
    } else {
      const contracted = centroid.map((c, j) => c + rho * (worst[j] - c));
      const fc = fn(contracted);
      if (fc < fvals[n]) { simplex[n] = contracted; fvals[n] = fc; }
      else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[0].map((v, j) => v + sigma * (simplex[i][j] - v));
          fvals[i] = fn(simplex[i]);
        }
      }
    }
  }
  const best = fvals.map((f, i) => i).reduce((a, b) => (fvals[a] <= fvals[b] ? a : b));
  return { x: simplex[best], fx: fvals[best] };
}

/** Ajusta uma ordem específica por CSS; devolve coeficientes, σ² e AICc. */
function fitOrder(values, { p, d, q, P, D, Q }, s) {
  const w = differenceSeries(values, d, s, D);
  const k = p + q + P + Q;
  if (w.length < k + 3) return null;

  const objective = (params) => {
    const phi = params.slice(0, p);
    const theta = params.slice(p, p + q);
    const Phi = params.slice(p + q, p + q + P);
    const Theta = params.slice(p + q + P, k);
    const arPoly = polyMul(toPoly(phi, true), toSeasonalPoly(Phi, s, true));
    const maPoly = polyMul(toPoly(theta, false), toSeasonalPoly(Theta, s, false));
    if (!isStable(arPoly) || !isStable(maPoly)) return 1e12;
    const { eps, start } = cssResiduals(w, arPoly, maPoly);
    let sse = 0;
    let n = 0;
    for (let t = start; t < eps.length; t++) { sse += eps[t] * eps[t]; n++; }
    if (n <= 0 || !Number.isFinite(sse)) return 1e12;
    return sse;
  };

  const start = new Array(k).fill(0.1);
  const { x, fx } = k > 0 ? nelderMead(objective, start) : { x: [], fx: objective([]) };
  if (!Number.isFinite(fx) || fx >= 1e12) return null;

  const phi = x.slice(0, p);
  const theta = x.slice(p, p + q);
  const Phi = x.slice(p + q, p + q + P);
  const Theta = x.slice(p + q + P, k);
  const arPoly = polyMul(toPoly(phi, true), toSeasonalPoly(Phi, s, true));
  const maPoly = polyMul(toPoly(theta, false), toSeasonalPoly(Theta, s, false));
  const { eps, start: st } = cssResiduals(w, arPoly, maPoly);
  const nEff = eps.length - st;
  if (nEff < k + 2) return null;
  const sigma2 = fx / nEff;
  if (!(sigma2 > 0)) return null;

  const kk = k + 1; // + variância
  const aic = nEff * Math.log(sigma2) + 2 * kk;
  const aicc = nEff - kk - 1 > 0 ? aic + (2 * kk * (kk + 1)) / (nEff - kk - 1) : Infinity;

  return { order: { p, d, q, P, D, Q }, phi, theta, Phi, Theta, arPoly, maPoly, sigma2, aicc, nEff, residuals: eps.slice(st) };
}

/** Projeta h passos à frente usando o polinômio AR completo (com diferenciação). */
function sarimaPredict(values, fit, s, h) {
  const arFull = polyMul(fit.arPoly, differencePoly(fit.order.d, s, fit.order.D));
  const ma = fit.maPoly;
  const pFull = arFull.length - 1;
  const q = ma.length - 1;

  // Resíduos alinhados ao fim da série (aproximação: zeros no passado remoto).
  const eps = new Array(values.length).fill(0);
  const resid = fit.residuals;
  for (let i = 0; i < resid.length; i++) eps[values.length - resid.length + i] = resid[i];

  const y = values.slice();
  const e = eps.slice();
  const preds = [];
  for (let step = 1; step <= h; step++) {
    const t = y.length;
    let v = 0;
    for (let i = 1; i <= pFull; i++) v -= arFull[i] * y[t - i];
    for (let j = 1; j <= q; j++) {
      const idx = t - j;
      v += ma[j] * (idx < e.length ? e[idx] : 0);
    }
    y.push(v);
    e.push(0);
    preds.push(v);
  }

  // Pesos psi (MA(∞)) para o intervalo de predição.
  const psi = [1];
  for (let j = 1; j < h; j++) {
    let v = j <= q ? ma[j] : 0;
    for (let i = 1; i <= Math.min(j, pFull); i++) v -= arFull[i] * psi[j - i];
    psi.push(v);
  }
  const se = [];
  let acc = 0;
  for (let j = 0; j < h; j++) {
    acc += psi[j] * psi[j];
    se.push(Math.sqrt(fit.sigma2 * acc));
  }
  return { preds, se };
}

/** Projeção por regressão linear com intervalo de predição. */
function linearForecast(values, h) {
  const n = values.length;
  const xs = values.map((_, i) => i + 1);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - meanX) * (values[i] - meanY);
    sxx += (xs[i] - meanX) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = meanY - slope * meanX;

  const fitted = xs.map((x) => intercept + slope * x);
  const sse = values.reduce((a, v, i) => a + (v - fitted[i]) ** 2, 0);
  const dof = Math.max(1, n - 2);
  const sigma = Math.sqrt(sse / dof);

  const preds = [];
  const se = [];
  for (let k = 1; k <= h; k++) {
    const x = n + k;
    preds.push(intercept + slope * x);
    // Erro de predição: ruído + incerteza da reta naquele ponto.
    const varPred = sigma ** 2 * (1 + 1 / n + (sxx === 0 ? 0 : ((x - meanX) ** 2) / sxx));
    se.push(Math.sqrt(varPred));
  }
  return {
    preds,
    se,
    model: { method: 'linear', slope, intercept, sigma, r2: r2Of(values, fitted) },
  };
}

function r2Of(values, fitted) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const ssTot = values.reduce((a, v) => a + (v - mean) ** 2, 0);
  const ssRes = values.reduce((a, v, i) => a + (v - fitted[i]) ** 2, 0);
  return ssTot === 0 ? null : 1 - ssRes / ssTot;
}

/** Busca a melhor ordem SARIMA por AICc dentro de uma grade pequena. */
function fitSarima(values, { seasonal }) {
  const s = SEASON;
  const grid = [];
  const dMax = 1;
  const DMax = seasonal ? 1 : 0;
  const PQMax = seasonal ? 1 : 0;
  for (let d = 0; d <= dMax; d++) {
    for (let D = 0; D <= DMax; D++) {
      for (let p = 0; p <= 2; p++) {
        for (let q = 0; q <= 2; q++) {
          for (let P = 0; P <= PQMax; P++) {
            for (let Q = 0; Q <= PQMax; Q++) {
              if (p + q + P + Q === 0 && d + D === 0) continue; // modelo vazio
              grid.push({ p, d, q, P, D, Q });
            }
          }
        }
      }
    }
  }

  let best = null;
  for (const order of grid) {
    const fit = fitOrder(values, order, s);
    if (fit && Number.isFinite(fit.aicc) && (!best || fit.aicc < best.aicc)) best = fit;
  }
  return best;
}

/**
 * Projeta a série mensal.
 * @param {Array<{periodKey:string,totalMsuConsumed:number}>} history ordenada por mês
 * @param {{method:'linear'|'sarima', months:number}} opts
 */
function forecast(history, { method = 'linear', months = 12 } = {}) {
  const notes = [];
  const clean = history.filter((h) => Number.isFinite(h.totalMsuConsumed));
  const values = clean.map((h) => h.totalMsuConsumed);
  const n = values.length;

  if (n < MIN_FOR_LINEAR) {
    const err = new Error(`São necessários pelo menos ${MIN_FOR_LINEAR} meses de histórico para projetar (há ${n}).`);
    err.status = 422;
    throw err;
  }

  // Meses ausentes no meio da série distorcem a sazonalidade; avisa.
  const firstKey = clean[0].periodKey;
  const expected = clean.length;
  const spanMonths = (() => {
    const [y1, m1] = firstKey.split('-').map(Number);
    const [y2, m2] = clean[clean.length - 1].periodKey.split('-').map(Number);
    return (y2 * 12 + m2) - (y1 * 12 + m1) + 1;
  })();
  if (spanMonths !== expected) {
    notes.push(`O histórico tem ${expected} meses num intervalo de ${spanMonths} — há meses sem SCRT, o que reduz a precisão da projeção.`);
  }

  let result;
  let usedMethod = method;

  if (method === 'sarima') {
    if (n < MIN_FOR_SARIMA) {
      notes.push(`SARIMA precisa de pelo menos ${MIN_FOR_SARIMA} meses (há ${n}); usada a regressão linear.`);
      usedMethod = 'linear';
    } else {
      const seasonal = n >= MIN_FOR_SEASONAL;
      if (!seasonal) {
        notes.push(
          `Sazonalidade não estimada: são necessários ${MIN_FOR_SEASONAL} meses (dois ciclos anuais) e há ${n}. ` +
          'O modelo usado é um ARIMA não sazonal — a projeção capta a tendência, não o padrão sazonal.'
        );
      }
      const fit = fitSarima(values, { seasonal });
      if (!fit) {
        notes.push('Não foi possível ajustar um SARIMA a esta série; usada a regressão linear.');
        usedMethod = 'linear';
      } else {
        const { preds, se } = sarimaPredict(values, fit, SEASON, months);
        const { p, d, q, P, D, Q } = fit.order;
        result = {
          preds,
          se,
          model: {
            method: 'sarima',
            order: seasonal ? `SARIMA(${p},${d},${q})(${P},${D},${Q})[${SEASON}]` : `ARIMA(${p},${d},${q})`,
            p, d, q, P, D, Q,
            seasonal,
            aicc: fit.aicc,
            sigma: Math.sqrt(fit.sigma2),
            observationsUsed: fit.nEff,
          },
        };
      }
    }
  }

  if (!result) result = linearForecast(values, months);

  // z = 1,96 (95%); o piso em zero evita projeção negativa de consumo.
  const z = 1.96;
  const lastKey = clean[clean.length - 1].periodKey;
  const points = result.preds.map((v, i) => {
    const { periodKey, label, year } = addMonths(lastKey, i + 1);
    const margin = z * result.se[i];
    return {
      periodKey,
      periodLabel: label,
      year,
      value: Math.max(0, Math.round(v)),
      lower: Math.max(0, Math.round(v - margin)),
      upper: Math.max(0, Math.round(v + margin)),
    };
  });

  return { method: usedMethod, requestedMethod: method, model: result.model, points, notes };
}

module.exports = {
  forecast,
  linearForecast,
  fitSarima,
  sarimaPredict,
  differenceSeries,
  polyMul,
  addMonths,
  SEASON,
  MIN_FOR_SEASONAL,
  MIN_FOR_SARIMA,
};
