import { api, stream, ApiError } from "/static/api.js";
import * as D from "/static/data.js";

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
// substitui os {{check}} do HTML por SVG
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

/* ─────────────────────────────── estado ──────────────────────────────── */
let session = null;
let data = null;       // { profile, updated, followers[], following[] }
let crossed = null;    // saída de cruzar()
let jobHandle = null;

/* ─────────────────────────────── router ──────────────────────────────── */
const body = document.body;
const setView = (v) => { body.dataset.view = v; window.scrollTo(0, 0); };
const setDrawer = (d) => (body.dataset.drawer = d || "");
$("#scrim").onclick = () => setDrawer("");
$$("[data-close-drawer]").forEach((b) => (b.onclick = () => setDrawer("")));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && body.dataset.drawer) setDrawer("");
});

// brand = voltar ao resumo, quando há dados cruzados
$("#brand").onclick = () => {
  if (crossed && collected("followers") && collected("following")) showReveal();
};

/* ─────────────────────────────── tema ────────────────────────────────── */
function initTheme() {
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
}

/* ─────────────────────────────── boot ────────────────────────────────── */
async function boot() {
  initTheme();
  wireStatic();
  await refresh(true);
}

async function refresh(initial = false) {
  session = await api.session().catch(() => ({ authenticated: false }));
  data = await api.lists().catch(() => null);
  paintWho();

  // coleta em andamento (voltou de um F5)? re-encaixa.
  const running = (await api.jobs().catch(() => ({ jobs: [] }))).jobs;
  if (session.authenticated && running.length) {
    resumeCollect(running[0]);
    return;
  }

  const hasBoth = data && data.followers.length && data.following.length && !data.foreign;
  if (session.authenticated) {
    if (hasBoth) { buildCross(); showReveal(); }
    else showConfirm();
  } else {
    if (data && (data.followers.length || data.following.length) && !data.foreign)
      { /* dados de sessão anterior visíveis? só se identidade destravou; senão cai aqui */ }
    if (initial && !D.store.get("iglists:visto", false)) setView("welcome");
    else showConnect();
  }
}

function paintWho() {
  const w = $("#who");
  if (session?.authenticated && session.profile) {
    const p = session.profile;
    w.classList.remove("hidden");
    w.innerHTML = `<b>@${p.username}</b> · ${D.nf(p.followers)} seguidores · ${D.nf(p.following)} seguindo`;
  } else w.classList.add("hidden");
}

/* ───────────────────────────── boas-vindas ───────────────────────────── */
$("#go-connect").onclick = () => { D.store.set("iglists:visto", true); showConnect(); };
$("#welcome-safety").onclick = () => setDrawer("safety");

/* ─────────────────────────────── conectar ────────────────────────────── */
function labelBrowser(key) {
  const m = { chrome: "Google Chrome", brave: "Brave", edge: "Microsoft Edge",
    arc: "Arc", vivaldi: "Vivaldi", chromium: "Chromium", opera: "Opera", firefox: "Firefox" };
  return m[key] || "navegador";
}

async function showConnect() {
  setView("connect");
  // caminho do extension para o passo a passo
  if (session?.root) {
    const path = session.root.replace(/\/?$/, "") + "/extension";
    $("#extpath").textContent = path;
    $("#copy-extpath").onclick = () => copy(path, $("#copy-extpath"));
  }
  let browsers = [];
  try { browsers = (await api.browsers()).browsers; } catch {}

  // botão primário: navegador que casa com o user-agent, senão o primeiro
  const box = $("#primary-connect");
  box.innerHTML = "";
  if (browsers.length) {
    const ua = navigator.userAgent.toLowerCase();
    const guess =
      browsers.find((b) => ua.includes("edg") && b.key === "edge") ||
      browsers.find((b) => ua.includes("brave") && b.key === "brave") ||
      browsers.find((b) => b.key === "chrome") || browsers[0];
    box.append(el("button", {
      class: "btn primary", text: `Entrar pelo ${labelBrowser(guess.key)}`,
      onclick: (e) => importFrom(guess, e.currentTarget),
    }));
    // demais navegadores no <details>
    const others = $("#browsers");
    others.innerHTML = "";
    browsers.filter((b) => b !== guess).forEach((b) =>
      others.append(el("button", { class: "btn block", text: `Entrar pelo ${b.label}`,
        onclick: (e) => importFrom(b, e.currentTarget) })));
    if (browsers.length <= 1) $("#other-browsers").classList.add("hidden");
    else $("#other-browsers").classList.remove("hidden");
  } else {
    box.append(el("p", { class: "note", text:
      "Não achei um navegador com sessão do Instagram. Use um dos jeitos abaixo." }));
    $("#other-browsers").classList.add("hidden");
    $("#fallbacks").open = true;
  }
}

let lastImport = null;   // para a recuperação de "não descobri seu @"
async function importFrom(b, btn, username) {
  const before = btn ? btn.textContent : "";
  if (btn) btn.disabled = true;
  lastImport = { browser: b.key, profile: b.profile };
  // no Mac, o import dispara o prompt do Keychain — mostra a tela dedicada
  if (session?.platform === "darwin") showKeychain();
  else if (btn) btn.textContent = "entrando…";
  try {
    await api.importFrom(b.key, b.profile, username);
    stopKeychain();
    await afterConnect();
  } catch (e) {
    stopKeychain();
    if (btn) { btn.disabled = false; btn.textContent = before; }
    showFail(e);
  }
}

