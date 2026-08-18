#!/usr/bin/env python3
"""
ig-lists — coleta local das listas de seguidores/seguindo do Instagram.

Roda 100% na sua máquina, sem dependência externa (só stdlib).
    python3 server.py
Abre em http://127.0.0.1:8765

O cookie nunca é gravado em disco: fica na memória do navegador e é enviado
a cada chamada, usado só para falar com a API do Instagram.
"""

import csv
import http.server
import io
import json
import os
import queue
import random
import re
import socketserver
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser

import cookies_import

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "static")
DATA = os.path.join(ROOT, "data")
SNAPSHOT = os.path.join(DATA, "snapshot.json")
os.makedirs(DATA, exist_ok=True)

PORT = int(os.environ.get("PORT", "8765"))
ACTUAL_PORT = PORT   # atualizado se a porta preferida estiver ocupada (roaming)
APP_ID = "936619743392459"

# esquemas de extensão de navegador que podem falar com o servidor
EXT_SCHEMES = ("chrome-extension://", "moz-extension://", "safari-web-extension://")
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36")

# tamanhos de página alternados entre passadas — o endpoint /following/
# devolve um subconjunto levemente diferente conforme o count, então
# variar e unir recupera os que uma passada sozinha perde.
PAGE_SIZES = [50, 200, 100, 75]


# ---------------------------------------------------------------- API client

