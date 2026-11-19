// Finto Telegram per provare il bot in locale (TG_API=http://127.0.0.1:8790 in .dev.vars).
// Risponde ai metodi che il bot usa, tiene i file mandati con sendDocument e li ridà con getFile.
//   node test/fake-telegram.mjs
//   GET  /_log            le chiamate ricevute (metodo e corpo)
//   POST /_file?ext=jpg   registra un file (il corpo) e risponde il suo file_id, da usare in un finto messaggio
import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 8790);
const files = new Map(); // file_id → { path, data }
const log = [];
let messageId = 1000, fileN = 0;

const addFile = (data, ext) => {
  const id = `file-${++fileN}`;
  files.set(id, { path: `files/${id}.${ext}`, data });
  return id;
};
const read = (req) => new Promise((resolve) => { const xs = []; req.on("data", (x) => xs.push(x)); req.on("end", () => resolve(Buffer.concat(xs))); });
const reply = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const body = await read(req);
  if (url.pathname === "/_log") return reply(res, 200, log);
  if (url.pathname === "/_file") return reply(res, 200, { file_id: addFile(body, url.searchParams.get("ext") || "jpg"), size: body.length });
  let m = url.pathname.match(/^\/file\/bot[^/]+\/(.+)$/);
  if (m) {
    const f = [...files.values()].find((x) => x.path === m[1]);
    if (!f) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Length": f.data.length });
    return res.end(f.data);
  }
  m = url.pathname.match(/^\/bot[^/]+\/(\w+)$/);
  if (!m) return reply(res, 404, { ok: false, description: "Not Found" });
  const method = m[1], type = req.headers["content-type"] || "";
  if (method === "sendDocument" && type.startsWith("multipart/")) {
    const form = await new Response(body, { headers: { "Content-Type": type } }).formData();
    const doc = form.get("document");
    const data = Buffer.from(await doc.arrayBuffer());
    const id = addFile(data, "json");
    log.push({ method, chat_id: form.get("chat_id"), caption: form.get("caption"), filename: doc.name, bytes: data.length, contentLength: Number(req.headers["content-length"]), received: body.length, file_id: id });
    return reply(res, 200, { ok: true, result: { message_id: ++messageId, document: { file_id: id, file_name: doc.name } } });
  }
  const args = body.length ? JSON.parse(body) : {};
  log.push({ method, ...args });
  if (method === "getFile") {
    const f = files.get(args.file_id);
    return f ? reply(res, 200, { ok: true, result: { file_id: args.file_id, file_path: f.path } }) : reply(res, 400, { ok: false, error_code: 400, description: "Bad Request: invalid file_id" });
  }
  if (method === "sendDocument") return reply(res, 200, { ok: true, result: { message_id: ++messageId, document: { file_id: args.document } } });
  if (method === "sendMessage") return reply(res, 200, { ok: true, result: { message_id: ++messageId, text: args.text } });
  return reply(res, 200, { ok: true, result: true });
}).listen(PORT, "127.0.0.1", () => console.log(`Finto Telegram su http://127.0.0.1:${PORT}`));
