/* ==========================================================================
   Ponte TFPSystem — anexada pelo scripts/build-inventario.js
   ==========================================================================
   O painel de inventário é preservado como veio: parse, filtros, tabelas,
   modais e exportações continuam sendo o código original. Este script apenas
   redefine a camada de persistência para gravar no MongoDB via API, em vez de
   localStorage, e amarra o painel à lista de clientes do TFPSystem.

   Como funciona: declarações de função em <script> compartilham o escopo
   global, então as definições abaixo substituem as do painel (que já rodou).
   ========================================================================== */
(function () {
  'use strict';

  const ACTIVE_KEY = 'tfp_inventario_ultimo_cliente';

  // Cache em memória: clientId (TFPSystem) -> { clientName, customerNumber, updatedAt, products, pairOverrides }
  const invStore = {};
  window.tfpClients = [];

  // Cliente na tela e seus ajustes manuais de par Licença↔S&S.
  let activeClientId = null;
  let pairOverrides = []; // [{ ssPid, licPid|null }]

  async function invApi(path, opts = {}) {
    const res = await fetch(`/api${path}`, opts);
    let body = null;
    try { body = await res.json(); } catch (e) { /* sem corpo */ }
    if (!res.ok) throw new Error((body && body.error) || `Erro ${res.status}`);
    return body;
  }

  function showBanner(messages) {
    document.querySelectorAll('.tfp-banner').forEach((b) => b.remove());
    if (!messages || !messages.length) return;
    const div = document.createElement('div');
    div.className = 'tfp-banner';
    div.textContent = messages.join(' · ');
    const container = document.querySelector('.container');
    if (container) container.prepend(div);
  }

  function setBadge(visible) {
    const badge = document.getElementById('savedStorageBadge');
    if (!badge) return;
    badge.innerText = 'Salvo no banco';
    badge.style.display = visible ? 'inline-block' : 'none';
  }

  function selectedClientId() {
    const sel = document.getElementById('selectCustomer');
    const v = sel ? sel.value : '';
    return v && v !== 'ADD_NEW' && v !== 'NEW_LOAD' ? v : null;
  }

  // ── Persistência (substitui as funções do painel) ────────────────────────

  /** O painel chama isto sem clientId; usamos o cliente escolhido no seletor. */
  window.saveCustomerInventory = async function (client, products, updatedAt, sourceFileName) {
    const clientId = selectedClientId();
    if (!clientId) {
      alert('Selecione o cliente do TFPSystem antes de carregar o inventário.');
      return null;
    }
    const result = await invApi(`/clients/${clientId}/inventory`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientName: client.name,
        customerNumber: client.number,
        products,
        reportUpdatedAt: updatedAt,
        sourceFileName: sourceFileName || null,
      }),
    });
    invStore[clientId] = {
      clientName: client.name,
      customerNumber: client.number,
      updatedAt,
      products,
      // O PUT do inventário não mexe nos ajustes manuais; preserva o que havia.
      pairOverrides: (invStore[clientId] && invStore[clientId].pairOverrides) || [],
    };
    setBadge(true);
    return result;
  };

  /** Lista os clientes do TFPSystem, marcando quais já têm inventário. */
  window.populateCustomerDropdown = async function (selectedClientId = null) {
    const select = document.getElementById('selectCustomer');
    if (!select) return;
    let inventories = [];
    try {
      const [clients, invs] = await Promise.all([invApi('/clients'), invApi('/inventories')]);
      window.tfpClients = clients;
      inventories = invs;
    } catch (err) {
      select.innerHTML = '<option value="">-- erro ao carregar clientes --</option>';
      showBanner([`Não foi possível falar com o servidor: ${err.message}`]);
      return;
    }

    const byClient = new Map(inventories.map((i) => [String(i.client && i.client._id), i]));
    select.innerHTML = '';

    const optDefault = document.createElement('option');
    optDefault.value = '';
    optDefault.innerText = window.tfpClients.length
      ? '-- Selecione o cliente --'
      : '-- Nenhum cliente cadastrado (cadastre no módulo de Consumo) --';
    select.appendChild(optDefault);

    window.tfpClients.forEach((c) => {
      const inv = byClient.get(String(c._id));
      const opt = document.createElement('option');
      opt.value = c._id;
      opt.innerText = inv
        ? `${c.name} — ${inv.productCount} produtos${inv.customerNumber ? ` (No. ${inv.customerNumber})` : ''}`
        : `${c.name} — sem inventário`;
      select.appendChild(opt);
    });

    const target = selectedClientId || localStorage.getItem(ACTIVE_KEY);
    if (target && window.tfpClients.some((c) => String(c._id) === String(target))) {
      select.value = target;
      await window.loadCustomerData(target);
    } else {
      select.value = '';
      showEmptyState();
    }
  };

  /** Carrega o inventário do cliente (cache em memória ou banco). */
  window.loadCustomerData = async function (clientId) {
    showBanner(null);
    let item = invStore[clientId];
    if (!item) {
      try {
        const inv = await invApi(`/clients/${clientId}/inventory`);
        item = {
          clientName: inv.clientName || 'Não Identificado',
          customerNumber: inv.customerNumber || 'Não Identificado',
          updatedAt: inv.reportUpdatedAt || new Date(inv.updatedAt).toLocaleString('pt-BR'),
          products: normalizeProducts(inv.products || []),
          pairOverrides: inv.pairOverrides || [],
        };
        invStore[clientId] = item;
        if (inv.warnings && inv.warnings.length) showBanner(inv.warnings);
      } catch (err) {
        showEmptyState(); // 404 = cliente ainda sem inventário
        return;
      }
    }
    activeClientId = clientId;
    pairOverrides = item.pairOverrides || [];
    globalInventoryData = item.products;
    clientInfo = { name: item.clientName, number: item.customerNumber };
    displayInventory(clientInfo, globalInventoryData, item.updatedAt);
    setBadge(true);
  };

  window.onCustomerSelectChanged = function () {
    const val = document.getElementById('selectCustomer').value;
    if (!val) { showEmptyState(); return; }
    if (val === 'ADD_NEW' || val === 'NEW_LOAD') {
      showEmptyState();
      document.getElementById('fileInputInventario').click();
      return;
    }
    localStorage.setItem(ACTIVE_KEY, val);
    window.loadCustomerData(val);
  };

  window.goHome = function () {
    const select = document.getElementById('selectCustomer');
    if (select) select.value = '';
    localStorage.removeItem(ACTIVE_KEY);
    showEmptyState();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  /** Exclui o inventário do cliente no banco (não apaga o cliente). */
  window.deleteActiveCustomerRecord = async function () {
    const clientId = selectedClientId();
    if (!clientId) { alert('Nenhum cliente selecionado.'); return; }
    const item = invStore[clientId];
    const nome = item ? item.clientName : 'este cliente';
    if (!confirm(`Excluir o inventário de "${nome}" do banco de dados?\n\nO cliente continua cadastrado; apenas o inventário é removido.`)) return;
    try {
      await invApi(`/clients/${clientId}/inventory`, { method: 'DELETE' });
    } catch (err) {
      alert(`Falha ao excluir: ${err.message}`);
      return;
    }
    delete invStore[clientId];
    localStorage.removeItem(ACTIVE_KEY);
    await window.populateCustomerDropdown(null);
    window.goHome();
  };

  // Não é mais usado (dados vêm da API), mas o painel pode chamá-lo.
  window.getStoredInventories = function () { return invStore; };

  // ── Link para o IBM ProductPages (w3) ────────────────────────────────────
  // O portal exige sessão w3 (SSO) e não libera CORS, então não dá para trazer
  // os dados (equipe, EOS, GA, carta de anúncio) para cá automaticamente.
  // A alternativa é abrir a página do PID, onde o usuário já está autenticado.

  const W3_PRODUCT_PAGE = 'https://w3.ibm.com/systems/productpages/index.html?pid=';

  const ICON_EXTERNAL =
    '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true" style="margin-left:2px">' +
    '<path d="M6.5 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V9.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' +
    '<path d="M9.5 2H14v4.5M14 2 7.5 8.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /** PID exibido no modal (o painel preenche #mdlPidCode / #mdlTitle). */
  function currentModalPid() {
    const el = document.getElementById('mdlPidCode');
    const fromCode = el && el.innerText ? el.innerText.trim() : '';
    if (/^[A-Z0-9]{6,8}$/i.test(fromCode)) return fromCode;
    const title = (document.getElementById('mdlTitle') || {}).innerText || '';
    const m = title.match(/\b([0-9]{4}[A-Z0-9]{3})\b/i);
    return m ? m[1] : '';
  }

  /** Insere no modal o link para a página do produto no w3. */
  function injectW3Link() {
    const pid = currentModalPid();
    const anchor = document.getElementById('mdlAnnouncementCsolLink');
    if (!pid || !anchor || !anchor.parentNode) return;

    let link = document.getElementById('tfpW3ProductLink');
    if (!link) {
      link = document.createElement('a');
      link.id = 'tfpW3ProductLink';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.style.cssText =
        'color:var(--ibm-blue); font-size:0.85rem; font-weight:600; text-decoration:none;' +
        'display:inline-flex; align-items:center; gap:4px;';
      anchor.parentNode.insertBefore(link, anchor);
    }
    link.href = W3_PRODUCT_PAGE + encodeURIComponent(pid);
    link.title = `Abrir ${pid} no IBM ProductPages (equipe, EOS, GA, carta de anúncio)`;
    link.innerHTML = `Ver ${pid} no IBM ProductPages${ICON_EXTERNAL}`;
  }

  // Envolve a função do painel: abre o modal como sempre e acrescenta o link.
  const originalOpenProductModal = window.openProductModal;
  if (typeof originalOpenProductModal === 'function') {
    window.openProductModal = function () {
      const r = originalOpenProductModal.apply(this, arguments);
      try { injectW3Link(); } catch (e) { /* não impede o modal de abrir */ }
      return r;
    };
  }

  // ── Upload: exige cliente selecionado e grava no banco ───────────────────
  // Substitui os listeners do painel clonando os elementos.
  function rebindUpload() {
    const oldInput = document.getElementById('fileInputInventario');
    const oldBtn = document.getElementById('btnCarregarInventario');
    if (!oldInput) return;

    const input = oldInput.cloneNode(true);
    oldInput.parentNode.replaceChild(input, oldInput);
    if (oldBtn) {
      const btn = oldBtn.cloneNode(true);
      oldBtn.parentNode.replaceChild(btn, oldBtn);
      btn.addEventListener('click', () => {
        if (!selectedClientId()) {
          alert('Selecione primeiro o cliente para o qual este inventário será salvo.');
          if (typeof focarSeletorCliente === 'function') focarSeletorCliente();
          return;
        }
        input.click();
      });
    }

    input.addEventListener('change', function () {
      const file = this.files[0];
      this.value = '';
      if (!file) return;

      const clientId = selectedClientId();
      if (!clientId) {
        alert('Selecione primeiro o cliente para o qual este inventário será salvo.');
        if (typeof focarSeletorCliente === 'function') focarSeletorCliente();
        return;
      }

      const reader = new FileReader();
      reader.onload = async function (evt) {
        let parsed;
        try {
          parsed = parseIBMLicenseReport(evt.target.result);
        } catch (err) {
          alert(`Não foi possível interpretar o inventário: ${err.message}`);
          return;
        }
        if (!parsed.products || !parsed.products.length) {
          alert('O arquivo foi lido, mas nenhum produto foi encontrado. Confira se é o relatório IBM SW Material.');
          return;
        }
        normalizeProducts(parsed.products); // grava já limpo e classificado

        const updatedAt = new Date().toLocaleString('pt-BR');
        let saved;
        try {
          saved = await window.saveCustomerInventory(parsed.client, parsed.products, updatedAt, file.name);
        } catch (err) {
          alert(`Falha ao salvar o inventário: ${err.message}`);
          return;
        }
        if (!saved) return;
        showBanner(saved.warnings);

        globalInventoryData = parsed.products;
        clientInfo = parsed.client;
        await window.populateCustomerDropdown(clientId);
      };
      reader.readAsText(file);
    });
  }

  // ── Tooltip dos status de inventário (iERP S/4HANA) ──────────────────────
  // Passar o mouse sobre o código de status (ECUS, AVLB, INAC, ECUS SLBP…)
  // mostra o significado. Definições internas do iERP.

  const STATUS_INFO = {
    ECUS: { t: 'ECUS', d: 'Produto ativo.' },
    AVLB: { t: 'AVLB', d: 'Produto reservado (booked), mas ainda não entregue.' },
    INAC: { t: 'INAC', d: 'Produto inativo (foi removido).' },
    ESTO: { t: 'ESTO', d: 'Relacionado a remoção pendente — ver "ECUS ESTO YREM".' },
    YREM: { t: 'YREM', d: 'Relacionado a remoção pendente — ver "ECUS ESTO YREM".' },
    QUBP: {
      t: 'QUBP',
      d: 'Há uma cotação não processada no histórico da licença. Sem efeito negativo — a Techline ainda pode configurar outra cotação ou bump. Quando a cotação é processada ou rejeitada, o QUBP some. (Pode haver restrição para criar configuração de bump no Danube.)',
    },
    SLBP: {
      t: 'SLBP',
      d: 'Há um pedido incompleto no histórico da licença, impedindo o bump (na GUI ou no CFSW/Techline). "Incompleto" pode significar:',
      bullets: [
        'O pedido está realmente incompleto — falta alguma informação obrigatória (ex.: erro de preço, nº de segmento de lucro). Some quando o pedido é completado.',
        'Um pedido com entrega ainda não foi totalmente entregue. Some quando o status muda para totalmente entregue.',
        'A licença pode ter ECUS SLBP sem nenhuma das condições acima — o status pode ter vindo copiado do CBS. Corrige-se na IQ02 com acesso de super-usuário.',
      ],
    },
    'ECUS ESTO YREM': { t: 'ECUS ESTO YREM', d: 'Produto ativo, mas aguardando remoção.' },
    'AVLB INAC': { t: 'AVLB INAC', d: 'Produto não foi entregue e foi rejeitado.' },
    'ECUS QUBP': null, // usa a definição de QUBP
    'ECUS SLBP': null, // usa a definição de SLBP
    'ECUS INAC': {
      t: 'ECUS INAC',
      d: 'Produto ativo que foi rejeitado — está errado. Corrigir no iERP S/4HANA criando um pedido de remoção ou excluindo a rejeição.',
    },
  };
  STATUS_INFO['ECUS QUBP'] = { t: 'ECUS QUBP', d: STATUS_INFO.QUBP.d };
  STATUS_INFO['ECUS SLBP'] = { t: 'ECUS SLBP', d: STATUS_INFO.SLBP.d, bullets: STATUS_INFO.SLBP.bullets };

  const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /** Descreve um texto de status (simples, composto, ou lista separada por vírgula). */
  function describeStatus(text) {
    const norm = String(text || '').trim().toUpperCase().replace(/\s+/g, ' ');
    if (!norm || norm === '-') return null;
    if (STATUS_INFO[norm]) return [STATUS_INFO[norm]];

    // Consolidado: vários status separados por vírgula ("ECUS, AVLB").
    if (norm.includes(',')) {
      const parts = norm.split(',').map((p) => p.trim()).filter(Boolean);
      const infos = parts.map((p) => STATUS_INFO[p] || tokensInfo(p)).flat().filter(Boolean);
      return infos.length ? infos : null;
    }
    return tokensInfo(norm);
  }

  /** Combinação desconhecida: explica cada código conhecido que aparece. */
  function tokensInfo(norm) {
    const infos = norm.split(' ').map((tok) => STATUS_INFO[tok]).filter(Boolean);
    return infos.length ? infos : null;
  }

  function statusTooltipHtml(infos) {
    return infos.map((i) => {
      const bullets = i.bullets ? `<ul>${i.bullets.map((b) => `<li>${escHtml(b)}</li>`).join('')}</ul>` : '';
      return `<div class="tfp-tip-item"><span class="tfp-tip-code">${escHtml(i.t)}</span>${escHtml(i.d)}${bullets}</div>`;
    }).join('');
  }

  function setupStatusTooltips() {
    if (document.getElementById('tfp-status-tip')) return;
    const tip = document.createElement('div');
    tip.id = 'tfp-status-tip';
    tip.className = 'tfp-status-tip';
    tip.style.display = 'none';
    document.body.appendChild(tip);

    let current = null;

    const position = (badge) => {
      const r = badge.getBoundingClientRect();
      tip.style.display = 'block';
      const tr = tip.getBoundingClientRect();
      let left = r.left + window.scrollX;
      let top = r.bottom + window.scrollY + 6;
      // Mantém dentro da tela (horizontal) e mostra acima se não couber abaixo.
      const maxLeft = window.scrollX + document.documentElement.clientWidth - tr.width - 10;
      if (left > maxLeft) left = Math.max(window.scrollX + 10, maxLeft);
      if (r.bottom + tr.height + 12 > document.documentElement.clientHeight) {
        top = r.top + window.scrollY - tr.height - 6;
      }
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
    };

    const statusBadge = (el) => {
      const badge = el && el.closest && el.closest('.badge');
      if (!badge || badge.classList.contains('badge-lic') || badge.classList.contains('badge-ss')) return null;
      return describeStatus(badge.textContent) ? badge : null;
    };

    document.addEventListener('mouseover', (e) => {
      const badge = statusBadge(e.target);
      if (!badge || badge === current) return;
      current = badge;
      tip.innerHTML = statusTooltipHtml(describeStatus(badge.textContent));
      position(badge);
    });
    document.addEventListener('mouseout', (e) => {
      if (!current) return;
      const to = e.relatedTarget;
      if (to && current.contains(to)) return;
      current = null;
      tip.style.display = 'none';
    });
    // Fecha ao rolar (a posição fixa ficaria deslocada).
    window.addEventListener('scroll', () => { if (current) { current = null; tip.style.display = 'none'; } }, true);
  }

  // ── Classificação Licença × S&S ──────────────────────────────────────────
  // O painel marca como S&S qualquer descrição que contenha "SUPP", e isso
  // pega licenças cujo nome tem "Support": "IMS ETO Support", "Tivoli Decision
  // Support", "Device Supp Facilities (ICKDSF)". Aqui só valem os marcadores
  // inequívocos de Subscription & Support.

  /** "S&S" (inclusive colado, "VerifierS&S"), "Subscription…" ou "SNS". */
  function isSupportItem(desc) {
    const u = String(desc || '').toUpperCase();
    // O (?![A-Z0-9]) evita casar o "S&S" de dentro de "TOOLS&SERVICES".
    return /S\s*&\s*S(?![A-Z0-9])/.test(u) || u.includes('SUBSCRIPTION') || /\bSNS\b/.test(u);
  }

  /**
   * Arruma os produtos recém-carregados — vale também para o que já está
   * gravado, porque roda a cada carga:
   *  - recalcula a categoria (Licença × S&S);
   *  - troca NBSP (char 160) por espaço comum. O relatório da IBM vem cheio
   *    deles, e por isso buscar "Data Gate" não achava "Data Gate for z/OS"
   *    nem aqui nem no campo de busca do painel.
   */
  function normalizeProducts(products) {
    const limpa = (s) => String(s == null ? '' : s).replace(/[ \s]+/g, ' ').trim();
    (products || []).forEach((p) => {
      p.description = limpa(p.description);
      p.status = limpa(p.status);
      (p.features || []).forEach((f) => {
        f.description = limpa(f.description);
        f.metric = limpa(f.metric);
      });
      p.category = isSupportItem(p.description) ? 'SS' : 'LICENCE';
    });
    return products || [];
  }

  // ── Licença ↔ S&S: traz o suporte junto da licença ───────────────────────
  // Nos relatórios ESW da IBM a licença e o seu S&S NUNCA compartilham o mesmo
  // PID (ex.: 5698DG3 "Data Gate for z/OS" ↔ 5698DGS "Data Gate for z/OS S&S"),
  // então o casamento usa dois sinais: a família do produto (descrição sem os
  // marcadores de S&S) e o par Effective Date + Config Value. Em "Tipo de
  // Licença: Todos", o S&S casado é desenhado logo abaixo da sua licença, para
  // mostrar que, além da licença, o cliente tem suporte para aquele produto.

  const FAM_STOPWORDS = new Set(['for', 'and', 'the', 'of', 'ibm', 'zos', 'os', 'sw', 'v', 'ver', 'version', 'tiv', 'tivoli']);
  const FAM_MIN = 0.6; // semelhança mínima de família para casar sem data/quantidade
  const FAM_WEAK = 0.3; // piso de família mesmo quando data e quantidade batem

  /** Acrescenta um valor à lista da chave (usado pelos índices e pelos pares). */
  function push(map, k, v) {
    if (!k) return;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(v);
  }

  /**
   * Identidade de um registro. PID + SW Serial, porque o serial se repete
   * entre PIDs diferentes (na CAIXA há 49 seriais repetidos).
   */
  function recKey(p) {
    return `${p.productId}|${p.swSerial}`;
  }

  /** Quantidade do produto: soma dos Config Values das features. */
  function configTotal(p) {
    return (p.features || []).reduce((a, f) => a + (f.numericValue || 0), 0);
  }

  /** Tokens da família: tira marcadores de S&S, versões e palavras de ruído. */
  function familyTokens(desc) {
    return String(desc || '').toLowerCase()
      .replace(/subscription\s*&\s*support/g, ' ')
      .replace(/\bs\s*&\s*s\b/g, ' ')
      .replace(/\b(sns|supp|support|subscription)\b/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      // Fora: letras soltas ("z" de z/VM, z/OS), que inflariam a semelhança
      // ("z/VM" casaria com "OMEGAMON z/VM S&S"), e números de versão soltos
      // ou no formato "v2"/"v13" — a licença traz a versão e o S&S não.
      .filter((t) => t.length > 1 && !/^\d+$/.test(t) && !/^v\d+$/.test(t) && !FAM_STOPWORDS.has(t));
  }

  /**
   * Peso de cada token pela raridade (IDF) no inventário do cliente.
   * Sem isso, o "ruído" comum a muitos produtos ("db2", "solution", "pack")
   * casaria "DB2 Perform Solution Pack" com "DB2 Utilities Sol Pack S&S" —
   * produtos diferentes. O que distingue são justamente os tokens raros.
   */
  function buildTokenWeights(data) {
    const df = new Map();
    data.forEach((p) => {
      new Set(familyTokens(p.description)).forEach((t) => df.set(t, (df.get(t) || 0) + 1));
    });
    const n = data.length || 1;
    const w = new Map();
    df.forEach((freq, t) => w.set(t, Math.log((n + 1) / (freq + 1))));
    return w;
  }

  /**
   * Compara duas famílias. Devolve { score, blocked }:
   *  - score 0..1 ponderado por raridade (token igual ou prefixo do outro,
   *    para abreviações como "Comparison"/"Comp", "Solution"/"Sol");
   *  - blocked: um termo distintivo aparece de um lado e não do outro, o que
   *    denuncia produtos diferentes ("DB2 *Utilities* Sol Pack" não é
   *    "DB2 *Admin* Sol Pack", ainda que o resto da descrição coincida).
   */
  function compareFamily(a, b, weights, distinctiveMin) {
    if (!a.length || !b.length) return { score: 0, blocked: true };
    const w = (t) => {
      const v = weights.get(t);
      return v === undefined ? 1 : v;
    };
    const casa = (ta, tb) => ta === tb
      || (ta.length >= 3 && tb.length >= 3 && (ta.startsWith(tb) || tb.startsWith(ta)));

    const usedB = new Set();
    const missA = [];
    let matched = 0;
    for (const ta of a) {
      let hit = -1;
      for (let i = 0; i < b.length; i++) {
        if (!usedB.has(i) && casa(ta, b[i])) { hit = i; break; }
      }
      if (hit < 0) missA.push(ta);
      else {
        usedB.add(hit);
        matched += Math.min(w(ta), w(b[hit])); // abreviação: fica com o menor peso
      }
    }
    const missB = b.filter((_, i) => !usedB.has(i));

    const sum = (list) => list.reduce((acc, t) => acc + w(t), 0);
    const denom = Math.max(sum(a), sum(b));
    // Descrições feitas só de termos comuns (peso ~0): cai na contagem simples.
    const score = denom < 0.01 ? usedB.size / Math.max(a.length, b.length) : matched / denom;

    // Dois vetos, que pegam erros de naturezas diferentes:
    //  1) sobrou um termo raro de um lado só — "z/VM" não é "OMEGAMON z/VM";
    //  2) sobrou termo dos DOIS lados — "IMS HP Unload" não é "DB2 HP Unload".
    //     Aqui o peso não denuncia: "ims" e "db2" são comuns no inventário,
    //     mas são exatamente o que separa um produto do outro.
    const raroSobrando = missA.concat(missB).some((t) => w(t) >= distinctiveMin);
    const sobraDosDoisLados = missA.length > 0 && missB.length > 0;
    return { score, blocked: raroSobrando || sobraDosDoisLados };
  }

  /**
   * Casa REGISTRO a REGISTRO, 1 para 1.
   *
   * Um PID de S&S costuma ter dezenas de registros (bumps e renovações), cada
   * um com o seu Config Value: o 5655E90 da CAIXA tem 37. Pendurar todos numa
   * licença daria a impressão de que o produto tem vários S&S, o que não é o
   * caso — cada registro de licença tem o SEU registro de S&S.
   *
   * Regra: mesmo Config Value (exato, obrigatório) + nome compatível. A mesma
   * Eff. Date é desempate, não requisito. Cada registro de S&S é usado uma vez.
   * Ex.: 5655DT2 (cfg 477 e cfg 8164) casa com os dois registros do 5655E90
   * que têm exatamente esses valores — e só com eles.
   *
   * Devolve { byLic: Map(registroLicença -> {rec, basis}), usedSs: Set }.
   */
  function pairLicenceWithSS(data) {
    const licRecs = data.filter((p) => p.category !== 'SS');
    const ssRecs = data.filter((p) => p.category === 'SS');
    const par = { byLic: new Map(), usedSs: new Set() };
    if (!licRecs.length || !ssRecs.length) return applyOverrides(par, licRecs, ssRecs);

    const weights = buildTokenWeights(data);
    // Acima deste peso, o termo identifica o produto (aparece em poucos itens).
    const distinctiveMin = 0.45 * Math.log(data.length + 1);

    // Índice dos S&S pelo Config Value — é o eixo obrigatório do casamento.
    const ssPorCfg = new Map();
    ssRecs.forEach((s) => push(ssPorCfg, configTotal(s), s));

    const cacheTokens = new Map();
    const tokensDe = (p) => {
      if (!cacheTokens.has(p.productId)) cacheTokens.set(p.productId, familyTokens(p.description));
      return cacheTokens.get(p.productId);
    };
    const mesmaData = (a, b) => {
      const x = String(a.effDate || '').trim();
      return x !== '' && x !== '-' && x === String(b.effDate || '').trim();
    };

    // Duas passadas: primeiro quem também bate a data (evidência mais forte),
    // para que esses pares não sejam "roubados" por um registro de outra data.
    [true, false].forEach((exigirData) => {
      licRecs.forEach((l) => {
        if (par.byLic.has(l)) return;
        const cfg = configTotal(l);
        if (!cfg) return; // sem Config Value não há o que casar
        let melhor = null;
        (ssPorCfg.get(cfg) || []).forEach((s) => {
          if (par.usedSs.has(s)) return; // 1:1
          const comData = mesmaData(s, l);
          if (exigirData && !comData) return;
          const fam = compareFamily(tokensDe(s), tokensDe(l), weights, distinctiveMin);
          if (fam.blocked || fam.score < FAM_MIN) return;
          if (!melhor || fam.score > melhor.score) melhor = { rec: s, score: fam.score, comData };
        });
        if (!melhor) return;
        par.usedSs.add(melhor.rec);
        par.byLic.set(l, {
          rec: melhor.rec,
          basis: melhor.comData
            ? 'mesmo Config Value, mesma Eff. Date e nome compatível'
            : 'mesmo Config Value e nome compatível',
        });
      });
    });

    return applyOverrides(par, licRecs, ssRecs);
  }

  /**
   * Ajustes manuais vencem o automático. Identidade do registro = PID + SW
   * Serial: o serial sozinho não serve, porque se repete entre PIDs diferentes
   * (na CAIXA, W00011K é 5698A50 e também 5770AF4).
   */
  function applyOverrides(par, licRecs, ssRecs) {
    if (!pairOverrides.length) return par;
    const ajuste = new Map(pairOverrides.map((o) => [
      `${o.ssPid}|${o.ssSerial}`,
      o.licPid && o.licSerial ? `${o.licPid}|${o.licSerial}` : null,
    ]));

    // Solta os pares automáticos que envolvem um S&S ajustado.
    [...par.byLic.entries()].forEach(([l, m]) => {
      if (ajuste.has(recKey(m.rec))) {
        par.byLic.delete(l);
        par.usedSs.delete(m.rec);
      }
    });

    const ssPorChave = new Map(ssRecs.map((s) => [recKey(s), s]));
    const licPorChave = new Map(licRecs.map((l) => [recKey(l), l]));

    // Refaz os que o usuário mandou casar (licença nula = "não casar").
    ajuste.forEach((chaveLic, chaveSs) => {
      if (!chaveLic) return;
      const s = ssPorChave.get(chaveSs);
      const l = licPorChave.get(chaveLic);
      if (!s || !l) return; // registro saiu do inventário ou do filtro atual
      const anterior = par.byLic.get(l); // 1:1 — a licença solta o par antigo
      if (anterior) par.usedSs.delete(anterior.rec);
      par.byLic.set(l, { rec: s, basis: 'ajuste manual', manual: true });
      par.usedSs.add(s);
    });
    return par;
  }

  /** Grava os ajustes no banco e redesenha. */
  async function savePairOverrides() {
    if (!activeClientId) return;
    try {
      const r = await invApi(`/clients/${activeClientId}/inventory/pairs`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairOverrides }),
      });
      pairOverrides = r.pairOverrides || [];
      if (invStore[activeClientId]) invStore[activeClientId].pairOverrides = pairOverrides;
    } catch (err) {
      alert(`Não foi possível salvar o ajuste: ${err.message}`);
      return;
    }
    renderAllTables();
  }

  /**
   * Define (ou remove) o ajuste de um registro de S&S.
   * `lic` = registro de licença, `null` para não casar, `undefined` para
   * apagar o ajuste e voltar ao automático.
   */
  function setOverride(ssPid, ssSerial, lic) {
    pairOverrides = pairOverrides.filter((o) => !(o.ssPid === ssPid && o.ssSerial === ssSerial));
    // 1:1 — se essa licença já estava presa a outro S&S à mão, solta o anterior.
    if (lic) {
      pairOverrides = pairOverrides.filter(
        (o) => !(o.licPid === lic.productId && o.licSerial === lic.swSerial)
      );
    }
    if (lic !== undefined) {
      pairOverrides.push({
        ssPid,
        ssSerial,
        licPid: lic ? lic.productId : null,
        licSerial: lic ? lic.swSerial : null,
      });
    }
    savePairOverrides();
  }

  window.tfpUnpairSS = function (evt, ssPid, ssSerial) {
    evt.stopPropagation();
    setOverride(ssPid, ssSerial, null); // não casa com ninguém
  };

  window.tfpAutoPairSS = function (evt, ssPid, ssSerial) {
    evt.stopPropagation();
    setOverride(ssPid, ssSerial, undefined); // sem ajuste = volta ao automático
  };

  window.tfpPickLicence = function (evt, ssPid, ssSerial) {
    evt.stopPropagation();
    openPairPicker(ssPid, ssSerial);
  };

  // ── Seletor da licença (usado pelo botão "Casar…") ───────────────────────

  let pickerSs = null;

  function ensurePairPicker() {
    if (document.getElementById('tfp-pair-modal')) return;
    const el = document.createElement('div');
    el.id = 'tfp-pair-modal';
    el.className = 'tfp-pair-modal';
    el.style.display = 'none';
    el.innerHTML =
      '<div class="tfp-pair-box" role="dialog" aria-modal="true" aria-labelledby="tfp-pair-title">'
      + '<h3 id="tfp-pair-title">Casar S&amp;S com uma licença</h3>'
      + '<p class="tfp-pair-sub" id="tfp-pair-sub"></p>'
      + '<input type="text" id="tfp-pair-search" placeholder="Buscar por PID ou descrição" autocomplete="off">'
      + '<div class="tfp-pair-list" id="tfp-pair-list"></div>'
      + '<div class="tfp-pair-actions"><button type="button" class="tfp-pair-btn" id="tfp-pair-cancel">Cancelar</button></div>'
      + '</div>';
    document.body.appendChild(el);

    el.addEventListener('click', (e) => { if (e.target === el) closePairPicker(); });
    document.getElementById('tfp-pair-cancel').addEventListener('click', closePairPicker);
    document.getElementById('tfp-pair-search').addEventListener('input', renderPairOptions);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && el.style.display !== 'none') closePairPicker();
    });
  }

  function openPairPicker(ssPid, ssSerial) {
    ensurePairPicker();
    const s = (globalInventoryData || []).find(
      (p) => p.productId === ssPid && p.swSerial === ssSerial
    );
    pickerSs = s || null;
    document.getElementById('tfp-pair-sub').textContent = s
      ? `${s.productId} · serial ${s.swSerial} · ${s.effDate || 's/ data'} · Config Value ${configTotal(s)} — ${s.description}`
      : ssSerial;
    const busca = document.getElementById('tfp-pair-search');
    busca.value = '';
    renderPairOptions();
    document.getElementById('tfp-pair-modal').style.display = 'flex';
    busca.focus();
  }

  function closePairPicker() {
    const el = document.getElementById('tfp-pair-modal');
    if (el) el.style.display = 'none';
    pickerSs = null;
  }

  const MAX_OPCOES = 60;

  function renderPairOptions() {
    const termo = (document.getElementById('tfp-pair-search').value || '').trim().toLowerCase();
    const alvoCfg = pickerSs ? configTotal(pickerSs) : null;

    // Lista REGISTROS de licença (não PIDs): o par é registro a registro.
    let lista = (globalInventoryData || []).filter((p) => p.category !== 'SS');
    if (termo) {
      lista = lista.filter((p) =>
        p.productId.toLowerCase().includes(termo)
        || String(p.description || '').toLowerCase().includes(termo)
        || String(p.swSerial || '').toLowerCase().includes(termo));
    }
    // Os de Config Value igual ao do S&S vêm primeiro — é o par provável.
    lista.sort((a, b) => {
      const ia = configTotal(a) === alvoCfg ? 0 : 1;
      const ib = configTotal(b) === alvoCfg ? 0 : 1;
      if (ia !== ib) return ia - ib;
      return String(a.description).localeCompare(String(b.description), 'pt-BR');
    });

    const el = document.getElementById('tfp-pair-list');
    el.innerHTML = lista.slice(0, MAX_OPCOES).map((p) => {
      const cfg = configTotal(p);
      const igual = cfg === alvoCfg;
      return `<button type="button" class="tfp-pair-opt" data-key="${escHtml(recKey(p))}">`
        + `<strong>${escHtml(p.productId)}</strong>`
        + `<span>${escHtml(p.description)}</span>`
        + `<em class="tfp-pair-cfg${igual ? ' igual' : ''}" title="${igual ? 'Config Value igual ao do S&S' : 'Config Value diferente do S&S'}">`
        + `${escHtml(p.swSerial)} · ${escHtml(p.effDate || 's/ data')} · cfg ${cfg}</em></button>`;
    }).join('') || '<p class="tfp-pair-empty">Nenhuma licença encontrada.</p>';
    if (lista.length > MAX_OPCOES) {
      el.insertAdjacentHTML('beforeend',
        `<p class="tfp-pair-empty">Mostrando ${MAX_OPCOES} de ${lista.length} — refine a busca.</p>`);
    }

    el.querySelectorAll('.tfp-pair-opt').forEach((b) => {
      b.addEventListener('click', () => {
        const lic = (globalInventoryData || []).find((p) => recKey(p) === b.dataset.key);
        const ss = pickerSs;
        closePairPicker();
        if (ss && lic) setOverride(ss.productId, ss.swSerial, lic);
      });
    });
  }

  /** Botões de ajuste manual, só nas linhas de S&S da visão "Todos". */
  function pairControls(prod, paired) {
    if (prod.category !== 'SS') return '';
    const ajustado = pairOverrides.some(
      (o) => o.ssPid === prod.productId && o.ssSerial === prod.swSerial
    );
    const args = `'${escHtml(prod.productId)}', '${escHtml(prod.swSerial)}'`;
    const btn = (fn, txt, title) =>
      `<button type="button" class="tfp-pair-btn" onclick="${fn}(event, ${args})"`
      + ` title="${escHtml(title)}">${escHtml(txt)}</button>`;

    let html = paired
      ? btn('tfpUnpairSS', 'Separar', 'Este S&S não é desta licença — desfazer o par')
      : btn('tfpPickLicence', 'Casar…', 'Escolher manualmente a licença deste S&S');
    if (ajustado) {
      html += btn('tfpAutoPairSS', 'auto', 'Descartar o ajuste manual e voltar ao casamento automático');
    }
    return html;
  }

  /** Desenha a linha do produto (e suas features) na visão hierárquica. */
  function appendProductRows(tbody, prod, opts) {
    opts = opts || {};
    const paired = opts.attachedTo;
    // As duas pontas do par ganham o verde: a licença e o S&S dela.
    const marca = paired ? ' tfp-row-ss-pair' : (opts.coverage ? ' tfp-row-lic-pair' : '');
    const row = document.createElement('tr');
    row.className = `row-parent row-clickable${marca}`;
    row.setAttribute('onclick', `openProductModal('${prod.productId}')`);
    row.title = paired
      ? `S&S da licença ${paired.lic.productId} (serial ${paired.lic.swSerial})`
        + ` — casado por ${paired.basis}`
      : 'Clique para abrir detalhes, carta de anúncio e VUE do produto';

    let categoria = prod.category === 'SS'
      ? '<span class="badge badge-ss">S&S Suporte</span>'
      : '<span class="badge badge-lic">Licença</span>';
    if (opts.coverage) {
      const s = opts.coverage.rec;
      const detalhe = `Este produto também tem S&S: ${s.productId} (serial ${s.swSerial},`
        + ` Config Value ${configTotal(s)}) — casado por ${opts.coverage.basis}`;
      categoria += `<span class="badge tfp-badge-cov" title="${escHtml(detalhe)}">+ S&amp;S</span>`;
    }
    if (paired) {
      categoria += `<span class="tfp-pair-note">da licença ${escHtml(paired.lic.productId)}</span>`;
    }
    categoria += pairControls(prod, Boolean(paired));

    row.innerHTML =
      `<td><strong>${escHtml(prod.productId)}</strong></td>` +
      `<td>${escHtml(prod.swSerial)}</td>` +
      `<td style="color:#0f62fe; font-weight:600;">${escHtml(prod.effDate || '-')}</td>` +
      `<td>${escHtml(prod.description)}</td>` +
      `<td>${categoria}</td>` +
      `<td><span class="badge" style="background:#e0e0e0; color:#161616; font-weight:600;">${escHtml(prod.status || '-')}</span></td>` +
      '<td>-</td><td>-</td>';
    tbody.appendChild(row);

    (prod.features || []).forEach((feat) => {
      const fRow = document.createElement('tr');
      fRow.className = `row-child row-clickable${marca}`;
      fRow.setAttribute('onclick', `openProductModal('${prod.productId}')`);
      fRow.innerHTML =
        `<td style="padding-left: 28px;">↳ ${escHtml(feat.featureCode)}</td>` +
        '<td>-</td><td>-</td>' +
        `<td>${escHtml(feat.description)}</td>` +
        '<td>-</td><td>-</td>' +
        `<td>${escHtml(feat.metric)}</td>` +
        `<td class="val-highlight">${escHtml(feat.configValue)}</td>`;
      tbody.appendChild(fRow);
    });
  }

  // Substitui a montagem da tabela hierárquica do painel.
  const panelRenderHierarchical = window.renderHierarchicalTable;

  window.renderHierarchicalTable = function (data) {
    const tbody = document.querySelector('#tblHierarquica tbody');
    const filtro = typeof currentCategoryFilter !== 'undefined' ? currentCategoryFilter : 'ALL';
    // Só faz sentido juntar quando as duas categorias estão na tela.
    if (!tbody || filtro !== 'ALL' || !Array.isArray(data) || !data.length) {
      return panelRenderHierarchical.call(this, data);
    }

    let par;
    try {
      par = pairLicenceWithSS(data);
    } catch (err) {
      console.warn('Pareamento Licença/S&S falhou; mostrando a tabela original.', err);
      return panelRenderHierarchical.call(this, data);
    }

    tbody.innerHTML = '';
    data.forEach((prod) => {
      // S&S casado não aparece solto: entra logo abaixo da sua licença.
      if (prod.category === 'SS' && par.usedSs.has(prod)) return;

      const cobertura = par.byLic.get(prod) || null;
      appendProductRows(tbody, prod, { coverage: cobertura });
      if (cobertura) {
        appendProductRows(tbody, cobertura.rec, { attachedTo: { lic: prod, basis: cobertura.basis } });
      }
    });
  };

  function init() {
    rebindUpload();
    setupStatusTooltips();
    window.populateCustomerDropdown();
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
