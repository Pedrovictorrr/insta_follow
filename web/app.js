import * as D from "./data.js";
import { lerExportacao } from "./exportacao.js";

/* ─────────────────────────────── helpers ─────────────────────────────── */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function el(tag, props = {}, kids = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of [].concat(kids)) if (c) n.append(c);
  return n;
}

const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
$$(".trust").forEach((ul) => (ul.innerHTML = ul.innerHTML.replaceAll("{{check}}", CHECK)));

function monoEl(u, size) {
  const { hue, letras } = D.monograma(u);
  const n = el("div", { class: `mono s${size}`, text: letras });
  n.style.setProperty("--h", hue);
  return n;
}

const LISTS = [
  ["not_following_back", "Não te seguem de volta", "você segue, eles não", "nfb", "--c-nfb"],
  ["not_followed_back", "Você não segue de volta", "eles seguem, você não", "nfdb", "--c-nfdb"],
  ["mutual", "Mútuos", "vocês dois se seguem", "mut", "--c-mut"],
  ["followers", "Seguidores", "quem te segue", "ers", "--c-ers"],
  ["following", "Seguindo", "quem você segue", "ing", "--c-ing"],
];
const LABEL = Object.fromEntries(LISTS.map((l) => [l[0], l[1]]));
const dataBR = (ms) => (ms ? new Date(ms).toLocaleDateString("pt-BR") : "");

/* ─────────────────────────────── estado ──────────────────────────────── */
let dados = null;     // { dono, followers[], following[] }
let crossed = null;   // saída de cruzar()

const body = document.body;
const setView = (v) => { body.dataset.view = v; window.scrollTo(0, 0); };
const setDrawer = (d) => (body.dataset.drawer = d || "");
$("#scrim").onclick = () => setDrawer("");
$$("[data-close-drawer]").forEach((b) => (b.onclick = () => setDrawer("")));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && body.dataset.drawer) setDrawer(""); });
$("#brand").onclick = () => (crossed ? showReveal() : setView("welcome"));

/* ─────────────────────────────── tema ────────────────────────────────── */
(function initTheme() {
  const saved = D.store.get("iglists:tema", "");
  const apply = (t) => {
    if (t) document.documentElement.setAttribute("data-theme", t);
    else document.documentElement.removeAttribute("data-theme");
    $$("[data-theme-set]").forEach((b) =>
      b.setAttribute("aria-pressed", (b.dataset.themeSet || "") === (t || "") ? "true" : "false"));
  };
  apply(saved);
  $$("[data-theme-set]").forEach((b) => (b.onclick = () => {
    const t = b.dataset.themeSet || "";
    t ? D.store.set("iglists:tema", t) : D.store.del("iglists:tema");
    apply(t);
  }));
})();

/* ─────────────────────────────── liberação (Pix) ─────────────────────── */
// shortcut: a trava é no navegador (as listas já estão na página, só borradas);
// serve pra amigos. Pra vender aberto, o cruzamento teria que ir pro servidor.
const chaveConta = () => "seguidores:liberado:" + (dados?.dono || "conta");
const liberado = () => !!D.store.get(chaveConta(), null);

async function api(acao, params, corpo) {
  const r = await fetch(`api.php?acao=${acao}&` + new URLSearchParams(params || {}), corpo
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) }
    : {});
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.erro || "Não deu pra falar com o servidor. Tente de novo.");
  return d;
}

let espera = null;
function abrirPix() {
  setDrawer("pix");
  const pend = D.store.get("seguidores:pix", null);
  if (pend && pend.conta === (dados?.dono || "conta")) mostrarQr(pend);
  else { $("#pix-form").classList.remove("hidden"); $("#pix-qr").classList.add("hidden"); }
}
$("#pix-cpf").oninput = (e) => {
  const d = e.target.value.replace(/\D/g, "").slice(0, 11);
  e.target.value = d.replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d{1,2})$/, "$1-$2");
};
$("#pix-gerar").onclick = async () => {
  const btn = $("#pix-gerar"), msg = $("#pix-msg");
  msg.textContent = ""; btn.disabled = true; btn.textContent = "Gerando…";
  try {
    const p = await api("cobrar", null, { nome: $("#pix-nome").value, cpf: $("#pix-cpf").value, conta: dados?.dono || "" });
    const pend = { ...p, conta: dados?.dono || "conta" };
    D.store.set("seguidores:pix", pend);
    mostrarQr(pend);
  } catch (e) { msg.textContent = e.message; }
  finally { btn.disabled = false; btn.textContent = "Gerar Pix"; }
};
function mostrarQr(p) {
  $("#pix-form").classList.add("hidden");
  $("#pix-qr").classList.remove("hidden");
  $("#pix-img").src = "data:image/png;base64," + p.imagem;
  $("#pix-code").textContent = p.copiaecola;
  $("#pix-copy").onclick = async () => {
    try { await navigator.clipboard.writeText(p.copiaecola); $("#pix-copy").textContent = "Copiado ✓"; } catch {}
  };
  clearInterval(espera);
  espera = setInterval(async () => {
    try {
      const s = await api("status", { id: p.id, token: p.token });
      if (!s.pago) return;
      clearInterval(espera);
      D.store.set("seguidores:liberado:" + p.conta, p.id);
      D.store.del("seguidores:pix");
      setDrawer("");
      showList("not_following_back");
    } catch { /* rede piscou: tenta no próximo ciclo */ }
  }, 4000);
}

