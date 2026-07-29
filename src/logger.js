'use strict';

/*
 * Log de acesso e de eventos de autenticação.
 *
 * Sai no terminal e, em paralelo, num arquivo por dia em data/logs. Sem
 * dependência nova: é um middleware pequeno em vez de morgan/winston, no mesmo
 * espírito do resto do projeto.
 *
 * Configuração (.env):
 *   LOG_REQUESTS = all | api | off   (padrão: all — 'api' ignora as páginas)
 *   LOG_STATIC   = 1                 (padrão: desligado; css/js/png poluem)
 *   LOG_DIR      = caminho           (padrão: data/logs)
 *   LOG_FILE     = 0                 (só terminal, sem arquivo)
 *   LOG_AUTH     = 0                 (silencia login/logout/negados)
 *
 * O que NUNCA entra no log: corpo das requisições, senhas, tokens e cookies.
 */

const fs = require('fs');
const path = require('path');

const MODO = (process.env.LOG_REQUESTS || 'all').toLowerCase();      // all | api | off
// Eventos de auth são a parte mais útil do log: seguem ligados mesmo com
// LOG_REQUESTS=off (quem só quer parar o barulho das requisições).
const LOG_AUTH = process.env.LOG_AUTH !== '0';
const LOG_STATIC = process.env.LOG_STATIC === '1';
const ESCREVE_ARQUIVO = process.env.LOG_FILE !== '0';
const DIR = process.env.LOG_DIR || path.join(__dirname, '..', 'data', 'logs');

/* Extensões de arquivo estático — fora do log por padrão, senão cada página
   vira dez linhas de css/js/svg e o que interessa some no meio. */
const ESTATICO = /\.(css|js|map|png|jpe?g|svg|ico|woff2?|ttf|webp|gif)$/i;

const pad = (n) => String(n).padStart(2, '0');
function carimbo(d = new Date()) {
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const diaArquivo = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

let arquivoAtual = null;
let stream = null;
function escreverArquivo(linha) {
  if (!ESCREVE_ARQUIVO) return;
  try {
    const dia = diaArquivo();
    if (arquivoAtual !== dia) {           // vira o arquivo à meia-noite
      if (stream) stream.end();
      fs.mkdirSync(DIR, { recursive: true });
      stream = fs.createWriteStream(path.join(DIR, `app-${dia}.log`), { flags: 'a' });
      arquivoAtual = dia;
    }
    stream.write(`${new Date().toISOString()} ${linha}\n`);
  } catch (err) {
    // Log nunca pode derrubar a aplicação.
    if (!escreverArquivo._avisou) {
      console.warn('[log] não foi possível gravar em arquivo:', err.message);
      escreverArquivo._avisou = true;
    }
  }
}

// Neutraliza log injection (CWE-117): valores derivados do usuário (e-mail de
// login, URL) podem trazer CR/LF/controle e forjar linhas. Tira tudo isso e
// limita o tamanho, num único ponto por onde toda linha passa.
function saneia(linha) {
  return String(linha == null ? '' : linha).replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').slice(0, 2000);
}

function registrar(linha) {
  const s = saneia(linha);
  console.log(`[${carimbo()}] ${s}`);
  escreverArquivo(s);
}

/** IP do cliente, respeitando proxy reverso quando houver. */
function ipDe(req) {
  const fwd = req.headers['x-forwarded-for'];
  const ip = (fwd ? String(fwd).split(',')[0] : req.socket && req.socket.remoteAddress) || '-';
  return ip.replace(/^::ffff:/, '').replace(/^::1$/, 'local');
}

/*
 * Cache id -> {name,email} para conseguir mostrar QUEM acessou também nas
 * páginas (onde não passa o attachUser da API) sem uma consulta por requisição.
 * Quem preenche são o login e as chamadas de API; num miss a busca é disparada
 * em segundo plano e a próxima linha já sai com o nome.
 */
const usuarios = new Map();
const buscando = new Set();
function lembrarUsuario(u) {
  if (u && u._id) usuarios.set(String(u._id), { name: u.name, email: u.email });
}
function esquecerUsuario(id) { usuarios.delete(String(id)); }

function quem(req) {
  if (req.user) { lembrarUsuario(req.user); return req.user.email || req.user.name; }
  const id = req._sessionUserId;
  if (!id) return '-';
  const achado = usuarios.get(String(id));
  if (achado) return achado.email || achado.name;
  if (!buscando.has(String(id))) {         // aquece o cache para a próxima
    buscando.add(String(id));
    Promise.resolve()
      .then(() => require('./models').User.findById(id).select('name email').lean())
      .then((u) => { if (u) lembrarUsuario({ _id: id, ...u }); })
      .catch(() => {})
      .finally(() => buscando.delete(String(id)));
  }
  return `id:${String(id).slice(-6)}`;
}

/** Middleware de acesso: uma linha por requisição, com status e duração. */
function requestLogger(sessionUserId) {
  return (req, res, next) => {
    if (MODO === 'off') return next();
    const ehApi = req.path.startsWith('/api');
    if (MODO === 'api' && !ehApi) return next();
    if (!LOG_STATIC && ESTATICO.test(req.path)) return next();

    // Guarda o id da sessão (sem ir ao banco) para o `quem()` resolver depois.
    try { req._sessionUserId = sessionUserId(req); } catch (e) { req._sessionUserId = null; }

    const t0 = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - t0;
      const st = res.statusCode;
      const marca = st >= 500 ? '!!' : st >= 400 ? ' !' : '  ';
      registrar(
        `${marca}${st} ${req.method.padEnd(6)} ${req.originalUrl.split('?')[0].padEnd(38)} `
        + `${String(ms + 'ms').padStart(7)}  ${quem(req)}  ${ipDe(req)}`
      );
    });
    next();
  };
}

/* ── Eventos de autenticação e autorização ───────────────────────────────── */
const evento = (linha) => { if (LOG_AUTH) registrar(linha); };
const auth = {
  login: (req, email, ok, motivo) => evento(
    `AUTH  ${ok ? 'login OK   ' : 'login FALHA'}  ${email || '-'}  ${ipDe(req)}${ok || !motivo ? '' : `  (${motivo})`}`
  ),
  logout: (req, user) => evento(`AUTH  logout      ${(user && user.email) || '-'}  ${ipDe(req)}`),
  setup: (req, user) => evento(`AUTH  1º admin    ${(user && user.email) || '-'}  ${ipDe(req)}`),
  negado: (req, motivo) => evento(
    `AUTH  negado      ${quem(req)}  ${req.method} ${req.originalUrl.split('?')[0]}  (${motivo})  ${ipDe(req)}`
  ),
};

/** Resumo da configuração, mostrado no start. */
function resumo() {
  if (MODO === 'off') return `requisições: não (LOG_REQUESTS=off) · auth: ${LOG_AUTH ? 'sim' : 'não'}`;
  const onde = ESCREVE_ARQUIVO ? `terminal + ${path.relative(path.join(__dirname, '..'), DIR)}/app-AAAA-MM-DD.log` : 'só terminal';
  return `log de acesso: ${MODO === 'api' ? 'somente /api' : 'páginas e /api'} · ${onde}`;
}

module.exports = { requestLogger, auth, registrar, lembrarUsuario, esquecerUsuario, resumo };
