#!/usr/bin/env bash
#
# deploy.sh — publica o IBM Z Control Desk no servidor.
#
# RODA NO MAC. Empurra o código para o servidor por rsync sobre SSH, reinstala as
# dependências de produção lá, reinicia o serviço e SÓ TERMINA BEM se a aplicação
# de fato responder. Se não responder, despeja o journal e sai com código != 0.
#
# Modo seguro: sem --sim ele faz apenas ensaio (rsync --dry-run e diagnóstico
# somente-leitura no servidor). Nada é alterado até você passar --sim.
#
#   ./deploy/deploy.sh              # ensaio: mostra o que faria
#   ./deploy/deploy.sh --sim        # publica de verdade
#
# Pré-requisitos no servidor (feitos UMA vez, à mão — este script não os cria):
#   sudo useradd --system --home-dir /opt/zcontroldesk --shell /sbin/nologin zcd
#   sudo install -m 600 -o root -g root /dev/null /etc/zcontroldesk.env  (preencher)
#   /etc/systemd/system/zcontroldesk.service  (ver deploy/env.exemplo)
# O script confere os três e aborta com instrução clara se faltar algum.
#
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Configuração — tudo aqui pode ser sobrescrito pelo ambiente:
#   HOST=10.0.0.9 APP_DIR=/opt/teste ./deploy/deploy.sh --sim
# ─────────────────────────────────────────────────────────────────────────────

# ATENÇÃO: o caminho da chave TEM ESPAÇO. Toda expansão dele no script está entre
# aspas, inclusive dentro do -e do rsync (ver RSYNC_SSH lá embaixo).
CHAVE="${CHAVE:-/Users/hulkz/Documents/Projetos/zControlDesk BackendMarista/zDesk.pem}"

HOST="${HOST:-148.100.74.249}"        # servidor de destino (não confundir com o
                                      # HOST do server.js, que é o bind da app)
USUARIO="${USUARIO:-linux1}"          # usuário do SSH (tem sudo sem senha)
APP_DIR="${APP_DIR:-/opt/zcontroldesk}"      # onde o código vive no servidor
DADOS_DIR="${DADOS_DIR:-/var/lib/zcontroldesk}"  # dados que NÃO podem ir junto no
                                                 # --delete: SCRTs, contratos, logs

DONO="${DONO:-zcd}"                              # usuário de sistema que roda a app
SERVICO="${SERVICO:-zcontroldesk}"               # unit do systemd
ENV_FILE="${ENV_FILE:-/etc/zcontroldesk.env}"    # EnvironmentFile (contém a senha
                                                 # do Mongo — nunca é impresso)
PORTA="${PORTA:-}"                # vazio = lê o PORT= do ENV_FILE no servidor
ROTA_SAUDE="${ROTA_SAUDE:-/api/auth/status}"   # rota pública que já toca o banco
TENTATIVAS="${TENTATIVAS:-30}"    # segundos de espera pela app subir

# O rsync do sistema no macOS moderno é openrsync, que NÃO tem --chown nem
# --rsync-path. Use o do Homebrew.
RSYNC="${RSYNC:-/opt/homebrew/bin/rsync}"

# Raiz do projeto = pasta acima desta (deploy/).
RAIZ="${RAIZ:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# ─────────────────────────────────────────────────────────────────────────────
# Argumentos
# ─────────────────────────────────────────────────────────────────────────────
VALENDO=0
PERMITE_SUJO=0
PULAR_NPM=0

for arg in "$@"; do
  case "$arg" in
    --sim)        VALENDO=1 ;;
    --sujo)       PERMITE_SUJO=1 ;;   # deixa publicar com árvore git suja
    --pular-npm)  PULAR_NPM=1 ;;      # só código mudou, package-lock não
    -h|--ajuda|--help)
      # imprime o cabeçalho de comentários deste arquivo (linhas 2..19)
      sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      printf '\nOutras opções: --sujo (publica com árvore git suja), --pular-npm\n'
      printf 'Variáveis: CHAVE HOST USUARIO APP_DIR DADOS_DIR DONO SERVICO ENV_FILE PORTA RSYNC\n\n'
      exit 0 ;;
    *)
      echo "Opção desconhecida: $arg  (use --ajuda)" >&2; exit 2 ;;
  esac
done