$("#paste-connect").onclick = async (e) => {
  const btn = e.currentTarget, msg = $("#paste-msg");
  msg.textContent = "verificando…"; btn.disabled = true;
  try {
    await api.authManual($("#cookie").value.trim(), $("#username").value.trim());
    $("#cookie").value = ""; msg.textContent = "";
    await afterConnect();
  } catch (err) { msg.textContent = err.message; }
  finally { btn.disabled = false; }
};

$$("[data-copy]").forEach((b) => (b.onclick = () => copy(b.dataset.copy, b)));
async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); const t = btn.textContent;
    btn.textContent = "copiado!"; setTimeout(() => (btn.textContent = t), 1200); } catch {}
}

// polling para a extensão: enquanto estiver na tela de conectar sem sessão
setInterval(async () => {
  if (body.dataset.view !== "connect") return;
  const s = await api.session().catch(() => null);
  if (s?.authenticated) { session = s; await afterConnect(); }
}, 2500);

async function afterConnect() {
  session = await api.session();
  data = await api.lists().catch(() => null);
  paintWho();
  buildCross();
  if (data && data.followers.length && data.following.length && !data.foreign) showReveal();
  else showConfirm();
}

/* ─────────────────────────────── keychain ────────────────────────────── */
let kcTimer = null;
function showKeychain() {
  setView("keychain");
  const arc = $("#kc-arc"), count = $("#kc-count"), hint = $("#kc-hint");
  const C = 2 * Math.PI * 52;
  let t = 60;
  const tick = () => {
    count.textContent = t + "s";
    arc.style.strokeDashoffset = C * (1 - t / 60);
    if (t === 45) hint.innerHTML =
      'Não achou a janela? Aperte <kbd>⌘ Tab</kbd> para procurar. Em 15s o app tenta de novo.';
    if (t <= 0) { clearInterval(kcTimer); return; }
    t--;
  };
  arc.style.strokeDasharray = C; tick();
  kcTimer = setInterval(tick, 1000);
}
function stopKeychain() { if (kcTimer) { clearInterval(kcTimer); kcTimer = null; } }
$("#kc-cancel").onclick = () => { stopKeychain(); showConnect(); };

/* ─────────────────────────────── confirmar ───────────────────────────── */
function collectOpts() {
  return {
    passes: +$("#opt-passes").value,
    delay: +$("#opt-delay").value,
    max_pages: $("#opt-test").checked ? 2 : 0,
  };
}
function showConfirm() {
  const p = session.profile;
  setView("confirm");
  $("#cf-mono").replaceWith(Object.assign(monoEl(p, 56), { id: "cf-mono" }));
  $("#cf-user").textContent = "@" + p.username;
  $("#cf-name").textContent = p.full_name || "";
  $("#cf-ers").textContent = D.nf(p.followers);
  $("#cf-ing").textContent = D.nf(p.following);
  updateEta();
  $("#opt-passes").onchange = $("#opt-delay").onchange = updateEta;
}
function updateEta() {
  const p = session.profile, o = collectOpts();
  const seg = D.estimarSegundos(p, o.passes, o.delay);
  $("#cf-eta").innerHTML = o.max_pages
    ? "🕐 Modo teste: vai ser rápido, mas incompleto."
    : `🕐 Ler tudo isso vai levar ${D.tempoHumano(seg)}. Dá para usar o computador normalmente — só não feche esta aba.`;
}
$("#cf-go").onclick = () => runCollect(["followers", "following"]);
$("#cf-switch").onclick = async () => { await api.logout(); await refresh(); };
$$("[data-only]").forEach((b) => (b.onclick = () => runCollect([b.dataset.only])));

/* ─────────────────────────────── coletando ───────────────────────────── */
const KIND_TITLE = {
  followers: "Lendo quem te segue…",
  following: "Lendo quem você segue…",
};
let segMeta = [], segFill = [], collectState = null;

function buildPlan(kinds) {
  const p = session.profile, o = collectOpts();
  segMeta = [];
  if (kinds.includes("followers"))
    segMeta.push({ kind: "followers", pass: 1, est: Math.max(1, Math.ceil((p.followers || 0) / 50)) });
  if (kinds.includes("following")) {
    const sizes = [50, 200, 100, 75];
    for (let i = 0; i < o.passes; i++)
      segMeta.push({ kind: "following", pass: i + 1, est: Math.max(1, Math.ceil((p.following || 0) / sizes[i % 4])) });
  }
  segFill = segMeta.map(() => 0);
  renderSegbar();
}
function renderSegbar() {
  const bar = $("#col-bar"); bar.innerHTML = "";
  const totalEst = segMeta.reduce((a, s) => a + s.est, 0) || 1;
  segMeta.forEach((s, i) => {
    const seg = el("div", { class: "seg" }, el("i"));
    seg.style.flex = s.est / totalEst;
    seg.firstChild.style.width = (segFill[i] * 100) + "%";
    bar.append(seg);
  });
}
function setSeg(i, frac) {
  for (let k = 0; k < i; k++) segFill[k] = 1;
  segFill[i] = Math.min(1, frac);
  const segs = $$("#col-bar .seg");
  segs.forEach((s, k) => (s.firstChild.style.width = (segFill[k] * 100) + "%"));
}

