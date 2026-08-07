'use strict';

const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const {
  Client, ScrtReport, Inventory, InfraSite, InfraMachine, InfraLpar, LsprModel,
  Contract, MigrationEvent, Region, MachineLifecycle,
} = require('./models');
// typeDaMaquina mora no regional porque foi lá que a regra nasceu (o parque por
// geração do painel). É a MESMA regra aqui: lsprModel primeiro, model depois.
const { typeDaMaquina } = require('./regional');
const { parseScrt, combineReports } = require('./scrtParser');
const { forecast } = require('./forecast');
const { serieUnificada, porAnoCalendario, porAnoContratual } = require('./forecastYears');
const { deckCapacityPlanning } = require('./deckCapacity');
const { isXlsx, readXlsxSheets, rowsToCsv } = require('./xlsx');
const { computeMlcView, addMonths } = require('./mlc');
const auth = require('./auth');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  // fileSize cobre a parte de arquivo; os demais limites contêm multipart abusivo
  // (muitos campos/partes materializados na memória). Excedente vira MulterError,
  // que o handler de erro do server.js já converte em 400.
  limits: { fileSize: 25 * 1024 * 1024, files: 1, parts: 20, fields: 10, fieldNameSize: 100, fieldSize: 1 * 1024 * 1024 },
  // Sem isto o multer decodifica o nome do arquivo como latin1 (default herdado
  // do busboy) e todo acento chega quebrado — os navegadores mandam UTF-8.
  // Opção disponível a partir do multer 2.1; até a 2.0 era preciso reinterpretar
  // o nome na mão (Buffer.from(nome, 'latin1').toString('utf8')).
  defParamCharset: 'utf-8',
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

/**
 * Id de uma referência que pode chegar como string OU como o objeto populado que
 * a própria API devolveu (o formulário reenvia o que recebeu). Sem isso, mandar
 * de volta um `site`/`contract` populado apagaria silenciosamente a referência.
 */
function refId(v) {
  if (!v) return null;
  const id = typeof v === 'object' ? (v._id || v.id) : v;
  return id && isValidId(String(id)) ? String(id) : null;
}

// Arquivos SCRT originais ficam no disco (podem passar do limite de 16 MB do
// documento Mongo — a planilha do Itaú tem 30 MB). Um por relatório, pelo _id.
// Diretório configurável (os testes apontam para um temp).
const SCRT_FILES_DIR = process.env.SCRT_FILES_DIR || path.join(__dirname, '..', 'data', 'scrt-files');
const scrtFilePath = (id) => path.join(SCRT_FILES_DIR, String(id));

function saveScrtFile(id, buffer, meta) {
  try {
    fs.mkdirSync(SCRT_FILES_DIR, { recursive: true });
    fs.writeFileSync(scrtFilePath(id), buffer);
    return { name: meta.name || null, size: buffer.length, contentType: meta.contentType || 'application/octet-stream' };
  } catch (err) {
    console.warn('[SCRT] não foi possível guardar o arquivo bruto:', err.message);
    return null;
  }
}

/** Remove do disco os arquivos brutos dos relatórios dados (ao excluir). */
function removeScrtFiles(ids) {
  for (const id of ids || []) {
    try { fs.rmSync(scrtFilePath(id), { force: true }); } catch (e) { /* ignora */ }
  }
}

// Arquivos dos contratos (PDF assinado, aditivos) — mesmo esquema do SCRT: bytes no
// disco nomeados pelo _id do subdocumento, só a metadata no Mongo.
const CONTRACT_FILES_DIR = process.env.CONTRACT_FILES_DIR || path.join(__dirname, '..', 'data', 'contract-files');
const contractFilePath = (id) => path.join(CONTRACT_FILES_DIR, String(id));

function saveContractFile(id, buffer) {
  fs.mkdirSync(CONTRACT_FILES_DIR, { recursive: true });
  fs.writeFileSync(contractFilePath(id), buffer);
}

function removeContractFiles(ids) {
  for (const id of ids || []) {
    try { fs.rmSync(contractFilePath(id), { force: true }); } catch (e) { /* ignora */ }
  }
}

/** Content-type a partir da extensão — PDF é o caso comum dos contratos. */
function contractContentType(name) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'txt') return 'text/plain; charset=utf-8';
  if (ext === 'doc' || ext === 'docx') return 'application/msword';
  if (ext === 'xls' || ext === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return 'application/octet-stream';
}

