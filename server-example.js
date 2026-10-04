/* ======================================================================
   Ledger Quest Arena — server side of the deposit bonus (stage 3).

   The ONLY place a bonus is ever computed. The game client (api.js) sends
   raw facts about a won level plus Telegram's signed initData; this module:
     1. verifies the initData HMAC (Telegram Mini App algorithm) and its age,
     2. checks the result is plausible (a server-issued single-use run, the
        level is unlocked for this player, shot/coin counts match the
        server's own level table, enough real time has passed, rate limit),
     3. works out the stars from the server's own rules,
     4. credits only the IMPROVEMENT over the player's best stars on that
        level, at the tier's rate, never past MAX_BONUS,
     5. stores the answer per run, so a retried request returns the same
        result instead of crediting twice.

   Use it two ways:
     - mount in the existing server.js:
         import { createArenaRouter } from "./server-example.js";
         app.use("/api/game", createArenaRouter({ botToken: BOT_TOKEN }));
     - or run standalone for local testing:
         BOT_TOKEN=123:abc node server-example.js
       (serves the game at http://localhost:3000/arena)

   What this does NOT protect against: the physics runs on the player's
   device, so a modified client can still report a clean 3-star win with
   plausible timing. The checks here bound what such a client can get (a
   level's max stars, once, at its tier's rate, under the 5% cap). Full
   protection needs the server to re-simulate the recorded shots.
   ====================================================================== */
import crypto from "crypto";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

export const ARENA_CONFIG_VERSION = "arena-v2"; // must match api.js

// Bonus rates, in basis points of a percent (1 bp = 0.01%), per star.
// Integers only, so totals never drift from floating-point rounding.
export const REWARDS_BP = { easy: 10, medium: 20, hard: 35, expert: 50 }; // 0.1 / 0.2 / 0.35 / 0.5 %
export const MAX_BONUS_BP = 500;                                          // 5.0 %

// The server's own copy of the level table. Must match the game's
// DIFFICULTY/LEVEL_TIERS/LEVEL_CHARGES_DELTA and each level's coin count
// (bump ARENA_CONFIG_VERSION on both sides when it changes).
export const ARENA_LEVELS = [
  { tier: "easy",   charges: 5, coins: 4 }, // 1 Три башни
  { tier: "easy",   charges: 5, coins: 3 }, // 2 Мост
  { tier: "medium", charges: 4, coins: 3 }, // 3 Крепость на крыше
  { tier: "medium", charges: 4, coins: 3 }, // 4 Пирамида
  { tier: "hard",   charges: 4, coins: 4 }, // 5 Небоскрёб
  { tier: "hard",   charges: 3, coins: 3 }, // 6 Снайпер
  { tier: "expert", charges: 5, coins: 3 }, // 7 Рампа
  { tier: "expert", charges: 5, coins: 5 }, // 8 Мегаполис
];

// Plausibility limits.
const RUN_TTL_MS = 30 * 60 * 1000;           // a run must be finished within 30 min
const MIN_LEVEL_MS = 2000;                    // intro camera flyover alone takes ~2.2s
const MIN_MS_PER_SHOT = 1200;                 // aim + flight + settle per shot
const MAX_OPEN_RUNS = 5;                      // per player; older ones are dropped
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_COMPLETES = 30;                // level-complete calls per player per window
const MAX_SCORE = 500000;                     // stored best score is clamped to this

export function starsFor(level, shotsUsed) {
  return Math.max(1, Math.min(3, 1 + (level.charges - shotsUsed)));
}
const bpToPct = bp => Math.round(bp) / 100;

/* ---------- Telegram initData verification ----------
   https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
   secret = HMAC_SHA256(key="WebAppData", msg=bot_token)
   hash   = hex(HMAC_SHA256(key=secret, msg=data_check_string))
   data_check_string = every field except `hash`, sorted by key, "k=v" joined by "\n".
   Returns the parsed `user` object, or null. */
export function verifyInitData(initData, botToken, maxAgeSec = 86400, nowMs = Date.now()) {
  if (!initData || typeof initData !== "string" || !botToken) return null;
  let params;
  try { params = new URLSearchParams(initData); } catch { return null; }
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = crypto.createHmac("sha256", secret).update(dataCheckString).digest();
  const given = Buffer.from(hash, "hex");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || authDate <= 0) return null;
  const ageSec = nowMs / 1000 - authDate;
  if (ageSec > maxAgeSec || ageSec < -300) return null; // stale, or from the future

  try {
    const user = JSON.parse(params.get("user") || "null");
    return user && (typeof user.id === "number" || typeof user.id === "string") ? user : null;
  } catch { return null; }
}

