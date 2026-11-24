// Bot Telegram di FitProgress (Cloudflare Worker).
//
// - /telegram   messaggi da Telegram (webhook, solo col codice segreto WEBHOOK_SECRET): diario, foto, comandi, pulsanti
// - /api/…      la pagina aperta dentro Telegram (Mini App): coi dati firmati da Telegram, se l'utente è già entrato
//               (password scritta al bot), una sessione breve. Stato, file, salva.
//               /api/check: la piattaforma (GitHub Pages) controlla la password all'apertura
// - /setup      collega il bot a questo Worker (webhook, comandi, pulsante del menu): una volta sola, con WEBHOOK_SECRET
// - cron        ogni 15 minuti: promemoria per le foto, salvataggi non conservati da togliere (4 ore), pulizia
// - il resto    la pagina stessa (index.html e vendor/, copiati in public/ da npm run build, con public/_headers)
//
// Si entra su invito: chi non è in ALLOWED_IDS scrive al bot il codice d'accesso (ACCESS_CODE), una volta.
// Cosa resta qui (D1): chi è stato ammesso, impostazioni del promemoria, l'identificativo dell'ultimo file dei
// progressi nella chat (cifrato: lo apre solo la pagina), i salvataggi mandati in chat (per toglierli dopo 4 ore se
// non li conservi), le sessioni (solo impronte), per 7 giorni le foto, e finché non salvi le voci del diario (anche le note) arrivate in chat e non
// ancora prese dalla pagina (testi cifrati). Le foto e i file stanno su Telegram.
import { parseMessage, describeItem, takeDate, shiftDate, NUM_FIELDS, TEXT_FIELDS } from "./parse.js";
import { checkInitData, safeEqual } from "./auth.js";
import { localDate, nextReminder, shortDate } from "./time.js";
import { fileKey, sealText, openText, newToken, tokenHash, isFileFor, isPasswordFile, b64u, fromB64u, PP_HEADER } from "./crypto.js";

const EVERY = 14, HOUR = 8; // promemoria: ogni 14 giorni alle 8
const MAX_FILE = 20e6; // il bot riscarica file fino a 20 MB: più grandi non si potrebbero riaprire
const KEEP_DAYS = 7; // foto e voci non prese dalla pagina
const SESSION_IDLE = 2 * 3600e3, SESSION_MAX = 12 * 3600e3;
const INIT_MAX_AGE = 12 * 3600; // dati firmati da Telegram: quanto valgono per aprire (o riaprire) una sessione
const SAVE_TTL = 4 * 3600e3; // salvataggi nella chat non conservati: via dopo 4 ore (l'ultimo resta)
// Al giorno, per utente. newuser: utenti nuovi in tutto; code: password sbagliate nel bot (per utente);
// pcode: password sbagliate dalla piattaforma (per indirizzo IP); pcheck: password sbagliate dalla piattaforma in tutto
const LIMITS = { msg: 300, photo: 40, save: 60, api: 3000, newuser: 30, code: 5, pcode: 10, pcheck: 500 };
const BURST_MS = 4000; // foto in blocco: si risponde una volta sola, dopo questa pausa senza foto nuove
const enc = new TextEncoder();
const tz = (env) => env.TIME_ZONE || "Europe/Rome";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (!env.MASTER_KEY || !env.BOT_TOKEN || !env.WEBHOOK_SECRET) return json({ error: "config" }, 503);
      if (url.pathname === "/telegram" && request.method === "POST") return await webhook(request, env, ctx, url);
      if (url.pathname === "/setup" && request.method === "POST") return await setup(request, env, url);
      if (url.pathname.startsWith("/api/")) return await api(request, env, url);
      return new Response("Non trovato", { status: 404, headers: SECURITY_HEADERS });
    } catch (e) {
      console.error(e?.message || "errore");
      return json({ error: "server" }, 500);
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(Promise.all([reminders(env), dropSaves(env), cleanup(env)]));
  },
};

const SECURITY_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...SECURITY_HEADERS } });

// ------------------------------------------------------------------ Telegram Bot API

// TG_API: solo per le prove in locale, con un finto Telegram (test/fake-telegram.mjs)
const tgBase = (env) => env.TG_API || "https://api.telegram.org";
async function tg(env, method, body) {
  const res = await fetch(`${tgBase(env)}/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  if (!data.ok) {
    const e = new Error(`${method}: ${data.description}`);
    e.code = data.error_code;
    throw e;
  }
  return data.result;
}
const send = (env, chatId, text, extra = {}) => tg(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra });
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const openButton = (page) => ({ text: "Apri FitProgress", web_app: { url: page } });
async function telegramFile(env, fileId) {
  const f = await tg(env, "getFile", { file_id: fileId });
  const res = await fetch(`${tgBase(env)}/file/bot${env.BOT_TOKEN}/${f.file_path}`);
  if (!res.ok) throw new Error("telegram file");
  return { res, path: f.file_path };
}
// I primi byte di un file su Telegram (per riconoscere un file dei progressi senza scaricarlo tutto)
async function fileHead(env, fileId, n) {
  const { res } = await telegramFile(env, fileId);
  const r = res.body.getReader(), out = new Uint8Array(n);
  let got = 0;
  while (got < n) {
    const { done, value } = await r.read();
    if (done) break;
    const take = value.subarray(0, n - got);
    out.set(take, got);
    got += take.length;
  }
  r.cancel().catch(() => {});
  return out.subarray(0, got);
}

// Il file dei progressi (già cifrato dalla pagina con la password) va a Telegram mentre arriva, senza tenerlo tutto
// in memoria. Prima di mandarlo si controlla che sia un file cifrato (FPP1): se no non parte niente
async function sendDocumentStream(env, chatId, body, length, filename, caption, markup) {
  const boundary = `fp${crypto.randomUUID().replace(/-/g, "")}`;
  const field = (name, value) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const head = enc.encode(field("chat_id", chatId) + field("caption", caption) + field("reply_markup", JSON.stringify(markup))
    + `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const { readable, writable } = new FixedLengthStream(head.length + length + tail.length);
  const w = writable.getWriter(), r = body.getReader();
  // Primi byte: l'intestazione di un file cifrato con la password
  const first = new Uint8Array(PP_HEADER);
  let got = 0;
  const pending = [];
  while (got < PP_HEADER) {
    const { done, value } = await r.read();
    if (done) break;
    pending.push(value);
    const take = value.subarray(0, PP_HEADER - got);
    first.set(take, got);
    got += take.length;
  }
  if (got < PP_HEADER || !isPasswordFile(first)) {
    r.cancel().catch(() => {});
    throw Object.assign(new Error("not-encrypted"), { status: 400 });
  }
  const pump = (async () => {
    await w.write(head);
    for (const chunk of pending) await w.write(chunk);
    for (;;) {
      const { done, value } = await r.read();
      if (done) break;
      await w.write(value);
    }
    await w.write(tail);
    await w.close();
  })();
  const [res] = await Promise.all([
    fetch(`${tgBase(env)}/bot${env.BOT_TOKEN}/sendDocument`, { method: "POST", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }, body: readable }),
    pump,
  ]);
  const data = await res.json().catch(() => ({ ok: false }));
  if (!data.ok) throw new Error(`sendDocument: ${data.description}`);
  return data.result;
}

