// Só o necessário para autenticar — não manda o resto dos cookies do domínio.
const WANTED = ["sessionid", "csrftoken", "ds_user_id", "mid", "ig_did", "datr"];

const $ = (id) => document.getElementById(id);
const msg = (text, cls = "") => { $("msg").textContent = text; $("msg").className = cls; };

chrome.storage.local.get("port", ({ port }) => { if (port) $("port").value = port; });

$("send").onclick = async () => {
  const port = $("port").value.trim() || "8765";
  chrome.storage.local.set({ port });
  $("send").disabled = true;
  msg("lendo cookies…");

  try {
    const all = await chrome.cookies.getAll({ domain: "instagram.com" });
    const picked = WANTED
      .map((name) => all.find((c) => c.name === name))
      .filter(Boolean);

    if (!picked.some((c) => c.name === "sessionid")) {
      msg("Você não está logado no Instagram neste Chrome.", "err");
      $("send").disabled = false;
      return;
    }

    const cookie = picked.map((c) => `${c.name}=${c.value}`).join("; ");
    msg("enviando…");

    const r = await fetch(`http://127.0.0.1:${port}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookie, source: "extensão do Chrome" }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);

    msg(`✓ conectado como @${data.profile.username} — volte para a aba do ig-lists`, "ok");
  } catch (e) {
    const dead = e instanceof TypeError;   // fetch não conseguiu conectar
    msg(dead ? `O ig-lists não respondeu na porta ${port}. Ele está rodando?`
             : e.message, "err");
  } finally {
    $("send").disabled = false;
  }
};
