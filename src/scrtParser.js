'use strict';

/**
 * Parser de relatórios SCRT (Sub-Capacity Reporting Tool / Enterprise TFP Report - IBM).
 *
 * Regra de negócio central: o consumo mensal do cliente é a soma da linha
 * "Machine MSU Consumed" de todas as máquinas do Multiplex (seção ==B5).
 * O total dos containers ("TOTAL MSU Consumption") é guardado como conferência.
 */

const EN_MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const PT_MONTH_ABBR = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

/** SCRTs costumam vir em ISO-8859-1; detecta UTF-8 válido e cai para latin1 se necessário. */
function decodeBuffer(buf) {
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  return buf.toString('latin1');
}

/**
 * Detecta o separador do arquivo. A maioria dos SCRTs usa vírgula, mas alguns
 * (ex.: ITAÚ) vêm com ponto e vírgula. Decide pelo caractere mais frequente,
 * ignorando o que estiver dentro de campos entre aspas duplas.
 */
function detectDelimiter(text) {
  const sample = text.slice(0, 20000);
  let commas = 0;
  let semis = 0;
  let inQuotes = false;
  for (const ch of sample) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch === ',') commas++;
    else if (!inQuotes && ch === ';') semis++;
  }
  return semis > commas ? ';' : ',';
}

/** Remove aspas simples que envolvem o campo inteiro (estilo ITAÚ: 'BANCO ITAU SA'). */
function stripWrappingQuotes(field) {
  if (field.length >= 2 && field[0] === "'" && field[field.length - 1] === "'") {
    return field.slice(1, -1).trim();
  }
  return field;
}

/** Divide uma linha CSV respeitando aspas duplas (com escape "") e o separador dado. */
function parseCsvLine(line, delimiter = ',') {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields.map((f) => stripWrappingQuotes(f.trim()));
}

/**
 * Alguns SCRTs vêm "duplo-codificados": a linha inteira foi empacotada como um
 * único campo CSV, com as aspas internas dobradas
 *   `"Customer Name,""BANCO DO BRASIL"""`  em vez de  `"Customer Name","BANCO DO BRASIL"`
 * (comum quando o relatório passa por Excel/exportadores). Detecta a assinatura
 * (um só campo, contendo o separador e aspas) e re-interpreta o conteúdo como CSV.
 */
function normalizeRow(fields, delimiter = ',') {
  if (fields.length === 1 && fields[0].includes(delimiter) && fields[0].includes('"')) {
    const reparsed = parseCsvLine(fields[0], delimiter);
    if (reparsed.length > 1) return reparsed;
  }
  return fields;
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/[",'\s]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function normalizeKey(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** "2 Jun, 2026 - 1 Jul, 2026 inclusive (30 days)" -> { start, end, days } */
function parseReportingPeriod(text) {
  const dateRe = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})/g;
  const dates = [];
  let m;
  while ((m = dateRe.exec(text)) !== null) {
    const month = EN_MONTHS[m[2].toLowerCase()];
    if (month === undefined) continue;
    dates.push(new Date(Date.UTC(Number(m[3]), month, Number(m[1]))));
  }
  if (dates.length < 2) return null;
  const daysMatch = /\((\d+)\s*days?\)/i.exec(text);
  return {
    start: dates[0],
    end: dates[1],
    days: daysMatch ? Number(daysMatch[1]) : null,
  };
}

/** Nome do marcador de seção: '==N7======' -> 'N7'; null se a linha não for marcador. */
function sectionMarker(row) {
  if (!row[0] || !row[0].startsWith('==')) return null;
  return row[0].replace(/^=+/, '').replace(/=+$/, '').trim().split(/\s/)[0] || null;
}

/**
 * Extrai as seções por LPAR do SCRT:
 *   ==N5  DETAIL LPAR DATA SECTION       -> picos de 4HRA (maior / 2ª maior) por LPAR
 *   ==N7  DETAIL LPAR USAGE DATA SECTION -> Total MSU Consumed + pico horário por LPAR
 * Os pares N5/N7 aparecem uma vez por máquina, NA ORDEM das máquinas da seção B5
 * (no Enterprise TFP ficam agrupados no fim do arquivo, sem marcador ==M<id>).
 * A i-ésima ocorrência de cada seção pertence à i-ésima máquina; a linha "CPC" da N7
 * (total da máquina) é retornada em cpcChecks para validar essa associação.
 */
