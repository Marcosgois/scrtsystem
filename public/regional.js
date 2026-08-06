'use strict';

/*
 * Painel gerencial: consumo agregado de um recorte de clientes — uma região (com
 * todas as regiões dentro dela) ou uma seleção avulsa.
 *
 * Toda a conta vem pronta do servidor (/api/regional/overview). Aqui não se soma
 * MSU: o total tem de ser exatamente o que a API calcula, que por sua vez usa a
 * mesma regra da tela individual (tag de máquina ignorada sai do faturável).
 */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const state = { modo: 'region', regionId: null, selecionados: new Set(), arvore: [], regions: [], clients: [], chart: null,
  rankingCompleto: false, ultimoConsumo: null };

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Erro ${res.status}`);
  return body;
}

function toast(message, kind = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('toast-stack').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

const nf = new Intl.NumberFormat('pt-BR');
const fmtMsu = (v) => (v == null ? '–' : nf.format(Math.round(v)));
const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
function rotuloMes(k) {
  const [a, m] = String(k).split('-').map(Number);
  return `${MESES[m - 1]}/${String(a).slice(-2)}`;
}
const fmtDia = (s) => { if (!s) return '—'; const [a, m, d] = String(s).split('-'); return `${d}/${m}/${a}`; };

/* ── Árvore de regiões ───────────────────────────────────────────────────── */
function renderArvore() {
  const linha = (r, nivel) => `
    <button type="button" class="region-node${state.regionId === r._id ? ' active' : ''}"
            data-region="${esc(r._id)}" style="padding-left:${12 + nivel * 20}px">
      <span class="region-name" data-no-i18n>${esc(r.name)}</span>
      <span class="region-count">${r.totalClientes} cliente(s)</span>
    </button>
    ${(r.filhas || []).map((f) => linha(f, nivel + 1)).join('')}`;

  const html = state.arvore.map((r) => linha(r, 0)).join('');
  $('rg-tree').innerHTML = `
    <button type="button" class="region-node${state.regionId === null ? ' active' : ''}" data-region="">
      <span class="region-name">Todos os clientes</span>
      <span class="region-count">${state.clients.length} cliente(s)</span>
    </button>${html}`
    || '<div class="access-empty">Nenhuma região cadastrada. Use o botão “Regiões” para criar.</div>';

  $('rg-tree').querySelectorAll('[data-region]').forEach((b) => b.addEventListener('click', () => {
    state.regionId = b.dataset.region || null;
    renderArvore();
    carregar();
  }));
}

function renderClientes() {
  $('rg-clients').innerHTML = state.clients.map((c) => `
    <label class="lpar-check">
      <input type="checkbox" value="${esc(c._id)}" ${state.selecionados.has(String(c._id)) ? 'checked' : ''}>
      <span data-no-i18n>${esc(c.name)}</span>
    </label>`).join('');
  $('rg-clients').querySelectorAll('input').forEach((i) => i.addEventListener('change', () => {
    if (i.checked) state.selecionados.add(i.value); else state.selecionados.delete(i.value);
  }));
}

/* ── Painel ──────────────────────────────────────────────────────────────── */
function renderChart(evolucao) {
  const ctx = $('rg-chart').getContext('2d');
  if (state.chart) state.chart.destroy();
  state.chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: evolucao.map((e) => rotuloMes(e.periodKey)),
      datasets: [{ label: 'MSU', data: evolucao.map((e) => e.totalMsuConsumed), backgroundColor: '#0f62fe', borderRadius: 3 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${nf.format(Math.round(c.parsed.y))} MSU` } } },
      scales: { y: { beginAtZero: true, ticks: { callback: (v) => nf.format(v) } } },
    },
  });
}

/*
 * Ranking de clientes. O top 5 é o padrão porque é o que responde "quem pesa
 * mais"; o ranking COMPLETO já vem na mesma resposta da API, então "ver todos"
 * só troca quantas linhas são desenhadas — nenhuma ida nova ao servidor.
 */
