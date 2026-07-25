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

// Catálogo de tags de máquina (ex.: "Produção", "DW", "Dev/Test").
// `ignored` marca as tags cujo consumo NÃO conta (dev/test por padrão).
const machineTagDefSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    ignored: { type: Boolean, default: false },
  },
  { _id: false }
);

// Atribuição de uma tag a uma máquina, pelo serial (vale para todos os meses).
const machineTagSchema = new mongoose.Schema(
  {
    serial: { type: String, required: true },
    tag: { type: String, required: true },
  },
  { _id: false }
);

const clientSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    // Tags de máquina: catálogo (nome + se é ignorada) e atribuição por serial.
    // Máquina de tag ignorada tem o consumo de MSU excluído do faturável.
    machineTagDefs: { type: [machineTagDefSchema], default: [] },
    machineTags: { type: [machineTagSchema], default: [] },
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
    // Arquivo SCRT original (guardado em disco, data/scrt-files/<_id>) para
    // download/pré-visualização. Ausente nos relatórios subidos antes disto.
    rawFile: {
      type: new mongoose.Schema(
        { name: String, size: Number, contentType: String },
        { _id: false }
      ),
      default: null,
    },
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

/* ── Infraestrutura (parque físico IBM Z / LinuxONE) ─────────────────────────
 * Inventário físico por cliente: Site -> Máquina -> LPAR. Distinto das máquinas
 * do SCRT (subdoc de ScrtReport); aqui é o cadastro do hardware. A ligação com
 * o SCRT é pelo serial (normalizado em maiúsculas). Sem foto e sem catálogo.
 */
const infraSiteSchema = new mongoose.Schema(
  {
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    name: { type: String, required: true, trim: true },
    location: { type: String, default: '' },
    role: { type: String, enum: ['prod', 'dr', 'ha', 'dev', 'test', 'colo'], default: 'prod' },
    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

const infraMachineSchema = new mongoose.Schema(
  {
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    site: { type: mongoose.Schema.Types.ObjectId, ref: 'InfraSite', default: null },
    model: { type: String, default: '' }, // ex.: "LinuxONE Emperor 5", "IBM z17"
    variant: { type: String, default: '' },
    featureModel: { type: String, default: '' }, // capacidade física (ex.: "Max32")
    lsprModel: { type: String, default: '' }, // liga com LsprModel.model (ex.: "3931-705")
    serial: { type: String, default: '', index: true }, // normalizado em maiúsculas
    year: { type: Number, default: null },
    iflsActive: { type: Number, default: 0 },
    iflsSpare: { type: Number, default: 0 },
    storageTB: { type: Number, default: 0 },
    storageAddTB: { type: Number, default: 0 },
    dormant: { type: Boolean, default: false },
    notes: { type: String, default: '' },
    // Arquivos de configuração (texto), guardados inline (excluídos da listagem).
    configTxtName: { type: String, default: '' },
    configTxtContent: { type: String, default: '' },
    configCfrName: { type: String, default: '' },
    configCfrContent: { type: String, default: '' },
  },
  { timestamps: true }
);

const infraNetworkCardSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['OSA', 'RoCE', 'NetworkExpress', 'HiperSockets', 'Other'], default: 'OSA' },
    label: { type: String, default: '' }, // CHPID/porta/identificação
  },
  { _id: false }
);

const infraLparSchema = new mongoose.Schema(
  {
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    machine: { type: mongoose.Schema.Types.ObjectId, ref: 'InfraMachine', required: true, index: true },
    name: { type: String, required: true, trim: true },
    os: { type: String, enum: ['linux', 'zos', 'zvm', 'kvm', 'other'], default: 'linux' },
    osDistro: { type: String, default: '' }, // "RHEL 10.2", "z/OS 3.1"
    ifls: { type: Number, default: 0 },
    cps: { type: Number, default: 0 }, // CPs/zIIPs (vCPUs)
    memoryGB: { type: Number, default: 0 },
    description: { type: String, default: '' },
    devices: { type: [String], default: [] },
    wwpns: { type: [String], default: [] },
    ips: { type: [String], default: [] },
    networkCards: { type: [infraNetworkCardSchema], default: [] },
    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

/* ── Usuários e acesso ───────────────────────────────────────────────────────
 * Login por e-mail + senha (scrypt). Cada usuário tem acesso a clientes
 * específicos, com nível 'view' (só ver) ou 'edit' (ver e editar). Admin vê e
 * edita tudo. O primeiro usuário é criado no setup inicial; depois, só o admin.
 */
const userAccessSchema = new mongoose.Schema(
  {
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
    level: { type: String, enum: ['view', 'edit'], default: 'view' },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    passwordSalt: { type: String, required: true },
    role: { type: String, enum: ['admin', 'user'], default: 'user' },
    access: { type: [userAccessSchema], default: [] },
  },
  { timestamps: true }
);

// ── LSPR: referência de capacidade por modelo IBM Z (zPCR Configuration Summary) ──
// Dados públicos da IBM (MIPS/MSU/#CPs máximos por modelo), não são de cliente.
// A chave é o type-model (ex.: "3931-705"), igual ao "Machine Type and Model" do SCRT.
const lsprModelSchema = new mongoose.Schema(
  {
    model: { type: String, required: true, unique: true, index: true }, // "3931-705"
    machineType: { type: String, default: '', index: true },            // "3931"
    generation: { type: String, default: '', index: true },             // "z16"
    family: { type: String, default: '' },                              // "IBM Z z16/700"
    mips: { type: Number, default: null },
    msu: { type: Number, default: null },
    partitions: { type: Number, default: null },
    cps: { type: Number, default: null },
    ifls: { type: Number, default: null },
    icfs: { type: Number, default: null },
    zaaps: { type: Number, default: null },
    ziips: { type: Number, default: null },
    source: { type: String, default: '' },
  },
  { timestamps: true }
);

const Client = mongoose.model('Client', clientSchema);
const ScrtReport = mongoose.model('ScrtReport', scrtReportSchema);
const Inventory = mongoose.model('Inventory', inventorySchema);
const InfraSite = mongoose.model('InfraSite', infraSiteSchema);
const InfraMachine = mongoose.model('InfraMachine', infraMachineSchema);
const InfraLpar = mongoose.model('InfraLpar', infraLparSchema);
const User = mongoose.model('User', userSchema);
const LsprModel = mongoose.model('LsprModel', lsprModelSchema);

module.exports = { Client, ScrtReport, Inventory, InfraSite, InfraMachine, InfraLpar, User, LsprModel };