/** Cabeçalhos de download/inline com nome de arquivo seguro (mesmo padrão do SCRT). */
function sendStoredFile(res, filePath, { name, contentType, download }) {
  const asciiName = String(name || 'arquivo').replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
  res.setHeader('Content-Type', contentType || 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `${download ? 'attachment' : 'inline'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name || 'arquivo')}`
  );
  res.send(fs.readFileSync(filePath));
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

/** Serial normalizado de uma máquina (mesma identidade de machineSerials). */
function serialOf(m) {
  return String((m && (m.serialNumber || m.identifier)) || '').trim().toUpperCase();
}

// Catálogo padrão de tags: dev/test é o único ignorado.
const DEFAULT_TAG_DEFS = [
  { name: 'Produção', ignored: false },
  { name: 'DW', ignored: false },
  { name: 'Dev/Test', ignored: true },
];

/** Catálogo efetivo do cliente (usa o padrão quando ele não configurou nada). */
function tagDefsOf(client) {
  const defs = client && client.machineTagDefs;
  return defs && defs.length ? defs : DEFAULT_TAG_DEFS;
}

/**
 * Contexto de tags do cliente para o merge: mapa serial->tag e o conjunto de
 * nomes de tag ignorados. Máquina com tag ignorada não entra no faturável.
 */
function tagContextOf(client) {
  const ignoredNames = new Set(tagDefsOf(client).filter((t) => t.ignored).map((t) => t.name));
  const bySerial = new Map();
  for (const a of (client && client.machineTags) || []) {
    const s = String(a.serial || '').trim().toUpperCase();
    if (s) bySerial.set(s, a.tag);
  }
  return { bySerial, ignoredNames };
}

/** A máquina é ignorada? (tem tag e a tag está marcada como ignorada). */
function isMachineIgnored(machine, tagCtx) {
  if (!tagCtx) return false;
  const tag = tagCtx.bySerial.get(serialOf(machine));
  return Boolean(tag && tagCtx.ignoredNames.has(tag));
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
 * `tagCtx` (opcional) exclui do faturável as máquinas de tag ignorada.
 */
function mergeMonth(reports, tagCtx) {
  if (!reports.length) return null;
  const first = reports[0];
  const machines = [];
  const lpars = [];
  const containers = [];
  const warnings = [];
  const productsMsu = [];
  const productsUnit = [];
  const productsMax = [];
  const productFootnotes = [];

  for (const r of reports) {
    const origem = r.siteLabel || r.sourceFileName || '';
    for (const m of r.machines || []) {
      const tag = tagCtx ? (tagCtx.bySerial.get(serialOf(m)) || null) : null;
      const ignored = isMachineIgnored(m, tagCtx);
      machines.push({ ...m, source: origem, reportId: r._id, tag, ignored });
    }
    for (const l of r.lpars || []) lpars.push({ ...l, source: origem });
    for (const c of r.containers || []) containers.push({ ...c, source: origem });
    // Produtos (==E5 / ==P5). Cada origem traz os seus, e a origem fica na linha:
    // no BRB o mesmo produto aparece em SCN e SIG com números diferentes, e somar
    // os dois seria inventar um número que não está em SCRT nenhum.
    const pr = r.products || {};
    for (const x of pr.msuBased || []) productsMsu.push({ ...x, source: origem });
    for (const x of pr.unitBased || []) productsUnit.push({ ...x, source: origem });
    for (const x of pr.maxContributors || []) productsMax.push({ ...x, source: origem });
    for (const n of pr.footnotes || []) if (!productFootnotes.includes(n)) productFootnotes.push(n);
    for (const w of r.warnings || []) warnings.push(reports.length > 1 && origem ? `[${origem}] ${w}` : w);
  }

  // Consumo faturável: parte do total confiável do relatório (soma das origens)
  // e SUBTRAI as máquinas ignoradas. Assim não depende de toda máquina trazer
  // msuConsumed (o formato Sub-Capacity/MVM do BRB, p.ex., não traz).
  const totalMsuAllMachines = reports.reduce((a, r) => a + (r.totalMsuConsumed || 0), 0);
  let ignoredMsuConsumed = 0;
  for (const m of machines) {
    if (m.ignored) ignoredMsuConsumed += (m.msuConsumed || 0);
  }
  const totalMsuConsumed = totalMsuAllMachines - ignoredMsuConsumed;
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
    products: {
      msuBased: productsMsu,
      unitBased: productsUnit,
      maxContributors: productsMax,
      footnotes: productFootnotes,
    },
    totalMsuConsumed,
    totalMsuAllMachines,
    ignoredMsuConsumed,
    containersTotalMsu,
    warnings,
    conflicts,
    sources: reports.map((r) => ({
      reportId: r._id,
      siteLabel: r.siteLabel || null,
      sourceFileName: r.sourceFileName || null,
      rawFile: r.rawFile || null, // { name, size, contentType } se o arquivo foi guardado
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
function mergeByMonth(reports, tagCtx) {
  const byKey = new Map();
  for (const r of reports) {
    if (!byKey.has(r.periodKey)) byKey.set(r.periodKey, []);
    byKey.get(r.periodKey).push(r);
  }
  return [...byKey.keys()].sort().map((k) => mergeMonth(byKey.get(k), tagCtx));
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
  const user = req.user;
  const isAdmin = user && user.role === 'admin';
  // Usa o accessLevel compartilhado (src/auth.js) de propósito: esta rota já teve
  // uma cópia própria da regra e ficou para trás quando o perfil de gerente entrou
  // — o guard deixava passar, mas a listagem vinha vazia. Uma fonte só evita isso.
  const levelOf = (id) => auth.accessLevel(user, id);
  let clients = await Client.find().sort({ name: 1 }).lean();
  if (!isAdmin) clients = clients.filter((c) => levelOf(c._id)); // só os clientes do usuário
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
        accessLevel: levelOf(c._id), // 'admin' | 'edit' | 'view'
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
  // Região do cliente (no máximo uma — ver regionSchema). Vazio desagrupa.
  if (req.body.region !== undefined) {
    const r = req.body.region;
    if (!r) update.region = null;
    else if (!isValidId(r)) return res.status(400).json({ error: 'Região inválida.' });
    else {
      if (!(await Region.exists({ _id: r }))) return res.status(422).json({ error: 'Região inexistente.' });
      update.region = r;
    }
  }
  if (req.body.monthlyBaselineMsu !== undefined) {
    const baseline = parseBaseline(req.body.monthlyBaselineMsu);
    if (Number.isNaN(baseline)) return res.status(400).json({ error: BASELINE_ERROR });
    update.monthlyBaselineMsu = baseline;
  }
  if (req.body.contractYearStart !== undefined) {
    const raw = req.body.contractYearStart;
    if (raw === null || raw === '') {
      update.contractYearStart = null;
    } else if (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(raw).trim())) {
      update.contractYearStart = String(raw).trim();
    } else {
      return res.status(400).json({ error: 'Início do ano contratual deve ser AAAA-MM (ex.: 2024-06).' });
    }
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
  const ids = await ScrtReport.find({ client: client._id }).select('_id').lean();
  const { deletedCount } = await ScrtReport.deleteMany({ client: client._id });
  removeScrtFiles(ids.map((r) => r._id));
  const inv = await Inventory.deleteOne({ client: client._id });
  res.json({ ok: true, deletedReports: deletedCount, deletedInventories: inv.deletedCount });
}));

/**
 * Tags de máquina do cliente: catálogo (defs) e/ou atribuições por serial.
 * Body: { defs?: [{name, ignored}], assignments?: [{serial, tag}] }.
 * Máquina de tag ignorada tem o consumo excluído do faturável (em tudo).
 */
router.put('/clients/:id/machine-tags', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const update = {};

  if (req.body.defs !== undefined) {
    if (!Array.isArray(req.body.defs)) return res.status(400).json({ error: 'Envie "defs" como lista.' });
    const seen = new Set();
    const defs = [];
    for (const d of req.body.defs) {
      const name = String((d && d.name) || '').trim();
      if (!name) return res.status(400).json({ error: 'Toda tag precisa de um nome.' });
      const key = name.toLowerCase();
      if (seen.has(key)) return res.status(422).json({ error: `Tag repetida: "${name}".` });
      seen.add(key);
      defs.push({ name, ignored: Boolean(d && d.ignored) });
    }
    if (!defs.length) return res.status(422).json({ error: 'Deixe pelo menos uma tag no catálogo.' });
    update.machineTagDefs = defs;
  }

  if (req.body.assignments !== undefined) {
    if (!Array.isArray(req.body.assignments)) {
      return res.status(400).json({ error: 'Envie "assignments" como lista.' });
    }
    // O catálogo válido: o que veio no corpo, ou o já salvo, ou o padrão.
    let catalogo = update.machineTagDefs;
    if (!catalogo) {
      const atual = await Client.findById(req.params.id).select('machineTagDefs').lean();
      catalogo = tagDefsOf(atual);
    }
    const validas = new Set(catalogo.map((t) => t.name));
    const bySerial = new Map(); // um serial -> uma tag (o último vence)
    for (const a of req.body.assignments) {
      const serial = String((a && a.serial) || '').trim().toUpperCase();
      const tag = String((a && a.tag) || '').trim();
      if (!serial) return res.status(400).json({ error: 'Cada atribuição precisa do "serial".' });
      if (!tag) { bySerial.delete(serial); continue; } // tag vazia = sem tag
      if (!validas.has(tag)) return res.status(422).json({ error: `Tag "${tag}" não existe no catálogo.` });
      bySerial.set(serial, tag);
    }
    update.machineTags = [...bySerial.entries()].map(([serial, tag]) => ({ serial, tag }));
  }

  // Mudou o catálogo sem reenviar as atribuições: poda as que ficaram órfãs.
  if (update.machineTagDefs && update.machineTags === undefined) {
    const validas = new Set(update.machineTagDefs.map((t) => t.name));
    const atual = await Client.findById(req.params.id).select('machineTags').lean();
    update.machineTags = ((atual && atual.machineTags) || []).filter((a) => validas.has(a.tag));
  }

  const client = await Client.findByIdAndUpdate(req.params.id, { $set: update }, { new: true }).lean();
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });
  res.json({ machineTags: { defs: tagDefsOf(client), assignments: client.machineTags || [] } });
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
  const fileName = req.file.originalname || null;

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
    products: parsed.products || { msuBased: [], unitBased: [], footnotes: [], maxContributors: [] },
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

  // Guarda o arquivo bruto em disco (para ver/baixar depois) e registra no doc.
  const contentType = isXlsx(req.file.buffer)
    ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    : 'text/csv; charset=utf-8';
  const rawFile = saveScrtFile(report._id, req.file.buffer, { name: fileName, contentType });
  if (rawFile) {
    report.rawFile = rawFile;
    await ScrtReport.updateOne({ _id: report._id }, { $set: { rawFile } });
  }

  // Total do mês já com este arquivo incluído.
  const doMes = await ScrtReport.find({ client: client._id, periodKey: parsed.periodKey }).lean();
  const merged = mergeMonth(doMes, tagContextOf(client));

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

/** Serve o arquivo SCRT original (inline para pré-visualizar; ?download=1 baixa). */
router.get('/reports/:id/file', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const report = await ScrtReport.findById(req.params.id).select('rawFile sourceFileName').lean();
  if (!report) return res.status(404).json({ error: 'Relatório não encontrado.' });
  if (!report.rawFile || !fs.existsSync(scrtFilePath(report._id))) {
    return res.status(404).json({
      error: 'O arquivo original deste SCRT não foi guardado (enviado antes desta versão). Reenvie o SCRT para ver/baixar.',
    });
  }
  const name = report.rawFile.name || report.sourceFileName || `scrt-${report._id}.csv`;
  const asciiName = name.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
  const disposition = req.query.download ? 'attachment' : 'inline';
  res.setHeader('Content-Type', report.rawFile.contentType || 'application/octet-stream');
  res.setHeader('Content-Disposition',
    `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(fs.readFileSync(scrtFilePath(report._id)));
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
  const client = await Client.findById(req.params.id).lean();
  res.json(mergeMonth(reports, tagContextOf(client)));
}));

/** Exclui o mês inteiro (todas as origens/SCRTs daquele cliente e período). */
router.delete('/clients/:id/months/:periodKey', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  if (!/^\d{4}-\d{2}$/.test(req.params.periodKey)) {
    return res.status(400).json({ error: 'Mês inválido (use AAAA-MM).' });
  }
  const doMes = await ScrtReport.find({ client: req.params.id, periodKey: req.params.periodKey }).select('_id').lean();
  const { deletedCount } = await ScrtReport.deleteMany({
    client: req.params.id,
    periodKey: req.params.periodKey,
  });
  if (!deletedCount) return res.status(404).json({ error: 'Mês não encontrado para este cliente.' });
  removeScrtFiles(doMes.map((r) => r._id));
  res.json({ ok: true, deletedReports: deletedCount });
}));

router.delete('/reports/:id', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const report = await ScrtReport.findByIdAndDelete(req.params.id);
  if (!report) return res.status(404).json({ error: 'Relatório não encontrado.' });
  removeScrtFiles([report._id]);
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
  // O consumo já sai faturável (exclui máquinas de tag ignorada).
  const reports = mergeByMonth(raw, tagContextOf(client));
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
      totalMsuAllMachines: r.totalMsuAllMachines,
      ignoredMsuConsumed: r.ignoredMsuConsumed,
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
  // Tags de máquina: catálogo efetivo (com padrão) e atribuições por serial.
  const machineTags = {
    defs: tagDefsOf(client),
    assignments: client.machineTags || [],
  };
  res.json({ client, series, latest, machineTags });
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

  // Compara MESES fundidos (um mês pode vir de vários SCRTs); já faturável.
  const reports = mergeByMonth(
    await ScrtReport.find({ client: client._id }).sort({ periodKey: 1, createdAt: 1 }).lean(),
    tagContextOf(client)
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

  // Faturável: fora as máquinas ignoradas (e as LPARs delas), para a soma das
  // variações bater com o totalDelta.
  const naoIgnoradas = (r) => (r.machines || []).filter((m) => !m.ignored);
  const idsIgnorados = (r) => new Set((r.machines || []).filter((m) => m.ignored).map((m) => m.identifier));
  const machines = diffRows(
    naoIgnoradas(base),
    naoIgnoradas(target),
    (m) => m.identifier,
    (m) => ({ identifier: m.identifier, typeModel: m.typeModel || null, serialNumber: m.serialNumber || null })
  );

  const ignBase = idsIgnorados(base);
  const ignTarget = idsIgnorados(target);
  const lparsOf = (r, ign) => (r.lpars || []).filter((l) => l.msuConsumed != null && !ign.has(l.machine));
  const lpars = diffRows(
    lparsOf(base, ignBase),
    lparsOf(target, ignTarget),
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
    lparDetailAvailable: lparsOf(base, ignBase).length > 0 && lparsOf(target, ignTarget).length > 0,
    lpars,
    availableMonths: reports.map(monthRef),
  });
}));

/** Horizonte pedido na query (?years=1..5 ou ?months=1..60), já validado. */
function horizonteDaQuery(query) {
  const years = query.years !== undefined ? Number(query.years) : null;
  const monthsRaw = query.months !== undefined ? Number(query.months) : null;
  const months = monthsRaw !== null ? monthsRaw : (years !== null ? years * 12 : 12);
  if (!Number.isFinite(months) || months < 1 || months > 60) {
    const err = new Error('Horizonte inválido: informe de 1 a 5 anos (até 60 meses).');
    err.status = 400;
    throw err;
  }
  return Math.round(months);
}

/*
 * Cliente sem `contractPeriods` mas com o mês-âncora do ano contratual (cadastro
 * antigo, ou definido pelo botão "Ano contratual" da tela) vale como UM contrato
 * em aberto. É a mesma leitura que o dashboard faz — sem isto o fechamento por
 * ano contratual apareceria vazio para quem já tem o ano contratual definido.
 */
function periodosContratuais(client) {
  if (client.contractPeriods && client.contractPeriods.length) return client.contractPeriods;
  const inicio = client.contractYearStart || (client.mlcContract && client.mlcContract.startPeriodKey);
  if (!inicio || !/^\d{4}-\d{2}$/.test(String(inicio))) return [];
  return [{
    _id: null,
    name: `Contrato ${String(inicio).slice(0, 4)}`,
    startPeriodKey: String(inicio),
    endPeriodKey: null,
    years: [],
  }];
}

/**
 * Payload do capacity planning. A tela e o PowerPoint consomem EXATAMENTE isto —
 * é o que garante que o slide levado ao cliente não discorde do que está no
 * navegador.
 */
async function montarForecast(client, { method, months }) {
  const monthsData = mergeByMonth(
    await ScrtReport.find({ client: client._id }).sort({ periodKey: 1, createdAt: 1 }).lean(),
    tagContextOf(client)
  );
  const history = monthsData.map((m) => ({
    periodKey: m.periodKey,
    periodLabel: m.periodLabel,
    totalMsuConsumed: m.totalMsuConsumed,
    year: Number(m.periodKey.slice(0, 4)),
  }));

  const result = forecast(history, { method, months });

  // Duas consolidações da MESMA série: ano-calendário (orçamento do cliente) e
  // ano contratual (janela em que o baseline é apurado). Ver src/forecastYears.js.
  const baseline = client.monthlyBaselineMsu || null;
  const serie = serieUnificada(history, result.points);
  const contratuais = porAnoContratual(serie, periodosContratuais(client), baseline);

  return {
    client: { _id: client._id, name: client.name, monthlyBaselineMsu: baseline },
    history,
    forecast: result.points,
    method: result.method,
    requestedMethod: result.requestedMethod,
    model: result.model,
    notes: result.notes,
    years: porAnoCalendario(serie, baseline),
    contractYears: contratuais.rows,
    hasContractPeriods: contratuais.hasContracts,
    horizonMonths: months,
  };
}

/**
 * Capacity planning: projeta o consumo dos próximos anos.
 * ?method=linear|sarima  &years=1..5  (ou &months=1..60)
 */
router.get('/clients/:id/forecast', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const client = await Client.findById(req.params.id).lean();
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });

  const method = req.query.method === 'sarima' ? 'sarima' : 'linear';
  let months;
  try { months = horizonteDaQuery(req.query); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  try {
    res.json(await montarForecast(client, { method, months }));
  } catch (err) {
    if (err.status === 422) return res.status(422).json({ error: err.message });
    throw err;
  }
}));

/**
 * O mesmo capacity planning em .pptx, para levar à reunião com o cliente.
 *
 * É GET de propósito: o guard de acesso trata qualquer verbo que não seja de
 * leitura como escrita e exigiria permissão de EDIÇÃO — gerar apresentação é
 * leitura. Por isso também o gráfico é desenhado no servidor em vez de vir como
 * imagem do canvas do navegador (que obrigaria a um POST).
 */
router.get('/clients/:id/forecast.pptx', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const client = await Client.findById(req.params.id).lean();
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });

  const method = req.query.method === 'sarima' ? 'sarima' : 'linear';
  let months;
  try { months = horizonteDaQuery(req.query); }
  catch (err) { return res.status(400).json({ error: err.message }); }

  let payload;
  try {
    payload = await montarForecast(client, { method, months });
  } catch (err) {
    if (err.status === 422) return res.status(422).json({ error: err.message });
    throw err;
  }

  const { buffer, fileName } = deckCapacityPlanning(payload, {
    autor: (req.user && req.user.name) || 'IBM Z Control Desk',
  });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  res.setHeader('Content-Disposition',
    `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  res.send(buffer);
}));

// ── Inventário de software (módulo Inventário) ──────────────────────────────
// O parse do relatório IBM acontece no navegador; aqui só persistimos o resultado.

/** Resumo dos inventários (só dos clientes que o usuário pode acessar). */
router.get('/inventories', asyncHandler(async (req, res) => {
  let inventories = await Inventory.find()
    .select('client customerNumber clientName productCount reportUpdatedAt sourceFileName updatedAt')
    .populate('client', 'name')
    .lean();
  const user = req.user;
  if (!user || user.role !== 'admin') {
    const allowed = new Set(((user && user.access) || []).map((a) => String(a.client)));
    inventories = inventories.filter((i) => i.client && allowed.has(String(i.client._id || i.client)));
  }
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

/**
 * Marcações manuais por registro (hoje "Demo/PoC"). Como os ajustes de par, fica
 * fora do PUT do inventário — assim sobrevive à recarga do relatório e não obriga
 * a reenviar milhares de produtos a cada clique.
 */
router.put('/clients/:id/inventory/flags', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const recebidos = req.body.productFlags;
  if (!Array.isArray(recebidos)) {
    return res.status(400).json({ error: 'Envie "productFlags" como lista.' });
  }
  const porChave = new Map(); // um registro por PID+serial; o último vale
  for (const f of recebidos) {
    const productId = String((f && f.productId) || '').trim();
    const swSerial = String((f && f.swSerial) || '').trim();
    if (!productId || !swSerial) {
      return res.status(400).json({ error: 'Cada marcação precisa de PID e serial.' });
    }
    const flag = (f && f.flag) === 'demo' ? 'demo' : 'demo';
    porChave.set(swKey(productId, swSerial), {
      productId, swSerial, flag, note: String((f && f.note) || '').trim(), at: new Date(),
    });
  }
  const productFlags = [...porChave.values()];
  const inv = await Inventory.findOneAndUpdate(
    { client: req.params.id }, { $set: { productFlags } }, { new: true }
  ).select('productFlags').lean();
  if (!inv) return res.status(404).json({ error: 'Este cliente ainda não tem inventário carregado.' });
  res.json({ productFlags: inv.productFlags });
}));

/**
 * Ajustes manuais do par Licença ↔ S&S. O par é registro a registro, e o
 * registro é identificado por PID + SW Serial (o serial se repete entre PIDs).
 * Um ajuste por registro de S&S: licença preenchida força o par; nula desfaz
 * o par automático. Fica separado do PUT do inventário para não reenviar
 * milhares de produtos a cada clique.
 */
router.put('/clients/:id/inventory/pairs', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const recebidos = req.body.pairOverrides;
  if (!Array.isArray(recebidos)) {
    return res.status(400).json({ error: 'Envie "pairOverrides" como lista.' });
  }

  const texto = (v) => (v == null ? '' : String(v).trim());
  const porSs = new Map(); // um ajuste por registro de S&S; o último vale
  const licUsados = new Set(); // 1:1 — cada licença aceita um S&S só
  for (const o of recebidos) {
    const ssPid = texto(o && o.ssPid);
    const ssSerial = texto(o && o.ssSerial);
    if (!ssPid || !ssSerial) {
      return res.status(400).json({ error: 'Cada ajuste precisa de "ssPid" e "ssSerial".' });
    }
    const licPid = texto(o && o.licPid);
    const licSerial = texto(o && o.licSerial);
    if (Boolean(licPid) !== Boolean(licSerial)) {
      return res.status(400).json({ error: 'Informe "licPid" e "licSerial" juntos, ou nenhum dos dois.' });
    }
    if (licPid) {
      const chaveLic = `${licPid}|${licSerial}`;
      if (licUsados.has(chaveLic)) {
        return res.status(422).json({
          error: `A licença ${licPid} (serial ${licSerial}) foi indicada para mais de um S&S — o par é 1 para 1.`,
        });
      }
      licUsados.add(chaveLic);
    }
    porSs.set(`${ssPid}|${ssSerial}`, {
      ssPid,
      ssSerial,
      licPid: licPid || null,
      licSerial: licSerial || null,
    });
  }

  const inventory = await Inventory.findOneAndUpdate(
    { client: req.params.id },
    { $set: { pairOverrides: [...porSs.values()] } },
    { new: true }
  ).lean();
  if (!inventory) return res.status(404).json({ error: 'Este cliente ainda não tem inventário carregado.' });
  res.json({ pairOverrides: inventory.pairOverrides || [] });
}));

router.delete('/clients/:id/inventory', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const deleted = await Inventory.findOneAndDelete({ client: req.params.id });
  if (!deleted) return res.status(404).json({ error: 'Este cliente não tem inventário carregado.' });
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 *  MLC (Monthly License Charge)
 *  Contrato por cliente (parâmetros por ano) + consumo mensal vindo do SCRT.
 * ------------------------------------------------------------------ */

const PERIOD_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// Consumo mensal (faturável) do cliente pelo SCRT: periodKey -> MSU.
// Recebe o cliente para respeitar as tags ignoradas (dev/test).
async function scrtConsumoByPeriod(client) {
  const raw = await ScrtReport.find({ client: client._id }).sort({ periodKey: 1, createdAt: 1 }).lean();
  const byPeriod = {};
  for (const r of mergeByMonth(raw, tagContextOf(client))) byPeriod[r.periodKey] = r.totalMsuConsumed;
  return byPeriod;
}

/** Valida e normaliza o corpo do contrato vindo do PUT. */
function sanitizeMlcContract(body) {
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const start = String((body && body.startPeriodKey) || '').trim();
  if (!PERIOD_KEY_RE.test(start)) {
    return { error: 'Informe o mês inicial do contrato ("startPeriodKey") no formato AAAA-MM.' };
  }
  if (!Array.isArray(body.years) || body.years.length === 0) {
    return { error: 'Informe pelo menos um ano de contrato em "years".' };
  }
  const listaEncargos = (arr) => (Array.isArray(arr) ? arr : [])
    .map((e) => ({ nome: String((e && e.nome) || '').trim(), valorMensal: num(e && e.valorMensal) }))
    .filter((e) => e.nome);

  let erro = null;
  const years = body.years.map((y, i) => {
    // Trechos de preço dentro do ano. O mês tem de cair DENTRO do ano (a decisão
    // é que vigência não atravessa a virada), e dois trechos não podem começar no
    // mesmo mês — senão qual dos dois vale seria uma escolha invisível.
    const primeiro = addMonths(start, i * 12);
    const ultimo = addMonths(start, i * 12 + 11);
    const vistos = new Set();
    const vigencias = (Array.isArray(y && y.vigencias) ? y.vigencias : [])
      .map((v) => {
        const from = String((v && v.fromPeriodKey) || '').trim();
        if (!PERIOD_KEY_RE.test(from)) { erro = erro || `Ano ${i + 1}: informe o mês inicial da vigência no formato AAAA-MM.`; return null; }
        if (from < primeiro || from > ultimo) {
          erro = erro || `Ano ${i + 1}: a vigência de ${from} está fora do ano (${primeiro} a ${ultimo}).`;
          return null;
        }
        // Começar no primeiro mês do ano tornaria os valores do ano inalcançáveis:
        // é edição do próprio ano, não um trecho novo.
        if (from === primeiro) { erro = erro || `Ano ${i + 1}: a vigência não pode começar no primeiro mês do ano — edite os valores do ano.`; return null; }
        if (vistos.has(from)) { erro = erro || `Ano ${i + 1}: há duas vigências começando em ${from}.`; return null; }
        vistos.add(from);
        return {
          fromPeriodKey: from,
          valorPorMsu: num(v.valorPorMsu),
          encargoCrescimentoPorMsu: num(v.encargoCrescimentoPorMsu),
          cbaPct: num(v.cbaPct),
          encargos: listaEncargos(v.encargos),
          notas: String((v && v.notas) || '').trim(),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.fromPeriodKey.localeCompare(b.fromPeriodKey));

    return {
      label: String((y && y.label) || '').trim() || `Ano ${i + 1}`,
      baselineAnnualMsu: num(y && y.baselineAnnualMsu),
      valorPorMsu: num(y && y.valorPorMsu),
      encargoCrescimentoPorMsu: num(y && y.encargoCrescimentoPorMsu),
      cbaPct: num(y && y.cbaPct),
      encargos: listaEncargos(y && y.encargos),
      vigencias,
    };
  });
  if (erro) return { error: erro };
  return { contract: { startPeriodKey: start, years } };
}

/** Devolve o contrato MLC do cliente e a visão calculada mês a mês. */
router.get('/clients/:id/mlc', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const client = await Client.findById(req.params.id).lean();
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });

  // O início do ano contratual é único por cliente: contractYearStart manda,
  // e o startPeriodKey do MLC serve de base quando aquele não está definido.
  const stored = client.mlcContract || null;
  const effStart = client.contractYearStart || (stored && stored.startPeriodKey) || null;
  const contract = stored ? { ...stored, startPeriodKey: effStart } : null;
  const consumo = await scrtConsumoByPeriod(client);
  const view = (contract && effStart) ? computeMlcView(contract, consumo) : null;
  const scrtMonths = Object.keys(consumo).sort();

  res.json({
    client: { _id: client._id, name: client.name },
    contract,
    view,
    scrt: {
      monthCount: scrtMonths.length,
      firstPeriodKey: scrtMonths[0] || null,
      lastPeriodKey: scrtMonths[scrtMonths.length - 1] || null,
    },
  });
}));

