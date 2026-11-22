// Bot Telegram di FitProgress (Cloudflare Worker).
//
// - /telegram  messaggi da Telegram (webhook, solo col codice segreto WEBHOOK_SECRET): diario, foto, comandi, pulsanti
// - /api/…     la pagina aperta dentro Telegram (Mini App), solo coi dati firmati da Telegram: stato, file, salva
// - /setup     collega il bot a questo Worker (webhook, comandi, pulsante del menu), solo con WEBHOOK_SECRET
// - cron       ogni ora i promemoria per le foto dei progressi
// - il resto   la pagina stessa (index.html e vendor/, copiati in public/ da npm run build)
//
// Cosa resta qui (D1): impostazioni del promemoria, l'identificativo dell'ultimo file dei progressi nella chat,
// le foto e le voci del diario arrivate in chat e non ancora prese dalla pagina. Le foto e i file stanno su Telegram.
import { parseMessage, describeItem, NUM_FIELDS, TEXT_FIELDS } from "./parse.js";
import { checkInitData, safeEqual } from "./auth.js";
import { localDate, nextReminder, shortDate } from "./time.js";

const EVERY = 14, HOUR = 8; // promemoria: ogni 14 giorni alle 8
const MAX_UPLOAD = 49e6; // Telegram accetta documenti fino a 50 MB
const enc = new TextEncoder();
const tz = (env) => env.TIME_ZONE || "Europe/Rome";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/telegram" && request.method === "POST") return await webhook(request, env, ctx, url);
      if (url.pathname === "/setup" && request.method === "POST") return await setup(request, env, url);
      if (url.pathname.startsWith("/api/")) return await api(request, env, url);
      return new Response("Non trovato", { status: 404 });
    } catch (e) {
      console.error(e);
      return json({ error: "server" }, 500);
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(reminders(env));
  },
};

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

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

