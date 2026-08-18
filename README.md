# ig-lists — quem não te segue de volta

Abre a sua lista de **seguidores**, cruza com a de quem você **segue** e mostra a
diferença: mútuos, quem não te segue de volta, quem você não segue de volta. Roda
inteiro na sua máquina, com uma interface web que se explica sozinha.

Sem `pip install`, sem `node_modules`, sem conta em serviço nenhum — só a biblioteca
padrão do Python 3.

## Abrir

- **Mac**: botão direito em `Abrir no Mac.command` → Abrir → Abrir (só na 1ª vez — dois
  cliques direto o macOS bloqueia).
- **Windows**: dois cliques em `Abrir no Windows.bat`.
- **Qualquer sistema**, pelo terminal:
  ```bash
  python3 server.py
  ```

Abre em <http://127.0.0.1:8765>. Se a porta estiver ocupada, anda sozinho para a próxima
livre; se o ocupante já for um ig-lists, só reabre a aba.

## O fluxo

1. **Conectar** — o app aproveita a sessão já aberta no seu navegador; você não digita
   senha do Instagram. Três caminhos, do mais fácil ao mais chato (abaixo).
2. **Confirmar** — mostra qual conta conectou e o tempo estimado, para você não coletar
   no perfil errado.
3. **Coletar** — barra de progresso ao vivo. Pode usar o computador enquanto isso; só não
   feche a aba.
4. **Revelação** — o número que importa, com o contexto antes do choque e uma nota
   honesta de quanto da lista pode estar impreciso.
5. **Listas** — placar navegável, busca por `@`/nome que cruza as cinco listas,
   ordenação, exportar (CSV/TXT/JSON) e um modo "revisar um por um".

## Como conectar

O `sessionid` do Instagram é **HttpOnly**: nenhum JavaScript numa página consegue lê-lo.
Por isso não existe bookmarklet — só estes três caminhos.

### 1. Importar do navegador (um clique, sem instalar nada)

Lê o cookie store do próprio navegador e descriptografa localmente — mesma técnica do
`yt-dlp --cookies-from-browser`. Detecta Chrome, Brave, Edge, Arc, Vivaldi, Chromium,
Opera e Firefox, em todos os perfis.

- **macOS**: o sistema pede sua senha para liberar a chave do Keychain. A janela pode
  abrir atrás desta — marque **Sempre Permitir**. Sem resposta em 60s, desiste.
- **Windows**: funciona sem pedir nada (DPAPI). **Exceção**: Chrome/Edge a partir da
  versão 127 blindaram os cookies (App-Bound Encryption) e nenhum programa comum
  consegue lê-los — nesse caso use a extensão.
- **Linux**: usa o keyring (GNOME/KDE) quando disponível.

### 2. Extensão do Chrome

Instalação única: `chrome://extensions` → **Modo do desenvolvedor** → **Carregar sem
compactação** → escolha a pasta `extension` (o app mostra o caminho exato, com botão de
copiar). Depois, clique no ícone da extensão → **Enviar sessão**; a página conecta
sozinha. Usa a API `chrome.cookies` (enxerga HttpOnly) e manda **só** os 6 cookies
necessários para `127.0.0.1`. Funciona em qualquer navegador Chromium (Chrome, Edge,
Brave, Arc, Vivaldi, Opera).

### 3. Colar o código na mão

Fallback: `F12` → **Network** → recarregue → clique numa linha de `instagram.com` →
**Headers** → *Request Headers* → linha `cookie` → botão direito → **Copy value**.

## Precisão — por que o app avisa

O contador do próprio perfil oscila: o mesmo endpoint devolveu 1.338, depois 1.257 para
"seguindo" com minutos de diferença. A lista de **seguidores** costuma vir completa numa
passada; a de **seguindo** é instável, então o app roda 3 passadas com tamanhos de página
diferentes (50/200/100/75) e une os resultados.

Quando faltam alguns dos seguidores que o Instagram declara, a tela de resultado **diz
quantos** e avisa que até N nomes da lista "não te seguem de volta" podem estar ali por
engano — porque com listas pequenas isso é uma fatia grande do número, e seria desonesto
esconder.

Se o Instagram responder *"wait a few minutes"* (`429`), o app mostra uma pausa com
contagem regressiva e continua sozinho (60s, 120s… até 5 tentativas).

## Segurança e privacidade

Cada afirmação corresponde a código real (a gaveta "Como isso é seguro?" no app aponta
onde):

- **Roda em 127.0.0.1** — não existe servidor nosso. O programa está na sua máquina.
- **O cookie fica só na memória do processo.** A página web nunca o recebe; ela só sabe
  qual perfil está conectado. Nada de cookie em disco. Parou o servidor, some.
- **Nenhum site alcança o app.** Três defesas: escuta só em loopback; recusa qualquer
  `Host` que não seja local (anti DNS-rebinding); recusa `POST` de qualquer `Origin` que
  não seja a própria página ou uma extensão (anti-CSRF).