// ------------------------------------------------------------------ utenti, limiti

// Chi entra: gli ID in ALLOWED_IDS (secret: ID separati da virgole, * per tutti) e chi ha scritto il codice
// d'accesso (ACCESS_CODE, secret: lo dai tu ai tester). u: la riga dell'utente, se c'è già
function isAdmin(env, id) {
  const ids = String(env.ALLOWED_IDS || "").split(/[\s,]+/).filter(Boolean);
  return ids.includes("*") || ids.includes(String(id));
}
const allowed = (env, id, u) => isAdmin(env, id) || u?.admitted === 1;
const getUser = (env, id) => env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
// L'utente, creato se non c'è (dentro il limite di utenti nuovi al giorno). null: oltre il limite
async function ensureUser(env, id) {
  const u = await getUser(env, id);
  if (u) return u;
  if (!(await within(env, 0, "newuser"))) return null;
  const now = Date.now();
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, every_days, hour, paused, next_at, created_at) VALUES (?, ?, ?, 0, ?, ?)")
    .bind(id, EVERY, HOUR, nextReminder(now, EVERY, HOUR, tz(env)), now).run();
  return getUser(env, id);
}
async function pageUrl(env, origin) {
  if (origin) return `${origin}/`;
  return (await env.DB.prepare("SELECT v FROM meta WHERE k = 'page'").first())?.v || null;
}
const setUser = (env, id, sql, ...args) => env.DB.prepare(`UPDATE users SET ${sql} WHERE id = ?`).bind(...args, id).run();
// D1 accetta al massimo 100 valori per query: gli elenchi di righe vanno a pezzi
const chunks = (xs, n = 90) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
// Conta un'azione di oggi; risponde se è ancora dentro il limite
const used = async (env, userId, kind) => (await env.DB.prepare("SELECT n FROM usage WHERE user_id = ? AND day = ? AND kind = ?").bind(userId, localDate(Date.now(), tz(env)), kind).first())?.n || 0;
async function within(env, userId, kind, n = 1) {
  const day = localDate(Date.now(), tz(env));
  const row = await env.DB.prepare("INSERT INTO usage (user_id, day, kind, n) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, day, kind) DO UPDATE SET n = n + excluded.n RETURNING n")
    .bind(userId, day, kind, n).first();
  return row.n <= LIMITS[kind];
}
const seal = (env, uid, s) => sealText(env.MASTER_KEY, uid, s);
const unseal = (env, uid, s) => openText(env.MASTER_KEY, uid, s);

// ------------------------------------------------------------------ messaggi dalla chat

async function webhook(request, env, ctx, url) {
  if (!safeEqual(request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "", env.WEBHOOK_SECRET)) return new Response("No", { status: 401 });
  if (Number(request.headers.get("Content-Length")) > 1e6) return new Response("ok"); // un update non è mai così grande
  const update = await request.json().catch(() => null);
  if (update) ctx.waitUntil(onUpdate(update, env, url.origin).catch((e) => console.error(e?.message || "errore")));
  return new Response("ok");
}
async function onUpdate(update, env, origin) {
  if (update.message) return onMessage(update.message, env, origin);
  if (update.callback_query) return onCallback(update.callback_query, env, origin);
}

const HELP = (u) => [
  "<b>Come funziona</b>",
  "",
  "1️⃣ Fai le foto dei progressi e <b>mandamele qui</b>, anche tutte insieme. Se vuoi, scrivi nella didascalia <i>fronte</i>, <i>lato</i> o <i>schiena</i>.",
  "2️⃣ Tocca <b>Apri FitProgress</b>: le allineo e le misuro.",
  "3️⃣ Controlla e tocca <b>Salva</b>: ti rimando qui il file dei progressi.",
  "",
  "📌 Ogni file resta qui 4 ore, l'ultimo sempre. Per tenerne uno, tocca <b>Conserva</b> sotto il file.",
  "",
  "📝 <b>Diario</b>: scrivimi quando vuoi, per esempio",
  "• il peso: <code>82,4</code>",
  "• una misura: <code>vita 84</code> · <code>grasso 18</code>",
  "• l'allenamento: <code>gambe 60 min</code>",
  "• un pasto: <code>cena ieri pizza</code>",
  "",
  `⏰ Ogni ${u.every_days} giorni alle ${u.hour} ti ricordo le foto${u.paused ? " (ora in pausa)" : ""}. Per cambiarlo: /promemoria`,
  "",
  "Tengo tutto da parte e lo metto nel diario del file quando salvi. /diario mostra cosa ho tenuto.",
  "",
  "/confronto · mi mandi una foto di prima e una di adesso, e te le metto a confronto",
  "/start rivede questo messaggio · /esporta ti rimanda l'ultimo file · /cancella toglie tutto quello che so di te",
].join("\n");

async function onMessage(msg, env, origin) {
  if (msg.chat?.type !== "private" || !msg.from || msg.from.is_bot) return;
  const uid = msg.from.id;
  if (!allowed(env, uid, await getUser(env, uid))) return askCode(msg, env, origin);
  const u = await ensureUser(env, uid);
  if (!u) return send(env, uid, "Oggi non posso accettare utenti nuovi. Riprova domani.");
  if (!(await within(env, uid, "msg"))) return; // oltre il limite di oggi: silenzio
  const page = await pageUrl(env, origin);
  const image = msg.photo?.length ? msg.photo[msg.photo.length - 1] : msg.document?.mime_type?.startsWith("image/") ? msg.document : null;
  if (image) {
    if (image.file_size > MAX_FILE) return send(env, uid, "Questa foto è troppo grande (oltre 20 MB): mandala come foto normale, non come file.");
    // Primo confronto: la prima foto è la partenza, la seconda è adesso (anche se arrivano insieme, in un album).
    // Lo stato si cambia con una sola istruzione: due foto che arrivano insieme non diventano tutte e due partenza
    if (u.onboard === "start" || u.onboard === "date" || u.onboard === "now") {
      const toDate = await env.DB.prepare("UPDATE users SET onboard = 'date' WHERE id = ? AND onboard = 'start' RETURNING id").bind(uid).first();
      if (toDate) return onStartPhoto(msg, image, u, env);
      const toNow = await env.DB.prepare("UPDATE users SET onboard = 'nowing' WHERE id = ? AND onboard IN ('date', 'now') RETURNING id").bind(uid).first();
      if (toNow) return onNowPhoto(msg, image, u, env, page);
    }
    return onPhoto(msg, image, u, env, page);
  }
  if (msg.document) return onDocument(msg, u, env, page);
  const text = (msg.text || "").trim();
  if (u.onboard === "date" && text && !text.startsWith("/")) return onStartDate(text, u, env);
  if (!text) return send(env, uid, "Mandami le foto dei progressi, oppure scrivimi peso, misure, allenamento o pasto. /start per vedere come funziona.");
  const cmd = text.match(/^\/([a-z]+)(?:@\w+)?\s*(.*)$/is);
  if (cmd) return onCommand(cmd[1].toLowerCase(), cmd[2].trim(), u, env, page);
  return onDiary(text, u, env);
}

