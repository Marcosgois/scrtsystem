'use strict';

/* TFPSystem — dashboard de consumo TFP (SCRT) por cliente. */

const state = {
  clients: [],
  clientId: localStorage.getItem('tfp.clientId') || null,
  dashboard: null,
  selectedPeriodKey: null, // mês selecionado (um mês pode vir de vários SCRTs)
  chart: null,
  dashboardReq: 0,
  chartMode: 'monthly', // 'monthly' | 'acc12'
  lparTab: 'n7', // 'n7' (uso) | 'n5' (picos 4HRA)
  lparView: 'exploded', // 'exploded' | 'grouped'
  machineFilter: null, // identificador da máquina que filtra as LPARs (null = todas)
  compare: null, // resultado do comparativo mês a mês
  compareBaseKey: null, // mês base escolhido no seletor (null = mês anterior)
  compareMachine: null, // máquina selecionada no comparativo (drill-down das LPARs)
  expandedGroups: new Set(), // grupos expandidos (dropdown) na visão agrupada
  reportDetail: null,
  groupEditing: null, // nome do grupo em edição no modal (null = novo grupo)
  forecast: null, // resultado do capacity planning
  forecastChart: null,
};

const $ = (id) => document.getElementById(id);
const fmt = (n) => (n === null || n === undefined ? '–' : Number(n).toLocaleString('pt-BR'));
const fmtM = (n) => (Math.abs(n) >= 1e6 ? (n / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + 'M' : fmt(n));
const fmtPct = (p) => (p === null || p === undefined ? '–' : (p >= 0 ? '+' : '') + p.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + '%');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Ícones inline (traço, 1.5px, herdam currentColor) — no lugar de emojis.
const ICON_CLOSE = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const ICON_CHEVRON = '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Paleta categórica dos grupos (ordem fixa, validada para daltonismo); cinzas = neutros.
const GROUP_COLORS = ['#0f62fe', '#b45309', '#6929c4', '#198038', '#9f1853'];
const COLOR_UNGROUPED = '#8d8d8d';
const COLOR_NO_DETAIL = '#c6c6c6';
const COLOR_OVERFLOW = '#4d5358';
// Paleta categórica IBM Carbon (14 tons) — para empilhados por máquina/LPAR.
const CARBON_CAT = [
  '#6929c4', '#1192e8', '#005d5d', '#9f1853', '#fa4d56', '#570408', '#198038',
  '#002d9c', '#ee538b', '#b28600', '#009d9a', '#012749', '#8a3800', '#a56eff',
];

/* ── Ordenação das tabelas ──────────────────────────────
   Cada tabela declara data-sort-table; cada <th> ordenável, data-sort="<campo>".
   Clique alterna desc → asc → volta à ordem padrão da tabela. */

const sortState = {}; // tableKey -> { key, dir } (dir: -1 desc, 1 asc)

/** Compara valores tratando null/undefined como "menor" e strings com locale pt-BR. */
function compareValues(a, b) {
  const aEmpty = a === null || a === undefined || a === '';
  const bEmpty = b === null || b === undefined || b === '';
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return -1;
  if (bEmpty) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), 'pt-BR', { numeric: true });
}

/** Aplica a ordenação escolhida; sem escolha, devolve as linhas na ordem padrão. */
function sortRows(tableKey, rows, accessors) {
  const s = sortState[tableKey];
  if (!s || !s.key) return rows;
  const get = (accessors && accessors[s.key]) || ((row) => row[s.key]);
  return [...rows].sort((a, b) => compareValues(get(a), get(b)) * s.dir);
}

/** Indicador de ordenação no cabeçalho da coluna ativa. */
function sortArrow(tableKey, key) {
  const s = sortState[tableKey];
  if (!s || s.key !== key) return '';
  return s.dir === -1 ? ' ↓' : ' ↑';
}

/** Marca os <th> estáticos com a seta e a classe de coluna ativa. */
function paintSortHeaders(tableKey) {
  document.querySelectorAll(`table[data-sort-table="${tableKey}"] th[data-sort]`).forEach((th) => {
    if (th.dataset.label === undefined) th.dataset.label = th.textContent;
    const s = sortState[tableKey];
    const active = s && s.key === th.dataset.sort;
    th.textContent = th.dataset.label + (active ? sortArrow(tableKey, th.dataset.sort) : '');
    th.classList.toggle('sorted', Boolean(active));
  });
}

// Re-render de cada tabela após mudar a ordenação.
const SORT_RERENDER = {
  history: () => state.dashboard && renderHistory(state.dashboard.series, state.dashboard.client),
  machines: () => renderMachines(),
  lpars: () => renderLparCard(),
  compareMachines: () => renderCompare(),
  compareLpars: () => renderCompare(),
};

document.addEventListener('click', (e) => {
  const th = e.target.closest('th[data-sort]');
  if (!th) return;
  const table = th.closest('table[data-sort-table]');
  if (!table) return;
  const tableKey = table.dataset.sortTable;
  const key = th.dataset.sort;
  const s = sortState[tableKey];
  // desc → asc → padrão
  if (!s || s.key !== key) sortState[tableKey] = { key, dir: -1 };
  else if (s.dir === -1) sortState[tableKey] = { key, dir: 1 };
  else sortState[tableKey] = { key: null, dir: -1 };
  const rerender = SORT_RERENDER[tableKey];
  if (rerender) rerender();
});

function darken(hex, f = 0.3) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.round(v * (1 - f)).toString(16).padStart(2, '0');
  return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`;
}

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, opts);
  let body = null;
  try { body = await res.json(); } catch { /* respostas sem corpo */ }
  if (!res.ok) throw new Error((body && body.error) || `Erro ${res.status}`);
  return body;
}

function toast(message, kind = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('toast-stack').appendChild(el);
  setTimeout(() => el.remove(), 4600);
}

/* ── Modais ─────────────────────────────────────────── */

function openModal(id) { $(id).classList.remove('hidden'); }
function closeModals() {
  document.querySelectorAll('.modal-backdrop').forEach((m) => m.classList.add('hidden'));
}

document.querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', closeModals));
document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
  // Só fecha se o gesto começou E terminou no backdrop (arrastar texto de dentro pra fora não fecha).
  let pressOnBackdrop = false;
  backdrop.addEventListener('mousedown', (e) => { pressOnBackdrop = e.target === backdrop; });
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop && pressOnBackdrop) closeModals();
    pressOnBackdrop = false;
  });
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });

let confirmAction = null;
function askConfirm(text, action) {
  $('modal-confirm-text').textContent = text;
  confirmAction = action;
  openModal('modal-confirm');
}
$('btn-confirm-yes').addEventListener('click', async () => {
  closeModals();
  if (confirmAction) { const fn = confirmAction; confirmAction = null; await fn(); }
});

/* ── Clientes ───────────────────────────────────────── */

async function loadClients(preserveSelection = true) {
  state.clients = await api('/clients');
  const select = $('client-select');
  select.innerHTML = state.clients
    .map((c) => `<option value="${c._id}">${esc(c.name)}</option>`)
    .join('');

  if (state.clients.length === 0) {
    state.clientId = null;
    showView('empty-clients');
    return;
  }

  const exists = state.clients.some((c) => c._id === state.clientId);
  if (!preserveSelection || !exists) state.clientId = state.clients[0]._id;
  select.value = state.clientId;
  localStorage.setItem('tfp.clientId', state.clientId);
  await loadDashboard();
}

$('client-select').addEventListener('change', async (e) => {
  state.clientId = e.target.value;
  localStorage.setItem('tfp.clientId', state.clientId);
  try {
    await loadDashboard();
  } catch (err) {
    toast(`Falha ao carregar o cliente: ${err.message}`, 'error');
  }
});

function currentClient() {
  return state.clients.find((c) => c._id === state.clientId) || null;
}

$('btn-new-client').addEventListener('click', () => openNewClientModal());
$('btn-empty-new-client').addEventListener('click', () => openNewClientModal());

function openNewClientModal() {
  $('input-client-name').value = '';
  $('input-client-baseline').value = '';
  openModal('modal-client');
  $('input-client-name').focus();
}

$('btn-save-client').addEventListener('click', async () => {
  const name = $('input-client-name').value.trim();
  if (!name) { toast('Informe o nome do cliente.', 'error'); return; }
  const baseline = $('input-client-baseline').value;
  if (baseline !== '' && (!Number.isFinite(Number(baseline)) || Number(baseline) < 0)) {
    toast('Baseline deve ser um número maior ou igual a zero.', 'error');
    return;
  }
  try {
    const client = await api('/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, monthlyBaselineMsu: baseline || null }),
    });
    closeModals();
    toast(`Cliente "${client.name}" criado.`);
    state.clientId = client._id;
    localStorage.setItem('tfp.clientId', state.clientId);
    await loadClients();
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('btn-delete-client').addEventListener('click', () => {
  const client = currentClient();
  if (!client) return;
  askConfirm(
    `Excluir o cliente "${client.name}" e TODOS os relatórios SCRT dele? Essa ação não pode ser desfeita.`,
    async () => {
      try {
        await api(`/clients/${client._id}`, { method: 'DELETE' });
        toast(`Cliente "${client.name}" excluído.`);
        state.clientId = null;
        await loadClients(false);
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  );
});

/* ── Baseline ───────────────────────────────────────── */

$('btn-edit-baseline').addEventListener('click', () => {
  const client = currentClient();
  if (!client) return;
  $('input-baseline').value = client.monthlyBaselineMsu ?? '';
  openModal('modal-baseline');
  $('input-baseline').focus();
});

$('btn-save-baseline').addEventListener('click', async () => {
  const value = $('input-baseline').value;
  if (value !== '' && (!Number.isFinite(Number(value)) || Number(value) < 0)) {
    toast('Baseline deve ser um número maior ou igual a zero.', 'error');
    return;
  }
  try {
    await api(`/clients/${state.clientId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monthlyBaselineMsu: value === '' ? null : Number(value) }),
    });
    closeModals();
    toast('Baseline atualizado.');
    await loadClients();
  } catch (err) {
    toast(err.message, 'error');
  }
});

