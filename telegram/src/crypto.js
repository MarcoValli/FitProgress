// Chiavi e cifratura del bot. Tutto parte da MASTER_KEY (secret di Cloudflare, 32 byte in esadecimale):
// per ogni utente se ne ricavano (HKDF) chiavi diverse, una per scopo.
//   file   cifra il file dei progressi nella chat. La ricava il Worker e la dà alla pagina solo dopo la password:
//          la pagina cifra e decifra da sola, il Worker il file in chiaro non lo vede mai
//   db     cifra quello che resta in attesa nel database (voci del diario, didascalie, guida del promemoria)
//   pepper (una per tutti) rende inutile un furto del database per indovinare le password
const enc = new TextEncoder(), dec = new TextDecoder();
export const MAGIC = enc.encode("FPE1"); // file dei progressi cifrato: FPE1 · id della chiave (8) · iv (12) · dati
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

// Password: la pagina la passa per PBKDF2 (lento, sul telefono) e manda solo il risultato (32 byte).
// Qui si tiene HMAC(pepper, risultato): senza MASTER_KEY il database non serve a indovinarla
export const PBKDF2_ITERATIONS = 600000;
export async function verifier(master, stretched) {
  return hexOf(await hmac(await derive(master, "pepper"), stretched));
}

// Sessione della pagina: un codice a caso, nel database solo la sua impronta
export const newToken = () => b64u(crypto.getRandomValues(new Uint8Array(32)));
export const tokenHash = async (t) => hexOf(await crypto.subtle.digest("SHA-256", enc.encode(t)));

// Il file inizia come un file dei progressi cifrato con la chiave di questo utente?
export function isFileFor(head, keyId) {
  if (!head || head.length < 12) return false;
  for (let i = 0; i < 4; i++) if (head[i] !== MAGIC[i]) return false;
  let d = 0;
  for (let i = 0; i < 8; i++) d |= head[4 + i] ^ keyId[i];
  return d === 0;
}

// Per i test (e uguale a quello che fa la pagina): cifra e decifra un file dei progressi
export async function sealFile(raw, id, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const head = new Uint8Array(HEADER);
  head.set(MAGIC);
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