// Il file dei progressi va a Telegram mentre arriva dalla pagina, senza tenerlo tutto in memoria
async function sendDocumentStream(env, chatId, body, length, filename, caption) {
  const boundary = `fp${crypto.randomUUID().replace(/-/g, "")}`;
  const field = (name, value) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const head = enc.encode(field("chat_id", chatId) + field("caption", caption)
    + `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: application/json\r\n\r\n`);
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const { readable, writable } = new FixedLengthStream(head.length + length + tail.length);
  const pump = (async () => {
    const w = writable.getWriter();
    await w.write(head);
    const r = body.getReader();
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

// ------------------------------------------------------------------ utenti

// ALLOWED_IDS: ID Telegram separati da virgole, oppure * per tutti. Vuoto: nessuno (a /start il bot dice il tuo ID)
function allowed(env, id) {
  const ids = String(env.ALLOWED_IDS || "").split(/[\s,]+/).filter(Boolean);
  return ids.includes("*") || ids.includes(String(id));
}
async function ensureUser(env, id) {
  const now = Date.now();
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, every_days, hour, paused, next_at, created_at) VALUES (?, ?, ?, 0, ?, ?)")
    .bind(id, EVERY, HOUR, nextReminder(now, EVERY, HOUR, tz(env)), now).run();
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
}
async function pageUrl(env, origin) {
  if (origin) return `${origin}/`;
  return (await env.DB.prepare("SELECT v FROM meta WHERE k = 'page'").first())?.v || null;
}
const setUser = (env, id, sql, ...args) => env.DB.prepare(`UPDATE users SET ${sql} WHERE id = ?`).bind(...args, id).run();
// D1 accetta al massimo 100 valori per query: gli elenchi di righe vanno a pezzi
const chunks = (xs, n = 90) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

// ------------------------------------------------------------------ messaggi dalla chat

async function webhook(request, env, ctx, url) {
  if (!safeEqual(request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "", env.WEBHOOK_SECRET || "")) return new Response("No", { status: 401 });
  const update = await request.json().catch(() => null);
  if (update) ctx.waitUntil(onUpdate(update, env, url.origin).catch((e) => console.error(e)));
  return new Response("ok");
}
async function onUpdate(update, env, origin) {
  if (update.message) return onMessage(update.message, env, origin);
  if (update.callback_query) return onCallback(update.callback_query, env, origin);
}

const HELP = (u) => [
  "<b>FitProgress</b>",
  "",
  "📷 <b>Foto dei progressi</b>: mandamele qui (anche normali, non come file). Scrivi nella didascalia <i>fronte</i>, <i>lato</i> o <i>schiena</i> se vuoi. Poi tocca <b>Apri FitProgress</b>: la pagina le allinea e le misura, e Salva rimanda qui il file dei progressi.",
  "",
  "📝 <b>Diario</b>: scrivimi",
  "• <code>82,4</code> · <code>grasso 18</code> · <code>vita 84</code>",
  "• <code>gambe 60 min</code> · <code>allenamento: spinta</code>",
  "• <code>cena ieri: pizza e birra</code>",
  "",
  `⏰ <b>Promemoria</b>: ogni ${u.every_days} giorni alle ${u.hour}${u.paused ? " (in pausa)" : ""}. /ogni 7 · /ora 19 · /pausa · /riprendi`,
  "",
  "📦 /esporta ti rimanda l'ultimo file dei progressi.",
].join("\n");

async function onMessage(msg, env, origin) {
  if (msg.chat?.type !== "private" || !msg.from) return;
  const uid = msg.from.id;
  if (!allowed(env, uid)) {
    if (/^\/start\b/.test(msg.text || "")) await send(env, msg.chat.id, `Questo bot per ora è privato. Il tuo ID Telegram è <code>${uid}</code>.`);
    return;
  }
  const u = await ensureUser(env, uid), page = await pageUrl(env, origin);
  const image = msg.photo?.length ? msg.photo[msg.photo.length - 1] : msg.document?.mime_type?.startsWith("image/") ? msg.document : null;
  if (image) return onPhoto(msg, image, u, env, page);
  const text = (msg.text || "").trim();
  if (!text) return send(env, uid, "Mandami una foto dei progressi, oppure scrivimi peso, misure, allenamento o pasto. /start per l'aiuto.");
  const cmd = text.match(/^\/([a-z]+)(?:@\w+)?\s*(.*)$/is);
  if (cmd) return onCommand(cmd[1].toLowerCase(), cmd[2].trim(), u, env, page);
  return onDiary(text, u, env);
}

async function onCommand(cmd, arg, u, env, page) {
  const id = u.id;
  if (cmd === "start" || cmd === "aiuto" || cmd === "help") {
    return send(env, id, HELP(u), page ? { reply_markup: { inline_keyboard: [[openButton(page)]] } } : {});
  }
  if (cmd === "esporta") {
    if (!u.last_json) return send(env, id, "Non c'è ancora un file dei progressi: aprili in FitProgress e tocca Salva.");
    return tg(env, "sendDocument", { chat_id: id, document: u.last_json, caption: "L'ultimo file dei progressi" });
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
    return send(env, id, u.paused ? "Promemoria in pausa. /riprendi quando vuoi."
      : `Ogni ${u.every_days} giorni alle ${u.hour}. Il prossimo il ${shortDate(u.next_at, tz(env))}.`);
  }
  return send(env, id, HELP(u));
}

async function onDiary(text, u, env) {
  const today = localDate(Date.now(), tz(env));
  const { items, asks } = parseMessage(text, today);
  const now = Date.now();
  for (const it of items) {
    await env.DB.prepare("INSERT INTO diary (user_id, date, field, value, created_at) VALUES (?, ?, ?, ?, ?)").bind(u.id, it.date, it.field, it.value, now).run();
  }
  if (items.length) await send(env, u.id, `Segnato ${dayWords(items[0].date, today)}: ${esc(items.map(describeItem).join(" · "))}.`);
  for (const a of asks.slice(0, 3)) {
    const row = await env.DB.prepare("INSERT INTO asks (user_id, date, text, created_at) VALUES (?, ?, ?, ?) RETURNING id").bind(u.id, a.date, a.ask.slice(0, 300), now).first();
    await send(env, u.id, `Non ho capito «${esc(a.ask.slice(0, 120))}». Cos'è?`, {
      reply_markup: { inline_keyboard: [[
        { text: "Allenamento", callback_data: `a:${row.id}:workout` },
        { text: "Pasto", callback_data: `a:${row.id}:meal` },
        { text: "Lascia stare", callback_data: `a:${row.id}:no` },
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

async function onPhoto(msg, image, u, env, page) {
  if (image.file_size > 20e6) return send(env, u.id, "Questa foto è troppo grande per il bot (oltre 20 MB): mandala come foto normale.");
  // Una foto conta come promemoria fatto
  await setUser(env, u.id, "next_at = ?", nextReminder(Date.now(), u.every_days, u.hour, tz(env)));
  const row = await env.DB.prepare("INSERT INTO photos (user_id, file_id, message_id, sent_at, caption) VALUES (?, ?, ?, ?, ?) RETURNING id")
    .bind(u.id, image.file_id, msg.message_id, msg.date, (msg.caption || "").slice(0, 200)).first();
  // Un album arriva come tanti messaggi: si risponde una volta sola
  if (msg.media_group_id && msg.media_group_id === u.last_group) return;
  if (msg.media_group_id) await setUser(env, u.id, "last_group = ?", msg.media_group_id);
  const reply = await send(env, u.id, msg.media_group_id ? "Foto ricevute. Aprile in FitProgress: le preparo lì, poi tocca Salva." : "Foto ricevuta. Aprila in FitProgress: la preparo lì, poi tocca Salva.", {
    reply_parameters: { message_id: msg.message_id },
    ...(page ? { reply_markup: { inline_keyboard: [[openButton(page)]] } } : {}),
  });
  await env.DB.prepare("UPDATE photos SET reply_id = ? WHERE id = ?").bind(reply.message_id, row.id).run();
}

async function onCallback(q, env, origin) {
  const uid = q.from?.id, data = q.data || "";
  const answer = (text) => tg(env, "answerCallbackQuery", { callback_query_id: q.id, ...(text ? { text } : {}) }).catch(() => {});
  if (!uid || !allowed(env, uid)) return answer();
  const u = await ensureUser(env, uid), page = await pageUrl(env, origin);
  const chatId = q.message?.chat?.id, messageId = q.message?.message_id;
  const keepOpen = page ? { inline_keyboard: [[openButton(page)]] } : { inline_keyboard: [] };
  const edit = (text, markup = { inline_keyboard: [] }) => chatId && tg(env, "editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", reply_markup: markup }).catch(() => {});
  let m;
  if ((m = data.match(/^r:(done|later|pause)$/))) {
    const now = Date.now();
    if (m[1] === "pause") {
      await setUser(env, uid, "paused = 1");
      await answer("Promemoria in pausa");
      return edit(`${q.message?.text ? esc(q.message.text.split("\n")[0]) : "Promemoria"}\n\nIn pausa. /riprendi quando vuoi.`);
    }
    const next = nextReminder(now, m[1] === "done" ? u.every_days : 1, u.hour, tz(env));
    await setUser(env, uid, "next_at = ?, paused = 0", next);
    await answer(m[1] === "done" ? "Fatto" : "Te lo ricordo domani");
    return edit(m[1] === "done" ? `Fatto. Il prossimo promemoria il ${shortDate(next, tz(env))}.\n\nMandami le foto qui, poi aprile in FitProgress.` : `Te lo ricordo domani alle ${u.hour}.`, m[1] === "done" ? keepOpen : undefined);
  }
  if ((m = data.match(/^a:(\d+):(workout|meal|no)$/))) {
    const ask = await env.DB.prepare("SELECT * FROM asks WHERE id = ? AND user_id = ?").bind(+m[1], uid).first();
    await env.DB.prepare("DELETE FROM asks WHERE id = ? AND user_id = ?").bind(+m[1], uid).run();
    if (!ask) { await answer(); return edit("Già fatto."); }
    if (m[2] === "no") { await answer(); return edit(`Lasciato stare: «${esc(ask.text)}».`); }
    const value = (ask.text.charAt(0).toUpperCase() + ask.text.slice(1)).slice(0, TEXT_FIELDS[m[2]]);
    await env.DB.prepare("INSERT INTO diary (user_id, date, field, value, created_at) VALUES (?, ?, ?, ?, ?)").bind(uid, ask.date, m[2], value, Date.now()).run();
    await answer("Segnato");
    return edit(`Segnato ${dayWords(ask.date, localDate(Date.now(), tz(env)))}: ${esc(describeItem({ field: m[2], value }))}.`);
  }
  return answer();
}

// ------------------------------------------------------------------ promemoria (cron, ogni ora)

// Le righe della guida arrivano dalla pagina in HTML con solo <b>: tutto il resto si scrive com'è
const safeLine = (s) => esc(s).replace(/&lt;(\/?)b&gt;/g, "<$1b>");
function reminderText(u) {
  let guide = null;
  try { guide = u.guide ? JSON.parse(u.guide) : null; } catch { /* rovinata */ }
  const lines = guide?.lines?.length
    ? [`${esc(guide.pose)}, come nel riferimento:`, ...guide.lines.map((l) => `• ${safeLine(l)}`)]
    : ["Stesso posto, stessa luce, stessa distanza dallo specchio. In FitProgress, nella scheda Guida, scegli una foto di riferimento: qui ti ricordo i suoi numeri."];
  return ["📷 <b>Oggi foto dei progressi</b>", "", ...lines, "", "Mandamele qui quando le hai fatte."].join("\n");
}
async function reminders(env) {
  const now = Date.now(), page = await pageUrl(env, null);
  const { results } = await env.DB.prepare("SELECT * FROM users WHERE paused = 0 AND next_at <= ? ORDER BY next_at LIMIT 50").bind(now).all();
  for (const u of results) {
    if (!allowed(env, u.id)) continue;
    // Senza risposta te lo ricordo di nuovo domani
    await setUser(env, u.id, "next_at = ?", nextReminder(now, 1, u.hour, tz(env)));
    try {
      await send(env, u.id, reminderText(u), {
        reply_markup: { inline_keyboard: [
          [{ text: "Fatto", callback_data: "r:done" }, { text: "Domani", callback_data: "r:later" }, { text: "Pausa", callback_data: "r:pause" }],
          ...(page ? [[openButton(page)]] : []),
        ] },
      });
    } catch (e) {
      // Bot bloccato o chat cancellata: niente più promemoria
      if (e.code === 403) await setUser(env, u.id, "paused = 1");
      else console.error(e);
    }
  }
}

// ------------------------------------------------------------------ la pagina (Mini App)

const ids = (request, name) => [...new Set((request.headers.get(name) || "").split(",").map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))].slice(0, 1000);
function fromB64url(s) {
  if (!s || s.length > 8000 || !/^[A-Za-z0-9_-]*$/.test(s)) return "";
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch { return ""; }
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

async function api(request, env, url) {
  const auth = request.headers.get("Authorization") || "";
  const who = auth.startsWith("tma ") ? await checkInitData(auth.slice(4), env.BOT_TOKEN) : null;
  if (!who || !allowed(env, who.id)) return json({ error: "auth" }, 401);
  const u = await ensureUser(env, who.id);

  if (url.pathname === "/api/state" && request.method === "GET") {
    const photos = await env.DB.prepare("SELECT id, sent_at, caption FROM photos WHERE user_id = ? ORDER BY id LIMIT 100").bind(u.id).all();
    const diary = await env.DB.prepare("SELECT id, date, field, value FROM diary WHERE user_id = ? ORDER BY id LIMIT 1000").bind(u.id).all();
    return json({
      json: u.last_json || null,
      photos: photos.results.map((r) => ({ id: r.id, date: r.sent_at, caption: r.caption || "" })),
      diary: diary.results.filter((r) => NUM_FIELDS[r.field] || TEXT_FIELDS[r.field]),
    });
  }

  if (url.pathname === "/api/file" && request.method === "GET") {
    // Solo file di chi chiede: l'ultimo file dei progressi o una delle sue foto in attesa
    let fileId = null, isJson = false;
    if (url.searchParams.get("json") === "1") { fileId = u.last_json; isJson = true; }
    else {
      const row = await env.DB.prepare("SELECT file_id FROM photos WHERE id = ? AND user_id = ?").bind(+url.searchParams.get("photo") || 0, u.id).first();
      fileId = row?.file_id;
    }
    if (!fileId) return json({ error: "missing" }, 404);
    const f = await tg(env, "getFile", { file_id: fileId });
    const res = await fetch(`${tgBase(env)}/file/bot${env.BOT_TOKEN}/${f.file_path}`);
    if (!res.ok) return json({ error: "telegram" }, 502);
    const ext = (f.file_path.split(".").pop() || "").toLowerCase();
    return new Response(res.body, { headers: { "Content-Type": isJson ? "application/json" : IMAGE_TYPES[ext] || "image/jpeg", "Cache-Control": "no-store" } });
  }

  if (url.pathname === "/api/save" && request.method === "POST") {
    const length = Number(request.headers.get("Content-Length"));
    if (!length || !request.body) return json({ error: "length" }, 411);
    if (length > MAX_UPLOAD) return json({ error: "size" }, 413);
    const note = fromB64url(request.headers.get("X-FP-Note")).replace(/[\r\n]+/g, " ").slice(0, 200);
    const guide = cleanGuide(fromB64url(request.headers.get("X-FP-Guide")));
    const day = localDate(Date.now(), tz(env));
    const caption = `Progressi del ${day.split("-").reverse().join("/")}${note ? ` · ${note}` : ""}`;
    const sent = await sendDocumentStream(env, u.id, request.body, length, `fitprogress-${day}.json`, caption);
    await setUser(env, u.id, "last_json = ?, guide = COALESCE(?, guide)", sent.document.file_id, guide);
    // Foto già prese dalla pagina: via dalla chat (le foto e le risposte del bot), restano solo nel file
    for (const part of chunks(ids(request, "X-FP-Photos"))) {
      const marks = part.map(() => "?").join(",");
      const rows = (await env.DB.prepare(`SELECT message_id, reply_id FROM photos WHERE user_id = ? AND id IN (${marks})`).bind(u.id, ...part).all()).results;
      const messages = rows.flatMap((r) => [r.message_id, r.reply_id]).filter(Boolean);
      for (const m of chunks(messages, 100)) await tg(env, "deleteMessages", { chat_id: u.id, message_ids: m }).catch(() => {}); // oltre 48 ore Telegram non le toglie
      await env.DB.prepare(`DELETE FROM photos WHERE user_id = ? AND id IN (${marks})`).bind(u.id, ...part).run();
    }
    for (const part of chunks(ids(request, "X-FP-Diary"))) {
      await env.DB.prepare(`DELETE FROM diary WHERE user_id = ? AND id IN (${part.map(() => "?").join(",")})`).bind(u.id, ...part).run();
    }
    return json({ json: sent.document.file_id });
  }

  return json({ error: "missing" }, 404);
}

// ------------------------------------------------------------------ collegamento (una volta, dopo il deploy)

async function setup(request, env, url) {
  if (!safeEqual(request.headers.get("X-Setup-Secret") || "", env.WEBHOOK_SECRET || "")) return new Response("No", { status: 401 });
  const page = `${url.origin}/`;
  await tg(env, "setWebhook", { url: `${url.origin}/telegram`, secret_token: env.WEBHOOK_SECRET, allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
  await tg(env, "setMyCommands", { commands: [
    { command: "start", description: "Come funziona" },
    { command: "esporta", description: "L'ultimo file dei progressi" },
    { command: "promemoria", description: "Quando ti ricordo le foto" },
    { command: "ogni", description: "Ogni quanti giorni: /ogni 14" },
    { command: "ora", description: "A che ora: /ora 8" },
    { command: "pausa", description: "Ferma i promemoria" },
    { command: "riprendi", description: "Riprendi i promemoria" },
  ] });
  await tg(env, "setChatMenuButton", { menu_button: { type: "web_app", text: "FitProgress", web_app: { url: page } } });
  await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('page', ?)").bind(page).run();
  return json({ ok: true, page });
}