function renderRanking(c) {
  const todos = c.ranking || c.top5 || [];
  const lista = state.rankingCompleto ? todos : (c.top5 || []);
  const temMais = todos.length > (c.top5 || []).length;

  $('rg-top-title').textContent = state.rankingCompleto
    ? `Clientes por consumo (${todos.length})`
    : 'Top 5 clientes';

  const botao = $('rg-top-toggle');
  botao.classList.toggle('hidden', !temMais);
  botao.textContent = state.rankingCompleto ? 'Ver só o top 5' : `Ver todos (${todos.length})`;
  $('rg-top-wrap').classList.toggle('expandido', state.rankingCompleto);

  $('rg-top-body').innerHTML = lista.length ? lista.map((r, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><strong data-no-i18n>${esc(r.name)}</strong></td>
      <td class="num">${fmtMsu(r.totalMsuConsumed)}</td>
      <td class="num">${r.pctDoTotal.toFixed(1)}%</td>
      <td class="num">${r.maquinas || '<span class="muted">—</span>'}</td>
      <td class="num">${celulaMips(r)}</td>
      <td class="num">${celulaIfls(r)}</td>
    </tr>`).join('') : '<tr><td colspan="7" class="muted">Nenhum SCRT no período.</td></tr>';
}

/*
 * MIPS somado das máquinas do cliente. Quando alguma máquina não tem vínculo
 * LSPR, o total está POR BAIXO — e isso precisa aparecer, senão o número vira
 * uma comparação injusta entre clientes com o cadastro completo e incompleto.
 */
function celulaMips(r) {
  if (!r.mips) return '<span class="muted">—</span>';
  const parcial = r.mipsParcial
    ? ' <span class="muted small" title="Alguma máquina ainda não tem modelo LSPR vinculado, então o total está por baixo.">parcial</span>'
    : '';
  return `${nf.format(Math.round(r.mips))}${parcial}`;
}

// IFLs vêm do cadastro da máquina. Zero com parque cadastrado é informação
// ("esse cliente não tem IFL"); sem parque nenhum é "—" (não se sabe).
function celulaIfls(r) {
  if (!r.maquinas) return '<span class="muted">—</span>';
  const spare = r.iflsSpare ? ` <span class="muted small">+${r.iflsSpare} spare</span>` : '';
  return `${nf.format(r.ifls || 0)}${spare}`;
}

function render(d) {
  const temCliente = d.clients.length > 0;
  $('rg-empty').classList.toggle('hidden', temCliente);
  $('rg-body').classList.toggle('hidden', !temCliente);

  // Nome/caminho da região são dado; a contagem é rótulo e continua traduzível.
  const caminho = (d.recorte.caminho || []).join(' › ');
  const ehNomeDeRegiao = state.modo === 'region' && !!state.regionId;
  $('rg-title').textContent = d.recorte.nome;
  $('rg-title').toggleAttribute('data-no-i18n', ehNomeDeRegiao);
  $('rg-sub-path').textContent = caminho && caminho !== d.recorte.nome ? `${caminho} · ` : '';
  $('rg-sub-count').textContent = `${d.clients.length} cliente(s) no recorte`;
  if (!temCliente) return;

  const c = d.consumo;
  $('rg-kpi-mes-title').textContent = c.ultimoPeriodKey ? `Consumo · ${rotuloMes(c.ultimoPeriodKey)}` : 'Consumo do mês';
  $('rg-kpi-mes').textContent = fmtMsu(c.totalUltimoMes);
  $('rg-kpi-clientes').textContent = d.clients.length;
  $('rg-kpi-maquinas').textContent = d.parque.totalMaquinas;
  $('rg-kpi-eos').textContent = d.parque.maquinasForaDeSuporte;
  $('rg-kpi-baseline').textContent = d.contratos.baselineMensalTotal ? fmtMsu(d.contratos.baselineMensalTotal) : '–';
  $('rg-kpi-contratos-sub').textContent = `${d.contratos.comContrato} com contrato · ${d.contratos.semContrato} sem`;
  // A legenda precisa dizer QUAL grandeza é de qual origem: MSU é consumo medido
  // no SCRT do período; MIPS e IFLs são o parque cadastrado HOJE.
  $('rg-top-sub').textContent = c.janelaMeses.length
    ? `MSU de ${c.janelaMeses.length} mês(es): ${rotuloMes(c.janelaMeses[0])} a ${rotuloMes(c.janelaMeses[c.janelaMeses.length - 1])} · MIPS e IFLs do parque atual`
    : 'sem dado no período';

  renderChart(c.evolucao);

  state.ultimoConsumo = c;
  renderRanking(c);

  $('rg-park-body').innerHTML = d.parque.geracoes.length ? d.parque.geracoes.map((g) => `
    <tr>
      <td><strong data-no-i18n>${esc(g.family)}</strong>${g.dormentes ? ` <span class="muted small">(${g.dormentes} dormente)</span>` : ''}</td>
      <td class="num">${g.quantidade}</td>
      <td>${fmtDia(g.coslEos)}</td>
      <td>${g.semCicloDeVida
        ? '<span class="badge-neutral">sem ciclo de vida</span>'
        : g.foraDeSuporte
          ? '<span class="role-tag" style="background:#fff1f1;color:#da1e28;border-color:#ffd7d9">fora de suporte</span>'
          : '<span class="role-tag" style="background:#defbe6;color:#0e6027;border-color:#a7f0ba">em suporte</span>'}</td>
    </tr>`).join('') : '<tr><td colspan="4" class="muted">Nenhuma máquina cadastrada na infraestrutura.</td></tr>';

  $('rg-contracts-body').innerHTML = d.contratos.porCliente.map((r) => `
    <tr>
      <td><strong data-no-i18n>${esc(r.name)}</strong></td>
      <td data-no-i18n>${r.contrato ? esc(r.contrato) : '<span class="muted">—</span>'}</td>
      <td>${r.inicio ? rotuloMes(r.inicio) : '—'}</td>
      <td>${r.fim ? rotuloMes(r.fim) : (r.contrato ? '<span class="muted">vigente</span>' : '—')}</td>
      <td class="num">${r.anos || '—'}</td>
      <td class="num">${r.baselineMensalMsu ? fmtMsu(r.baselineMensalMsu) : '—'}</td>
    </tr>`).join('');
}

async function carregar() {
  const q = state.modo === 'region'
    ? (state.regionId ? `?region=${encodeURIComponent(state.regionId)}` : '')
    : `?clients=${[...state.selecionados].join(',')}`;
  if (state.modo === 'clients' && !state.selecionados.size) {
    $('rg-body').classList.add('hidden');
    $('rg-empty').classList.remove('hidden');
    return;
  }
  try { render(await api(`/regional/overview${q}`)); }
  catch (e) { toast(e.message, 'error'); }
}

/* ── Modal de regiões (admin) ────────────────────────────────────────────── */
function opcoesRegiao(selecionado, exceto) {
  return ['<option value="">— nenhuma —</option>'].concat(
    state.regions.filter((r) => String(r._id) !== String(exceto)).map((r) =>
      `<option value="${esc(r._id)}" ${String(r._id) === String(selecionado) ? 'selected' : ''} data-no-i18n>${esc(r.name)}</option>`)
  ).join('');
}

function renderModalRegioes() {
  $('rg-new-parent').innerHTML = opcoesRegiao(null, null);
  const porId = new Map(state.regions.map((r) => [String(r._id), r]));
  const contagem = new Map();
  for (const c of state.clients) if (c.region) contagem.set(String(c.region), (contagem.get(String(c.region)) || 0) + 1);

  // O nome é um input, não um <strong>: erro de digitação na criação da região se
  // conserta aqui mesmo, sem ter de excluir e recriar (o que exigiria mover os
  // clientes e as filhas antes).
  $('rg-regions-body').innerHTML = state.regions.map((r) => `
    <tr>
      <td><input type="text" class="cell-rename" data-rename="${esc(r._id)}" value="${esc(r.name)}" maxlength="60" aria-label="Nome da região" data-no-i18n></td>
      <td><select class="cell-select" data-parent="${esc(r._id)}">${opcoesRegiao(r.parent, r._id)}</select></td>
      <td class="num">${contagem.get(String(r._id)) || 0}</td>
      <td class="col-actions"><button class="row-action danger" data-del="${esc(r._id)}" title="Excluir">✕</button></td>
    </tr>`).join('') || '<tr><td colspan="4" class="muted">Nenhuma região ainda.</td></tr>';

  $('rg-client-region-body').innerHTML = state.clients.map((c) => `
    <tr>
      <td data-no-i18n>${esc(c.name)}</td>
      <td><select class="cell-select" data-client="${esc(c._id)}">${opcoesRegiao(c.region, null)}</select></td>
    </tr>`).join('');

  const erro = (e) => { $('rg-error').textContent = e; $('rg-error').classList.remove('hidden'); };
  $('rg-error').classList.add('hidden');

  // Renomear: grava ao sair do campo ou no Enter, e só se o nome mudou de verdade.
  // Esc devolve o valor anterior. Nome duplicado volta 409 da API e a linha é
  // recarregada com o nome original, para a tela não mentir sobre o que foi salvo.
  $('rg-regions-body').querySelectorAll('[data-rename]').forEach((i) => {
    const original = i.value;
    const salvar = async () => {
      const novo = i.value.trim();
      if (novo === original) { i.value = original; return; }
      if (!novo) { i.value = original; return erro('O nome não pode ficar vazio.'); }
      try { await api(`/admin/regions/${i.dataset.rename}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: novo }) }); await recarregarRegioes(); toast('Região renomeada.'); }
      catch (e) { i.value = original; erro(e.message); }
    };
    i.addEventListener('blur', salvar);
    i.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); i.blur(); }
      if (ev.key === 'Escape') { i.value = original; i.blur(); }
    });
  });

  $('rg-regions-body').querySelectorAll('[data-parent]').forEach((s) => s.addEventListener('change', async () => {
    try { await api(`/admin/regions/${s.dataset.parent}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent: s.value || null }) }); await recarregarRegioes(); toast('Região movida.'); }
    // Recarrega ANTES de mostrar o erro: o re-render limpa a mensagem, então na
    // ordem inversa o aviso do ciclo ("não pode ficar dentro de quem já está
    // dentro dela") aparecia e sumia no mesmo instante, e o select só voltava
    // sozinho sem explicação.
    catch (e) { await recarregarRegioes(); erro(e.message); }
  }));
  $('rg-regions-body').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    try { await api(`/admin/regions/${b.dataset.del}`, { method: 'DELETE' }); await recarregarRegioes(); toast('Região excluída.'); }
    catch (e) { erro(e.message); }
  }));
  $('rg-client-region-body').querySelectorAll('[data-client]').forEach((s) => s.addEventListener('change', async () => {
    try { await api(`/clients/${s.dataset.client}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ region: s.value || null }) }); await recarregarRegioes(); toast('Cliente movido.'); }
    catch (e) { erro(e.message); }
  }));
}

