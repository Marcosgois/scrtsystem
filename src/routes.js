'use strict';

const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const { Client, ScrtReport, Inventory } = require('./models');
const { parseScrt, combineReports } = require('./scrtParser');
const { forecast } = require('./forecast');
const { isXlsx, readXlsxSheets, rowsToCsv } = require('./xlsx');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

function normalizeName(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

/** Normaliza o baseline: null/''/0 -> null (sem baseline); inválido ou negativo -> NaN (sinal de erro). */
function parseBaseline(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return n === 0 ? null : n;
}

const BASELINE_ERROR = 'Baseline mensal deve ser um número maior ou igual a zero.';

/** Seriais (ou identificadores) das máquinas, normalizados e ordenados. */
function machineSerials(machines) {
  return [...new Set(
    (machines || [])
      .map((m) => String(m.serialNumber || m.identifier || '').trim().toUpperCase())
      .filter(Boolean)
  )].sort();
}

/** Identidade física do relatório: o conjunto de máquinas que ele reporta. */
function sourceKeyOf(machines) {
  const serials = machineSerials(machines);
  return serials.length ? serials.join('|') : 'SEM-MAQUINA';
}

/** Rótulo curto da origem a partir do nome do arquivo (ex.: "… - SIG.csv" -> "SIG"). */
function siteLabelFrom(fileName, machines) {
  const base = String(fileName || '').replace(/\.[^.]+$/, '');
  const tail = base.split(/[-_]/).pop().trim();
  if (tail && tail.length <= 10 && /^[A-Za-z0-9 ]+$/.test(tail) && /[A-Za-z]/.test(tail)) {
    return tail.toUpperCase();
  }
  const serials = machineSerials(machines);
  return serials.length === 1 ? serials[0] : `${serials.length} máquinas`;
}

/**
 * Funde os relatórios de um mês numa visão única: soma o consumo e une
 * máquinas, LPARs e containers, mantendo a lista de origens para rastreio.
 */
function mergeMonth(reports) {
  if (!reports.length) return null;
  const first = reports[0];
  const machines = [];
  const lpars = [];
  const containers = [];
  const warnings = [];

  for (const r of reports) {
    const origem = r.siteLabel || r.sourceFileName || '';
    for (const m of r.machines || []) machines.push({ ...m, source: origem, reportId: r._id });
    for (const l of r.lpars || []) lpars.push({ ...l, source: origem });
    for (const c of r.containers || []) containers.push({ ...c, source: origem });
    for (const w of r.warnings || []) warnings.push(reports.length > 1 && origem ? `[${origem}] ${w}` : w);
  }

  const totalMsuConsumed = reports.reduce((a, r) => a + (r.totalMsuConsumed || 0), 0);
  const containersTotalMsu = containers.length
    ? containers.reduce((a, c) => a + (c.totalMsu || 0), 0)
    : null;

  // Conflito: a mesma máquina aparece em mais de uma origem do mesmo mês.
  const porSerial = new Map();
  for (const r of reports) {
    for (const s of machineSerials(r.machines)) {
      if (!porSerial.has(s)) porSerial.set(s, new Set());
      porSerial.get(s).add(r.siteLabel || r.sourceFileName || String(r._id));
    }
  }
  const conflicts = [...porSerial.entries()]
    .filter(([, origens]) => origens.size > 1)
    .map(([serial, origens]) => ({ serial, sources: [...origens] }));

  return {
    periodKey: first.periodKey,
    periodLabel: first.periodLabel,
    periodStart: first.periodStart,
    periodEnd: first.periodEnd,
    periodDays: first.periodDays,
    customerName: first.customerName,
    scrtToolRelease: first.scrtToolRelease,
    runDateTime: first.runDateTime,
    processorsInMultiplex: reports.reduce((a, r) => a + (r.processorsInMultiplex || 0), 0) || null,
    machines,
    lpars,
    containers,
    totalMsuConsumed,
    containersTotalMsu,
    warnings,
    conflicts,
    sources: reports.map((r) => ({
      reportId: r._id,
      siteLabel: r.siteLabel || null,
      sourceFileName: r.sourceFileName || null,
      totalMsuConsumed: r.totalMsuConsumed,
      machineCount: (r.machines || []).length,
      machines: machineSerials(r.machines),
      periodDays: r.periodDays,
      runDateTime: r.runDateTime,
      scrtToolRelease: r.scrtToolRelease,
      customerName: r.customerName,
      createdAt: r.createdAt,
    })),
  };
}

/** Agrupa relatórios (já ordenados) por mês e devolve os meses fundidos. */
function mergeByMonth(reports) {
  const byKey = new Map();
  for (const r of reports) {
    if (!byKey.has(r.periodKey)) byKey.set(r.periodKey, []);
    byKey.get(r.periodKey).push(r);
  }
  return [...byKey.keys()].sort().map((k) => mergeMonth(byKey.get(k)));
}

/** Referência enxuta de um mês (para seletores e cabeçalhos do comparativo). */
function monthRef(report) {
  return {
    periodKey: report.periodKey,
    periodLabel: report.periodLabel,
    totalMsuConsumed: report.totalMsuConsumed,
  };
}

/**
 * Valida e normaliza os grupos de LPARs.
 * Regras: nome de grupo obrigatório e único (case-insensitive); cada LPAR em no máximo um grupo.
 * @returns {{groups?: Array<{name: string, lpars: string[]}>, error?: string}}
 */
function parseLparGroups(value) {
  if (!Array.isArray(value)) return { error: 'lparGroups deve ser uma lista de grupos.' };
  const seenNames = new Set();
  const seenLpars = new Set();
  const groups = [];
  for (const g of value) {
    if (!g || typeof g.name !== 'string' || !g.name.trim()) {
      return { error: 'Todo grupo precisa de um nome.' };
    }
    const name = g.name.trim();
    if (name.length > 60) return { error: 'Nome de grupo muito longo (máx. 60 caracteres).' };
    const nameKey = name.toLowerCase();
    if (seenNames.has(nameKey)) return { error: `Grupo duplicado: "${name}".` };
    seenNames.add(nameKey);
    if (!Array.isArray(g.lpars)) return { error: `Grupo "${name}": lista de LPARs inválida.` };
    const lpars = [];
    for (const l of g.lpars) {
      if (typeof l !== 'string' || !l.trim()) return { error: `Grupo "${name}": LPAR inválida.` };
      const lparName = l.trim();
      if (seenLpars.has(lparName)) {
        return { error: `A LPAR ${lparName} está em mais de um grupo — cada LPAR pode pertencer a apenas um.` };
      }
      seenLpars.add(lparName);
      lpars.push(lparName);
    }
    groups.push({ name, lpars });
  }
  return { groups };
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── Clientes ────────────────────────────────────────────────────────────────

router.get('/clients', asyncHandler(async (req, res) => {
  const clients = await Client.find().sort({ name: 1 }).lean();
  const stats = await ScrtReport.aggregate([
    {
      $group: {
        _id: '$client',
        reportCount: { $sum: 1 },
        lastPeriodKey: { $max: '$periodKey' },
      },
    },
  ]);
  const statsById = new Map(stats.map((s) => [String(s._id), s]));
  res.json(
    clients.map((c) => {
      const s = statsById.get(String(c._id));
      return {
        ...c,
        reportCount: s ? s.reportCount : 0,
        lastPeriodKey: s ? s.lastPeriodKey : null,
      };
    })
  );
}));

router.post('/clients', asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Informe o nome do cliente.' });
  const monthlyBaselineMsu = parseBaseline(req.body.monthlyBaselineMsu);
  if (Number.isNaN(monthlyBaselineMsu)) return res.status(400).json({ error: BASELINE_ERROR });
  try {
    const client = await Client.create({ name, monthlyBaselineMsu });
    res.status(201).json(client);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Já existe um cliente com esse nome.' });
    throw err;
  }
}));

