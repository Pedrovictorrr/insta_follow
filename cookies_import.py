"""
Lê a sessão do Instagram direto do cookie store do navegador — Windows, macOS e Linux.

Como cada plataforma protege os cookies do Chromium:
  macOS   → valor = "v10" + AES-128-CBC. Chave: PBKDF2-SHA1(senha do Keychain,
            "saltysalt", 1003, 16). O macOS pede autorização para ler o Keychain.
  Windows → valor = "v10" + nonce(12) + AES-256-GCM + tag(16). Chave: guardada em
            base64 no Local State sob "os_crypt.encrypted_key", prefixada por
            "DPAPI", desembrulhada com CryptUnprotectData (DPAPI, sem prompt).
  Linux   → valor = "v10"/"v11" + AES-128-CBC. Chave: PBKDF2-SHA1(senha, "saltysalt",
            iterações, 16). "v11" usa a senha do keyring (Secret Service); "v10" e o
            fallback usam a senha fixa "peanuts" com 1 iteração.

Firefox guarda em texto puro nos três sistemas.
Mesma ideia do `yt-dlp --cookies-from-browser`. Só stdlib + crypto_min.
"""

import base64
import glob
import hashlib
import json
import os
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile

import crypto_min

WANTED = ("sessionid", "csrftoken", "ds_user_id", "mid", "ig_did", "datr")
IS_MAC = sys.platform == "darwin"
IS_WIN = sys.platform.startswith("win")


class ImportError_(Exception):
    pass


# ---------------------------------------------------- localização dos perfis

def _chromium_roots():
    """{key: (rótulo, diretório-base-do-navegador, nome-no-keychain)} por SO."""
    home = os.path.expanduser("~")
    if IS_MAC:
        s = os.path.join(home, "Library/Application Support")
        return {
            "chrome":   ("Google Chrome", f"{s}/Google/Chrome", "Chrome"),
            "brave":    ("Brave", f"{s}/BraveSoftware/Brave-Browser", "Brave"),
            "edge":     ("Microsoft Edge", f"{s}/Microsoft Edge", "Microsoft Edge"),
            "arc":      ("Arc", f"{s}/Arc/User Data", "Arc"),
            "vivaldi":  ("Vivaldi", f"{s}/Vivaldi", "Vivaldi"),
            "chromium": ("Chromium", f"{s}/Chromium", "Chromium"),
        }
    if IS_WIN:
        la = os.environ.get("LOCALAPPDATA", f"{home}\\AppData\\Local")
        ra = os.environ.get("APPDATA", f"{home}\\AppData\\Roaming")
        return {
            "chrome":   ("Google Chrome", f"{la}\\Google\\Chrome\\User Data", None),
            "brave":    ("Brave", f"{la}\\BraveSoftware\\Brave-Browser\\User Data", None),
            "edge":     ("Microsoft Edge", f"{la}\\Microsoft\\Edge\\User Data", None),
            "vivaldi":  ("Vivaldi", f"{la}\\Vivaldi\\User Data", None),
            "chromium": ("Chromium", f"{la}\\Chromium\\User Data", None),
            "opera":    ("Opera", f"{ra}\\Opera Software\\Opera Stable", None),
        }
    # Linux
    cfg = os.environ.get("XDG_CONFIG_HOME", f"{home}/.config")
    return {
        "chrome":   ("Google Chrome", f"{cfg}/google-chrome", "Chrome"),
        "brave":    ("Brave", f"{cfg}/BraveSoftware/Brave-Browser", "Brave"),
        "chromium": ("Chromium", f"{cfg}/chromium", "Chromium"),
        "edge":     ("Microsoft Edge", f"{cfg}/microsoft-edge", "Microsoft Edge"),
        "vivaldi":  ("Vivaldi", f"{cfg}/vivaldi", "Vivaldi"),
    }


def _firefox_globs():
    home = os.path.expanduser("~")
    if IS_MAC:
        return [f"{home}/Library/Application Support/Firefox/Profiles/*/cookies.sqlite"]
    if IS_WIN:
        ra = os.environ.get("APPDATA", f"{home}\\AppData\\Roaming")
        return [f"{ra}\\Mozilla\\Firefox\\Profiles\\*\\cookies.sqlite"]
    return [f"{home}/.mozilla/firefox/*/cookies.sqlite",
            f"{home}/snap/firefox/common/.mozilla/firefox/*/cookies.sqlite"]


def _profiles_in(base):
    found = []
    for name in ("Default", *(f"Profile {i}" for i in range(1, 15))):
        if os.path.isfile(os.path.join(base, name, "Cookies")) or \
           os.path.isfile(os.path.join(base, name, "Network", "Cookies")):
            found.append(name)
    # Opera guarda o Cookies direto na raiz do perfil
    if not found and os.path.isfile(os.path.join(base, "Cookies")):
        found.append("")
    return found


