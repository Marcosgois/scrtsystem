'use strict';

/*
 * Trilha de auditoria. Duas entradas:
 *
 *  - middleware: captura AUTOMATICAMENTE toda mutação de /api (POST/PUT/PATCH/
 *    DELETE) bem-sucedida. Para as entidades-documento (cliente, máquina, site,
 *    LPAR, contrato, migração, relatório, usuário) ele lê o "antes" da mudança,
 *    compara com o "depois" e grava o diff campo a campo. Para o resto (upload de
 *    inventário, MLC, vínculos…) grava o que a pessoa enviou.
 *
 *  - event(): grava um evento pontual (login, logout, acesso negado, setup).
 *
 * NADA de senha/token entra no log: sanitizeDoc remove os campos sensíveis e
 * resume os campos grandes (config .txt/.cfr, lista de produtos, etc.).
 */

const { AuditLog, Client, InfraMachine, InfraSite, InfraLpar, Contract, MigrationEvent, ScrtReport, User } = require('./models');

// ── IP real do visitante (atrás do Cloudflare/nginx vem em X-Forwarded-For) ──
function ipDe(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0].trim() : req.socket && req.socket.remoteAddress) || '-';
}

// ── Resolução da entidade a partir do caminho ──
// "fina" = tem model + id → dá para ler o antes/depois e fazer diff.
const FINA = [
  [/^\/clients\/([a-f0-9]{24})$/i, 'Client', Client],
  [/^\/clients\/[a-f0-9]{24}\/infra\/machines\/([a-f0-9]{24})/i, 'InfraMachine', InfraMachine],
  [/^\/clients\/[a-f0-9]{24}\/infra\/sites\/([a-f0-9]{24})/i, 'InfraSite', InfraSite],
  [/^\/clients\/[a-f0-9]{24}\/infra\/lpars\/([a-f0-9]{24})/i, 'InfraLpar', InfraLpar],
  [/^\/clients\/[a-f0-9]{24}\/contracts\/([a-f0-9]{24})$/i, 'Contract', Contract],
  [/^\/clients\/[a-f0-9]{24}\/migrations\/([a-f0-9]{24})/i, 'MigrationEvent', MigrationEvent],
  [/^\/reports\/([a-f0-9]{24})/i, 'ScrtReport', ScrtReport],
  [/^\/admin\/users\/([a-f0-9]{24})/i, 'User', User],
];
// "grossa" = só o tipo (sub-recurso, blob, criação). Sem diff, guarda o payload.
const GROSSA = [
  [/^\/clients\/[a-f0-9]{24}\/inventory/i, 'Inventory'],
  [/^\/clients\/[a-f0-9]{24}\/mlc/i, 'MLC'],
  [/^\/clients\/[a-f0-9]{24}\/machine-tags/i, 'Tags'],
  [/^\/clients\/[a-f0-9]{24}\/infra\/machines/i, 'InfraMachine'],
  [/^\/clients\/[a-f0-9]{24}\/infra\/sites/i, 'InfraSite'],
  [/^\/clients\/[a-f0-9]{24}\/infra\/lpars/i, 'InfraLpar'],
  [/^\/clients\/[a-f0-9]{24}\/contracts/i, 'Contract'],
  [/^\/clients\/[a-f0-9]{24}\/migrations/i, 'MigrationEvent'],
  [/^\/clients\/[a-f0-9]{24}\/reports/i, 'ScrtReport'],
  [/^\/clients$/i, 'Client'],
  [/^\/admin\/users/i, 'User'],
];

function resolveEntity(path) {
  for (const [re, type, model] of FINA) {
    const m = path.match(re);
    if (m) return { type, model, id: m[1] };
  }
  for (const [re, type] of GROSSA) if (re.test(path)) return { type, model: null, id: null };
  return { type: 'API', model: null, id: null };
}

// ── Sanitização: tira segredo e encolhe campo grande ──
const SENSIVEL = new Set(['password', 'passwordHash', 'passwordSalt', 'senha', 'token', 'secret']);
const GRANDE = new Set(['configTxtContent', 'configCfrContent', 'rawContent', 'content', 'products', 'data', 'base64', 'file']);

function encolhe(v) {
  if (typeof v === 'string') return v.length > 500 ? `${v.slice(0, 500)}… (${v.length} caracteres)` : v;
  if (Array.isArray(v)) return v.length > 25 ? `[${v.length} itens]` : v.map(encolhe);
  if (v && typeof v === 'object') return sanitizeDoc(v);
  return v;
}
function sanitizeDoc(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  const out = Array.isArray(doc) ? [] : {};
  for (const [k, v] of Object.entries(doc)) {
    if (SENSIVEL.has(k)) continue;                       // some por completo
    if (k === '__v') continue;
    if (GRANDE.has(k)) {
      out[k] = Array.isArray(v) ? `[${v.length} itens]` : '[conteúdo grande omitido]';
      continue;
    }
    out[k] = encolhe(v);
  }
  return out;
}