router.patch('/clients/:id', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const update = {};
  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: 'Nome não pode ser vazio.' });
    update.name = name;
  }
  if (req.body.monthlyBaselineMsu !== undefined) {
    const baseline = parseBaseline(req.body.monthlyBaselineMsu);
    if (Number.isNaN(baseline)) return res.status(400).json({ error: BASELINE_ERROR });
    update.monthlyBaselineMsu = baseline;
  }
  if (req.body.notes !== undefined) update.notes = String(req.body.notes);
  if (req.body.lparGroups !== undefined) {
    const { groups, error } = parseLparGroups(req.body.lparGroups);
    if (error) return res.status(400).json({ error });
    update.lparGroups = groups;
  }
  try {
    const client = await Client.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
    if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });
    res.json(client);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Já existe um cliente com esse nome.' });
    throw err;
  }
}));

router.delete('/clients/:id', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const client = await Client.findByIdAndDelete(req.params.id);
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });
  const { deletedCount } = await ScrtReport.deleteMany({ client: client._id });
  const inv = await Inventory.deleteOne({ client: client._id });
  res.json({ ok: true, deletedReports: deletedCount, deletedInventories: inv.deletedCount });
}));

// ── Upload de SCRT ──────────────────────────────────────────────────────────

router.post('/clients/:id/reports', upload.single('file'), asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const client = await Client.findById(req.params.id);
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });
  if (!req.file) return res.status(400).json({ error: 'Envie o arquivo SCRT (.csv) no campo "file".' });

  let parsed;
  let sheetCount = 0;
  try {
    if (isXlsx(req.file.buffer)) {
      // Planilha: cada aba é uma máquina; combina num multiplex único.
      const sheets = readXlsxSheets(req.file.buffer);
      const parsedSheets = [];
      for (const sheet of sheets) {
        try {
          parsedSheets.push(parseScrt(Buffer.from(rowsToCsv(sheet.rows), 'utf8')));
        } catch (e) {
          // Aba que não é um SCRT (resumo, notas etc.) — ignora.
        }
      }
      if (!parsedSheets.length) {
        return res.status(422).json({ error: 'Nenhuma aba da planilha é um SCRT válido.' });
      }
      parsed = combineReports(parsedSheets);
      sheetCount = parsedSheets.length;
    } else {
      parsed = parseScrt(req.file.buffer);
    }
  } catch (err) {
    return res.status(422).json({ error: `Falha ao interpretar o SCRT: ${err.message}` });
  }

  const warnings = [...parsed.warnings];
  if (sheetCount > 1) {
    warnings.push(`Planilha com ${sheetCount} abas (máquinas) combinadas num multiplex de ${parsed.machines.length} máquina(s).`);
  }
  const clientNorm = normalizeName(client.name);
  const customerNorm = normalizeName(parsed.customerName);
  if (clientNorm && customerNorm && !customerNorm.includes(clientNorm) && !clientNorm.includes(customerNorm)) {
    warnings.push(
      `Atenção: o SCRT é de "${parsed.customerName}", mas foi enviado para o cliente "${client.name}".`
    );
  }

  const sourceKey = sourceKeyOf(parsed.machines);
  const fileName = req.file.originalname
    // multer 1.x entrega o filename como latin1; reinterpreta para UTF-8 (acentos).
    ? Buffer.from(req.file.originalname, 'latin1').toString('utf8')
    : null;

  // Conflito: alguma máquina deste arquivo já foi reportada por OUTRA origem no mesmo mês.
  const irmaos = await ScrtReport.find({
    client: client._id,
    periodKey: parsed.periodKey,
    sourceKey: { $ne: sourceKey },
  }).lean();
  const serieNova = new Set(machineSerials(parsed.machines));
  const conflicts = [];
  for (const irmao of irmaos) {
    const repetidas = machineSerials(irmao.machines).filter((s) => serieNova.has(s));
    if (repetidas.length) {
      conflicts.push({
        serials: repetidas,
        withFile: irmao.sourceFileName || irmao.siteLabel || irmao.periodLabel,
      });
      warnings.push(
        `Conflito: a(s) máquina(s) ${repetidas.join(', ')} já constam em "${irmao.sourceFileName || irmao.siteLabel}" ` +
        `no mesmo mês (${parsed.periodLabel}). O consumo seria contado em dobro — confira antes de usar os números.`
      );
    }
  }

  const doc = {
    client: client._id,
    sourceKey,
    siteLabel: siteLabelFrom(fileName, parsed.machines),
    periodKey: parsed.periodKey,
    periodLabel: parsed.periodLabel,
    periodStart: parsed.reportingPeriod.start,
    periodEnd: parsed.reportingPeriod.end,
    periodDays: parsed.reportingPeriod.days,
    customerName: parsed.customerName,
    scrtToolRelease: parsed.scrtToolRelease,
    runDateTime: parsed.runDateTime,
    submitter: parsed.submitter,
    processorsInMultiplex: parsed.processorsInMultiplex,
    machines: parsed.machines,
    containers: parsed.containers,
    lpars: parsed.lpars,
    totalMsuConsumed: parsed.totalMsuConsumed,
    containersTotalMsu: parsed.containersTotalMsu,
    warnings,
    sourceFileName: fileName,
  };

  // Mesma origem (mesmas máquinas) = reenvio, substitui. Origem nova = soma ao mês.
  const existing = await ScrtReport.findOne({ client: client._id, periodKey: parsed.periodKey, sourceKey });
  const report = await ScrtReport.findOneAndUpdate(
    { client: client._id, periodKey: parsed.periodKey, sourceKey },
    { $set: doc },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  // Total do mês já com este arquivo incluído.
  const doMes = await ScrtReport.find({ client: client._id, periodKey: parsed.periodKey }).lean();
  const merged = mergeMonth(doMes);

  res.status(existing ? 200 : 201).json({
    replaced: Boolean(existing),
    merged: doMes.length > 1,
    sheetCount, // abas combinadas (planilha .xlsx); 0 para CSV
    conflicts,
    report,
    month: {
      periodKey: merged.periodKey,
      periodLabel: merged.periodLabel,
      totalMsuConsumed: merged.totalMsuConsumed,
      sourceCount: merged.sources.length,
      sources: merged.sources,
    },
    warnings,
  });
}));

