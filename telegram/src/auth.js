// Dati firmati che Telegram passa alla Mini App (initData): si controllano col token del bot.
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
const enc = new TextEncoder();

async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

// Confronto a tempo costante: non dice quanti caratteri iniziali sono giusti
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// L'utente Telegram ({ id, first_name… }) se la firma torna e non è più vecchia di maxAge secondi, se no null
export async function checkInitData(initData, botToken, now = Date.now(), maxAge = 86400) {
  if (typeof initData !== "string" || !initData || initData.length > 8192 || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  params.delete("hash");
  const check = [...params].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = await hmac(enc.encode("WebAppData"), enc.encode(botToken));
  if (!safeEqual(hex(await hmac(secret, enc.encode(check))), hash)) return null;
  const authDate = Number(params.get("auth_date"));
  if (!authDate || now / 1000 - authDate > maxAge) return null;
  let user;
  try { user = JSON.parse(params.get("user")); } catch { return null; }
  return Number.isSafeInteger(user?.id) ? user : null;
}

// Per i test: initData firmata come la firma Telegram
export async function signInitData(fields, botToken) {
  const params = new URLSearchParams(fields);
  const check = [...params].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = await hmac(enc.encode("WebAppData"), enc.encode(botToken));
  params.set("hash", hex(await hmac(secret, enc.encode(check))));
  return params.toString();
}