# ─────────────────────────────────────────────────────────────────────────────
# Saída
# ─────────────────────────────────────────────────────────────────────────────
if [ -t 1 ]; then A="\033[1m"; V="\033[32m"; Y="\033[33m"; R="\033[31m"; Z="\033[0m"
else A=""; V=""; Y=""; R=""; Z=""; fi

passo() { printf "\n${A}▸ %s${Z}\n" "$*"; }
ok()    { printf "  ${V}✓${Z} %s\n" "$*"; }
aviso() { printf "  ${Y}!${Z} %s\n" "$*"; }
erro()  { printf "\n${R}✗ %s${Z}\n\n" "$*" >&2; exit 1; }

# ─────────────────────────────────────────────────────────────────────────────
# 1. Verificações locais
# ─────────────────────────────────────────────────────────────────────────────
passo "Verificações locais"

[ -r "$CHAVE" ] || erro "Chave SSH não encontrada ou sem permissão de leitura:
  $CHAVE
  Ajuste a variável CHAVE ou o caminho do arquivo."

# O ssh recusa chave legível por grupo/outros. stat -f é a sintaxe do macOS.
MODO_CHAVE="$(stat -f '%Lp' "$CHAVE" 2>/dev/null || echo '')"
case "$MODO_CHAVE" in
  400|600) ;;
  '')      aviso "não consegui checar a permissão da chave" ;;
  *)       erro "A chave está com modo $MODO_CHAVE — o ssh vai recusar.
  Corrija com:  chmod 600 \"$CHAVE\"" ;;
esac
ok "chave SSH legível e com permissão correta"

[ -x "$RSYNC" ] || erro "rsync não encontrado em: $RSYNC
  Instale com:  brew install rsync
  (o /usr/bin/rsync do macOS é openrsync e não tem --chown/--rsync-path)"
VERSAO_RSYNC="$("$RSYNC" --version 2>&1 | head -1 || true)"
case "$VERSAO_RSYNC" in
  *openrsync*|*OpenRSYNC*)
    erro "$RSYNC é openrsync — sem --chown e --rsync-path. Use o do Homebrew (RSYNC=...)." ;;
esac
ok "rsync: ${VERSAO_RSYNC%%,*}"

[ -f "$RAIZ/server.js" ] && [ -f "$RAIZ/package-lock.json" ] \
  || erro "A raiz do projeto não parece certa: $RAIZ (sem server.js/package-lock.json)"
ok "raiz do projeto: $RAIZ"

# Procedência: o rsync manda o working tree, não um commit. Publicar com a árvore
# suja significa que ninguém consegue dizer depois o que está rodando no servidor.
if git -C "$RAIZ" rev-parse --git-dir >/dev/null 2>&1; then
  if [ -n "$(git -C "$RAIZ" status --porcelain)" ]; then
    if [ "$PERMITE_SUJO" = 1 ]; then
      aviso "árvore git SUJA — publicando assim mesmo (--sujo)"
    else
      git -C "$RAIZ" status --short | head -20
      erro "Árvore git suja. Commite (ou use --sujo, por sua conta e risco)."
    fi
  fi
  COMMIT="$(git -C "$RAIZ" rev-parse HEAD)"
  ok "commit: ${COMMIT:0:12}  ($(git -C "$RAIZ" rev-parse --abbrev-ref HEAD))"
else
  COMMIT="sem-git"
  aviso "não é um repositório git — sem rastro de versão"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 2. SSH — conectividade e diagnóstico somente-leitura do servidor
#    Roda TAMBÉM no ensaio: é o que faz o --dry-run valer alguma coisa.
# ─────────────────────────────────────────────────────────────────────────────
SSH_OPCOES=(-i "$CHAVE"
            -o BatchMode=yes            # nunca ficar pendurado pedindo senha
            -o ConnectTimeout=10
            -o StrictHostKeyChecking=accept-new)

passo "Servidor $USUARIO@$HOST"

ssh "${SSH_OPCOES[@]}" "$USUARIO@$HOST" true 2>/dev/null \
  || erro "Não consegui abrir SSH em $USUARIO@$HOST com essa chave."
ok "SSH ok"

# printf %q deixa cada valor seguro para o shell remoto (o ssh junta tudo numa
# string só e o shell de lá reinterpreta).
ARGS_REMOTOS="$(printf '%q ' "$APP_DIR" "$DADOS_DIR" "$SERVICO" "$DONO" "$ENV_FILE" "$PORTA")"

