'use strict';

/*
 * Rotas de autenticação + administração de usuários, e os middlewares de
 * autorização (login obrigatório, admin, acesso por cliente). Sem deps externas.
 */

const express = require('express');
const mongoose = require('mongoose');
const { User, ScrtReport, AuditLog, MachineLifecycle } = require('./models');
const auth = require('./auth');
const log = require('./logger');
const audit = require('./audit');
const guardaLogin = require('./loginGuard');

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_SENHA = 10;
const ipOf = (req) => {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0].trim() : (req.socket && req.socket.remoteAddress)) || '-';
};

function publicUser(u) {
  if (!u) return null;
  return {
    _id: u._id,
    name: u.name,
    email: u.email,
    role: u.role,
    access: (u.access || []).map((a) => ({ client: String(a.client), level: a.level })),
  };
}

/** Carrega req.user (ou null) a partir do cookie de sessão. */
async function attachUser(req, res, next) {
  try {
    const payload = auth.sessionPayload(req);
    const uid = payload && payload.uid;
    if (uid && isValidId(uid)) {
      const u = await User.findById(uid).lean();
      // Revogação: o token carrega a versão; se não bate com a do usuário (senha
      // trocada / "sair de todos os dispositivos"), a sessão é considerada inválida.
      req.user = u && Number(payload.tv || 0) === Number(u.tokenVersion || 0) ? u : null;
    } else req.user = null;
  } catch (e) { req.user = null; }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Faça login para continuar.' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Faça login para continuar.' });
  if (req.user.role !== 'admin') {
    log.auth.negado(req, 'exige administrador');
    return res.status(403).json({ error: 'Apenas administradores.' });
  }
  next();
}
const deny = (res, req, motivo) => {
  if (req) {
    log.auth.negado(req, motivo || 'sem acesso ao cliente');
    // Só registra na auditoria a negação de uma TENTATIVA de mudança (não a de leitura),
    // que é o que interessa numa investigação.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const cm = String(req.path).match(/\/clients\/([a-f0-9]{24})/i);
      audit.event(req, { action: 'negado', summary: motivo, status: 403, clientId: cm ? cm[1] : undefined });
    }
  }
  return res.status(403).json({ error: 'Você não tem acesso a este cliente.' });
};

/**
 * Controle de acesso por cliente nas rotas /api existentes.
 * Leitura (GET) exige nível 'view'; escrita exige 'edit'. Criar/excluir cliente
 * é só admin. Admin pode tudo.
 */
async function clientAccessGuard(req, res, next) {
  const user = req.user;
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  let m;

  // O Express NÃO decodifica req.path, mas ENTREGA req.params já decodificado
  // ao handler. Sem alinhar os dois, um id percent-encoded (%36a6… no lugar de
  // 6a6…) escapa dos regexes abaixo, cai no next() do fim e o handler serve o
  // recurso mesmo assim — furando o isolamento entre clientes. Decodificamos
  // aqui para casar o MESMO valor que o handler vai ver. Sequência inválida
  // (que decodeURIComponent recusa) é tentativa de burla: nega.
  let p;
  try { p = decodeURIComponent(req.path); }
  catch (e) { return deny(res, req, 'caminho malformado'); }

  // Criar cliente
  if (p === '/clients' && req.method === 'POST') return user.role === 'admin' ? next() : deny(res, req, 'criar cliente exige administrador');

  // /clients/:id exato -> DELETE (admin) / PATCH (edit)
  if ((m = p.match(/^\/clients\/([a-f0-9]{24})$/i))) {
    if (req.method === 'DELETE') return user.role === 'admin' ? next() : deny(res, req, 'excluir cliente exige administrador');
    return auth.canEdit(user, m[1]) ? next() : deny(res, req, 'sem permissão de edição neste cliente');
  }
  // /clients/:id/... -> write=edit, read=view
  if ((m = p.match(/^\/clients\/([a-f0-9]{24})\//i))) {
    return (write ? auth.canEdit(user, m[1]) : auth.canView(user, m[1])) ? next() : deny(res, req, write ? 'sem permissão de edição neste cliente' : 'sem acesso a este cliente');
  }
  // /reports/:id e /reports/:id/file -> resolve o cliente do relatório
  if ((m = p.match(/^\/reports\/([a-f0-9]{24})(\/file)?$/i))) {
    const rep = await ScrtReport.findById(m[1]).select('client').lean();
    if (!rep) return next(); // 404 vem do handler
    return (write ? auth.canEdit(user, rep.client) : auth.canView(user, rep.client)) ? next() : deny(res, req, 'sem acesso ao cliente do relatório');
  }
  // Fecha por padrão: sob /clients/<seg>, se <seg> é um id de cliente VÁLIDO que
  // não casou os padrões acima, é tentativa de burlar o guard (ex.: id de 12
  // bytes que escapa do regex de 24 hex, ou alguma normalização que não previmos)
  // — nega. Antes o next() cego aqui era o que deixava o bypass funcionar.
  // Um segmento que nem é ObjectId não corresponde a cliente nenhum: deixa o
  // handler devolver 400/404, como faz para /clients lista e /inventories.
  if ((m = p.match(/^\/clients\/([^/]+)/)) && isValidId(m[1])) {
    return deny(res, req, 'rota de cliente não reconhecida pelo guard');
  }
  next();
}

// ── Rotas públicas de auth ──
const authRouter = express.Router();

authRouter.get('/status', asyncHandler(async (req, res) => {
  const count = await User.countDocuments();
  res.json({ needsSetup: count === 0, user: publicUser(req.user) });
}));

authRouter.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Não autenticado.' });
  res.json(publicUser(req.user));
});

