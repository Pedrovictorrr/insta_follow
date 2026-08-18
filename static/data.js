// data.js — tudo que é cálculo puro, no cliente. Sem rede aqui.

// chave de busca sem acento, pré-calculada uma vez por pessoa
const chave = (u) =>
  (u.username + " " + (u.full_name || ""))
    .toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

// cruza as duas listas cruas em cinco visões, numa passada
export function cruzar(followers, following) {
  const idx = new Map();
  const push = (u, campo) => {
    let e = idx.get(u.pk);
    if (!e) idx.set(u.pk, (e = { ...u, ers: false, ing: false, s: chave(u) }));
    e[campo] = true;
  };
  for (const u of followers) push(u, "ers");
  for (const u of following) push(u, "ing");
  const todos = [...idx.values()];
  return {
    followers:          todos.filter((u) => u.ers),
    following:          todos.filter((u) => u.ing),
    mutual:             todos.filter((u) => u.ers && u.ing),
    not_following_back: todos.filter((u) => u.ing && !u.ers), // você segue, não te seguem
    not_followed_back:  todos.filter((u) => u.ers && !u.ing), // te seguem, você não segue
  };
}

// monograma determinístico: cor pelo hash do @, iniciais do nome
export function monograma(u) {
  let h = 0;
  for (const c of u.username) h = (h * 31 + c.codePointAt(0)) >>> 0;
  const nome = (u.full_name || "").trim();
  const letras = nome
    ? nome.split(/\s+/).slice(0, 2).map((p) => p[0]).join("")
    : u.username.slice(0, 2);
  return { hue: h % 360, letras: letras.toUpperCase() };
}

export const nf = (n) => (n == null ? "—" : n.toLocaleString("pt-BR"));

// estimativa de tempo, espelhando PAGE_SIZES e o delay do server.py
const PAGE_SIZES = [50, 200, 100, 75];
const pgs = (n, size) => Math.max(1, Math.ceil((n || 0) / size));

export function estimarSegundos({ followers, following }, passes, delay) {
  let p = pgs(followers, PAGE_SIZES[0]); // seguidores: sempre 1 passada
  for (let i = 0; i < passes; i++) p += pgs(following, PAGE_SIZES[i % 4]);
  return p * (delay + 0.6 + 0.35) + (passes - 1) * delay;
}

// "uns 6 minutos", "menos de 1 minuto" — nunca 00:06:00
export function tempoHumano(seg) {
  if (seg < 60) return "menos de 1 minuto";
  const min = Math.ceil(seg / 60);
  return `uns ${min} minuto${min > 1 ? "s" : ""}`;
}

export function relativo(iso) {
  if (!iso) return "";
  const d = new Date(iso.replace(" ", "T"));
  const dias = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (dias <= 0) return "hoje às " + iso.slice(11, 16);
  if (dias === 1) return "ontem";
  if (dias < 7) return `há ${dias} dias`;
  return `há ${dias} dias`;
}

// segundos → "0:47"
export const mmss = (s) => {
  s = Math.max(0, Math.round(s));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
};

// localStorage por conta, tolerante a modo privado
const store = {
  get(k, d) {
    try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; }
  },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// conjuntos de pk marcados pelo usuário (sobrevivem a recoletas)
export function marks(kind) {
  const key = `iglists:${kind}`;
  const set = new Set(store.get(key, []));
  return {
    has: (pk) => set.has(pk),
    toggle: (pk) => { set.has(pk) ? set.delete(pk) : set.add(pk); store.set(key, [...set]); },
    add: (pk) => { set.add(pk); store.set(key, [...set]); },
    all: () => set,
    size: () => set.size,
  };
}

export { store };
