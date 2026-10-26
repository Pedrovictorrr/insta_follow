#!/bin/zsh
# Publica o site "quem não me segue" (web/) em seguidores.cwsystems.com.br no droplet.
# Uso: zsh deploy/publicar-web.sh
set -euo pipefail
cd "${0:A:h}/.."
node web/teste-exportacao.mjs
php -l web/api.php >/dev/null
DEST=/home/forge/seguidores.cwsystems.com.br/public
rsync -az web/index.html web/app.js web/exportacao.js web/api.php static/style.css static/data.js do-droplet:$DEST/
ssh do-droplet "chown -R forge:forge $DEST && curl -fsS -o /dev/null -w 'site %{http_code}\n' https://seguidores.cwsystems.com.br/"