async function runCollect(kinds, forcedOpts) {
  const o = forcedOpts || collectOpts();
  buildPlan(kinds);
  setView("collecting");
  $("#col-log").textContent = "";
  logLine(`▸ coletando ${kinds.join(" e ")} (${o.passes} passada${o.passes > 1 ? "s" : ""})`);
  // guarda o plano para sobreviver a um F5 no meio de "buscar as duas"
  D.store.set("iglists:plano", { kinds, o });
  window.addEventListener("beforeunload", beforeUnload);
  collectState = { kinds, o, i: 0, tRate: null, seenPasses: 0 };
  for (const kind of kinds) {
    const ok = await collectOne(kind, o);
    if (!ok) { window.removeEventListener("beforeunload", beforeUnload); return; }
  }
  window.removeEventListener("beforeunload", beforeUnload);
  await finishCollect();
}

function segIndexFor(kind, pass) {
  return segMeta.findIndex((s) => s.kind === kind && s.pass === pass);
}

function collectOne(kind, o) {
  return new Promise(async (resolve) => {
    let started;
    try { started = await api.collect({ kind, ...o }); }
    catch (e) { showFail(e); return resolve(false); }
    const expected = kind === "followers" ? session.profile.followers : session.profile.following;
    $("#col-step").textContent = collectState.kinds.length > 1
      ? `Etapa ${collectState.kinds.indexOf(kind) + 1} de ${collectState.kinds.length}` : "";
    $("#col-title").textContent = KIND_TITLE[kind];
    let lastEta = 0, t0 = performance.now(), firstTotal = 0;

    jobHandle = stream(started.job, {
      onProgress(d) {
        exitPause();
        $("#col-num").textContent = D.nf(d.total);
        const si = segIndexFor(kind, d.pass);
        if (si >= 0) setSeg(si, d.page / segMeta[si].est);
        if (kind === "following" && d.pass >= 2 && collectState.seenPasses < d.pass) {
          collectState.seenPasses = d.pass;
          $("#col-title").textContent = d.pass === d.passes
            ? `Última conferida (${d.pass}ª de ${d.passes})`
            : `Conferindo de novo (${d.pass}ª de ${d.passes})`;
          if (d.pass === 2) logLine("  o Instagram entrega essa lista em pedaços diferentes a cada vez; passamos várias vezes e juntamos tudo.", "o");
        }
        // ETA pelo ritmo real
        if (!firstTotal) { firstTotal = d.total; t0 = performance.now(); }
        else {
          const rate = (d.total - firstTotal) / ((performance.now() - t0) / 1000);
          if (rate > 0 && expected) {
            const eta = (expected - d.total) / rate;
            if (Math.abs(eta - lastEta) > 30 || !lastEta) {
              lastEta = eta;
              $("#col-eta").textContent = eta > 5 ? `faltam ${D.tempoHumano(eta)}` : "quase lá…";
            }
          }
        }
      },
      onWarn(d) {
        if (d.reason === "rate_limit") enterPause(d);
        else logLine("  " + d.message, "w"); // modo teste etc.
      },
      onPassDone(d) { logLine(`  passada ${d.pass}: +${d.gained} (total ${d.total})`); },
      onDone(d) {
        const si = segIndexFor(kind, kind === "following" ? d.passes || 1 : 1);
        if (si >= 0) setSeg(si, 1);
        logLine(`  ✓ ${D.nf(d.total)} ${kind === "followers" ? "seguidores" : "seguindo"} coletados`, "o");
        resolve(true);
      },
      onError(d) { showFail(new ApiError(d.message)); resolve(false); },
      onLost() { showFail(new ApiError("__lost__")); resolve(false); },
    });
  });
}

function enterPause(d) {
  setView("paused");
  $("#col-pause").classList.remove("hidden");
  $("#col-warnbox").classList.add("warn");
  $("#col-title").textContent = `Pausa de ${d.wait >= 60 ? Math.round(d.wait / 60) + " minuto" + (d.wait >= 120 ? "s" : "") : d.wait + " segundos"}`;
  $("#col-pausenote").textContent = "O Instagram pediu para ir mais devagar. É normal em listas grandes e não é bloqueio da sua conta. O app continua sozinho quando o tempo acabar.";
  let t = d.wait;
  clearInterval(enterPause._i);
  const tick = () => {
    $("#col-countdown").textContent = D.mmss(t);
    if (t-- <= 0) clearInterval(enterPause._i);
  };
  tick(); enterPause._i = setInterval(tick, 1000);
  if (d.attempt >= 3) logLine(`  já foram ${d.attempt} pausas; no limite de ${d.of} o app para e avisa.`, "w");
}
function exitPause() {
  if (body.dataset.view === "paused") {
    setView("collecting");
    $("#col-pause").classList.add("hidden");
    $("#col-warnbox").classList.remove("warn");
    clearInterval(enterPause._i);
  }
}

async function finishCollect() {
  D.store.del("iglists:plano");
  data = await api.lists();
  buildCross();
  markSnapshotForDiff();
  showReveal();
}