// Non ancora entrato: la password (ACCESS_CODE), scritta qui una volta sola. Il messaggio si toglie subito dalla chat.
// 5 tentativi al giorno; finché non entri il bot non tiene niente di te (solo il conteggio dei tentativi)
async function askCode(msg, env, origin) {
  const uid = msg.from.id, text = (msg.text || "").trim();
  if (!text || text.startsWith("/")) {
    return send(env, uid, "Ciao! Sono il bot di <b>FitProgress</b>: confronto le foto dei progressi in palestra e tengo il diario di peso, misure, allenamenti e pasti.\n\nPer ora è riservato a chi ha la password: <b>scrivimela qui sotto</b>. Te la chiedo solo questa volta, e il messaggio lo cancello subito.");
  }
  await tg(env, "deleteMessage", { chat_id: uid, message_id: msg.message_id }).catch(() => {}); // la password non resta in chat
  if (!env.ACCESS_CODE || !safeEqual(text, env.ACCESS_CODE)) {
    if (!(await within(env, uid, "code"))) return send(env, uid, "Troppi tentativi per oggi. Riprova domani.");
    const left = LIMITS.code - (await used(env, uid, "code"));
    return send(env, uid, left > 0 ? `Password sbagliata. ${left === 1 ? "Ti resta 1 tentativo" : `Ti restano ${left} tentativi`} per oggi.` : "Password sbagliata. Per oggi i tentativi sono finiti: riprova domani.");
  }
  const u = await ensureUser(env, uid);
  if (!u) return send(env, uid, "Oggi non posso accettare utenti nuovi. Riprova domani.");
  await setUser(env, uid, "admitted = 1");
  return askFirst(env, uid, "✅ <b>Sei dentro.</b> La password non te la chiedo più, nemmeno quando apri FitProgress da qui.\n\n");
}

// ------------------------------------------------------------------ primo confronto
//
// Dopo la password (o con /confronto): hai già una foto di prima da confrontare, o inizi adesso?
// Con un confronto: prima la foto di partenza (e quando l'hai fatta), poi quella di adesso. users.onboard dice a
// che punto sei: "ask" (domanda fatta), "start" (aspetto la partenza), "date" (aspetto la sua data), "now" (aspetto
// quella di adesso). Le due foto hanno role "start" e "now": la pagina le mette come Prima e Dopo
const FIRST_BUTTONS = { inline_keyboard: [[{ text: "📸 Ho una foto di prima", callback_data: "o:pair" }], [{ text: "🌱 Inizio adesso", callback_data: "o:new" }]] };
async function askFirst(env, uid, lead = "") {
  await setUser(env, uid, "onboard = 'ask'");
  return send(env, uid, `${lead}Hai già una foto di <b>prima</b> da confrontare con com'è <b>adesso</b>, o inizi oggi?`, { reply_markup: FIRST_BUTTONS });
}
// "15/03/2026", "15/3", "ieri": la data di oggi o di prima, o null
function dayOf(text, today) {
  const [d, rest] = takeDate(text, today);
  if (d === today && !/\b(oggi|stamattina|stasera)\b/i.test(text)) return null;
  return d <= today && rest.length < 20 ? d : null;
}
// La foto di partenza: arriva, poi chiedo quando è stata fatta
async function onStartPhoto(msg, image, u, env) {
  await env.DB.prepare("INSERT INTO photos (user_id, file_id, message_id, sent_at, caption, role) VALUES (?, ?, ?, ?, ?, 'start')")
    .bind(u.id, image.file_id, msg.message_id, msg.date, msg.caption ? await seal(env, u.id, msg.caption.slice(0, 200)) : "").run();
  return send(env, u.id, "👍 Questa è la <b>partenza</b>.\n\nQuando l'hai fatta? Scrivimi la data, per esempio <code>15/03/2026</code>.", {
    reply_markup: { inline_keyboard: [[{ text: "Non me la ricordo", callback_data: "o:nodate" }]] },
  });
}
async function onStartDate(text, u, env) {
  const today = localDate(Date.now(), tz(env)), d = dayOf(text, today);
  if (!d) return send(env, u.id, "Non ho capito la data. Scrivila così: <code>15/03/2026</code>. Oppure tocca «Non me la ricordo».", {
    reply_markup: { inline_keyboard: [[{ text: "Non me la ricordo", callback_data: "o:nodate" }]] },
  });
  await env.DB.prepare("UPDATE photos SET taken = ? WHERE user_id = ? AND role = 'start'").bind(d, u.id).run();
  await setUser(env, u.id, "onboard = 'now'");
  return send(env, u.id, `Partenza del ${d.split("-").reverse().join("/")}. 📸 Ora mandami una foto di <b>adesso</b>, nella stessa posa.`);
}
// La foto di adesso: con la partenza è il confronto. Se la data della partenza non c'è, la pagina la mette al giorno prima
async function onNowPhoto(msg, image, u, env, page) {
  await env.DB.prepare("INSERT INTO photos (user_id, file_id, message_id, sent_at, caption, role) VALUES (?, ?, ?, ?, ?, 'now')")
    .bind(u.id, image.file_id, msg.message_id, msg.date, msg.caption ? await seal(env, u.id, msg.caption.slice(0, 200)) : "").run();
  await setUser(env, u.id, "onboard = NULL, next_at = ?", nextReminder(Date.now(), u.every_days, u.hour, tz(env)));
  const ack = await send(env, u.id, "✅ Ho la <b>partenza</b> e la foto di <b>adesso</b>.\nTocca <b>Apri FitProgress</b>: le allineo e te le metto a confronto. Poi tocca <b>Salva</b>.",
    page ? { reply_markup: { inline_keyboard: [[openButton(page)]] } } : {});
  await setUser(env, u.id, "ack_id = ?", ack.message_id);
}