/* ── Upload de SCRT ─────────────────────────────────── */

$('btn-upload').addEventListener('click', () => triggerUpload());
$('btn-empty-upload').addEventListener('click', () => triggerUpload());

function triggerUpload() {
  if (!state.clientId) { toast('Cadastre um cliente antes de subir o SCRT.', 'error'); return; }
  $('file-input').click();
}

$('file-input').addEventListener('change', (e) => {
  if (e.target.files.length) uploadScrtFiles(e.target.files);
  e.target.value = '';
});

let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  if (state.clientId) {
    const client = currentClient();
    $('drop-client-hint').textContent = client ? `O relatório será salvo para: ${client.name}` : '';
    $('drop-overlay').classList.remove('hidden');
  }
});
const dragHasFiles = (e) => Boolean(e.dataTransfer) && Array.from(e.dataTransfer.types).includes('Files');

document.addEventListener('dragover', (e) => {
  if (dragHasFiles(e)) e.preventDefault();
});
document.addEventListener('dragleave', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $('drop-overlay').classList.add('hidden');
});
document.addEventListener('drop', (e) => {
  // Arrasto de texto/links segue o comportamento nativo do navegador.
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('drop-overlay').classList.add('hidden');
  if (!state.clientId) { toast('Cadastre um cliente antes de subir o SCRT.', 'error'); return; }
  if (e.dataTransfer.files.length) uploadScrtFiles(e.dataTransfer.files);
});

/** Sobe um ou vários SCRTs em sequência e mostra um resumo consolidado. */
async function uploadScrtFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  if (!state.clientId) { toast('Cadastre um cliente antes de subir o SCRT.', 'error'); return; }

  const clientName = (currentClient() || {}).name || 'cliente selecionado';
  toast(files.length === 1 ? `Processando "${files[0].name}"…` : `Processando ${files.length} arquivos…`);

  const results = [];
  for (const file of files) {
    const form = new FormData();
    form.append('file', file);
    try {
      const result = await api(`/clients/${state.clientId}/reports`, { method: 'POST', body: form });
      results.push({ file: file.name, ok: true, result });
    } catch (err) {
      results.push({ file: file.name, ok: false, error: err.message });
    }
  }

  renderUploadResult(results, clientName);
  openModal('modal-upload-result');
  await loadClients();
}