async function recarregarRegioes() {
  const r = await api('/regional/regions');
  state.arvore = r.arvore; state.regions = r.regions; state.clients = r.clients;
  renderArvore(); renderClientes(); renderModalRegioes();
  await carregar();
}

/* ── Eventos ─────────────────────────────────────────────────────────────── */
document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
  state.modo = b.dataset.mode;
  document.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('active', x === b));
  $('rg-picker-region').classList.toggle('hidden', state.modo !== 'region');
  $('rg-picker-clients').classList.toggle('hidden', state.modo !== 'clients');
  if (state.modo === 'region') carregar();
}));
$('rg-apply').addEventListener('click', carregar);
$('rg-top-toggle').addEventListener('click', () => {
  state.rankingCompleto = !state.rankingCompleto;
  if (state.ultimoConsumo) renderRanking(state.ultimoConsumo);   // redesenha com o que já veio
});
$('rg-all').addEventListener('click', () => { state.clients.forEach((c) => state.selecionados.add(String(c._id))); renderClientes(); });
$('rg-none').addEventListener('click', () => { state.selecionados.clear(); renderClientes(); });

$('btn-manage-regions').addEventListener('click', () => { renderModalRegioes(); $('modal-regions').classList.remove('hidden'); });
document.querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.modal-backdrop').forEach((m) => m.classList.add('hidden'));
}));
$('rg-new-add').addEventListener('click', async () => {
  const name = $('rg-new-name').value.trim();
  if (!name) return;
  try {
    await api('/admin/regions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, parent: $('rg-new-parent').value || null }) });
    $('rg-new-name').value = '';
    await recarregarRegioes();
    toast('Região criada.');
  } catch (e) { $('rg-error').textContent = e.message; $('rg-error').classList.remove('hidden'); }
});

recarregarRegioes().catch((e) => toast(`Falha ao carregar: ${e.message}`, 'error'));
