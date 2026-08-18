#!/bin/bash
# Duplo-clique neste arquivo para abrir o ig-lists.
# Se o Mac reclamar que "não pode verificar o desenvolvedor", clique com o
# botão direito no arquivo → Abrir → Abrir.
cd "$(dirname "$0")" || exit 1

if ! command -v python3 >/dev/null 2>&1; then
  osascript -e 'display dialog "O ig-lists precisa do Python 3.\n\nInstale em python.org/downloads e tente de novo." buttons {"OK"} default button 1 with icon caution' >/dev/null 2>&1
  open "https://www.python.org/downloads/"
  exit 1
fi

echo "Abrindo o ig-lists… (feche esta janela para desligar)"
exec python3 server.py
