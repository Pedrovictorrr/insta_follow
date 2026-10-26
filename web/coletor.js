// coletor.js — roda como favorito (bookmarklet) DENTRO da aba do instagram.com.
// Usa a sessão já logada no navegador da pessoa (o cookie nunca sai dela) e manda
// só as listas prontas pra aba do site, por postMessage. A página monta o link
// "javascript:" a partir deste arquivo; mantenha-o autocontido (sem import).
(async () => {
  const SITE = "https://seguidores.cwsystems.com.br";
  if (!/(^|\.)instagram\.com$/.test(location.hostname)) {
    alert("Abra o instagram.com (logado na sua conta) e clique no favorito de novo.");
    return;
  }
  if (window.__seguidores) return; // já está rodando nesta aba
  window.__seguidores = true;

  const uid = (document.cookie.match(/ds_user_id=(\d+)/) || [])[1];
  const csrf = (document.cookie.match(/csrftoken=([^;]+)/) || [])[1] || "";
  if (!uid) { alert("Você não está logado no Instagram nesta aba."); window.__seguidores = false; return; }
  const dono = ((document.documentElement.innerHTML.match(/"username":"([A-Za-z0-9._]+)"/) || [])[1] || "").toLowerCase();

  // janela do resultado: aberta agora, no clique (depois o bloqueador de pop-up barraria)
  let win = window.open(SITE + "/#coleta", "seguidores");

  // aviso na própria aba do Instagram
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:320px;padding:14px 16px;" +
    "border-radius:14px;background:#171b23;color:#fff;font:14px/1.45 system-ui,sans-serif;box-shadow:0 12px 48px rgba(0,0,0,.35)";
  document.body.appendChild(box);
  const aviso = (html) => (box.innerHTML = "<b>Quem não me segue</b><br>" + html);

  const envia = (msg) => { try { if (win && !win.closed) win.postMessage(msg, SITE); } catch (e) {} };
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));

  async function pagina(kind, count, maxId) {
    const q = new URLSearchParams({ count, search_surface: "follow_list_page" });
    if (maxId) q.set("max_id", maxId);
    let pausa = 60;
    for (let t = 1; t <= 5; t++) {
      const r = await fetch(`/api/v1/friendships/${uid}/${kind}/?${q}`, {
        credentials: "include",
        headers: { "X-IG-App-ID": "936619743392459", "X-CSRFToken": csrf, "X-Requested-With": "XMLHttpRequest" },
      });
      const tipo = r.headers.get("content-type") || "";
      if (r.ok && tipo.includes("json")) return r.json();
      // 429, ou HTML no lugar do JSON: o Instagram está segurando — espera e tenta de novo
      for (let s = pausa; s > 0; s--) {
        aviso(`O Instagram pediu uma pausa. Continuo em ${s}s (tentativa ${t} de 5)…`);
        envia({ tipo: "pausa", segundos: s });
        await espera(1000);
      }
      pausa = Math.min(pausa * 2, 600);
    }
    throw new Error("O Instagram não deixou continuar agora. Tente de novo daqui a algumas horas.");
  }

  // seguidores vêm completos numa passada; "seguindo" varia, então 2 passadas com tamanhos diferentes
  const plano = [["followers", 50], ["following", 50], ["following", 100]];
  const listas = { followers: new Map(), following: new Map() };
  try {
    for (const [kind, count] of plano) {
      let maxId = null;
      do {
        const d = await pagina(kind, count, maxId);
        for (const u of d.users || [])
          listas[kind].set(String(u.pk), { pk: String(u.pk), username: u.username, full_name: u.full_name || "",
            is_private: !!u.is_private, is_verified: !!u.is_verified });
        maxId = (d.users || []).length ? d.next_max_id : null;
        const n = { followers: listas.followers.size, following: listas.following.size };
        aviso(`Lendo ${kind === "followers" ? "quem te segue" : "quem você segue"}…<br>` +
          `${n.followers} seguidores · ${n.following} seguindo<br><small>Não feche esta aba.</small>`);
        envia({ tipo: "progresso", kind, ...n });
        await espera(3000 + Math.random() * 2000); // ~4 s por página: no teste, 1,5–2,7 s levou pausa depois de ~47 páginas
      } while (maxId);
    }
  } catch (e) {
    aviso(e.message);
    envia({ tipo: "erro", mensagem: e.message });
    window.__seguidores = false;
    return;
  }

  const fim = { tipo: "fim", dono, followers: [...listas.followers.values()], following: [...listas.following.values()] };
  // reenvia até a página confirmar (ela pode ainda estar carregando)
  let ok = false;
  window.addEventListener("message", (e) => { if (e.origin === SITE && e.data && e.data.tipo === "recebido") ok = true; });
  const abrir = () => { win = window.open(SITE + "/#coleta", "seguidores"); };
  aviso(`Pronto! ${fim.followers.length} seguidores · ${fim.following.length} seguindo.<br>`);
  const b = document.createElement("button");
  b.textContent = "Ver resultado";
  b.style.cssText = "margin-top:8px;padding:8px 12px;border:0;border-radius:10px;background:#d6336c;color:#fff;font-weight:600;cursor:pointer";
  b.onclick = abrir; // se o pop-up foi bloqueado, este clique abre
  box.appendChild(b);
  for (let i = 0; i < 300 && !ok; i++) { envia(fim); await espera(1000); }
  if (ok) aviso("Pronto! O resultado abriu na outra aba.");
  window.__seguidores = false;
})();