function renderUploadResult(results, clientName) {
  const okCount = results.filter((r) => r.ok).length;
  $('modal-upload-title').textContent = results.length === 1 ? 'SCRT processado' : `${results.length} arquivos processados`;

  // Um único arquivo com sucesso: visão detalhada (número em destaque).
  if (results.length === 1 && results[0].ok) {
    const { result } = results[0];
    const r = result.report;
    $('upload-result-body').innerHTML = `
      <div class="upload-summary">
        <div><strong>${esc(r.customerName)}</strong> → cliente <strong>${esc(clientName)}</strong></div>
        <div>Período: <strong>${esc(r.periodLabel)}</strong> (${esc(r.periodDays ?? '?')} dias)</div>
        <div class="big">${fmt(r.totalMsuConsumed)} MSU</div>
        <div>Consumo mensal = soma de "Machine MSU Consumed" de <strong>${r.machines.length}</strong> máquina(s)</div>
        ${result.sheetCount > 1 ? `<div style="margin-top:6px;"><span class="tag tag-history">planilha: ${result.sheetCount} abas combinadas</span></div>` : ''}
        ${result.replaced ? '<div style="margin-top:6px;"><span class="tag tag-neutral">Relatório do mês substituído</span></div>' : ''}
        ${result.warnings && result.warnings.length
          ? `<ul>${result.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`
          : ''}
      </div>`;
    return;
  }

  // Lote: tabela com uma linha por arquivo.
  const rows = results.map((r) => {
    if (!r.ok) {
      return `<tr>
        <td>${esc(r.file)}</td><td>–</td><td class="num">–</td>
        <td><span class="tag tag-alert">erro</span> <span class="muted small">${esc(r.error)}</span></td></tr>`;
    }
    const rep = r.result.report;
    const conflict = r.result.conflicts && r.result.conflicts.length;
    const statusTag = conflict
      ? '<span class="tag tag-alert">conflito</span>'
      : r.result.replaced
        ? '<span class="tag tag-neutral">substituído</span>'
        : '<span class="tag tag-ok">salvo</span>';
    const abas = r.result.sheetCount > 1 ? ` <span class="muted small">(${r.result.sheetCount} abas)</span>` : '';
    return `<tr>
      <td>${esc(r.file)}${abas}</td>
      <td>${esc(rep.periodLabel)}</td>
      <td class="num">${fmt(rep.totalMsuConsumed)}</td>
      <td>${statusTag}</td></tr>`;
  }).join('');

  // Avisos e conflitos agregados (mostra uma vez cada).
  const avisos = [...new Set(results.filter((r) => r.ok).flatMap((r) => r.result.warnings || []))];

  $('upload-result-body').innerHTML = `
    <div class="upload-summary">
      <div><strong>${okCount} de ${results.length}</strong> arquivo(s) processado(s) · cliente <strong>${esc(clientName)}</strong></div>
      <div class="table-responsive" style="max-height: 340px; margin-top: 10px;">
        <table>
          <thead><tr><th>Arquivo</th><th>Mês</th><th class="num">Consumo (MSU)</th><th>Status</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${avisos.length ? `<ul>${avisos.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    </div>`;
}

/* ── Dashboard ──────────────────────────────────────── */

function showView(view) {
  $('empty-clients').classList.toggle('hidden', view !== 'empty-clients');
  $('empty-reports').classList.toggle('hidden', view !== 'empty-reports');
  $('dashboard').classList.toggle('hidden', view !== 'dashboard');
}

async function loadDashboard() {
  if (!state.clientId) return;
  // Token de corrida: se o usuário trocar de cliente antes da resposta, descarta a resposta atrasada.
  const reqId = ++state.dashboardReq;
  const data = await api(`/clients/${state.clientId}/dashboard`);
  if (reqId !== state.dashboardReq) return;
  state.dashboard = data;
  const { client, series, latest } = state.dashboard;

  // Troca de cliente/recarga geral: o filtro de máquina não deve vazar entre contextos.
  state.machineFilter = null;

  if (!series.length) {
    state.selectedPeriodKey = null;
    $('empty-reports-client').textContent = client.name;
    showView('empty-reports');
    return;
  }

  showView('dashboard');
  $('dash-client-name').textContent = client.name;
  const last = series[series.length - 1];
  $('dash-client-sub').textContent =
    `${series.length} mês(es) de histórico · último SCRT: ${last.periodLabel} · cliente SCRT: ${latest.customerName || '–'}`;

  state.selectedPeriodKey = last.periodKey;
  state.compareBaseKey = null; // volta ao padrão (mês anterior) ao trocar de cliente
  state.forecast = null; // projeção é do cliente anterior
  $('forecast-body').classList.add('hidden');
  $('forecast-empty').classList.remove('hidden');
  $('forecast-empty').innerHTML = 'Clique em <strong>Projetar</strong> para estimar o consumo futuro.';
  renderWarnings(latest);
  renderKpis(series, client);
  renderChart(series, client);
  renderHistory(series, client);

  await loadMonthDetail(last.periodKey);
  await loadCompare();
}

function renderWarnings(latest) {
  const el = $('dash-warnings');
  const warnings = (latest && latest.warnings) || [];
  if (!warnings.length) { el.classList.add('hidden'); return; }
  el.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" style="margin-top:2px">' +
    '<path d="M8 1.8 15 14H1L8 1.8Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
    '<path d="M8 6.2v3.4M8 11.6h.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' +
    `<div><strong>Avisos do último SCRT (${esc(latest.periodLabel)}):</strong><br>` +
    warnings.map((w) => esc(w)).join('<br>') + '</div>';
  el.classList.remove('hidden');
}

function renderKpis(series, client) {
  // Os KPIs seguem o mês selecionado (clique no gráfico ou no histórico); padrão = último.
  const last = series.find((s) => s.periodKey === state.selectedPeriodKey) || series[series.length - 1];
  // Janela de 12 meses de CALENDÁRIO calculada no servidor (meses ausentes não contam).
  const acc12 = last.acc12;
  const acc12Months = last.acc12Months;
  const avg12 = acc12Months > 0 ? acc12 / acc12Months : 0;

  $('kpi-month-title').textContent = `Consumo · ${last.periodLabel}`;
  $('kpi-month-value').textContent = `${fmt(last.totalMsuConsumed)} MSU`;
  const momEl = $('kpi-month-mom');
  momEl.textContent = fmtPct(last.momPct);
  momEl.className = 'delta ' + (last.momPct === null ? 'flat' : last.momPct >= 0 ? 'up' : 'down');

  $('kpi-yty-value').textContent = fmtPct(last.ytyPct);
  $('kpi-yty-sub').textContent = last.ytyPct === null
    ? 'sem SCRT do mesmo mês do ano anterior'
    : `${last.periodLabel} vs ano anterior`;

  $('kpi-avg-value').textContent = `${fmt(Math.round(avg12))} MSU`;
  $('kpi-avg-sub').textContent = `média de ${acc12Months} mês(es)`;

  $('kpi-acc-value').textContent = `${fmt(acc12)} MSU`;
  $('kpi-acc-sub').textContent = acc12Months === 12
    ? `12 meses completos até ${last.periodLabel}`
    : `soma de ${acc12Months} mês(es) disponíveis`;

  // No modo Acumulado 12M o baseline vira anual (12×), para comparar com o
  // acumulado; nos demais modos segue mensal, comparado ao mês selecionado.
  const baseline = client.monthlyBaselineMsu;
  const isAcc = state.chartMode === 'acc12';
  $('kpi-baseline-title').textContent = isAcc ? 'Baseline anual' : 'Baseline mensal';
  if (baseline) {
    const alvo = isAcc ? baseline * 12 : baseline;
    const consumo = isAcc ? acc12 : last.totalMsuConsumed;
    const diff = consumo - alvo;
    const ondeVs = isAcc ? 'do baseline anual' : `do baseline em ${esc(last.periodLabel)}`;
    $('kpi-baseline-value').textContent = `${fmt(alvo)} MSU`;
    $('kpi-baseline-sub').innerHTML = diff > 0
      ? `<span class="delta up">+${fmt(diff)} MSU</span> acima ${ondeVs}`
      : `<span class="delta down">${fmt(diff)} MSU</span> abaixo ${ondeVs}`;
  } else {
    $('kpi-baseline-value').textContent = '–';
    $('kpi-baseline-sub').textContent = 'defina o baseline do contrato';
  }
}

/* Regressão linear simples sobre a série para a linha de tendência. */
function trendLine(values) {
  const n = values.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  values.forEach((y, i) => { const x = i + 1; sx += x; sy += y; sxy += x * y; sxx += x * x; });
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return values.map((_, i) => Math.round(slope * (i + 1) + intercept));
}

function renderChart(series, client) {
  const ctx = $('msuChart').getContext('2d');
  const labels = series.map((s) => s.periodLabel);
  const baseline = client.monthlyBaselineMsu || null;
  const isAcc = state.chartMode === 'acc12';
  const isGroups = state.chartMode === 'groups';
  const isMachines = state.chartMode === 'machines';
  const isLpars = state.chartMode === 'lpars';
  const isStacked = isGroups || isMachines || isLpars;
  const showBaseline = $('toggle-baseline').checked && baseline;
  const selIdx = series.findIndex((s) => s.periodKey === state.selectedPeriodKey);

  // Tendência só faz sentido no modo mensal.
  $('toggle-trend-wrap').classList.toggle('hidden', isAcc || isStacked);

  // Mês selecionado ganha a versão escurecida da cor.
  const perBarColor = (color) => series.map((_, i) => (i === selIdx ? darken(color) : color));

  const datasets = [];

  if (isAcc) {
    datasets.push({
      type: 'line',
      label: 'Acumulado 12 meses (MSU)',
      data: series.map((s) => s.acc12),
      borderColor: '#0f62fe',
      backgroundColor: 'rgba(15, 98, 254, 0.08)',
      borderWidth: 2.5,
      pointRadius: series.map((_, i) => (i === selIdx ? 6 : 3.5)),
      pointBackgroundColor: perBarColor('#0f62fe'),
      pointHoverRadius: 6,
      fill: true,
      tension: 0.15,
    });
    if (showBaseline) {
      datasets.push({
        type: 'line',
        label: `Baseline anual (12 × ${fmtM(baseline)})`,
        data: labels.map(() => baseline * 12),
        borderColor: '#da1e28',
        borderWidth: 2,
        borderDash: [4, 4],
        pointRadius: 0,
        pointHoverRadius: 0,
      });
    }
  } else if (isGroups) {
    const groupNames = (client.lparGroups || []).map((g) => g.name);
    const shown = groupNames.slice(0, GROUP_COLORS.length);
    const overflow = groupNames.slice(GROUP_COLORS.length);
    const msuOf = (s, name) => {
      if (!s.groupBreakdown) return 0;
      const g = s.groupBreakdown.groups.find((x) => x.name === name);
      return g ? g.msu : 0;
    };
    const stackedBar = (label, data, color) => ({
      type: 'bar',
      label,
      stack: 'msu',
      data,
      backgroundColor: perBarColor(color),
      borderColor: '#ffffff',
      borderWidth: 1,
      maxBarThickness: 46,
    });

    shown.forEach((name, gi) => {
      datasets.push(stackedBar(name, series.map((s) => msuOf(s, name)), GROUP_COLORS[gi]));
    });
    if (overflow.length) {
      datasets.push(stackedBar(
        `Outros grupos (${overflow.length})`,
        series.map((s) => overflow.reduce((a, n) => a + msuOf(s, n), 0)),
        COLOR_OVERFLOW
      ));
    }
    const semGrupo = series.map((s) => (s.groupBreakdown ? s.groupBreakdown.ungroupedMsu : 0));
    if (semGrupo.some((v) => v > 0)) {
      datasets.push(stackedBar('Sem grupo', semGrupo, COLOR_UNGROUPED));
    }
    const semDetalhe = series.map((s) => (s.groupBreakdown ? 0 : s.totalMsuConsumed));
    if (semDetalhe.some((v) => v > 0)) {
      datasets.push(stackedBar('Sem detalhe por LPAR', semDetalhe, COLOR_NO_DETAIL));
    }
    if (showBaseline) {
      datasets.push({
        type: 'line',
        label: `Baseline mensal (${fmtM(baseline)} MSU)`,
        data: labels.map(() => baseline),
        borderColor: '#da1e28',
        borderWidth: 2,
        borderDash: [4, 4],
        pointRadius: 0,
        pointHoverRadius: 0,
      });
    }
  } else if (isMachines || isLpars) {
    const field = isMachines ? 'machineBreakdown' : 'lparBreakdown';
    const keyOf = isMachines ? (i) => i.id : (i) => i.key;
    const labelOf = isMachines ? (i) => i.id : (i) => i.name;
    const TOP_N = 8;

    // Ranking das entidades pelo total consumido no período visível.
    const totalByKey = new Map();
    const labelByKey = new Map();
    for (const s of series) {
      for (const it of (s[field] || [])) {
        const k = keyOf(it);
        totalByKey.set(k, (totalByKey.get(k) || 0) + (it.msu || 0));
        if (!labelByKey.has(k)) labelByKey.set(k, labelOf(it));
      }
    }
    const ranked = [...totalByKey.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const shownKeys = ranked.slice(0, TOP_N);
    const overflowKeys = new Set(ranked.slice(TOP_N));

    const msuOf = (s, key) => {
      const it = (s[field] || []).find((x) => keyOf(x) === key);
      return it ? it.msu : 0;
    };
    const stackedBar = (label, data, color) => ({
      type: 'bar',
      label,
      stack: 'msu',
      data,
      backgroundColor: perBarColor(color),
      borderColor: '#ffffff',
      borderWidth: 1,
      maxBarThickness: 46,
    });

    shownKeys.forEach((k, i) => {
      datasets.push(stackedBar(labelByKey.get(k), series.map((s) => msuOf(s, k)), CARBON_CAT[i % CARBON_CAT.length]));
    });
    if (overflowKeys.size) {
      datasets.push(stackedBar(
        `Outras (${overflowKeys.size})`,
        series.map((s) => (s[field] || []).reduce((a, it) => a + (overflowKeys.has(keyOf(it)) ? (it.msu || 0) : 0), 0)),
        COLOR_OVERFLOW
      ));
    }
    // Meses sem detalhe da entidade (ex.: sem seção de LPAR) — total em cinza.
    const semDetalhe = series.map((s) => {
      const soma = (s[field] || []).reduce((a, it) => a + (it.msu || 0), 0);
      return soma > 0 ? 0 : s.totalMsuConsumed;
    });
    if (semDetalhe.some((v) => v > 0)) {
      datasets.push(stackedBar(isLpars ? 'Sem detalhe por LPAR' : 'Sem detalhe por máquina', semDetalhe, COLOR_NO_DETAIL));
    }
    if (showBaseline) {
      datasets.push({
        type: 'line',
        label: `Baseline mensal (${fmtM(baseline)} MSU)`,
        data: labels.map(() => baseline),
        borderColor: '#da1e28',
        borderWidth: 2,
        borderDash: [4, 4],
        pointRadius: 0,
        pointHoverRadius: 0,
      });
    }
  } else {
    const values = series.map((s) => s.totalMsuConsumed);
    const trend = trendLine(values);
    const showTrend = $('toggle-trend').checked && trend;

    datasets.push({
      type: 'bar',
      label: 'Consumo mensal (MSU)',
      data: values,
      backgroundColor: perBarColor('#0f62fe'),
      hoverBackgroundColor: '#0043ce',
      borderRadius: { topLeft: 4, topRight: 4 },
      borderSkipped: 'bottom',
      maxBarThickness: 46,
      order: 3,
    });

    if (showTrend) {
      datasets.push({
        type: 'line',
        label: 'Tendência (regressão linear)',
        data: trend,
        borderColor: '#b45309',
        borderWidth: 2,
        borderDash: [6, 5],
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0,
        order: 2,
      });
    }

    if (showBaseline) {
      datasets.push({
        type: 'line',
        label: `Baseline mensal (${fmtM(baseline)} MSU)`,
        data: labels.map(() => baseline),
        borderColor: '#da1e28',
        borderWidth: 2,
        borderDash: [4, 4],
        pointRadius: 0,
        pointHoverRadius: 0,
        order: 1,
      });
    }
  }

  if (state.chart) state.chart.destroy();
  state.chart = new Chart(ctx, {
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      onClick: (evt, els, chart) => {
        const pts = chart.getElementsAtEventForMode(evt, 'index', { intersect: false }, true);
        if (!pts.length) return;
        const s = series[pts[0].index];
        if (s && s.periodKey !== state.selectedPeriodKey) selectMonth(s.periodKey);
      },
      plugins: {
        legend: {
          position: 'top',
          align: 'end',
          labels: { usePointStyle: true, pointStyleWidth: 10, boxHeight: 7, font: { size: 12 } },
        },
        tooltip: {
          backgroundColor: '#1c1c1c',
          padding: 12,
          filter: (item) => !isStacked || item.dataset.type !== 'bar' || item.parsed.y > 0,
          callbacks: {
            label: (c) => ` ${c.dataset.label}: ${fmt(c.parsed.y)} MSU`,
            afterBody: (items) => {
              if (!items.length) return '';
              const s = series[items[0].dataIndex];
              if (isAcc) return s.acc12Months < 12 ? `soma de ${s.acc12Months} mês(es) disponíveis` : '';
              if (isStacked) return `Total do mês: ${fmt(s.totalMsuConsumed)} MSU`;
              return '';
            },
          },
        },
      },
      scales: {
        x: { stacked: isStacked, grid: { display: false }, ticks: { font: { size: 12 } } },
        y: {
          stacked: isStacked,
          beginAtZero: !isAcc,
          grid: { color: '#eef1f5' },
          ticks: { font: { size: 12 }, callback: (v) => fmtM(v) },
          title: { display: true, text: isAcc ? 'MSUs acumulados (12 meses móveis)' : 'MSUs', font: { size: 12 } },
        },
      },
    },
  });
}

// Clique no gráfico seleciona o mês. Listener próprio no canvas além do onClick do
// Chart.js: em alguns ambientes os listeners internos do Chart.js não recebem o evento;
// os dois caminhos convergem em selectMonth, que ignora o mês já selecionado.
$('msuChart').addEventListener('click', (e) => {
  const chart = state.chart;
  const series = state.dashboard && state.dashboard.series;
  if (!chart || !series || !series.length) return;
  const { left, right, top, bottom } = chart.chartArea;
  if (e.offsetX < left - 8 || e.offsetX > right + 8 || e.offsetY < top || e.offsetY > bottom + 28) return;
  const idx = Math.min(series.length - 1, Math.max(0, Math.round(chart.scales.x.getValueForPixel(e.offsetX))));
  const s = series[idx];
  if (s && s.periodKey !== state.selectedPeriodKey) selectMonth(s.periodKey);
});

/** Foca tudo (KPIs, gráfico, histórico, máquinas e LPARs) no mês do relatório dado. */
async function selectMonth(periodKey) {
  if (!state.dashboard) return;
  state.selectedPeriodKey = periodKey;
  renderKpis(state.dashboard.series, state.dashboard.client);
  renderChart(state.dashboard.series, state.dashboard.client);
  document.querySelectorAll('#history-tbody tr[data-period]').forEach((tr) =>
    tr.classList.toggle('selected', tr.dataset.period === periodKey));
  try {
    await loadMonthDetail(periodKey);
    // O comparativo acompanha o mês selecionado, sempre contra o mês anterior a ele.
    state.compareBaseKey = null;
    await loadCompare();
  } catch (err) {
    toast(`Falha ao carregar o mês: ${err.message}`, 'error');
  }
}

document.querySelectorAll('[data-chart-mode]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (state.chartMode === btn.dataset.chartMode) return;
    state.chartMode = btn.dataset.chartMode;
    document.querySelectorAll('[data-chart-mode]').forEach((b) => b.classList.toggle('active', b === btn));
    rerenderChart();
  });
});

$('toggle-trend').addEventListener('change', () => rerenderChart());
$('toggle-baseline').addEventListener('change', () => rerenderChart());
function rerenderChart() {
  if (state.dashboard && state.dashboard.series.length) {
    // O KPI de baseline (mensal ↔ anual) segue o modo do gráfico.
    renderKpis(state.dashboard.series, state.dashboard.client);
    renderChart(state.dashboard.series, state.dashboard.client);
  }
}

function renderHistory(series, client) {
  const baseline = client.monthlyBaselineMsu || null;
  const tbody = $('history-tbody');
  paintSortHeaders('history');
  // Sem ordenação escolhida, mantém o padrão: mês mais recente primeiro.
  const rows = sortState.history && sortState.history.key
    ? sortRows('history', series)
    : [...series].reverse();
  tbody.innerHTML = rows.map((s) => {
    let statusTag = '<span class="tag tag-neutral">—</span>';
    if (baseline) {
      statusTag = s.totalMsuConsumed > baseline
        ? '<span class="tag tag-alert">Acima baseline</span>'
        : '<span class="tag tag-ok">Abaixo baseline</span>';
    }
    const momCls = s.momPct === null ? 'flat' : s.momPct >= 0 ? 'up' : 'down';
    const ytyCls = s.ytyPct === null ? 'flat' : s.ytyPct >= 0 ? 'up' : 'down';
    const accCell = s.acc12Months === 12
      ? fmt(s.acc12)
      : `<span class="muted" title="soma de ${s.acc12Months} mês(es) disponíveis">${fmt(s.acc12)}</span>`;
    // Mês composto por vários SCRTs (sites) ganha um selo com a contagem.
    const multi = s.sourceCount > 1
      ? ` <span class="tag tag-history" title="${esc((s.sources || []).map((o) => o.siteLabel || o.sourceFileName).join(' + '))}">${s.sourceCount} SCRTs</span>`
      : '';
    const conflito = (s.conflicts && s.conflicts.length)
      ? ' <span class="tag tag-alert" title="Máquina repetida entre os SCRTs deste mês">conflito</span>'
      : '';
    return `
      <tr data-period="${esc(s.periodKey)}" class="${s.periodKey === state.selectedPeriodKey ? 'selected' : ''}">
        <td><strong>${esc(s.periodLabel)}</strong>${multi}${conflito}</td>
        <td class="num"><strong>${fmt(s.totalMsuConsumed)}</strong></td>
        <td class="num"><span class="delta ${momCls}">${fmtPct(s.momPct)}</span></td>
        <td class="num"><span class="delta ${ytyCls}">${fmtPct(s.ytyPct)}</span></td>
        <td class="num">${accCell}</td>
        <td>${statusTag}</td>
        <td><button class="row-action" data-delete-month="${esc(s.periodKey)}" title="Excluir ${esc(s.periodLabel)}" aria-label="Excluir ${esc(s.periodLabel)}">${ICON_CLOSE}</button></td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('tr').forEach((tr) => {
    tr.addEventListener('click', async (e) => {
      if (e.target.closest('[data-delete-month]')) return;
      await selectMonth(tr.dataset.period);
    });
  });

  tbody.querySelectorAll('[data-delete-month]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = btn.dataset.deleteMonth;
      const item = series.find((s) => s.periodKey === key);
      const quantos = item && item.sourceCount > 1
        ? ` Isso remove os ${item.sourceCount} SCRTs do mês (${(item.sources || []).map((o) => o.siteLabel || o.sourceFileName).join(', ')}).`
        : '';
      askConfirm(`Excluir ${item ? item.periodLabel : 'este mês'}?${quantos}`, async () => {
        try {
          await api(`/clients/${state.clientId}/months/${key}`, { method: 'DELETE' });
          toast('Mês excluído.');
          await loadClients();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  });
}

async function loadMonthDetail(periodKey) {
  const report = await api(`/clients/${state.clientId}/months/${periodKey}`);
  // Resposta atrasada de um mês que já não está selecionado é descartada.
  if (state.selectedPeriodKey !== periodKey) return;
  state.reportDetail = report;
  // Mantém o filtro ao navegar entre meses, mas limpa se a máquina não existir neste SCRT.
  if (state.machineFilter && !report.machines.some((m) => m.identifier === state.machineFilter)) {
    state.machineFilter = null;
  }
  renderMachines();
  renderReportMeta(report);
  renderLparCard();
}

function renderMachines() {
  const report = state.reportDetail;
  if (!report) return;
  $('machines-title').textContent = `Máquinas · ${report.machines.length} no Multiplex`;
  $('machines-period').textContent = report.periodLabel;

  const total = report.totalMsuConsumed || 1;
  const tbody = $('machines-tbody');
  paintSortHeaders('machines');
  tbody.innerHTML = sortRows('machines', report.machines).map((m) => {
    const pct = ((m.msuConsumed || 0) / total) * 100;
    const selected = state.machineFilter === m.identifier;
    return `
      <tr data-machine="${esc(m.identifier)}" class="${selected ? 'selected' : ''}"
          title="${selected ? `Remover filtro da máquina ${esc(m.identifier)}` : `Filtrar LPARs da máquina ${esc(m.identifier)}`}">
        <td><strong>${esc(m.identifier)}</strong>${m.serialNumber ? `<div class="small muted">${esc(m.serialNumber)}</div>` : ''}</td>
        <td>${esc(m.typeModel || '–')}</td>
        <td class="num">${fmt(m.ratedCapacityMsus)}</td>
        <td class="num">${fmt(m.peakUtilizationMsus)}</td>
        <td class="num"><strong>${fmt(m.msuConsumed)}</strong></td>
        <td class="num">
          <div class="pct-bar-wrap">
            <span>${pct.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</span>
            <div class="pct-bar-track"><div class="pct-bar" style="width:${Math.max(2, pct)}%"></div></div>
          </div>
        </td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('tr[data-machine]').forEach((tr) => {
    tr.addEventListener('click', () => {
      const id = tr.dataset.machine;
      state.machineFilter = state.machineFilter === id ? null : id;
      renderMachines();
      renderLparCard();
    });
  });
}

function renderReportMeta(month) {
  const sources = month.sources || [];
  const containerInfo = month.containersTotalMsu !== null && month.containersTotalMsu !== undefined
    ? ` · Total containers: ${fmt(month.containersTotalMsu)} MSU ${month.containersTotalMsu === month.totalMsuConsumed ? '(confere)' : '≠ soma das máquinas'}`
    : '';

  // Conflito: a mesma máquina aparece em mais de um SCRT do mês (risco de dobra).
  const conflitos = (month.conflicts || []).length
    ? `<div class="conflict-note">Conflito: máquina(s) ${month.conflicts.map((c) => esc(c.serial)).join(', ')} ` +
      `aparecem em mais de um SCRT deste mês (${month.conflicts.map((c) => esc(c.sources.join(' e '))).join('; ')}). ` +
      `O consumo pode estar contado em dobro.</div>`
    : '';

  // Origens (SCRTs) que compõem o mês — com exclusão individual quando há mais de uma.
  const listaOrigens = sources.length > 1
    ? `<div class="sources-panel">
         <div class="sources-title">${sources.length} SCRTs somados neste mês</div>
         ${sources.map((o) => `
           <div class="source-row">
             <span class="tag tag-history">${esc(o.siteLabel || '—')}</span>
             <span class="source-file" title="${esc(o.sourceFileName || '')}">${esc(o.sourceFileName || '(sem nome)')}</span>
             <span class="muted small">${esc(o.machines.join(', '))}</span>
             <strong class="num">${fmt(o.totalMsuConsumed)} MSU</strong>
             <button class="row-action" data-delete-source="${o.reportId}"
                     title="Remover este SCRT do mês" aria-label="Remover ${esc(o.siteLabel || 'origem')}">${ICON_CLOSE}</button>
           </div>`).join('')}
       </div>`
    : '';

  const arquivo = sources.length === 1
    ? `Arquivo: <strong>${esc(sources[0].sourceFileName || '–')}</strong> · SCRT ${esc(month.scrtToolRelease || '–')}` +
      ` · Gerado em: ${esc(month.runDateTime || '–')}`
    : `${sources.length} SCRTs · consumo somado`;

  $('report-meta').innerHTML =
    conflitos + listaOrigens +
    arquivo + containerInfo +
    `<br>Período: ${esc((month.periodStart || '').slice(0, 10))} a ${esc((month.periodEnd || '').slice(0, 10))}` +
    ` (${esc(month.periodDays ?? '?')} dias) · Processadores: ${fmt(month.processorsInMultiplex)}`;

  $('report-meta').querySelectorAll('[data-delete-source]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.deleteSource;
      const origem = sources.find((o) => String(o.reportId) === String(id));
      askConfirm(
        `Remover o SCRT "${origem ? (origem.sourceFileName || origem.siteLabel) : ''}" de ${month.periodLabel}? ` +
        `O consumo do mês passa a desconsiderar ${origem ? fmt(origem.totalMsuConsumed) : ''} MSU.`,
        async () => {
          try {
            await api(`/reports/${id}`, { method: 'DELETE' });
            toast('SCRT removido do mês.');
            await loadClients();
          } catch (err) {
            toast(err.message, 'error');
          }
        }
      );
    });
  });
}

/* ── Consumo por LPAR (seções N7 e N5 do SCRT) ──────── */

function clientLparGroups() {
  return (state.dashboard && state.dashboard.client && state.dashboard.client.lparGroups) || [];
}

/** Mapa nome-da-LPAR -> nome-do-grupo. */
function lparToGroupMap() {
  const map = new Map();
  for (const g of clientLparGroups()) {
    for (const l of g.lpars || []) map.set(l, g.name);
  }
  return map;
}

const groupBadge = '<span class="tag tag-group">grupo</span> ';

function renderLparCard() {
  const report = state.reportDetail;
  if (!report) return;
  const lpars = report.lpars || [];
  const filter = state.machineFilter;
  $('lpar-title').textContent = `Consumo por LPAR · ${report.periodLabel}`;

  const chip = $('lpar-machine-chip');
  chip.classList.toggle('hidden', !filter);
  if (filter) chip.innerHTML = `Máquina ${esc(filter)}${ICON_CLOSE}`;

  const byMachine = (l) => !filter || l.machine === filter;
  // Ordem padrão: maior consumo/pico primeiro; o clique no cabeçalho sobrepõe.
  const applyLparSort = (rows) =>
    (sortState.lpars && sortState.lpars.key ? sortRows('lpars', rows) : rows);
  const usage = applyLparSort(lpars
    .filter((l) => l.msuConsumed != null && byMachine(l))
    .sort((a, b) => b.msuConsumed - a.msuConsumed));
  const peaks = applyLparSort(lpars
    .filter((l) => l.peak4hraMsu != null && byMachine(l))
    .sort((a, b) => b.peak4hraMsu - a.peak4hraMsu));

  // Na visão agrupada as linhas são grupos: ordena pelo agregado (ou pelo nome).
  const sortGroupEntries = (entries) => {
    const s = sortState.lpars;
    if (!s || !s.key) return entries.sort((a, b) => b.sum - a.sum);
    if (s.key === 'name' || s.key === 'machine') {
      return entries.sort((a, b) => compareValues(a.label, b.label) * s.dir);
    }
    return entries.sort((a, b) => (a.sum - b.sum) * s.dir);
  };

  const grouped = state.lparView === 'grouped';
  const groups = clientLparGroups();
  const groupOf = lparToGroupMap();

  const rows = state.lparTab === 'n7' ? usage : peaks;
  const emptyEl = $('lpar-empty');
  emptyEl.classList.toggle('hidden', rows.length > 0);
  emptyEl.textContent = filter && lpars.length > 0
    ? `A máquina ${filter} não tem LPARs com dados nesta seção do SCRT.`
    : 'O SCRT deste mês não traz as seções de LPAR (N5/N7).';
  $('lpar-groups-hint').classList.toggle('hidden', !(grouped && groups.length === 0 && rows.length > 0));

  const thead = $('lpar-thead');
  const tbody = $('lpar-tbody');

  if (state.lparTab === 'n7') {
    const total = usage.reduce((a, l) => a + l.msuConsumed, 0) || 1;
    const pctCell = (value) => {
      const pct = (value / total) * 100;
      return `<div class="pct-bar-wrap">
        <span>${pct.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</span>
        <div class="pct-bar-track"><div class="pct-bar" style="width:${Math.max(2, pct)}%"></div></div>
      </div>`;
    };
    thead.innerHTML = `<tr>
      <th data-sort="name">${grouped ? 'Grupo / LPAR' : 'LPAR'}${sortArrow('lpars', 'name')}</th>
      <th data-sort="machine">Máquina${sortArrow('lpars', 'machine')}</th>
      <th data-sort="os">OS${sortArrow('lpars', 'os')}</th>
      <th class="num" data-sort="msuConsumed">MSU Consumido${sortArrow('lpars', 'msuConsumed')}</th>
      <th class="num" data-sort="msuConsumed">${filter ? '% da máquina' : '% do total'}${sortArrow('lpars', 'msuConsumed')}</th>
      <th class="num" data-sort="peakHourMsu">Pico hora (MSU)${sortArrow('lpars', 'peakHourMsu')}</th>
      <th data-sort="peakHourAt">Quando${sortArrow('lpars', 'peakHourAt')}</th>
    </tr>`;

    const lparRow = (l, cls = '') => `
      <tr${cls ? ` class="${cls}"` : ''}>
        <td><strong>${esc(l.name)}</strong></td>
        <td>${esc(l.machine || '–')}</td>
        <td>${esc(l.os || '–')}</td>
        <td class="num"><strong>${fmt(l.msuConsumed)}</strong></td>
        <td class="num">${pctCell(l.msuConsumed)}</td>
        <td class="num">${fmt(l.peakHourMsu)}</td>
        <td class="small muted">${esc(l.peakHourAt || '–')}</td>
      </tr>`;

    if (!grouped) {
      tbody.innerHTML = usage.map((l) => lparRow(l)).join('');
    } else {
      const groupRows = groups.map((g) => {
        const members = usage.filter((l) => (g.lpars || []).includes(l.name));
        if (!members.length) return null;
        const sum = members.reduce((a, l) => a + l.msuConsumed, 0);
        const topPeak = members.reduce((best, l) => (l.peakHourMsu > (best?.peakHourMsu ?? -1) ? l : best), null);
        const machines = [...new Set(members.map((m) => m.machine))];
        const oses = [...new Set(members.map((m) => m.os).filter(Boolean))];
        const open = state.expandedGroups.has(g.name);
        return {
          sum,
          label: g.name,
          html: `
          <tr class="group-row" data-group="${esc(g.name)}" title="Clique para ${open ? 'recolher' : 'ver'} as LPARs do grupo">
            <td><span class="chev ${open ? 'open' : ''}">${ICON_CHEVRON}</span>${groupBadge}<strong>${esc(g.name)}</strong> <span class="muted small">(${members.length} LPARs)</span></td>
            <td>${esc(machines.length === 1 ? machines[0] : `${machines.length} máquinas`)}</td>
            <td>${esc(oses.length === 1 ? oses[0] : (oses.length ? 'vários' : '–'))}</td>
            <td class="num"><strong>${fmt(sum)}</strong></td>
            <td class="num">${pctCell(sum)}</td>
            <td class="num">${topPeak ? `${fmt(topPeak.peakHourMsu)} <span class="muted small">(${esc(topPeak.name)})</span>` : '–'}</td>
            <td class="small muted">${esc(topPeak?.peakHourAt || '–')}</td>
          </tr>` + (open ? members.map((m) => lparRow(m, 'group-member-row')).join('') : ''),
        };
      }).filter(Boolean);

      const leftovers = usage
        .filter((l) => !groupOf.has(l.name))
        .map((l) => ({ sum: l.msuConsumed, label: l.name, html: lparRow(l) }));

      tbody.innerHTML = sortGroupEntries([...groupRows, ...leftovers])
        .map((r) => r.html)
        .join('');
      attachGroupRowToggles(tbody);
    }
  } else {
    thead.innerHTML = `<tr>
      <th data-sort="name">${grouped ? 'Grupo / LPAR' : 'LPAR'}${sortArrow('lpars', 'name')}</th>
      <th data-sort="machine">Máquina${sortArrow('lpars', 'machine')}</th>
      <th class="num" data-sort="peak4hraMsu">Maior 4HRA (MSU)${sortArrow('lpars', 'peak4hraMsu')}</th>
      <th data-sort="peak4hraAt">Quando${sortArrow('lpars', 'peak4hraAt')}</th>
      <th class="num" data-sort="secondPeak4hraMsu">2ª maior 4HRA (MSU)${sortArrow('lpars', 'secondPeak4hraMsu')}</th>
      <th data-sort="secondPeak4hraAt">Quando${sortArrow('lpars', 'secondPeak4hraAt')}</th>
    </tr>`;

    const lparRow = (l, cls = '') => `
      <tr${cls ? ` class="${cls}"` : ''}>
        <td><strong>${esc(l.name)}</strong></td>
        <td>${esc(l.machine || '–')}</td>
        <td class="num"><strong>${fmt(l.peak4hraMsu)}</strong></td>
        <td class="small muted">${esc(l.peak4hraAt || '–')}</td>
        <td class="num">${fmt(l.secondPeak4hraMsu)}</td>
        <td class="small muted">${esc(l.secondPeak4hraAt || '–')}</td>
      </tr>`;

    if (!grouped) {
      tbody.innerHTML = peaks.map((l) => lparRow(l)).join('');
    } else {
      // Nos picos de 4HRA a soma não faz sentido — o grupo mostra os dois maiores picos individuais.
      const groupRows = groups.map((g) => {
        const members = peaks.filter((l) => (g.lpars || []).includes(l.name));
        if (!members.length) return null;
        const [first, second] = members;
        const open = state.expandedGroups.has(g.name);
        return {
          sum: first.peak4hraMsu,
          label: g.name,
          html: `
          <tr class="group-row" data-group="${esc(g.name)}" title="Clique para ${open ? 'recolher' : 'ver'} as LPARs do grupo">
            <td><span class="chev ${open ? 'open' : ''}">${ICON_CHEVRON}</span>${groupBadge}<strong>${esc(g.name)}</strong> <span class="muted small">(${members.length} LPARs)</span></td>
            <td>${esc([...new Set(members.map((m) => m.machine))].length === 1 ? members[0].machine : `${[...new Set(members.map((m) => m.machine))].length} máquinas`)}</td>
            <td class="num"><strong>${fmt(first.peak4hraMsu)}</strong> <span class="muted small">(${esc(first.name)})</span></td>
            <td class="small muted">${esc(first.peak4hraAt || '–')}</td>
            <td class="num">${second ? `${fmt(second.peak4hraMsu)} <span class="muted small">(${esc(second.name)})</span>` : '–'}</td>
            <td class="small muted">${esc(second?.peak4hraAt || '–')}</td>
          </tr>` + (open ? members.map((m) => lparRow(m, 'group-member-row')).join('') : ''),
        };
      }).filter(Boolean);

      const leftovers = peaks
        .filter((l) => !groupOf.has(l.name))
        .map((l) => ({ sum: l.peak4hraMsu, label: l.name, html: lparRow(l) }));

      tbody.innerHTML = sortGroupEntries([...groupRows, ...leftovers])
        .map((r) => r.html)
        .join('');
      attachGroupRowToggles(tbody);
    }
  }
}

/* ── Capacity planning (projeção) ───────────────────── */

async function runForecast() {
  if (!state.clientId) return;
  const method = $('forecast-method').value;
  const years = $('forecast-years').value;
  const btn = $('btn-forecast');
  btn.disabled = true;
  btn.textContent = 'Projetando…';
  try {
    state.forecast = await api(`/clients/${state.clientId}/forecast?method=${method}&years=${years}`);
    renderForecast();
  } catch (err) {
    $('forecast-body').classList.add('hidden');
    $('forecast-empty').classList.remove('hidden');
    $('forecast-empty').innerHTML = `<span class="delta up">${esc(err.message)}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Projetar';
  }
}

function renderForecast() {
  const f = state.forecast;
  if (!f) return;
  $('forecast-empty').classList.add('hidden');
  $('forecast-body').classList.remove('hidden');

  const anos = f.horizonMonths / 12;
  $('forecast-title').textContent =
    `Capacity planning · ${anos === 1 ? '1 ano' : `${anos} anos`} à frente`;

  // Avisos (histórico curto, sazonalidade não estimada, meses faltando)
  const notes = $('forecast-notes');
  notes.classList.toggle('hidden', !f.notes.length);
  if (f.notes.length) {
    notes.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" style="margin-top:2px">' +
      '<path d="M8 1.8 15 14H1L8 1.8Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
      '<path d="M8 6.2v3.4M8 11.6h.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' +
      `<div>${f.notes.map((n) => esc(n)).join('<br>')}</div>`;
  }

  const m = f.model;
  const desc = m.method === 'sarima'
    ? `Modelo: <strong>${esc(m.order)}</strong> · AICc ${m.aicc.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}` +
      ` · ${m.observationsUsed} observações · desvio residual ${fmt(Math.round(m.sigma))} MSU`
    : `Modelo: <strong>regressão linear</strong> · inclinação ${fmt(Math.round(m.slope))} MSU/mês` +
      (m.r2 !== null ? ` · R² ${m.r2.toFixed(3)}` : '') +
      ` · desvio residual ${fmt(Math.round(m.sigma))} MSU`;
  $('forecast-model').innerHTML = `${desc} · faixa sombreada = intervalo de 95%`;

  renderForecastChart(f);
  renderForecastYears(f);
}

function renderForecastChart(f) {
  const ctx = $('forecastChart').getContext('2d');
  const labels = [...f.history.map((h) => h.periodLabel), ...f.forecast.map((p) => p.periodLabel)];
  const nH = f.history.length;

  const hist = [...f.history.map((h) => h.totalMsuConsumed), ...f.forecast.map(() => null)];
  // O primeiro ponto projetado repete o último real para a linha não ficar quebrada.
  const proj = [
    ...f.history.map((h, i) => (i === nH - 1 ? h.totalMsuConsumed : null)),
    ...f.forecast.map((p) => p.value),
  ];
  const banda = (campo) => [
    ...f.history.map((h, i) => (i === nH - 1 ? h.totalMsuConsumed : null)),
    ...f.forecast.map((p) => p[campo]),
  ];

  const baseline = f.client.monthlyBaselineMsu;
  const datasets = [
    {
      label: 'Consumo real',
      data: hist,
      borderColor: '#0f62fe',
      backgroundColor: '#0f62fe',
      borderWidth: 2,
      pointRadius: 2,
      pointHoverRadius: 4,
      tension: 0.1,
    },
    {
      label: `Projeção (${f.method === 'sarima' ? 'SARIMA' : 'regressão linear'})`,
      data: proj,
      borderColor: '#b45309',
      backgroundColor: '#b45309',
      borderWidth: 2,
      borderDash: [6, 4],
      pointRadius: 2,
      pointHoverRadius: 4,
      tension: 0.1,
    },
    {
      label: 'Intervalo de 95%',
      data: banda('upper'),
      borderColor: 'rgba(180, 83, 9, 0.25)',
      backgroundColor: 'rgba(180, 83, 9, 0.10)',
      borderWidth: 1,
      pointRadius: 0,
      fill: '+1', // preenche até a série seguinte (limite inferior)
      tension: 0.1,
    },
    {
      label: 'limite inferior',
      data: banda('lower'),
      borderColor: 'rgba(180, 83, 9, 0.25)',
      borderWidth: 1,
      pointRadius: 0,
      fill: false,
      tension: 0.1,
    },
  ];

  if (baseline) {
    datasets.push({
      label: `Baseline mensal (${fmtM(baseline)} MSU)`,
      data: labels.map(() => baseline),
      borderColor: '#da1e28',
      borderWidth: 2,
      borderDash: [4, 4],
      pointRadius: 0,
      fill: false,
    });
  }

  if (state.forecastChart) state.forecastChart.destroy();
  state.forecastChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          align: 'end',
          labels: {
            usePointStyle: true,
            pointStyleWidth: 10,
            boxHeight: 7,
            font: { size: 12 },
            // "limite inferior" é parte da banda, não merece entrada própria.
            filter: (item) => item.text !== 'limite inferior',
          },
        },
        tooltip: {
          backgroundColor: '#1c1c1c',
          padding: 12,
          filter: (item) => item.dataset.label !== 'limite inferior' && item.parsed.y !== null,
          callbacks: { label: (c) => ` ${c.dataset.label}: ${fmt(c.parsed.y)} MSU` },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 }, maxRotation: 0, autoSkipPadding: 12 } },
        y: {
          beginAtZero: false,
          grid: { color: '#eef1f5' },
          ticks: { font: { size: 12 }, callback: (v) => fmtM(v) },
          title: { display: true, text: 'MSUs por mês', font: { size: 12 } },
        },
      },
    },
  });
}