function beforeUnload(e) { e.preventDefault(); e.returnValue = ""; }
$("#col-details").onclick = () => $("#col-log").classList.toggle("hidden");
$("#col-stop").onclick = async () => {
  if (!confirm("Parar agora descarta o que já veio nesta etapa. As listas de antes continuam salvas. Parar mesmo?")) return;
  if (jobHandle) jobHandle.close();
  const jobs = (await api.jobs().catch(() => ({ jobs: [] }))).jobs;
  for (const j of jobs) await api.cancel(j.id);
  D.store.del("iglists:plano");
  logLine("cancelado", "w");
  window.removeEventListener("beforeunload", beforeUnload);
  await refresh();
};
function logLine(msg, cls = "") {
  const log = $("#col-log");
  log.append(el("span", { class: cls, text: msg + "\n" }));
  log.scrollTop = log.scrollHeight;
}

// re-encaixe após F5
function resumeCollect(job) {
  setView("collecting");
  $("#col-title").textContent = KIND_TITLE[job.kind] || "Coletando…";
  if (job.last) { $("#col-num").textContent = D.nf(job.last.total || 0); }
  logLine("↩ reconectado a uma coleta em andamento");
  buildPlan([job.kind]);
  jobHandle = stream(job.id, {
    onProgress(d) { $("#col-num").textContent = D.nf(d.total);
      const si = segIndexFor(job.kind, d.pass); if (si >= 0) setSeg(si, d.page / segMeta[si].est); },
    onWarn(d) { d.reason === "rate_limit" ? enterPause(d) : logLine("  " + d.message, "w"); },
    onDone: async () => {
      // se a coleta era "as duas" e o F5 caiu na 1ª, continua a que falta
      const plano = D.store.get("iglists:plano", null);
      data = await api.lists(); buildCross();
      const resto = plano ? plano.kinds.filter((k) => k !== job.kind && !collected(k)) : [];
      if (resto.length) return runCollect(resto, plano.o);
      await finishCollect();
    },
    onError: (d) => showFail(new ApiError(d.message)),
    onLost: () => showFail(new ApiError("__lost__")),
  });
}

/* ─────────────────────────────── crossing ────────────────────────────── */
function buildCross() {
  if (!data || !data.followers) { crossed = null; return; }
  crossed = D.cruzar(data.followers, data.following);
}
function count(name) { return crossed ? crossed[name].length : 0; }
function collected(kind) { return !!(data?.updated && data.updated[kind]); }

/* ─────────────────────────────── revelação ───────────────────────────── */
function markSnapshotForDiff() {
  // guarda os pk atuais de "não te seguem" para o diff da próxima vez
  const prev = D.store.get("iglists:anterior", null);
  const now = crossed.not_following_back.map((u) => u.pk);
  if (prev) window._novos = now.filter((pk) => !prev.includes(pk));
  D.store.set("iglists:anterior", now);
}