async function onCommand(cmd, arg, u, env, page) {
  const id = u.id;
  if (cmd === "start" || cmd === "aiuto" || cmd === "help") {
    return send(env, id, HELP(u), page ? { reply_markup: { inline_keyboard: [[openButton(page)]] } } : {});
  }
  if (cmd === "confronto") return askFirst(env, id);
  if (cmd === "diario") {
    const rows = (await env.DB.prepare("SELECT date, field, value FROM diary WHERE user_id = ? ORDER BY date, id LIMIT 200").bind(id).all()).results;
    if (!rows.length) return send(env, id, "Non ho voci del diario da parte. Scrivimi peso, misure, allenamento o pasti quando vuoi.");
    const lines = [];
    for (const r of rows) {
      const v = await unseal(env, id, r.value);
      if (v) lines.push(`• ${r.date.split("-").slice(1).reverse().join("/")} · ${esc(r.field === "note" ? `nota: ${v}` : describeItem({ field: r.field, value: v }))}`);
    }
    return send(env, id, `📝 <b>Voci del diario da mettere nel file</b> (${rows.length}):\n${lines.join("\n")}\n\nEntrano nel diario la prossima volta che salvi in FitProgress.`);
  }
  if (cmd === "esporta") {
    if (!u.last_json) return send(env, id, "Non hai ancora salvato niente: mandami le foto, apri FitProgress e tocca Salva.");
    const sent = await tg(env, "sendDocument", { chat_id: id, document: u.last_json, caption: "📦 Una copia dell'ultimo file dei progressi.\nResta qui 4 ore: per tenerla tocca «Conserva».", reply_markup: keepMarkup(false) });
    return trackSave(env, id, sent);
  }
  if (cmd === "cancella") {
    return send(env, id, "Tolgo tutto quello che so di te: l'accesso (poi ti chiedo di nuovo la password), i promemoria, le foto e le voci del diario non ancora salvate, il collegamento all'ultimo file dei progressi.\n\nQuello che c'è in questa chat resta: per toglierlo, cancella la chat.\n\nSei sicuro?", {
      reply_markup: { inline_keyboard: [[{ text: "Sì, cancella tutto", callback_data: "x:yes" }, { text: "No", callback_data: "x:no" }]] },
    });
  }
  if (cmd === "ogni") {
    const n = parseInt(arg, 10);
    if (!(n >= 1 && n <= 90)) return send(env, id, "Scrivi quanti giorni, fra 1 e 90: per esempio /ogni 14");
    const next = nextReminder(Date.now(), n, u.hour, tz(env));
    await setUser(env, id, "every_days = ?, next_at = ?", n, next);
    return send(env, id, `Ti ricordo le foto ogni ${n} ${n === 1 ? "giorno" : "giorni"}. Il prossimo il ${shortDate(next, tz(env))} alle ${u.hour}.`);
  }
  if (cmd === "ora") {
    const h = parseInt(arg, 10);
    if (!(h >= 0 && h <= 23) || !/^\d{1,2}$/.test(arg)) return send(env, id, "Scrivi l'ora, fra 0 e 23: per esempio /ora 8");
    // Stesso giorno del prossimo promemoria, all'ora nuova; se è già passata, domani
    let at = nextReminder(u.next_at || Date.now(), 0, h, tz(env));
    if (at <= Date.now()) at = nextReminder(Date.now(), 1, h, tz(env));
    await setUser(env, id, "hour = ?, next_at = ?", h, at);
    return send(env, id, `Ti ricordo le foto alle ${h}. Il prossimo il ${shortDate(at, tz(env))}.`);
  }
  if (cmd === "pausa") {
    await setUser(env, id, "paused = 1");
    return send(env, id, "Promemoria in pausa. /riprendi quando vuoi.");
  }
  if (cmd === "riprendi") {
    const next = nextReminder(Date.now(), u.every_days, u.hour, tz(env));
    await setUser(env, id, "paused = 0, next_at = ?", next);
    return send(env, id, `Promemoria ripresi: il prossimo il ${shortDate(next, tz(env))} alle ${u.hour}.`);
  }
  if (cmd === "promemoria") {
    const now = u.paused ? "⏸ I promemoria sono in pausa." : `⏰ Ti ricordo le foto ogni ${u.every_days} giorni alle ${u.hour}. Il prossimo il ${shortDate(u.next_at, tz(env))}.`;
    return send(env, id, `${now}\n\nPer cambiare:\n• /ogni 7 · ogni quanti giorni\n• /ora 19 · a che ora\n• /pausa · li fermo\n• /riprendi · li riprendo`);
  }
  return send(env, id, HELP(u));
}

// Diario in chat: ogni messaggio resta (cifrato) finché non salvi in FitProgress, che lo mette nel diario del file.
// Quello che non capisco resta come nota, e chiedo se è un allenamento o un pasto
async function onDiary(text, u, env) {
  const today = localDate(Date.now(), tz(env));
  const { items, asks } = parseMessage(text, today);
  const now = Date.now();
  const add = async (date, field, value) => (await env.DB.prepare("INSERT INTO diary (user_id, date, field, value, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id").bind(u.id, date, field, await seal(env, u.id, value), now).first()).id;
  for (const it of items) await add(it.date, it.field, it.value);
  if (items.length) await send(env, u.id, `✍️ Segnato ${dayWords(items[0].date, today)}: ${esc(items.map(describeItem).join(" · "))}.\nVa nel diario la prossima volta che salvi in FitProgress.`);
  for (const a of asks.slice(0, 3)) {
    const note = (a.ask.charAt(0).toUpperCase() + a.ask.slice(1)).slice(0, 200);
    const diaryId = await add(a.date, "note", note);
    const row = await env.DB.prepare("INSERT INTO asks (user_id, date, text, created_at, diary_id) VALUES (?, ?, ?, ?, ?) RETURNING id").bind(u.id, a.date, await seal(env, u.id, note), now, diaryId).first();
    await send(env, u.id, `✍️ Ho segnato «${esc(note.slice(0, 120))}» come nota ${dayWords(a.date, today)}. È un allenamento o un pasto?`, {
      reply_markup: { inline_keyboard: [[
        { text: "Allenamento", callback_data: `a:${row.id}:workout` },
        { text: "Pasto", callback_data: `a:${row.id}:meal` },
      ], [
        { text: "Va bene come nota", callback_data: `a:${row.id}:note` },
        { text: "Non segnarlo", callback_data: `a:${row.id}:no` },
      ]] },
    });
  }
}
function dayWords(date, today) {
  const d = date.split("-").slice(1).reverse().join("/");
  if (date === today) return "per oggi";
  const y = new Date(`${today}T12:00:00Z`);
  y.setUTCDate(y.getUTCDate() - 1);
  return date === y.toISOString().slice(0, 10) ? `per ieri, ${d}` : `per il ${d}`;
}