// ── Consultas ───────────────────────────────────────────────────────────────

router.get('/clients/:id/reports', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const reports = await ScrtReport.find({ client: req.params.id })
    .select('periodKey periodLabel totalMsuConsumed containersTotalMsu processorsInMultiplex machines.identifier sourceFileName warnings createdAt updatedAt')
    .sort({ periodKey: 1 })
    .lean();
  res.json(reports);
}));

router.get('/reports/:id', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const report = await ScrtReport.findById(req.params.id).lean();
  if (!report) return res.status(404).json({ error: 'Relatório não encontrado.' });
  res.json(report);
}));

/** Mês fundido: soma das origens (sites) enviadas para aquele cliente/mês. */
router.get('/clients/:id/months/:periodKey', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  if (!/^\d{4}-\d{2}$/.test(req.params.periodKey)) {
    return res.status(400).json({ error: 'Mês inválido (use AAAA-MM).' });
  }
  const reports = await ScrtReport.find({ client: req.params.id, periodKey: req.params.periodKey })
    .sort({ siteLabel: 1, createdAt: 1 })
    .lean();
  if (!reports.length) return res.status(404).json({ error: 'Mês não encontrado para este cliente.' });
  res.json(mergeMonth(reports));
}));

/** Exclui o mês inteiro (todas as origens/SCRTs daquele cliente e período). */
router.delete('/clients/:id/months/:periodKey', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  if (!/^\d{4}-\d{2}$/.test(req.params.periodKey)) {
    return res.status(400).json({ error: 'Mês inválido (use AAAA-MM).' });
  }
  const { deletedCount } = await ScrtReport.deleteMany({
    client: req.params.id,
    periodKey: req.params.periodKey,
  });
  if (!deletedCount) return res.status(404).json({ error: 'Mês não encontrado para este cliente.' });
  res.json({ ok: true, deletedReports: deletedCount });
}));