/** Salva (ou substitui) o contrato MLC do cliente. */
router.put('/clients/:id/mlc', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const { error, contract } = sanitizeMlcContract(req.body || {});
  if (error) return res.status(400).json({ error });

  // Unifica o início do ano contratual com o do dashboard (contractYearStart).
  const client = await Client.findByIdAndUpdate(
    req.params.id,
    { $set: { mlcContract: contract, contractYearStart: contract.startPeriodKey } },
    { new: true }
  ).lean();
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });

  const consumo = await scrtConsumoByPeriod(client);
  res.json({ contract: client.mlcContract, view: computeMlcView(client.mlcContract, consumo) });
}));

/** Remove o contrato MLC do cliente. */
router.delete('/clients/:id/mlc', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const client = await Client.findByIdAndUpdate(
    req.params.id,
    { $set: { mlcContract: null } },
    { new: true }
  ).lean();
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ *
 *  Infraestrutura (parque físico): Sites, Máquinas, LPARs — por cliente.
 *  Sem foto e sem catálogo. Máquina cruza com o SCRT pelo serial.
 * ------------------------------------------------------------------ */

const INFRA_ROLES = ['prod', 'dr', 'ha', 'dev', 'test', 'colo'];
const INFRA_OS = ['linux', 'zos', 'zvm', 'kvm', 'other'];
const INFRA_NIC = ['OSA', 'RoCE', 'NetworkExpress', 'HiperSockets', 'Other'];
const MACHINE_STATUS = ['ativa', 'dormente', 'substituida', 'desativada'];
const numOf = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** Mapa serial(maiúsculo) -> consumo/tag da máquina no ÚLTIMO mês de SCRT. */
async function scrtBySerialLatest(client) {
  const map = new Map();
  if (!client) return map;
  const raw = await ScrtReport.find({ client: client._id }).sort({ periodKey: 1, createdAt: 1 }).lean();
  if (!raw.length) return map;
  const merged = mergeByMonth(raw, tagContextOf(client));
  const latest = merged[merged.length - 1];
  for (const m of (latest.machines || [])) {
    const s = serialOf(m);
    if (s) map.set(s, { msuConsumed: m.msuConsumed, tag: m.tag || null, ignored: !!m.ignored, periodLabel: latest.periodLabel });
  }
  return map;
}

/** Máquinas do último mês de SCRT (deduplicadas por serial, com type-model). */
async function scrtLatestMachines(client) {
  const out = [];
  if (!client) return out;
  const raw = await ScrtReport.find({ client: client._id }).sort({ periodKey: 1, createdAt: 1 }).lean();
  if (!raw.length) return out;
  const merged = mergeByMonth(raw, tagContextOf(client));
  const latest = merged[merged.length - 1];
  const seen = new Set();
  for (const m of (latest.machines || [])) {
    const s = serialOf(m);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push({
      serial: s,
      typeModel: String(m.typeModel || '').trim(),
      ratedCapacityMsus: m.ratedCapacityMsus || null,
      msuConsumed: m.msuConsumed || null,
      identifier: m.identifier || '',
      periodLabel: latest.periodLabel,
    });
  }
  return out;
}

/** Anexa a linha LSPR (m.lspr) a cada máquina de infra que tenha lsprModel. */
async function attachLspr(machines) {
  const ids = [...new Set(machines.map((m) => String(m.lsprModel || '').trim()).filter(Boolean))];
  const rows = ids.length ? await LsprModel.find({ model: { $in: ids } }).lean() : [];
  const byModel = new Map(rows.map((r) => [r.model, r]));
  for (const m of machines) m.lspr = byModel.get(String(m.lsprModel || '').trim()) || null;
  return machines;
}

/**
 * Anexa a GERAÇÃO e o CICLO DE VIDA IBM de cada máquina.
 *
 *   m.generation  "z17", "z16"…  — do LSPR quando há vínculo; sem vínculo, do
 *                 ciclo de vida pelo type. Sem isso, metade das máquinas
 *                 mostraria "3931" cru, que não diz nada a quem lê.
 *   m.lifecycle   { ga, hwWdfm, coslEos, foraDeSuporte }
 *
 * `foraDeSuporte` é calculado AQUI, com a data do servidor, e não no navegador:
 * a mesma tela aberta em máquinas com relógio diferente não pode discordar sobre
 * uma máquina estar ou não fora de suporte.
 */
async function attachLifecycle(machines, { hoje = new Date().toISOString().slice(0, 10) } = {}) {
  const tipos = [...new Set(machines.map(typeDaMaquina).filter(Boolean))];
  const rows = tipos.length
    ? await MachineLifecycle.find({ type: { $in: tipos } }).select('type family ga hwWdfm coslEos').lean()
    : [];
  // Um type pode ter mais de uma linha (2064 = z900 G1 e G2, 3932 = z16 AGZ/A02);
  // para o rótulo e as datas basta a primeira, como no painel gerencial.
  const porType = new Map();
  for (const r of rows) if (!porType.has(String(r.type))) porType.set(String(r.type), r);

  for (const m of machines) {
    const lc = porType.get(typeDaMaquina(m)) || null;
    m.generation = (m.lspr && m.lspr.generation) || (lc && lc.family) || null;
    m.lifecycle = lc
      ? {
        ga: lc.ga || null,
        hwWdfm: lc.hwWdfm || null,
        coslEos: lc.coslEos || null,
        foraDeSuporte: !!(lc.coslEos && lc.coslEos < hoje),
      }
      : null;
  }
  return machines;
}

/**
 * Anexa o contrato de cada máquina em `m.contractRef`.
 * Repare que NÃO usamos .populate('contract'): o formulário de máquina devolve no
 * PUT o objeto que recebeu, e um `contract` populado viraria lixo no banco. O id
 * cru fica em `m.contract`, o objeto em `m.contractRef`.
 */
async function attachContracts(machines) {
  const ids = [...new Set(machines.map((m) => m.contract && String(m.contract)).filter(Boolean))];
  const rows = ids.length
    ? await Contract.find({ _id: { $in: ids } }).select('number name type status startDate endDate client').lean()
    : [];
  const byId = new Map(rows.map((r) => [String(r._id), r]));
  for (const m of machines) {
    const c = byId.get(String(m.contract || ''));
    // Defesa em profundidade: só anexa se o contrato é do MESMO cliente da máquina,
    // para uma referência cruzada indevida não vazar metadados de contrato alheio.
    m.contractRef = c && String(c.client) === String(m.client) ? c : null;
  }
  return machines;
}

/** Anexa um resumo dos eventos de MO/MES de cada máquina (m.migrations). */
async function attachMigrations(machines) {
  const ids = machines.map((m) => m._id);
  const evs = ids.length
    ? await MigrationEvent.find({ $or: [{ fromMachine: { $in: ids } }, { toMachine: { $in: ids } }] })
      .select('fromMachine toMachine kind status').lean()
    : [];
  const acc = new Map();
  for (const e of evs) {
    for (const ref of [e.fromMachine, e.toMachine]) {
      if (!ref) continue;
      const k = String(ref);
      if (!acc.has(k)) acc.set(k, { total: 0, pendentes: 0, ultimoKind: null });
      const a = acc.get(k);
      a.total++;
      if (e.status === 'proposta' || e.status === 'contratado') a.pendentes++;
      a.ultimoKind = e.kind;
    }
  }
  for (const m of machines) m.migrations = acc.get(String(m._id)) || { total: 0, pendentes: 0, ultimoKind: null };
  return machines;
}

// Atualização parcial: só grava os campos presentes no corpo.
function siteUpdate(body) {
  const set = {};
  if (body.name !== undefined) set.name = String(body.name || '').trim();
  if (body.location !== undefined) set.location = String(body.location || '').trim();
  if (body.role !== undefined) set.role = INFRA_ROLES.includes(body.role) ? body.role : 'prod';
  if (body.notes !== undefined) set.notes = String(body.notes || '');
  return set;
}

function machineUpdate(body) {
  const set = {};
  if (body.site !== undefined) set.site = refId(body.site);
  if (body.model !== undefined) set.model = String(body.model || '').trim();
  if (body.variant !== undefined) set.variant = String(body.variant || '').trim();
  if (body.featureModel !== undefined) set.featureModel = String(body.featureModel || '').trim();
  if (body.lsprModel !== undefined) set.lsprModel = String(body.lsprModel || '').trim();
  if (body.serial !== undefined) set.serial = String(body.serial || '').trim().toUpperCase();
  if (body.year !== undefined) set.year = body.year === '' || body.year === null ? null : numOf(body.year);
  // iflsSpare/icfs/memoryAddTB ficam DE FORA: saíram do formulário e não podem
  // ser alterados por requisição direta — o valor de produção é preservado.
  ['cps', 'ziips', 'iflsActive', 'memoryTB', 'vfmTB'].forEach((k) => { if (body[k] !== undefined) set[k] = numOf(body[k]); });
  if (body.status !== undefined && MACHINE_STATUS.includes(body.status)) set.status = body.status;
  // Compatibilidade: clientes antigos ainda mandam o booleano `dormant`.
  else if (body.dormant !== undefined) set.status = body.dormant ? 'dormente' : 'ativa';
  if (body.contract !== undefined) set.contract = refId(body.contract);
  if (body.notes !== undefined) set.notes = String(body.notes || '');
  ['configTxtName', 'configTxtContent', 'configCfrName', 'configCfrContent'].forEach((k) => {
    if (body[k] !== undefined) set[k] = String(body[k] || '');
  });
  return set;
}

function lparUpdate(body) {
  const set = {};
  if (body.machine !== undefined && isValidId(body.machine)) set.machine = body.machine;
  if (body.name !== undefined) set.name = String(body.name || '').trim();
  if (body.os !== undefined) set.os = INFRA_OS.includes(body.os) ? body.os : 'linux';
  if (body.osDistro !== undefined) set.osDistro = String(body.osDistro || '').trim();
  ['ifls', 'cps', 'memoryGB'].forEach((k) => { if (body[k] !== undefined) set[k] = numOf(body[k]); });
  if (body.description !== undefined) set.description = String(body.description || '');
  ['devices', 'wwpns', 'ips'].forEach((k) => {
    if (body[k] !== undefined) set[k] = (Array.isArray(body[k]) ? body[k] : []).map((x) => String(x).trim()).filter(Boolean);
  });
  if (body.networkCards !== undefined) {
    set.networkCards = (Array.isArray(body.networkCards) ? body.networkCards : [])
      .map((c) => ({ type: INFRA_NIC.includes(c && c.type) ? c.type : 'OSA', label: String((c && c.label) || '').trim() }))
      .filter((c) => c.label);
  }
  if (body.notes !== undefined) set.notes = String(body.notes || '');
  return set;
}

/* ══════════════════════════════════════════════════════════════════════════
   CONTRATOS
   Tudo aninhado em /clients/:id/... para herdar o controle de acesso por
   cliente (canView em GET, canEdit em escrita) sem nenhum branch manual.
   ══════════════════════════════════════════════════════════════════════════ */

const CONTRACT_TYPES = ['hardware', 'software', 'servicos', 'misto'];
const CONTRACT_STATUS = ['rascunho', 'vigente', 'encerrado', 'cancelado'];
const CONTRACT_FILE_KINDS = ['contrato', 'aditivo', 'proposta', 'anexo'];
const CURRENCIES = ['BRL', 'USD', 'EUR'];

const dateOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const moneyOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** Chave de identidade de um registro de software: PID + serial. */
const swKey = (productId, swSerial) =>
  `${String(productId || '').trim().toUpperCase()}|${String(swSerial || '').trim().toUpperCase()}`;

/** Atualização parcial do contrato: só grava os campos presentes no corpo. */
function contractUpdate(body) {
  const set = {};
  if (body.number !== undefined) set.number = String(body.number || '').trim();
  if (body.name !== undefined) set.name = String(body.name || '').trim();
  if (body.type !== undefined) set.type = CONTRACT_TYPES.includes(body.type) ? body.type : 'misto';
  if (body.status !== undefined) set.status = CONTRACT_STATUS.includes(body.status) ? body.status : 'vigente';
  if (body.vendor !== undefined) set.vendor = String(body.vendor || '').trim();
  if (body.poNumber !== undefined) set.poNumber = String(body.poNumber || '').trim();
  if (body.owner !== undefined) set.owner = String(body.owner || '').trim();
  if (body.notes !== undefined) set.notes = String(body.notes || '');
  if (body.currency !== undefined) set.currency = CURRENCIES.includes(body.currency) ? body.currency : 'BRL';
  ['signedAt', 'startDate', 'endDate'].forEach((k) => { if (body[k] !== undefined) set[k] = dateOrNull(body[k]); });
  ['totalValue', 'monthlyValue'].forEach((k) => { if (body[k] !== undefined) set[k] = moneyOrNull(body[k]); });
  return set;
}

/** Carrega o contrato garantindo que ele é do cliente da rota. */
async function findContract(clientId, contractId) {
  if (!isValidId(contractId)) return null;
  return Contract.findOne({ _id: contractId, client: clientId });
}

// Lista: sem o array de software (pode ser grande), com os contadores que a tela usa.
router.get('/clients/:id/contracts', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const filter = { client: req.params.id };
  if (req.query.status && CONTRACT_STATUS.includes(req.query.status)) filter.status = req.query.status;
  if (req.query.type && CONTRACT_TYPES.includes(req.query.type)) filter.type = req.query.type;
  const q = String(req.query.q || '').trim();
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ number: rx }, { name: rx }, { vendor: rx }, { poNumber: rx }];
  }
  const contracts = await Contract.find(filter).sort({ createdAt: -1 }).lean();
  const ids = contracts.map((c) => c._id);
  // Termos aditivos de qualquer contrato do cliente (para somar valores mesmo que o
  // aditivo não caia no filtro atual).
  const aditivos = await Contract.find({ client: req.params.id, parentContract: { $ne: null } })
    .select('parentContract number name totalValue monthlyValue currency status signedAt startDate endDate files').lean();
  const porPai = new Map();
  for (const a of aditivos) {
    const k = String(a.parentContract);
    if (!porPai.has(k)) porPai.set(k, []);
    const { files, ...resto } = a;
    porPai.get(k).push({ ...resto, fileCount: (files || []).length });
  }
  // Contagens em lote (contratos por cliente são dezenas — sem agregação).
  const [machines, events] = await Promise.all([
    InfraMachine.find({ client: req.params.id, contract: { $in: ids } }).select('contract').lean(),
    MigrationEvent.find({ client: req.params.id, contract: { $in: ids } }).select('contract').lean(),
  ]);
  const countBy = (rows) => rows.reduce((acc, r) => {
    const k = String(r.contract); acc[k] = (acc[k] || 0) + 1; return acc;
  }, {});
  const mCount = countBy(machines);
  const eCount = countBy(events);
  res.json(contracts.map((c) => {
    const { software, files, ...rest } = c;
    const meus = porPai.get(String(c._id)) || [];
    const somaAditivos = meus.reduce((a, x) => a + (x.totalValue || 0), 0);
    return {
      ...rest,
      softwareCount: (software || []).length,
      fileCount: (files || []).length,
      machineCount: mCount[String(c._id)] || 0,
      eventCount: eCount[String(c._id)] || 0,
      files: (files || []).map((f) => ({ _id: f._id, name: f.name, kind: f.kind, size: f.size, contentType: f.contentType })),
      amendments: meus,
      amendmentCount: meus.length,
      amendmentValue: somaAditivos,
      // Valor consolidado = o do contrato + o dos termos aditivos.
      totalWithAmendments: (c.totalValue || 0) + somaAditivos,
    };
  }));
}));

