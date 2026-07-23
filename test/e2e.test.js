'use strict';

/* E2E: sobe MongoDB em memória + servidor, e exercita o fluxo completo da API. */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

const SAMPLE = path.join(__dirname, '..', 'SCRT', 'CAIXA', '#JUN2026.csv');
const BB_SAMPLE = path.join(__dirname, '..', 'SCRT', 'BB', 'PR3001-MES02.csv');
const BB_MES03 = path.join(__dirname, '..', 'SCRT', 'BB', 'PR3001-MES03.csv');
const BRB_SAMPLE = path.join(__dirname, '..', 'SCRT', 'BRB', 'SCRT - Janeiro 2026 - SIG.csv');
const brbFile = (n) => path.join(__dirname, '..', 'SCRT', 'BRB', n);
const BRB_JAN_SCN = brbFile('SCRT - Janeiro 2026 - SCN.csv');
const BRB_JAN_SIG = brbFile('SCRT - Janeiro 2026 - SIG.csv');
const BRB_FEV_SCN = brbFile('SCRT - Fevereiro 2026 - SCN.csv');
const BRB_FEV_SIG = brbFile('SCRT - Fevereiro 2026 - SIG.csv');
const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}/api`;

async function api(pathname, opts = {}) {
  const res = await fetch(`${BASE}${pathname}`, opts);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

function uploadForm(filePath, fileName) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(filePath)]), fileName);
  return form;
}

async function main() {
  console.log('Iniciando MongoDB em memória…');
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('tfpsystem-e2e');
  process.env.PORT = String(PORT);

  const { connectDb } = require('../src/db');
  const { app } = require('../server');
  await connectDb(process.env.MONGODB_URI);
  const server = app.listen(PORT);

  let failures = 0;
  const check = (name, cond, extra) => {
    if (cond) console.log(`  ✓ ${name}`);
    else { failures++; console.error(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : ''); }
  };

  try {
    // Clientes
    let r = await api('/clients');
    check('GET /clients vazio', r.status === 200 && r.body.length === 0, r.body);

    r = await api('/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'CAIXA' }),
    });
    check('POST /clients cria CAIXA', r.status === 201 && r.body.name === 'CAIXA', r.body);
    const caixaId = r.body._id;

    r = await api('/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'CAIXA' }),
    });
    check('POST /clients duplicado -> 409', r.status === 409, r.status);

    r = await api('/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'BRB', monthlyBaselineMsu: 5000000 }),
    });
    check('POST /clients cria BRB com baseline', r.status === 201 && r.body.monthlyBaselineMsu === 5000000, r.body);
    const brbId = r.body._id;

    // Upload SCRT
    r = await api(`/clients/${caixaId}/reports`, { method: 'POST', body: uploadForm(SAMPLE, '#JUN2026.csv') });
    check('upload SCRT -> 201', r.status === 201, { status: r.status, body: r.body });
    check('consumo mensal = 22.040.571 (soma Machine MSU Consumed)', r.body.report.totalMsuConsumed === 22040571, r.body.report.totalMsuConsumed);
    check('período Jun/2026', r.body.report.periodKey === '2026-06' && r.body.report.periodLabel === 'Jun/2026');
    check('6 máquinas persistidas', r.body.report.machines.length === 6);
    check('sem replaced no primeiro envio', r.body.replaced === false);
    const reportId = r.body.report._id;

    // Reenvio do mesmo mês substitui (upsert)
    r = await api(`/clients/${caixaId}/reports`, { method: 'POST', body: uploadForm(SAMPLE, '#JUN2026-v2.csv') });
    check('reenvio do mesmo mês -> replaced=true, status 200', r.status === 200 && r.body.replaced === true, r.body);
    check('mantém um único relatório do mês', r.body.report._id === reportId);

    // Upload para cliente errado gera aviso
    r = await api(`/clients/${brbId}/reports`, { method: 'POST', body: uploadForm(SAMPLE, '#JUN2026.csv') });
    check('SCRT da CAIXA no cliente BRB gera aviso de divergência',
      r.status === 201 && r.body.warnings.some((w) => w.includes('CAIXA') && w.includes('BRB')), r.body.warnings);

    // Upload dos outros formatos reais de SCRT (fluxo completo pela API)
    {
      const bbRes = await api('/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'BANCO DO BRASIL' }),
      });
      r = await api(`/clients/${bbRes.body._id}/reports`, {
        method: 'POST',
        body: uploadForm(BB_SAMPLE, 'PR3001-MES02.csv'),
      });
      check('upload do SCRT duplo-codificado (BB) -> 201 com 25.966.092 MSU',
        r.status === 201 && r.body.report.totalMsuConsumed === 25966092 && r.body.report.machines.length === 9,
        { status: r.status, total: r.body.report && r.body.report.totalMsuConsumed });
      check('BB: 44 LPARs persistidas', r.body.report.lpars.length === 44, r.body.report.lpars.length);

      // Comparativo mês a mês com dois meses reais do BB (Fev vs Mar/2026)
      await api(`/clients/${bbRes.body._id}/reports`, {
        method: 'POST',
        body: uploadForm(BB_MES03, 'PR3001-MES03.csv'),
      });
      r = await api(`/clients/${bbRes.body._id}/compare`);
      const cmp = r.body;
      check('compare: alvo Mar/2026 vs base Fev/2026 (padrão = mês anterior)',
        r.status === 200 && cmp.target.periodKey === '2026-03' && cmp.base.periodKey === '2026-02',
        { t: cmp.target && cmp.target.periodKey, b: cmp.base && cmp.base.periodKey });
      check('compare: variação total = 30.171.885 - 25.966.092 = 4.205.793',
        cmp.totalDelta === 30171885 - 25966092, cmp.totalDelta);
      check('compare: soma dos deltas das máquinas = variação total',
        cmp.machines.reduce((a, m) => a + m.delta, 0) === cmp.totalDelta);
      check('compare: soma dos deltas das LPARs = variação total',
        cmp.lpars.reduce((a, l) => a + l.delta, 0) === cmp.totalDelta);
      check('compare: máquinas ordenadas por maior aumento primeiro',
        cmp.machines.every((m, i) => i === 0 || cmp.machines[i - 1].delta >= m.delta));
      check('compare: contribuições somam ~100% da variação',
        Math.abs(cmp.machines.reduce((a, m) => a + (m.contribPct || 0), 0) - 100) < 0.001,
        cmp.machines.reduce((a, m) => a + (m.contribPct || 0), 0));
      check('compare: detalhe por LPAR disponível', cmp.lparDetailAvailable === true);
      check('compare: lista os meses disponíveis para o seletor',
        cmp.availableMonths.length === 2 && cmp.availableMonths[0].periodKey === '2026-02',
        cmp.availableMonths);

      r = await api(`/clients/${bbRes.body._id}/compare?target=2026-02&base=2026-03`);
      check('compare: inverter base/alvo inverte o sinal da variação',
        r.status === 200 && r.body.totalDelta === -(30171885 - 25966092), r.body.totalDelta);

      r = await api(`/clients/${bbRes.body._id}/compare?target=2026-99`);
      check('compare: mês inexistente -> 404', r.status === 404, r.status);

      const brbRes = await api('/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'BANCO DE BRASILIA' }),
      });
      r = await api(`/clients/${brbRes.body._id}/reports`, {
        method: 'POST',
        body: uploadForm(BRB_SAMPLE, 'SCRT - Janeiro 2026 - SIG.csv'),
      });
      check('upload do SCRT Sub-Capacity/MVM (BRB, máquina única) -> 201 com 520.762 MSU',
        r.status === 201 && r.body.report.totalMsuConsumed === 520762 && r.body.report.machines.length === 1,
        { status: r.status, total: r.body.report && r.body.report.totalMsuConsumed, err: r.body.error });
    }

    // Upload inválido
    const badForm = new FormData();
    badForm.append('file', new Blob([Buffer.from('a,b\n1,2\n')]), 'nao-scrt.csv');
    r = await api(`/clients/${caixaId}/reports`, { method: 'POST', body: badForm });
    check('CSV não-SCRT -> 422', r.status === 422, r.status);

    // Consultas
    r = await api(`/clients/${caixaId}/reports`);
    check('GET reports do cliente', r.status === 200 && r.body.length === 1);

    r = await api(`/reports/${reportId}`);
    check('GET report completo com máquinas', r.status === 200 && r.body.machines[0].serialNumber === '82-C5DC8');
    check('report persiste 50 LPARs com soma = total',
      r.body.lpars.length === 50 &&
      r.body.lpars.reduce((a, l) => a + (l.msuConsumed || 0), 0) === 22040571, r.body.lpars.length);

    r = await api(`/clients/${caixaId}/dashboard`);
    check('GET dashboard: série com 1 mês', r.status === 200 && r.body.series.length === 1, r.body);
    check('dashboard: MoM/YTY nulos sem histórico anterior',
      r.body.series[0].momPct === null && r.body.series[0].ytyPct === null);
    check('dashboard: capacidade agregada = 82.798',
      r.body.series[0].ratedCapacityMsus === 10894 + 14195 + 14581 + 16117 + 10894 + 16117, r.body.series[0].ratedCapacityMsus);
    check('dashboard: acumulado 12M com 1 mês = consumo do mês',
      r.body.series[0].acc12 === 22040571 && r.body.series[0].acc12Months === 1,
      { acc12: r.body.series[0].acc12, acc12Months: r.body.series[0].acc12Months });
    check('dashboard: lparCount = 50', r.body.series[0].lparCount === 50, r.body.series[0].lparCount);

    // Validações (correções da revisão)
    r = await api('/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'INVALIDO', monthlyBaselineMsu: 'abc' }),
    });
    check('baseline "abc" -> 400 (não 500)', r.status === 400, r.status);

    r = await api(`/clients/${caixaId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monthlyBaselineMsu: -5 }),
    });
    check('baseline negativo -> 400', r.status === 400, r.status);

    r = await api('/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"name": "X",}',
    });
    check('JSON malformado -> 400 (não 500)', r.status === 400, r.status);

    r = await api('/clients');
    check('GET /clients com contagem de relatórios',
      r.body.find((c) => c.name === 'CAIXA').reportCount === 1 &&
      r.body.find((c) => c.name === 'CAIXA').lastPeriodKey === '2026-06');

    // Baseline
    r = await api(`/clients/${caixaId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monthlyBaselineMsu: 19366655 }),
    });
    check('PATCH baseline', r.status === 200 && r.body.monthlyBaselineMsu === 19366655);

    // Grupos de LPARs
    r = await api(`/clients/${caixaId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lparGroups: [
        { name: 'Produção', lpars: ['P0', 'P4', 'PC'] },
        { name: 'Rio', lpars: ['BRJP2', 'BRJP4'] },
      ] }),
    });
    check('PATCH lparGroups salva 2 grupos',
      r.status === 200 && r.body.lparGroups.length === 2 && r.body.lparGroups[0].lpars.length === 3, r.body.lparGroups);

    r = await api(`/clients/${caixaId}/dashboard`);
    check('dashboard devolve lparGroups do cliente',
      r.status === 200 && r.body.client.lparGroups.length === 2);
    {
      const gb = r.body.series[0].groupBreakdown;
      const producao = gb ? gb.groups.find((g) => g.name === 'Produção') : null;
      const rio = gb ? gb.groups.find((g) => g.name === 'Rio') : null;
      // P0=1.226.272 + P4=1.199.300 + PC=1.184.078; BRJP2=822.411 + BRJP4=20.624
      check('groupBreakdown: Produção = 3.609.650 e Rio = 843.035',
        producao && producao.msu === 3609650 && rio && rio.msu === 843035, gb);
      check('groupBreakdown: grupos + sem grupo = total do mês',
        gb && gb.groups.reduce((a, g) => a + g.msu, 0) + gb.ungroupedMsu === 22040571, gb);
    }

    r = await api(`/clients/${caixaId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lparGroups: [
        { name: 'A', lpars: ['P0'] },
        { name: 'B', lpars: ['P0'] },
      ] }),
    });
    check('LPAR em dois grupos -> 400', r.status === 400, r.status);

    r = await api(`/clients/${caixaId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lparGroups: [{ name: '  ', lpars: ['P0'] }] }),
    });
    check('grupo sem nome -> 400', r.status === 400, r.status);

    r = await api(`/clients/${caixaId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lparGroups: [
        { name: 'prod', lpars: ['P0'] },
        { name: 'PROD', lpars: ['P4'] },
      ] }),
    });
    check('nomes de grupo duplicados (case-insensitive) -> 400', r.status === 400, r.status);

    // Exclusões
    r = await api(`/reports/${reportId}`, { method: 'DELETE' });
    check('DELETE report', r.status === 200);

    r = await api(`/clients/${brbId}`, { method: 'DELETE' });
    check('DELETE cliente apaga relatórios junto', r.status === 200 && r.body.deletedReports === 1, r.body);

    // ── Merge de vários SCRTs no mesmo mês (BRB: sites SCN e SIG) ─────────
    {
      const brbId2 = (await api('/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'BANCO DE BRASILIA S.A.' }),
      })).body._id;

      r = await api(`/clients/${brbId2}/reports`, { method: 'POST', body: uploadForm(BRB_JAN_SCN, 'SCRT - Janeiro 2026 - SCN.csv') });
      check('merge: 1º site (SCN) -> 201, mês com 1 origem',
        r.status === 201 && r.body.merged === false && r.body.month.totalMsuConsumed === 82576,
        { status: r.status, total: r.body.month && r.body.month.totalMsuConsumed });
      check('merge: rótulo do site derivado do arquivo', r.body.report.siteLabel === 'SCN', r.body.report.siteLabel);

      r = await api(`/clients/${brbId2}/reports`, { method: 'POST', body: uploadForm(BRB_JAN_SIG, 'SCRT - Janeiro 2026 - SIG.csv') });
      check('merge: 2º site (SIG) soma em vez de substituir -> 82.576 + 520.762 = 603.338',
        r.status === 201 && r.body.merged === true && r.body.month.totalMsuConsumed === 82576 + 520762,
        { merged: r.body.merged, total: r.body.month && r.body.month.totalMsuConsumed });
      check('merge: mês lista as 2 origens', r.body.month.sourceCount === 2, r.body.month.sourceCount);
      check('merge: sem conflito (máquinas diferentes)', r.body.conflicts.length === 0, r.body.conflicts);

      r = await api(`/clients/${brbId2}/months/2026-01`);
      check('merge: GET do mês fundido soma e une as máquinas',
        r.status === 200 && r.body.totalMsuConsumed === 603338 && r.body.machines.length === 2,
        { total: r.body.totalMsuConsumed, maq: r.body.machines && r.body.machines.length });
      check('merge: cada máquina sabe de qual origem veio',
        r.body.machines.map((m) => m.source).sort().join(',') === 'SCN,SIG',
        r.body.machines.map((m) => m.source));
      check('merge: LPARs das duas origens (7 + 3 = 10)',
        r.body.lpars.filter((l) => l.msuConsumed != null).length === 10,
        r.body.lpars.length);

      // Reenviar o MESMO site substitui (não duplica)
      r = await api(`/clients/${brbId2}/reports`, { method: 'POST', body: uploadForm(BRB_JAN_SIG, 'SCRT - Janeiro 2026 - SIG.csv') });
      check('merge: reenvio do mesmo site substitui (replaced) e mantém 2 origens',
        r.status === 200 && r.body.replaced === true && r.body.month.sourceCount === 2 &&
        r.body.month.totalMsuConsumed === 603338,
        { replaced: r.body.replaced, n: r.body.month.sourceCount, total: r.body.month.totalMsuConsumed });

      // Conflito: mesmo mês, arquivo com a MESMA máquina de outra origem
      const conflitante = fs.readFileSync(BRB_JAN_SCN).toString('latin1').replace('Janeiro', 'Janeiro');
      const form = new FormData();
      form.append('file', new Blob([Buffer.from(conflitante, 'latin1')]), 'SCRT - Janeiro 2026 - COPIA.csv');
      r = await api(`/clients/${brbId2}/reports`, { method: 'POST', body: form });
      check('merge: mesma máquina em outro arquivo do mês -> substitui a origem (sem duplicar)',
        r.status === 200 && r.body.month.sourceCount === 2 && r.body.month.totalMsuConsumed === 603338,
        { n: r.body.month.sourceCount, total: r.body.month.totalMsuConsumed });

      // Fevereiro nos dois sites, para o dashboard/comparativo
      await api(`/clients/${brbId2}/reports`, { method: 'POST', body: uploadForm(BRB_FEV_SCN, 'SCRT - Fevereiro 2026 - SCN.csv') });
      await api(`/clients/${brbId2}/reports`, { method: 'POST', body: uploadForm(BRB_FEV_SIG, 'SCRT - Fevereiro 2026 - SIG.csv') });

      r = await api(`/clients/${brbId2}/dashboard`);
      check('merge: dashboard tem 2 meses (não 4 relatórios)', r.body.series.length === 2, r.body.series.length);
      check('merge: Jan = 603.338 e Fev = 578.697 (90.410 + 488.287)',
        r.body.series[0].totalMsuConsumed === 603338 && r.body.series[1].totalMsuConsumed === 90410 + 488287,
        r.body.series.map((s) => s.totalMsuConsumed));
      check('merge: série informa as origens do mês', r.body.series[0].sourceCount === 2);

      r = await api(`/clients/${brbId2}/compare`);
      check('merge: comparativo usa os meses somados',
        r.status === 200 && r.body.totalDelta === (90410 + 488287) - 603338,
        r.body.totalDelta);
      check('merge: comparativo enxerga as 2 máquinas',
        r.body.machines.length === 2, r.body.machines.length);
    }

    // ── Capacity planning (projeção) ──────────────────────────────────────
    {
      // Cliente com 24 meses sintéticos, para o SARIMA ter o que estimar.
      const capId = (await api('/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'CLIENTE CAPACITY', monthlyBaselineMsu: 1000000 }),
      })).body._id;

      const mongoose = require('mongoose');
      const docs = [];
      for (let i = 0; i < 24; i++) {
        const y = 2024 + Math.floor(i / 12);
        const m = (i % 12) + 1;
        docs.push({
          client: new mongoose.Types.ObjectId(capId),
          periodKey: `${y}-${String(m).padStart(2, '0')}`,
          periodLabel: `M${m}/${y}`,
          sourceKey: 'SINTETICO',
          totalMsuConsumed: 1000000 + 10000 * i,
          machines: [], lpars: [], containers: [], warnings: [],
        });
      }
      await mongoose.connection.db.collection('scrtreports').insertMany(docs);

      r = await api(`/clients/${capId}/forecast?method=linear&years=2`);
      check('forecast: linear com 2 anos devolve 24 pontos',
        r.status === 200 && r.body.forecast.length === 24 && r.body.method === 'linear',
        { status: r.status, n: r.body.forecast && r.body.forecast.length });
      check('forecast: continua a tendência (próximo ≈ 1.240.000)',
        Math.abs(r.body.forecast[0].value - 1240000) < 5000, r.body.forecast[0]);
      check('forecast: intervalo de predição envolve o ponto',
        r.body.forecast.every((p) => p.lower <= p.value && p.value <= p.upper));
      check('forecast: consolida por ano com comparação ao baseline anual',
        r.body.years.length === 4 && r.body.years[0].annualBaselineMsu === 12000000,
        r.body.years.map((a) => a.year));
      check('forecast: crescimento ano-a-ano só entre anos completos',
        r.body.years[0].growthPct === undefined || r.body.years[0].growthPct === null);

      r = await api(`/clients/${capId}/forecast?method=sarima&years=1`);
      check('forecast: SARIMA com 24 meses estima sazonalidade',
        r.status === 200 && r.body.method === 'sarima' && r.body.model.seasonal === true,
        { method: r.body.method, model: r.body.model });
      check('forecast: modelo informa a ordem escolhida',
        /SARIMA\(\d,\d,\d\)\(\d,\d,\d\)\[12\]/.test(r.body.model.order), r.body.model.order);

      r = await api(`/clients/${capId}/forecast?years=9`);
      check('forecast: horizonte fora do limite -> 400', r.status === 400, r.status);

      // Cliente com 4 meses: suficiente para linear, insuficiente para SARIMA
      const curtoId = (await api('/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'CLIENTE HISTORICO CURTO' }),
      })).body._id;
      await mongoose.connection.db.collection('scrtreports').insertMany(
        [0, 1, 2, 3].map((i) => ({
          client: new mongoose.Types.ObjectId(curtoId),
          periodKey: `2026-0${i + 1}`,
          periodLabel: `M${i + 1}/2026`,
          sourceKey: 'SINTETICO',
          totalMsuConsumed: 500000 + 20000 * i,
          machines: [], lpars: [], containers: [], warnings: [],
        }))
      );
      r = await api(`/clients/${curtoId}/forecast?method=sarima&years=1`);
      check('forecast: histórico curto (4 meses) cai para linear avisando',
        r.status === 200 && r.body.method === 'linear' && r.body.requestedMethod === 'sarima' &&
        r.body.notes.some((n) => n.toLowerCase().includes('sarima')),
        { method: r.body.method, notes: r.body.notes });

      r = await api(`/clients/${caixaId}/forecast?method=linear&years=1`);
      check('forecast: cliente com 1 mês -> 422 explicando o mínimo', r.status === 422, r.status);
    }

    // ── Módulo de Inventário ──────────────────────────────────────────────
    {
      r = await api('/inventories');
      check('inventário: lista vazia no início', r.status === 200 && r.body.length === 0, r.body);

      r = await api(`/clients/${caixaId}/inventory`);
      check('inventário: cliente sem inventário -> 404', r.status === 404, r.status);

      const produtos = [
        { productId: '5698DG3', swSerial: 'W00000C', description: 'Data Gate for z/OS', category: 'LICENSE', features: [] },
        { productId: '5741A07', swSerial: 'W0001JR', description: 'z/VM Version 6', category: 'SS', features: [{ vue: 'X' }] },
      ];
      r = await api(`/clients/${caixaId}/inventory`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          products: produtos,
          clientName: 'CAIXA ECONOMICA FEDERAL',
          customerNumber: '095616',
          sourceFileName: 'inventario.htm',
          reportUpdatedAt: '22/07/2026, 22:00:00',
        }),
      });
      check('inventário: PUT cria -> 201 com 2 produtos',
        r.status === 201 && r.body.inventory.productCount === 2 && r.body.replaced === false,
        { status: r.status, count: r.body.inventory && r.body.inventory.productCount });
      check('inventário: sem aviso quando o nome do cliente bate',
        r.body.warnings.length === 0, r.body.warnings);

      r = await api(`/clients/${caixaId}/inventory`);
      check('inventário: GET devolve os produtos (estrutura preservada)',
        r.status === 200 && r.body.products.length === 2 &&
        r.body.products[0].productId === '5698DG3' &&
        Array.isArray(r.body.products[1].features), r.body.products && r.body.products.length);

      r = await api(`/clients/${caixaId}/inventory`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ products: [produtos[0]], clientName: 'BANCO XPTO' }),
      });
      check('inventário: reenvio substitui (replaced=true) e avisa divergência de cliente',
        r.status === 200 && r.body.replaced === true && r.body.inventory.productCount === 1 &&
        r.body.warnings.some((w) => w.includes('BANCO XPTO')), r.body.warnings);

      r = await api('/inventories');
      check('inventário: lista traz o cliente populado',
        r.status === 200 && r.body.length === 1 && r.body[0].client.name === 'CAIXA', r.body);

      r = await api(`/clients/${caixaId}/inventory`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ products: 'nao-e-lista' }),
      });
      check('inventário: products inválido -> 400', r.status === 400, r.status);

      r = await api(`/clients/${caixaId}/inventory`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ products: [] }),
      });
      check('inventário: lista vazia -> 422', r.status === 422, r.status);

      r = await api(`/clients/${caixaId}/inventory`, { method: 'DELETE' });
      check('inventário: DELETE remove', r.status === 200);
      r = await api(`/clients/${caixaId}/inventory`, { method: 'DELETE' });
      check('inventário: DELETE de novo -> 404', r.status === 404, r.status);
    }

    // Ids inválidos
    r = await api('/clients/xxx/dashboard');
    check('id inválido -> 400', r.status === 400);
  } finally {
    server.close();
    const mongoose = require('mongoose');
    await mongoose.disconnect();
    await mongod.stop();
  }

  console.log(failures === 0 ? '\nE2E: TODOS OS TESTES PASSARAM' : `\nE2E: ${failures} FALHA(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