authRouter.post('/setup', asyncHandler(async (req, res) => {
  const count = await User.countDocuments();
  if (count > 0) return res.status(409).json({ error: 'O sistema já tem usuários — peça a um admin.' });
  const { name, email, password } = req.body || {};
  const err = validateCreate({ name, email, password });
  if (err) return res.status(400).json({ error: err });
  const { salt, hash, params } = auth.hashPassword(password);
  const user = await User.create({ name: String(name).trim(), email: String(email).toLowerCase().trim(), passwordHash: hash, passwordSalt: salt, passwordParams: params, role: 'admin', access: [] });
  auth.setSessionCookie(res, user);
  log.lembrarUsuario(user);
  log.auth.setup(req, user);
  audit.event(req, { action: 'setup', actor: user, entityType: 'User', entityLabel: user.email, status: 201, summary: 'primeiro administrador' });
  res.status(201).json(publicUser(user));
}));

authRouter.post('/login', asyncHandler(async (req, res) => {
  const email = String((req.body && req.body.email) || '').toLowerCase().trim().slice(0, 200);
  const password = String((req.body && req.body.password) || '');
  const chaveEmail = `email:${email}`;
  const chaveIp = `ip:${ipOf(req)}`;

  // Rate limit: trava por e-mail e por IP após muitas falhas (força-bruta/stuffing).
  if (guardaLogin.bloqueado(chaveEmail, chaveIp)) {
    const seg = guardaLogin.restanteSeg(chaveEmail, chaveIp);
    log.auth.login(req, email, false, `bloqueado por ${seg}s`);
    audit.event(req, { action: 'login-falho', entityType: 'Sessão', entityLabel: email, status: 429, summary: 'bloqueado por excesso de tentativas' });
    return res.status(429).json({ error: 'Muitas tentativas. Tente novamente em alguns minutos.' });
  }

  const user = await User.findOne({ email });
  // Custo constante mesmo sem usuário: o tempo de resposta não revela se a conta existe.
  if (!user) auth.dummyVerify(password);
  if (!user || !auth.verifyPassword(password, user.passwordSalt, user.passwordHash, user.passwordParams)) {
    guardaLogin.registrarFalha(chaveEmail, chaveIp);
    // O motivo vai só para o log; a resposta continua genérica de propósito.
    log.auth.login(req, email, false, user ? 'senha incorreta' : 'e-mail não cadastrado');
    audit.event(req, { action: 'login-falho', entityType: 'Sessão', entityLabel: email, status: 401, summary: user ? 'senha incorreta' : 'e-mail não cadastrado' });
    return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  }
  guardaLogin.limpar(chaveEmail, chaveIp);
  // Upgrade transparente: se o hash usa parâmetros antigos do scrypt, re-hasheia agora.
  if (auth.needsRehash(user.passwordParams)) {
    try {
      const nh = auth.hashPassword(password);
      await User.updateOne({ _id: user._id }, { $set: { passwordHash: nh.hash, passwordSalt: nh.salt, passwordParams: nh.params } });
    } catch (e) { /* upgrade é best-effort */ }
  }
  auth.setSessionCookie(res, user);
  log.lembrarUsuario(user);
  log.auth.login(req, user.email, true);
  audit.event(req, { action: 'login', actor: user, entityType: 'Sessão', status: 200 });
  res.json(publicUser(user));
}));