function parseLparSections(rows, machineIds) {
  const byKey = new Map(); // machine|lpar -> registro combinado N5+N7
  let currentSection = null;
  let currentMachine = null;
  let n5Seen = 0;
  let n7Seen = 0;
  const cpcChecks = []; // { machine, totalMsu } vindos da linha CPC da N7

  const entry = (machine, name) => {
    const key = `${machine}|${name}`;
    if (!byKey.has(key)) byKey.set(key, { name, machine });
    return byKey.get(key);
  };

  for (const row of rows) {
    const marker = sectionMarker(row);
    if (marker) {
      if (marker === 'N5') {
        currentSection = 'N5';
        currentMachine = machineIds[n5Seen] !== undefined ? machineIds[n5Seen] : null;
        n5Seen++;
      } else if (marker === 'N7') {
        currentSection = 'N7';
        currentMachine = machineIds[n7Seen] !== undefined ? machineIds[n7Seen] : null;
        n7Seen++;
      } else {
        currentSection = null;
        currentMachine = null;
      }
      continue;
    }
    if (!currentSection || !currentMachine || !row[0]) continue;
    if (row[0] === 'CPC') {
      if (currentSection === 'N7') {
        cpcChecks.push({ machine: currentMachine, totalMsu: toNumber(row[1]) });
      }
      continue;
    }
    // Linhas de dados: nome da LPAR + valor numérico. Ignora títulos e cabeçalhos.
    if (toNumber(row[1]) === null) continue;

    if (currentSection === 'N7') {
      const e = entry(currentMachine, row[0]);
      e.msuConsumed = toNumber(row[1]);
      e.peakHourMsu = toNumber(row[2]);
      e.peakHourAt = row[3] || null;
      e.os = row[4] || null;
    } else {
      const e = entry(currentMachine, row[0]);
      e.peak4hraMsu = toNumber(row[1]);
      e.peak4hraAt = row[3] || null;
      e.secondPeak4hraMsu = toNumber(row[5]);
      e.secondPeak4hraAt = row[7] || null;
    }
  }
  return { lpars: Array.from(byKey.values()), cpcChecks };
}

/**
 * Faz o parse do buffer de um arquivo SCRT CSV.
 * @returns {object} dados estruturados do relatório
 * @throws {Error} se o arquivo não for reconhecido como SCRT
 */