# O resultado vai para arquivo, NÃO para "$( )": o bash 3.2 que o macOS traz em
# /bin/bash tem um bug de parser com "case" dentro de substituição de comando com
# heredoc, e o script morreria com "syntax error near unexpected token `('".
DIAG_TMP="$(mktemp -t zcd-diag)"
trap 'rm -f "$DIAG_TMP"' EXIT

set +e
ssh "${SSH_OPCOES[@]}" "$USUARIO@$HOST" "bash -s -- $ARGS_REMOTOS" >"$DIAG_TMP" 2>&1 <<'REMOTO'
set -uo pipefail
APP_DIR="$1"; DADOS_DIR="$2"; SERVICO="$3"; DONO="$4"; ENV_FILE="$5"; PORTA="${6:-}"
faltou=0
diz() { printf '%s\n' "$*"; }

diz "arquitetura: $(uname -m)   kernel: $(uname -r)"
if command -v node >/dev/null 2>&1; then diz "node: $(node -v)   npm: $(npm -v)"
else diz "FALTA: node não está no PATH"; faltou=1; fi

id "$DONO" >/dev/null 2>&1 \
  && diz "usuário $DONO: existe" \
  || { diz "FALTA: usuário $DONO — sudo useradd --system --home-dir /opt/zcontroldesk --shell /sbin/nologin $DONO"; faltou=1; }

sudo test -f "$ENV_FILE" \
  && diz "EnvironmentFile: $ENV_FILE (ok)" \
  || { diz "FALTA: $ENV_FILE — copie de deploy/env.exemplo, modo 0600 root:root"; faltou=1; }

systemctl cat "$SERVICO" >/dev/null 2>&1 \
  && diz "unit systemd: $SERVICO (ok)  estado atual: $(systemctl is-active "$SERVICO" 2>/dev/null)" \
  || { diz "FALTA: unit $SERVICO em /etc/systemd/system/$SERVICO.service"; faltou=1; }

[ -d "$APP_DIR" ]   && diz "APP_DIR: $APP_DIR (existe)"   || diz "APP_DIR $APP_DIR será criado"
[ -d "$DADOS_DIR" ] && diz "DADOS_DIR: $DADOS_DIR (existe)" || diz "DADOS_DIR $DADOS_DIR será criado"

# ── A checagem mais importante deste script ──────────────────────────────────
# Os binários de SCRT e de contrato ficam em DISCO (src/routes.js:51 e :74), e o
# padrão é <app>/data/. Se esses diretórios estiverem dentro do APP_DIR, o
# "rsync --delete" do passo 3 APAGA arquivo de contrato de cliente no próximo
# deploy — silenciosamente, e o Mongo continua apontando para o que sumiu.
# Só os nomes dos caminhos são lidos; nenhuma credencial é tocada.
le_chave() { sudo grep -m1 -E "^[[:space:]]*$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '\042\047 \t\r'; }
for chave in SCRT_FILES_DIR CONTRACT_FILES_DIR; do
  valor="$(le_chave "$chave" || true)"
  case "$valor" in
    "")
      diz "FALTA: $chave não está em $ENV_FILE — a app gravaria em $APP_DIR/data,"
      diz "       que o rsync --delete deste script apaga a cada deploy."
      diz "       Defina $chave=$DADOS_DIR/... e reinicie o serviço."
      faltou=1 ;;
    "$APP_DIR"*)
      diz "FALTA: $chave=$valor está DENTRO do APP_DIR — o rsync --delete"
      diz "       apagaria esses arquivos. Mova para $DADOS_DIR/..."
      faltou=1 ;;
    *)
      diz "$chave: $valor (fora do APP_DIR, ok)" ;;
  esac
done
valor="$(le_chave LOG_DIR || true)"
case "$valor" in
  ""|"$APP_DIR"*) diz "aviso: LOG_DIR vazio ou dentro do APP_DIR — os logs de acesso somem no próximo deploy (ou use LOG_FILE=0 e fique só com o journal)" ;;
  *)              diz "LOG_DIR: $valor (ok)" ;;
esac

# Só a chave PORT é lida do EnvironmentFile. O arquivo inteiro NUNCA é impresso:
# ele guarda MONGODB_URI com a senha do Mongo e o AUTH_SECRET.
if [ -z "$PORTA" ]; then
  # \042 = aspa dupla, \047 = aspa simples (octal evita aninhar aspas aqui).
  PORTA="$(sudo grep -m1 -E '^[[:space:]]*PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '\042\047 \t\r' || true)"