def _cookies_db(base, profile):
    for cand in (os.path.join(base, profile, "Network", "Cookies"),
                 os.path.join(base, profile, "Cookies"),
                 os.path.join(base, "Cookies")):
        if os.path.isfile(cand):
            return cand
    return None


# ------------------------------------------------------------- ler o SQLite

def _read_sqlite(db_path, query):
    """Copia antes de ler: o navegador aberto mantém lock no arquivo."""
    if not stat.S_ISREG(os.stat(db_path).st_mode):
        raise ImportError_("caminho inválido para banco de cookies")
    with tempfile.TemporaryDirectory() as tmp:
        copy = os.path.join(tmp, "db")
        shutil.copyfile(db_path, copy)
        for ext in ("-wal", "-shm"):
            if os.path.exists(db_path + ext):
                try:
                    shutil.copyfile(db_path + ext, copy + ext)
                except OSError:
                    pass
        con = sqlite3.connect(copy)
        try:
            return con.execute(query).fetchall()
        finally:
            con.close()


# ------------------------------------------------------ chaves por plataforma

def _mac_key(kc_name):
    try:
        out = subprocess.run(
            ["security", "find-generic-password", "-w",
             "-s", f"{kc_name} Safe Storage", "-a", kc_name],
            capture_output=True, timeout=60)
    except (subprocess.TimeoutExpired, FileNotFoundError):
        raise ImportError_("O macOS não respondeu ao pedido de acesso ao Keychain.")
    if out.returncode != 0:
        err = out.stderr.decode(errors="replace")
        if "-25308" in err or "interaction is not allowed" in err:
            raise ImportError_("Autorização do Keychain negada — clique em Permitir na "
                               "janela do macOS e tente de novo.")
        raise ImportError_(f"Chave '{kc_name} Safe Storage' não encontrada no Keychain.")
    pw = out.stdout.rstrip(b"\n")
    return hashlib.pbkdf2_hmac("sha1", pw, b"saltysalt", 1003, 16)


def _win_master_key(base):
    """Desembrulha a chave do Local State com DPAPI."""
    local_state = os.path.join(os.path.dirname(base.rstrip("\\/")), "Local State") \
        if os.path.basename(base) == "User Data" else os.path.join(base, "Local State")
    # o Local State fica na raiz do "User Data"
    for cand in (os.path.join(base, "Local State"),
                 os.path.join(os.path.dirname(base), "Local State"), local_state):
        if os.path.isfile(cand):
            local_state = cand
            break
    with open(local_state, encoding="utf-8") as f:
        enc_key = base64.b64decode(json.load(f)["os_crypt"]["encrypted_key"])
    if enc_key[:5] != b"DPAPI":
        raise ImportError_("Formato inesperado da chave no Local State.")
    return _dpapi_unprotect(enc_key[5:])


def _dpapi_unprotect(blob):
    import ctypes
    from ctypes import wintypes

    class BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD),
                    ("pbData", ctypes.POINTER(ctypes.c_char))]

    buf = ctypes.create_string_buffer(blob, len(blob))
    blob_in = BLOB(len(blob), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    blob_out = BLOB()
    if not ctypes.windll.crypt32.CryptUnprotectData(
            ctypes.byref(blob_in), None, None, None, None, 0,
            ctypes.byref(blob_out)):
        raise ImportError_("DPAPI recusou a chave (perfil do Windows diferente?).")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)


def _linux_keys(kc_name):
    """Candidatas: senha do keyring (v11) e a fixa 'peanuts' (v10). Tenta ambas."""
    keys = {}
    keys[b"v10"] = hashlib.pbkdf2_hmac("sha1", b"peanuts", b"saltysalt", 1, 16)
    secret = _linux_keyring_password(kc_name)
    if secret:
        keys[b"v11"] = hashlib.pbkdf2_hmac("sha1", secret, b"saltysalt", 1, 16)
    return keys


def _linux_keyring_password(kc_name):
    try:
        import secretstorage
    except ImportError:
        return None
    try:
        conn = secretstorage.dbus_init()
        for coll in secretstorage.get_all_collections(conn):
            if coll.is_locked():
                continue
            for item in coll.get_all_items():
                label = (item.get_label() or "").lower()
                if kc_name.lower() in label and "safe storage" in label:
                    return item.get_secret()
    except Exception:
        return None
    return None


# ---------------------------------------------------------- decifrar valores

