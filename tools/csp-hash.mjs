#!/usr/bin/env node
// Impronta dello script di index.html nella Content Security Policy.
// La CSP fa partire solo lo script con questa impronta (niente 'unsafe-inline'): dopo ogni modifica
// allo script va ricalcolata, se no la pagina non parte.
//   node tools/csp-hash.mjs          aggiorna l'impronta in index.html
//   node tools/csp-hash.mjs --check  controlla soltanto (esce con 1 se non torna)
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(new URL("../index.html", import.meta.url));
const check = process.argv.includes("--check");
const html = readFileSync(file, "utf8");

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (scripts.length !== 1 || /<script[\s>]/.test(html.replace(scripts[0][0], ""))) {
  console.error("index.html deve avere uno e un solo <script> (senza attributi): la CSP ne conosce uno");
  process.exit(1);
}
// Il browser calcola l'impronta sul testo dello script come lo legge: a capo normalizzati in \n
const body = scripts[0][1].replace(/\r\n?/g, "\n");
const hash = `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`;

const meta = /(<meta http-equiv="Content-Security-Policy" content="[^"]*script-src )'sha256-[A-Za-z0-9+/=]*'/;
if (!meta.test(html)) {
  console.error("Nella CSP di index.html manca script-src 'sha256-…'");
  process.exit(1);
}
const current = html.match(meta)[0].match(/'sha256-[A-Za-z0-9+/=]*'/)[0];
if (current === hash) {
  console.log(`Impronta già giusta: ${hash}`);
  process.exit(0);
}
if (check) {
  console.error(`Impronta da aggiornare (node tools/csp-hash.mjs): nella CSP ${current}, lo script è ${hash}`);
  process.exit(1);
}
writeFileSync(file, html.replace(meta, `$1${hash}`));
console.log(`Impronta aggiornata: ${hash}`);
