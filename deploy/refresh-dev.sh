#!/usr/bin/env bash
#
# Atualiza o ambiente DEV com uma cópia fresca do banco e dos arquivos de PROD.
#
#   ./deploy/refresh-dev.sh            # mostra o que faria
#   ./deploy/refresh-dev.sh --sim      # executa
#
# Use quando quiser testar em dev com o estado atual de prod. É de MÃO ÚNICA,
# prod → dev: SOBRESCREVE o banco tfpsystem_dev e os arquivos do dev. Nunca toca
# em prod.
#
# As senhas não passam pela sua máquina: o script lê os /etc/*.env NO SERVIDOR
# (via sudo) e usa os usuários de aplicação (zcd_app lê prod, zcd_dev escreve
# dev) — o usuário admin do Mongo não entra nisso.
#
set -euo pipefail

SIM="${1:-}"
CHAVE="${ZCD_KEY:-$HOME/Documents/Projetos/zControlDesk BackendMarista/zDesk.pem}"
HOST="${ZCD_HOST:-148.100.74.249}"
USUARIO="${ZCD_USER:-linux1}"
[ -r "$CHAVE" ] || { echo "✗ chave SSH não encontrada: $CHAVE"; exit 1; }

if [ "$SIM" != "--sim" ]; then
  cat <<TXT
Isto copia PROD → DEV (sobrescreve o dev):
  · banco   tfpsystem  →  tfpsystem_dev   (mongodump/mongorestore --drop)
  · arquivos /var/lib/zcontroldesk/{scrt,contract}-files  →  .../zcontroldesk-dev/

Nada foi feito. Repita com --sim para executar:
   ./deploy/refresh-dev.sh --sim
TXT
  exit 0
fi

echo "→ atualizando dev a partir de prod…"
ssh -i "$CHAVE" -o BatchMode=yes "$USUARIO@$HOST" 'sudo bash -s' <<'REMOTO'
set -euo pipefail
PROD_URI=$(sed -n 's/^MONGODB_URI=//p' /etc/zcontroldesk.env)
DEV_URI=$(sed -n 's/^MONGODB_URI=//p' /etc/zcontroldesk-dev.env)
D=$(mktemp -d)

echo "  · dump de prod (usuário zcd_app, só leitura efetiva aqui)…"
mongodump --uri="$PROD_URI" --out "$D" --quiet

echo "  · restaurando em tfpsystem_dev (usuário zcd_dev)…"
mongorestore --uri="$DEV_URI" --nsFrom 'tfpsystem.*' --nsTo 'tfpsystem_dev.*' --drop "$D" --quiet
rm -rf "$D"

echo "  · copiando os arquivos binários…"
rsync -a --delete /var/lib/zcontroldesk/scrt-files/     /var/lib/zcontroldesk-dev/scrt-files/
rsync -a --delete /var/lib/zcontroldesk/contract-files/ /var/lib/zcontroldesk-dev/contract-files/
chown -R zcd-dev:zcd-dev /var/lib/zcontroldesk-dev

echo "  · reiniciando o dev…"
systemctl restart zcontroldesk-dev
sleep 4
systemctl is-active zcontroldesk-dev
REMOTO
echo "✓ dev atualizado a partir de prod."