class IGError(Exception):
    def __init__(self, code, message, retryable=False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


def cookie_value(cookie, key):
    for part in cookie.split(";"):
        k, _, v = part.strip().partition("=")
        if k == key:
            return v
    return None


def api_get(path, cookie, params=None, referer="https://www.instagram.com/",
            raw_body=False):
    url = "https://www.instagram.com" + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    headers = {
        "Cookie": cookie,
        "X-CSRFToken": cookie_value(cookie, "csrftoken") or "",
        "X-IG-App-ID": APP_ID,
        "X-ASBD-ID": "359341",
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "*/*",
        "Referer": referer,
        "User-Agent": UA,
    }
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode("utf-8", "replace")
        if raw_body:
            return raw
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            # o Instagram devolve a página de login em HTML quando não
            # reconhece a sessão, em vez de responder 401
            raise IGError(200, "Resposta não-JSON do Instagram — sessão provavelmente "
                               "expirada. Recopie o cookie.")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        msg = body
        try:
            msg = json.loads(body).get("message", body)
        except Exception:
            pass
        if e.code in (401, 403) and "login" in body:
            raise IGError(e.code, "Cookie inválido ou expirado — recopie do navegador.")
        raise IGError(e.code, msg, retryable=e.code in (429, 500, 502, 503))
    except urllib.error.URLError as e:
        raise IGError(0, f"Falha de rede: {e.reason}", retryable=True)

    if isinstance(payload, dict) and payload.get("status") == "fail":
        msg = payload.get("message", "requisição recusada")
        raise IGError(200, msg, retryable="wait" in msg.lower())
    return payload


def slim(u):
    return {
        "pk": str(u["pk"]),
        "username": u["username"],
        "full_name": u.get("full_name", ""),
        "is_private": bool(u.get("is_private")),
        "is_verified": bool(u.get("is_verified")),
    }


def detect_username(cookie):
    """Lê o @ do usuário logado a partir do HTML da home."""
    html = api_get("/", cookie, raw_body=True)
    m = re.search(r'"username":"([A-Za-z0-9._]+)"', html)
    if not m:
        raise IGError(0, "Não consegui descobrir seu @ automaticamente — "
                         "informe no campo ao lado.")
    return m.group(1)


def fetch_profile(cookie, username=None):
    uid = cookie_value(cookie, "ds_user_id")
    if not uid:
        raise IGError(0, "Cookie sem ds_user_id — copie o header Cookie inteiro.")
    username = (username or "").strip().lstrip("@") or detect_username(cookie)
    data = api_get("/api/v1/users/web_profile_info/", cookie,
                   {"username": username})
    u = (data.get("data") or {}).get("user")
    if not u:
        raise IGError(0, f"Perfil @{username} não encontrado.")
    return {
        "user_id": str(u.get("id") or uid),
        "username": u["username"],
        "full_name": u.get("full_name", ""),
        "followers": (u.get("edge_followed_by") or {}).get("count"),
        "following": (u.get("edge_follow") or {}).get("count"),
    }


# ------------------------------------------------------------------- sessão

# O cookie vive só aqui, na memória do processo. A página web nunca recebe ele
# de volta — ela só enxerga o perfil autenticado.
SESSION = {"cookie": None, "profile": None, "source": None, "at": None}
SESSION_LOCK = threading.Lock()


def set_session(cookie, source, username=None):
    profile = fetch_profile(cookie, username)   # valida antes de guardar
    with SESSION_LOCK:
        SESSION.update(cookie=cookie, profile=profile, source=source,
                       at=time.strftime("%H:%M:%S"))
    return profile


def session_view():
    with SESSION_LOCK:
        return {"authenticated": bool(SESSION["cookie"]),
                "profile": SESSION["profile"],
                "source": SESSION["source"],
                "at": SESSION["at"],
                "platform": sys.platform,   # pular a tela do Keychain fora do Mac
                "root": ROOT}               # preencher o caminho da extensão


def _foreign_snapshot(state):
    """True quando o snapshot no disco NÃO pertence a quem está conectado agora
    (inclui ninguém conectado). Protege quem recebe a pasta já com os dados de
    quem a montou: a lista do dono anterior não aparece até você entrar na sua
    conta. Só destrava quando a sessão viva bate com o dono do snapshot."""
    owner = (state.get("profile") or {}).get("user_id")
    if not owner:
        return False        # sem dono gravado (instalação limpa) → nada a esconder
    with SESSION_LOCK:
        live = (SESSION["profile"] or {}).get("user_id")
    return live != owner


# ---------------------------------------------------------------------- jobs

JOBS = {}
STATE_LOCK = threading.Lock()


class Job:
    def __init__(self, kind, passes, max_pages, delay):
        self.id = uuid.uuid4().hex[:12]
        self.kind = kind
        self.passes = passes
        self.max_pages = max_pages
        self.delay = delay
        self.events = queue.Queue()
        self.cancelled = False
        self.finished = False
        self.last = None            # último progress, para redesenhar a barra no F5

    def emit(self, event, **data):
        ev = {"event": event, **data}
        if event in ("progress", "warn", "pass_done"):
            self.last = ev
        self.events.put(ev)

    def cancel(self):
        self.cancelled = True


def api_with_retry(job, path, params, referer):
    delay = 60
    for attempt in range(1, 6):
        if job.cancelled:
            raise IGError(0, "cancelado")
        try:
            return api_get(path, job.cookie, params, referer)
        except IGError as e:
            if not e.retryable or attempt == 5:
                raise
            job.emit("warn", reason="rate_limit", wait=delay, attempt=attempt, of=5,
                     message=f"{e.message} — aguardando {delay}s "
                             f"(tentativa {attempt}/5)")
            for _ in range(delay):
                if job.cancelled:
                    raise IGError(0, "cancelado")
                time.sleep(1)
            delay = min(delay * 2, 600)
    raise IGError(0, "esgotou as tentativas")


def run_collect(job):
    referer = f"https://www.instagram.com/{job.profile['username']}/"
    merged, requests_made = {}, 0
    try:
        for p in range(job.passes):
            count = PAGE_SIZES[p % len(PAGE_SIZES)]
            before = len(merged)
            max_id, page = None, 0
            while not job.cancelled:
                params = {"count": count, "search_surface": "follow_list_page"}
                if max_id:
                    params["max_id"] = max_id
                data = api_with_retry(
                    job, f"/api/v1/friendships/{job.profile['user_id']}/{job.kind}/",
                    params, referer)
                requests_made += 1
                batch = data.get("users", [])
                for u in batch:
                    merged[str(u["pk"])] = slim(u)
                page += 1
                job.emit("progress", **{
                    "pass": p + 1, "passes": job.passes, "page": page,
                    "page_size": count, "total": len(merged),
                    "requests": requests_made,
                })
                max_id = data.get("next_max_id")
                if not max_id or not batch:
                    break
                if job.max_pages and page >= job.max_pages:
                    job.emit("warn", reason="test_mode",
                             message=f"modo teste: parei em {page} páginas")
                    break
                time.sleep(job.delay + random.uniform(0, 1.2))
            job.emit("pass_done", **{
                "pass": p + 1, "gained": len(merged) - before, "total": len(merged)})
            if p + 1 < job.passes and not job.cancelled:
                time.sleep(job.delay)

        if job.cancelled:
            # cancelado no meio: o resultado está incompleto, não sobrescreve
            # o snapshot bom que já estava salvo
            job.emit("error", message="cancelado — nada foi gravado")
            return
        users = sorted(merged.values(), key=lambda u: u["username"].lower())
        save_list(job.kind, users, job.profile)
        expected = job.profile.get(job.kind)
        job.emit("done", kind=job.kind, total=len(users), expected=expected)
    except IGError as e:
        job.emit("error", message=e.message)
    except Exception as e:  # rede caindo no meio, etc.
        job.emit("error", message=f"{type(e).__name__}: {e}")
    finally:
        job.finished = True
        job.events.put(None)
        JOBS.pop(job.id, None)   # só aqui — se saísse ao fechar o stream, um
                                 # /api/cancel posterior não acharia o job


# --------------------------------------------------------------------- state

def load_state():
    if os.path.exists(SNAPSHOT):
        try:
            return json.load(open(SNAPSHOT, encoding="utf-8"))
        except Exception:
            pass
    return {"profile": None, "followers": [], "following": [],
            "updated": {"followers": None, "following": None}}


def save_list(kind, users, profile):
    with STATE_LOCK:
        state = load_state()
        # troca de dono: nunca deixar o snapshot conter duas contas ao mesmo
        # tempo (senão a lista antiga do dono anterior vaza pela guarda de
        # identidade, que passa a valer para a conta nova).
        old = (state.get("profile") or {}).get("user_id")
        if old and old != profile.get("user_id"):
            state = {"profile": None, "followers": [], "following": [],
                     "updated": {"followers": None, "following": None}}
        state[kind] = users
        state["profile"] = profile
        state["updated"][kind] = time.strftime("%Y-%m-%d %H:%M:%S")
        json.dump(state, open(SNAPSHOT, "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)


def compute(name, state=None):
    state = state or load_state()
    ers = {u["pk"]: u for u in state["followers"]}
    ing = {u["pk"]: u for u in state["following"]}
    meta = {**ers, **ing}
    if name == "followers":
        ids = set(ers)
    elif name == "following":
        ids = set(ing)
    elif name == "mutual":
        ids = set(ers) & set(ing)
    elif name == "not_following_back":     # você segue, não te seguem
        ids = set(ing) - set(ers)
    elif name == "not_followed_back":      # te seguem, você não segue
        ids = set(ers) - set(ing)
    else:
        return None
    return sorted((meta[i] for i in ids), key=lambda u: u["username"].lower())


# de quais listas-fonte cada visão depende
NEEDS = {"followers": ("followers",), "following": ("following",),
         "mutual": ("followers", "following"),
         "not_following_back": ("followers", "following"),
         "not_followed_back": ("followers", "following")}


def missing_for(name, state=None):
    """Listas-fonte ainda não coletadas para esta visão. Vazio = pode calcular.
    Sem isso, um `set(ers) - set(ing)` com `ing` vazio devolveria TODOS os
    seguidores como 'você não segue de volta' — uma mentira dolorosa."""
    upd = (state or load_state()).get("updated") or {}
    return [k for k in NEEDS.get(name, ()) if not upd.get(k)]


LIST_LABELS = {
    "followers": "seguidores",
    "following": "seguindo",
    "mutual": "mutuos",
    "not_following_back": "nao_te_seguem_de_volta",
    "not_followed_back": "voce_nao_segue_de_volta",
}


def _csv_safe(value):
    """Neutraliza CSV/formula injection: um full_name como '=CMD()' ou '+A1'
    é executado pelo Excel ao abrir. Prefixa com aspa simples os gatilhos."""
    s = str(value)
    if s and s[0] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + s
    return s


def render(rows, fmt):
    if fmt == "txt":
        # CRLF: abre certo tanto no Windows quanto no mac/Linux
        return "\r\n".join(f"@{u['username']}" for u in rows) + "\r\n", "text/plain"
    if fmt == "json":
        return json.dumps(rows, ensure_ascii=False, indent=2), "application/json"
    buf = io.StringIO()
    w = csv.writer(buf)   # csv.writer já usa \r\n
    w.writerow(["usuario", "url", "nome", "user_id", "privado", "verificado"])
    for u in rows:
        w.writerow([f"@{u['username']}",
                    f"https://www.instagram.com/{u['username']}/",
                    _csv_safe(u["full_name"]), u["pk"],
                    int(u["is_private"]), int(u["is_verified"])])
    # BOM UTF-8: sem ele o Excel brasileiro lê 'José' como 'JosÃ©'
    return "﻿" + buf.getvalue(), "text/csv"


# -------------------------------------------------------------------- server

class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # silencia o log de acesso

    def _cors(self):
        """Libera só extensões de navegador — nunca páginas da web, que senão
        qualquer site aberto poderia ler suas listas via fetch para localhost."""
        origin = self.headers.get("Origin", "")
        if origin.startswith(EXT_SCHEMES):
            return {"Access-Control-Allow-Origin": origin,
                    "Access-Control-Allow-Headers": "Content-Type",
                    "Access-Control-Allow-Methods": "POST, OPTIONS"}
        return {}

    def _origin_ok(self):
        """Barra CSRF: um site aberto no navegador consegue disparar um POST
        'simple request' para 127.0.0.1 (sem preflight), e o CORS só impede LER
        a resposta, não o efeito colateral. Então rejeitamos qualquer Origin que
        não seja a própria página local ou uma extensão nossa.

        Origin AUSENTE é aceito de propósito: o navegador SEMPRE anexa Origin em
        POST (Fetch spec), então ausência = curl/script local do próprio dono.
        Origin 'null' (iframe sandbox, file://) é string presente → cai fora → 403."""
        origin = self.headers.get("Origin")
        if origin is None:
            return True
        local = {f"http://127.0.0.1:{ACTUAL_PORT}", f"http://localhost:{ACTUAL_PORT}",
                 f"http://[::1]:{ACTUAL_PORT}"}
        return origin in local or origin.startswith(EXT_SCHEMES)

    def do_OPTIONS(self):
        self._send(204, b"", "text/plain", self._cors())

    def _send(self, code, body, ctype="application/json", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj, extra=None):
        self._send(code, json.dumps(obj, ensure_ascii=False), extra=extra)

    def _body(self):
        n = int(self.headers.get("Content-Length", 0))
        if n:
            ct = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
            if ct != "application/json":
                # fecha o vetor de CSRF via 'simple request' text/plain
                raise ValueError("content-type inválido")
        return json.loads(self.rfile.read(n) or b"{}")

    def _host_ok(self):
        """Anti-DNS-rebinding: só aceita Host de loopback. Sem isso, um site
        aberto no navegador poderia apontar um domínio dele para 127.0.0.1 e
        conversar com este servidor para ler suas listas."""
        host = self.headers.get("Host", "").split(":")[0].strip("[]").lower()
        return host in ("127.0.0.1", "localhost", "::1", "")

    # qualquer exceção não tratada vira 500 JSON, em vez de matar a conexão
    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception as e:
            try:
                self._json(500, {"error": f"{type(e).__name__}: {e}"})
            except Exception:
                self.close_connection = True

    def _guard(self):
        if not self._host_ok():
            self._json(403, {"error": "host não permitido"})
            return False
        return True

    # ---- GET
    def do_GET(self):
        if not self._guard():
            return
        url = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(url.query)

        if url.path in ("/", "/index.html"):
            return self._file("index.html", "text/html")
        if url.path.startswith("/static/"):
            name = os.path.basename(url.path)
            ctype = ("text/css" if name.endswith(".css")
                     else "application/javascript" if name.endswith(".js")
                     else "application/octet-stream")
            return self._file(name, ctype)

        if url.path == "/api/session":
            return self._json(200, session_view())

        if url.path == "/api/jobs":
            # coletas vivas, para a página re-encaixar a barra depois de um F5.
            # exclui canceladas: senão o "parar" reencaixaria o job que está
            # justamente encerrando, e o usuário voltaria para a tela de coleta.
            return self._json(200, {"jobs": [
                {"id": j.id, "kind": j.kind, "last": j.last}
                for j in list(JOBS.values()) if not j.finished and not j.cancelled]})

        if url.path == "/api/browsers":
            try:
                return self._json(200, {"browsers": cookies_import.available()})
            except Exception as e:
                return self._json(200, {"browsers": [], "error": str(e)})

        if url.path == "/api/state":
            state = load_state()
            # guarda de identidade: se o snapshot no disco é de outra pessoa
            # (ex.: a pasta foi repassada com dados de quem coletou antes),
            # não expõe nada até a sessão viva bater com o dono do snapshot.
            if _foreign_snapshot(state):
                return self._json(200, {"profile": None, "updated":
                                        {"followers": None, "following": None},
                                        "counts": {k: None for k in LIST_LABELS},
                                        "foreign": True})
            counts = {k: (None if missing_for(k, state) else len(compute(k, state)))
                      for k in LIST_LABELS}
            return self._json(200, {"profile": state["profile"],
                                    "updated": state["updated"], "counts": counts})

        if url.path == "/api/lists":
            state = load_state()
            if _foreign_snapshot(state):
                return self._json(200, {"profile": None, "followers": [],
                                        "following": [], "foreign": True,
                                        "updated": {"followers": None,
                                                    "following": None}})
            return self._json(200, {
                "profile": state["profile"], "updated": state["updated"],
                "followers": state["followers"], "following": state["following"]})

        if url.path == "/api/list":
            state = load_state()
            if _foreign_snapshot(state):
                return self._json(403, {"error": "conecte a sua conta primeiro"})
            name = q.get("name", [""])[0]
            rows = compute(name, state)
            if rows is None:
                return self._json(400, {"error": "lista desconhecida"})
            if missing_for(name, state):
                return self._json(409, {"error": "faltou coletar uma das listas",
                                        "missing": missing_for(name, state)})
            return self._json(200, {"rows": rows})

        if url.path == "/api/export":
            state = load_state()
            if _foreign_snapshot(state):
                return self._json(403, {"error": "conecte a sua conta primeiro"})
            name = q.get("name", [""])[0]
            fmt = q.get("format", ["csv"])[0]
            rows = compute(name, state)
            if rows is None or fmt not in ("csv", "txt", "json"):
                return self._json(400, {"error": "parâmetros inválidos"})
            if missing_for(name, state):
                return self._json(409, {"error": "faltou coletar uma das listas"})
            body, ctype = render(rows, fmt)
            fname = f"instagram_{LIST_LABELS[name]}.{fmt}"
            # grava também em data/ para uso fora do navegador (newline="" para
            # não duplicar o \r\n do CSV no Windows)
            with open(os.path.join(DATA, fname), "w", encoding="utf-8",
                      newline="") as f:
                f.write(body)
            return self._send(200, body, ctype,
                              {"Content-Disposition": f'attachment; filename="{fname}"'})

        if url.path == "/api/stream":
            return self._stream(q.get("job", [""])[0])

        return self._json(404, {"error": "not found"})

    def _file(self, name, ctype):
        path = os.path.join(STATIC, name)
        if not os.path.isfile(path):
            return self._json(404, {"error": "not found"})
        with open(path, "rb") as f:
            return self._send(200, f.read(), ctype)

    def _stream(self, job_id):
        job = JOBS.get(job_id)
        if not job:
            return self._json(404, {"error": "job não encontrado"})
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            while True:
                ev = job.events.get()
                if ev is None:
                    break
                self.wfile.write(f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
                                 .encode("utf-8"))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return   # cliente sumiu (aba fechada / F5); o job segue vivo.
                     # cancelar é só via POST /api/cancel explícito.

    # ---- POST
    def do_POST(self):
        if not self._guard():
            return
        if not self._origin_ok():
            return self._json(403, {"error": "origem não permitida"})
        url = urllib.parse.urlparse(self.path)
        try:
            body = self._body()
        except Exception:
            return self._json(400, {"error": "json inválido"})

        # aceita cookie colado à mão (página) ou enviado pela extensão
        if url.path == "/api/auth":
            cookie = (body.get("cookie") or "").strip()
            if not cookie:
                return self._json(400, {"error": "cookie vazio"}, self._cors())
            if not cookie_value(cookie, "sessionid"):
                return self._json(400, {"error": "faltou o sessionid"}, self._cors())
            try:
                profile = set_session(cookie, body.get("source", "manual"),
                                      body.get("username"))
            except IGError as e:
                return self._json(400, {"error": e.message}, self._cors())
            return self._json(200, {"ok": True, "profile": profile}, self._cors())

        if url.path == "/api/import":
            browser, profile = body.get("browser"), body.get("profile")
            # aceita só pares que o próprio servidor listou — fecha o path
            # traversal via campo profile ('../..', '/etc/passwd', etc.)
            avail = cookies_import.available()
            match = next((b for b in avail
                          if b["key"] == browser and b["profile"] == profile), None)
            if not match:
                return self._json(400, {"error": "navegador/perfil inválido — "
                                                  "recarregue a página"})
            try:
                cookie = cookies_import.get_cookie(browser, profile)
                return self._json(200, {"ok": True,
                                        "profile": set_session(cookie, match["label"],
                                                               body.get("username"))})
            except cookies_import.ImportError_ as e:
                return self._json(400, {"error": str(e)})
            except IGError as e:
                return self._json(400, {"error": e.message})

        if url.path == "/api/logout":
            with SESSION_LOCK:
                SESSION.update(cookie=None, profile=None, source=None, at=None)
            return self._json(200, {"ok": True})

        if url.path == "/api/collect":
            with SESSION_LOCK:
                cookie, profile = SESSION["cookie"], SESSION["profile"]
            if not cookie:
                return self._json(401, {"error": "sem sessão — conecte primeiro"})
            kind = body.get("kind")
            if kind not in ("followers", "following"):
                return self._json(400, {"error": "kind inválido"})
            # F5 no meio da coleta não deve criar um segundo coletor concorrente
            # com o mesmo cookie: reaproveita o job vivo do mesmo tipo.
            for j in list(JOBS.values()):
                if j.kind == kind and not j.finished:
                    return self._json(200, {"job": j.id, "profile": profile,
                                            "resumed": True})
            job = Job(kind,
                      max(1, min(int(body.get("passes", 1)), 5)),
                      int(body.get("max_pages", 0)),
                      max(1.0, float(body.get("delay", 2.5))))
            job.cookie = cookie
            job.profile = profile
            JOBS[job.id] = job
            threading.Thread(target=run_collect, args=(job,), daemon=True).start()
            return self._json(200, {"job": job.id, "profile": profile})

        if url.path == "/api/cancel":
            job = JOBS.get(body.get("job"))
            if job:
                job.cancel()
            return self._json(200, {"ok": True})

        if url.path == "/api/reset":
            with STATE_LOCK:
                if os.path.exists(SNAPSHOT):
                    os.remove(SNAPSHOT)
            return self._json(200, {"ok": True})

        if url.path == "/api/quit":
            with SESSION_LOCK:
                SESSION.update(cookie=None, profile=None, source=None, at=None)
            threading.Timer(0.4, self.server.shutdown).start()
            return self._json(200, {"ok": True})

        return self._json(404, {"error": "not found"})


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    # No Windows, SO_REUSEADDR permite DOIS processos no mesmo 127.0.0.1:porta
    # (a extensão autentica num, a página pergunta no outro). Só liga fora dele.
    allow_reuse_address = os.name != "nt"


def _is_ig_lists(port):
    """Um ig-lists já rodando responde /api/session com JSON contendo
    'authenticated' — assim distinguimos ele de outro app qualquer na porta."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/session",
                                    timeout=1.5) as r:
            return "authenticated" in json.loads(r.read())
    except Exception:
        return False


def _bind():
    """Sobe na porta preferida; se ocupada, primeiro checa se o ocupante já é
    um ig-lists (então reaproveita, abrindo só o navegador), senão anda de porta."""
    global ACTUAL_PORT
    for p in range(PORT, PORT + 20):
        try:
            httpd = Server(("127.0.0.1", p), Handler)
            ACTUAL_PORT = p
            return httpd
        except OSError:
            if p == PORT and _is_ig_lists(p):
                print(f"O ig-lists já está aberto em http://127.0.0.1:{p}")
                if "--no-open" not in sys.argv:
                    webbrowser.open(f"http://127.0.0.1:{p}")
                sys.exit(0)
    sys.exit("Não achei porta livre entre "
             f"{PORT} e {PORT + 19}. Feche algum programa e tente de novo.")


if __name__ == "__main__":
    httpd = _bind()
    url = f"http://127.0.0.1:{ACTUAL_PORT}"
    print(f"ig-lists → {url}   (feche esta janela para desligar)")
    if "--no-open" not in sys.argv:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\ntchau")
