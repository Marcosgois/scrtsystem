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

  // Cache em memória: clientId (TFPSystem) -> { clientName, customerNumber, updatedAt, products }
  const invStore = {};
  window.tfpClients = [];

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
          products: inv.products || [],
        };
        invStore[clientId] = item;
        if (inv.warnings && inv.warnings.length) showBanner(inv.warnings);
      } catch (err) {
        showEmptyState(); // 404 = cliente ainda sem inventário
        return;
      }
    }
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

  function init() {
    rebindUpload();
    window.populateCustomerDropdown();
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