/* ─────────────────────────────── favorito (coleta na aba do Instagram) ─ */
// o link "javascript:" é montado do coletor.js publicado, assim só existe uma fonte
fetch("coletor.js").then((r) => r.text()).then((codigo) => {
  $("#favorito").href = "javascript:" + encodeURIComponent(codigo);
}).catch(() => {});
$("#favorito").onclick = (e) => {
  e.preventDefault();
  alert("Arraste este botão para a barra de favoritos. Depois abra o instagram.com e clique nele lá.");
};

const ORIGENS_IG = ["https://www.instagram.com", "https://instagram.com"];
const USER_OK = /^[A-Za-z0-9._]{1,30}$/;
// validação na fronteira: o postMessage chega de outra origem, aceita só o formato esperado
const limpa = (lista) => (Array.isArray(lista) ? lista : [])
  .filter((u) => u && USER_OK.test(u.username))
  .map((u) => ({ pk: String(u.pk || u.username).slice(0, 30), username: u.username.toLowerCase(),
    full_name: String(u.full_name || "").slice(0, 100), is_private: !!u.is_private, is_verified: !!u.is_verified }));

window.addEventListener("message", (e) => {
  if (!ORIGENS_IG.includes(e.origin) || !e.data || typeof e.data !== "object") return;
  const m = e.data;
  if (m.tipo === "progresso") {
    if (body.dataset.view !== "coleta") setView("coleta");
    $("#co-titulo").textContent = m.kind === "followers" ? "Lendo quem te segue…" : "Lendo quem você segue…";
    $("#co-ers").textContent = D.nf(m.followers);
    $("#co-ing").textContent = D.nf(m.following);
    $("#co-nota").textContent = "Deixe a aba do Instagram aberta até terminar. Dá pra usar o computador normalmente.";
  } else if (m.tipo === "pausa") {
    if (body.dataset.view !== "coleta") setView("coleta");
    $("#co-nota").textContent = `O Instagram pediu uma pausa. Continua sozinho em ${m.segundos}s.`;
  } else if (m.tipo === "erro") {
    falha("O Instagram não deixou continuar agora", String(m.mensagem || "") +
      " Enquanto isso, dá pra usar o arquivo oficial do Instagram (a opção de baixo na tela inicial).");
  } else if (m.tipo === "fim") {
    e.source?.postMessage({ tipo: "recebido" }, e.origin);
    if (dados?.recebido) return;   // reenvios do coletor
    const followers = limpa(m.followers), following = limpa(m.following);
    if (!followers.length && !following.length) return falha("As listas vieram vazias",
      "Confira se a aba do Instagram está logada na sua conta e tente de novo.");
    dados = { dono: USER_OK.test(m.dono || "") ? m.dono.toLowerCase() : null, followers, following, recebido: true };
    crossed = D.cruzar(followers, following);
    showReveal();
  }
});
if (location.hash === "#coleta") setView("coleta");
window.addEventListener("hashchange", () => { if (location.hash === "#coleta" && !dados) setView("coleta"); });

/* ─────────────────────────────── upload ──────────────────────────────── */
const drop = $("#drop");
$("#arquivo").onchange = (e) => carregar(e.target.files);
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("on"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove("on")));
drop.addEventListener("drop", (e) => { e.preventDefault(); carregar(e.dataTransfer.files); });

