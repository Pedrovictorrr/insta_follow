#!/bin/bash
# Gera um zip limpo do ig-lists para mandar aos amigos.
# Tira os SEUS dados (data/), caches e arquivos pessoais — só vai o app.
set -e
cd "$(dirname "$0")"

OUT="${1:-$HOME/Desktop/ig-lists.zip}"
rm -f "$OUT"

zip -r "$OUT" . \
  -x 'data/*' \
  -x '__pycache__/*' -x '*/__pycache__/*' -x '*.pyc' \
  -x '.git/*' -x '.DS_Store' -x '*/.DS_Store' \
  -x 'empacotar.sh' \
  >/dev/null

echo "Pacote pronto: $OUT"
echo "Sem os seus dados dentro. Pode mandar para quem quiser."
unzip -l "$OUT" | grep -q 'data/snapshot' && \
  echo "ATENÇÃO: o snapshot entrou no zip — não mande!" || \
  echo "Conferido: nenhum snapshot pessoal no pacote."