// Foto in blocco: ognuna si mette in attesa; la risposta è una sola, mandata dopo BURST_MS senza foto nuove
// (l'ultima foto arrivata vince: burst). La risposta di prima si toglie, così quella giusta è sempre in fondo
async function onPhoto(msg, image, u, env, page) {
  if (image.file_size > MAX_FILE) return send(env, u.id, "Questa foto è troppo grande (oltre 20 MB): mandala come foto normale, non come file.");
  if (!(await within(env, u.id, "photo"))) return send(env, u.id, "Per oggi ho già tutte le foto che posso prendere. Mandami le altre domani.");
  await env.DB.prepare("INSERT INTO photos (user_id, file_id, message_id, sent_at, caption) VALUES (?, ?, ?, ?, ?)")
    .bind(u.id, image.file_id, msg.message_id, msg.date, msg.caption ? await seal(env, u.id, msg.caption.slice(0, 200)) : "").run();
  // Le foto contano come promemoria fatto
  const burst = crypto.randomUUID();
  await setUser(env, u.id, "next_at = ?, burst = ?", nextReminder(Date.now(), u.every_days, u.hour, tz(env)), burst);
  await new Promise((r) => setTimeout(r, Number(env.BURST_MS) || BURST_MS));
  const now = await getUser(env, u.id);
  if (now?.burst !== burst) return; // è arrivata un'altra foto: risponde lei
  const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM photos WHERE user_id = ?").bind(u.id).first()).n;
  const d = (await env.DB.prepare("SELECT COUNT(*) AS n FROM diary WHERE user_id = ?").bind(u.id).first()).n;
  if (now.ack_id) await tg(env, "deleteMessage", { chat_id: u.id, message_id: now.ack_id }).catch(() => {});
  const diaryLine = d ? `\n📝 Ho anche ${d === 1 ? "1 voce" : `${d} voci`} del diario: le metto nel file insieme alle foto.` : "";
  const ack = await send(env, u.id, `📷 <b>${n === 1 ? "Ho 1 foto" : `Ho ${n} foto`}</b> da preparare.${diaryLine}\nSe hai altre foto mandale pure. Quando hai finito, tocca <b>Apri FitProgress</b>: le preparo e con <b>Salva</b> va tutto nel file.`,
    page ? { reply_markup: { inline_keyboard: [[openButton(page)]] } } : {});
  await setUser(env, u.id, "ack_id = ?", ack.message_id);
}

// Un file inoltrato: se è un file dei progressi cifrato per questo utente, si riparte da lì
async function onDocument(msg, u, env, page) {
  const doc = msg.document;
  if (!doc.file_size || doc.file_size > MAX_FILE) return send(env, u.id, "Questo file non lo posso usare.");
  const { id } = await fileKey(env.MASTER_KEY, u.id);
  let head = null;
  try { head = await fileHead(env, doc.file_id, PP_HEADER); } catch { /* non si scarica */ }
  if (!isPasswordFile(head) && !isFileFor(head, id)) return send(env, u.id, "Questo non è un file dei progressi. Per ripartire da un salvataggio vecchio, inoltrami uno dei file che ti ho mandato io.");
  await setUser(env, u.id, "last_json = ?, last_msg = ?", doc.file_id, msg.message_id);
  return send(env, u.id, "Riparto da questo file dei progressi: tocca <b>Apri FitProgress</b>.", page ? { reply_markup: { inline_keyboard: [[openButton(page)]] } } : {});
}

// Tutto quello che il bot sa di un utente, via
async function forget(env, uid) {
  const photos = (await env.DB.prepare("SELECT message_id, reply_id FROM photos WHERE user_id = ?").bind(uid).all()).results;
  const messages = photos.flatMap((r) => [r.message_id, r.reply_id]).filter(Boolean);
  const ack = (await getUser(env, uid))?.ack_id;
  if (ack) messages.push(ack);
  for (const m of chunks(messages, 100)) await tg(env, "deleteMessages", { chat_id: uid, message_ids: m }).catch(() => {});
  await env.DB.batch(["photos", "diary", "asks", "sessions", "usage", "saves"].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(uid))
    .concat(env.DB.prepare("DELETE FROM users WHERE id = ?").bind(uid)));
}