- **O programa só lê.** Nunca segue, deixa de seguir, curte ou publica — justamente a
  automação que faz o Instagram bloquear conta.
- **Sem fotos de perfil, de propósito.** Baixá-las avisaria o Instagram quais perfis você
  está olhando. As cores dos avatares vêm do próprio `@`.
- **Guarda de identidade.** Se a pasta for repassada com os dados de quem coletou antes,
  as listas só aparecem depois que você conecta a *sua* conta.
- O `sessionid` equivale à sua senha. Se vazar: *Instagram → Configurações → Central de
  Contas → Senha e segurança → Onde você entrou*.

## Distribuir para amigos

Cada pessoa roda a **própria** cópia na máquina dela — nunca hospede num servidor onde os
outros colam o cookie (isso seria coletar a credencial deles).

```bash
./empacotar.sh            # gera ~/Desktop/ig-lists.zip, SEM os seus dados
```

O zip exclui `data/` (suas listas), então pode mandar por WhatsApp/Drive à vontade. Diga
ao amigo a regra do Gatekeeper que está no `LEIA-ME.txt`: no Mac, **botão direito → Abrir**
na primeira vez.

## Como funciona por dentro

**Coleta.** O servidor pagina `GET /api/v1/friendships/<id>/followers|following/`
seguindo o cursor `next_max_id`, com o cookie da sessão nos headers. Cada página vira um
evento `progress` enviado à página por **Server-Sent Events** (`/api/stream`), então a
barra anda ao vivo sem polling. Se o Instagram responder `429`, o worker faz backoff
(60→120→…→600s) e emite um `warn reason=rate_limit`, que a UI mostra como uma pausa com
contagem regressiva. O resultado é gravado num único `data/snapshot.json`.

**O cookie nunca chega no navegador.** Ele vive só num dict `SESSION` na memória do
processo. A página só chama `/api/session` (que perfil está conectado) e `/api/lists`
(as duas listas cruas) — nunca recebe o cookie de volta. Parou o servidor, some.

**O cruzamento é no cliente.** `/api/lists` manda as duas listas uma vez; `data.js`
cruza em memória (`Map` por `pk`) nas cinco visões e a UI troca de aba sem novas
requisições. Isso também deixa a busca instantânea e permite o "também: N em Mútuos".

**A interface é uma máquina de estados.** O `<body>` tem `data-view` (welcome, connect,
keychain, confirm, collecting, paused, reveal, list, fail) e o CSS mostra a `view`
correspondente. `app.js` só troca esse atributo — não há telas sendo montadas/destruídas.

**A honestidade é calculada, não escrita.** A tela de resultado compara quantos
seguidores foram coletados com o número que o Instagram declara; se faltam N, avisa que
até N nomes da lista "não te seguem de volta" podem estar ali por engano.

### Endpoints

| Rota | O quê |
|---|---|
| `GET /api/session` | perfil conectado, plataforma, caminho da extensão |
| `POST /api/auth` · `/api/import` | conectar (cookie colado / cookie store do navegador) |
| `GET /api/browsers` | navegadores com sessão do Instagram, para os botões |
| `POST /api/collect` → `GET /api/stream` | inicia a coleta e transmite o progresso (SSE) |
| `GET /api/jobs` | coletas vivas, para re-encaixar a barra após um F5 |
| `GET /api/lists` | as duas listas cruas (a UI cruza no cliente) |
| `GET /api/export` | CSV (com BOM) · TXT · JSON de uma lista |
| `POST /api/logout` · `/api/reset` · `/api/quit` | encerrar sessão · apagar listas · desligar |

Todo `POST` exige `Origin` local ou de extensão (anti-CSRF); todo request exige `Host`
de loopback (anti DNS-rebinding); o servidor escuta só em `127.0.0.1`.

## Arquivos

```
server.py           servidor HTTP + cliente da API do Instagram + progresso via SSE
cookies_import.py   leitura do cookie store do navegador (Win/mac/Linux)
crypto_min.py       AES-128/256, CBC e GCM, em Python puro (validado contra vetores NIST)
extension/          extensão de navegador (manifest MV3, popup)
static/             index.html · style.css · api.js · data.js · app.js
data/               snapshot.json (suas listas) + exports        [não versionado]
Abrir no Mac.command / Abrir no Windows.bat / empacotar.sh / LEIA-ME.txt
```

`PORT=9000 python3 server.py` troca a porta preferida; `--no-open` não abre o navegador.

## Aviso

Ferramenta não-oficial que usa a API web privada do Instagram com a sua própria sessão.
Não é afiliada à Meta. Use com a sua conta e com bom senso — coletas muito agressivas
podem fazer o Instagram limitar temporariamente os pedidos (o app já espaça e faz pausas
para evitar isso). Sem licença explícita: uso pessoal.