authRouter.post('/logout', (req, res) => {
  log.auth.logout(req, req.user);
  if (req.user) audit.event(req, { action: 'logout', entityType: 'Sessão', status: 200 });
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// ── Rotas de administração de usuários ──
const adminRouter = express.Router();

function validateCreate({ name, email, password }) {
  if (!name || !String(name).trim()) return 'Informe o nome.';
  if (!email || !EMAIL_RE.test(String(email).trim())) return 'E-mail inválido.';
  if (!password || String(password).length < MIN_SENHA) return `A senha precisa de ao menos ${MIN_SENHA} caracteres.`;
  return null;
}
// Papel válido, com 'user' como padrão seguro: valor desconhecido nunca vira
// admin nem gerente por acidente.
const PAPEIS = ['admin', 'manager', 'user'];
const papelValido = (p) => (PAPEIS.includes(p) ? p : 'user');

function parseAccess(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const a of list) {
    const client = String((a && a.client) || '').trim();
    if (!isValidId(client) || seen.has(client)) continue;
    seen.add(client);
    out.push({ client, level: (a && a.level) === 'edit' ? 'edit' : 'view' });
  }
  return out;
}

adminRouter.get('/users', asyncHandler(async (req, res) => {
  const users = await User.find().sort({ createdAt: 1 }).lean();
  res.json(users.map(publicUser));
}));

adminRouter.post('/users', asyncHandler(async (req, res) => {
  const { name, email, password, role } = req.body || {};
  const err = validateCreate({ name, email, password });
  if (err) return res.status(400).json({ error: err });
  const exists = await User.findOne({ email: String(email).toLowerCase().trim() });
  if (exists) return res.status(409).json({ error: 'Já existe um usuário com esse e-mail.' });
  const { salt, hash, params } = auth.hashPassword(password);
  const user = await User.create({
    name: String(name).trim(), email: String(email).toLowerCase().trim(),
    passwordHash: hash, passwordSalt: salt, passwordParams: params,
    role: papelValido(role),
    // Admin vê tudo, então lista de acesso não faz sentido. Gerente já tem piso de
    // 'view' em todos, mas a lista continua valendo para elevar algum para 'edit'.
    access: role === 'admin' ? [] : parseAccess(req.body.access),
  });
  res.status(201).json(publicUser(user));
}));

adminRouter.put('/users/:id', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const update = {};
  const b = req.body || {};
  if (b.name !== undefined) { if (!String(b.name).trim()) return res.status(400).json({ error: 'Nome não pode ser vazio.' }); update.name = String(b.name).trim(); }
  if (b.role !== undefined) update.role = papelValido(b.role);
  if (b.access !== undefined) update.access = parseAccess(b.access);
  if (b.password) {
    if (String(b.password).length < MIN_SENHA) return res.status(400).json({ error: `A senha precisa de ao menos ${MIN_SENHA} caracteres.` });
    const { salt, hash, params } = auth.hashPassword(b.password);
    update.passwordHash = hash; update.passwordSalt = salt; update.passwordParams = params;
  }
  // Admin não tem acesso por cliente (vê tudo).
  if (update.role === 'admin') update.access = [];
  // Não deixar remover o último admin.
  const target = await User.findById(req.params.id);
  if (!target) return res.status(404).json({ error: 'Usuário não encontrado.' });
  // Qualquer papel que NÃO seja admin é rebaixamento — inclusive 'manager'. Testar
  // só contra 'user' deixaria o último admin virar gerente e o sistema sem admin.
  if (target.role === 'admin' && update.role && update.role !== 'admin') {
    const admins = await User.countDocuments({ role: 'admin' });
    if (admins <= 1) return res.status(422).json({ error: 'Não é possível rebaixar o último administrador.' });
  }
  // Trocar a senha invalida os tokens de sessão antigos (revogação por versão).
  const mutacao = update.passwordHash ? { $set: update, $inc: { tokenVersion: 1 } } : { $set: update };
  const user = await User.findByIdAndUpdate(req.params.id, mutacao, { new: true }).lean();
  res.json(publicUser(user));
}));