router.post('/clients/:id/contracts', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const client = await Client.findById(req.params.id).lean();
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });
  const set = contractUpdate(req.body || {});
  if (!set.number) return res.status(400).json({ error: 'Informe o número do contrato.' });

  // Termo aditivo: precisa de um contrato-pai válido, e só um nível.
  const paiId = (req.body || {}).parentContract;
  if (paiId) {
    if (!isValidId(paiId)) return res.status(400).json({ error: 'Contrato de origem inválido.' });
    const pai = await Contract.findOne({ _id: paiId, client: client._id }).select('parentContract').lean();
    if (!pai) return res.status(422).json({ error: 'Contrato de origem não encontrado para este cliente.' });
    if (pai.parentContract) return res.status(422).json({ error: 'Um termo aditivo não pode ter outro termo aditivo.' });
    set.parentContract = pai._id;
  }

  try {
    const contract = await Contract.create({ client: client._id, ...set });
    res.status(201).json(contract);
  } catch (err) {
    if (err && err.code === 11000) return res.status(409).json({ error: 'Já existe um contrato com esse número para este cliente.' });
    throw err;
  }
}));

/*
 * Mapa PID|SERIAL -> contrato, para o inventário desenhar o selo sem custo por linha.
 * Precisa vir ANTES de /contracts/:cid: o Express casa na ordem, e "software-map"
 * cairia no :cid como se fosse um id.
 */
