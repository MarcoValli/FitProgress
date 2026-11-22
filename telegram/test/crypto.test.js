import { test } from "node:test";
import assert from "node:assert/strict";
import { fileKey, sealText, openText, verifier, newToken, tokenHash, isFileFor, sealFile, openFile, b64u, fromB64u } from "../src/crypto.js";

const master = "11".repeat(32), other = "22".repeat(32);
const enc = new TextEncoder(), dec = new TextDecoder();

test("chiave del file: diversa per utente e per chiave principale, sempre uguale per lo stesso", async () => {
  const a = await fileKey(master, 42), b = await fileKey(master, 43), c = await fileKey(other, 42), a2 = await fileKey(master, 42);
  assert.deepEqual(a.raw, a2.raw);
  assert.notDeepEqual(a.raw, b.raw);
  assert.notDeepEqual(a.raw, c.raw);
  assert.equal(a.raw.length, 32);
  assert.equal(a.id.length, 8);
});

test("file dei progressi: si apre solo con la chiave di chi l'ha fatto, e non si può toccare", async () => {
  const a = await fileKey(master, 42), b = await fileKey(master, 43);
  const sealed = await sealFile(a.raw, a.id, enc.encode('{"app":"fitprogress"}'));
  assert.ok(isFileFor(sealed, a.id));
  assert.ok(!isFileFor(sealed, b.id));
  assert.ok(!isFileFor(enc.encode('{"app":"fitprogress"}'), a.id)); // in chiaro: no
  assert.equal(dec.decode(await openFile(a.raw, sealed)), '{"app":"fitprogress"}');
  await assert.rejects(openFile(b.raw, sealed));
  const touched = sealed.slice();
  touched[touched.length - 1] ^= 1;
  await assert.rejects(openFile(a.raw, touched));
  const otherId = sealed.slice();
  otherId[5] ^= 1; // l'intestazione è autenticata
  await assert.rejects(openFile(a.raw, otherId));
});

test("testi nel database: cifrati, ognuno con la sua chiave; quelli di prima si leggono com'erano", async () => {
  const s = await sealText(master, 42, "Cena: pizza");
  assert.ok(s.startsWith("e1:") && !s.includes("pizza"));
  assert.equal(await openText(master, 42, s), "Cena: pizza");
  assert.equal(await openText(master, 43, s), null);
  assert.notEqual(await sealText(master, 42, "Cena: pizza"), s); // iv sempre nuovo
  assert.equal(await openText(master, 42, "82.4"), "82.4");
});

test("password: impronta legata alla chiave principale", async () => {
  const k = crypto.getRandomValues(new Uint8Array(32));
  assert.equal(await verifier(master, k), await verifier(master, k));
  assert.notEqual(await verifier(master, k), await verifier(other, k));
  assert.match(await verifier(master, k), /^[0-9a-f]{64}$/);
});

test("sessioni: codici diversi, nel database solo l'impronta", async () => {
  const t1 = newToken(), t2 = newToken();
  assert.notEqual(t1, t2);
  assert.equal(fromB64u(t1).length, 32);
  assert.match(await tokenHash(t1), /^[0-9a-f]{64}$/);
  assert.equal(b64u(fromB64u(t1)), t1);
});

test("MASTER_KEY sbagliata: errore", async () => {
  await assert.rejects(fileKey("corta", 1));
});
