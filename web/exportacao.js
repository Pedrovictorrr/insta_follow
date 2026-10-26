// exportacao.js — lê a exportação oficial do Instagram ("Baixar suas informações")
// direto no navegador. Aceita o .zip inteiro ou os arquivos soltos, em JSON ou HTML.
// Nada sai da máquina da pessoa.

// ── zip mínimo: diretório central + DecompressionStream (nativo) ────────────
// shortcut: sem ZIP64 — a exportação só de "seguidores e seguindo" fica em KB;
// se alguém mandar a exportação completa de vários GB, cai no erro abaixo.
async function lerZip(buf) {
  const v = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--)
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("zip");
  const total = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  if (p === 0xffffffff) throw new Error("zip64");
  const dec = new TextDecoder();
  const arquivos = [];
  for (let n = 0; n < total; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error("zip");
    const metodo = v.getUint16(p + 10, true);
    const tam = v.getUint32(p + 20, true);
    const ln = v.getUint16(p + 28, true), le = v.getUint16(p + 30, true), lc = v.getUint16(p + 32, true);
    const off = v.getUint32(p + 42, true);
    const nome = dec.decode(new Uint8Array(buf, p + 46, ln));
    p += 46 + ln + le + lc;
    if (!nos(nome)) continue;   // só descompacta o que interessa
    const ini = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true);
    const bytes = new Uint8Array(buf, ini, tam);
    let texto;
    if (metodo === 0) texto = dec.decode(bytes);
    else if (metodo === 8)
      texto = await new Response(new Blob([bytes]).stream()
        .pipeThrough(new DecompressionStream("deflate-raw"))).text();
    else throw new Error("zip");
    arquivos.push({ nome, texto });
  }
  return arquivos;
}

const base = (nome) => nome.split("/").pop().toLowerCase();
const ehSeguidores = (nome) => /^followers(_\d+)?\.(json|html)$/.test(base(nome));
const ehSeguindo = (nome) => /^following\.(json|html)$/.test(base(nome));
const nos = (nome) => ehSeguidores(nome) || ehSeguindo(nome);

// ── um arquivo → lista de { pk, username, quando } ────────────────────────
const deHref = (h) => (h || "").match(/instagram\.com\/(?:_u\/)?([A-Za-z0-9._]+)/)?.[1];

function pessoas(nome, texto) {
  const out = [];
  if (nome.toLowerCase().endsWith(".html")) {
    // HTML: cada pessoa é um link para o perfil
    for (const m of texto.matchAll(/href="https?:\/\/(?:www\.)?instagram\.com\/(?:_u\/)?([A-Za-z0-9._]+)\/?"/g))
      out.push({ username: m[1], quando: null });
  } else {
    let d = JSON.parse(texto);
    // seguidores vêm como array; seguindo vem embrulhado em { relationships_following: [...] }
    if (!Array.isArray(d)) d = Object.values(d).find(Array.isArray) || [];
    for (const item of d) {
      const s = (item.string_list_data || [])[0] || {};
      // formato antigo: s.value; formato novo (2024+): item.title + href com /_u/
      const username = s.value || item.title || deHref(s.href);
      if (username) out.push({ username, quando: s.timestamp ? s.timestamp * 1000 : null });
    }
  }
  return out.map((u) => ({ ...u, username: u.username.toLowerCase(), pk: u.username.toLowerCase() }));
}

// dono da exportação: o Instagram nomeia o zip "instagram-<usuario>-AAAA-MM-DD-xxxx.zip"
export function donoDoArquivo(nomeArquivo) {
  return nomeArquivo.match(/^instagram-([A-Za-z0-9._]+?)-\d{4}-\d{2}-\d{2}/)?.[1]?.toLowerCase() || null;
}

// files: FileList/array de File (um .zip ou os .json/.html soltos)
export async function lerExportacao(files) {
  let arquivos = [];
  for (const f of files) {
    if (f.name.toLowerCase().endsWith(".zip")) arquivos.push(...await lerZip(await f.arrayBuffer()));
    else if (nos(f.name)) arquivos.push({ nome: f.name, texto: await f.text() });
  }
  return montar(arquivos, [...files].map((f) => donoDoArquivo(f.name)).find(Boolean) || null);
}

export function montar(arquivos, dono) {
  const unico = (lista) => [...new Map(lista.map((u) => [u.pk, u])).values()];
  const followers = unico(arquivos.filter((a) => ehSeguidores(a.nome)).flatMap((a) => pessoas(a.nome, a.texto)));
  const following = unico(arquivos.filter((a) => ehSeguindo(a.nome)).flatMap((a) => pessoas(a.nome, a.texto)));
  const faltando = !arquivos.some((a) => ehSeguidores(a.nome)) ? "followers"
    : !arquivos.some((a) => ehSeguindo(a.nome)) ? "following" : null;
  return { dono, followers, following, faltando };
}