router.get('/clients/:id/contracts/software-map', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const rows = await Contract.find({ client: req.params.id })
    .select('number name status signedAt startDate endDate parentContract type software.productId software.swSerial').lean();
  const map = {};
  for (const c of rows) {
    for (const s of c.software || []) {
      map[swKey(s.productId, s.swSerial)] = { contract: String(c._id), number: c.number, name: c.name, status: c.status };
    }
  }
  // signedAt/startDate vão junto: o inventário sugere o contrato comparando a
  // Eff. Date do software com a data de assinatura.
  res.json({
    map,
    contracts: rows.map((c) => ({
      _id: c._id, number: c.number, name: c.name, status: c.status, type: c.type,
      signedAt: c.signedAt, startDate: c.startDate, endDate: c.endDate,
      parentContract: c.parentContract || null,
    })),
  });
}));

// Detalhe: máquinas e eventos resolvidos, e o software re-conferido contra o
// inventário vivo (o que não existe mais volta com stale:true).
router.get('/clients/:id/contracts/:cid', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const contract = await findContract(req.params.id, req.params.cid);
  if (!contract) return res.status(404).json({ error: 'Contrato não encontrado.' });
  const [machines, events, inventory, amendments, parent] = await Promise.all([
    InfraMachine.find({ client: req.params.id, contract: contract._id })
      .select('model serial status lsprModel cps ziips iflsActive memoryTB vfmTB iflsSpare icfs memoryAddTB site')
      .populate('site', 'name role').sort({ model: 1, serial: 1 }).lean(),
    MigrationEvent.find({ client: req.params.id, contract: contract._id })
      .select('kind status title fromMachine toMachine plannedDate executedAt value currency')
      .populate('fromMachine', 'model serial').populate('toMachine', 'model serial')
      .sort({ createdAt: -1 }).lean(),
    Inventory.findOne({ client: req.params.id }).select('products').lean(),
    Contract.find({ client: req.params.id, parentContract: contract._id }).sort({ signedAt: 1, createdAt: 1 }).lean(),
    contract.parentContract
      ? Contract.findById(contract.parentContract).select('number name totalValue currency').lean()
      : null,
  ]);
  const vivos = new Set((inventory && inventory.products ? inventory.products : [])
    .map((p) => swKey(p.productId, p.swSerial)));
  const doc = contract.toObject();
  doc.software = (doc.software || []).map((s) => ({ ...s, stale: !vivos.has(swKey(s.productId, s.swSerial)) }));
  const amendmentValue = amendments.reduce((a, x) => a + (x.totalValue || 0), 0);
  res.json({
    ...doc,
    machines,
    events,
    amendments: amendments.map((a) => {
      const { software, files, ...rest } = a;
      return { ...rest, softwareCount: (software || []).length, fileCount: (files || []).length };
    }),
    amendmentValue,
    totalWithAmendments: (doc.totalValue || 0) + amendmentValue,
    parent,
  });
}));

router.put('/clients/:id/contracts/:cid', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const set = contractUpdate(req.body || {});
  if (set.number !== undefined && !set.number) return res.status(400).json({ error: 'Informe o número do contrato.' });
  try {
    const contract = await Contract.findOneAndUpdate(
      { _id: req.params.cid, client: req.params.id }, { $set: set }, { new: true }
    ).lean();
    if (!contract) return res.status(404).json({ error: 'Contrato não encontrado.' });
    res.json(contract);
  } catch (err) {
    if (err && err.code === 11000) return res.status(409).json({ error: 'Já existe um contrato com esse número para este cliente.' });
    throw err;
  }
}));

// Excluir: solta as máquinas e os eventos (nada é apagado em cascata) e limpa os PDFs.
router.delete('/clients/:id/contracts/:cid', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const contract = await findContract(req.params.id, req.params.cid);
  if (!contract) return res.status(404).json({ error: 'Contrato não encontrado.' });
  // Termo aditivo é registro legal próprio: não some junto sem o usuário mandar.
  const aditivos = await Contract.countDocuments({ client: req.params.id, parentContract: contract._id });
  if (aditivos) {
    return res.status(422).json({ error: `Este contrato tem ${aditivos} termo(s) aditivo(s). Exclua-os antes.` });
  }
  removeContractFiles((contract.files || []).map((f) => f._id));
  await Promise.all([
    InfraMachine.updateMany({ client: req.params.id, contract: contract._id }, { $set: { contract: null } }),
    MigrationEvent.updateMany({ client: req.params.id, contract: contract._id }, { $set: { contract: null } }),
  ]);
  await Contract.deleteOne({ _id: contract._id });
  res.json({ ok: true });
}));

// ── Arquivos do contrato ──
router.post('/clients/:id/contracts/:cid/files', upload.single('file'), asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const contract = await findContract(req.params.id, req.params.cid);
  if (!contract) return res.status(404).json({ error: 'Contrato não encontrado.' });
  if (!req.file) return res.status(400).json({ error: 'Envie um arquivo.' });
  const name = req.file.originalname || 'arquivo';
  const kind = CONTRACT_FILE_KINDS.includes(req.body && req.body.kind) ? req.body.kind : 'contrato';
  contract.files.push({
    name, size: req.file.size, contentType: contractContentType(name), kind,
    uploadedAt: new Date(), uploadedBy: (req.user && req.user._id) || null,
  });
  const added = contract.files[contract.files.length - 1];
  saveContractFile(added._id, req.file.buffer);
  await contract.save();
  res.status(201).json({ file: added });
}));

router.get('/clients/:id/contracts/:cid/files/:fid', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const contract = await findContract(req.params.id, req.params.cid);
  if (!contract) return res.status(404).json({ error: 'Contrato não encontrado.' });
  const file = contract.files.id(req.params.fid);
  if (!file || !fs.existsSync(contractFilePath(file._id))) {
    return res.status(404).json({ error: 'Arquivo não encontrado.' });
  }
  sendStoredFile(res, contractFilePath(file._id), {
    name: file.name, contentType: file.contentType, download: Boolean(req.query.download),
  });
}));

router.delete('/clients/:id/contracts/:cid/files/:fid', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const contract = await findContract(req.params.id, req.params.cid);
  if (!contract) return res.status(404).json({ error: 'Contrato não encontrado.' });
  const file = contract.files.id(req.params.fid);
  if (!file) return res.status(404).json({ error: 'Arquivo não encontrado.' });
  removeContractFiles([file._id]);
  file.deleteOne();
  await contract.save();
  res.json({ ok: true });
}));

// ── Vínculo com máquinas (a relação mora em InfraMachine.contract) ──
router.post('/clients/:id/contracts/:cid/machines', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const contract = await findContract(req.params.id, req.params.cid);
  if (!contract) return res.status(404).json({ error: 'Contrato não encontrado.' });
  const ids = (Array.isArray(req.body && req.body.machineIds) ? req.body.machineIds : []).filter(isValidId);
  if (!ids.length) return res.status(400).json({ error: 'Informe ao menos uma máquina.' });
  const found = await InfraMachine.countDocuments({ _id: { $in: ids }, client: req.params.id });
  if (found !== ids.length) return res.status(422).json({ error: 'Alguma máquina não pertence a este cliente.' });
  const r = await InfraMachine.updateMany({ _id: { $in: ids }, client: req.params.id }, { $set: { contract: contract._id } });
  res.json({ ok: true, linked: r.modifiedCount });
}));

router.delete('/clients/:id/contracts/:cid/machines/:mid', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id) || !isValidId(req.params.mid)) return res.status(400).json({ error: 'Id inválido.' });
  const r = await InfraMachine.updateOne(
    { _id: req.params.mid, client: req.params.id, contract: req.params.cid }, { $set: { contract: null } }
  );
  if (!r.matchedCount) return res.status(404).json({ error: 'Máquina não vinculada a este contrato.' });
  res.json({ ok: true });
}));

/* ── Vínculo com software (PID) ──
   Mora no contrato porque um registro de software não é documento: é item de
   Inventory.products, que é apagado inteiro a cada re-upload. A descrição é
   copiada como snapshot para o contrato continuar legível depois da recarga. */
