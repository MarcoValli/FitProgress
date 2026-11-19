import { test } from "node:test";
import assert from "node:assert/strict";
import { localDate, atLocal, nextReminder, shortDate } from "../src/time.js";

const TZ = "Europe/Rome";

test("giorno locale anche vicino a mezzanotte", () => {
  assert.equal(localDate(Date.UTC(2026, 10, 19, 23, 30), TZ), "2026-11-20"); // 00:30 a Roma
  assert.equal(localDate(Date.UTC(2026, 6, 1, 21, 59), TZ), "2026-07-01"); // 23:59 del 1° luglio, ora legale
  assert.equal(localDate(Date.UTC(2026, 6, 1, 22, 1), TZ), "2026-07-02"); // 00:01
});

test("ora locale in inverno e in estate", () => {
  assert.equal(atLocal("2026-11-20", 8, TZ), Date.UTC(2026, 10, 20, 7));
  assert.equal(atLocal("2026-07-01", 8, TZ), Date.UTC(2026, 6, 1, 6));
});

test("prossimo promemoria a cavallo del cambio dell'ora", () => {
  const now = Date.UTC(2026, 9, 20, 10); // 20 ottobre, ora legale
  assert.equal(nextReminder(now, 14, 8, TZ), Date.UTC(2026, 10, 3, 7)); // 3 novembre, ora solare
  assert.equal(shortDate(nextReminder(now, 14, 8, TZ), TZ), "03/11");
});