async function onCallback(q, env, origin) {
  const uid = q.from?.id, data = q.data || "";
  const answer = (text) => tg(env, "answerCallbackQuery", { callback_query_id: q.id, ...(text ? { text } : {}) }).catch(() => {});
  const u = uid ? await getUser(env, uid) : null;
  if (!u || !allowed(env, uid, u) || !(await within(env, uid, "msg"))) return answer();
  const page = await pageUrl(env, origin);
  const chatId = q.message?.chat?.id, messageId = q.message?.message_id;
  if (chatId !== uid) return answer();
  const keepOpen = page ? { inline_keyboard: [[openButton(page)]] } : { inline_keyboard: [] };
  const edit = (text, markup = { inline_keyboard: [] }) => tg(env, "editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", reply_markup: markup }).catch(() => {});
  let m;
  if (data === "o:pair") {
    // Una partenza vecchia rimasta a metà si toglie
    await env.DB.prepare("UPDATE photos SET role = NULL WHERE user_id = ? AND role IS NOT NULL").bind(uid).run();
    await setUser(env, uid, "onboard = 'start'");
    await answer();
    return edit("📸 Mandami la foto di <b>partenza</b>: quella di prima, da cui vuoi vedere i progressi.\nPoi ti chiedo quella di adesso.");
  }
  if (data === "o:new") {
    await setUser(env, uid, "onboard = NULL");
    await answer();
    await edit("🌱 Perfetto: le foto che mi mandi oggi saranno la tua <b>partenza</b>. Fra qualche settimana le rifai e vedi cosa è cambiato.");
    return send(env, uid, HELP(u), page ? { reply_markup: { inline_keyboard: [[openButton(page)]] } } : {});
  }
  if (data === "o:nodate") {
    const ok = await env.DB.prepare("UPDATE users SET onboard = 'now' WHERE id = ? AND onboard = 'date' RETURNING id").bind(uid).first();
    await answer();
    if (!ok) return;
    return edit("Va bene: la metto come la foto più vecchia, la data la puoi cambiare in FitProgress (Data e posa).\n\n📸 Ora mandami una foto di <b>adesso</b>, nella stessa posa.");
  }
  if ((m = data.match(/^(k|u)$/))) {
    const row = await env.DB.prepare("SELECT * FROM saves WHERE user_id = ? AND message_id = ?").bind(uid, messageId || 0).first();
    if (!row) { await answer("Non lo trovo più"); return; }
    const keep = m[1] === "k";
    await env.DB.prepare("UPDATE saves SET kept = ? WHERE user_id = ? AND message_id = ?").bind(keep ? 1 : 0, uid, row.message_id).run();
    await tg(env, "editMessageReplyMarkup", { chat_id: uid, message_id: row.message_id, reply_markup: keepMarkup(keep) }).catch(() => {});
    return answer(keep ? "Conservato: resta nella chat" : "Non più conservato: lo tolgo passate le 4 ore (se non è l'ultimo)");
  }
  if ((m = data.match(/^x:(yes|no)$/))) {
    if (m[1] === "no") { await answer(); return edit("Non ho cancellato niente."); }
    await forget(env, uid);
    await answer("Cancellato");
    return edit("Ho tolto tutto quello che sapevo di te. Per togliere anche messaggi e file da questa chat, cancella la chat. /start per ricominciare.");
  }
  if ((m = data.match(/^r:(done|later|pause)$/))) {
    const now = Date.now();
    if (m[1] === "pause") {
      await setUser(env, uid, "paused = 1");
      await answer("Promemoria in pausa");
      return edit("Promemoria in pausa. /riprendi quando vuoi.");
    }
    const next = nextReminder(now, m[1] === "done" ? u.every_days : 1, u.hour, tz(env));
    await setUser(env, uid, "next_at = ?, paused = 0", next);
    await answer(m[1] === "done" ? "Fatto" : "Te lo ricordo domani");
    return edit(m[1] === "done" ? `Fatto. Il prossimo promemoria il ${shortDate(next, tz(env))}.\n\nMandami le foto qui, poi aprile in FitProgress.` : `Te lo ricordo domani alle ${u.hour}.`, m[1] === "done" ? keepOpen : undefined);
  }
  if ((m = data.match(/^a:(\d+):(workout|meal|note|no)$/))) {
    const ask = await env.DB.prepare("SELECT * FROM asks WHERE id = ? AND user_id = ?").bind(+m[1], uid).first();
    await env.DB.prepare("DELETE FROM asks WHERE id = ? AND user_id = ?").bind(+m[1], uid).run();
    if (!ask) { await answer(); return edit("Già fatto."); }
    const text = (await unseal(env, uid, ask.text)) || "";
    const day = dayWords(ask.date, localDate(Date.now(), tz(env)));
    // La nota è già nel diario in attesa: si sposta, si lascia o si toglie
    const row = ask.diary_id ? await env.DB.prepare("SELECT id FROM diary WHERE id = ? AND user_id = ?").bind(ask.diary_id, uid).first() : null;
    if (m[2] === "no") {
      if (row) await env.DB.prepare("DELETE FROM diary WHERE id = ?").bind(row.id).run();
      await answer("Non segnato");
      return edit(`Non l'ho segnato: «${esc(text)}».`);
    }
    if (m[2] === "note") { await answer("Resta come nota"); return edit(`✍️ Segnato ${day} come nota: «${esc(text)}».`); }
    const value = text.slice(0, TEXT_FIELDS[m[2]]);
    if (row) await env.DB.prepare("UPDATE diary SET field = ?, value = ? WHERE id = ?").bind(m[2], await seal(env, uid, value), row.id).run();
    else await env.DB.prepare("INSERT INTO diary (user_id, date, field, value, created_at) VALUES (?, ?, ?, ?, ?)").bind(uid, ask.date, m[2], await seal(env, uid, value), Date.now()).run();
    await answer("Segnato");
    return edit(`✍️ Segnato ${day}: ${esc(describeItem({ field: m[2], value }))}.`);
  }
  return answer();
}

// ------------------------------------------------------------------ cron: promemoria e pulizia

// Le righe della guida arrivano dalla pagina in HTML con solo <b>: tutto il resto si scrive com'è
const safeLine = (s) => esc(s).replace(/&lt;(\/?)b&gt;/g, "<$1b>");
async function reminderText(env, u) {
  let guide = null;
  try { guide = u.guide ? JSON.parse(await unseal(env, u.id, u.guide)) : null; } catch { /* rovinata */ }
  const lines = guide?.lines?.length
    ? [`${esc(guide.pose)}, come nel riferimento:`, ...guide.lines.map((l) => `• ${safeLine(l)}`)]
    : ["Stesso posto, stessa luce, stessa distanza dallo specchio. In FitProgress, nella scheda Guida, scegli una foto di riferimento: qui ti ricordo i suoi numeri."];
  return ["📷 <b>Oggi tocca alle foto dei progressi</b>", "", ...lines, "", "Quando le hai fatte, mandamele qui (anche tutte insieme)."].join("\n");
}
async function reminders(env) {
  const now = Date.now(), page = await pageUrl(env, null);
  const { results } = await env.DB.prepare("SELECT * FROM users WHERE paused = 0 AND next_at <= ? ORDER BY next_at LIMIT 50").bind(now).all();
  for (const u of results) {
    if (!allowed(env, u.id, u)) continue;
    // Senza risposta te lo ricordo di nuovo domani
    await setUser(env, u.id, "next_at = ?", nextReminder(now, 1, u.hour, tz(env)));
    try {
      await send(env, u.id, await reminderText(env, u), {
        reply_markup: { inline_keyboard: [
          [{ text: "Fatto", callback_data: "r:done" }, { text: "Domani", callback_data: "r:later" }, { text: "Pausa", callback_data: "r:pause" }],
          ...(page ? [[openButton(page)]] : []),
        ] },
      });
    } catch (e) {
      // Bot bloccato o chat cancellata: niente più promemoria
      if (e.code === 403) await setUser(env, u.id, "paused = 1");
      else console.error(e?.message || "errore");
    }
  }
}
// Storico nella chat: ogni salvataggio ha sotto Conserva; quelli non conservati si tolgono dopo SAVE_TTL, tranne
// l'ultimo (è quello da cui riparte la pagina). Telegram lascia togliere i messaggi solo entro 48 ore
// Il pulsante non dice quale messaggio: lo sa il bot, dal messaggio su cui l'hai toccato
const keepMarkup = (kept) => ({ inline_keyboard: [[kept
  ? { text: "📌 Conservato · tocca per non tenerlo", callback_data: "u" }
  : { text: "📌 Conserva", callback_data: "k" }]] });