fi
diz "porta da app: ${PORTA:-8008}"
diz "__PORTA__=${PORTA:-8008}"
[ "$faltou" = 0 ] || { diz "__FALTOU__"; exit 3; }
REMOTO
RC_DIAG=$?
set -e

# || true: com pipefail ligado, um grep que não casa nada derrubaria o script aqui.
grep -v '^__' "$DIAG_TMP" | sed 's/^/  /' || true

if [ "$RC_DIAG" != 0 ]; then
  erro "O servidor não está preparado (veja os FALTA acima). Este script não cria
  usuário, EnvironmentFile nem unit do systemd de propósito — são passos únicos,
  com senha envolvida, e devem ser feitos e revisados à mão."
fi

# Porta descoberta no servidor (ou a fixada por ambiente).
PORTA_EFETIVA="$(sed -n 's/^__PORTA__=//p' "$DIAG_TMP" | tail -1)"
PORTA_EFETIVA="${PORTA_EFETIVA:-8008}"

# ─────────────────────────────────────────────────────────────────────────────
# 3. rsync do código
# ─────────────────────────────────────────────────────────────────────────────

# O rsync HONRA aspas duplas dentro do -e, mas NÃO honra barra invertida — por
# isso a chave (que tem espaço no caminho) vai entre aspas duplas aqui dentro.
RSYNC_SSH="ssh -i \"$CHAVE\" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new"

# A barra inicial em '/data/' ancora o padrão na raiz da transferência. SEM ela,
# o rsync excluiria também src/data/lspr.json (3033 modelos LSPR) e o módulo de
# infra subiria sem referência de capacidade — falha silenciosa, o seedLspr só
# avisa. Mesma razão para /docs/, /test/, /SCRT/, /mlc/, /inventario/.
EXCLUDES=(
  --exclude '/VERSION'        # gerado NO servidor (passo 4); sem esta linha o
                              # --delete apagaria o carimbo a cada deploy
  --exclude '/.git/'          # 3,5 MB de histórico, com commits anteriores ao .gitignore atual
  --exclude '/.claude/'
  --exclude '.DS_Store'
  --exclude 'node_modules/'   # 193 MB de artefato macOS/arm64 (inclui binário Mach-O do
                              # mongodb-memory-server). Reconstruído no servidor.
  --exclude '/data/'          # banco local, auth-secret, e os binários (vão à parte, para DADOS_DIR)
  --exclude '/.env'           # tem SYNC_REMOTE_URI com senha; o servidor usa o EnvironmentFile
  --exclude '/docs/'          # portal do GitHub Pages, o server.js nunca serve isso
  --exclude '/test/'          # sobem mongodb-memory-server, que não tem binário s390x
  --exclude '/deploy/'        # este script e o modelo de env
  --exclude '/SCRT/'          # dados crus de clientes reais — nada disso é lido em runtime
  --exclude '/scrt/'
  --exclude '/mlc/'
  --exclude '/inventario/'
  --exclude '/Inventario/'
  --exclude '*.xlsx'
  --exclude '/consumo_tfp_caixa_v0.7.html'
  --exclude '/app_inventario_esw_v0.12.html'
)

# --chown exige receptor root: daí o --rsync-path='sudo rsync' (sudo sem senha).
# --chmod fecha o que veio do macOS com 644.
# --delete limpa o que sumiu do repo; arquivos EXCLUÍDOS são protegidos da
# remoção, então node_modules/ do servidor sobrevive ao redeploy.
RSYNC_ARGS=(-a --delete --human-readable
            -e "$RSYNC_SSH"
            --rsync-path='sudo rsync'
            --chown="$DONO:$DONO"
            --chmod=D750,F640
            "${EXCLUDES[@]}"
            "$RAIZ/" "$USUARIO@$HOST:$APP_DIR/")

if [ "$VALENDO" = 1 ]; then
  passo "rsync do código → $APP_DIR"
  ssh "${SSH_OPCOES[@]}" "$USUARIO@$HOST" \
    "sudo install -d -m 0750 -o $(printf '%q' "$DONO") -g $(printf '%q' "$DONO") $(printf '%q' "$APP_DIR")"
  set +e
  "$RSYNC" "${RSYNC_ARGS[@]}" --info=stats1
  RC=$?
  set -e
  # 24 = "arquivo sumiu durante a cópia". Não é falha de deploy.
  [ "$RC" = 0 ] || [ "$RC" = 24 ] || erro "rsync falhou (código $RC)"
  ok "código publicado"
