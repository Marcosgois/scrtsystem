'use strict';

/*
 * SSO pelo Cloudflare Access (w3id): entrada direta de quem já tem cadastro,
 * pedido de acesso de quem não tem, e aprovação pelo administrador.
 *
 * Metade destes testes é sobre o que NÃO pode acontecer. O caminho feliz é curto
 * — chegou token válido, virou sessão —, mas a superfície de ataque é grande:
 * cabeçalho de texto sem assinatura, token de outro tenant, token de outra
 * aplicação, alg:none, confusão de algoritmo (HS256 com a chave pública como
 * segredo), token vencido, e-mail escolhido pelo corpo da requisição. Cada um
 * desses vira admin se passar, então cada um tem um teste.
 */

const crypto = require('crypto');
const { MongoMemoryServer } = require('mongodb-memory-server');

const PORT = 3994;
const RAIZ = `http://127.0.0.1:${PORT}`;
const BASE = `${RAIZ}/api`;

const TEAM = 'https://zcd-teste.cloudflareaccess.com';
const AUD = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

// Precisa vir ANTES de qualquer require do app: o src/sso.js lê o ambiente na
// carga do módulo (é o que permite o "fecha por padrão" em quem não configurou).
process.env.SSO_TEAM_DOMAIN = TEAM;
process.env.SSO_AUD = AUD;

let failures = 0;
const check = (name, cond, extra) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : ''); }
};

// ── Chaves e JWKS falsos do "tenant" ──
const KID = 'chave-de-teste-1';
const par = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...par.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
// Um segundo par, para simular token assinado por quem não é o nosso tenant.
const intruso = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

