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
    cps: { type: Number, default: 0 },        // CPs / GPs (processadores de propósito geral)
    ziips: { type: Number, default: 0 },      // zIIPs
    iflsActive: { type: Number, default: 0 }, // IFLs ativos
    iflsSpare: { type: Number, default: 0 },  // IFLs spare
    icfs: { type: Number, default: 0 },       // ICFs (Coupling Facility / CF)
    memoryTB: { type: Number, default: 0 },       // memória (antigo storageTB)
    memoryAddTB: { type: Number, default: 0 },    // memória adicional (antigo storageAddTB)
    // Situação da máquina no parque (substituiu o antigo booleano `dormant`):
    // ativa · dormente (ligada, fora de produção) · substituida (saiu num MO) · desativada
    status: { type: String, enum: ['ativa', 'dormente', 'substituida', 'desativada'], default: 'ativa', index: true },
    // Contrato vigente da máquina. O histórico de contratos anteriores fica nos
    // eventos de MO/MES, que carregam o contrato de cada mudança.
    contract: { type: mongoose.Schema.Types.ObjectId, ref: 'Contract', default: null, index: true },
    replacedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'InfraMachine', default: null }, // MO: para quem foi
    replaces: { type: mongoose.Schema.Types.ObjectId, ref: 'InfraMachine', default: null },   // MO: quem ela substituiu
    replacedAt: { type: Date, default: null },
    installedAt: { type: Date, default: null },
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

/* ──────────────────────────────────────────────────────────────────────────
   Contratos — o elo entre o parque físico e o software licenciado.

   Direção dos ponteiros: a máquina aponta para o contrato (InfraMachine.contract)
   e o evento de MO/MES também (MigrationEvent.contract). O contrato só guarda o
   vínculo de SOFTWARE, porque um registro de software não é documento — é um item
   de Inventory.products (Mixed), apagado por inteiro a cada re-upload. Guardar o
   vínculo aqui é a única forma de ele sobreviver à recarga do inventário.
   ────────────────────────────────────────────────────────────────────────── */

// Arquivos do contrato (PDF assinado, aditivos). COM _id: o _id nomeia o arquivo em disco.
const contractFileSchema = new mongoose.Schema(
  {
    name: { type: String, default: '' },
    size: { type: Number, default: 0 },
    contentType: { type: String, default: 'application/octet-stream' },
    kind: { type: String, enum: ['contrato', 'aditivo', 'proposta', 'anexo'], default: 'contrato' },
    uploadedAt: { type: Date, default: Date.now },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: false }
);

/*
 * Vínculo de um registro de software ao contrato. A identidade é productId +
 * swSerial (o swSerial sozinho se repete entre PIDs). Os campos de descrição são
 * SNAPSHOT do inventário no momento do vínculo: sem eles, um re-upload deixaria o
 * contrato exibindo PIDs sem nome.
 */