async function carregar(files) {
  if (!files || !files.length) return;
  setView("ler");
  try {
    const r = await lerExportacao(files);
    if (r.faltando) return falha(
      r.faltando === "followers" ? "Não achei a lista de seguidores no arquivo" : "Não achei a lista de quem você segue no arquivo",
      "Confira se na exportação ficou marcado “Seguidores e seguindo”. Se mandou os arquivos soltos, mande o followers_1 e o following juntos.");
    if (!r.followers.length && !r.following.length) return falha("O arquivo veio vazio",
      "Escolha “Desde o início” no intervalo de datas e peça a exportação de novo.");
    dados = r;
    crossed = D.cruzar(r.followers, r.following);
    showReveal();
  } catch (e) {
    falha("Não consegui ler esse arquivo", e.message === "zip64"
      ? "Esse zip é a exportação completa, grande demais. Peça de novo marcando só “Seguidores e seguindo”."
      : "Mande o .zip que o Instagram enviou, sem abrir nem renomear. Se você escolheu HTML, funciona também.");
  } finally { $("#arquivo").value = ""; }
}
function falha(titulo, causa) {
  $("#fail-title").textContent = titulo;
  $("#fail-cause").textContent = causa;
  setView("fail");
}
$("#fail-back").onclick = () => setView("welcome");
$("#rv-outro").onclick = () => { dados = null; crossed = null; history.replaceState(null, "", location.pathname); setView("welcome"); };

/* ─────────────────────────────── revelação ───────────────────────────── */
const count = (name) => (crossed ? crossed[name].length : 0);

function showReveal() {
  setView("reveal");
  $("#rv-fresh").textContent = dados.dono ? `@${dados.dono}` : "sua conta";
  const following = count("following"), mutual = count("mutual"), nfb = count("not_following_back");
  const recip = following ? (mutual / following) * 100 : 0;

  const hero = $("#rv-hero");
  hero.className = "hero"; hero.innerHTML = "";
  hero.append(
    el("p", { class: "ctx", html: `Você segue <b>${D.nf(following)}</b> contas.<br>${D.nf(mutual)} seguem você de volta.` }),
    el("div", { class: "recip" }, [
      el("div", { class: "bar" }, Object.assign(el("i"), { style: `width:${recip}%` })),
      el("span", { class: "pct", text: recip.toFixed(1).replace(".", ",") + "%" }),
    ]),
    el("div", { class: "hero-num", text: D.nf(nfb) }),
    el("div", { class: "hero-num-sub", text: nfb ? "não seguem você de volta"
      : "— todo mundo que você segue te segue de volta. Sério." }),
  );
  const verif = crossed.not_following_back.filter((u) => u.is_verified).length;
  if (verif) hero.append(el("div", { class: "subtract" }, [
    row("− verificados (clubes, artistas, marcas)", verif),
    Object.assign(row("= contas comuns", nfb - verif), { className: "r total" }),
  ]));

  // prévia borrada + botão de pagar, até liberar
  const gate = $("#rv-gate"); gate.innerHTML = "";
  if (!liberado() && nfb) {
    const prev = el("div", { class: "people" });
    crossed.not_following_back.slice(0, 8).forEach((u) => prev.append(personRow(u)));
    gate.append(el("div", { class: "locked-list card" }, [prev, el("div", { class: "unlock" }, [
      el("b", { text: `Ver os ${D.nf(nfb)} nomes` }),
      el("button", { class: "btn primary", style: "width:auto", text: "Liberar por R$ 27,90 no Pix", onclick: abrirPix }),
      el("span", { class: "note", text: "pagamento único pra esta conta · libera todas as listas" }),
    ])]));
  }
  $("#rv-lists").textContent = liberado() ? "Ver todas as listas" : "Liberar as listas";
  $("#rv-lists").onclick = () => (liberado() ? showList("not_following_back") : abrirPix());

  const nfdb = count("not_followed_back");
  const mini = $("#rv-mini"); mini.innerHTML = "";
  mini.append(
    el("div", {}, [el("span", { class: "n", text: D.nf(nfdb) + "  " }), el("h3", { text: "Só te seguem" })]),
    el("p", { class: "desc", text: "Te seguem e você não segue de volta. Em conta pública, isso é o normal." }),
    el("p", { class: "breakdown", text: `${D.nf(count("followers"))} seguidores · ${D.nf(mutual)} mútuos` }),
  );
}

function row(k, v) {
  return el("div", { class: "r" }, [el("span", { class: "k", text: k }), el("span", { text: D.nf(v) })]);
}

/* ─────────────────────────────── placar + lista ──────────────────────── */
let curList = "not_following_back", shown = 200, filtered = [];

