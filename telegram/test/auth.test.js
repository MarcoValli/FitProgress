import { test } from "node:test";
import assert from "node:assert/strict";
import { checkInitData, signInitData, safeEqual } from "../src/auth.js";

const token = "123456:TEST-token";
const now = Date.UTC(2026, 10, 19, 10);
const fields = (age = 60) => ({
  query_id: "AAE", user: JSON.stringify({ id: 42, first_name: "Marco" }), auth_date: String(Math.floor(now / 1000) - age),
});

test("firma giusta: risponde l'utente", async () => {
  const data = await signInitData(fields(), token);
  assert.equal((await checkInitData(data, token, now)).id, 42);
});

test("firma con un altro token, dati cambiati o senza firma: niente", async () => {
  const data = await signInitData(fields(), token);
  assert.equal(await checkInitData(data, "999:altro", now), null);
  assert.equal(await checkInitData(data.replace("Marco", "Mario"), token, now), null);
  assert.equal(await checkInitData(data.replace(/&?hash=[0-9a-f]+/, ""), token, now), null);
  assert.equal(await checkInitData("", token, now), null);
});

test("dati più vecchi di un giorno: niente", async () => {
  const data = await signInitData(fields(86400 + 5), token);
  assert.equal(await checkInitData(data, token, now), null);
});

test("confronto a tempo costante", () => {
  assert.ok(safeEqual("abc", "abc"));
  assert.ok(!safeEqual("abc", "abd"));
  assert.ok(!safeEqual("abc", "ab"));
  assert.ok(!safeEqual("", ""));
});