else
  passo "ENSAIO — rsync que SERIA feito (--dry-run)"
  set +e
  "$RSYNC" "${RSYNC_ARGS[@]}" --dry-run --itemize-changes
  RC=$?
  set -e
  [ "$RC" = 0 ] || [ "$RC" = 24 ] || erro "rsync (ensaio) falhou (código $RC)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 4. Servidor: dependências, restart e VERIFICAÇÃO DE VERDADE
# ─────────────────────────────────────────────────────────────────────────────
if [ "$VALENDO" != 1 ]; then
  passo "ENSAIO — o que rodaria no servidor"
  cat <<FIM
  sudo install -d ... $DADOS_DIR/{scrt-files,contract-files,logs,npm}
  gravar $APP_DIR/VERSION  →  ${COMMIT:0:12}
  sudo -u $DONO npm ci --omit=dev --ignore-scripts   (MONGOMS_DISABLE_POSTINSTALL=1)
  sudo restorecon -RF $APP_DIR
  sudo systemctl restart $SERVICO
  curl http://127.0.0.1:$PORTA_EFETIVA$ROTA_SAUDE   (até ${TENTATIVAS}s)

  Nada foi alterado. Para publicar de verdade:  $0 --sim
FIM
  exit 0
fi

passo "Dependências, restart e verificação"

ARGS_REMOTOS="$(printf '%q ' "$APP_DIR" "$DADOS_DIR" "$SERVICO" "$DONO" \
                              "$PORTA_EFETIVA" "$ROTA_SAUDE" "$TENTATIVAS" "$PULAR_NPM" \
                              "$COMMIT" "$(date -u +%FT%TZ)")"

set +e
ssh "${SSH_OPCOES[@]}" "$USUARIO@$HOST" "bash -s -- $ARGS_REMOTOS" <<'REMOTO'
set -uo pipefail
APP_DIR="$1"; DADOS_DIR="$2"; SERVICO="$3"; DONO="$4"
PORTA="$5"; ROTA="$6"; TENTATIVAS="$7"; PULAR_NPM="$8"
COMMIT="$9"; QUANDO="${10}"

# O server.js imprime a MONGODB_URI inteira quando falha ao conectar
# (server.js:116) — ou seja, a senha do Mongo VAI para o journal. Todo despejo de
# log passa por aqui antes de chegar ao terminal do operador.
mascarar() {
  sed -E -e 's#(mongodb(\+srv)?://)[^@[:space:]]+@#\1***:***@#g' \
         -e 's#((AUTH_SECRET|PASSWORD|PASSWD|SENHA|PWD|TOKEN)[[:space:]]*[=:][[:space:]]*)[^[:space:]]+#\1***#Ig'
}

# Diretórios de dados FORA do APP_DIR: é o que impede um rsync --delete de levar
# junto contrato e SCRT de cliente. Idempotente.
sudo install -d -m 0750 -o "$DONO" -g "$DONO" \
  "$DADOS_DIR" "$DADOS_DIR/scrt-files" "$DADOS_DIR/contract-files" \
  "$DADOS_DIR/logs" "$DADOS_DIR/npm" "$DADOS_DIR/npm/cache" \
  || { echo "  ERRO: não consegui criar os diretórios em $DADOS_DIR"; exit 1; }

# Carimbo de versão: com rsync não existe `git log` no servidor, e este arquivo
# passa a ser a única forma de saber o que está rodando aqui. Escrito por ssh (e
# não pelo rsync) para não sujar a árvore local com um arquivo não versionado.
printf '%s\n%s\n' "$COMMIT" "$QUANDO" \
  | sudo -u "$DONO" tee "$APP_DIR/VERSION" >/dev/null \
  || echo "  aviso: não consegui gravar $APP_DIR/VERSION (segue o deploy)"

if [ "$PULAR_NPM" = 1 ]; then
  echo "  npm ci pulado (--pular-npm)"