function renderForecastYears(f) {
  $('forecast-years-tbody').innerHTML = f.years.map((a) => {
    const composicao = a.projMonths === 0
      ? `<span class="tag tag-history">real</span> ${a.realMonths} meses`
      : a.realMonths === 0
        ? `<span class="tag tag-forecast">projetado</span> ${a.projMonths} meses`
        : `<span class="tag tag-history">real</span> ${a.realMonths} + <span class="tag tag-forecast">proj.</span> ${a.projMonths}`;
    const incompleto = a.complete ? '' : ' <span class="muted small">(ano parcial)</span>';
    const growth = a.growthPct === null || a.growthPct === undefined
      ? '<span class="muted">–</span>'
      : `<span class="delta ${a.growthPct >= 0 ? 'up' : 'down'}">${fmtPct(a.growthPct)}</span>`;
    const vsBase = a.vsBaselinePct === null
      ? '<span class="muted">–</span>'
      : `<span class="delta ${a.vsBaselinePct > 100 ? 'up' : 'down'}">${a.vsBaselinePct.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</span>`;
    return `
      <tr>
        <td><strong>${a.year}</strong>${incompleto}</td>
        <td>${composicao}</td>
        <td class="num"><strong>${fmt(a.totalMsu)}</strong></td>
        <td class="num">${growth}</td>
        <td class="num">${a.annualBaselineMsu ? fmt(a.annualBaselineMsu) : '<span class="muted">–</span>'}</td>
        <td class="num">${vsBase}</td>
      </tr>`;
  }).join('');
}

