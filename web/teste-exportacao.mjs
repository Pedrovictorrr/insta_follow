// node web/teste-exportacao.mjs — autoteste do leitor da exportação (sem zip; o zip é testado no navegador)
import assert from "node:assert/strict";
import { montar, donoDoArquivo } from "./exportacao.js";

const ers = JSON.stringify([
  { title: "", media_list_data: [], string_list_data: [{ href: "https://www.instagram.com/Ana", value: "Ana", timestamp: 1700000000 }] },
  { title: "", media_list_data: [], string_list_data: [{ href: "https://www.instagram.com/bia", value: "bia", timestamp: 1700000001 }] },
]);
// formato novo: username no title, href com /_u/, sem value
const ing = JSON.stringify({ relationships_following: [
  { title: "bia", string_list_data: [{ href: "https://www.instagram.com/_u/bia", timestamp: 1690000000 }] },
  { title: "", string_list_data: [{ href: "https://www.instagram.com/_u/caio", timestamp: 1690000001 }] },
] });
const p = "connections/followers_and_following/";

const r = montar([{ nome: p + "followers_1.json", texto: ers }, { nome: p + "following.json", texto: ing }], "pedro");
assert.equal(r.faltando, null);
assert.deepEqual(r.followers.map((u) => u.username), ["ana", "bia"]);
assert.deepEqual(r.following.map((u) => u.username), ["bia", "caio"]);
assert.equal(r.following[0].quando, 1690000000 * 1000);

// HTML
const html = '<a target="_blank" href="https://www.instagram.com/caio">caio</a><a href="https://www.instagram.com/_u/dani/">dani</a>';
const h = montar([{ nome: "followers_1.html", texto: html }, { nome: "following.html", texto: html }], null);
assert.deepEqual(h.followers.map((u) => u.username), ["caio", "dani"]);

// arquivo faltando
assert.equal(montar([{ nome: "following.json", texto: ing }], null).faltando, "followers");

assert.equal(donoDoArquivo("instagram-pedrovictorrr-2026-10-26-AbC123.zip"), "pedrovictorrr");
assert.equal(donoDoArquivo("meu-arquivo.zip"), null);
console.log("ok");
