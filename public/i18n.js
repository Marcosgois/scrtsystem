'use strict';

/*
 * Tradução da interface — português (padrão), espanhol e inglês.
 *
 * COMO FUNCIONA, e por quê assim
 * ------------------------------
 * O próprio texto em português é a CHAVE. O dicionário (i18n-dict.js) mapeia
 * "texto em pt" -> ["texto em es", "texto em en"], e este motor aplica a troca
 * sobre o DOM por correspondência EXATA da string.
 *
 * A alternativa clássica — trocar cada texto por t('chave.alguma') — exigiria
 * reescrever as ~11 mil linhas de front (boa parte do HTML é montada em template
 * literal dentro do JS de cada módulo). A correspondência exata evita isso por
 * inteiro e traz três propriedades boas:
 *
 *   1. Degradação suave: o que não está no dicionário continua em português.
 *      Nunca aparece uma chave crua ("app.botao.salvar") na tela.
 *   2. Conteúdo dinâmico funciona: um MutationObserver traduz o que os módulos
 *      injetam depois (tabelas, modais, toasts).
 *   3. Dado do cliente não é afetado: só casa a FRASE INTEIRA, então nome de
 *      cliente, serial ("W0002TN"), PID e modelo ("3931-7C6") passam intactos.
 *
 * A troca de idioma recarrega a página de propósito: é mais barato e muito mais
 * seguro do que tentar desfazer traduções em estado já renderizado.
 */

