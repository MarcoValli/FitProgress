import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMessage, parseLine, takeDate, describeItem } from "../src/parse.js";

const today = "2026-11-19";
const one = (text) => {
  const { items, asks } = parseMessage(text, today);
  return items.length === 1 && !asks.length ? items[0] : { items, asks };
};

test("peso, con o senza parola e unità", () => {
  assert.deepEqual(one("82,4"), { date: today, field: "weight", value: "82.4" });
  assert.deepEqual(one("peso 82.4 kg"), { date: today, field: "weight", value: "82.4" });
  assert.deepEqual(one("Peso: 79"), { date: today, field: "weight", value: "79" });
});

test("massa grassa", () => {
  assert.equal(one("grasso 18").field, "fat");
  assert.equal(one("18,5%").value, "18.5");
  assert.equal(one("massa grassa 21%").value, "21");
});

test("circonferenze, petto e pancia compresi", () => {
  assert.deepEqual(one("vita 84"), { date: today, field: "waist", value: "84" });
  assert.equal(one("petto 101 cm").field, "chest");
  assert.equal(one("pancia 90").field, "waist");
  assert.equal(one("spalle 118").field, "shoulders");
});

test("allenamento: parole, durata o la parola allenamento", () => {
  assert.deepEqual(one("gambe 60 min"), { date: today, field: "workout", value: "Gambe 60 min" });
  assert.deepEqual(one("allenamento: spinta"), { date: today, field: "workout", value: "Spinta" });
  assert.equal(one("spalle 45 min").field, "workout"); // non è una circonferenza
  assert.equal(one("petto e tricipiti").field, "workout");
  assert.equal(one("corsa 5 km in 30 min").field, "workout");
});

test("pasti, con la data", () => {
  assert.deepEqual(one("cena ieri: pizza e birra"), { date: "2026-11-18", field: "meal", value: "Cena: pizza e birra" });
  assert.deepEqual(one("Pranzo: riso, pollo e verdure"), { date: today, field: "meal", value: "Pranzo: riso, pollo e verdure" });
});

test("date: ieri, l'altro ieri, 18/11, anno scorso se nel futuro", () => {
  assert.deepEqual(takeDate("ieri 82", today), ["2026-11-18", "82"]);
  assert.deepEqual(takeDate("l'altro ieri gambe", today), ["2026-11-17", "gambe"]);
  assert.deepEqual(takeDate("15/11 vita 84", today), ["2026-11-15", "vita 84"]);
  assert.deepEqual(takeDate("25/12 82", today), ["2025-12-25", "82"]);
  assert.deepEqual(takeDate("1/3/2026 82", today), ["2026-03-01", "82"]);
  assert.deepEqual(takeDate("31/02 82", today), [today, "31/02 82"]); // non è una data
});

test("più voci: righe, punto e virgola, virgole fra misure", () => {
  const { items, asks } = parseMessage("82,4, vita 84\ngambe 60 min; cena: pasta", today);
  assert.equal(asks.length, 0);
  assert.deepEqual(items.map((i) => i.field), ["weight", "waist", "workout", "meal"]);
});

test("fuori dai limiti o non capito: si chiede", () => {
  assert.ok(parseLine("peso 900", today).ask);
  assert.ok(parseLine("oggi sono stanco", today).ask);
  assert.equal(parseLine("ieri", today), null);
  assert.deepEqual(parseMessage("cena", today).asks.length, 1);
});

test("descrizione per la risposta del bot", () => {
  assert.equal(describeItem({ field: "weight", value: "82.4" }), "peso 82,4 kg");
  assert.equal(describeItem({ field: "fat", value: "18" }), "grasso 18%");
  assert.equal(describeItem({ field: "waist", value: "84" }), "vita 84 cm");
  assert.equal(describeItem({ field: "workout", value: "Gambe" }), "allenamento: Gambe");
});