$('btn-open-forecast').addEventListener('click', () => {
  openModal('modal-forecast');
  // Redesenha no tamanho atual do modal se já houver projeção (canvas precisa estar visível).
  if (state.forecast) requestAnimationFrame(() => renderForecast());
});
$('btn-forecast').addEventListener('click', runForecast);
$('forecast-method').addEventListener('change', () => { if (state.forecast) runForecast(); });
$('forecast-years').addEventListener('change', () => { if (state.forecast) runForecast(); });

/* ── Comparativo mês a mês (atribuição da variação) ──── */

async function loadCompare() {
  if (!state.dashboard || !state.selectedPeriodKey) return;
  const target = state.dashboard.series.find((s) => s.periodKey === state.selectedPeriodKey);
  if (!target) return;

  const card = $('compare-card');
  if (state.dashboard.series.length < 2) {
    card.classList.remove('hidden');
    $('compare-empty').classList.remove('hidden');
    $('compare-body').classList.add('hidden');
    return;
  }
  $('compare-empty').classList.add('hidden');
  $('compare-body').classList.remove('hidden');

  const params = new URLSearchParams({ target: target.periodKey });
  if (state.compareBaseKey) params.set('base', state.compareBaseKey);
  try {
    state.compare = await api(`/clients/${state.clientId}/compare?${params}`);
  } catch (err) {
    // Base inválida para este alvo (ex.: alvo é o primeiro mês) — volta ao padrão.
    if (state.compareBaseKey) {
      state.compareBaseKey = null;
      return loadCompare();
    }
    toast(`Falha no comparativo: ${err.message}`, 'error');
    return;
  }
  state.compareMachine = null;
  renderCompare();
}