adminRouter.delete('/users/:id', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  if (String(req.params.id) === String(req.user._id)) return res.status(422).json({ error: 'Você não pode excluir a si mesmo.' });
  const target = await User.findById(req.params.id);
  if (!target) return res.status(404).json({ error: 'Usuário não encontrado.' });
  if (target.role === 'admin') {
    const admins = await User.countDocuments({ role: 'admin' });
    if (admins <= 1) return res.status(422).json({ error: 'Não é possível excluir o último administrador.' });
  }
  await User.deleteOne({ _id: req.params.id });
  res.json({ ok: true });
}));

// ── Consulta da trilha de auditoria (só admin) ──
function auditFilter(q) {
  const f = {};
  if (isValidId(q.client)) f['client.id'] = new mongoose.Types.ObjectId(q.client);
  if (isValidId(q.actor)) f['actor.id'] = new mongoose.Types.ObjectId(q.actor);
  if (q.action) f.action = String(q.action);
  if (q.from || q.to) {
    f.at = {};
    if (q.from) { const d = new Date(q.from); if (!isNaN(d)) f.at.$gte = d; }
    if (q.to) { const d = new Date(q.to); if (!isNaN(d)) f.at.$lte = d; }
    if (!Object.keys(f.at).length) delete f.at;
  }
  if (q.q && String(q.q).trim()) {
    const rx = new RegExp(String(q.q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    f.$or = [{ 'entity.label': rx }, { 'actor.email': rx }, { path: rx }, { summary: rx }];
  }
  return f;
}

adminRouter.get('/audit', asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const filter = auditFilter(req.query);
  const [total, items] = await Promise.all([
    AuditLog.countDocuments(filter),
    AuditLog.find(filter).sort({ at: -1 }).skip((page - 1) * limit).limit(limit).lean(),
  ]);
  res.json({ total, page, limit, items });
}));

