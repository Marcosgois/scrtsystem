'use strict';

/*
 * SSO — a identidade que vem do Cloudflare Access (federado ao w3id da IBM).
 *
 * Quem abre zcontroldesk-dev.linuxone.com.br já autenticou no w3id ANTES de a
 * requisição chegar aqui: o Access só entrega o tráfego depois disso. Pedir
 * e-mail e senha de novo é redundante, então este módulo diz QUEM o Access
 * afirma que é a pessoa, e o authRoutes emite a sessão do app com esse e-mail.
 *
 * A parte perigosa é exatamente essa. O Access acrescenta dois cabeçalhos:
 *
 *   Cf-Access-Authenticated-User-Email   texto puro, sem prova nenhuma
 *   Cf-Access-Jwt-Assertion              JWT assinado pelo Cloudflare
 *
 * ESTE MÓDULO IGNORA O PRIMEIRO DE PROPÓSITO — e essa é a decisão mais
 * importante do arquivo. Confiar num cabeçalho de texto só vale quando é
 * IMPOSSÍVEL alcançar a origem por fora do Cloudflare, e aqui não é: o firewall
 * libera as FAIXAS do Cloudflare, que são compartilhadas por todos os clientes
 * deles. Qualquer pessoa aponta um domínio próprio para este IP, manda o
 * cabeçalho com o e-mail que quiser e vira admin. O JWT fecha esse buraco
 * porque é assinado pela chave do NOSSO tenant e carrega o `aud` da NOSSA
 * aplicação Access — um token legítimo de outro tenant, ou de outra aplicação
 * do mesmo tenant, é recusado.
 *
 * Só o CABEÇALHO é lido, nunca o cookie CF_Authorization (que carrega o mesmo
 * JWT). O cabeçalho quem põe é o Cloudflare; o cookie está ao alcance do
 * navegador, e plantar o próprio cookie no navegador de outra pessoa logaria a
 * vítima como o atacante. A assinatura continuaria válida — a diferença é de
 * quem controla o canal, não de quem assina.
 *
 * Fecha por padrão: sem SSO_TEAM_DOMAIN e SSO_AUD configurados o SSO fica
 * desligado e o login por senha segue sendo o único caminho — que é o estado da
 * produção enquanto o w3id dela não sai do boarding.
 */

const crypto = require('crypto');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CABECALHO = 'cf-access-jwt-assertion';

// Algoritmos aceitos -> hash do Node. Lista fechada: sem isso, um token com
// alg:"none" ou alg:"HS256" (assinado com a chave PÚBLICA como segredo) passaria.
const ALGS = { RS256: 'sha256', RS384: 'sha384', RS512: 'sha512', ES256: 'sha256', ES384: 'sha384' };

const SKEW_SEG = 60;                    // tolerância de relógio entre nós e o Cloudflare
const JWKS_TTL = 10 * 60 * 1000;        // idade máxima do conjunto de chaves em cache
const JWKS_PISO = 30 * 1000;            // intervalo mínimo entre buscas ao Cloudflare
const JWKS_TIMEOUT = 5000;

/**
 * Aceita "empresa", "empresa.cloudflareaccess.com" ou a URL inteira, e devolve
 * sempre `https://host` — que é a forma exata do `iss` do token, com o qual
 * comparamos depois.
 */
function normalizaTeam(v) {
  const s = String(v || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  const url = /^https?:\/\//i.test(s) ? s : `https://${s.includes('.') ? s : `${s}.cloudflareaccess.com`}`;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname ? `https://${u.host}` : '';
  } catch (e) { return ''; }
}

const TEAM = normalizaTeam(process.env.SSO_TEAM_DOMAIN);
const AUD = String(process.env.SSO_AUD || '').trim();
const ATIVO = Boolean(TEAM && AUD);

// ── Chaves públicas do tenant (JWKS), em cache ──
let cache = { at: 0, chaves: new Map() };
let ultimaBusca = 0;
let emVoo = null;

async function baixarJwks() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), JWKS_TIMEOUT);
  try {
    const r = await fetch(`${TEAM}/cdn-cgi/access/certs`, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.json();
    const m = new Map();
    for (const jwk of (body && body.keys) || []) {
      if (!jwk || !jwk.kid) continue;
      // Uma chave que este Node não sabe importar não pode derrubar as outras.
      try { m.set(String(jwk.kid), crypto.createPublicKey({ key: jwk, format: 'jwk' })); } catch (e) { /* ignora */ }
    }
    if (!m.size) throw new Error('nenhuma chave utilizável no JWKS');
    cache = { at: Date.now(), chaves: m };
    return m;
  } finally { clearTimeout(t); }
}

