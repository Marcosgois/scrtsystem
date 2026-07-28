#!/usr/bin/env bash
#
# Túnel SSH até o MongoDB do servidor.
#
# Desde o deploy da aplicação no próprio servidor, o mongod só escuta em
# 127.0.0.1 — foi assim que a porta 27017 saiu da internet. Em troca, o
# `npm run db:pull` daqui não alcança mais o banco diretamente. Este túnel
# devolve esse acesso, mas só para quem tem a chave SSH.
#
#   Terminal 1:  ./scripts/tunel-db.sh        (fica aberto, é normal)
#   Terminal 2:  npm run db:status
#                npm run db:pull -- --yes
#
# A porta local é a 27019 de propósito: a 27018 é o mongod de desenvolvimento
# desta máquina (LOCAL_DB_PORT no .env). Apontar o túnel para lá faria o
# db:pull ler e escrever no MESMO banco, e a trava de "origem == destino" do
# scripts/sync-db.js não pegaria — para ela seriam dois hosts diferentes.
#
set -euo pipefail

CHAVE="${ZCD_KEY:-$HOME/Documents/Projetos/zControlDesk BackendMarista/zDesk.pem}"
SERVIDOR="${ZCD_HOST:-148.100.74.249}"
USUARIO="${ZCD_USER:-linux1}"
PORTA_LOCAL="${ZCD_TUNNEL_PORT:-27019}"

[ -r "$CHAVE" ] || { echo "✗ chave SSH não encontrada: $CHAVE" >&2; exit 1; }

if lsof -nP -iTCP:"$PORTA_LOCAL" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "✗ a porta $PORTA_LOCAL já está em uso — outro túnel aberto?" >&2
  exit 1
fi

echo "  túnel: 127.0.0.1:$PORTA_LOCAL → $SERVIDOR:27017"
echo "  SYNC_REMOTE_URI do .env já aponta para cá. Ctrl-C encerra."
exec ssh -i "$CHAVE" -N -L "${PORTA_LOCAL}:127.0.0.1:27017" "$USUARIO@$SERVIDOR"