router.post('/clients/:id/contracts/:cid/software', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const contract = await findContract(req.params.id, req.params.cid);
  if (!contract) return res.status(404).json({ error: 'Contrato não encontrado.' });
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'Informe ao menos um registro de software.' });
  const move = Boolean(req.body && req.body.move);

  const pedidos = [];
  for (const it of items) {
    const productId = String((it && it.productId) || '').trim();
    const swSerial = String((it && it.swSerial) || '').trim();
    if (!productId || !swSerial) return res.status(400).json({ error: 'Cada registro precisa de PID e serial.' });
    pedidos.push({ productId, swSerial });
  }

  // Um registro só pode estar em um contrato por cliente.
  const chaves = new Set(pedidos.map((p) => swKey(p.productId, p.swSerial)));
  const outros = await Contract.find({ client: req.params.id, _id: { $ne: contract._id } })
    .select('number name software').lean();
  const conflitos = [];
  for (const o of outros) {
    for (const s of o.software || []) {
      if (chaves.has(swKey(s.productId, s.swSerial))) conflitos.push({ contrato: o, sw: s });
    }
  }
  if (conflitos.length && !move) {
    const c = conflitos[0];
    return res.status(409).json({
      error: `${c.sw.productId} (serial ${c.sw.swSerial}) já está no contrato ${c.contrato.number}. Use "mover" para transferir.`,
      conflicts: conflitos.map((x) => ({ productId: x.sw.productId, swSerial: x.sw.swSerial, contract: x.contrato._id, number: x.contrato.number })),
    });
  }
  if (conflitos.length && move) {
    for (const o of outros) {
      const restante = (o.software || []).filter((s) => !chaves.has(swKey(s.productId, s.swSerial)));
      if (restante.length !== (o.software || []).length) {
        await Contract.updateOne({ _id: o._id }, { $set: { software: restante } });
      }
    }
  }

  // Snapshot do inventário vivo (o que não achar entra só com PID+serial).
  const inv = await Inventory.findOne({ client: req.params.id }).select('products').lean();
  const byKey = new Map((inv && inv.products ? inv.products : []).map((p) => [swKey(p.productId, p.swSerial), p]));
  const atuais = new Map((contract.software || []).map((s) => [swKey(s.productId, s.swSerial), s]));
  for (const p of pedidos) {
    const k = swKey(p.productId, p.swSerial);
    const src = byKey.get(k);
    atuais.set(k, {
      productId: p.productId,
      swSerial: p.swSerial,
      category: (src && src.category) || '',
      description: (src && src.description) || '',
      effDate: (src && src.effDate) || '',
      poNumber: (src && src.poNumber) || '',
      notes: (atuais.get(k) && atuais.get(k).notes) || '',
      linkedAt: (atuais.get(k) && atuais.get(k).linkedAt) || new Date(),
    });
  }
  contract.software = [...atuais.values()];
  await contract.save();
  res.json({ ok: true, software: contract.software, moved: move ? conflitos.length : 0 });
}));

// POST (não DELETE) porque o codebase nunca manda corpo em DELETE.
router.post('/clients/:id/contracts/:cid/software/unlink', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const contract = await findContract(req.params.id, req.params.cid);
  if (!contract) return res.status(404).json({ error: 'Contrato não encontrado.' });
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  const alvo = new Set(items.map((i) => swKey(i && i.productId, i && i.swSerial)));
  contract.software = (contract.software || []).filter((s) => !alvo.has(swKey(s.productId, s.swSerial)));
  await contract.save();
  res.json({ ok: true, software: contract.software });
}));

/** Busca enxuta no inventário para o autocomplete de vínculo (sem baixar tudo). */
router.get('/clients/:id/inventory/records', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const inv = await Inventory.findOne({ client: req.params.id }).select('products').lean();
  if (!inv) return res.json([]);
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const q = String(req.query.q || '').trim().toLowerCase();
  const cat = String(req.query.category || '').trim().toUpperCase();
  const out = [];
  for (const p of inv.products || []) {
    if (cat && String(p.category || '').toUpperCase() !== cat) continue;
    if (q && !`${p.productId} ${p.swSerial} ${p.description}`.toLowerCase().includes(q)) continue;
    out.push({
      productId: p.productId, swSerial: p.swSerial, description: p.description,
      category: p.category, effDate: p.effDate, poNumber: p.poNumber,
    });
    if (out.length >= limit) break;
  }
  res.json(out);
}));

/* ══════════════════════════════════════════════════════════════════════════
   MO / MES — atualização tecnológica do parque
   proposta → contratado → executado (+ cancelada). A execução é o ÚNICO ponto
   que altera documentos de máquina.
   ══════════════════════════════════════════════════════════════════════════ */

const CONFIG_FIELDS = ['model', 'variant', 'featureModel', 'lsprModel', 'cps', 'ziips', 'iflsActive', 'memoryTB', 'vfmTB', 'iflsSpare', 'icfs', 'memoryAddTB'];
const upperSerial = (s) => String(s || '').trim().toUpperCase();

/** Foto da configuração de uma máquina, com o LSPR congelado. */
async function configOf(machine) {
  const cfg = { serial: machine.serial || '' };
  for (const f of CONFIG_FIELDS) cfg[f] = machine[f] === undefined ? (typeof machine[f] === 'string' ? '' : 0) : machine[f];
  const lspr = machine.lsprModel ? await LsprModel.findOne({ model: machine.lsprModel }).select('msu mips').lean() : null;
  cfg.msu = lspr ? lspr.msu : null;
  cfg.mips = lspr ? lspr.mips : null;
  return cfg;
}

/** Normaliza o alvo vindo do corpo, congelando o LSPR informado. */
async function configFromBody(body) {
  const cfg = { serial: upperSerial(body && body.serial) };
  for (const f of CONFIG_FIELDS) {
    const v = body ? body[f] : undefined;
    if (['model', 'variant', 'featureModel', 'lsprModel'].includes(f)) cfg[f] = String(v || '').trim();
    else cfg[f] = numOf(v);
  }
  const lspr = cfg.lsprModel ? await LsprModel.findOne({ model: cfg.lsprModel }).select('msu mips').lean() : null;
  cfg.msu = lspr ? lspr.msu : null;
  cfg.mips = lspr ? lspr.mips : null;
  return cfg;
}

/** Aplica uma configuração numa máquina (sem tocar no serial). */
function applyConfig(machine, cfg) {
  for (const f of CONFIG_FIELDS) if (cfg[f] !== undefined && cfg[f] !== null && cfg[f] !== '') machine[f] = cfg[f];
}

router.get('/clients/:id/migrations', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const filter = { client: req.params.id };
  if (req.query.machineId && isValidId(req.query.machineId)) {
    filter.$or = [{ fromMachine: req.query.machineId }, { toMachine: req.query.machineId }];
  }
  if (['MO', 'MES'].includes(req.query.kind)) filter.kind = req.query.kind;
  if (['proposta', 'contratado', 'executado', 'cancelada'].includes(req.query.status)) filter.status = req.query.status;
  const events = await MigrationEvent.find(filter)
    .populate('fromMachine', 'model serial status')
    .populate('toMachine', 'model serial status')
    .populate('contract', 'number name status')
    .sort({ createdAt: -1 }).lean();
  res.json(events);
}));

router.post('/clients/:id/migrations', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const client = await Client.findById(req.params.id).lean();
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });
  const b = req.body || {};
  if (!['MO', 'MES'].includes(b.kind)) return res.status(400).json({ error: 'Informe se é MO ou MES.' });
  if (!isValidId(b.fromMachine)) return res.status(400).json({ error: 'Informe a máquina de origem.' });
  const machine = await InfraMachine.findOne({ _id: b.fromMachine, client: client._id });
  if (!machine) return res.status(404).json({ error: 'Máquina não encontrada.' });

  // `before` é SEMPRE do servidor — o que vier do cliente é ignorado.
  const before = await configOf(machine);
  const after = await configFromBody(b.after || {});

  if (b.kind === 'MES') {
    if (after.serial && after.serial !== upperSerial(machine.serial)) {
      return res.status(422).json({ error: 'MES mantém a mesma máquina — para trocar de serial use MO.' });
    }
    after.serial = upperSerial(machine.serial);
  } else {
    if (!after.serial) return res.status(422).json({ error: 'Num MO informe o serial da máquina nova.' });
    if (after.serial === upperSerial(machine.serial)) {
      return res.status(422).json({ error: 'O serial da máquina nova precisa ser diferente do atual.' });
    }
  }

  let contract = null;
  if (b.contract && isValidId(b.contract)) {
    const ok = await Contract.exists({ _id: b.contract, client: client._id });
    if (!ok) return res.status(422).json({ error: 'Contrato inválido para este cliente.' });
    contract = b.contract;
  }

  const event = await MigrationEvent.create({
    client: client._id, kind: b.kind, status: 'proposta',
    title: String(b.title || '').trim(), notes: String(b.notes || ''), proposalRef: String(b.proposalRef || '').trim(),
    fromMachine: machine._id, contract, before, after,
    plannedDate: dateOrNull(b.plannedDate), value: moneyOrNull(b.value),
    currency: CURRENCIES.includes(b.currency) ? b.currency : 'BRL',
    createdBy: (req.user && req.user._id) || null,
    history: [{ at: new Date(), from: '', to: 'proposta', by: (req.user && req.user._id) || null, note: 'proposta criada' }],
  });
  res.status(201).json(event);
}));

router.get('/clients/:id/migrations/:eid', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id) || !isValidId(req.params.eid)) return res.status(400).json({ error: 'Id inválido.' });
  const event = await MigrationEvent.findOne({ _id: req.params.eid, client: req.params.id })
    .populate('fromMachine', 'model serial status site')
    .populate('toMachine', 'model serial status site')
    .populate('contract', 'number name status').lean();
  if (!event) return res.status(404).json({ error: 'Evento não encontrado.' });
  res.json(event);
}));

router.put('/clients/:id/migrations/:eid', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id) || !isValidId(req.params.eid)) return res.status(400).json({ error: 'Id inválido.' });
  const event = await MigrationEvent.findOne({ _id: req.params.eid, client: req.params.id });
  if (!event) return res.status(404).json({ error: 'Evento não encontrado.' });
  const b = req.body || {};
  const travado = event.status === 'executado';
  if (travado && (b.after !== undefined || b.kind !== undefined || b.fromMachine !== undefined)) {
    return res.status(422).json({ error: 'Evento já executado: desfaça antes de mudar a configuração.' });
  }
  if (b.title !== undefined) event.title = String(b.title || '').trim();
  if (b.notes !== undefined) event.notes = String(b.notes || '');
  if (b.proposalRef !== undefined) event.proposalRef = String(b.proposalRef || '').trim();
  if (b.plannedDate !== undefined) event.plannedDate = dateOrNull(b.plannedDate);
  if (b.value !== undefined) event.value = moneyOrNull(b.value);
  if (b.currency !== undefined && CURRENCIES.includes(b.currency)) event.currency = b.currency;
  if (b.contract !== undefined) {
    if (b.contract && isValidId(b.contract)) {
      const ok = await Contract.exists({ _id: b.contract, client: req.params.id });
      if (!ok) return res.status(422).json({ error: 'Contrato inválido para este cliente.' });
      event.contract = b.contract;
    } else event.contract = null;
  }
  if (!travado && b.after !== undefined) {
    const after = await configFromBody(b.after);
    if (event.kind === 'MES') after.serial = event.before.serial;
    else if (!after.serial) return res.status(422).json({ error: 'Num MO informe o serial da máquina nova.' });
    event.after = after;
  }
  await event.save();
  res.json(event);
}));

router.delete('/clients/:id/migrations/:eid', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id) || !isValidId(req.params.eid)) return res.status(400).json({ error: 'Id inválido.' });
  const event = await MigrationEvent.findOne({ _id: req.params.eid, client: req.params.id });
  if (!event) return res.status(404).json({ error: 'Evento não encontrado.' });
  if (!['proposta', 'cancelada'].includes(event.status)) {
    return res.status(422).json({ error: 'Só dá para excluir uma proposta ou um evento cancelado.' });
  }
  await MigrationEvent.deleteOne({ _id: event._id });
  res.json({ ok: true });
}));

// Transições simples (proposta / contratado / cancelada). Executar e desfazer têm rota própria.
router.post('/clients/:id/migrations/:eid/status', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id) || !isValidId(req.params.eid)) return res.status(400).json({ error: 'Id inválido.' });
  const event = await MigrationEvent.findOne({ _id: req.params.eid, client: req.params.id });
  if (!event) return res.status(404).json({ error: 'Evento não encontrado.' });
  const alvo = (req.body || {}).status;
  if (!['proposta', 'contratado', 'cancelada'].includes(alvo)) {
    return res.status(400).json({ error: 'Status inválido. Use executar/desfazer para a execução.' });
  }
  if (event.status === 'executado') {
    return res.status(422).json({ error: 'Evento já executado: desfaça a execução antes.' });
  }
  if (alvo === 'contratado') {
    const b = req.body || {};
    if (b.contract && isValidId(b.contract)) {
      const ok = await Contract.exists({ _id: b.contract, client: req.params.id });
      if (!ok) return res.status(422).json({ error: 'Contrato inválido para este cliente.' });
      event.contract = b.contract;
    }
    if (!event.contract) return res.status(422).json({ error: 'Vincule o contrato assinado antes de marcar como contratado.' });
  }
  const de = event.status;
  event.status = alvo;
  event.history.push({ at: new Date(), from: de, to: alvo, by: (req.user && req.user._id) || null, note: String((req.body || {}).note || '') });
  await event.save();
  res.json(event);
}));

