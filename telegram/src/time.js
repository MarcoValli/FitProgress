// Date e ore nel fuso dell'utente (TIME_ZONE, di solito Europe/Rome), anche col cambio dell'ora
import { shiftDate } from "./parse.js";

const pad = (n) => String(n).padStart(2, "0");
function parts(ms, tz) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const o = Object.fromEntries(f.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, min: +o.minute };
}

// "2026-11-19": il giorno di ms nel fuso tz
export function localDate(ms, tz) {
  const p = parts(ms, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}
// L'istante in cui nel fuso tz è il giorno iso all'ora h
export function atLocal(iso, h, tz) {
  const [y, m, d] = iso.split("-").map(Number);
  const want = Date.UTC(y, m - 1, d, h);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const p = parts(t, tz);
    const diff = want - Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    if (!diff) break;
    t += diff;
  }
  return t;
}
// Prossimo promemoria: fra days giorni (contati da oggi, nel fuso tz) all'ora h
export const nextReminder = (now, days, h, tz) => atLocal(shiftDate(localDate(now, tz), days), h, tz);
// "19/11"
export const shortDate = (ms, tz) => localDate(ms, tz).split("-").slice(1).reverse().join("/");
