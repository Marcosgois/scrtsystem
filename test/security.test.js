'use strict';

/* Hardening de segurança: rate limit no login, resposta genérica (anti-enumeração),
   IDOR de contrato entre clientes, CSV formula injection, CSP e mínimo de senha. */

const assert = require('assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

const PORT = 3994;
const BASE = `http://127.0.0.1:${PORT}/api`;

let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : ''); }
};

function session() {
  let cookie = '';
  const req = async (pathname, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (cookie) headers.Cookie = cookie;
    if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.json); }
    const res = await fetch(`${BASE}${pathname}`, { method: opts.method, headers, body: opts.body });
    const setc = res.headers.get('set-cookie');
    if (setc) cookie = setc.split(';')[0];
    const text = await res.text();
    let body = null; try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body, headers: res.headers };
  };
  return { req };
}

async function main() {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('tfpsystem-sec');
  process.env.PORT = String(PORT);
  process.env.LOG_REQUESTS = 'off'; process.env.LOG_FILE = '0'; process.env.LOG_AUTH = '0';
  const { connectDb } = require('../src/db');
  const { app } = require('../server');
  await connectDb(process.env.MONGODB_URI);
  const server = app.listen(PORT);
  await new Promise((r) => server.once('listening', r));

  const admin = session();
  await admin.req('/auth/setup', { method: 'POST', json: { name: 'Admin', email: 'admin@x.com', password: 'admin123456' } });

  // ── CSP presente em toda resposta ──
  const st = await admin.req('/auth/status');
  const csp = st.headers.get('content-security-policy');
  check('CSP presente no cabeçalho', !!csp && /default-src 'self'/.test(csp), csp);
  check('X-Powered-By não exposto', !st.headers.get('x-powered-by'), st.headers.get('x-powered-by'));

  // ── Mínimo de senha (10) ──
  const curta = await admin.req('/admin/users', { method: 'POST', json: { name: 'Curto', email: 'curto@x.com', password: '123456789', role: 'user', access: [] } });
  check('senha < 10 é rejeitada (400)', curta.status === 400, curta.status);

  // ── IDOR de contrato entre clientes ──
  const A = (await admin.req('/clients', { method: 'POST', json: { name: 'ClienteA' } })).body;
  const B = (await admin.req('/clients', { method: 'POST', json: { name: 'ClienteB' } })).body;
  const contratoB = (await admin.req(`/clients/${B._id}/contracts`, { method: 'POST', json: { number: 'C-B-1', name: 'Contrato do B' } })).body;
  const contratoA = (await admin.req(`/clients/${A._id}/contracts`, { method: 'POST', json: { number: 'C-A-1', name: 'Contrato do A' } })).body;
  await admin.req('/admin/users', { method: 'POST', json: { name: 'Editor', email: 'editor@x.com', password: 'editor12345', role: 'user', access: [{ client: A._id, level: 'edit' }] } });
  const editor = session();
  await editor.req('/auth/login', { method: 'POST', json: { email: 'editor@x.com', password: 'editor12345' } });
  const maq = (await editor.req(`/clients/${A._id}/infra/machines`, { method: 'POST', json: { model: '3931-7C6', serial: 'AAA1' } })).body;
  const idorPut = await editor.req(`/clients/${A._id}/infra/machines/${maq._id}`, { method: 'PUT', json: { contract: contratoB._id } });
  check('máquina de A não aceita contrato de B (422)', idorPut.status === 422, idorPut.status);
  const okPut = await editor.req(`/clients/${A._id}/infra/machines/${maq._id}`, { method: 'PUT', json: { contract: contratoA._id } });
  check('máquina de A aceita contrato de A (200)', okPut.status === 200, okPut.status);

  // ── CSV formula injection na auditoria ──
  await admin.req(`/clients/${A._id}`, { method: 'PATCH', json: { name: '=1+2 CLIENTE' } });
  await new Promise((r) => setTimeout(r, 300)); // deixa a auditoria assíncrona cair
  const csv = (await admin.req('/admin/audit.csv')).body;
  check('CSV neutraliza fórmula (prefixo apóstrofo)', typeof csv === 'string' && csv.includes("'=1+2 CLIENTE") && !/,=1\+2 CLIENTE/.test(csv), String(csv).slice(0, 60));

  // ── Anti-enumeração: mesma resposta para e-mail inexistente e senha errada ──
  const semUser = await admin.req('/auth/login', { method: 'POST', json: { email: 'naoexiste@x.com', password: 'qualquer12345' } });
  const senhaErr = await admin.req('/auth/login', { method: 'POST', json: { email: 'admin@x.com', password: 'errada_demais' } });
  check('login inexistente e senha errada dão o mesmo 401 genérico',
    semUser.status === 401 && senhaErr.status === 401 && semUser.body.error === senhaErr.body.error, { a: semUser.body, b: senhaErr.body });

  // ── Excluir cliente é exclusivo de administrador ──
  // O editor tem o nível MAIS ALTO abaixo de admin ('edit') no cliente A, e ainda
  // assim não pode excluí-lo: excluir cliente leva junto todo o histórico de SCRT.
  const delEditor = await editor.req(`/clients/${A._id}`, { method: 'DELETE' });
  check('não-admin com edição NÃO exclui cliente (403)', delEditor.status === 403, delEditor.status);
  // (não há GET /clients/:id — a checagem é na listagem)
  const listaDepois = (await admin.req('/clients')).body;
  check('cliente sobrevive à tentativa do não-admin',
    Array.isArray(listaDepois) && listaDepois.some((c) => String(c._id) === String(A._id)),
    listaDepois && listaDepois.map && listaDepois.map((c) => c.name));
  const delAdmin = await admin.req(`/clients/${A._id}`, { method: 'DELETE' });
  check('admin consegue excluir o cliente', delAdmin.status === 200, delAdmin.status);

  // ── Perfil GERENTE: vê todo cliente, inclusive os criados DEPOIS dele ──
  await admin.req('/admin/users', { method: 'POST', json: { name: 'Renata', email: 'renata@x.com', password: 'renata12345', role: 'manager', access: [] } });
  const gerente = session();
  await gerente.req('/auth/login', { method: 'POST', json: { email: 'renata@x.com', password: 'renata12345' } });

  const listaGer = (await gerente.req('/clients')).body;
  check('gerente enxerga os clientes existentes sem concessão explícita',
    Array.isArray(listaGer) && listaGer.some((c) => String(c._id) === String(B._id)), listaGer && listaGer.length);

  // O ponto do pedido: cliente criado DEPOIS já nasce visível para o gerente.
  const novo = (await admin.req('/clients', { method: 'POST', json: { name: 'ClienteNovoDepois' } })).body;
  const listaGerDepois = (await gerente.req('/clients')).body;
  check('cliente criado DEPOIS já aparece para o gerente, sem mexer em permissão',
    listaGerDepois.some((c) => String(c._id) === String(novo._id)), listaGerDepois.map((c) => c.name));
  const leitura = await gerente.req(`/clients/${novo._id}/infra/machines`);
  check('gerente consegue LER o cliente novo', leitura.status === 200, leitura.status);

  // Mas é só leitura: não edita nem exclui, e não administra.
  const tentaEditar = await gerente.req(`/clients/${novo._id}`, { method: 'PATCH', json: { monthlyBaselineMsu: 1 } });
  check('gerente NÃO edita (403)', tentaEditar.status === 403, tentaEditar.status);
  const tentaExcluir = await gerente.req(`/clients/${novo._id}`, { method: 'DELETE' });
  check('gerente NÃO exclui cliente (403)', tentaExcluir.status === 403, tentaExcluir.status);
  const tentaAdmin = await gerente.req('/admin/users');
  check('gerente NÃO administra usuários (403)', tentaAdmin.status === 403, tentaAdmin.status);

  // Concessão explícita continua valendo por cima do piso e pode elevar para edição.
  await admin.req('/admin/users', { method: 'POST', json: { name: 'Gui', email: 'gui@x.com', password: 'gui12345678', role: 'manager', access: [{ client: novo._id, level: 'edit' }] } });
  const gerenteEdit = session();
  await gerenteEdit.req('/auth/login', { method: 'POST', json: { email: 'gui@x.com', password: 'gui12345678' } });
  const editOk = await gerenteEdit.req(`/clients/${novo._id}`, { method: 'PATCH', json: { monthlyBaselineMsu: 7 } });
  check('gerente COM concessão de edição consegue editar', editOk.status === 200, editOk.status);

  // Rebaixar o último admin para gerente não pode passar (deixaria o sistema sem admin).
  const eu = (await admin.req('/auth/me')).body;
  const rebaixa = await admin.req(`/admin/users/${eu._id}`, { method: 'PUT', json: { role: 'manager' } });
  check('não deixa rebaixar o ÚLTIMO admin para gerente (422)', rebaixa.status === 422, rebaixa.status);

  // ── Rate limit: por último, pois tranca o IP do processo ──
  const bruta = session();
  let travou = false;
  for (let i = 0; i < 12; i++) {
    const r = await bruta.req('/auth/login', { method: 'POST', json: { email: 'alvo@x.com', password: `errada${i}` } });
    if (r.status === 429) { travou = true; break; }
  }
  check('login trava após muitas tentativas (429)', travou);

  await server.close();
  await mongod.stop();
  if (failures) { console.error(`\nSEGURANÇA: ${failures} FALHA(S)`); process.exit(1); }
  console.log('\nSEGURANÇA: TODOS OS TESTES PASSARAM');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