/* Executar: o único ponto que altera máquinas.
   MES aplica na própria; MO cria (ou atualiza) a nova e aposenta a antiga —
   sem apagar nada, para o consumo SCRT e as LPARs históricas continuarem lá. */
router.post('/clients/:id/migrations/:eid/executar', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id) || !isValidId(req.params.eid)) return res.status(400).json({ error: 'Id inválido.' });
  const event = await MigrationEvent.findOne({ _id: req.params.eid, client: req.params.id });
  if (!event) return res.status(404).json({ error: 'Evento não encontrado.' });
  if (event.status === 'executado') return res.status(422).json({ error: 'Este evento já foi executado.' });
  if (event.status !== 'contratado') return res.status(422).json({ error: 'Só dá para executar um evento contratado.' });

  const from = await InfraMachine.findOne({ _id: event.fromMachine, client: req.params.id });
  if (!from) return res.status(404).json({ error: 'Máquina de origem não encontrada.' });

  const b = req.body || {};
  const executedAt = dateOrNull(b.executedAt) || new Date();
  // Ponto de restauração: a config REAL agora, que pode ter mudado desde a proposta.
  const applied = {
    at: executedAt,
    fromMachineBefore: await configOf(from),
    fromMachineStatusBefore: from.status || 'ativa',
    toMachineCreated: false,
    clonedLparIds: [],
  };

  let to = null;
  if (event.kind === 'MES') {
    applyConfig(from, event.after);
    if (event.contract) from.contract = event.contract;
    await from.save();
  } else {
    if (event.toMachine) {
      to = await InfraMachine.findOne({ _id: event.toMachine, client: req.params.id });
    }
    if (!to) {
      const site = b.site && isValidId(b.site) ? b.site : from.site;
      to = new InfraMachine({
        client: from.client, site, serial: upperSerial(event.after.serial),
        status: 'ativa', replaces: from._id, installedAt: executedAt,
        contract: event.contract || from.contract || null,
      });
      applyConfig(to, event.after);
      await to.save();
      applied.toMachineCreated = true;
      event.toMachine = to._id;
    } else {
      applyConfig(to, event.after);
      to.serial = upperSerial(event.after.serial);
      to.replaces = from._id;
      to.status = 'ativa';
      if (event.contract) to.contract = event.contract;
      await to.save();
    }
    if (b.migrarLpars) {
      const lpars = await InfraLpar.find({ machine: from._id }).lean();
      for (const l of lpars) {
        const { _id, machine, createdAt, updatedAt, __v, ...rest } = l;
        const novo = await InfraLpar.create({ ...rest, machine: to._id });
        applied.clonedLparIds.push(novo._id);
      }
    }
    from.status = 'substituida';
    from.replacedBy = to._id;
    from.replacedAt = executedAt;
    await from.save();
  }

  event.applied = applied;
  event.status = 'executado';
  event.executedAt = executedAt;
  event.history.push({ at: executedAt, from: 'contratado', to: 'executado', by: (req.user && req.user._id) || null, note: String(b.note || '') });
  await event.save();

  res.json({ event: event.toObject(), fromMachine: from.toObject(), toMachine: to ? to.toObject() : null });
}));

/* Desfazer: restaura o ponto capturado na execução. Nunca destrói às cegas —
   se a máquina criada já ganhou vida própria (LPAR/outro evento), recusa. */
router.post('/clients/:id/migrations/:eid/desfazer', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id) || !isValidId(req.params.eid)) return res.status(400).json({ error: 'Id inválido.' });
  const event = await MigrationEvent.findOne({ _id: req.params.eid, client: req.params.id });
  if (!event) return res.status(404).json({ error: 'Evento não encontrado.' });
  if (event.status !== 'executado') return res.status(422).json({ error: 'Só dá para desfazer um evento executado.' });
  if (!event.applied) return res.status(422).json({ error: 'Sem ponto de restauração para este evento.' });

  const from = await InfraMachine.findOne({ _id: event.fromMachine, client: req.params.id });
  if (!from) return res.status(404).json({ error: 'Máquina de origem não encontrada.' });

  const clonadas = (event.applied.clonedLparIds || []).map(String);
  if (event.kind === 'MO' && event.toMachine) {
    const proprias = await InfraLpar.countDocuments({ machine: event.toMachine, _id: { $nin: clonadas } });
    if (proprias > 0) {
      return res.status(422).json({ error: 'A máquina nova já tem LPARs próprias — remova-as antes de desfazer.' });
    }
    const outros = await MigrationEvent.countDocuments({
      _id: { $ne: event._id }, $or: [{ fromMachine: event.toMachine }, { toMachine: event.toMachine }],
    });
    if (outros > 0) {
      return res.status(422).json({ error: 'A máquina nova já tem outros eventos de MO/MES — desfaça-os antes.' });
    }
  }

  if (clonadas.length) await InfraLpar.deleteMany({ _id: { $in: clonadas } });

  applyConfig(from, event.applied.fromMachineBefore);
  if (event.kind === 'MES') from.serial = event.applied.fromMachineBefore.serial || from.serial;
  from.status = event.applied.fromMachineStatusBefore || 'ativa';
  from.replacedBy = null;
  from.replacedAt = null;
  await from.save();

  if (event.kind === 'MO' && event.toMachine) {
    if (event.applied.toMachineCreated) {
      await InfraMachine.deleteOne({ _id: event.toMachine });
      event.toMachine = null;
    } else {
      await InfraMachine.updateOne({ _id: event.toMachine }, { $set: { replaces: null } });
    }
  }

  event.status = 'contratado';
  event.executedAt = null;
  event.applied = null;
  event.history.push({ at: new Date(), from: 'executado', to: 'contratado', by: (req.user && req.user._id) || null, note: String((req.body || {}).note || 'execução desfeita') });
  await event.save();

  res.json({ event: event.toObject(), fromMachine: from.toObject() });
}));

/* Histórico da máquina: eventos, cadeia de substituição e o consumo SCRT de
   TODOS os meses (a máquina substituída some do último SCRT, mas o histórico dela
   continua nos relatórios antigos). */
async function scrtSeriesForSerial(client, serial) {
  const alvo = upperSerial(serial);
  if (!alvo) return [];
  const raw = await ScrtReport.find({ client: client._id }).sort({ periodKey: 1, createdAt: 1 }).lean();
  if (!raw.length) return [];
  const out = [];
  for (const mes of mergeByMonth(raw, tagContextOf(client))) {
    const m = (mes.machines || []).find((x) => serialOf(x) === alvo);
    if (m) out.push({ periodKey: mes.periodKey, periodLabel: mes.periodLabel, msuConsumed: m.msuConsumed || 0, ignored: !!m.ignored });
  }
  return out;
}

/*
 * Detalhes da máquina: contrato, capacidade (LSPR) e as LPARs que o SCRT reporta
 * para ela. Atenção ao pulo serial → identificador: a máquina de infra casa com o
 * SCRT pelo SERIAL, mas as LPARs do SCRT referenciam o IDENTIFICADOR (ex.: "M1C1").
 */
router.get('/clients/:id/infra/machines/:machineId/detalhes', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id) || !isValidId(req.params.machineId)) return res.status(400).json({ error: 'Id inválido.' });
  const client = await Client.findById(req.params.id).lean();
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });
  const machine = await InfraMachine.findOne({ _id: req.params.machineId, client: client._id })
    .select('-configTxtContent -configCfrContent').populate('site', 'name location role').lean();
  if (!machine) return res.status(404).json({ error: 'Máquina não encontrada.' });

  await attachLspr([machine]);
  await attachContracts([machine]);

  const alvo = String(machine.serial || '').trim().toUpperCase();
  let scrtMachine = null;
  let scrtLpars = [];
  let periodLabel = null;
  if (alvo) {
    const raw = await ScrtReport.find({ client: client._id }).sort({ periodKey: 1, createdAt: 1 }).lean();
    if (raw.length) {
      const merged = mergeByMonth(raw, tagContextOf(client));
      const ultimo = merged[merged.length - 1];
      const m = (ultimo.machines || []).find((x) => serialOf(x) === alvo);
      if (m) {
        periodLabel = ultimo.periodLabel;
        scrtMachine = {
          identifier: m.identifier || '', serialNumber: m.serialNumber || '', typeModel: m.typeModel || '',
          ratedCapacityMsus: m.ratedCapacityMsus || null, peakUtilizationMsus: m.peakUtilizationMsus || null,
          msuConsumed: m.msuConsumed || null, tag: m.tag || null, ignored: !!m.ignored, periodLabel: ultimo.periodLabel,
        };
        // As LPARs do SCRT apontam para o identificador da máquina, não para o serial.
        const chave = m.identifier || m.serialNumber;
        scrtLpars = (ultimo.lpars || [])
          .filter((l) => l.machine === chave)
          .map((l) => ({
            name: l.name, os: l.os || '', msuConsumed: l.msuConsumed || null,
            peakHourMsu: l.peakHourMsu || null, peakHourAt: l.peakHourAt || '',
            peak4hraMsu: l.peak4hraMsu || null, peak4hraAt: l.peak4hraAt || '',
          }))
          .sort((a, b) => (b.msuConsumed || 0) - (a.msuConsumed || 0));
      }
    }
  }

  const [lpars, events] = await Promise.all([
    InfraLpar.find({ machine: machine._id }).sort({ name: 1 }).lean(),
    MigrationEvent.find({ client: client._id, $or: [{ fromMachine: machine._id }, { toMachine: machine._id }] })
      .select('kind status title executedAt plannedDate value currency contract')
      .populate('contract', 'number name').sort({ createdAt: -1 }).lean(),
  ]);

  res.json({ machine, scrtMachine, scrtLpars, scrtPeriodLabel: periodLabel, lpars, events });
}));

router.get('/clients/:id/infra/machines/:machineId/historico', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id) || !isValidId(req.params.machineId)) return res.status(400).json({ error: 'Id inválido.' });
  const client = await Client.findById(req.params.id).lean();
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });
  const machine = await InfraMachine.findOne({ _id: req.params.machineId, client: client._id })
    .select('-configTxtContent -configCfrContent').populate('site', 'name role').lean();
  if (!machine) return res.status(404).json({ error: 'Máquina não encontrada.' });

  // Cadeia de substituição, com proteção contra dado circular (A→B→A travaria o servidor).
  const anda = async (startId, campo) => {
    const out = [];
    const vistos = new Set([String(req.params.machineId)]);
    let id = startId;
    for (let i = 0; i < 20 && id; i++) {
      if (vistos.has(String(id))) break;
      vistos.add(String(id));
      const m = await InfraMachine.findById(id).select('model serial status replaces replacedBy replacedAt installedAt').lean();
      if (!m) break;
      out.push(m);
      id = m[campo];
    }
    return out;
  };

  const [events, chainBack, chainFwd, scrt, lparCount] = await Promise.all([
    MigrationEvent.find({ client: client._id, $or: [{ fromMachine: machine._id }, { toMachine: machine._id }] })
      .populate('fromMachine', 'model serial').populate('toMachine', 'model serial')
      .populate('contract', 'number name status').sort({ createdAt: 1 }).lean(),
    anda(machine.replaces, 'replaces'),
    anda(machine.replacedBy, 'replacedBy'),
    scrtSeriesForSerial(client, machine.serial),
    InfraLpar.countDocuments({ machine: machine._id }),
  ]);
  await attachLspr([machine]);
  await attachContracts([machine]);

  res.json({ machine, events, chain: { replaces: chainBack, replacedBy: chainFwd }, scrt, lparCount });
}));