adminRouter.get('/audit.csv', asyncHandler(async (req, res) => {
  const items = await AuditLog.find(auditFilter(req.query)).sort({ at: -1 }).limit(10000).lean();
  const cel = (v) => {
    let s = v == null ? '' : String(v);
    // Neutraliza fórmula de planilha (CSV injection): valor iniciado por = + - @
    // (ou TAB/CR) é avaliado pelo Excel/LibreOffice ao abrir. Prefixa com apóstrofo.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const resumoMudancas = (e) => {
    if (e.changes && e.changes.length) return e.changes.map((c) => `${c.field}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`).join(' | ');
    if (e.before) return `apagado: ${JSON.stringify(e.before)}`;
    if (e.after) return `criado: ${JSON.stringify(e.after)}`;
    return e.summary || '';
  };
  const head = ['data_hora', 'quem', 'acao', 'entidade', 'cliente', 'ip', 'metodo', 'caminho', 'status', 'detalhe'];
  const linhas = items.map((e) => [
    e.at ? new Date(e.at).toISOString() : '',
    (e.actor && e.actor.email) || '',
    e.action || '',
    e.entity ? `${e.entity.type || ''}${e.entity.label ? ': ' + e.entity.label : ''}` : '',
    (e.client && e.client.name) || '',
    e.ip || '',
    e.method || '',
    e.path || '',
    e.status || '',
    resumoMudancas(e),
  ].map(cel).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="auditoria.csv"');
  res.send('﻿' + [head.join(','), ...linhas].join('\n'));
}));

/* ── Ciclo de vida das máquinas IBM Z (só admin) ──────────────────────────────
 *
 * Referência de mercado (a tabela "IBM Mainframe Life Cycle History"), não dado
 * de cliente. Fica sob o adminRouter, então já nasce restrito a administrador —
 * usuário comum nem enxerga. A ideia é cruzar depois com o parque do cliente
 * para responder "esta máquina perde suporte quando?".
 */
const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;
const CAMPOS_DATA = ['ann', 'ga', 'hwWdfm', 'licWdfm', 'coslEos'];

/** Anos entre duas datas "AAAA-MM-DD", com 1 casa. null se faltar alguma. */
function anosEntre(de, ate) {
  if (!DATA_RE.test(de || '') || !DATA_RE.test(ate || '')) return null;
  const dias = (Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86400000;
  return Math.round((dias / 365.25) * 10) / 10;
}

/** Acrescenta as colunas de anos da tabela original — derivadas, nunca gravadas. */
function comAnos(d) {
  return {
    ...d,
    annToGa: anosEntre(d.ann, d.ga),
    gaToHwWdfm: anosEntre(d.ga, d.hwWdfm),
    hwWdfmToEos: anosEntre(d.hwWdfm, d.coslEos),
  };
}

function validarCiclo(b, { parcial = false } = {}) {
  if (!parcial || b.type !== undefined) {
    if (!String(b.type || '').trim()) return 'Informe o Type da máquina (ex.: 3931).';
  }
  if (!parcial || b.family !== undefined) {
    if (!String(b.family || '').trim()) return 'Informe a Family (ex.: z16).';
  }
  for (const c of CAMPOS_DATA) {
    const v = b[c];
    if (v === undefined || v === null || v === '') continue;
    if (!DATA_RE.test(String(v))) return `A data de ${c} precisa estar no formato AAAA-MM-DD.`;
  }
  // Coerência cronológica: a tabela da IBM sempre segue esta ordem.
  const ordem = CAMPOS_DATA.filter((c) => DATA_RE.test(String(b[c] || '')));
  for (let i = 0; i < ordem.length - 1; i++) {
    if (String(b[ordem[i]]) > String(b[ordem[i + 1]])) {
      return `As datas estão fora de ordem: ${ordem[i]} é depois de ${ordem[i + 1]}.`;
    }
  }
  return null;
}

function limparCiclo(b) {
  const set = {};
  if (b.type !== undefined) set.type = String(b.type).trim();
  if (b.model !== undefined) set.model = String(b.model || '').trim();
  if (b.family !== undefined) set.family = String(b.family).trim();
  for (const c of CAMPOS_DATA) {
    if (b[c] !== undefined) set[c] = DATA_RE.test(String(b[c] || '')) ? String(b[c]) : null;
  }
  if (b.notes !== undefined) set.notes = String(b.notes || '');
  return set;
}

adminRouter.get('/lifecycle', asyncHandler(async (req, res) => {
  const itens = await MachineLifecycle.find().sort({ ann: -1, type: -1 }).lean();
  const comAno = itens.map(comAnos);
  // Médias do rodapé da tabela da IBM, sobre o que tem data.
  const media = (campo) => {
    const vals = comAno.map((d) => d[campo]).filter((v) => v != null);
    return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
  };
  res.json({
    items: comAno,
    medias: { annToGa: media('annToGa'), gaToHwWdfm: media('gaToHwWdfm'), hwWdfmToEos: media('hwWdfmToEos') },
  });
}));

adminRouter.post('/lifecycle', asyncHandler(async (req, res) => {
  const b = req.body || {};
  const erro = validarCiclo(b);
  if (erro) return res.status(400).json({ error: erro });
  const set = limparCiclo(b);
  const existe = await MachineLifecycle.findOne({ type: set.type, model: set.model || '' });
  if (existe) return res.status(409).json({ error: `Já existe um registro para ${set.type} ${set.model || ''}.`.trim() });
  res.status(201).json(comAnos((await MachineLifecycle.create(set)).toObject()));
}));

adminRouter.put('/lifecycle/:id', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const b = req.body || {};
  const erro = validarCiclo(b, { parcial: true });
  if (erro) return res.status(400).json({ error: erro });
  const set = limparCiclo(b);
  if (set.type || set.model !== undefined) {
    const atual = await MachineLifecycle.findById(req.params.id).lean();
    if (!atual) return res.status(404).json({ error: 'Registro não encontrado.' });
    const type = set.type || atual.type;
    const model = set.model !== undefined ? set.model : atual.model;
    const outro = await MachineLifecycle.findOne({ type, model: model || '', _id: { $ne: req.params.id } });
    if (outro) return res.status(409).json({ error: `Já existe um registro para ${type} ${model || ''}.`.trim() });
  }
  const doc = await MachineLifecycle.findByIdAndUpdate(req.params.id, { $set: set }, { new: true }).lean();
  if (!doc) return res.status(404).json({ error: 'Registro não encontrado.' });
  res.json(comAnos(doc));
}));

adminRouter.delete('/lifecycle/:id', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const doc = await MachineLifecycle.findByIdAndDelete(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Registro não encontrado.' });
  res.json({ ok: true });
}));

module.exports = { attachUser, requireAuth, requireAdmin, clientAccessGuard, authRouter, adminRouter };