// O fetch global serve a dois senhores: o JWKS (interceptado) e as requisições
// do próprio teste contra o servidor (passam direto).
const fetchReal = global.fetch;
let buscasJwks = 0;
global.fetch = async (url, opts) => {
  const u = String((url && url.url) || url);
  if (u.startsWith(TEAM)) {
    buscasJwks++;
    return new Response(JSON.stringify({ keys: [JWK] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return fetchReal(url, opts);
};

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** Monta um JWT do Access. Sem opções, é um token perfeitamente válido. */
function token(claims = {}, { alg = 'RS256', kid = KID, chave = par.privateKey, corromper = false } = {}) {
  const agora = Math.floor(Date.now() / 1000);
  const h = b64({ alg, kid, typ: 'JWT' });
  const p = b64({ iss: TEAM, aud: [AUD], iat: agora - 10, exp: agora + 3600, sub: 'u-1', email: 'fulano@br.ibm.com', ...claims });
  if (alg === 'none') return `${h}.${p}.`;
  if (alg === 'HS256') {
    // Confusão de algoritmo: assina com HMAC usando a chave PÚBLICA (que é, por
    // definição, conhecida) como segredo. Quem escolhe o algoritmo pelo cabeçalho
    // do token em vez de fixar a lista aceita, engole isto.
    const pem = par.publicKey.export({ type: 'spki', format: 'pem' });
    const sig = crypto.createHmac('sha256', pem).update(`${h}.${p}`).digest('base64url');
    return `${h}.${p}.${sig}`;
  }
  const sig = crypto.sign('sha256', Buffer.from(`${h}.${p}`), chave).toString('base64url');
  return `${h}.${p}.${corromper ? `${sig.slice(0, -4)}AAAA` : sig}`;
}

const reqCom = (jwt) => ({ headers: jwt ? { 'cf-access-jwt-assertion': jwt } : {} });

/** Sessão HTTP com cookie próprio e, opcionalmente, um token de SSO fixo. */
function session(jwt) {
  let cookie = '';
  const req = async (pathname, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (cookie) headers.Cookie = cookie;
    if (jwt) headers['Cf-Access-Jwt-Assertion'] = jwt;
    if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.json); }
    const res = await fetchReal(`${BASE}${pathname}`, { method: opts.method, headers, body: opts.body });
    const setc = res.headers.get('set-cookie');
    if (setc) cookie = setc.split(';')[0];
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  };
  const pagina = async (pathname, extra = {}) => {
    const headers = { ...extra };
    if (cookie) headers.Cookie = cookie;
    if (jwt) headers['Cf-Access-Jwt-Assertion'] = jwt;
    const res = await fetchReal(`${RAIZ}${pathname}`, { headers, redirect: 'manual' });
    return { status: res.status, location: res.headers.get('location') };
  };
  return { req, pagina, temCookie: () => /zcd_session=/.test(cookie), limparCookie: () => { cookie = ''; } };
}

async function main() {
  const sso = require('../src/sso');

  console.log('\n── Verificação do token (unitário) ──');

  check('SSO liga quando team e aud estão definidos', sso.ATIVO === true);
  check('normalizaTeam aceita só o nome do tenant',
    sso.normalizaTeam('acme') === 'https://acme.cloudflareaccess.com', sso.normalizaTeam('acme'));
  check('normalizaTeam aceita a URL inteira e tira a barra final',
    sso.normalizaTeam('https://acme.cloudflareaccess.com/') === 'https://acme.cloudflareaccess.com');
  check('normalizaTeam recusa http:// (seria segredo em claro)', sso.normalizaTeam('http://acme.cloudflareaccess.com') === '');
  check('nomeDoEmail vira nome legível', sso.nomeDoEmail('marcos.gois@br.ibm.com') === 'Marcos Gois', sso.nomeDoEmail('marcos.gois@br.ibm.com'));

  let id = await sso.identidade(reqCom(token()));
  check('token válido identifica a pessoa', id && id.email === 'fulano@br.ibm.com', id);
  check('JWKS foi buscado uma vez só', buscasJwks === 1, buscasJwks);

  id = await sso.identidade(reqCom(token()));
  check('segundo token reusa o JWKS em cache', buscasJwks === 1, buscasJwks);

  // ── O cerne: nada que não seja um token assinado identifica ninguém ──
  const soCabecalho = { headers: { 'cf-access-authenticated-user-email': 'admin@x.com' } };
  check('CABEÇALHO DE E-MAIL SOZINHO NÃO IDENTIFICA', (await sso.identidade(soCabecalho)) === null);
  check('sem cabeçalho nenhum -> null', (await sso.identidade({ headers: {} })) === null);
  check('assinatura corrompida -> null', (await sso.identidade(reqCom(token({}, { corromper: true })))) === null);
  check('alg:none -> null', (await sso.identidade(reqCom(token({}, { alg: 'none' })))) === null);
  check('HS256 com a chave pública como segredo -> null', (await sso.identidade(reqCom(token({}, { alg: 'HS256' })))) === null);
  check('assinado por outro tenant -> null', (await sso.identidade(reqCom(token({}, { chave: intruso.privateKey })))) === null);
  check('aud de outra aplicação Access -> null', (await sso.identidade(reqCom(token({ aud: ['outra-aplicacao'] })))) === null);
  check('emissor diferente -> null', (await sso.identidade(reqCom(token({ iss: 'https://outro.cloudflareaccess.com' })))) === null);
  check('token expirado -> null', (await sso.identidade(reqCom(token({ exp: Math.floor(Date.now() / 1000) - 3600 })))) === null);
  check('token sem e-mail (token de serviço) -> null', (await sso.identidade(reqCom(token({ email: undefined })))) === null);
  check('e-mail malformado no token -> null', (await sso.identidade(reqCom(token({ email: 'nao-e-email' })))) === null);
  check('texto qualquer no lugar do token -> null', (await sso.identidade(reqCom('nem-parece-um-jwt'))) === null);
  check('URL de logout aponta para o tenant', sso.urlDeLogout() === `${TEAM}/cdn-cgi/access/logout`, sso.urlDeLogout());

  // kid inventado não pode virar uma ida à rede por requisição.
  const antes = buscasJwks;
  await sso.identidade(reqCom(token({}, { kid: 'inventado-1' })));
  await sso.identidade(reqCom(token({}, { kid: 'inventado-2' })));
  await sso.identidade(reqCom(token({}, { kid: 'inventado-3' })));
  check('kid desconhecido não dispara uma busca de JWKS por requisição', buscasJwks - antes <= 1, buscasJwks - antes);

  // ── Integração ──
  console.log('\n── Entrada, pedido de acesso e aprovação ──');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('tfpsystem-sso');
  process.env.PORT = String(PORT);
  process.env.LOG_REQUESTS = 'off';
  process.env.LOG_FILE = '0';
  process.env.LOG_AUTH = '0';

  const { connectDb } = require('../src/db');
  const { app } = require('../server');
  await connectDb(process.env.MONGODB_URI);
  const server = app.listen(PORT);

  try {
    // O primeiro admin ainda nasce por senha: um sistema vazio não tem quem aprove.
    const admin = session();
    let r = await admin.req('/auth/setup', { method: 'POST', json: { name: 'Admin', email: 'admin@x.com', password: 'admin12399' } });
    check('setup do 1º admin continua funcionando com SSO ligado', r.status === 201, r.body);

    const cliente = (await admin.req('/clients', { method: 'POST', json: { name: 'CAIXA' } })).body;

    // ── Quem chega pelo SSO sem cadastro ──
    const novo = session(token({ email: 'fulano@br.ibm.com' }));
    r = await novo.req('/auth/status');
    check('status expõe a identidade do SSO', r.body.sso && r.body.sso.ativo === true && r.body.sso.email === 'fulano@br.ibm.com', r.body.sso);
    check('sem cadastro, não há usuário logado', r.body.user === null, r.body.user);
    check('sem cadastro, nenhuma sessão é emitida', !novo.temCookie());

    r = await novo.req('/clients');
    check('sem cadastro, a API segue fechada (401)', r.status === 401, r.status);

    let p = await novo.pagina('/consumo');
    check('sem cadastro, a página redireciona para /login', p.status === 302 && p.location === '/login', p);

    r = await novo.req('/auth/solicitar-acesso', { method: 'POST', json: { note: 'sou o arquiteto da conta' } });
    check('pedido de acesso é registrado', r.status === 201 && r.body.status === 'pendente', r.body);

    r = await novo.req('/auth/solicitar-acesso', { method: 'POST', json: { note: 'de novo' } });
    check('segundo pedido não duplica a fila', r.status === 200 && r.body.jaHavia === true, r.body);

    r = await novo.req('/auth/status');
    check('status mostra o pedido pendente', r.body.sso.solicitacao && r.body.sso.solicitacao.status === 'pendente', r.body.sso);

    // O e-mail do pedido vem do TOKEN, nunca do corpo.
    const outro = session(token({ email: 'ciclano@br.ibm.com' }));
    r = await outro.req('/auth/solicitar-acesso', { method: 'POST', json: { email: 'admin@x.com', name: 'Admin', role: 'admin' } });
    check('pedido ignora e-mail/papel vindos do corpo', r.status === 201, r.body);

    // Sem token não se pede acesso: senão qualquer um enfileira e-mail alheio.
    const anonimo = session();
    r = await anonimo.req('/auth/solicitar-acesso', { method: 'POST', json: { note: 'me deixa entrar' } });
    check('sem SSO, pedido de acesso é recusado (403)', r.status === 403, r.status);

    // Cabeçalho de e-mail forjado, sem JWT: continua sendo ninguém.
    const forjado = session();
    r = await forjado.req('/auth/status', { headers: { 'Cf-Access-Authenticated-User-Email': 'admin@x.com' } });
    check('CABEÇALHO FORJADO NÃO LOGA NINGUÉM', r.body.user === null && !r.body.sso.email, r.body);
    p = await forjado.pagina('/consumo', { 'Cf-Access-Authenticated-User-Email': 'admin@x.com' });
    check('cabeçalho forjado não abre página protegida', p.status === 302 && p.location === '/login', p);

    // ── A fila do administrador ──
    r = await admin.req('/admin/access-requests');
    check('admin vê os dois pedidos', r.status === 200 && r.body.items.length === 2 && r.body.pendentes === 2, r.body && r.body.pendentes);

    const pedidoFulano = r.body.items.find((x) => x.email === 'fulano@br.ibm.com');
    const pedidoCiclano = r.body.items.find((x) => x.email === 'ciclano@br.ibm.com');
    check('pedido guarda a justificativa e o e-mail do token',
      pedidoFulano && pedidoFulano.note === 'sou o arquiteto da conta' && pedidoCiclano.email === 'ciclano@br.ibm.com', pedidoFulano);

    // Quem não é admin não chega perto da fila.
    r = await novo.req('/admin/access-requests');
    check('sem cadastro não lista pedidos (401)', r.status === 401, r.status);

    r = await admin.req(`/admin/access-requests/${pedidoFulano._id}/aprovar`, {
      method: 'POST', json: { role: 'user', access: [{ client: String(cliente._id), level: 'edit' }] },
    });
    check('aprovar cria o usuário com o papel e o acesso escolhidos',
      r.status === 200 && r.body.criado === true && r.body.user.email === 'fulano@br.ibm.com'
      && r.body.user.access.length === 1 && r.body.user.access[0].level === 'edit', r.body);

    r = await admin.req(`/admin/access-requests/${pedidoFulano._id}/aprovar`, { method: 'POST', json: { role: 'admin' } });
    check('aprovar duas vezes -> 409 (não vira admin no segundo clique)', r.status === 409, r.status);

    r = await admin.req(`/admin/access-requests/${pedidoCiclano._id}/recusar`, { method: 'POST', json: { reason: 'não é da equipe' } });
    check('recusar encerra o pedido com motivo', r.status === 200 && r.body.request.status === 'recusado' && r.body.request.reason === 'não é da equipe', r.body);

    // ── Aprovado: agora entra direto, sem senha ──
    const aprovado = session(token({ email: 'fulano@br.ibm.com' }));
    r = await aprovado.req('/auth/me');
    check('aprovado é reconhecido pelo SSO', r.status === 200 && r.body.email === 'fulano@br.ibm.com', r.body);
    check('a sessão do app é emitida na hora', aprovado.temCookie());

    p = await aprovado.pagina('/consumo');
    check('aprovado abre a página protegida direto, sem passar pelo login', p.status === 200, p);

    r = await aprovado.req(`/clients/${cliente._id}`, { method: 'PATCH', json: { monthlyBaselineMsu: 10 } });
    check('o acesso "edit" concedido na aprovação vale de verdade', r.status === 200, r.status);

    r = await aprovado.req('/admin/users');
    check('aprovado como "user" não vira admin', r.status === 403, r.status);

    // A sessão em cookie sobrevive sem o token: é ela que sustenta as requisições
    // seguintes (é o motivo de o JWT não ser verificado a cada clique).
    r = await aprovado.req('/auth/me');
    check('sessão segue válida na requisição seguinte', r.status === 200, r.status);

    // Recusado continua de fora, e pode pedir de novo.
    const recusado = session(token({ email: 'ciclano@br.ibm.com' }));
    r = await recusado.req('/auth/status');
    check('recusado vê o motivo da recusa',
      r.body.user === null && r.body.sso.solicitacao.status === 'recusado' && r.body.sso.solicitacao.motivo === 'não é da equipe', r.body.sso);

    r = await recusado.req('/auth/solicitar-acesso', { method: 'POST', json: { note: 'agora entrei na equipe' } });
    check('recusado pode pedir de novo', r.status === 201 && r.body.status === 'pendente', r.body);

    // ── Sair de verdade ──
    r = await aprovado.req('/auth/logout', { method: 'POST' });
    check('logout devolve a URL que encerra a sessão do Access',
      r.status === 200 && r.body.redirect === `${TEAM}/cdn-cgi/access/logout`, r.body);

    // ── Login por senha continua vivo (é o único caminho da produção hoje) ──
    const porSenha = session();
    r = await porSenha.req('/auth/login', { method: 'POST', json: { email: 'admin@x.com', password: 'admin12399' } });
    check('login por senha continua funcionando com SSO ligado', r.status === 200 && porSenha.temCookie(), r.body);

    r = await porSenha.req('/auth/status');
    check('admin logado vê o contador de pendências', Number(r.body.pendentes) === 1, r.body.pendentes);

    // O cookie manda: token de OUTRA pessoa não troca a sessão já estabelecida.
    r = await porSenha.req('/auth/me', { headers: { 'Cf-Access-Jwt-Assertion': token({ email: 'fulano@br.ibm.com' }) } });
    check('cookie de sessão tem precedência sobre o token do SSO', r.body.email === 'admin@x.com', r.body);
  } finally {
    server.close();
    await require('mongoose').disconnect();
    await mongod.stop();
    global.fetch = fetchReal;
  }

  console.log(failures === 0 ? '\n✅ SSO: tudo certo\n' : `\n❌ ${failures} verificação(ões) falharam\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