router.delete('/reports/:id', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const report = await ScrtReport.findByIdAndDelete(req.params.id);
  if (!report) return res.status(404).json({ error: 'Relatório não encontrado.' });
  res.json({ ok: true });
}));

/**
 * Série mensal consolidada do cliente para o dashboard,
 * com variação mês-a-mês (MoM) e ano-a-ano (YTY).
 */
router.get('/clients/:id/dashboard', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const client = await Client.findById(req.params.id).lean();
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });

  const raw = await ScrtReport.find({ client: client._id }).sort({ periodKey: 1, createdAt: 1 }).lean();
  // Cada mês pode ter vários SCRTs (sites diferentes) — trabalha sobre o mês fundido.
  const reports = mergeByMonth(raw);
  const byKey = new Map(reports.map((r) => [r.periodKey, r]));
  // Consumo por grupo de LPARs em cada mês (usa os grupos ATUAIS do cliente).
  const groupsDef = (client.lparGroups || []).map((g) => ({ name: g.name, set: new Set(g.lpars || []) }));
  const breakdownOf = (r) => {
    const usage = (r.lpars || []).filter((l) => l.msuConsumed != null);
    if (!usage.length) return null; // mês sem seções N7 — sem detalhe por LPAR
    const groups = groupsDef.map((g) => ({ name: g.name, msu: 0 }));
    let ungroupedMsu = 0;
    for (const l of usage) {
      const idx = groupsDef.findIndex((g) => g.set.has(l.name));
      if (idx >= 0) groups[idx].msu += l.msuConsumed;
      else ungroupedMsu += l.msuConsumed;
    }
    return { groups, ungroupedMsu };
  };
  // Índice absoluto de mês (ano*12+mês) para janela móvel de 12 meses do acumulado.
  const byMonthIdx = new Map(reports.map((r) => {
    const [y, m] = r.periodKey.split('-').map(Number);
    return [y * 12 + (m - 1), r.totalMsuConsumed];
  }));

  const series = reports.map((r, i) => {
    const [year, month] = r.periodKey.split('-').map(Number);
    const monthIdx = year * 12 + (month - 1);
    let acc12 = 0;
    let acc12Months = 0;
    for (let k = 0; k < 12; k++) {
      const v = byMonthIdx.get(monthIdx - k);
      if (v !== undefined) { acc12 += v; acc12Months++; }
    }
    const prevYearKey = `${year - 1}-${String(month).padStart(2, '0')}`;
    const prevYear = byKey.get(prevYearKey) || null;

    // MoM só compara com o mês imediatamente anterior no calendário.
    const prevDate = new Date(Date.UTC(year, month - 2, 1));
    const prevMonthKey = `${prevDate.getUTCFullYear()}-${String(prevDate.getUTCMonth() + 1).padStart(2, '0')}`;
    const prevMonth = byKey.get(prevMonthKey) || null;

    return {
      periodKey: r.periodKey,
      periodLabel: r.periodLabel,
      totalMsuConsumed: r.totalMsuConsumed,
      containersTotalMsu: r.containersTotalMsu,
      machineCount: r.machines ? r.machines.length : 0,
      // Origens (sites) que compõem o mês e conflitos entre elas.
      sourceCount: r.sources.length,
      sources: r.sources,
      conflicts: r.conflicts,
      peakUtilizationMsus: r.machines
        ? r.machines.reduce((acc, m) => acc + (m.peakUtilizationMsus || 0), 0)
        : null,
      ratedCapacityMsus: r.machines
        ? r.machines.reduce((acc, m) => acc + (m.ratedCapacityMsus || 0), 0)
        : null,
      warnings: r.warnings || [],
      // Soma móvel dos últimos 12 meses de calendário (só os meses presentes).
      acc12,
      acc12Months,
      groupBreakdown: breakdownOf(r),
      // Detalhamento do mês por máquina e por LPAR (para os modos do gráfico).
      machineBreakdown: (r.machines || []).map((m) => ({
        id: m.identifier || m.serialNumber || '—',
        msu: m.msuConsumed || 0,
      })),
      lparBreakdown: (r.lpars || [])
        .filter((l) => l.msuConsumed != null)
        .map((l) => ({ key: `${l.machine || ''}|${l.name}`, name: l.name, machine: l.machine || null, msu: l.msuConsumed })),
      lparCount: r.lpars ? r.lpars.filter((l) => l.msuConsumed != null).length : 0,
      // Base zero (mês parado/dados parciais) não gera Infinity/NaN — fica null como "sem base de comparação".
      momPct: prevMonth && prevMonth.totalMsuConsumed > 0
        ? ((r.totalMsuConsumed - prevMonth.totalMsuConsumed) / prevMonth.totalMsuConsumed) * 100 : null,
      ytyPct: prevYear && prevYear.totalMsuConsumed > 0
        ? ((r.totalMsuConsumed - prevYear.totalMsuConsumed) / prevYear.totalMsuConsumed) * 100 : null,
    };
  });

  const latest = reports.length > 0 ? reports[reports.length - 1] : null;
  res.json({ client, series, latest });
}));

