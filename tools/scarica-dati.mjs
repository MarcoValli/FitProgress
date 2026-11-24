#!/usr/bin/env node
// Scarica sul computer quello che il bot di FitProgress ha di un utente, così com'è (niente si decifra):
//   database.json          le righe del database (D1) di quell'utente: i testi in attesa restano cifrati (e1:…)
//   progressi/*.fitprogress i file dei progressi nella chat (l'ultimo e quelli conservati): cifrati con la password
//   foto-in-attesa/*.jpg   le foto mandate in chat e non ancora salvate: sono foto di Telegram, NON cifrate
// e lo zip di tutto. Serve il login a Cloudflare (npx wrangler login) e il token del bot, che si chiede e non si salva.
//   node tools/scarica-dati.mjs            il mio ID (560065429)
//   node tools/scarica-dati.mjs 123456789  un altro utente (solo se è d'accordo)
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const uid = Number(process.argv[2] || 560065429);
if (!Number.isSafeInteger(uid) || uid <= 0) { console.error("Scrivi un ID Telegram, per esempio 560065429"); process.exit(1); }
const telegramDir = fileURLToPath(new URL("../telegram/", import.meta.url));

// Il token: dalla variabile BOT_TOKEN, se no si chiede senza mostrarlo
async function askToken() {
  if (process.env.BOT_TOKEN) return process.env.BOT_TOKEN.trim();
  process.stdout.write("Token del bot (da @BotFather › /mybots › API Token, non si vede mentre scrivi): ");
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  let t = "";
  return new Promise((resolve) => process.stdin.on("data", (b) => {
    for (const c of b.toString("utf8")) {
      if (c === "\r" || c === "\n") { process.stdin.setRawMode?.(false); process.stdin.pause(); process.stdout.write("\n"); resolve(t.trim()); return; }
      if (c === "\u0003") process.exit(1);
      if (c === "\u007f") t = t.slice(0, -1); else t += c;
    }
  }));
}

// Il database (D1, su Cloudflare)
const query = (sql) => {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "fitprogress", "--remote", "--json", "--command", sql], { cwd: telegramDir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  return JSON.parse(out)[0].results;
};
console.log(`Leggo il database per l'utente ${uid}…`);
const db = {};
for (const [name, sql] of Object.entries({
  users: `SELECT * FROM users WHERE id = ${uid}`,
  photos: `SELECT * FROM photos WHERE user_id = ${uid} ORDER BY id`,
  diary: `SELECT * FROM diary WHERE user_id = ${uid} ORDER BY id`,
  asks: `SELECT * FROM asks WHERE user_id = ${uid} ORDER BY id`,
  saves: `SELECT * FROM saves WHERE user_id = ${uid} ORDER BY sent_at`,
  sessions: `SELECT user_id, created_at, last_at FROM sessions WHERE user_id = ${uid}`,
})) db[name] = query(sql);
if (!db.users.length) { console.error(`Nel database non c'è l'utente ${uid}.`); process.exit(1); }
const u = db.users[0];

const day = new Date().toISOString().slice(0, 10);
const dir = `${homedir()}/Downloads/fitprogress-dati-${uid}-${day}`;
mkdirSync(`${dir}/progressi`, { recursive: true });
mkdirSync(`${dir}/foto-in-attesa`, { recursive: true });
writeFileSync(`${dir}/database.json`, JSON.stringify(db, null, 2));

// I file su Telegram, dai riferimenti del database
const files = [];
if (u.last_json) files.push({ id: u.last_json, to: `progressi/ultimo.fitprogress` });
for (const s of db.saves) if (s.file_id !== u.last_json) files.push({ id: s.file_id, to: `progressi/salvataggio-${s.message_id}${s.kept ? "-conservato" : ""}.fitprogress` });
for (const p of db.photos) files.push({ id: p.file_id, to: `foto-in-attesa/foto-${p.id}${p.role ? `-${p.role === "start" ? "partenza" : "adesso"}` : ""}.jpg` });

if (files.length) {
  const token = await askToken();
  for (const f of files) {
    try {
      const info = await (await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(f.id)}`)).json();
      if (!info.ok) throw new Error(info.description);
      const res = await fetch(`https://api.telegram.org/file/bot${token}/${info.result.file_path}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      writeFileSync(`${dir}/${f.to}`, bytes);
      const head = Buffer.from(bytes.slice(0, 4)).toString("latin1");
      const what = head === "FPP1" ? "cifrato con la password" : head === "FPE1" ? "cifrato (versione di prima)" : bytes[0] === 0xff && bytes[1] === 0xd8 ? "foto JPG, non cifrata" : bytes[0] === 0x7b ? "JSON IN CHIARO" : "altro";
      console.log(`  ${f.to} · ${Math.round(bytes.length / 1024)} KB · ${what}`);
    } catch (e) {
      console.log(`  ${f.to} · non scaricato: ${e.message}`);
    }
  }
}
execFileSync("zip", ["-qr", `${dir}.zip`, "."], { cwd: dir });
console.log(`\nFatto: ${dir}\n e lo zip ${dir}.zip`);
const sealed = db.diary.concat(db.asks).every((r) => String(r.value ?? r.text).startsWith("e1:"));
console.log(`Testi in attesa nel database: ${db.diary.length + db.asks.length}${db.diary.length + db.asks.length ? (sealed ? ", tutti cifrati (e1:…)" : ", ALCUNI IN CHIARO") : ""}.`);