/* ---------- storage ----------
   Player record:
     { id, bonusBp, levels: { [levelId]: { bestStars, bestScore } },
       runs: { [runId]: { levelId, startedAt, result|null } }, completes: [timestamps] }
   TODO(prod): replace with Postgres (store.js already uses DATABASE_URL).
   Keep the read-modify-write per player inside withPlayerLock (or a DB
   transaction with SELECT ... FOR UPDATE) so two parallel requests can't
   both credit the same improvement. */
export class MemoryArenaStore {
  constructor() { this.players = new Map(); }
  async getPlayer(id) {
    const p = this.players.get(id);
    return p ? structuredClone(p) : { id, bonusBp: 0, levels: {}, runs: {}, completes: [] };
  }
  async savePlayer(p) { this.players.set(p.id, structuredClone(p)); }
}

export function createArenaRouter({
  botToken,
  store = new MemoryArenaStore(),
  initDataMaxAgeSec = 86400,
  now = () => Date.now(),
  log = (...a) => console.log("[arena]", ...a),
} = {}) {
  if (!botToken) throw new Error("createArenaRouter: botToken is required");
  const router = express.Router();
  router.use(express.json({ limit: "4kb" }));

  const locks = new Map();
  function withPlayerLock(id, fn) {
    const prev = locks.get(id) || Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    locks.set(id, tail);
    tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
    return next;
  }

  const fail = (res, status, error, message) => res.status(status).json({ error, message });

  // Every route: the player id comes ONLY from verified initData.
  router.use((req, res, next) => {
    const user = verifyInitData(req.get("X-Telegram-Init-Data"), botToken, initDataMaxAgeSec, now());
    if (!user) return fail(res, 401, "bad_init_data", "Сессия Telegram недействительна. Открой игру заново.");
    req.playerId = "tg:" + String(user.id);
    next();
  });

  const isUnlocked = (player, levelId) =>
    levelId === 0 || ((player.levels[levelId - 1] || {}).bestStars || 0) > 0;

  function profileView(player) {
    const levels = {};
    for (const [k, v] of Object.entries(player.levels)) levels[k] = { bestStars: v.bestStars, bestScore: v.bestScore };
    return { bonusTotalPct: bpToPct(player.bonusBp), maxBonusPct: bpToPct(MAX_BONUS_BP), levels };
  }

  function pruneRuns(player, t) {
    for (const [id, r] of Object.entries(player.runs)) {
      // finished runs are kept as long as open ones so a late retry still
      // gets its stored answer; everything goes after RUN_TTL_MS * 2
      if (t - r.startedAt > RUN_TTL_MS * 2) delete player.runs[id];
    }
  }

  const validLevelId = v => Number.isInteger(v) && v >= 0 && v < ARENA_LEVELS.length;

  router.get("/profile", async (req, res, next) => {
    try { res.json(profileView(await store.getPlayer(req.playerId))); } catch (e) { next(e); }
  });

  router.post("/level-start", (req, res, next) => {
    const { levelId, configVersion } = req.body || {};
    if (configVersion !== ARENA_CONFIG_VERSION) return fail(res, 409, "config_mismatch", "Обнови игру.");
    if (!validLevelId(levelId)) return fail(res, 400, "bad_level", "Неизвестный уровень.");
    withPlayerLock(req.playerId, async () => {
      const t = now();
      const player = await store.getPlayer(req.playerId);
      if (!isUnlocked(player, levelId)) return fail(res, 403, "level_locked", "Уровень ещё не открыт.");
      pruneRuns(player, t);
      const open = Object.entries(player.runs).filter(([, r]) => !r.result).sort((a, b) => a[1].startedAt - b[1].startedAt);
      while (open.length >= MAX_OPEN_RUNS) delete player.runs[open.shift()[0]];
      const runId = crypto.randomBytes(16).toString("hex");
      player.runs[runId] = { levelId, startedAt: t, result: null };
      await store.savePlayer(player);
      res.json({ runId });
    }).catch(next);
  });

  router.post("/level-complete", (req, res, next) => {
    const { runId, levelId, shotsUsed, coinsCollected, score, configVersion } = req.body || {};
    if (configVersion !== ARENA_CONFIG_VERSION) return fail(res, 409, "config_mismatch", "Обнови игру.");
    if (typeof runId !== "string" || !/^[0-9a-f]{32}$/.test(runId)) return fail(res, 400, "bad_run", "Нет сессии уровня.");
    if (!validLevelId(levelId)) return fail(res, 400, "bad_level", "Неизвестный уровень.");

    withPlayerLock(req.playerId, async () => {
      const t = now();
      const player = await store.getPlayer(req.playerId);
      const run = player.runs[runId];
      if (!run) return fail(res, 404, "run_not_found", "Сессия уровня не найдена или истекла.");
      if (run.levelId !== levelId) return fail(res, 422, "run_level_mismatch", "Сессия от другого уровня.");
      // Idempotent retry: same run -> same stored answer, nothing credited again.
      if (run.result) return res.json({ ...run.result, repeated: true });

      player.completes = (player.completes || []).filter(ts => t - ts < RATE_WINDOW_MS);
      if (player.completes.length >= RATE_MAX_COMPLETES) return fail(res, 429, "rate_limited", "Слишком много попыток. Подожди немного.");
      player.completes.push(t);

      const level = ARENA_LEVELS[levelId];
      const reject = async (code, message) => {
        delete player.runs[runId]; // an implausible run can't be retried with other numbers
        await store.savePlayer(player);
        log("rejected", req.playerId, "level", levelId, code);
        return fail(res, 422, code, message);
      };
      if (t - run.startedAt > RUN_TTL_MS) return reject("run_expired", "Сессия уровня истекла.");
      if (!Number.isInteger(shotsUsed) || shotsUsed < 1 || shotsUsed > level.charges) return reject("bad_shots", "Неверное число выстрелов.");
      if (coinsCollected !== level.coins) return reject("not_cleared", "Уровень не пройден.");
      if (t - run.startedAt < MIN_LEVEL_MS + MIN_MS_PER_SHOT * shotsUsed) return reject("too_fast", "Слишком быстро.");
      if (!isUnlocked(player, levelId)) return reject("level_locked", "Уровень ещё не открыт.");

      // ---- the only bonus calculation in the whole system ----
      const stars = starsFor(level, shotsUsed);
      const prev = player.levels[levelId] || { bestStars: 0, bestScore: 0 };
      const bestStars = Math.max(prev.bestStars, stars);
      const earnedBp = (bestStars - prev.bestStars) * REWARDS_BP[level.tier];
      const addedBp = Math.max(0, Math.min(earnedBp, MAX_BONUS_BP - player.bonusBp));
      player.bonusBp += addedBp;
      const cleanScore = Number.isInteger(score) ? Math.max(0, Math.min(MAX_SCORE, score)) : 0;
      player.levels[levelId] = { bestStars, bestScore: Math.max(prev.bestScore, cleanScore) };

      const result = {
        ok: true,
        levelId,
        stars,
        bestStars,
        starsImproved: bestStars > prev.bestStars,
        bonusAddedPct: bpToPct(addedBp),
        bonusTotalPct: bpToPct(player.bonusBp),
        maxBonusPct: bpToPct(MAX_BONUS_BP),
        capped: earnedBp > addedBp,
        nextUnlocked: levelId + 1 < ARENA_LEVELS.length ? isUnlocked(player, levelId + 1) : false,
      };
      run.result = result;
      await store.savePlayer(player);
      log("credited", req.playerId, "level", levelId, "stars", stars, "+bp", addedBp, "total bp", player.bonusBp);
      res.json(result);
    }).catch(next);
  });

  router.use((err, req, res, next) => {
    log("error", err && err.stack || err);
    if (res.headersSent) return next(err);
    fail(res, 500, "server_error", "Ошибка сервера.");
  });

  return router;
}

/* ---------- standalone dev server ---------- */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const botToken = process.env.BOT_TOKEN;
  if (!botToken) { console.error("BOT_TOKEN is missing."); process.exit(1); }
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const app = express();
  app.use("/api/game", createArenaRouter({ botToken }));
  // Only these two files are served, never the whole directory (.env lives here).
  app.get("/arena", (req, res) => res.sendFile(path.join(dir, "prototype.html")));
  app.get("/api.js", (req, res) => res.sendFile(path.join(dir, "api.js")));
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`[arena] http://localhost:${port}/arena`));
}