async function chavePorKid(kid) {
  if (!kid) return null;
  const agora = Date.now();
  const achada = cache.chaves.get(kid);
  if (achada && agora - cache.at < JWKS_TTL) return achada;

  // Rebaixar o JWKS custa uma ida à rede, e um `kid` inventado no cabeçalho
  // faria isso a CADA requisição — um jeito barato de nos usar para martelar o
  // Cloudflare. O piso transforma a tentativa em, no máximo, duas buscas por
  // minuto; enquanto isso vale o que já está em cache (e o token cai por falta
  // de chave, que é o desfecho certo para um kid inventado).
  if (agora - ultimaBusca < JWKS_PISO) return achada || null;
  ultimaBusca = agora;
  if (!emVoo) emVoo = baixarJwks().finally(() => { emVoo = null; });
  const m = await emVoo.catch((e) => {
    console.warn('[sso] JWKS indisponível:', e.message);
    return cache.chaves;    // segue com o que houver: uma queda do Cloudflare não desloga todo mundo
  });
  return m.get(kid) || null;
}

// ── Verificação do token ──
const decodifica = (parte) => JSON.parse(Buffer.from(parte, 'base64url').toString('utf8'));

/** "marcos.gois@br.ibm.com" -> "Marcos Gois" (só para não nascer sem nome). */
function nomeDoEmail(email) {
  return String(email).split('@')[0]
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\p{L}/gu, (c) => c.toUpperCase()) || email;
}

async function verificar(token) {
  const partes = String(token).split('.');
  if (partes.length !== 3) throw new Error('token fora do formato JWT');
  const [h, p, s] = partes;

  const cabecalho = decodifica(h);
  const hash = ALGS[cabecalho && cabecalho.alg];
  if (!hash) throw new Error(`algoritmo não aceito: ${cabecalho && cabecalho.alg}`);

  const chave = await chavePorKid(cabecalho.kid);
  if (!chave) throw new Error(`kid desconhecido: ${cabecalho.kid}`);
  // O JWT traz ECDSA como r||s cru; o Node espera DER se não avisarmos.
  const opcoes = String(cabecalho.alg).startsWith('ES') ? { key: chave, dsaEncoding: 'ieee-p1363' } : chave;
  if (!crypto.verify(hash, Buffer.from(`${h}.${p}`), opcoes, Buffer.from(s, 'base64url'))) {
    throw new Error('assinatura inválida');
  }

  const c = decodifica(p);
  const agora = Math.floor(Date.now() / 1000);
  if (c.iss !== TEAM) throw new Error(`emissor inesperado: ${c.iss}`);
  const aud = Array.isArray(c.aud) ? c.aud.map(String) : [String(c.aud)];
  if (!aud.includes(AUD)) throw new Error('token de outra aplicação Access');
  if (!Number.isFinite(Number(c.exp)) || Number(c.exp) + SKEW_SEG < agora) throw new Error('token expirado');
  if (c.nbf && Number(c.nbf) - SKEW_SEG > agora) throw new Error('token ainda não válido');
  if (c.iat && Number(c.iat) - SKEW_SEG > agora) throw new Error('token emitido no futuro');

  const email = String(c.email || '').toLowerCase().trim();
  // Token de serviço (automação) não tem e-mail: identifica uma máquina, não uma
  // pessoa, e virar sessão de usuário aqui seria escalada de privilégio.
  if (!EMAIL_RE.test(email)) throw new Error('token sem e-mail (token de serviço?)');

  return { email, sub: String(c.sub || ''), nome: String(c.name || c.given_name || '').trim() || nomeDoEmail(email) };
}

// Falha de verificação é ruído esperado (token vencido, aba velha). Loga uma vez
// por motivo a cada minuto para não afogar o journal num incidente.
const vistos = new Map();
function avisa(motivo) {
  const agora = Date.now();
  if (agora - (vistos.get(motivo) || 0) < 60000) return;
  vistos.set(motivo, agora);
  console.warn('[sso] token recusado:', motivo);
}

/**
 * Identidade verificada da requisição, ou null. Nunca lança: um token ruim
 * significa "não identificado", e o app cai no login por senha.
 */
async function identidade(req) {
  if (!ATIVO) return null;
  const bruto = req && req.headers && req.headers[CABECALHO];
  if (!bruto) return null;
  try {
    return await verificar(String(bruto).trim());
  } catch (e) {
    avisa(e.message);
    return null;
  }
}

/**
 * Sair do app não adianta se o Access continua autenticado: o próximo GET
 * re-loga na hora. Quem encerra a sessão do Access é esta URL.
 */
const urlDeLogout = () => (ATIVO ? `${TEAM}/cdn-cgi/access/logout` : null);

const resumo = () => (ATIVO
  ? `SSO: Cloudflare Access em ${TEAM} (aud ${AUD.slice(0, 8)}…)`
  : 'SSO: desligado (defina SSO_TEAM_DOMAIN e SSO_AUD) — login por senha');

module.exports = { ATIVO, TEAM, AUD, identidade, verificar, urlDeLogout, resumo, normalizaTeam, nomeDoEmail, CABECALHO };