const contractSoftwareSchema = new mongoose.Schema(
  {
    productId: { type: String, required: true, trim: true },
    swSerial: { type: String, required: true, trim: true },
    category: { type: String, default: '' },    // 'SS' | 'LICENCE'
    description: { type: String, default: '' },
    effDate: { type: String, default: '' },
    poNumber: { type: String, default: '' },
    notes: { type: String, default: '' },
    linkedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const contractSchema = new mongoose.Schema(
  {
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    number: { type: String, required: true, trim: true }, // identificação do contrato
    name: { type: String, default: '' },                  // apelido: "MO z16 → z17 SCN 2026"
    type: { type: String, enum: ['hardware', 'software', 'servicos', 'misto'], default: 'misto' },
    vendor: { type: String, default: 'IBM' },
    status: { type: String, enum: ['rascunho', 'vigente', 'encerrado', 'cancelado'], default: 'vigente' },
    signedAt: { type: Date, default: null },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    currency: { type: String, enum: ['BRL', 'USD', 'EUR'], default: 'BRL' },
    totalValue: { type: Number, default: null },
    monthlyValue: { type: Number, default: null },
    poNumber: { type: String, default: '' },
    owner: { type: String, default: '' },
    notes: { type: String, default: '' },
    software: { type: [contractSoftwareSchema], default: [] },
    files: { type: [contractFileSchema], default: [] },
  },
  { timestamps: true }
);
contractSchema.index({ client: 1, number: 1 }, { unique: true });
contractSchema.index({ client: 1, status: 1 });

/*
 * MO/MES — atualização tecnológica do parque.
 *   MO  (Migration Offering): troca de máquina — sai a velha, entra uma nova.
 *   MES: mantém a máquina e faz upgrade lógico (memória, capacidade).
 * Um schema só, discriminado por `kind`: a máquina de estados é idêntica.
 */
const machineConfigSchema = new mongoose.Schema(
  {
    model: { type: String, default: '' },
    variant: { type: String, default: '' },
    featureModel: { type: String, default: '' },
    lsprModel: { type: String, default: '' },
    serial: { type: String, default: '' },
    cps: { type: Number, default: 0 },
    ziips: { type: Number, default: 0 },
    iflsActive: { type: Number, default: 0 },
    iflsSpare: { type: Number, default: 0 },
    icfs: { type: Number, default: 0 },
    memoryTB: { type: Number, default: 0 },
    memoryAddTB: { type: Number, default: 0 },
    // LSPR congelado: a tabela de referência é reimportável, o delta tem de ficar estável.
    msu: { type: Number, default: null },
    mips: { type: Number, default: null },
  },
  { _id: false }
);

const migrationHistorySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    from: { type: String, default: '' },
    to: { type: String, default: '' },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    note: { type: String, default: '' },
  },
  { _id: false }
);

const migrationEventSchema = new mongoose.Schema(
  {
    client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true, index: true },
    kind: { type: String, enum: ['MO', 'MES'], required: true },
    status: { type: String, enum: ['proposta', 'contratado', 'executado', 'cancelada'], default: 'proposta', index: true },
    title: { type: String, default: '' },
    contract: { type: mongoose.Schema.Types.ObjectId, ref: 'Contract', default: null, index: true },
    proposalRef: { type: String, default: '' },
    notes: { type: String, default: '' },
    fromMachine: { type: mongoose.Schema.Types.ObjectId, ref: 'InfraMachine', required: true, index: true }, // MES: a própria · MO: a que sai
    toMachine: { type: mongoose.Schema.Types.ObjectId, ref: 'InfraMachine', default: null },                 // MO: a que entra
    // `before` é a foto no momento da PROPOSTA (o que foi negociado, imutável).
    // `applied.fromMachineBefore` é a foto real no instante da EXECUÇÃO — é dela que
    // o "desfazer" restaura, porque a máquina pode ter mudado nesse meio-tempo.
    before: { type: machineConfigSchema, default: () => ({}) },
    after: { type: machineConfigSchema, default: () => ({}) },
    plannedDate: { type: Date, default: null },
    executedAt: { type: Date, default: null },
    value: { type: Number, default: null },
    currency: { type: String, enum: ['BRL', 'USD', 'EUR'], default: 'BRL' },
    history: { type: [migrationHistorySchema], default: [] },
    applied: {
      type: new mongoose.Schema(
        {
          at: { type: Date, default: Date.now },
          fromMachineBefore: { type: machineConfigSchema, default: () => ({}) },
          fromMachineStatusBefore: { type: String, default: 'ativa' },
          toMachineCreated: { type: Boolean, default: false },
          clonedLparIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
        },
        { _id: false }
      ),
      default: null,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);
migrationEventSchema.index({ client: 1, fromMachine: 1, createdAt: -1 });
migrationEventSchema.index({ client: 1, toMachine: 1 });

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
const Contract = mongoose.model('Contract', contractSchema);
const MigrationEvent = mongoose.model('MigrationEvent', migrationEventSchema);

module.exports = {
  Client, ScrtReport, Inventory, InfraSite, InfraMachine, InfraLpar, User, LsprModel,
  Contract, MigrationEvent,
};