function renderCompare() {
  const c = state.compare;
  if (!c || !c.base || !c.target) return;

  $('compare-title').textContent = `Comparativo · ${c.target.periodLabel} vs ${c.base.periodLabel}`;

  // Seletor de mês base: todos os meses menos o alvo.
  const sel = $('compare-base');
  sel.innerHTML = c.availableMonths
    .filter((m) => m.periodKey !== c.target.periodKey)
    .map((m) => `<option value="${esc(m.periodKey)}">${esc(m.periodLabel)}</option>`)
    .join('');
  sel.value = c.base.periodKey;

  const up = c.totalDelta >= 0;
  $('compare-summary').innerHTML = `
    <span class="headline ${up ? 'delta up' : 'delta down'}">${up ? '+' : ''}${fmt(c.totalDelta)} MSU</span>
    <span>${up ? 'de aumento' : 'de redução'} em <strong>${esc(c.target.periodLabel)}</strong>
      (${fmt(c.target.totalMsuConsumed)}) vs <strong>${esc(c.base.periodLabel)}</strong>
      (${fmt(c.base.totalMsuConsumed)})</span>
    <span class="delta ${up ? 'up' : 'down'}">${fmtPct(c.totalDeltaPct)}</span>`;

  // Rótulos dos meses vão em data-label: paintSortHeaders os reescreve com a seta de ordenação.
  $('th-machine-base').dataset.label = c.base.periodLabel;
  $('th-machine-target').dataset.label = c.target.periodLabel;
  $('th-lpar-base').dataset.label = c.base.periodLabel;
  $('th-lpar-target').dataset.label = c.target.periodLabel;
  paintSortHeaders('compareMachines');
  paintSortHeaders('compareLpars');

  // Escala das barras: a maior variação absoluta da lista vira 100% do meio-lado.
  const maxAbs = Math.max(1, ...c.machines.map((m) => Math.abs(m.delta)));
  $('compare-machines-tbody').innerHTML = sortRows('compareMachines', c.machines).map((m) => `
    <tr data-machine="${esc(m.identifier)}" class="${state.compareMachine === m.identifier ? 'selected' : ''}"
        title="Ver as LPARs da máquina ${esc(m.identifier)}">
      <td><strong>${esc(m.identifier)}</strong>${statusTag(m.status)}
        ${m.typeModel ? `<div class="small muted">${esc(m.typeModel)}</div>` : ''}</td>
      <td class="num">${fmt(m.baseMsu)}</td>
      <td class="num">${fmt(m.targetMsu)}</td>
      <td class="num">${deltaCell(m.delta, m.deltaPct, maxAbs)}</td>
      <td class="num">${contribCell(m.contribPct)}</td>
    </tr>`).join('');

  $('compare-machines-tbody').querySelectorAll('tr[data-machine]').forEach((tr) => {
    tr.addEventListener('click', () => {
      const id = tr.dataset.machine;
      state.compareMachine = state.compareMachine === id ? null : id;
      renderCompare();
    });
  });

  renderCompareLpars();
}

