'use strict';

const mongoose = require('mongoose');

// Agrupamento de LPARs definido pelo usuário (ex.: "Produção" = P0, P4, PC…).
// Uma LPAR pertence a no máximo um grupo; a visão agrupada soma o consumo dos membros.
const lparGroupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    lpars: [String],
  },
  { _id: false }
);

// Encargo mensal fixo do contrato MLC (ex.: "Dev/Test", "Produtos Flat").
// A lista é livre — cada cliente monta os seus conforme o contrato assinado.
const mlcEncargoSchema = new mongoose.Schema(
  {
    nome: { type: String, required: true, trim: true },
    valorMensal: { type: Number, default: 0 },
  },
  { _id: false }
);

// Um ano do contrato MLC. Os parâmetros podem mudar de um ano para o outro.
const mlcYearSchema = new mongoose.Schema(
  {
    label: { type: String, default: '' }, // "Ano 1"; vazio => gerado na visão
    baselineAnnualMsu: { type: Number, default: 0 },
    valorPorMsu: { type: Number, default: 0 }, // R$ por MSU do baseline
    encargoCrescimentoPorMsu: { type: Number, default: 0 }, // R$ por MSU acima do baseline
    cbaPct: { type: Number, default: 0 }, // desconto CBA (0.19 = 19%)
    encargos: { type: [mlcEncargoSchema], default: [] },
  },
  { _id: false }
);

// Contrato MLC do cliente. O consumo mensal NÃO fica aqui: vem do SCRT.
const mlcContractSchema = new mongoose.Schema(
  {
    startPeriodKey: { type: String, default: null }, // 1º mês do Ano 1, ex.: "2024-06"
    years: { type: [mlcYearSchema], default: [] },
  },
  { _id: false }
);

const clientSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    // Baseline mensal contratual (MSUs) — opcional; habilita as comparações no dashboard.
    monthlyBaselineMsu: { type: Number, default: null },
    // Mês de início do ano contratual (AAAA-MM). Ex.: "2024-06" => Ano 1 vai de
    // jun/24 a mai/25, Ano 2 de jun/25 a mai/26, etc. Habilita a visão "Por Ano
    // Contratual" no dashboard. Se vazio, o MLC (mlcContract.startPeriodKey) serve de base.
    contractYearStart: { type: String, default: null },
    lparGroups: { type: [lparGroupSchema], default: [] },
    // Contrato MLC (Monthly License Charge) — parâmetros por ano; consumo vem do SCRT.
    mlcContract: { type: mlcContractSchema, default: null },
    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

const machineSchema = new mongoose.Schema(
  {
    identifier: String,
    customerNumber: String,
    serialNumber: String,
    typeModel: String,
    ratedCapacityMsus: Number,
    peakUtilizationMsus: Number,
    msuConsumed: Number,
    modelChanged: String,
    excludeData: String,
    missingLparData: String,
    missingCpcData: String,
  },
  { _id: false }
);

const containerSchema = new mongoose.Schema(
  {
    identifier: String,
    name: String,
    totalMsu: Number,
    perMachineMsu: [Number],
  },
  { _id: false }
);

// Dados por LPAR: uso (seção ==N7) + picos de 4HRA (seção ==N5) do SCRT.
const lparSchema = new mongoose.Schema(
  {
    name: String,
    machine: String,
    os: String,
    msuConsumed: Number, // N7: Total MSU Consumed
    peakHourMsu: Number, // N7: Peak Hour Consumption
    peakHourAt: String,
    peak4hraMsu: Number, // N5: Highest
    peak4hraAt: String,
    secondPeak4hraMsu: Number, // N5: 2nd Highest
    secondPeak4hraAt: String,
  },
  { _id: false }
);

const scrtReportSchema = new mongoose.Schema(
  {
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    periodKey: { type: String, required: true }, // "2026-06"
    periodLabel: { type: String, required: true }, // "Jun/2026"
    periodStart: Date,
    periodEnd: Date,
    periodDays: Number,
    customerName: String,
    scrtToolRelease: String,
    runDateTime: String,
    submitter: { name: String, email: String, phone: String },
    processorsInMultiplex: Number,
    machines: [machineSchema],
    containers: [containerSchema],
    lpars: [lparSchema],
    // Consumo mensal oficial do sistema: soma de "Machine MSU Consumed".
    totalMsuConsumed: { type: Number, required: true },
    containersTotalMsu: Number,
    warnings: [String],
    sourceFileName: String,
    // Identidade física do relatório: seriais das máquinas, ordenados.
    // Dois SCRTs do mesmo mês com máquinas diferentes (ex.: sites SCN e SIG)
    // convivem e são somados; reenviar o mesmo conjunto substitui o anterior.
    sourceKey: { type: String, required: true },
    siteLabel: String, // rótulo amigável da origem (ex.: "SIG"), derivado do arquivo
  },
  { timestamps: true }
);

// Um relatório por cliente/mês/origem — o mês é a soma das origens.
scrtReportSchema.index({ client: 1, periodKey: 1, sourceKey: 1 }, { unique: true });

/**
 * Inventário de software zSystems (relatório IBM SW Material) por cliente.
 * O parse acontece no navegador (app de inventário) e o resultado é persistido aqui;
 * `products` é Mixed de propósito, para acompanhar a evolução do parser sem migração.
 */
/**
 * Ajuste manual do par Licença ↔ S&S, quando o casamento automático erra.
 * O par é registro a registro (um PID de S&S costuma ter dezenas, um por
 * bump/renovação), e o registro é identificado por PID + SW Serial — o
 * serial sozinho não serve, pois se repete entre PIDs diferentes.
 * `licPid`/`licSerial` nulos significam "este S&S não casa com nenhuma licença".
 */
const pairOverrideSchema = new mongoose.Schema(
  {
    ssPid: { type: String, required: true },
    ssSerial: { type: String, required: true },
    licPid: { type: String, default: null },
    licSerial: { type: String, default: null },
  },
  { _id: false }
);

const inventorySchema = new mongoose.Schema(
  {
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true, unique: true },
    customerNumber: String, // número do cliente no relatório IBM
    clientName: String, // nome como veio no relatório
    products: { type: [mongoose.Schema.Types.Mixed], default: [] },
    productCount: Number,
    sourceFileName: String,
    reportUpdatedAt: String, // data/hora exibida pelo app (string já formatada)
    warnings: [String],
    pairOverrides: { type: [pairOverrideSchema], default: [] },
  },
  { timestamps: true }
);

const Client = mongoose.model('Client', clientSchema);
const ScrtReport = mongoose.model('ScrtReport', scrtReportSchema);
const Inventory = mongoose.model('Inventory', inventorySchema);

module.exports = { Client, ScrtReport, Inventory };