else
  echo "  npm ci --omit=dev ..."
  # MONGOMS_DISABLE_POSTINSTALL=1: o postinstall do mongodb-memory-server tenta
  # resolver binário do mongod e não conhece s390x — falha sempre, com um aviso
  # assustador. --ignore-scripts é a rede de segurança (hoje a árvore de produção
  # não tem nenhum script de instalação).
  # HOME/cache apontam para o DADOS_DIR: dentro do APP_DIR o --delete apagaria.
  sudo -u "$DONO" -H sh -c "cd \"$APP_DIR\" && exec env \
      HOME=\"$DADOS_DIR/npm\" \
      npm_config_cache=\"$DADOS_DIR/npm/cache\" \
      MONGOMS_DISABLE_POSTINSTALL=1 \
      npm ci --omit=dev --ignore-scripts --no-audit --no-fund" \
    || { echo "  ERRO: npm ci falhou"; exit 1; }
fi

# SELinux Enforcing: o rsync pode trazer rótulo errado de fora. Custa milissegundos.
if command -v restorecon >/dev/null 2>&1; then
  sudo restorecon -RF "$APP_DIR" >/dev/null 2>&1 || true
fi

echo "  systemctl restart $SERVICO"
sudo systemctl restart "$SERVICO" || {
  echo "  ERRO: o restart falhou"
  sudo systemctl status --no-pager -l "$SERVICO" 2>&1 | mascarar
  sudo journalctl -u "$SERVICO" -n 60 --no-pager 2>&1 | mascarar
  exit 1
}

# ── Verificação de verdade: a app tem que RESPONDER, não só "estar ativa".
# O systemd dá is-active=activating/active mesmo com o Node morrendo em loop.
URL="http://127.0.0.1:${PORTA}${ROTA}"
echo "  aguardando $URL ..."
subiu=0
cod=""   # set -u: o laço pode terminar antes da 1ª atribuição
for _ in $(seq 1 "$TENTATIVAS"); do
  # A app pode ter morrido de vez: nesse caso não adianta esperar o timeout todo.
  if ! systemctl is-active --quiet "$SERVICO"; then break; fi
  cod="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$URL" 2>/dev/null || true)"
  case "$cod" in
    200|204|301|302|401|403) subiu=1; break ;;   # respondeu HTTP = processo de pé
  esac
  sleep 1
done

if [ "$subiu" != 1 ]; then
  echo
  echo "  ✗ A aplicação NÃO respondeu em $URL após ${TENTATIVAS}s (último código: ${cod:-nenhum})"
  echo "  estado: $(systemctl is-active "$SERVICO" 2>/dev/null) / $(systemctl is-failed "$SERVICO" 2>/dev/null)"
  echo
  echo "  ── journalctl -u $SERVICO -n 60 ──"
  sudo journalctl -u "$SERVICO" -n 60 --no-pager 2>&1 | mascarar | sed 's/^/  /'
  echo "  ──────────────────────────────────"
  exit 1
fi

echo "  ✓ respondeu $cod em $URL"

# Em que interface a app ficou. 0.0.0.0 aqui = alcançável de fora, por cima do
# TLS e sem firewall neste host — é aviso, não detalhe.
ESCUTA="$(sudo ss -lntp 2>/dev/null | grep -E "LISTEN.*:${PORTA}[[:space:]]" | head -1 | tr -s ' ')"
echo "  escutando: ${ESCUTA:-(não localizei a porta ${PORTA} no ss)}"
case "$ESCUTA" in
  *"0.0.0.0:${PORTA}"*|*":::${PORTA}"*|*"*:${PORTA}"*)
    echo "  ! ATENÇÃO: escutando em TODAS as interfaces. Defina HOST=127.0.0.1 no"
    echo "    EnvironmentFile para a app só ser alcançável pelo proxy reverso." ;;
esac

# APP_DIR é 0750 zcd:zcd — o usuário do SSH não entra sem sudo.
sudo test -f "$APP_DIR/VERSION" \
  && echo "  versão no servidor: $(sudo head -1 "$APP_DIR/VERSION")"
exit 0
REMOTO
RC_REMOTO=$?
set -e

if [ "$RC_REMOTO" != 0 ]; then
  erro "Deploy FALHOU — a aplicação não subiu (veja o journal acima).
  O código novo já está em $APP_DIR. Para voltar ao anterior, publique o commit
  bom de novo:  git checkout <sha> && $0 --sim"
fi

passo "Pronto"
ok "$SERVICO no ar em $HOST — commit ${COMMIT:0:12}"
printf "  Acompanhar:  ssh -i \"%s\" %s@%s 'journalctl -u %s -f'\n\n" \
  "$CHAVE" "$USUARIO" "$HOST" "$SERVICO"