function statusTag(status) {
  if (status === 'nova') return ' <span class="tag tag-new">nova</span>';
  if (status === 'removida') return ' <span class="tag tag-gone">removida</span>';
  return '';
}

function deltaCell(delta, deltaPct, maxAbs) {
  const up = delta >= 0;
  const width = (Math.abs(delta) / maxAbs) * 50; // metade da barra = maior variação
  return `<div class="delta-cell">
    <span class="delta ${delta === 0 ? 'flat' : up ? 'up' : 'down'}">
      ${up && delta !== 0 ? '+' : ''}${fmt(delta)}${deltaPct !== null ? ` <span class="small">(${fmtPct(deltaPct)})</span>` : ''}
    </span>
    <div class="delta-bar-track"><div class="delta-bar ${up ? 'up' : 'down'}" style="width:${width}%"></div></div>
  </div>`;
}

function contribCell(contribPct) {
  if (contribPct === null || contribPct === undefined) return '–';
  // >100% acontece quando um item sobe e outro cai: ele sozinho explica mais que o líquido.
  return `<strong>${contribPct.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</strong>`;
}

function renderCompareLpars() {
  const c = state.compare;
  const filter = state.compareMachine;

  const chip = $('compare-machine-chip');
  chip.classList.toggle('hidden', !filter);
  if (filter) chip.innerHTML = `Máquina ${esc(filter)}${ICON_CLOSE}`;
  $('compare-lpar-title').textContent = filter
    ? `Por LPAR · máquina ${filter}`
    : 'Por LPAR · todas as máquinas';

  $('compare-lpar-unavailable').classList.toggle('hidden', c.lparDetailAvailable);
  const rows = c.lparDetailAvailable
    ? sortRows('compareLpars', c.lpars.filter((l) => !filter || l.machine === filter))
    : [];
  const maxAbs = Math.max(1, ...rows.map((l) => Math.abs(l.delta)));

  $('compare-lpars-tbody').innerHTML = rows.map((l) => `
    <tr>
      <td><strong>${esc(l.name)}</strong>${statusTag(l.status)}</td>
      <td>${esc(l.machine || '–')}</td>
      <td class="num">${fmt(l.baseMsu)}</td>
      <td class="num">${fmt(l.targetMsu)}</td>
      <td class="num">${deltaCell(l.delta, l.deltaPct, maxAbs)}</td>
      <td class="num">${contribCell(l.contribPct)}</td>
    </tr>`).join('');
}