function parseScrt(buffer) {
  const text = decodeBuffer(buffer);
  const delimiter = detectDelimiter(text);
  const rawLines = text.split(/\r\n|\r|\n/);
  const rows = rawLines.map((line) => normalizeRow(parseCsvLine(line, delimiter), delimiter));

  const looksLikeScrt = rows.some(
    (r) => r[0] && (r[0].includes('SCRT') || normalizeKey(r[0]) === 'customer name')
  );
  if (!looksLikeScrt) {
    throw new Error('Arquivo não reconhecido como relatório SCRT (cabeçalho ausente).');
  }

  // A seção ==B5 (sumário do Multiplex) vai do banner até o próximo marcador (==M...).
  // O banner pode não estar na linha 0 (linha em branco inicial, prefixo "sep=," do Excel etc.).
  const bannerIdx = rows.findIndex((r) => r[0] && r[0].startsWith('=='));
  let b5End = rows.length;
  for (let i = (bannerIdx === -1 ? 0 : bannerIdx) + 1; i < rows.length; i++) {
    if (rows[i][0] && rows[i][0].startsWith('==')) { b5End = i; break; }
  }
  const b5 = rows.slice(0, b5End);

  const warnings = [];
  const header = {};
  const headerKeys = {
    'scrt tool release': 'scrtToolRelease',
    'tool release': 'scrtToolRelease', // nome usado no relatório Sub-Capacity/MVM
    'customer name': 'customerName',
    'run date/time': 'runDateTime',
    'reporting period': 'reportingPeriodText',
    'number of processors in multiplex': 'processorsInMultiplex',
    'name of person submitting report:': 'submitterName',
    'e-mail address of report submitter:': 'submitterEmail',
    'phone number of report submitter:': 'submitterPhone',
  };
  for (const row of b5) {
    const mapped = headerKeys[normalizeKey(row[0])];
    if (mapped && row.length > 1 && header[mapped] === undefined) {
      header[mapped] = row[1];
    }
  }
  // Relatórios Sub-Capacity/MVM trazem "Reporting Period" e "Tool Release" na seção
  // ==C5 (TOOL INFORMATION), fora da B5 — procura no arquivo inteiro o que faltou.
  for (const row of rows) {
    const mapped = headerKeys[normalizeKey(row[0])];
    if (mapped && row.length > 1 && header[mapped] === undefined) {
      header[mapped] = row[1];
    }
  }
  if (!header.customerName) {
    throw new Error('Arquivo SCRT sem "Customer Name" na seção de sumário.');
  }

  const period = header.reportingPeriodText ? parseReportingPeriod(header.reportingPeriodText) : null;
  if (!period) {
    throw new Error('Não foi possível interpretar o "Reporting Period" do SCRT.');
  }
  const periodKey = `${period.start.getUTCFullYear()}-${String(period.start.getUTCMonth() + 1).padStart(2, '0')}`;
  const periodLabel = `${PT_MONTH_ABBR[period.start.getUTCMonth()]}/${period.start.getUTCFullYear()}`;

  // ── Máquinas da seção B5 ──────────────────────────────────────────────────
  // Enterprise TFP: matriz com uma coluna por máquina do Multiplex.
  // Sub-Capacity/MVM: máquina única, com os campos em linhas "chave,valor".
  const idRowIdx = b5.findIndex(
    (r) => normalizeKey(r[0]) === 'machine identifier' && r.slice(1).some((f) => f !== '')
  );
  const machineAttrKeys = {
    'customer number': 'customerNumber',
    'machine serial number': 'serialNumber',
    'machine type and model': 'typeModel',
    'machine rated capacity (msus)': 'ratedCapacityMsus',
    'machine peak utilization': 'peakUtilizationMsus',
    'machine msu consumed': 'msuConsumed',
    'machine model changed': 'modelChanged',
    'exclude data': 'excludeData',
    'missing lpar data': 'missingLparData',
    'missing cpc data': 'missingCpcData',
  };
  const numericAttrs = new Set(['ratedCapacityMsus', 'peakUtilizationMsus', 'msuConsumed']);

  let machines;
  let machineIds;
  let valueStart = -1;

  if (idRowIdx !== -1) {
    // Formato matriz (Enterprise TFP): uma coluna por máquina.
    const idRow = b5[idRowIdx];
    for (let i = 1; i < idRow.length; i++) {
      if (idRow[i] !== '') { valueStart = i; break; }
    }
    machineIds = idRow.slice(valueStart).filter((f) => f !== '');
    machines = machineIds.map((id) => ({ identifier: id }));
    for (let i = idRowIdx + 1; i < b5.length; i++) {
      const row = b5[i];
      if (!row[0]) {
        if (row.every((f) => f === '')) break;
        continue;
      }
      const attr = machineAttrKeys[normalizeKey(row[0])];
      if (!attr) break;
      const values = row.slice(valueStart);
      machines.forEach((machine, idx) => {
        const raw = values[idx] !== undefined ? values[idx] : '';
        machine[attr] = numericAttrs.has(attr) ? toNumber(raw) : raw;
      });
    }
  } else {
    // Formato de máquina única (Sub-Capacity/MVM): campos planos "chave,valor".
    const machine = {};
    for (const row of b5) {
      const attr = machineAttrKeys[normalizeKey(row[0])];
      if (attr && row.length > 1 && machine[attr] === undefined) {
        machine[attr] = numericAttrs.has(attr) ? toNumber(row[1]) : row[1];
      }
    }
    if (machine.msuConsumed === undefined) {
      throw new Error('Seção de máquinas não encontrada no SCRT (nem matriz "Machine identifier", nem máquina única).');
    }
    machine.identifier = machine.serialNumber || 'CPC';
    machines = [machine];
    machineIds = [machine.identifier];
  }

  const missingMsu = machines.filter((m) => m.msuConsumed === null || m.msuConsumed === undefined);
  if (missingMsu.length === machines.length) {
    throw new Error('Linha "Machine MSU Consumed" não encontrada na seção B5 do SCRT.');
  }
  if (missingMsu.length > 0) {
    warnings.push(
      `Máquina(s) sem valor de MSU Consumed: ${missingMsu.map((m) => m.identifier).join(', ')}`
    );
  }

  // Consumo mensal = soma de "Machine MSU Consumed" (regra do sistema).
  const totalMsuConsumed = machines.reduce((acc, m) => acc + (m.msuConsumed || 0), 0);

  // ── Containers (linha "Container Identifier" na B5) ───────────────────────
  const containers = [];
  const containerHeaderIdx = b5.findIndex((r) => normalizeKey(r[0]) === 'container identifier');
  if (containerHeaderIdx !== -1) {
    for (let i = containerHeaderIdx + 1; i < b5.length; i++) {
      const row = b5[i];
      if (!row[0] || row[0].startsWith('==')) break;
      const perMachine = valueStart >= 0 ? row.slice(valueStart).map(toNumber) : [];
      containers.push({
        identifier: row[0],
        name: row[1] || '',
        totalMsu: toNumber(row[2]),
        perMachineMsu: perMachine.slice(0, machines.length),
      });
    }
  }
  const containersTotalMsu = containers.reduce((acc, c) => acc + (c.totalMsu || 0), 0);
  if (containers.length > 0 && containersTotalMsu !== totalMsuConsumed) {
    warnings.push(
      `Soma de "Machine MSU Consumed" (${totalMsuConsumed.toLocaleString('pt-BR')}) difere do total dos containers ` +
      `(${containersTotalMsu.toLocaleString('pt-BR')}). O sistema usa a soma das máquinas como consumo mensal.`
    );
  }

  // ── LPARs (seções ==N5 e ==N7, uma ocorrência por máquina) ────────────────
  const { lpars, cpcChecks } = parseLparSections(rows, machineIds);
  for (const check of cpcChecks) {
    const machine = machines.find((m) => m.identifier === check.machine);
    if (machine && machine.msuConsumed != null && check.totalMsu != null && check.totalMsu !== machine.msuConsumed) {
      warnings.push(
        `Total CPC da seção N7 associada à máquina ${check.machine} (${check.totalMsu.toLocaleString('pt-BR')}) ` +
        `difere do "Machine MSU Consumed" (${machine.msuConsumed.toLocaleString('pt-BR')}) — confira a ordem das seções.`
      );
    }
  }
  for (const m of machines) {
    const mLpars = lpars.filter((l) => l.machine === m.identifier && l.msuConsumed != null);
    if (mLpars.length > 0 && m.msuConsumed != null) {
      const sum = mLpars.reduce((a, l) => a + l.msuConsumed, 0);
      if (sum !== m.msuConsumed) {
        warnings.push(
          `Soma das LPARs (N7) da máquina ${m.identifier} (${sum.toLocaleString('pt-BR')}) difere do ` +
          `"Machine MSU Consumed" da máquina (${m.msuConsumed.toLocaleString('pt-BR')}).`
        );
      }
    }
  }

  return {
    customerName: header.customerName,
    scrtToolRelease: header.scrtToolRelease || null,
    runDateTime: header.runDateTime || null,
    submitter: {
      name: header.submitterName || null,
      email: header.submitterEmail || null,
      phone: header.submitterPhone || null,
    },
    reportingPeriod: {
      text: header.reportingPeriodText,
      start: period.start,
      end: period.end,
      days: period.days,
    },
    periodKey,
    periodLabel,
    processorsInMultiplex: toNumber(header.processorsInMultiplex),
    machines,
    containers,
    lpars,
    totalMsuConsumed,
    containersTotalMsu: containers.length > 0 ? containersTotalMsu : null,
    warnings,
  };
}