function showReveal() {
  setView("reveal");
  const p = data.profile || session.profile;
  const normais = D.marks("normais");

  $("#rv-fresh").textContent = `@${p.username} · coletado ${D.relativo(data.updated.following || data.updated.followers)}`;
  const stale = data.updated.following &&
    (Date.now() - new Date(data.updated.following.replace(" ", "T"))) / 86400000 > 7;
  $("#rv-fresh").style.color = stale ? "var(--warn)" : "";

  const hero = $("#rv-hero");
  const faltando = !collected("following") ? "following" : !collected("followers") ? "followers" : null;
  if (faltando) {
    hero.className = "hero locked";
    hero.innerHTML = "";
    hero.append(
      el("div", { class: "lock" }, [
        el("p", { class: "muted", text: faltando === "following"
          ? "Falta ler quem você segue para cruzar as listas."
          : "Falta ler quem te segue para cruzar as listas." }),
        el("button", { class: "btn primary", style: "width:auto;margin-top:10px",
          text: "Ler agora", onclick: () => runCollect([faltando]) }),
      ]));
    $("#rv-mini").classList.add("hidden");
    $("#rv-mutual").textContent = "";
    // sem cruzamento confiável: esconde a saída para as listas cruzadas
    $("#rv-lists").classList.add("hidden");
    $("#rv-share").classList.add("hidden");
    return;
  }
  $("#rv-lists").classList.remove("hidden");
  $("#rv-share").classList.remove("hidden");
  $("#rv-mini").classList.remove("hidden");

  const following = count("following"), mutual = count("mutual");
  const nfbAll = crossed.not_following_back;
  const nfb = nfbAll.length;
  const verif = nfbAll.filter((u) => u.is_verified).length;
  const marcados = nfbAll.filter((u) => normais.has(u.pk)).length;
  const comuns = nfb - verif - marcados;
  const recip = following ? ((mutual / following) * 100) : 0;

  hero.className = "hero";
  hero.innerHTML = "";
  hero.append(
    el("p", { class: "ctx", html: `Você segue <b>${D.nf(following)}</b> contas.<br>${D.nf(mutual)} seguem você de volta.` }),
    el("div", { class: "recip" }, [
      el("div", { class: "bar" }, Object.assign(el("i"), { style: `width:${recip}%` })),
      el("span", { class: "pct", text: recip.toFixed(1).replace(".", ",") + "%" }),
    ]),
    el("div", { class: "hero-num", text: D.nf(nfb) }),
    el("div", { class: "hero-num-sub", text: "não seguem você de volta" }),
    el("div", { class: "subtract" }, [
      row("− verificados (clubes, artistas, marcas)", verif),
      row("− que você marcou como normais", marcados),
      Object.assign(row("= contas comuns", comuns), { className: "r total" }),
    ]),
  );
  // nota de precisão
  const gap = (p.followers || 0) - count("followers");
  if (gap > 0) {
    hero.append(el("div", { class: "precision" }, [
      el("span", { text: "ⓘ" }),
      el("span", { html: `Coletei ${D.nf(count("followers"))} dos ${D.nf(p.followers)} seguidores que o Instagram declara. Até ${gap} destes nomes podem estar aqui por engano. ` }),
    ]));
    hero.querySelector(".precision").append(
      el("button", { class: "linkish", text: "recoletar seguidores", onclick: () => runCollect(["followers"]) }));
  }
  if (window._novos && window._novos.length)
    hero.append(el("p", { class: "note", style: "margin-top:12px",
      text: `✨ ${window._novos.length} nome(s) novo(s) nesta lista desde a última vez.` }));
  if (nfb === 0)
    hero.querySelector(".hero-num-sub").textContent = "— todo mundo que você segue te segue de volta. Sério.";

  // cartão gêmeo: só te seguem
  const nfdb = crossed.not_followed_back;
  const priv = nfdb.filter((u) => u.is_private).length;
  const semNome = nfdb.filter((u) => !u.full_name).length;
  const vv = nfdb.filter((u) => u.is_verified).length;
  const mini = $("#rv-mini");
  mini.innerHTML = "";
  mini.append(
    el("div", {}, [el("span", { class: "n", text: D.nf(nfdb.length) + "  " }),
      el("h3", { text: "Só te seguem" })]),
    el("p", { class: "desc", text: "Te seguem e você não segue de volta. Em conta pública, isso é o normal." }),
    el("p", { class: "breakdown", text: `${D.nf(priv)} privados · ${D.nf(semNome)} sem nome · ${D.nf(vv)} verificados` }),
  );

  const vBack = crossed.mutual.filter((u) => u.is_verified).length;
  $("#rv-mutual").textContent = `${D.nf(mutual)} mútuos · ${D.nf(vBack)} contas verificadas seguem você de volta`;
}
function row(k, v) {
  return el("div", { class: "r" }, [el("span", { class: "k", text: k }), el("span", { text: D.nf(v) })]);
}
$("#rv-refresh").onclick = () => showConfirm();
$("#rv-lists").onclick = () => showList("not_following_back");
$("#rv-share").onclick = () => openShare();

/* ─────────────────────────────── placar + lista ──────────────────────── */
let curList = "not_following_back", shown = 200;

function showList(name) {
  curList = name; shown = 200;
  setView("list");
  renderRail();
  renderPanel();
}
function renderRail() {
  // barra de cruzamento
  const nfb = count("not_following_back"), mut = count("mutual"), nfdb = count("not_followed_back");
  const cb = $("#crossbar"); cb.innerHTML = "";
  const seg = (v, c) => { const s = el("span"); s.style.flex = v || 0.001; s.style.background = `var(${c})`; return s; };
  cb.append(seg(nfb, "--c-nfb"), seg(mut, "--c-mut"), seg(nfdb, "--c-nfdb"));
  $("#crosskey").innerHTML = `<span>você segue</span><span>mútuos</span><span>te seguem</span>`;

  const box = $("#scorecards"); box.innerHTML = "";
  LISTS.forEach(([key, label, leg, cls], i) => {
    if (i === 3) box.append(el("div", { class: "divider", text: "listas completas" }));
    const c = count(key);
    // listas derivadas exigem as DUAS fontes coletadas; as cruas só a si mesmas
    const ready = NEEDS(key) ? (collected("followers") && collected("following")) : collected(key);
    const btn = el("button", {
      class: `scorecard ${cls}`, "aria-pressed": key === curList ? "true" : "false",
      onclick: () => showList(key),
    }, [
      el("div", { class: "n", text: ready ? D.nf(c) : "—" }),
      el("div", { class: "nm", text: label }),
      el("div", { class: "leg", text: leg }),
    ]);
    box.append(btn);
  });

  // rodapé de precisão
  const p = data.profile || session.profile;
  const foot = $("#rail-foot");
  if (p.following && collected("following")) {
    const pct = (count("following") / p.following) * 100;
    foot.innerHTML = `O Instagram diz ${D.nf(p.following)} seguindo. Coletamos ${D.nf(count("following"))} (${pct.toFixed(0)}%).`;
    if (pct < 95) foot.append(el("button", { class: "linkish", text: " coletar de novo, mais devagar",
      onclick: () => { $("#opt-delay").value = "5"; showConfirm(); } }));
  } else foot.textContent = "";
}
function NEEDS(key) { return key !== "followers" && key !== "following"; }

