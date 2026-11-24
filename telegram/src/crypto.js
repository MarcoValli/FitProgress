// Chiavi e cifratura del bot. Tutto parte da MASTER_KEY (secret di Cloudflare, 32 byte in esadecimale):
// per ogni utente (il suo ID Telegram) se ne ricavano (HKDF) chiavi diverse, una per scopo.
//   file   il secondo livello del file dei progressi nella chat (FPU1, sopra quello con la password). La ricava il
//          Worker e la dà alla pagina solo dentro una sessione: la pagina cifra e decifra da sola, il Worker il file
//          in chiaro non lo vede mai
//   db     cifra quello che resta in attesa nel database (voci del diario, didascalie, guida del promemoria)
const enc = new TextEncoder(), dec = new TextDecoder();
// File cifrato con la chiave dell'utente: magia (4) · id della chiave (8) · iv (12) · dati, intestazione autenticata.
//   FPU1  adesso: dentro c'è il file cifrato con la password (FPP1)
//   FPE1  versione di prima: dentro c'era il JSON
export const U_MAGIC = enc.encode("FPU1");
export const MAGIC = enc.encode("FPE1");
export const HEADER = 4 + 8 + 12;

const hexBytes = (hex) => {
  if (typeof hex !== "string" || !/^[0-9a-f]{64}$/i.test(hex)) throw new Error("MASTER_KEY: servono 64 cifre esadecimali");
  return Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
};
export const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
export const hexOf = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function derive(master, info) {
  const base = await crypto.subtle.importKey("raw", hexBytes(master), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: enc.encode("fitprogress v1"), info: enc.encode(info) }, base, 256));
}
const aesKey = (raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
const hmacKey = (raw) => crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const hmac = async (raw, data) => new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(raw), typeof data === "string" ? enc.encode(data) : data));

// Chiave del file di un utente (32 byte) e il suo id (8 byte, sta in chiaro nel file: dice di chi è, non la rivela)
export async function fileKey(master, userId) {
  const raw = await derive(master, `file:${userId}`);
  return { raw, id: (await hmac(raw, "fitprogress key id")).slice(0, 8) };
}
const dbKeys = new Map();
async function dbKey(master, userId) {
  if (!dbKeys.has(userId)) {
    if (dbKeys.size > 200) dbKeys.clear();
    dbKeys.set(userId, aesKey(await derive(master, `db:${userId}`)));
  }
  return dbKeys.get(userId);
}

// Testo nel database: "e1:" + iv + dati, in base64. Quello scritto prima della cifratura si legge com'è
export async function sealText(master, userId, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await dbKey(master, userId), enc.encode(text)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return `e1:${b64u(out)}`;
}
export async function openText(master, userId, s) {
  if (typeof s !== "string" || !s.startsWith("e1:")) return s;
  try {
    const b = fromB64u(s.slice(3));
    return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12) }, await dbKey(master, userId), b.slice(12)));
  } catch { return null; }
}

// Sessione della pagina: un codice a caso, nel database solo la sua impronta
export const newToken = () => b64u(crypto.getRandomValues(new Uint8Array(32)));
export const tokenHash = async (t) => hexOf(await crypto.subtle.digest("SHA-256", enc.encode(t)));

// File dei progressi cifrato con la password (lo fa la pagina): FPP1 · giri (4) · sale (16) · iv (12) · dati.
// Nella chat sta dentro FPU1. Il Worker la password non la usa per cifrare: riconosce solo i file salvati prima
export const PP_MAGIC = enc.encode("FPP1");
export const PP_HEADER = 4 + 4 + 16 + 12;
export const isPasswordFile = (head) => !!head && head.length >= PP_HEADER && PP_MAGIC.every((x, i) => head[i] === x);

// Il file inizia come un file cifrato con la chiave di questo utente? magic: FPU1, o FPE1 per la versione di prima
export function isFileFor(head, keyId, magic = MAGIC) {
  if (!head || head.length < HEADER) return false;
  for (let i = 0; i < 4; i++) if (head[i] !== magic[i]) return false;
  let d = 0;
  for (let i = 0; i < 8; i++) d |= head[4 + i] ^ keyId[i];
  return d === 0;
}
// Cifrato con la chiave di un utente (FPU1), non importa di chi
export const isUserFile = (head) => !!head && head.length >= HEADER && U_MAGIC.every((x, i) => head[i] === x);

// Per i test (e uguale a quello che fa la pagina): cifra e decifra un file dei progressi
export async function sealFile(raw, id, bytes, magic = MAGIC) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const head = new Uint8Array(HEADER);
  head.set(magic);
  head.set(id, 4);
  head.set(iv, 12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: head }, await aesKey(raw), bytes));
  const out = new Uint8Array(HEADER + ct.length);
  out.set(head);
  out.set(ct, HEADER);
  return out;
}
export async function openFile(raw, bytes) {
  const head = bytes.slice(0, HEADER);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: head.slice(12), additionalData: head }, await aesKey(raw), bytes.slice(HEADER)));
}