/**
 * Combina vários relatórios do MESMO mês/cliente num único multiplex.
 * Usado quando um SCRT vem como planilha .xlsx com uma aba por máquina —
 * cada aba é um relatório de máquina única que, juntos, formam o multiplex.
 * @param {Array} list resultados de parseScrt (um por aba)
 * @returns {object} um relatório com todas as máquinas, LPARs e containers
 */
function combineReports(list) {
  if (!list.length) throw new Error('Nada para combinar.');
  if (list.length === 1) return list[0];

  const first = list[0];
  const divergente = list.find((p) => p.periodKey !== first.periodKey);
  if (divergente) {
    throw new Error(`As abas têm períodos diferentes (${first.periodLabel} e ${divergente.periodLabel}).`);
  }

  const machines = [];
  const lpars = [];
  const containers = [];
  const warnings = [];
  let totalMsuConsumed = 0;
  let containersTotalMsu = 0;
  let hasContainers = false;
  let processorsInMultiplex = 0;

  for (const p of list) {
    machines.push(...p.machines);
    lpars.push(...p.lpars);
    containers.push(...p.containers);
    warnings.push(...p.warnings);
    totalMsuConsumed += p.totalMsuConsumed;
    if (p.containersTotalMsu != null) { hasContainers = true; containersTotalMsu += p.containersTotalMsu; }
    processorsInMultiplex += p.processorsInMultiplex || 0;
  }

  return {
    ...first,
    processorsInMultiplex: processorsInMultiplex || first.processorsInMultiplex,
    machines,
    lpars,
    containers,
    totalMsuConsumed,
    containersTotalMsu: hasContainers ? containersTotalMsu : null,
    warnings,
  };
}

module.exports = { parseScrt, parseCsvLine, parseReportingPeriod, decodeBuffer, parseLparSections, combineReports };