let filtered = [];
function renderPanel() {
  const list = crossed[curList] || [];
  $("#lp-title").textContent = LABEL[curList];
  $("#lp-review").style.display =
    ["not_following_back", "not_followed_back"].includes(curList) ? "" : "none";

  const q = $("#lp-search").value.trim().toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
  filtered = q ? list.filter((u) => u.s.includes(q)) : list.slice();

  const sort = $("#lp-sort").value;
  filtered.sort((a, b) => {
    if (sort === "verified" && a.is_verified !== b.is_verified) return a.is_verified ? -1 : 1;
    if (sort === "named" && !!a.full_name !== !!b.full_name) return a.full_name ? -1 : 1;
    const c = a.username.localeCompare(b.username);
    return sort === "za" ? -c : c;
  });

  $("#lp-count").textContent = q ? `${D.nf(filtered.length)} de ${D.nf(list.length)}` : D.nf(list.length);

  // "também em outras listas"
  const also = $("#lp-also");
  if (q) {
    const hits = LISTS.map(([k, l]) => [k, l, (crossed[k] || []).filter((u) => u.s.includes(q)).length])
      .filter(([k, , n]) => k !== curList && n > 0);
    if (hits.length) {
      also.classList.remove("hidden"); also.innerHTML = "também: ";
      hits.forEach(([k, l, n]) => also.append(el("button", { text: `${n} em ${l}`,
        onclick: () => { curList = k; renderRail(); renderPanel(); } })));
    } else also.classList.add("hidden");
  } else also.classList.add("hidden");

  renderPeople();
}
function renderPeople() {
  const box = $("#lp-people"); box.innerHTML = "";
  if (!filtered.length) {
    const q = $("#lp-search").value.trim();
    box.append(el("div", { class: "empty" }, q
      ? [el("p", { text: `Ninguém com "${q}" nesta lista.` })]
      : [el("p", { text: emptyMsg(curList) })]));
    $("#lp-more").classList.add("hidden");
    return;
  }
  const resolved = D.marks("resolvidos"), normais = D.marks("normais");
  filtered.slice(0, shown).forEach((u) => box.append(personRow(u, resolved, normais)));
  $("#lp-more").classList.toggle("hidden", filtered.length <= shown);
}
function personRow(u, resolved, normais) {
  const row = el("div", { class: "person" + (resolved.has(u.pk) ? " done" : "")
    + (normais.has(u.pk) ? " normal" : "") });
  row.append(monoEl(u, 32));
  const id = el("div", { class: "id" });
  id.append(el("div", { class: "at", text: "@" + u.username }));
  if (u.full_name) id.append(el("div", { class: "nm", text: u.full_name }));
  row.append(id);
  const badges = el("div", { class: "row", style: "gap:4px" });
  if (u.is_verified) badges.append(el("span", { class: "badge v", text: "verificado" }));
  if (u.is_private) badges.append(el("span", { class: "badge", text: "privado" }));
  row.append(badges);
  const acts = el("div", { class: "acts" });
  const link = el("a", { class: "iconlink", href: `https://www.instagram.com/${u.username}/`,
    target: "_blank", rel: "noopener noreferrer", title: "abrir no Instagram", text: "↗" });
  acts.append(link);
  if (["not_following_back", "not_followed_back"].includes(curList)) {
    const mark = el("button", { class: "iconlink", title: "marcar como normal",
      "aria-pressed": normais.has(u.pk) ? "true" : "false", text: "✓",
      onclick: (e) => { e.preventDefault(); normais.toggle(u.pk); renderPeople(); } });
    acts.append(mark);
  }
  row.append(acts);
  return row;
}
function emptyMsg(name) {
  if (name === "mutual") return "Nenhum mútuo ainda. Você já coletou as duas listas?";
  if (name === "not_following_back") return "Todo mundo que você segue te segue de volta.";
  return "Lista vazia.";
}
$("#lp-search").oninput = renderPanel;
$("#lp-sort").onchange = renderPanel;
$("#lp-morebtn").onclick = () => { shown += 200; renderPeople(); };
// digitar em qualquer lugar foca a busca
document.addEventListener("keydown", (e) => {
  if (body.dataset.view !== "list" || body.dataset.drawer) return;
  const s = $("#lp-search");
  if (e.key === "/") { e.preventDefault(); s.focus(); }
  else if (e.key === "Escape" && document.activeElement === s) { s.value = ""; renderPanel(); }
  else if (e.key.length === 1 && /\S/.test(e.key) && document.activeElement !== s) s.focus();
});

// menu de export
$("#lp-export").onclick = (e) => {
  e.stopPropagation();
  const m = $("#lp-exportmenu");
  m.classList.toggle("hidden");
  if (m.classList.contains("hidden")) return;
  m.innerHTML = "";
  const opts = [["csv", "Planilha, para abrir no Excel (CSV)"],
    ["txt", "Só os @, um por linha (TXT)"], ["json", "Para programadores (JSON)"]];
  opts.forEach(([fmt, label]) => m.append(el("a", { text: label,
    href: api.exportUrl(curList, fmt), download: "" })));
  m.append(el("p", { class: "note", text: "Uma cópia também fica na pasta ig-lists/data no seu computador." }));
};
document.addEventListener("click", () => $("#lp-exportmenu").classList.add("hidden"));

