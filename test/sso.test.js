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

  /* Corrida do primeiro JWKS: logo depois de um restart o cache está vazio e a
     primeira requisição sai buscando. Todas as outras que chegarem durante essa
     ida têm de ESPERAR a busca em voo — antes elas caíam no piso de 30s, voltavam
     null e recusavam token válido, mandando para /login justamente quem o SSO
     deveria deixar passar. É o cenário exato do restart do deploy. */
  sso.__zerarCacheParaTeste();
  let liberaJwks;
  const represa = new Promise((r) => { liberaJwks = r; });
  const fetchJwksNormal = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String((url && url.url) || url);
    if (u.startsWith(TEAM)) { await represa; }
    return fetchJwksNormal(url, opts);
  };
  const concorrentes = Promise.all([1, 2, 3, 4].map(() => sso.identidade(reqCom(token()))));
  await new Promise((r) => setTimeout(r, 60));   // todas já bateram no cache vazio
  liberaJwks();
  const resultado = await concorrentes;
  global.fetch = fetchJwksNormal;
  check('4 requisições concorrentes no cache vazio: TODAS identificam (nenhuma cai no piso)',
    resultado.every((x) => x && x.email === 'fulano@br.ibm.com'),
    resultado.map((x) => (x ? 'ok' : 'RECUSADO')).join(', '));

  /* O anti-flood guardava a mensagem INTEIRA como chave, e metade das mensagens
     interpola valor vindo do token. Cada kid novo virava chave nova: o Map crescia
     para sempre com dado do atacante e o teto de 60s nunca casava. */
  const linhas = [];
  const warnReal = console.warn;
  console.warn = (...a) => { linhas.push(a.join(' ')); };
  for (let i = 0; i < 60; i++) await sso.identidade(reqCom(token({}, { kid: `lixo-${i}` })));
  console.warn = warnReal;
  check('60 kids distintos não geram 60 linhas de log', linhas.length <= 2, linhas.length);
  check('o valor do token não vira chave permanente em memória', sso.__tamanhoDoAntiFlood() <= 100, sso.__tamanhoDoAntiFlood());

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

    /* ── Mesma pessoa, outro domínio (@ibm.com × @br.ibm.com) ──────────────
       O caso que mais dói na prática: a conta foi cadastrada com um domínio e o
       w3id devolve o outro. Aprovar como novo criaria uma segunda conta e a
       pessoa perderia os acessos por cliente que já tinha. */
    const antigo = (await admin.req('/admin/users', {
      method: 'POST', json: { name: 'Beltrano', email: 'beltrano@ibm.com', password: 'senha123456', role: 'user', access: [{ client: String(cliente._id), level: 'edit' }] },
    })).body;

    const outroDominio = session(token({ email: 'beltrano@br.ibm.com' }));
    await outroDominio.req('/auth/solicitar-acesso', { method: 'POST', json: { note: 'domínio diferente' } });

    r = await admin.req('/admin/access-requests');
    const pedidoBeltrano = r.body.items.find((x) => x.email === 'beltrano@br.ibm.com');
    check('a fila avisa que já existe conta com o outro domínio',
      pedidoBeltrano.parecida && pedidoBeltrano.parecida.email === 'beltrano@ibm.com', pedidoBeltrano.parecida);
    check('não sugere parecida quando não há homônimo', !pedidoFulano.parecida || pedidoFulano.status !== 'pendente');

    r = await admin.req(`/admin/access-requests/${pedidoBeltrano._id}/aprovar`, { method: 'POST', json: { vincularA: String(antigo._id) } });
    check('vincular corrige o e-mail em vez de criar conta nova',
      r.status === 200 && r.body.vinculado === true && r.body.criado === false
      && r.body.user._id === antigo._id && r.body.user.email === 'beltrano@br.ibm.com', r.body);
    check('vincular preserva o acesso por cliente que a conta já tinha',
      r.body.user.access.length === 1 && r.body.user.access[0].level === 'edit', r.body.user.access);

    r = await admin.req('/admin/users');
    check('vincular NÃO deixa duas contas para a mesma pessoa',
      r.body.filter((u) => String(u.email).startsWith('beltrano@')).length === 1,
      r.body.filter((u) => String(u.email).startsWith('beltrano@')).map((u) => u.email));

    r = await outroDominio.req('/auth/me');
    check('vinculado entra pelo SSO com o e-mail do w3id', r.status === 200 && r.body._id === antigo._id, r.body);

    /* Vincular reescreve o e-mail, que é a chave de login e é imutável na edição —
       então um id errado no corpo transferiria a conta de OUTRA pessoa, sem desfazer. */
    const alheia = (await admin.req('/admin/users', {
      method: 'POST', json: { name: 'Sicrano', email: 'sicrano@ibm.com', password: 'senha123456', role: 'user' },
    })).body;
    const terceiro = session(token({ email: 'zezinho@br.ibm.com' }));
    await terceiro.req('/auth/solicitar-acesso', { method: 'POST', json: {} });
    const pedidoZezinho = (await admin.req('/admin/access-requests')).body.items.find((x) => x.email === 'zezinho@br.ibm.com');

    r = await admin.req(`/admin/access-requests/${pedidoZezinho._id}/aprovar`, { method: 'POST', json: { vincularA: String(alheia._id) } });
    check('vincular a uma conta que não é a mesma pessoa -> 422', r.status === 422, { status: r.status, erro: r.body && r.body.error });

    r = await admin.req('/admin/users');
    check('a conta alheia continua com o e-mail dela', r.body.some((u) => u.email === 'sicrano@ibm.com'), r.body.map((u) => u.email));

    // Herdar conta de admin/gerente é escalada a um clique: exige confirmação explícita.
    const chefe = (await admin.req('/admin/users', {
      method: 'POST', json: { name: 'Zezinho Chefe', email: 'zezinho@ibm.com', password: 'senha123456', role: 'manager' },
    })).body;
    r = await admin.req(`/admin/access-requests/${pedidoZezinho._id}/aprovar`, { method: 'POST', json: { vincularA: String(chefe._id) } });
    check('vincular a conta de gerente sem confirmar -> 422 avisando do papel',
      r.status === 422 && r.body.exigeConfirmacao === true && r.body.papelDoAlvo === 'manager', r.body);

    r = await admin.req(`/admin/access-requests/${pedidoZezinho._id}/aprovar`, { method: 'POST', json: { vincularA: String(chefe._id), confirmarPapelElevado: true } });
    check('com a confirmação explícita, o vínculo acontece', r.status === 200 && r.body.vinculado === true, r.body);

    /* Aprovar quem JÁ tem conta precisa aplicar o que o admin escolheu. Descartar
       em silêncio deixava a pessoa com menos acesso do que o admin acreditava ter
       concedido, e o pedido saía da fila sem nada que lembrasse de refazer. */
    // A ordem é a do mundo real: o pedido nasce PRIMEIRO (quem já tem conta nem
    // consegue pedir), e a conta aparece à mão enquanto o pedido espera na fila.
    const quarto = session(token({ email: 'fulaninho@br.ibm.com' }));
    r = await quarto.req('/auth/solicitar-acesso', { method: 'POST', json: {} });
    check('pedido de fulaninho registrado antes de a conta existir', r.status === 201, r.body);
    const pedidoFulaninho = (await admin.req('/admin/access-requests')).body.items.find((x) => x.email === 'fulaninho@br.ibm.com');

    const jaExistia = (await admin.req('/admin/users', {
      method: 'POST', json: { name: 'Fulaninho', email: 'fulaninho@br.ibm.com', password: 'senha123456', role: 'user', access: [] },
    })).body;

    r = await admin.req(`/admin/access-requests/${pedidoFulaninho._id}/aprovar`, {
      method: 'POST', json: { role: 'manager', access: [{ client: String(cliente._id), level: 'edit' }] },
    });
    check('aprovar conta existente aplica o papel escolhido (não descarta em silêncio)',
      r.status === 200 && r.body.ajustado === true && r.body.user.role === 'manager'
      && r.body.user.access.length === 1 && r.body.user._id === jaExistia._id, r.body);

    r = await admin.req('/admin/users');
    check('o estado gravado bate com o que o admin escolheu',
      r.body.find((u) => u.email === 'fulaninho@br.ibm.com').role === 'manager', r.body.find((u) => u.email === 'fulaninho@br.ibm.com'));

    r = await quarto.req('/auth/me');
    check('fulaninho entra pelo SSO já com o papel que o admin concedeu',
      r.status === 200 && r.body.role === 'manager', r.body);

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
