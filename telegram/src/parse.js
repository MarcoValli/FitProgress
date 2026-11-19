// Voci del diario scritte al bot: "82,4", "grasso 18", "vita 84", "gambe 60 min", "cena ieri: pizza".
// Pura (niente rete, niente database): si prova coi test. I campi sono quelli del diario della pagina.

// Misure: [min, max], come DIARY_FIELDS in index.html
export const NUM_FIELDS = {
  weight: [20, 400], fat: [2, 75],
  neck: [10, 300], shoulders: [10, 300], chest: [10, 300], arm: [10, 300],
  waist: [10, 300], hips: [10, 300], thigh: [10, 300], calf: [10, 300],
};
export const TEXT_FIELDS = { workout: 200, meal: 300 };

const CIRC = {
  collo: "neck", spalle: "shoulders", torace: "chest", petto: "chest", braccio: "arm", bicipite: "arm",
  vita: "waist", pancia: "waist", fianchi: "hips", coscia: "thigh", polpaccio: "calf",
};
const WORKOUT_LEAD = /^(allenamento|allenat[oa]|palestra|workout)\b\s*[:,-]?\s*/i;
const WORKOUT_WORDS = /^(gambe|petto|schiena|spalle|braccia|bicipiti|tricipiti|addome|addominali|glutei|full ?body|push|pull|legs|spinta|tirata|upper|lower|corsa|cardio|bici|spinning|nuoto|camminata|yoga|pilates|crossfit|calisthenics|riposo|stretching|mobilità)\b/i;
const DURATION = /\b\d+(?:[.,]\d+)?\s*(?:min|minuti|h|ora|ore)\b|\b\d+h(?:\d+)?\b/i;
const MEAL = /^(colazione|pranzo|cena|spuntino|merenda|pasto)\b\s*[:,-]?\s*(.*)$/is;

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const num = (s) => +s.replace(",", ".");

export function shiftDate(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Data detta nel testo (oggi, ieri, l'altro ieri, 18/11, 18/11/26): [data, testo senza la data]
export function takeDate(text, today) {
  let t = ` ${text} `, date = today;
  const rel = [[/\b(?:l['’]\s*altro\s*ieri|altroieri|avantieri)\b/i, -2], [/\bieri\b/i, -1], [/\b(?:oggi|stamattina|stamani|stasera)\b/i, 0]];
  for (const [re, d] of rel) {
    if (!re.test(t)) continue;
    date = shiftDate(today, d);
    t = t.replace(re, " ");
    break;
  }
  const m = t.match(/(?:^|\s)(?:il\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?=\s|$|[:,])/i);
  if (m) {
    const [y0] = today.split("-").map(Number);
    let y = m[3] ? +m[3] : y0;
    if (y < 100) y += 2000;
    const iso = `${y}-${String(+m[2]).padStart(2, "0")}-${String(+m[1]).padStart(2, "0")}`;
    const ok = !Number.isNaN(Date.parse(`${iso}T12:00:00Z`)) && new Date(`${iso}T12:00:00Z`).toISOString().slice(0, 10) === iso;
    if (ok) {
      // Senza anno, una data dopo oggi è dell'anno scorso
      date = !m[3] && iso > today ? `${y - 1}${iso.slice(4)}` : iso;
      t = t.replace(m[0], " ");
    }
  }
  return [date, t.replace(/\s+/g, " ").replace(/^[\s:,-]+|[\s:,-]+$/g, "")];
}

// Una riga: { date, field, value } se la capisco, { date, ask } se no, null se è vuota
export function parseLine(line, today) {
  const [date, t] = takeDate(line, today);
  if (!t) return null;
  const low = t.toLowerCase();
  let m;
  if ((m = t.match(MEAL))) {
    const what = m[2].trim();
    return what ? { date, field: "meal", value: `${cap(m[1].toLowerCase())}: ${what}`.slice(0, TEXT_FIELDS.meal) } : { date, ask: t };
  }
  if ((m = low.match(/^(?:peso\s*[:=]?\s*)?(\d{2,3}(?:[.,]\d{1,2})?)\s*(?:kg|chili|chilo|kili)?$/))) return numItem(date, "weight", m[1], t);
  if ((m = low.match(/^(?:grasso|massa grassa|bf|body ?fat)\s*[:=]?\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*%?$/))
    || (m = low.match(/^(\d{1,2}(?:[.,]\d{1,2})?)\s*%\s*(?:di\s+)?(?:grasso|massa grassa|bf)?$/))) return numItem(date, "fat", m[1], t);
  if ((m = low.match(/^([a-z]+)\s*[:=]?\s*(\d{2,3}(?:[.,]\d)?)\s*(?:cm)?$/)) && CIRC[m[1]]) return numItem(date, CIRC[m[1]], m[2], t);
  if ((m = t.match(WORKOUT_LEAD))) {
    const rest = t.slice(m[0].length).trim();
    return { date, field: "workout", value: cap(rest || "allenamento").slice(0, TEXT_FIELDS.workout) };
  }
  if (WORKOUT_WORDS.test(low) || DURATION.test(low)) return { date, field: "workout", value: cap(t).slice(0, TEXT_FIELDS.workout) };
  return { date, ask: t };
}
function numItem(date, field, raw, t) {
  const v = num(raw), [min, max] = NUM_FIELDS[field];
  return v >= min && v <= max ? { date, field, value: String(Math.round(v * 10) / 10) } : { date, ask: t };
}

// Un messaggio: una voce per riga (o per ";"). Una riga di sole misure si può dividere anche con le virgole:
// "82,4, vita 84". Risponde { items, asks }
export function parseMessage(text, today) {
  const items = [], asks = [];
  for (const line of String(text).slice(0, 2000).split(/\n|;/)) {
    const r = parseLine(line, today);
    if (!r) continue;
    if (r.field) { items.push(r); continue; }
    const parts = line.split(/,\s+/);
    const each = parts.length > 1 ? parts.map((p) => parseLine(p, today)) : [];
    if (each.length && each.every((x) => x?.field && NUM_FIELDS[x.field])) items.push(...each);
    else asks.push(r);
  }
  return { items, asks };
}

// "peso 82,4 kg", "vita 84 cm", "grasso 18%", "allenamento: Gambe 60 min", "Cena: pizza"
const NAMES = { weight: "peso", fat: "grasso", neck: "collo", shoulders: "spalle", chest: "torace", arm: "braccio", waist: "vita", hips: "fianchi", thigh: "coscia", calf: "polpaccio" };
export function describeItem({ field, value }) {
  if (field === "meal") return value;
  if (field === "workout") return `allenamento: ${value}`;
  const v = String(value).replace(".", ",");
  return field === "fat" ? `grasso ${v}%` : field === "weight" ? `peso ${v} kg` : `${NAMES[field]} ${v} cm`;
}