async function trackSave(env, uid, sent, latest = false) {
  await env.DB.prepare("INSERT OR REPLACE INTO saves (user_id, message_id, file_id, sent_at, kept) VALUES (?, ?, ?, ?, 0)").bind(uid, sent.message_id, sent.document.file_id, Date.now()).run();
  if (latest) await setUser(env, uid, "last_msg = ?", sent.message_id);
}
async function dropSaves(env) {
  const old = Date.now() - SAVE_TTL;
  const { results } = await env.DB.prepare(`SELECT s.user_id, s.message_id FROM saves s JOIN users u ON u.id = s.user_id
    WHERE s.kept = 0 AND s.sent_at < ? AND s.message_id IS NOT u.last_msg LIMIT 200`).bind(old).all();
  for (const s of results) {
    await tg(env, "deleteMessage", { chat_id: s.user_id, message_id: s.message_id }).catch(() => {}); // oltre 48 ore resta
    await env.DB.prepare("DELETE FROM saves WHERE user_id = ? AND message_id = ?").bind(s.user_id, s.message_id).run();
  }
}

// Foto non prese entro KEEP_DAYS, domande senza risposta (la nota resta nel diario), sessioni scadute, conteggi vecchi: via.
// Le voci del diario restano finché non salvi
async function cleanup(env) {
  const now = Date.now(), old = now - KEEP_DAYS * 864e5;
  const day = localDate(now - 3 * 864e5, tz(env));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM photos WHERE sent_at < ?").bind(Math.floor(old / 1000)),
    env.DB.prepare("DELETE FROM asks WHERE created_at < ?").bind(old),
    env.DB.prepare("DELETE FROM sessions WHERE last_at < ? OR created_at < ?").bind(now - SESSION_IDLE, now - SESSION_MAX),
    env.DB.prepare("DELETE FROM usage WHERE day < ?").bind(day),
  ]);
}

// ------------------------------------------------------------------ la pagina (Mini App)

const ids = (request, name) => [...new Set((request.headers.get(name) || "").split(",").map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))].slice(0, 1000);
function fromB64url(s) {
  if (!s || s.length > 8000 || !/^[A-Za-z0-9_-]*$/.test(s)) return "";
  try { return new TextDecoder().decode(fromB64u(s)); } catch { return ""; }
}
function cleanGuide(s) {
  try {
    const g = JSON.parse(s);
    if (!g || typeof g.pose !== "string" || !Array.isArray(g.lines)) return null;
    const lines = g.lines.filter((l) => typeof l === "string").slice(0, 12).map((l) => l.slice(0, 300));
    return lines.length ? JSON.stringify({ pose: g.pose.slice(0, 30), lines }) : null;
  } catch { return null; }
}
const IMAGE_TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif" };

// Entrare dalla pagina aperta dal bot: dati firmati da Telegram e accesso già fatto nel bot (password scritta una
// volta in chat), niente altro. Risponde una sessione breve e la password con cui la pagina cifra il file dei
// progressi (per ora la stessa per tutti i tester: vedi APPUNTI.md). fileKey: solo per i file della versione di prima
async function login(request, env) {
  if (request.method !== "POST") return json({ error: "missing" }, 404);
  const auth = request.headers.get("Authorization") || "";
  const who = auth.startsWith("tma ") ? await checkInitData(auth.slice(4), env.BOT_TOKEN, Date.now(), INIT_MAX_AGE) : null;
  if (!who) return json({ error: "auth" }, 401);
  const existing = await getUser(env, who.id);
  if (!allowed(env, who.id, existing)) return json({ error: "invite" }, 403);
  const u = existing || await ensureUser(env, who.id);
  if (!u || !env.ACCESS_CODE) return json({ error: "limit" }, 429);
  if (!(await within(env, u.id, "api"))) return json({ error: "limit" }, 429);
  const now = Date.now(), token = newToken();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_at) VALUES (?, ?, ?, ?)").bind(await tokenHash(token), u.id, now, now).run();
  const fk = await fileKey(env.MASTER_KEY, u.id);
  return json({ token, code: env.ACCESS_CODE, fileKey: b64u(fk.raw) });
}

// La piattaforma (fuori da Telegram) controlla la password all'apertura: risponde solo se è giusta. Da qualunque
// sito (CORS *, niente cookie). Password sbagliate: 10 al giorno per indirizzo IP, 500 al giorno in tutto
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST", "Access-Control-Max-Age": "86400" };
async function check(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return json({ error: "missing" }, 404);
  const ip = request.headers.get("CF-Connecting-IP") || "?";
  const ipId = -parseInt((await tokenHash(`${env.MASTER_KEY}:${ip}`)).slice(0, 12), 16); // negativo: non è un utente
  const reply = (data, status) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...SECURITY_HEADERS, ...CORS } });
  if ((await used(env, ipId, "pcode")) >= LIMITS.pcode || (await used(env, 0, "pcheck")) >= LIMITS.pcheck) return reply({ error: "limit" }, 429);
  const code = (await request.text().catch(() => "")).slice(0, 200);
  if (env.ACCESS_CODE && safeEqual(code, env.ACCESS_CODE)) return reply({ ok: true }, 200);
  await within(env, ipId, "pcode");
  await within(env, 0, "pcheck");
  return reply({ error: "password", left: Math.max(0, LIMITS.pcode - (await used(env, ipId, "pcode"))) }, 401);
}

// La sessione della richiesta: l'utente, o null (scaduta, o di qualcuno che non può più entrare)
async function session(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ") || auth.length > 100) return null;
  const now = Date.now(), h = await tokenHash(auth.slice(7));
  const s = await env.DB.prepare("SELECT * FROM sessions WHERE token_hash = ?").bind(h).first();
  if (!s || now - s.last_at > SESSION_IDLE || now - s.created_at > SESSION_MAX) return null;
  const u = await getUser(env, s.user_id);
  if (!u || !allowed(env, u.id, u)) return null;
  await env.DB.prepare("UPDATE sessions SET last_at = ? WHERE token_hash = ?").bind(now, h).run();
  return u;
}

