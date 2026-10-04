// Tests for server-example.js: initData HMAC, plausibility checks and the
// bonus math. Run: npm run test:arena
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import express from "express";

import {
  createArenaRouter, verifyInitData, MemoryArenaStore,
  ARENA_CONFIG_VERSION, ARENA_LEVELS,
} from "../server-example.js";

const BOT_TOKEN = "123456:TEST-token";

// Signs initData exactly the way Telegram does.
export function signInitData(user, botToken = BOT_TOKEN, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({ auth_date: String(authDate), query_id: "AAH-test", user: JSON.stringify(user) });
  const dcs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  params.set("hash", crypto.createHmac("sha256", secret).update(dcs).digest("hex"));
  return params.toString();
}

async function makeServer() {
  let clock = 1_800_000_000_000;
  const app = express();
  app.use("/api/game", createArenaRouter({ botToken: BOT_TOKEN, store: new MemoryArenaStore(), now: () => clock, log: () => {} }));
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/game`;
  const authDate = Math.floor(clock / 1000);
  const call = async (method, path, body, initData) => {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...(initData !== null ? { "X-Telegram-Init-Data": initData } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const player = (id) => {
    const init = signInitData({ id, first_name: "T" }, BOT_TOKEN, authDate);
    return {
      init,
      start: (levelId) => call("POST", "/level-start", { levelId, configVersion: ARENA_CONFIG_VERSION }, init),
      complete: (body) => call("POST", "/level-complete", { configVersion: ARENA_CONFIG_VERSION, ...body }, init),
      profile: () => call("GET", "/profile", null, init),
      // start + wait + win with `shots`
      async win(levelId, shots, waitMs = 20000) {
        const s = await this.start(levelId);
        assert.equal(s.status, 200, JSON.stringify(s.body));
        clock += waitMs;
        return this.complete({ runId: s.body.runId, levelId, shotsUsed: shots, coinsCollected: ARENA_LEVELS[levelId].coins, score: 12345 });
      },
    };
  };
  return { server, call, player, tick: ms => { clock += ms; }, now: () => clock };
}

test("verifyInitData: accepts a real signature, rejects tampering/wrong token/stale", () => {
  const now = Date.now();
  const good = signInitData({ id: 42 }, BOT_TOKEN, Math.floor(now / 1000));
  assert.equal(verifyInitData(good, BOT_TOKEN, 86400, now).id, 42);
  assert.equal(verifyInitData(good, "999:other", 86400, now), null);
  const tampered = good.replace(encodeURIComponent('"id":42'), encodeURIComponent('"id":43'));
  assert.notEqual(tampered, good);
  assert.equal(verifyInitData(tampered, BOT_TOKEN, 86400, now), null);
  assert.equal(verifyInitData(good, BOT_TOKEN, 86400, now + 2 * 86400 * 1000), null);
  assert.equal(verifyInitData("", BOT_TOKEN), null);
  assert.equal(verifyInitData("hash=zz", BOT_TOKEN), null);
});

test("requests without valid initData get 401", async () => {
  const { server, call } = await makeServer();
  try {
    assert.equal((await call("GET", "/profile", null, null)).status, 401);
    assert.equal((await call("GET", "/profile", null, "user=%7B%22id%22%3A1%7D&hash=" + "0".repeat(64))).status, 401);
    // a client can't pick its own identity via the body
    assert.equal((await call("POST", "/level-start", { levelId: 0, userId: 1, configVersion: ARENA_CONFIG_VERSION }, null)).status, 401);
  } finally { server.close(); }
});

test("bonus: server computes stars and credits only improvements", async () => {
  const { server, player } = await makeServer();
  try {
    const p = player(1001);
    // level 1 (easy, 5 shots): 4 shots -> 2 stars -> 2 * 0.1% = 0.2%
    let r = await p.win(0, 4);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.stars, 2);
    assert.equal(r.body.bonusAddedPct, 0.2);
    assert.equal(r.body.bonusTotalPct, 0.2);
    // same stars again: nothing more
    r = await p.win(0, 4);
    assert.equal(r.body.bonusAddedPct, 0);
    assert.equal(r.body.bonusTotalPct, 0.2);
    // improve to 3 stars: only the extra star is paid
    r = await p.win(0, 1);
    assert.equal(r.body.stars, 3);
    assert.equal(r.body.bonusAddedPct, 0.1);
    assert.equal(r.body.bonusTotalPct, 0.3);
    assert.equal(r.body.nextUnlocked, true);
  } finally { server.close(); }
});

test("retry of the same runId is idempotent", async () => {
  const { server, player, tick } = await makeServer();
  try {
    const p = player(1002);
    await p.win(0, 1); // unlock level 2
    const s = await p.start(1);
    tick(20000);
    const body = { runId: s.body.runId, levelId: 1, shotsUsed: 3, coinsCollected: ARENA_LEVELS[1].coins };
    const a = await p.complete(body);
    const b = await p.complete(body);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(b.body.repeated, true);
    assert.equal(a.body.bonusTotalPct, b.body.bonusTotalPct);
    assert.equal((await p.profile()).body.bonusTotalPct, a.body.bonusTotalPct);
  } finally { server.close(); }
});

test("plausibility: locked level, too fast, bad shots, uncleared, wrong run, foreign run, config", async () => {
  const { server, player, tick } = await makeServer();
  try {
    const p = player(2001);
    assert.equal((await p.start(1)).body.error, "level_locked");

    let s = await p.start(0);
    tick(500); // < 2000 + 1200*shots
    let r = await p.complete({ runId: s.body.runId, levelId: 0, shotsUsed: 1, coinsCollected: 4 });
    assert.equal(r.status, 422); assert.equal(r.body.error, "too_fast");
    // a rejected run is burned — can't resubmit with other numbers
    tick(60000);
    r = await p.complete({ runId: s.body.runId, levelId: 0, shotsUsed: 1, coinsCollected: 4 });
    assert.equal(r.status, 404);

    s = await p.start(0); tick(60000);
    r = await p.complete({ runId: s.body.runId, levelId: 0, shotsUsed: 6, coinsCollected: 4 });
    assert.equal(r.body.error, "bad_shots");

    s = await p.start(0); tick(60000);
    r = await p.complete({ runId: s.body.runId, levelId: 0, shotsUsed: 0, coinsCollected: 4 });
    assert.equal(r.body.error, "bad_shots");

    s = await p.start(0); tick(60000);
    r = await p.complete({ runId: s.body.runId, levelId: 0, shotsUsed: 2, coinsCollected: 3 });
    assert.equal(r.body.error, "not_cleared");

    s = await p.start(0); tick(60000);
    r = await p.complete({ runId: s.body.runId, levelId: 1, shotsUsed: 2, coinsCollected: 3 });
    assert.equal(r.body.error, "run_level_mismatch");

    // another player's run id is unknown to me
    const q = player(2002);
    const qs = await q.start(0); tick(60000);
    r = await p.complete({ runId: qs.body.runId, levelId: 0, shotsUsed: 2, coinsCollected: 4 });
    assert.equal(r.status, 404);

    s = await p.start(0); tick(31 * 60 * 1000);
    r = await p.complete({ runId: s.body.runId, levelId: 0, shotsUsed: 2, coinsCollected: 4 });
    assert.equal(r.body.error, "run_expired");

    r = await p.complete({ runId: "x", levelId: 0, shotsUsed: 2, coinsCollected: 4 });
    assert.equal(r.body.error, "bad_run");

    const old = await p.complete({ runId: "a".repeat(32), levelId: 0, shotsUsed: 2, coinsCollected: 4, configVersion: "arena-v1" });
    assert.equal(old.body.error, "config_mismatch");

    assert.equal((await p.profile()).body.bonusTotalPct, 0);
  } finally { server.close(); }
});

test("bonus never exceeds 5.0%, and parallel duplicate submits credit once", async () => {
  const { server, player, tick } = await makeServer();
  try {
    const p = player(3001);
    let total = 0;
    for (let i = 0; i < ARENA_LEVELS.length; i++) {
      const r = await p.win(i, 1);
      assert.equal(r.status, 200, `level ${i}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.stars, 3);
      total = r.body.bonusTotalPct;
      assert.ok(total <= 5.0);
    }
    // 3 stars everywhere would be 6.9%; capped at 5.0
    assert.equal(total, 5.0);
    const prof = (await p.profile()).body;
    assert.equal(prof.bonusTotalPct, 5.0);
    assert.equal(Object.keys(prof.levels).length, 8);

    const q = player(3002);
    const s = await q.start(0);
    tick(20000);
    const body = { runId: s.body.runId, levelId: 0, shotsUsed: 1, coinsCollected: 4 };
    const results = await Promise.all([q.complete(body), q.complete(body), q.complete(body)]);
    assert.deepEqual(results.map(r => r.status), [200, 200, 200]);
    assert.equal((await q.profile()).body.bonusTotalPct, 0.3);
  } finally { server.close(); }
});

test("rate limit: 30 completes per 10 minutes", async () => {
  const { server, player, tick } = await makeServer();
  try {
    const p = player(4001);
    let last;
    for (let i = 0; i < 31; i++) {
      const s = await p.start(0);
      tick(5000);
      last = await p.complete({ runId: s.body.runId, levelId: 0, shotsUsed: 1, coinsCollected: 4 });
    }
    assert.equal(last.status, 429);
  } finally { server.close(); }
});
