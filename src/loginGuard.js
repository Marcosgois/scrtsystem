'use strict';

/*
 * Limite de tentativas de login, em memória. Trava por e-mail e por IP após
 * muitas falhas seguidas, contendo força-bruta e credential-stuffing sem
 * dependência nova. Num cenário multi-processo, migrar para um store compartilhado.
 */

const MAX = Number(process.env.LOGIN_MAX_TENTATIVAS) || 8; // falhas até travar
const JANELA_MS = 15 * 60 * 1000;                          // janela de contagem das falhas
const LOCK_MS = 15 * 60 * 1000;                            // duração da trava
const TETO = 20000;                                        // teto de chaves guardadas

const falhas = new Map(); // chave -> { n, t0, ate }

const travado = (chave) => { const e = falhas.get(chave); return !!(e && e.ate && Date.now() < e.ate); };
const bloqueado = (...chaves) => chaves.some(travado);

function registrarFalha(...chaves) {
  const now = Date.now();
  for (const chave of chaves) {
    let e = falhas.get(chave);
    if (!e || (now - e.t0 > JANELA_MS && (!e.ate || now > e.ate))) e = { n: 0, t0: now, ate: 0 };
    e.n++;
    if (e.n >= MAX) e.ate = now + LOCK_MS;
    falhas.set(chave, e);
  }
  if (falhas.size > TETO) prune(now);
}

function limpar(...chaves) { for (const c of chaves) falhas.delete(c); }

function prune(now = Date.now()) {
  for (const [k, e] of falhas) if ((!e.ate || now > e.ate) && now - e.t0 > JANELA_MS) falhas.delete(k);
}

/** Segundos restantes de trava (para a mensagem); 0 se livre. */
function restanteSeg(...chaves) {
  const now = Date.now();
  let max = 0;
  for (const c of chaves) { const e = falhas.get(c); if (e && e.ate && e.ate > now) max = Math.max(max, Math.ceil((e.ate - now) / 1000)); }
  return max;
}

// Limpeza periódica que não segura o event loop (importante para os testes).
const timer = setInterval(() => prune(), JANELA_MS);
if (timer && timer.unref) timer.unref();

module.exports = { bloqueado, registrarFalha, limpar, restanteSeg, MAX, _falhas: falhas };