/**
 * Comparativo entre dois meses: atribui a variação de consumo às máquinas e,
 * dentro delas, às LPARs — para responder "quem puxou o consumo pra cima?".
 * ?target=2026-06 (padrão: último mês) &base=2026-05 (padrão: mês anterior na série)
 */
router.get('/clients/:id/compare', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const client = await Client.findById(req.params.id).lean();
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });

  // Compara MESES fundidos (um mês pode vir de vários SCRTs).
  const reports = mergeByMonth(
    await ScrtReport.find({ client: client._id }).sort({ periodKey: 1, createdAt: 1 }).lean()
  );
  if (reports.length < 2) {
    return res.json({ base: null, target: null, machines: [], lpars: [], totalDelta: 0, availableMonths: reports.map(monthRef) });
  }

  const targetKey = req.query.target || reports[reports.length - 1].periodKey;
  const targetIdx = reports.findIndex((r) => r.periodKey === targetKey);
  if (targetIdx === -1) return res.status(404).json({ error: `Mês ${targetKey} não encontrado para este cliente.` });

  const baseKey = req.query.base || (targetIdx > 0 ? reports[targetIdx - 1].periodKey : null);
  const baseIdx = reports.findIndex((r) => r.periodKey === baseKey);
  if (baseIdx === -1) {
    return res.status(400).json({ error: 'Não há um mês anterior para comparar com este.' });
  }

  const target = reports[targetIdx];
  const base = reports[baseIdx];
  const totalDelta = target.totalMsuConsumed - base.totalMsuConsumed;
  // Cada item contribui com sua fatia da variação total (soma das contribuições = 100%).
  const contrib = (delta) => (totalDelta !== 0 ? (delta / totalDelta) * 100 : null);
  const pct = (delta, from) => (from > 0 ? (delta / from) * 100 : null);

  const diffRows = (baseItems, targetItems, keyOf, labelOf) => {
    const baseMap = new Map(baseItems.map((i) => [keyOf(i), i]));
    const targetMap = new Map(targetItems.map((i) => [keyOf(i), i]));
    const keys = new Set([...baseMap.keys(), ...targetMap.keys()]);
    return [...keys].map((k) => {
      const b = baseMap.get(k);
      const t = targetMap.get(k);
      const baseMsu = b ? (b.msuConsumed || 0) : 0;
      const targetMsu = t ? (t.msuConsumed || 0) : 0;
      const delta = targetMsu - baseMsu;
      return {
        ...labelOf(t || b),
        baseMsu,
        targetMsu,
        delta,
        deltaPct: pct(delta, baseMsu),
        contribPct: contrib(delta),
        status: !b ? 'nova' : !t ? 'removida' : 'ok',
      };
    }).sort((a, b) => b.delta - a.delta);
  };

  const machines = diffRows(
    base.machines || [],
    target.machines || [],
    (m) => m.identifier,
    (m) => ({ identifier: m.identifier, typeModel: m.typeModel || null, serialNumber: m.serialNumber || null })
  );

  const lparsOf = (r) => (r.lpars || []).filter((l) => l.msuConsumed != null);
  const lpars = diffRows(
    lparsOf(base),
    lparsOf(target),
    (l) => `${l.machine}|${l.name}`,
    (l) => ({ name: l.name, machine: l.machine || null, os: l.os || null })
  );

  res.json({
    base: monthRef(base),
    target: monthRef(target),
    totalDelta,
    totalDeltaPct: pct(totalDelta, base.totalMsuConsumed),
    machines,
    // Meses sem seções N7 não têm detalhe por LPAR — o front avisa em vez de mostrar tabela vazia.
    lparDetailAvailable: lparsOf(base).length > 0 && lparsOf(target).length > 0,
    lpars,
    availableMonths: reports.map(monthRef),
  });
}));

