'use strict';

/*
 * Camada de autenticação do lado do cliente, compartilhada por todas as páginas
 * dos módulos (zOTC, MLC, Inventário, Infraestrutura).
 *
 *  1) Se qualquer chamada /api responder 401 (sessão expirada), manda pro login.
 *  2) Desenha o menu do usuário (nome, papel, atalho de admin, sair) no topbar.
 *  3) Marca a página como "somente leitura" quando o cliente selecionado é de
 *     acesso 'view' — o CSS esconde os controles com [data-requires-edit].
 *
 * Não depende de nada das páginas; conversa com elas só pelo #client-select e
 * pelo localStorage 'tfp.clientId'.
 */
(function () {
  const origFetch = window.fetch.bind(window);

  // 1) Sessão expirada em qualquer /api → volta pro login (menos as rotas de auth).
  window.fetch = async function (input, init) {
    const res = await origFetch(input, init);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (res.status === 401 && url.indexOf('/api/') !== -1 && url.indexOf('/api/auth/') === -1) {
        location.href = '/login?next=' + encodeURIComponent(location.pathname);
      }
    } catch (_) { /* ignora */ }
    return res;
  };

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const initials = (name, email) => {
    const base = (name || email || '?').trim();
    const parts = base.split(/\s+/).filter(Boolean);
    const chars = parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : base.slice(0, 2);
    return chars.toUpperCase();
  };

  const ICON = {
    chevron: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    admin: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 1.5l5 2v3.2c0 3.1-2.1 5.3-5 6.3-2.9-1-5-3.2-5-6.3V3.5l5-2Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M6 8l1.4 1.4L10.5 6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    logout: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 2.5H3.5A1.5 1.5 0 0 0 2 4v8a1.5 1.5 0 0 0 1.5 1.5H6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M10.5 11 14 8l-3.5-3M14 8H6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    eye: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8Z" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="1.8" stroke="currentColor" stroke-width="1.2"/></svg>',
  };

  let me = null;
  const levels = new Map(); // clientId -> 'admin' | 'edit' | 'view'

  async function loadMe() {
    try {
      const r = await origFetch('/api/auth/me');
      me = r.ok ? await r.json() : null;
    } catch (_) { me = null; }
    window.__me = me;
    return me;
  }

  async function loadLevels() {
    try {
      const r = await origFetch('/api/clients');
      if (!r.ok) return;
      const list = await r.json();
      levels.clear();
      list.forEach((c) => levels.set(String(c._id), c.accessLevel || null));
    } catch (_) { /* ignora */ }
  }

  function currentClientId() {
    const sel = document.getElementById('client-select');
    if (sel && sel.value) return sel.value;
    return localStorage.getItem('tfp.clientId') || null;
  }

  function applyViewOnly() {
    if (!me) return;
    // Admin nunca é somente-leitura.
    if (me.role === 'admin') { document.body.classList.remove('view-only'); return; }
    const id = currentClientId();
    const lvl = id ? levels.get(String(id)) : null;
    document.body.classList.toggle('view-only', lvl === 'view');
  }

  function renderMenu() {
    const host = document.querySelector('.topbar-actions')
      || document.querySelector('.topbar-inner')
      || document.querySelector('.tfp-topbar-inner');
    if (!host || !me) return;

    // Selo "somente leitura" (aparece só quando body.view-only).
    if (!document.querySelector('.readonly-badge')) {
      const badge = document.createElement('span');
      badge.className = 'readonly-badge';
      badge.innerHTML = ICON.eye + '<span>Somente leitura</span>';
      host.appendChild(badge);
    }

    if (document.querySelector('.user-menu')) return;
    const wrap = document.createElement('div');
    wrap.className = 'user-menu';
    const ini = initials(me.name, me.email);
    const roleLabel = me.role === 'admin' ? 'Administrador' : 'Usuário';
    wrap.innerHTML =
      '<button type="button" class="user-chip" id="ac-chip" aria-haspopup="menu" aria-expanded="false">'
      + '<span class="user-avatar">' + esc(ini) + '</span>'
      + '<span class="user-chip-text"><span class="user-chip-name">' + esc(me.name || me.email) + '</span>'
      + '<span class="user-chip-role">' + roleLabel + '</span></span>'
      + ICON.chevron + '</button>'
      + '<div class="user-pop hidden" id="ac-pop" role="menu">'
      + '<div class="user-pop-head"><span class="user-avatar lg">' + esc(ini) + '</span>'
      + '<div><strong>' + esc(me.name || '') + '</strong><span class="muted">' + esc(me.email) + '</span></div></div>'
      + (me.role === 'admin'
        ? '<a class="user-pop-item" href="/admin" role="menuitem">' + ICON.admin + 'Administração</a>'
        : '')
      + '<button type="button" class="user-pop-item danger" id="ac-logout" role="menuitem">' + ICON.logout + 'Sair</button>'
      + '</div>';
    host.appendChild(wrap);

    const chip = wrap.querySelector('#ac-chip');
    const pop = wrap.querySelector('#ac-pop');
    const toggle = (open) => {
      const show = open === undefined ? pop.classList.contains('hidden') : open;
      pop.classList.toggle('hidden', !show);
      chip.setAttribute('aria-expanded', String(show));
    };
    chip.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) toggle(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggle(false); });
    wrap.querySelector('#ac-logout').addEventListener('click', async () => {
      try { await origFetch('/api/auth/logout', { method: 'POST' }); } catch (_) {}
      location.href = '/';
    });
  }

  async function init() {
    await loadMe();
    if (!me) return; // o page-guard do servidor já redireciona; nada a montar
    document.body.classList.toggle('is-admin', me.role === 'admin');
    renderMenu();
    await loadLevels();
    applyViewOnly();
    // Reage à troca de cliente (o handler da página também roda; ordem não importa).
    const sel = document.getElementById('client-select');
    if (sel) sel.addEventListener('change', applyViewOnly);
    // Captura a seleção inicial assíncrona da página (popula o select depois do load).
    [250, 700, 1500].forEach((t) => setTimeout(applyViewOnly, t));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Exposto caso alguma página queira reaplicar manualmente.
  window.__authApplyViewOnly = applyViewOnly;
})();