/* ─────────────────────────────── revisar 1 a 1 ───────────────────────── */
let reviewIdx = 0, reviewList = [];
$("#lp-review").onclick = () => openReview();
function openReview() {
  reviewList = filtered.slice(); reviewIdx = 0;
  $("#rvw-listname").textContent = "Revisar · " + LABEL[curList];
  setDrawer("review");
  renderReview();
}
function renderReview() {
  const resolved = D.marks("resolvidos");
  // pula os já resolvidos
  while (reviewIdx < reviewList.length && resolved.has(reviewList[reviewIdx].pk)) reviewIdx++;
  const body = $("#rvw-body");
  if (reviewIdx >= reviewList.length) {
    body.innerHTML = "";
    body.append(el("p", { class: "muted", text: "Você passou por todos. 🎉" }),
      el("button", { class: "btn", style: "margin-top:12px", text: "Fechar",
        onclick: () => setDrawer("") }));
    return;
  }
  const u = reviewList[reviewIdx];
  body.innerHTML = "";
  body.append(monoEl(u, 72));
  body.append(el("div", { class: "review-at", text: "@" + u.username }));
  if (u.full_name) body.append(el("div", { class: "review-nm", text: u.full_name }));
  const b = el("div", { class: "row", style: "justify-content:center;gap:6px" });
  if (u.is_verified) b.append(el("span", { class: "badge v", text: "verificado" }));
  if (u.is_private) b.append(el("span", { class: "badge", text: "privado" }));
  body.append(b);
  body.append(el("div", { class: "stack", style: "margin-top:18px" }, [
    el("a", { class: "btn primary", href: `https://www.instagram.com/${u.username}/`,
      target: "_blank", rel: "noopener noreferrer", text: "Abrir no Instagram ↗",
      onclick: () => { markResolvedNext(u); } }),
    el("button", { class: "btn block", text: "Já resolvi ✓", onclick: () => markResolvedNext(u) }),
    el("button", { class: "btn ghost", text: "Pular", onclick: () => { reviewIdx++; renderReview(); } }),
  ]));
  body.append(el("div", { class: "review-count", text: `${reviewIdx + 1} de ${D.nf(reviewList.length)}` }));
  body.append(el("button", { class: "linkish", text: "voltar um",
    onclick: () => { reviewIdx = Math.max(0, reviewIdx - 1); renderReview(); } }));
}
function markResolvedNext(u) {
  D.marks("resolvidos").add(u.pk);
  reviewIdx++;
  renderReview();
  renderPeople();
}
document.addEventListener("keydown", (e) => {
  if (body.dataset.drawer !== "review") return;
  if (e.key === "ArrowRight") { reviewIdx++; renderReview(); }
  if (e.key === "ArrowLeft") { reviewIdx = Math.max(0, reviewIdx - 1); renderReview(); }
});
// ao voltar do Instagram, avança
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && body.dataset.drawer === "review" && renderReview._pendingOpen) {
    renderReview._pendingOpen = false;
  }
});

/* ─────────────────────────────── cartão compartilhar ─────────────────── */
function openShare() {
  const following = count("following"), mutual = count("mutual");
  const nfb = count("not_following_back");
  const verif = crossed.not_following_back.filter((u) => u.is_verified).length;
  const vBack = crossed.mutual.filter((u) => u.is_verified).length;
  const recip = following ? ((mutual / following) * 100).toFixed(1).replace(".", ",") : "0";
  const card = $("#share-card");
  card.innerHTML = "";
  card.append(
    el("div", { class: "l1", text: `sigo ${D.nf(following)} · ${D.nf(mutual)} me seguem de volta` }),
    el("div", { class: "l2", text: recip + "%" }),
    el("div", { class: "l3", text: "de reciprocidade" }),
    el("div", { class: "l3", text: `${D.nf(nfb)} não seguem · ${verif} verificados` }),
    el("div", { class: "l3", text: `${vBack} verificadas me seguem` }),
    el("div", { class: "foot", text: "rodou na minha máquina, sem servidor" }),
  );
  const text = `sigo ${D.nf(following)} · ${D.nf(mutual)} me seguem de volta\n${recip}% de reciprocidade\n${D.nf(nfb)} não seguem · ${verif} verificados\n${D.nf(vBack)} verificadas me seguem\n\nrodou na minha máquina, sem servidor`;
  $("#share-copy").onclick = (e) => copy(text, e.currentTarget);
  setDrawer("share");
}