function showList(name) {
  if (!liberado()) return abrirPix();
  curList = name; shown = 200;
  setView("list");
  renderRail();
  renderPanel();
}
function renderRail() {
  const cb = $("#crossbar"); cb.innerHTML = "";
  const seg = (v, c) => { const s = el("span"); s.style.flex = v || 0.001; s.style.background = `var(${c})`; return s; };
  cb.append(seg(count("not_following_back"), "--c-nfb"), seg(count("mutual"), "--c-mut"), seg(count("not_followed_back"), "--c-nfdb"));
  $("#crosskey").innerHTML = `<span>você segue</span><span>mútuos</span><span>te seguem</span>`;
  const box = $("#scorecards"); box.innerHTML = "";
  LISTS.forEach(([key, label, leg, cls], i) => {
    if (i === 3) box.append(el("div", { class: "divider", text: "listas completas" }));
    box.append(el("button", {
      class: `scorecard ${cls}`, "aria-pressed": key === curList ? "true" : "false", onclick: () => showList(key),
    }, [
      el("div", { class: "n", text: D.nf(count(key)) }),
      el("div", { class: "nm", text: label }),
      el("div", { class: "leg", text: leg }),
    ]));
  });
}
function renderPanel() {
  const list = crossed[curList] || [];
  $("#lp-title").textContent = LABEL[curList];
  const q = $("#lp-search").value.trim().toLowerCase().replace(/^@/, "");
  filtered = q ? list.filter((u) => u.username.includes(q)) : list.slice();
  const sort = $("#lp-sort").value;
  filtered.sort((a, b) => {
    if (sort === "novos" || sort === "antigos") {
      const d = (quando(b) || 0) - (quando(a) || 0);
      if (d) return sort === "novos" ? d : -d;
    }
    const c = a.username.localeCompare(b.username);
    return sort === "za" ? -c : c;
  });
  $("#lp-count").textContent = q ? `${D.nf(filtered.length)} de ${D.nf(list.length)}` : D.nf(list.length);
  renderPeople();
}
// data da exportação: quando você seguiu (no "seguindo") ou quando te seguiu (no "seguidores")
const quando = (u) => u.quando;

function renderPeople() {
  const box = $("#lp-people"); box.innerHTML = "";
  if (!filtered.length) {
    box.append(el("div", { class: "empty" }, [el("p", { text: $("#lp-search").value.trim()
      ? "Ninguém com esse @ nesta lista." : "Lista vazia." })]));
    $("#lp-more").classList.add("hidden");
    return;
  }
  filtered.slice(0, shown).forEach((u) => box.append(personRow(u)));
  $("#lp-more").classList.toggle("hidden", filtered.length <= shown);
}
function personRow(u) {
  const row = el("div", { class: "person" });
  row.append(monoEl(u, 32));
  row.append(el("div", { class: "id" }, [el("div", { class: "at", text: "@" + u.username }),
    u.full_name && el("div", { class: "nm", text: u.full_name })]));
  const selos = el("div", { class: "row", style: "gap:4px" });
  if (u.is_verified) selos.append(el("span", { class: "badge v", text: "verificado" }));
  if (u.is_private) selos.append(el("span", { class: "badge", text: "privado" }));
  row.append(selos);
  if (u.quando) row.append(el("span", { class: "when", text: dataBR(u.quando) }));
  row.append(el("div", { class: "acts" }, [el("a", { class: "iconlink", href: `https://www.instagram.com/${u.username}/`,
    target: "_blank", rel: "noopener noreferrer", title: "abrir no Instagram", text: "↗" })]));
  return row;
}
$("#lp-search").oninput = renderPanel;
$("#lp-sort").onchange = renderPanel;
$("#lp-morebtn").onclick = () => { shown += 200; renderPeople(); };

// export no próprio navegador
$("#lp-export").onclick = (e) => {
  e.stopPropagation();
  const m = $("#lp-exportmenu");
  m.classList.toggle("hidden");
  if (m.classList.contains("hidden")) return;
  m.innerHTML = "";
  const nome = `${dados.dono || "instagram"}-${LABEL[curList].toLowerCase().replace(/\s+/g, "-")}`;
  const lista = crossed[curList];
  const fmts = [
    ["csv", "Planilha, para abrir no Excel (CSV)", () => "﻿username,link,data\n" +
      lista.map((u) => `${u.username},https://instagram.com/${u.username},${dataBR(quando(u))}`).join("\n"), "text/csv"],
    ["txt", "Só os @, um por linha (TXT)", () => lista.map((u) => "@" + u.username).join("\n"), "text/plain"],
  ];
  fmts.forEach(([ext, label, gerar, tipo]) => m.append(el("a", { text: label, href: "#", onclick: (ev) => {
    ev.preventDefault();
    const a = el("a", { href: URL.createObjectURL(new Blob([gerar()], { type: tipo })), download: `${nome}.${ext}` });
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } })));
};
document.addEventListener("click", () => $("#lp-exportmenu").classList.add("hidden"));