def _decrypt_chromium(enc, keys_by_version, dpapi_base=None):
    version = enc[:3]
    if version in (b"v10", b"v11"):
        if IS_WIN:                                   # AES-256-GCM
            nonce, ct, tag = enc[3:15], enc[15:-16], enc[-16:]
            raw = crypto_min.gcm_decrypt(keys_by_version["win"], nonce, ct, tag)
        else:
            key = keys_by_version.get(version) or keys_by_version.get(b"v10")
            raw = crypto_min.cbc_decrypt(key, b" " * 16, enc[3:])
        # Chrome ≥130 prefixa 32 bytes de SHA-256 do domínio ao valor, nos três SO
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            return raw[32:].decode("utf-8", "replace")
    if IS_WIN and enc[:4] == b"\x01\x00\x00\x00":    # DPAPI puro (Chrome antigo)
        return _dpapi_unprotect(enc).decode("utf-8", "replace")
    return None


def chromium_cookies(key, profile):
    roots = _chromium_roots()
    if key not in roots:
        raise ImportError_("navegador desconhecido")
    label, base, kc_name = roots[key]
    db = _cookies_db(base, profile)
    if not db:
        raise ImportError_(f"{label}: perfil não encontrado.")

    rows = _read_sqlite(db, "SELECT name, value, encrypted_value FROM cookies "
                            "WHERE host_key LIKE '%instagram.com'")
    if not rows:
        raise ImportError_(f"{label}: nenhum cookie do Instagram nesse perfil.")

    keys, jar, undecryptable = None, {}, False
    for name, plain, enc in rows:
        if name not in WANTED:
            continue
        if plain:
            jar[name] = plain
            continue
        if not enc:
            continue
        # Chrome/Edge ≥127 no Windows blindam com App-Bound Encryption (v20):
        # a chave só abre com DPAPI de SYSTEM, inalcançável por um programa
        # comum. Detecta ANTES do try que engole exceções.
        if IS_WIN and enc[:3] == b"v20":
            raise ImportError_(
                f"{label} no Windows passou a blindar os cookies (a partir da "
                "versão 127) e nenhum programa consegue lê-los sozinho. Use a "
                "Extensão do Chrome aqui em cima — é um clique — ou cole o código "
                "na mão.")
        if keys is None:                             # deriva a chave só uma vez
            try:
                if IS_MAC:
                    keys = {b"v10": _mac_key(kc_name)}
                elif IS_WIN:
                    keys = {"win": _win_master_key(base)}
                else:
                    keys = _linux_keys(kc_name)
            except ImportError_:
                raise
            except Exception as e:
                raise ImportError_(f"{label}: não consegui obter a chave de "
                                   f"criptografia ({type(e).__name__}).")
        try:
            val = _decrypt_chromium(enc, keys)
        except ImportError_:
            raise                                    # mensagem específica passa
        except Exception:
            val = None
        if val:
            jar[name] = val
        elif name == "sessionid":
            undecryptable = True

    if "sessionid" not in jar:
        if undecryptable:
            raise ImportError_(f"{label}: achei o cookie da sua sessão, mas não "
                               "consegui decifrar. Use a Extensão do Chrome — "
                               "é um clique.")
        raise ImportError_(f"{label}: você não está logado no Instagram nesse perfil.")
    return "; ".join(f"{k}={v}" for k, v in jar.items())


# ------------------------------------------------------------------- firefox

def firefox_cookies(db):
    rows = _read_sqlite(db, "SELECT name, value FROM moz_cookies "
                            "WHERE host LIKE '%instagram.com'")
    jar = {n: v for n, v in rows if n in WANTED}
    if "sessionid" not in jar:
        raise ImportError_("Firefox: você não está logado no Instagram nesse perfil.")
    return "; ".join(f"{k}={v}" for k, v in jar.items())


# ----------------------------------------------------------------- descoberta

def available():
    """Navegadores instalados com cookie store legível — para a UI listar."""
    out = []
    for key, (label, base, _) in _chromium_roots().items():
        if not os.path.isdir(base):
            continue
        for profile in _profiles_in(base):
            nice = label if profile in ("", "Default") else f"{label} · {profile}"
            out.append({"key": key, "profile": profile, "label": nice})
    for pattern in _firefox_globs():
        for db in sorted(glob.glob(pattern)):
            name = os.path.basename(os.path.dirname(db))
            nice = "Firefox" if name.endswith(".default-release") \
                else f"Firefox · {name.split('.')[-1]}"
            out.append({"key": "firefox", "profile": db, "label": nice})
    return out


def get_cookie(key, profile):
    if key == "firefox":
        return firefox_cookies(profile)
    return chromium_cookies(key, profile)