// ── Diff campo a campo entre o antes e o depois ──
const IGNORA_DIFF = new Set(['_id', '__v', 'createdAt', 'updatedAt']);
function diffDocs(antes, depois) {
  const a = sanitizeDoc(antes || {});
  const d = sanitizeDoc(depois || {});
  const chaves = new Set([...Object.keys(a), ...Object.keys(d)]);
  const changes = [];
  for (const k of chaves) {
    if (IGNORA_DIFF.has(k)) continue;
    if (JSON.stringify(a[k]) !== JSON.stringify(d[k])) changes.push({ field: k, from: a[k], to: d[k] });
  }
  return changes.length ? changes : undefined;
}

function labelFor(type, doc, body) {
  const src = doc || body || {};
  switch (type) {
    case 'Client': return src.name;
    case 'InfraMachine': return src.serial || src.model;
    case 'InfraSite': return src.name;
    case 'InfraLpar': return src.name;
    case 'Contract': return src.number || src.name;
    case 'MigrationEvent': return src.title || src.kind;
    case 'ScrtReport': return src.periodKey || src.fileName;
    case 'User': return src.email || src.name;
    default: return undefined;
  }
}

const acaoDe = (method) => (method === 'POST' ? 'create' : method === 'DELETE' ? 'delete' : 'update');

// Grava sem nunca derrubar a requisição.
async function grava(entrada) {
  try { await AuditLog.create(entrada); }
  catch (e) { console.warn('[auditoria] não gravou:', e.message); }
}

async function nomeCliente(id) {
  if (!id) return undefined;
  const c = await Client.findById(id).select('name').lean().catch(() => null);
  return c ? c.name : undefined;
}

const atorDe = (req) => (req.user
  ? { id: req.user._id, email: req.user.email, name: req.user.name }
  : { email: '-', name: 'anônimo' });

// ── Middleware de captura automática ──
function middleware(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();

  const path = req.path;
  const { type, model, id } = resolveEntity(path);
  const cm = path.match(/^\/clients\/([a-f0-9]{24})/i);
  const clientId = cm ? cm[1] : null;

  // captura o corpo da resposta (para pegar o doc criado no POST)
  const jsonOrig = res.json.bind(res);
  res.json = (body) => { req._auditResp = body; return jsonOrig(body); };

  // lê o "antes" para update/delete de entidade-documento
  const preleitura = (model && id && req.method !== 'POST')
    ? model.findById(id).lean().catch(() => null)
    : Promise.resolve(null);

  preleitura.then((antes) => {
    res.on('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;   // só mutação bem-sucedida
      (async () => {
        const acao = acaoDe(req.method);
        const resp = req._auditResp && typeof req._auditResp === 'object' ? req._auditResp : null;
        // o "depois": relê a entidade (update) ou usa o doc criado da resposta (create)
        let depois = null;
        if (model && id && acao !== 'delete') depois = await model.findById(id).lean().catch(() => null);
        else if (acao === 'create' && resp && resp._id) depois = resp;

        const entidadeId = id || (depois && depois._id) || (resp && resp._id) || null;
        const entrada = {
          actor: atorDe(req),
          action: acao,
          entity: { type, id: entidadeId ? String(entidadeId) : undefined, label: labelFor(type, depois || antes, req.body) },
          client: { id: clientId || undefined, name: await nomeCliente(clientId || (antes && antes.client) || (depois && depois.client)) },
          method: req.method,
          path,
          ip: ipDe(req),
          status: res.statusCode,
        };
        if (acao === 'update') {
          entrada.changes = diffDocs(antes, depois);
          if (!entrada.changes && req.body && Object.keys(req.body).length) entrada.after = sanitizeDoc(req.body);
        } else if (acao === 'delete') {
          entrada.before = sanitizeDoc(antes);
        } else { // create
          entrada.after = sanitizeDoc(depois || resp || req.body);
        }
        await grava(entrada);
      })().catch((e) => console.warn('[auditoria] falhou:', e.message));
    });
    next();
  }).catch(() => next());
}

// ── Evento pontual (login, logout, negado, setup) ──
// `actor` explícito serve para o login, onde req.user ainda não existe.
function event(req, { action, actor, entityType, entityLabel, clientId, clientName, summary, status }) {
  return grava({
    actor: actor
      ? { id: actor._id, email: actor.email, name: actor.name }
      : atorDe(req),
    action,
    entity: entityType ? { type: entityType, label: entityLabel } : undefined,
    client: (clientId || clientName) ? { id: clientId || undefined, name: clientName } : undefined,
    method: req.method,
    path: req.path,
    ip: ipDe(req),
    status,
    summary,
  });
}

module.exports = { middleware, event, sanitizeDoc, diffDocs };
