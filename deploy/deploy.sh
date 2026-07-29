#!/usr/bin/env bash
#
# Publica o IBM Z Control Desk no servidor, num dos dois ambientes.
#
#   ./deploy/deploy.sh dev            # ensaio (não faz nada, só mostra o plano)
#   ./deploy/deploy.sh dev  --sim     # publica em DEV   (dev.zcontroldesk.linuxone.com.br)
#   ./deploy/deploy.sh prod --sim     # publica em PROD  (zcontroldesk.linuxone.com.br)
#
# Fluxo recomendado: publique em dev, teste no navegador, e quando estiver bom
# rode o MESMO commit em prod — é promoção, não um novo build.
#
# O que sobe é o `git archive HEAD` (só o que o git rastreia), NUNCA a árvore de
# trabalho: o rsync ignoraria o .gitignore e levaria planilha de cliente junto.
# Por isso o deploy exige árvore limpa.
#
set -euo pipefail

AMBIENTE="${1:-}"
SIM="${2:-}"
case "$AMBIENTE" in
  dev)  APP_DIR=/opt/zcontroldesk-dev; SERVICO=zcontroldesk-dev; PORTA=8009; URL="https://dev.zcontroldesk.linuxone.com.br" ;;
  prod) APP_DIR=/opt/zcontroldesk;     SERVICO=zcontroldesk;     PORTA=8008; URL="https://zcontroldesk.linuxone.com.br" ;;
  *) echo "uso: $0 <dev|prod> [--sim]"; exit 2 ;;
esac

CHAVE="${ZCD_KEY:-$HOME/Documents/Projetos/zControlDesk BackendMarista/zDesk.pem}"
HOST="${ZCD_HOST:-148.100.74.249}"
USUARIO="${ZCD_USER:-linux1}"
SSH=(ssh -i "$CHAVE" -o BatchMode=yes "$USUARIO@$HOST")

[ -r "$CHAVE" ] || { echo "✗ chave SSH não encontrada: $CHAVE"; exit 1; }

# Procedência: publica um COMMIT, então a árvore tem de estar limpa.
if [ -n "$(git status --porcelain)" ]; then
  echo "✗ há mudanças não commitadas. Faça commit antes de publicar (o deploy usa git archive HEAD)."
  git status --short
  exit 1
fi
COMMIT=$(git rev-parse --short HEAD)
ASSUNTO=$(git log -1 --format=%s)

echo "══════════════════════════════════════════════════════════════"
echo "  ambiente : $AMBIENTE  ($URL)"
echo "  destino  : $USUARIO@$HOST:$APP_DIR  ·  serviço $SERVICO  ·  porta $PORTA"
echo "  commit   : $COMMIT  $ASSUNTO"
echo "══════════════════════════════════════════════════════════════"

if [ "$SIM" != "--sim" ]; then
  echo
  echo "  ENSAIO — nada foi feito. Repita com --sim para publicar de verdade:"
  echo "     ./deploy/deploy.sh $AMBIENTE --sim"
  exit 0
fi

echo
echo "→ enviando o código ($COMMIT)…"
# git archive só rastreados; exclui docs/test (não vão para o servidor).
git archive --format=tar HEAD -- src public server.js package.json package-lock.json scripts \
  | "${SSH[@]}" "tar -x -C $APP_DIR"

echo "→ npm ci (sem baixar o mongod, que não tem binário s390x)…"
"${SSH[@]}" "cd $APP_DIR && MONGOMS_DISABLE_POSTINSTALL=1 npm ci --omit=dev >/dev/null 2>&1 && echo '  ok'"

echo "→ reiniciando o serviço…"
"${SSH[@]}" "sudo systemctl restart $SERVICO"

echo "→ verificando que subiu…"
OK=0
for i in $(seq 1 10); do
  CODE=$("${SSH[@]}" "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORTA/login" || true)
  if [ "$CODE" = "200" ]; then OK=1; break; fi
  sleep 2
done
if [ "$OK" = "1" ]; then
  echo "  ✓ $SERVICO no ar (HTTP 200 em /login)."
  echo
  echo "  Publicado em $AMBIENTE: $URL   ($COMMIT)"
else
  echo "  ✗ o serviço não respondeu 200 depois de 20s. Últimas linhas do log:"
  "${SSH[@]}" "sudo journalctl -u $SERVICO -n 40 --no-pager -o cat" || true
  exit 1
fi