async function api(request, env, url) {
  if (url.pathname === "/api/check") return check(request, env);
  if (url.pathname === "/api/login") return login(request, env);
  const u = await session(request, env);
  if (!u) return json({ error: "session" }, 401);
  if (!(await within(env, u.id, "api"))) return json({ error: "limit" }, 429);

  if (url.pathname === "/api/logout" && request.method === "POST") {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await tokenHash((request.headers.get("Authorization") || "").slice(7))).run();
    return json({ ok: true });
  }

  if (url.pathname === "/api/state" && request.method === "GET") {
    const photos = (await env.DB.prepare("SELECT id, sent_at, caption, role, taken FROM photos WHERE user_id = ? ORDER BY id LIMIT 100").bind(u.id).all()).results;
    const diary = (await env.DB.prepare("SELECT id, date, field, value FROM diary WHERE user_id = ? ORDER BY id LIMIT 1000").bind(u.id).all()).results;
    const open = async (s) => (s ? (await unseal(env, u.id, s)) || "" : "");
    return json({
      json: !!u.last_json,
      photos: await Promise.all(photos.map(async (r) => ({ id: r.id, date: r.sent_at, caption: await open(r.caption), role: r.role || null, taken: r.taken || null }))),
      diary: (await Promise.all(diary.filter((r) => NUM_FIELDS[r.field] || TEXT_FIELDS[r.field] || r.field === "note").map(async (r) => ({ ...r, value: await open(r.value) })))).filter((r) => r.value),
    });
  }

  if (url.pathname === "/api/file" && request.method === "GET") {
    // Solo file di chi chiede: l'ultimo file dei progressi (cifrato: lo apre la pagina) o una delle sue foto in attesa
    let fileId = null, isJson = false;
    if (url.searchParams.get("json") === "1") { fileId = u.last_json; isJson = true; }
    else {
      const row = await env.DB.prepare("SELECT file_id FROM photos WHERE id = ? AND user_id = ?").bind(+url.searchParams.get("photo") || 0, u.id).first();
      fileId = row?.file_id;
    }
    if (!fileId) return json({ error: "missing" }, 404);
    const { res, path } = await telegramFile(env, fileId);
    const ext = (path.split(".").pop() || "").toLowerCase();
    return new Response(res.body, { headers: { "Content-Type": isJson ? "application/octet-stream" : IMAGE_TYPES[ext] || "image/jpeg", ...SECURITY_HEADERS } });
  }

  if (url.pathname === "/api/save" && request.method === "POST") {
    const length = Number(request.headers.get("Content-Length"));
    if (!length || !request.body) return json({ error: "length" }, 411);
    if (length > MAX_FILE) return json({ error: "size" }, 413);
    if (!(await within(env, u.id, "save"))) return json({ error: "limit" }, 429);
    const note = fromB64url(request.headers.get("X-FP-Note")).replace(/[\r\n]+/g, " ").slice(0, 200);
    const guide = cleanGuide(fromB64url(request.headers.get("X-FP-Guide")));
    const day = localDate(Date.now(), tz(env));
    const caption = `💾 Progressi del ${day.split("-").reverse().join("/")}${note ? ` · ${note}` : ""}.\nResta qui 4 ore, a meno che non tocchi «Conserva». L'ultimo salvataggio resta sempre.`;
    let sent;
    try { sent = await sendDocumentStream(env, u.id, request.body, length, `fitprogress-${day}.fitprogress`, caption, keepMarkup(false)); } catch (e) {
      if (e.status === 400) return json({ error: "not-encrypted" }, 400);
      throw e;
    }
    await setUser(env, u.id, "last_json = ?, guide = COALESCE(?, guide)", sent.document.file_id, guide ? await seal(env, u.id, guide) : null);
    await trackSave(env, u.id, sent, true);
    // Foto già prese dalla pagina: via dalla chat (le foto e le risposte del bot), restano solo nel file
    for (const part of chunks(ids(request, "X-FP-Photos"))) {
      const marks = part.map(() => "?").join(",");
      const rows = (await env.DB.prepare(`SELECT message_id, reply_id FROM photos WHERE user_id = ? AND id IN (${marks})`).bind(u.id, ...part).all()).results;
      const messages = rows.flatMap((r) => [r.message_id, r.reply_id]).filter(Boolean);
      for (const m of chunks(messages, 100)) await tg(env, "deleteMessages", { chat_id: u.id, message_ids: m }).catch(() => {}); // oltre 48 ore Telegram non le toglie
      await env.DB.prepare(`DELETE FROM photos WHERE user_id = ? AND id IN (${marks})`).bind(u.id, ...part).run();
    }
    // Le foto in attesa sono finite: via anche il messaggio "Ho N foto"
    const left = (await env.DB.prepare("SELECT COUNT(*) AS n FROM photos WHERE user_id = ?").bind(u.id).first()).n;
    if (!left && u.ack_id) {
      await tg(env, "deleteMessage", { chat_id: u.id, message_id: u.ack_id }).catch(() => {});
      await setUser(env, u.id, "ack_id = NULL");
    }
    for (const part of chunks(ids(request, "X-FP-Diary"))) {
      await env.DB.prepare(`DELETE FROM diary WHERE user_id = ? AND id IN (${part.map(() => "?").join(",")})`).bind(u.id, ...part).run();
    }
    return json({ ok: true });
  }

  return json({ error: "missing" }, 404);
}

// ------------------------------------------------------------------ collegamento (una volta, dopo il primo deploy)

// Per rifarlo (bot nuovo, indirizzo nuovo): ALLOW_SETUP = "1" nelle variabili, deploy, /setup, poi di nuovo via
async function setup(request, env, url) {
  if (!safeEqual(request.headers.get("X-Setup-Secret") || "", env.WEBHOOK_SECRET)) return new Response("No", { status: 401 });
  const done = await env.DB.prepare("SELECT v FROM meta WHERE k = 'setup_at'").first();
  if (done && env.ALLOW_SETUP !== "1") return json({ error: "already" }, 403);
  const page = `${url.origin}/`;
  await tg(env, "setWebhook", { url: `${url.origin}/telegram`, secret_token: env.WEBHOOK_SECRET, allowed_updates: ["message", "callback_query"], drop_pending_updates: true, max_connections: 10 });
  await tg(env, "setMyCommands", { commands: [
    { command: "start", description: "Come funziona" },
    { command: "confronto", description: "Una foto di prima e una di adesso, a confronto" },
    { command: "diario", description: "Le voci del diario che ho tenuto da parte" },
    { command: "esporta", description: "L'ultimo file dei progressi" },
    { command: "promemoria", description: "Quando ti ricordo le foto" },
    { command: "ogni", description: "Ogni quanti giorni: /ogni 14" },
    { command: "ora", description: "A che ora: /ora 8" },
    { command: "pausa", description: "Ferma i promemoria" },
    { command: "riprendi", description: "Riprendi i promemoria" },
    { command: "cancella", description: "Togli tutto quello che il bot sa di te" },
  ] });
  await tg(env, "setChatMenuButton", { menu_button: { type: "web_app", text: "FitProgress", web_app: { url: page } } });
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('page', ?)").bind(page),
    env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('setup_at', ?)").bind(String(Date.now())),
  ]);
  return json({ ok: true, page });
}
