// Copia in public/ la pagina e le librerie, e nient'altro: il Worker le serve così come sono.
// Prima controlla l'impronta dello script nella CSP, se no la pagina non partirebbe.
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const out = fileURLToPath(new URL("../public/", import.meta.url));

execFileSync(process.execPath, [`${root}tools/csp-hash.mjs`, "--check"], { stdio: "inherit" });
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}vendor`, { recursive: true });
cpSync(`${root}index.html`, `${out}index.html`);
for (const f of ["heic-to.js", "vision_bundle.mjs", "vision_wasm_internal.js", "vision_wasm_internal.wasm", "pose_landmarker_full.task", "LICENSE-heic-to.txt", "LICENSE-mediapipe.txt"]) {
  cpSync(`${root}vendor/${f}`, `${out}vendor/${f}`);
}
// Header di sicurezza per la pagina e le librerie (li aggiunge Cloudflare). La pagina si può mettere in un iframe
// solo da Telegram Web: le app di Telegram la aprono in una loro finestra, non in un iframe
writeFileSync(`${out}_headers`, `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Strict-Transport-Security: max-age=31536000
  Content-Security-Policy: frame-ancestors 'self' https://web.telegram.org
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
  Cross-Origin-Opener-Policy: same-origin-allow-popups
`);
console.log("public/ pronta: index.html, vendor/ e _headers");