/**
 * Capacity planning: projeta o consumo dos próximos anos.
 * ?method=linear|sarima  &years=1..5  (ou &months=1..60)
 */
router.get('/clients/:id/forecast', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const client = await Client.findById(req.params.id).lean();
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });

  const method = req.query.method === 'sarima' ? 'sarima' : 'linear';
  const years = req.query.years !== undefined ? Number(req.query.years) : null;
  const monthsRaw = req.query.months !== undefined ? Number(req.query.months) : null;
  let months = monthsRaw !== null ? monthsRaw : (years !== null ? years * 12 : 12);
  if (!Number.isFinite(months) || months < 1 || months > 60) {
    return res.status(400).json({ error: 'Horizonte inválido: informe de 1 a 5 anos (até 60 meses).' });
  }
  months = Math.round(months);

  const monthsData = mergeByMonth(
    await ScrtReport.find({ client: client._id }).sort({ periodKey: 1, createdAt: 1 }).lean()
  );
  const history = monthsData.map((m) => ({
    periodKey: m.periodKey,
    periodLabel: m.periodLabel,
    totalMsuConsumed: m.totalMsuConsumed,
    year: Number(m.periodKey.slice(0, 4)),
  }));

  let result;
  try {
    result = forecast(history, { method, months });
  } catch (err) {
    if (err.status === 422) return res.status(422).json({ error: err.message });
    throw err;
  }

  // Consolidação por ano-calendário: o que o cliente precisa para planejar capacidade.
  const baseline = client.monthlyBaselineMsu || null;
  const porAno = new Map();
  const add = (year, value, tipo) => {
    if (!porAno.has(year)) porAno.set(year, { year, realMsu: 0, realMonths: 0, projMsu: 0, projMonths: 0 });
    const a = porAno.get(year);
    if (tipo === 'real') { a.realMsu += value; a.realMonths++; } else { a.projMsu += value; a.projMonths++; }
  };
  for (const h of history) add(h.year, h.totalMsuConsumed, 'real');
  for (const p of result.points) add(p.year, p.value, 'proj');

  const anos = [...porAno.values()].sort((a, b) => a.year - b.year).map((a) => {
    const total = a.realMsu + a.projMsu;
    const meses = a.realMonths + a.projMonths;
    return {
      ...a,
      totalMsu: total,
      months: meses,
      complete: meses === 12,
      annualBaselineMsu: baseline ? baseline * 12 : null,
      vsBaselinePct: baseline ? (total / (baseline * 12)) * 100 : null,
    };
  });
  // Crescimento ano a ano só entre anos completos (12 meses), para não comparar
  // um ano cheio com um pedaço de ano.
  for (let i = 1; i < anos.length; i++) {
    const ant = anos[i - 1];
    anos[i].growthPct = ant.complete && anos[i].complete && ant.totalMsu > 0
      ? ((anos[i].totalMsu - ant.totalMsu) / ant.totalMsu) * 100
      : null;
  }

  res.json({
    client: { _id: client._id, name: client.name, monthlyBaselineMsu: baseline },
    history,
    forecast: result.points,
    method: result.method,
    requestedMethod: result.requestedMethod,
    model: result.model,
    notes: result.notes,
    years: anos,
    horizonMonths: months,
  });
}));

