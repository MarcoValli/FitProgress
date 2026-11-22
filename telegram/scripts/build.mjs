// Copia in public/ la pagina e le librerie, e nient'altro: il Worker le serve così come sono.
// Prima controlla l'impronta dello script nella CSP, se no la pagina non partirebbe.
import { cpSync, mkdirSync, rmSync } from "node:fs";
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
console.log("public/ pronta: index.html e vendor/");