$('compare-base').addEventListener('change', async (e) => {
  state.compareBaseKey = e.target.value;
  await loadCompare();
});

$('compare-machine-chip').addEventListener('click', () => {
  state.compareMachine = null;
  renderCompare();
});

/** Dropdown dos grupos na visão agrupada: clique na linha do grupo mostra/esconde as LPARs. */
function attachGroupRowToggles(tbody) {
  tbody.querySelectorAll('tr.group-row[data-group]').forEach((tr) => {
    tr.addEventListener('click', () => {
      const name = tr.dataset.group;
      if (state.expandedGroups.has(name)) state.expandedGroups.delete(name);
      else state.expandedGroups.add(name);
      renderLparCard();
    });
  });
}

document.querySelectorAll('[data-lpar-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (state.lparTab === btn.dataset.lparTab) return;
    state.lparTab = btn.dataset.lparTab;
    document.querySelectorAll('[data-lpar-tab]').forEach((b) => b.classList.toggle('active', b === btn));
    renderLparCard();
  });
});

document.querySelectorAll('[data-lpar-view]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (state.lparView === btn.dataset.lparView) return;
    state.lparView = btn.dataset.lparView;
    document.querySelectorAll('[data-lpar-view]').forEach((b) => b.classList.toggle('active', b === btn));
    renderLparCard();
  });
});

$('lpar-machine-chip').addEventListener('click', () => {
  state.machineFilter = null;
  renderMachines();
  renderLparCard();
});

/* ── Gerenciamento de grupos de LPARs ───────────────── */

/** Nomes de LPAR conhecidos: os do mês selecionado + os já usados em grupos. */
function knownLparNames() {
  const names = new Set();
  for (const l of (state.reportDetail && state.reportDetail.lpars) || []) names.add(l.name);
  for (const g of clientLparGroups()) for (const l of g.lpars || []) names.add(l);
  return [...names].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

function renderGroupsModal() {
  const groups = clientLparGroups();
  const list = $('groups-list');
  list.innerHTML = groups.length
    ? groups.map((g) => `
        <span class="group-chip ${state.groupEditing === g.name ? 'editing' : ''}" data-edit-group="${esc(g.name)}" title="Editar grupo ${esc(g.name)}">
          ${esc(g.name)} <span class="count">· ${(g.lpars || []).length}</span>
        </span>`).join('') +
      `<span class="group-chip ${state.groupEditing === null ? 'editing' : ''}" id="chip-new-group" title="Criar um novo grupo">+ Novo grupo</span>`
    : '<div class="groups-empty">Nenhum grupo ainda — dê um nome abaixo, marque as LPARs e salve.</div>';

  list.querySelectorAll('[data-edit-group]').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.groupEditing = chip.dataset.editGroup;
      fillGroupForm();
      renderGroupsModal();
    });
  });
  const newChip = document.getElementById('chip-new-group');
  if (newChip) {
    newChip.addEventListener('click', () => {
      state.groupEditing = null;
      fillGroupForm();
      renderGroupsModal();
      $('input-group-name').focus();
    });
  }

  $('group-form-label').textContent = state.groupEditing ? `Editando grupo: ${state.groupEditing}` : 'Novo grupo';
  $('btn-delete-group').classList.toggle('hidden', !state.groupEditing);
}

function fillGroupForm() {
  const editing = clientLparGroups().find((g) => g.name === state.groupEditing) || null;
  $('input-group-name').value = editing ? editing.name : '';
  const inGroup = new Set(editing ? editing.lpars : []);
  const groupOf = lparToGroupMap();
  const presentNames = new Set(((state.reportDetail && state.reportDetail.lpars) || []).map((l) => l.name));

  $('group-lpar-checks').innerHTML = knownLparNames().map((name) => {
    const other = groupOf.get(name);
    const otherLabel = other && other !== state.groupEditing ? ` <span class="origin">(${esc(other)})</span>` : '';
    const absentLabel = presentNames.has(name) ? '' : ' <span class="origin">(fora deste mês)</span>';
    return `<label class="lpar-check">
      <input type="checkbox" value="${esc(name)}" ${inGroup.has(name) ? 'checked' : ''}>
      <span>${esc(name)}${otherLabel}${absentLabel}</span>
    </label>`;
  }).join('');
  updateGroupCount();
}

function updateGroupCount() {
  const n = $('group-lpar-checks').querySelectorAll('input:checked').length;
  $('group-lpar-count').textContent = n ? `· ${n} selecionada(s)` : '';
}
$('group-lpar-checks').addEventListener('change', updateGroupCount);

$('btn-manage-groups').addEventListener('click', () => {
  if (!state.reportDetail) return;
  state.groupEditing = null;
  fillGroupForm();
  renderGroupsModal();
  openModal('modal-groups');
  $('input-group-name').focus();
});

async function saveLparGroups(groups, successMsg) {
  const client = await api(`/clients/${state.clientId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lparGroups: groups }),
  });
  // Atualiza o estado local sem recarregar tudo.
  if (state.dashboard) state.dashboard.client = client;
  const idx = state.clients.findIndex((c) => c._id === client._id);
  if (idx !== -1) state.clients[idx] = { ...state.clients[idx], ...client };
  toast(successMsg);
  renderLparCard();
}

$('btn-save-group').addEventListener('click', async () => {
  const name = $('input-group-name').value.trim();
  if (!name) { toast('Dê um nome ao grupo.', 'error'); return; }
  const selected = [...$('group-lpar-checks').querySelectorAll('input:checked')].map((i) => i.value);
  if (!selected.length) { toast('Marque ao menos uma LPAR para o grupo.', 'error'); return; }

  const selectedSet = new Set(selected);
  // Remove as LPARs selecionadas dos demais grupos (mover) e descarta o grupo em edição.
  const others = clientLparGroups()
    .filter((g) => g.name !== state.groupEditing && g.name.toLowerCase() !== name.toLowerCase())
    .map((g) => ({ name: g.name, lpars: (g.lpars || []).filter((l) => !selectedSet.has(l)) }))
    .filter((g) => g.lpars.length > 0);

  try {
    await saveLparGroups([...others, { name, lpars: selected }], `Grupo "${name}" salvo.`);
    state.groupEditing = name;
    fillGroupForm();
    renderGroupsModal();
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('btn-delete-group').addEventListener('click', () => {
  const name = state.groupEditing;
  if (!name) return;
  askConfirm(`Excluir o grupo "${name}"? As LPARs voltam a aparecer individualmente.`, async () => {
    try {
      await saveLparGroups(
        clientLparGroups().filter((g) => g.name !== name).map((g) => ({ name: g.name, lpars: g.lpars })),
        `Grupo "${name}" excluído.`
      );
      state.groupEditing = null;
      fillGroupForm();
      renderGroupsModal();
      openModal('modal-groups');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
});

/* ── Init ───────────────────────────────────────────── */

(async function init() {
  try {
    await loadClients();
  } catch (err) {
    toast(`Falha ao carregar: ${err.message}`, 'error');
    showView('empty-clients');
  }
})();
