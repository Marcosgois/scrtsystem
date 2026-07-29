'use strict';

/*
 * Rotas de autenticação + administração de usuários, e os middlewares de
 * autorização (login obrigatório, admin, acesso por cliente). Sem deps externas.
 */

const express = require('express');
const mongoose = require('mongoose');
const { User, ScrtReport, AuditLog } = require('./models');
const auth = require('./auth');
const log = require('./logger');
const audit = require('./audit');

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    const uid = auth.sessionUserId(req);
    req.user = uid && isValidId(uid) ? await User.findById(uid).lean() : null;
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
  const count = await User.estimatedDocumentCount();
  res.json({ needsSetup: count === 0, user: publicUser(req.user) });
}));

authRouter.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Não autenticado.' });
  res.json(publicUser(req.user));
});

authRouter.post('/setup', asyncHandler(async (req, res) => {
  const count = await User.estimatedDocumentCount();
  if (count > 0) return res.status(409).json({ error: 'O sistema já tem usuários — peça a um admin.' });
  const { name, email, password } = req.body || {};
  const err = validateCreate({ name, email, password });
  if (err) return res.status(400).json({ error: err });
  const { salt, hash } = auth.hashPassword(password);
  const user = await User.create({ name: String(name).trim(), email: String(email).toLowerCase().trim(), passwordHash: hash, passwordSalt: salt, role: 'admin', access: [] });
  auth.setSessionCookie(res, user._id);
  log.lembrarUsuario(user);
  log.auth.setup(req, user);
  audit.event(req, { action: 'setup', actor: user, entityType: 'User', entityLabel: user.email, status: 201, summary: 'primeiro administrador' });
  res.status(201).json(publicUser(user));
}));

authRouter.post('/login', asyncHandler(async (req, res) => {
  const email = String((req.body && req.body.email) || '').toLowerCase().trim();
  const password = String((req.body && req.body.password) || '');
  const user = await User.findOne({ email });
  if (!user || !auth.verifyPassword(password, user.passwordSalt, user.passwordHash)) {
    // O motivo vai só para o log; a resposta continua genérica de propósito.
    log.auth.login(req, email, false, user ? 'senha incorreta' : 'e-mail não cadastrado');
    audit.event(req, { action: 'login-falho', entityType: 'Sessão', entityLabel: email, status: 401, summary: user ? 'senha incorreta' : 'e-mail não cadastrado' });
    return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  }
  auth.setSessionCookie(res, user._id);
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
  if (!password || String(password).length < 6) return 'A senha precisa de ao menos 6 caracteres.';
  return null;
}
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
  const { salt, hash } = auth.hashPassword(password);
  const user = await User.create({
    name: String(name).trim(), email: String(email).toLowerCase().trim(),
    passwordHash: hash, passwordSalt: salt,
    role: role === 'admin' ? 'admin' : 'user',
    access: role === 'admin' ? [] : parseAccess(req.body.access),
  });
  res.status(201).json(publicUser(user));
}));

adminRouter.put('/users/:id', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const update = {};
  const b = req.body || {};
  if (b.name !== undefined) { if (!String(b.name).trim()) return res.status(400).json({ error: 'Nome não pode ser vazio.' }); update.name = String(b.name).trim(); }
  if (b.role !== undefined) update.role = b.role === 'admin' ? 'admin' : 'user';
  if (b.access !== undefined) update.access = parseAccess(b.access);
  if (b.password) {
    if (String(b.password).length < 6) return res.status(400).json({ error: 'A senha precisa de ao menos 6 caracteres.' });
    const { salt, hash } = auth.hashPassword(b.password);
    update.passwordHash = hash; update.passwordSalt = salt;
  }
  // Admin não tem acesso por cliente (vê tudo).
  if (update.role === 'admin') update.access = [];
  // Não deixar remover o último admin.
  const target = await User.findById(req.params.id);
  if (!target) return res.status(404).json({ error: 'Usuário não encontrado.' });
  if (target.role === 'admin' && update.role === 'user') {
    const admins = await User.countDocuments({ role: 'admin' });
    if (admins <= 1) return res.status(422).json({ error: 'Não é possível rebaixar o último administrador.' });
  }
  const user = await User.findByIdAndUpdate(req.params.id, { $set: update }, { new: true }).lean();
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
    const s = v == null ? '' : String(v);
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

module.exports = { attachUser, requireAuth, requireAdmin, clientAccessGuard, authRouter, adminRouter };