(function () {
  var IDIOMAS = { pt: 'Português', es: 'Español', en: 'English' };
  var PADRAO = 'pt';
  var CHAVE = 'zcd.lang';
  var LANG_HTML = { pt: 'pt-BR', es: 'es', en: 'en' };
  // Índice da língua dentro do par [es, en] do dicionário.
  var COLUNA = { es: 0, en: 1 };

  function lerIdioma() {
    try {
      var v = localStorage.getItem(CHAVE);
      return IDIOMAS[v] ? v : PADRAO;
    } catch (e) { return PADRAO; }
  }

  var lang = lerIdioma();
  var dic = (window.ZCD_DICT || {});
  var col = COLUNA[lang];
  var ativo = lang !== PADRAO && col !== undefined;

  /** Traduz uma string solta. Devolve o próprio texto se não houver tradução. */
  function t(txt) {
    if (!ativo || !txt) return txt;
    var e = dic[txt];
    if (e && e[col]) return e[col];
    return porPadrao(String(txt).trim()) || txt;
  }

  // ── Aplicação sobre o DOM ────────────────────────────────────────────────
  // Não mexer no conteúdo destas tags (é código/dado, não texto de interface).
  var IGNORA_TAG = { SCRIPT: 1, STYLE: 1, CODE: 1, PRE: 1, TEXTAREA: 1, SVG: 1 };
  var ATRIBUTOS = ['placeholder', 'title', 'aria-label', 'alt'];

  function ignorar(el) {
    for (var n = el; n; n = n.parentElement) {
      if (IGNORA_TAG[n.tagName]) return true;
      if (n.hasAttribute && n.hasAttribute('data-no-i18n')) return true;
    }
    return false;
  }

  /*
   * Padrões: frases montadas com valor no meio ("25 mês(es) de histórico"), que
   * não casam por texto exato. Cada regra é [regex, es, en] e os grupos ($1, $2)
   * são preservados. Só são testadas quando a busca exata falha, e apenas em
   * textos curtos — assim uma tabela grande não paga o custo à toa.
   */
  var padroes = (window.ZCD_PATTERNS || []);

  function porPadrao(txt) {
    if (txt.length > 160) return null;
    for (var i = 0; i < padroes.length; i++) {
      var p = padroes[i];
      if (p[0].test(txt)) return txt.replace(p[0], p[col + 1]);
    }
    return null;
  }

  /** Traduz um nó de texto, preservando os espaços das pontas. */
  function traduzTexto(no) {
    var bruto = no.nodeValue;
    if (!bruto) return;
    var txt = bruto.trim();
    if (txt.length < 2) return;                 // "·", "—", números soltos
    var entrada = dic[txt];
    var novo = (entrada && entrada[col]) || porPadrao(txt);
    if (!novo) return;
    var i = bruto.indexOf(txt);
    no.nodeValue = bruto.slice(0, i) + novo + bruto.slice(i + txt.length);
  }

  function traduzAtributos(el) {
    for (var i = 0; i < ATRIBUTOS.length; i++) {
      var a = ATRIBUTOS[i];
      if (!el.hasAttribute || !el.hasAttribute(a)) continue;
      var v = el.getAttribute(a).trim();
      var novo = dic[v];
      if (novo && novo[col]) el.setAttribute(a, novo[col]);
    }
    // <input type="button|submit" value="Salvar">
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type || '')) {
      var vv = (el.value || '').trim();
      var nv = dic[vv];
      if (nv && nv[col]) el.value = nv[col];
    }
  }

  /** Percorre uma subárvore traduzindo textos e atributos. */
  function traduzArvore(raiz) {
    if (!ativo || !raiz) return;
    if (raiz.nodeType === 3) {                  // nó de texto solto
      if (raiz.parentElement && !ignorar(raiz.parentElement)) traduzTexto(raiz);
      return;
    }
    if (raiz.nodeType !== 1 && raiz.nodeType !== 9 && raiz.nodeType !== 11) return;
    if (raiz.nodeType === 1 && ignorar(raiz)) return;

    if (raiz.nodeType === 1) traduzAtributos(raiz);
    var els = raiz.querySelectorAll ? raiz.querySelectorAll('*') : [];
    for (var i = 0; i < els.length; i++) {
      if (!IGNORA_TAG[els[i].tagName]) traduzAtributos(els[i]);
    }

    var walker = document.createTreeWalker(raiz, NodeFilter.SHOW_TEXT, {
      acceptNode: function (no) {
        var p = no.parentElement;
        if (!p || IGNORA_TAG[p.tagName]) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    var lista = [];
    while (walker.nextNode()) lista.push(walker.currentNode);
    for (var j = 0; j < lista.length; j++) {
      if (!ignorar(lista[j].parentElement)) traduzTexto(lista[j]);
    }
  }

  // ── Conteúdo dinâmico: reaplica no que os módulos injetarem ──────────────
  var observador = null;
  function observar() {
    if (!ativo || observador || !window.MutationObserver) return;
    observador = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        for (var j = 0; j < m.addedNodes.length; j++) traduzArvore(m.addedNodes[j]);
      }
    });
    observador.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ── Troca de idioma ──────────────────────────────────────────────────────
  function setLang(novo) {
    if (!IDIOMAS[novo] || novo === lang) return;
    try { localStorage.setItem(CHAVE, novo); } catch (e) { /* sessão anônima */ }
    location.reload();   // recarrega: garante a tela inteira coerente no idioma novo
  }

  // ── Seletor de idioma ────────────────────────────────────────────────────
  // Injetado em qualquer elemento com [data-i18n-switcher]. `compacto` usa só a
  // sigla (PT/ES/EN), para caber no topbar.
  function montarSeletor(host) {
    if (!host || host.querySelector('.i18n-switch')) return;
    var compacto = host.hasAttribute('data-i18n-compact');
    var wrap = document.createElement('div');
    wrap.className = 'i18n-switch' + (compacto ? ' compact' : '');
    wrap.setAttribute('data-no-i18n', '');       // o seletor nunca se traduz
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Idioma / Idioma / Language');
    Object.keys(IDIOMAS).forEach(function (cod) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'i18n-opt' + (cod === lang ? ' active' : '');
      b.textContent = compacto ? cod.toUpperCase() : IDIOMAS[cod];
      b.title = IDIOMAS[cod];
      b.setAttribute('aria-pressed', String(cod === lang));
      b.addEventListener('click', function (e) { e.stopPropagation(); setLang(cod); });
      wrap.appendChild(b);
    });
    host.appendChild(wrap);
  }

  function montarSeletores() {
    var hosts = document.querySelectorAll('[data-i18n-switcher]');
    for (var i = 0; i < hosts.length; i++) montarSeletor(hosts[i]);
  }

  // ── Arranque ─────────────────────────────────────────────────────────────
  document.documentElement.setAttribute('lang', LANG_HTML[lang] || 'pt-BR');
  observar();                                   // começa cedo: pega o que for renderizado depois

  function pronto() {
    traduzArvore(document.body);
    if (ativo && document.title) document.title = t(document.title.trim());
    montarSeletores();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pronto);
  else pronto();

  window.i18n = {
    lang: lang,
    idiomas: IDIOMAS,
    t: t,
    setLang: setLang,
    traduzir: traduzArvore,      // para módulos que queiram forçar uma passada
    montarSeletores: montarSeletores,
  };
})();