// ── Inventário de software (módulo Inventário) ──────────────────────────────
// O parse do relatório IBM acontece no navegador; aqui só persistimos o resultado.

/** Resumo de todos os inventários (para o seletor e a lista do módulo). */
router.get('/inventories', asyncHandler(async (req, res) => {
  const inventories = await Inventory.find()
    .select('client customerNumber clientName productCount reportUpdatedAt sourceFileName updatedAt')
    .populate('client', 'name')
    .lean();
  res.json(inventories);
}));

router.get('/clients/:id/inventory', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const inventory = await Inventory.findOne({ client: req.params.id }).lean();
  if (!inventory) return res.status(404).json({ error: 'Este cliente ainda não tem inventário carregado.' });
  res.json(inventory);
}));

/** Salva (ou substitui) o inventário do cliente. Um inventário atual por cliente. */
router.put('/clients/:id/inventory', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const client = await Client.findById(req.params.id);
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });

  const products = req.body.products;
  if (!Array.isArray(products)) {
    return res.status(400).json({ error: 'Envie "products" como lista (resultado do parse do inventário).' });
  }
  if (products.length === 0) {
    return res.status(422).json({ error: 'O inventário veio sem produtos — confira se o arquivo é o relatório IBM correto.' });
  }

  const warnings = [];
  const reportName = String(req.body.clientName || '').trim();
  if (reportName) {
    const a = normalizeName(client.name);
    const b = normalizeName(reportName);
    if (a && b && !b.includes(a) && !a.includes(b)) {
      warnings.push(`Atenção: o inventário é de "${reportName}", mas foi salvo no cliente "${client.name}".`);
    }
  }

  const doc = {
    client: client._id,
    customerNumber: req.body.customerNumber || null,
    clientName: reportName || null,
    products,
    productCount: products.length,
    sourceFileName: req.body.sourceFileName || null,
    reportUpdatedAt: req.body.reportUpdatedAt || null,
    warnings,
  };

  const existing = await Inventory.findOne({ client: client._id });
  const inventory = await Inventory.findOneAndUpdate(
    { client: client._id },
    { $set: doc },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  res.status(existing ? 200 : 201).json({ replaced: Boolean(existing), inventory, warnings });
}));

router.delete('/clients/:id/inventory', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const deleted = await Inventory.findOneAndDelete({ client: req.params.id });
  if (!deleted) return res.status(404).json({ error: 'Este cliente não tem inventário carregado.' });
  res.json({ ok: true });
}));

module.exports = router;