// ── LSPR: referência de capacidade por modelo IBM Z (consulta, dados públicos) ──
router.get('/lspr/meta', asyncHandler(async (req, res) => {
  const total = await LsprModel.estimatedDocumentCount();
  const [generations, machineTypes, sample] = await Promise.all([
    LsprModel.distinct('generation'),
    LsprModel.distinct('machineType'),
    LsprModel.findOne().select('source').lean(),
  ]);
  res.json({
    total,
    generations: generations.filter(Boolean).sort(),
    machineTypes: machineTypes.filter(Boolean).sort(),
    source: (sample && sample.source) || '',
  });
}));

router.get('/lspr', asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.type) filter.machineType = String(req.query.type).trim();
  if (req.query.generation) filter.generation = String(req.query.generation).trim();
  const q = String(req.query.q || '').trim();
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ model: rx }, { family: rx }, { generation: rx }, { machineType: rx }];
  }
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const skip = Math.max(Number(req.query.skip) || 0, 0);
  // A resposta continua sendo o ARRAY puro — o combobox de modelo da infra e os
  // testes dependem disso. O total do filtro vai no cabeçalho, para a tela de
  // consulta poder dizer "mostrando 100 de 3.190" e paginar.
  const [rows, total] = await Promise.all([
    LsprModel.find(filter).sort({ machineType: 1, cps: 1 }).skip(skip).limit(limit).lean(),
    LsprModel.countDocuments(filter),
  ]);
  res.setHeader('X-Total-Count', String(total));
  res.json(rows);
}));

router.get('/lspr/:model', asyncHandler(async (req, res) => {
  const row = await LsprModel.findOne({ model: String(req.params.model || '').trim() }).lean();
  if (!row) return res.status(404).json({ error: 'Modelo LSPR não encontrado.' });
  res.json(row);
}));

// ── Sites ──
router.get('/clients/:id/infra/sites', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  res.json(await InfraSite.find({ client: req.params.id }).sort({ name: 1 }).lean());
}));

router.post('/clients/:id/infra/sites', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const client = await Client.findById(req.params.id).lean();
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });
  const set = siteUpdate(req.body || {});
  if (!set.name) return res.status(400).json({ error: 'Informe o nome do site.' });
  res.status(201).json(await InfraSite.create({ client: client._id, ...set }));
}));

router.put('/clients/:id/infra/sites/:siteId', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id) || !isValidId(req.params.siteId)) return res.status(400).json({ error: 'Id inválido.' });
  const set = siteUpdate(req.body || {});
  if (set.name !== undefined && !set.name) return res.status(400).json({ error: 'O nome do site não pode ficar vazio.' });
  const site = await InfraSite.findOneAndUpdate({ _id: req.params.siteId, client: req.params.id }, { $set: set }, { new: true }).lean();
  if (!site) return res.status(404).json({ error: 'Site não encontrado.' });
  res.json(site);
}));

router.delete('/clients/:id/infra/sites/:siteId', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id) || !isValidId(req.params.siteId)) return res.status(400).json({ error: 'Id inválido.' });
  const site = await InfraSite.findOneAndDelete({ _id: req.params.siteId, client: req.params.id });
  if (!site) return res.status(404).json({ error: 'Site não encontrado.' });
  // Máquinas do site ficam "sem site".
  await InfraMachine.updateMany({ client: req.params.id, site: site._id }, { $unset: { site: 1 } });
  res.json({ ok: true });
}));

// ── Máquinas ──
router.get('/clients/:id/infra/machines', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const client = await Client.findById(req.params.id).lean();
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });
  const filter = { client: req.params.id };
  if (req.query.siteId && isValidId(req.query.siteId)) filter.site = req.query.siteId;
  const machines = await InfraMachine.find(filter)
    .select('-configTxtContent -configCfrContent')
    .populate('site', 'name location role')
    .sort({ model: 1, serial: 1 })
    .lean();
  // Cruza com o SCRT pelo serial (consumo/tag do último mês).
  const bySerial = await scrtBySerialLatest(client);
  for (const m of machines) m.scrt = bySerial.get(String(m.serial || '').trim().toUpperCase()) || null;
  await attachLspr(machines);       // referência de capacidade LSPR (m.lspr)
  await attachLifecycle(machines);  // geração + fim de serviço IBM (m.lifecycle)
  await attachContracts(machines);  // contrato vigente (m.contractRef)
  await attachMigrations(machines); // resumo de MO/MES (m.migrations)
  res.json(machines);
}));

router.post('/clients/:id/infra/machines', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const client = await Client.findById(req.params.id).lean();
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });
  const set = machineUpdate(req.body || {});
  if (!set.model && !set.serial) return res.status(400).json({ error: 'Informe ao menos o modelo ou o serial da máquina.' });
  if (set.site) {
    const ok = await InfraSite.exists({ _id: set.site, client: client._id });
    if (!ok) return res.status(422).json({ error: 'Site inválido para este cliente.' });
  }
  if (set.contract) {
    const ok = await Contract.exists({ _id: set.contract, client: client._id });
    if (!ok) return res.status(422).json({ error: 'Contrato inválido para este cliente.' });
  }
  res.status(201).json(await InfraMachine.create({ client: client._id, ...set }));
}));

// Puxa as máquinas do último SCRT: cria as que faltam e atualiza type-model/LSPR
// das existentes (casadas pelo serial). Liga automaticamente ao LSPR pelo type-model.
router.post('/clients/:id/infra/machines/import-scrt', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const client = await Client.findById(req.params.id).lean();
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });

  const scrtMachines = await scrtLatestMachines(client);
  if (!scrtMachines.length) {
    return res.status(422).json({ error: 'Nenhum SCRT com máquinas encontrado para este cliente.' });
  }

  // Resolve de uma vez os type-models presentes no SCRT contra a tabela LSPR.
  const typeModels = [...new Set(scrtMachines.map((m) => m.typeModel).filter(Boolean))];
  const lsprRows = typeModels.length ? await LsprModel.find({ model: { $in: typeModels } }).lean() : [];
  const lsprByModel = new Map(lsprRows.map((r) => [r.model, r]));

  const existing = await InfraMachine.find({ client: client._id }).select('serial model lsprModel').lean();
  const bySerial = new Map(existing.map((m) => [String(m.serial || '').trim().toUpperCase(), m]));

  let created = 0;
  let updated = 0;
  let linked = 0;
  for (const sm of scrtMachines) {
    const lspr = sm.typeModel ? lsprByModel.get(sm.typeModel) : null;
    if (lspr) linked++;
    const cur = bySerial.get(sm.serial);
    if (cur) {
      const set = {};
      if (lspr && cur.lsprModel !== lspr.model) set.lsprModel = lspr.model;
      if (!cur.model && (lspr ? lspr.family : sm.typeModel)) set.model = lspr ? lspr.family : sm.typeModel;
      if (Object.keys(set).length) { await InfraMachine.updateOne({ _id: cur._id }, { $set: set }); updated++; }
    } else {
      await InfraMachine.create({
        client: client._id,
        serial: sm.serial,
        model: lspr ? lspr.family : (sm.typeModel || ''),
        lsprModel: lspr ? lspr.model : '',
        notes: sm.periodLabel ? `Importado do SCRT (${sm.periodLabel})` : 'Importado do SCRT',
      });
      created++;
    }
  }
  res.json({ created, updated, linked, scanned: scrtMachines.length, periodLabel: scrtMachines[0].periodLabel });
}));

router.get('/clients/:id/infra/machines/:machineId', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id) || !isValidId(req.params.machineId)) return res.status(400).json({ error: 'Id inválido.' });
  const machine = await InfraMachine.findOne({ _id: req.params.machineId, client: req.params.id })
    .populate('site', 'name location role').lean();
  if (!machine) return res.status(404).json({ error: 'Máquina não encontrada.' });
  await attachLspr([machine]);
  res.json(machine);
}));

router.put('/clients/:id/infra/machines/:machineId', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id) || !isValidId(req.params.machineId)) return res.status(400).json({ error: 'Id inválido.' });
  const set = machineUpdate(req.body || {});
  if (set.site) {
    const ok = await InfraSite.exists({ _id: set.site, client: req.params.id });
    if (!ok) return res.status(422).json({ error: 'Site inválido para este cliente.' });
  }
  if (set.contract) {
    const ok = await Contract.exists({ _id: set.contract, client: req.params.id });
    if (!ok) return res.status(422).json({ error: 'Contrato inválido para este cliente.' });
  }
  const machine = await InfraMachine.findOneAndUpdate({ _id: req.params.machineId, client: req.params.id }, { $set: set }, { new: true })
    .select('-configTxtContent -configCfrContent').populate('site', 'name location role').lean();
  if (!machine) return res.status(404).json({ error: 'Máquina não encontrada.' });
  res.json(machine);
}));

router.delete('/clients/:id/infra/machines/:machineId', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id) || !isValidId(req.params.machineId)) return res.status(400).json({ error: 'Id inválido.' });
  const machine = await InfraMachine.findOneAndDelete({ _id: req.params.machineId, client: req.params.id });
  if (!machine) return res.status(404).json({ error: 'Máquina não encontrada.' });
  await InfraLpar.deleteMany({ machine: machine._id }); // cascata: LPARs da máquina
  res.json({ ok: true });
}));

// ── LPARs ──
router.get('/clients/:id/infra/lpars', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const filter = { client: req.params.id };
  if (req.query.machineId && isValidId(req.query.machineId)) filter.machine = req.query.machineId;
  res.json(await InfraLpar.find(filter).populate('machine', 'model variant featureModel serial').sort({ name: 1 }).lean());
}));

router.post('/clients/:id/infra/lpars', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Id inválido.' });
  const client = await Client.findById(req.params.id).lean();
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado.' });
  const set = lparUpdate(req.body || {});
  if (!set.machine) return res.status(400).json({ error: 'Informe a máquina da LPAR.' });
  if (!set.name) return res.status(400).json({ error: 'Informe o nome da LPAR.' });
  const machineOk = await InfraMachine.exists({ _id: set.machine, client: client._id });
  if (!machineOk) return res.status(422).json({ error: 'Máquina inválida para este cliente.' });
  res.status(201).json(await InfraLpar.create({ client: client._id, ...set }));
}));

router.put('/clients/:id/infra/lpars/:lparId', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id) || !isValidId(req.params.lparId)) return res.status(400).json({ error: 'Id inválido.' });
  const set = lparUpdate(req.body || {});
  if (set.name !== undefined && !set.name) return res.status(400).json({ error: 'O nome da LPAR não pode ficar vazio.' });
  if (set.machine) {
    const ok = await InfraMachine.exists({ _id: set.machine, client: req.params.id });
    if (!ok) return res.status(422).json({ error: 'Máquina inválida para este cliente.' });
  }
  const lpar = await InfraLpar.findOneAndUpdate({ _id: req.params.lparId, client: req.params.id }, { $set: set }, { new: true }).lean();
  if (!lpar) return res.status(404).json({ error: 'LPAR não encontrada.' });
  res.json(lpar);
}));

router.delete('/clients/:id/infra/lpars/:lparId', asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id) || !isValidId(req.params.lparId)) return res.status(400).json({ error: 'Id inválido.' });
  const lpar = await InfraLpar.findOneAndDelete({ _id: req.params.lparId, client: req.params.id });
  if (!lpar) return res.status(404).json({ error: 'LPAR não encontrada.' });
  res.json({ ok: true });
}));

module.exports = router;
/*
 * Reaproveitados pelo painel gerencial (src/regional.js). São exportados em vez
 * de copiados de propósito: o consumo faturável de um recorte de clientes TEM de
 * ser calculado exatamente como na tela individual — mesma fusão mensal e mesma
 * regra de tag ignorada. Uma segunda implementação divergiria, e o painel perderia
 * a credibilidade na primeira conferência.
 */
module.exports.mergeByMonth = mergeByMonth;
module.exports.tagContextOf = tagContextOf;