/* ─────────────────────────────── gaveta segurança ────────────────────── */
$("#open-safety").onclick = () => { renderSafety(); setDrawer("safety"); };
const SAFETY = [
  ["Roda no seu computador", "O endereço 127.0.0.1 quer dizer “esta máquina”. Não existe servidor nosso no meio."],
  ["Sua sessão não é gravada", "Fica só na memória do programa, enquanto ele está aberto. Fechou a janela preta, sumiu."],
  ["Esta página nunca vê sua sessão", "A tela só sabe qual perfil está conectado. O dado em si não chega no navegador."],
  ["Nenhum site alcança o app", "Só esta página e a extensão conseguem conversar com ele; qualquer site da internet é recusado."],
  ["O programa só lê", "Ele nunca segue, deixa de seguir, curte ou publica."],
  ["Suas listas ficam com você", "Num arquivo dentro da pasta ig-lists/data. Nada sai daí."],
  ["Por que as fotos não aparecem?", "Baixar as fotos avisaria o Instagram exatamente quais perfis você está olhando. As cores vêm do próprio @."],
];
function renderSafety() {
  const box = $("#safety-items"); box.innerHTML = "";
  SAFETY.forEach(([t, d]) => box.append(el("div", { class: "safe-item" }, [
    el("div", { html: CHECK }),
    el("div", {}, [el("b", { text: t }), el("span", { text: d })]),
  ])));
}
$("#sf-logout").onclick = async (e) => {
  if (e.currentTarget.dataset.armed !== "1") { arm(e.currentTarget, "Confirmar: desconectar?"); return; }
  await api.logout(); setDrawer(""); await refresh();
};
$("#sf-reset").onclick = async (e) => {
  if (e.currentTarget.dataset.armed !== "1") { arm(e.currentTarget, "Confirmar: apagar listas?"); return; }
  await api.reset();
  ["normais", "resolvidos", "anterior"].forEach((k) => D.store.del("iglists:" + k));
  setDrawer(""); await refresh();
};
function arm(btn, label) {
  btn.dataset.armed = "1"; const t = btn.textContent; btn.textContent = label;
  btn.style.borderColor = "var(--err)"; btn.style.color = "var(--err)";
  setTimeout(() => { btn.dataset.armed = "0"; btn.textContent = t; btn.style.borderColor = ""; btn.style.color = ""; }, 4000);
}

/* ─────────────────────────────── desligar ────────────────────────────── */
$("#quit").onclick = async () => {
  try { await api.quit(); } catch {}
  document.body.innerHTML =
    '<div style="min-height:100dvh;display:grid;place-items:center;text-align:center;color:var(--tx2);font:16px/1.6 system-ui;padding:24px">' +
    '<div><h1 style="color:var(--tx)">Pronto 👋</h1><p>Sua sessão do Instagram foi apagada da memória.<br>' +
    'Pode fechar esta aba — a janela preta já fechou sozinha.</p></div></div>';
};

/* ─────────────────────────────── falha ───────────────────────────────── */
function showFail(err) {
  setView("fail");
  const msg = err?.message || "";
  const map = matchFail(msg);
  $("#fail-title").textContent = map.title;
  $("#fail-cause").textContent = map.cause;
  const extra = $("#fail-extra"); extra.innerHTML = "";
  const act = $("#fail-action");
  act.textContent = map.action;
  act.onclick = map.onAction;
  if (map.extra) extra.append(map.extra);
  $("#fail-back").onclick = () => refresh();
}
function matchFail(msg) {
  const m = msg.toLowerCase();
  if (msg === "__lost__") return {
    title: "Perdemos contato com o app",
    cause: "A janela preta do Terminal foi fechada, ou o computador dormiu.",
    action: "Recarregar a página", onAction: () => location.reload() };
  // "expirad" cobre expirada/expirado; "recopie" só aparece nas msgs de sessão
  if (m.includes("venceu") || m.includes("expirad") || m.includes("não-json")
      || m.includes("expirou") || m.includes("recopie"))
    return { title: "Sua entrada no Instagram venceu",
      cause: "Acontece quando você sai do Instagram ou passa muito tempo. Basta reconectar.",
      action: "Reconectar", onAction: () => showConnect() };
  if (m.includes("não está logado") || m.includes("nesse perfil"))
    return { title: "Nesse navegador você não está logado no Instagram",
      cause: msg, action: "Tentar outro navegador", onAction: () => showConnect() };
  if (m.includes("keychain") || m.includes("permitir") || m.includes("negad"))
    return { title: "Faltou a autorização do Mac",
      cause: "Sem liberar a chave do Keychain, o app não consegue ler a sessão do navegador.",
      action: "Tentar de novo", onAction: () => showConnect() };
  if (m.includes("blindar") || m.includes("app-bound") || m.includes("extensão"))
    return { title: "Esse navegador protege os cookies",
      cause: msg, action: "Ver como conectar", onAction: () => { showConnect(); $("#fallbacks").open = true; } };
  if (m.includes("wait") || m.includes("limit") || m.includes("aguard"))
    return { title: "O Instagram não deixou continuar agora",
      cause: "Ele está limitando os pedidos. Espere uns 15 minutos — na próxima, escolha “devagar” nos ajustes.",
      action: "Voltar ao início", onAction: () => refresh() };
  if (m.includes("descobri seu @") || m.includes("informe"))
    return { title: "Não descobri seu @ sozinho",
      cause: "Digite seu @ do Instagram e tente de novo.",
      action: "Continuar",
      extra: buildUsernameField(),
      onAction: async () => {
        const u = $("#fail-user").value.trim();
        if (!u) return;
        try {
          // veio de importar do navegador? repete o import com o @ informado.
          if (lastImport) await importFrom({ key: lastImport.browser, profile: lastImport.profile }, null, u);
          else { await api.authManual($("#cookie").value.trim(), u); await afterConnect(); }
        } catch (e) { showFail(e); } } };
  return { title: "Algo deu errado", cause: msg || "Erro inesperado.",
    action: "Voltar ao início", onAction: () => refresh() };
}
function buildUsernameField() {
  return el("div", { style: "margin:0 auto 16px;max-width:280px" },
    el("input", { id: "fail-user", type: "text", placeholder: "@voce", autocomplete: "off" }));
}

/* ─────────────────────────────── go ──────────────────────────────────── */
function wireStatic() {}
boot();
