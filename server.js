import "dotenv/config";

import express from "express";
import crypto from "crypto";
import { Telegraf, Markup } from "telegraf";
import path from "path";
import { fileURLToPath } from "url";

import { createStore } from "./store.js";
import { questionsForDay } from "./questions.js";
import { REWARD_TIERS, rewardForScore, rewardInfo } from "./rewards.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEB_APP_URL = process.env.WEB_APP_URL;
const PORT = Number(process.env.PORT || 10000);

// Optional: your personal numeric Telegram ID, so the bot can notify you
// when someone claims a reward.
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || null;

// Optional: your public Telegram @username (without the @), used to build
// a "claim reward" link so the user can open a chat with you directly.
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || null;

// Browser demo mode (open the app outside Telegram). Demo users get their own
// "demo-..." ids, so they can never touch a real Telegram user's progress.
// Set ALLOW_DEMO=false in production to allow only real Telegram users.
const ALLOW_DEMO = (process.env.ALLOW_DEMO ?? "true").toLowerCase() !== "false";

// How long a Telegram initData signature stays valid (seconds).
const INIT_DATA_MAX_AGE = Number(process.env.INIT_DATA_MAX_AGE_SECONDS || 86400);

// Time zone that decides when "today" starts (IANA name, e.g. Europe/Kyiv).
const QUEST_TZ = process.env.QUEST_TZ || "UTC";

const QUESTIONS_PER_DAY = Number(process.env.QUESTIONS_PER_DAY || 5);
const XP_PER_CORRECT = 10;

if (!BOT_TOKEN) {
  console.error("BOT_TOKEN is missing.");
  process.exit(1);
}
if (!WEB_APP_URL) {
  console.error("WEB_APP_URL is missing.");
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
// Missing assets get a plain 404 instead of falling through to index.html.
app.use("/assets", (req, res) => res.status(404).end());

const bot = new Telegraf(BOT_TOKEN);
const store = createStore();

// Filled in once at startup via bot.telegram.getMe().
let BOT_USERNAME = null;

// ---------- Dates ----------

function todayKey() {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: QUEST_TZ }).format(new Date());
}

function previousDay(dayKey) {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

function todaysQuestions(day, userId) {
  return questionsForDay(day, QUESTIONS_PER_DAY, userId);
}

// ---------- Per-user lock ----------
// Serializes read-modify-write per user, so two fast requests
// (e.g. double tap) can't overwrite each other's progress.
const locks = new Map();

function withUserLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  locks.set(id, tail);
  tail.then(() => {
    if (locks.get(id) === tail) locks.delete(id);
  });
  return next;
}

// Loads a user and brings them up to date for today:
// resets the daily quest on a new day and breaks the streak if a day was missed.
async function loadUser(id) {
  const user = await store.getUser(id);
  const day = todayKey();
  let changed = false;

  if (user.day !== day) {
    user.day = day;
    user.answers = {};
    user.score = 0;
    changed = true;
  }

  if (
    user.streak > 0 &&
    user.lastCompletedDate !== day &&
    user.lastCompletedDate !== previousDay(day)
  ) {
    user.streak = 0;
    changed = true;
  }

  return { user, changed };
}

// ---------- Messages ----------

// Message the bot sends to the admin automatically — keeps identifying
// info since this is the admin's only reliable way to know who to reward.
function buildAdminMessage(ctx, reward) {
  const who = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || "без имени";
  const tier = rewardInfo(reward)?.tier;
  return (
    `🎁 Выигрыш в Ledger Quest\n\n` +
    `Пользователь: ${who}\n` +
    `Telegram ID: ${ctx.from.id}\n` +
    `Награда: ${reward}` + (tier ? ` (${tier})` : "")
  );
}

// Message pre-filled in the user's own chat with the admin — no need to
// repeat the user's name/id here, Telegram already shows who's sending it.
function buildClaimMessage(reward) {
  return `Хочу забрать награду в Ledger Quest 🎁\nВыиграл: ${reward}`;
}

function adminLinkKeyboard(reward) {
  if (!ADMIN_USERNAME) return undefined;
  const url = `https://t.me/${ADMIN_USERNAME}?text=${encodeURIComponent(buildClaimMessage(reward))}`;
  return Markup.inlineKeyboard([Markup.button.url("Написать админу", url)]);
}

// ---------- Auth ----------

// Telegram Web App initData validation.
// Never trust initDataUnsafe on the server.
function validateInitData(initData) {
  if (!initData) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (
    !crypto.timingSafeEqual(
      Buffer.from(calculatedHash, "hex"),
      Buffer.from(hash, "hex")
    )
  ) {
    return null;
  }

  // Reject stale signatures so an old initData can't be reused forever.
  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > INIT_DATA_MAX_AGE) return null;

  const userRaw = params.get("user");
  if (!userRaw) return null;

  try {
    return JSON.parse(userRaw);
  } catch {
    return null;
  }
}

// Works out who is calling the API. The user id always comes from a
// verified source — never from the request body or query string.
function resolveCaller(req) {
  const initData = req.get("X-Telegram-Init-Data");
  if (initData) {
    const tgUser = validateInitData(initData);
    if (!tgUser) return { error: "Сессия Telegram устарела. Закрой приложение и открой снова." };
    return { id: String(tgUser.id), tgUser, demo: false };
  }

  if (ALLOW_DEMO) {
    const demoId = req.get("X-Demo-Id") || "";
    if (/^[a-z0-9-]{8,64}$/i.test(demoId)) {
      return { id: `demo-${demoId}`, demo: true };
    }
  }

  return { error: "Открой Ledger Quest через Telegram." };
}

function requireCaller(req, res, next) {
  const caller = resolveCaller(req);
  if (caller.error) return res.status(401).json({ error: caller.error });
  req.caller = caller;
  next();
}

// Wraps async handlers so errors become a 500 instead of a hung request.
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- API ----------

// Lightweight endpoint for uptime pings and Render health checks.
app.get("/healthz", (req, res) => res.json({ ok: true }));

function publicQuestions(questions) {
  return questions.map(q => ({
    id: q.id,
    category: q.category,
    text: q.text,
    options: q.options
  }));
}

app.post("/api/session", requireCaller, (req, res) => {
  const { demo, tgUser } = req.caller;
  res.json({
    demo,
    botUsername: BOT_USERNAME,
    user: demo ? { first_name: "трейдер", username: "demo" } : tgUser
  });
});

app.get("/api/daily", requireCaller, asyncRoute(async (req, res) => {
  const result = await withUserLock(req.caller.id, async () => {
    const { user, changed } = await loadUser(req.caller.id);
    if (changed) await store.saveUser(user);
    return user;
  });

  const questions = todaysQuestions(result.day, req.caller.id);
  const answered = Object.keys(result.answers);
  const rewardToday = result.rewardDay === result.day;

  res.json({
    day: result.day,
    questions: publicQuestions(questions),
    total: questions.length,
    score: result.score,
    xp: result.xp,
    streak: result.streak,
    answered,
    reward: rewardToday ? rewardInfo(result.reward) : null,
    rewardClaimed: rewardToday ? result.rewardClaimed : false,
    rewardTiers: REWARD_TIERS.filter(Boolean).map(({ tier, title }) => ({ tier, title })),
    completed: answered.length >= questions.length
  });
}));

app.post("/api/answer", requireCaller, asyncRoute(async (req, res) => {
  const { questionId, optionIndex } = req.body || {};

  const outcome = await withUserLock(req.caller.id, async () => {
    const { user } = await loadUser(req.caller.id);
    const questions = todaysQuestions(user.day, req.caller.id);

    const question = questions.find(q => q.id === questionId);
    if (!question) return { status: 400, body: { error: "Вопрос не найден. Обнови приложение." } };

    const index = Number(optionIndex);
    if (!Number.isInteger(index) || index < 0 || index >= question.options.length) {
      return { status: 400, body: { error: "Такого варианта ответа нет." } };
    }

    if (user.answers[questionId] !== undefined) {
      return { status: 400, body: { error: "На этот вопрос ты уже ответил." } };
    }

    const correct = index === question.correct;
    user.answers[questionId] = index;
    if (correct) {
      user.score += 1;
      user.xp += XP_PER_CORRECT;
    }

    const finished = Object.keys(user.answers).length >= questions.length;
    if (finished && user.lastCompletedDate !== user.day) {
      user.streak = user.lastCompletedDate === previousDay(user.day) ? user.streak + 1 : 1;
      user.bestStreak = Math.max(user.bestStreak || 0, user.streak);
      user.questsCompleted = (user.questsCompleted || 0) + 1;
      user.lastCompletedDate = user.day;

      // Reward depends on how many answers were correct. With 0 correct
      // there's no new reward, and an older unclaimed one is kept.
      const earned = rewardForScore(user.score, questions.length);
      if (earned) {
        user.reward = earned.title;
        user.rewardDay = user.day;
        user.rewardClaimed = false;
        await store.addReward(user.id, {
          day: user.day,
          title: earned.title,
          tier: earned.tier,
          score: user.score,
          total: questions.length
        });
      }
    }

    await store.saveUser(user);

    const rewardToday = user.rewardDay === user.day;
    return {
      status: 200,
      body: {
        correct,
        correctIndex: question.correct,
        explanation: question.explanation,
        score: user.score,
        xp: user.xp,
        streak: user.streak,
        answeredCount: Object.keys(user.answers).length,
        finished,
        reward: rewardToday ? rewardInfo(user.reward) : null,
        rewardClaimed: rewardToday ? user.rewardClaimed : false
      }
    };
  });

  res.status(outcome.status).json(outcome.body);
}));

// Player profile: totals and the history of earned rewards.
app.get("/api/profile", requireCaller, asyncRoute(async (req, res) => {
  const user = await withUserLock(req.caller.id, async () => {
    const { user, changed } = await loadUser(req.caller.id);
    if (changed) await store.saveUser(user);
    return user;
  });
  const rewards = await store.listRewards(req.caller.id, 50);

  res.json({
    xp: user.xp,
    streak: user.streak,
    bestStreak: user.bestStreak || 0,
    questsCompleted: user.questsCompleted || 0,
    rewardsClaimed: rewards.filter(r => r.status === "claimed").length,
    rewards: rewards.map(r => ({ ...r, note: rewardInfo(r.title)?.note || "" }))
  });
}));

app.use("/api", (err, req, res, next) => {
  console.error("API error:", err);
  res.status(500).json({ error: "Ошибка сервера. Попробуй ещё раз." });
});

// ---------- Bot ----------

// Set the Telegram bot menu button to open the Mini App.
async function configureBot() {
  await bot.telegram.setChatMenuButton({
    menuButton: {
      type: "web_app",
      text: "Открыть квест",
      web_app: { url: WEB_APP_URL }
    }
  });

  await bot.telegram.setMyCommands([
    { command: "start", description: "Запустить Ledger Quest" },
    { command: "quest", description: "Открыть квест дня" },
    { command: "stats", description: "Моя статистика" }
  ]);
}

async function initBotUsername() {
  const me = await bot.telegram.getMe();
  BOT_USERNAME = me.username;
}

bot.start(async ctx => {
  const payload = ctx.startPayload;

  // Reached when the user taps "Claim reward" in the Mini App,
  // which opens https://t.me/<bot>?start=claim
  if (payload === "claim") {
    const user = await store.getUser(String(ctx.from.id));

    if (!user.reward) {
      await ctx.reply(
        "Похоже, у тебя пока нет награды. Сначала пройди дневной квест до конца."
      );
      return;
    }

    if (user.rewardClaimed) {
      await ctx.reply(
        `Эта награда уже забрана: ${user.reward}\nНовая появится после следующего пройденного квеста.`,
        adminLinkKeyboard(user.reward)
      );
      return;
    }

    await ctx.reply(
      `Твоя награда: ${user.reward}\n\nГотов ли ты забрать выигрыш?`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Да", "claim_yes")],
        [Markup.button.callback("Позже", "claim_later")]
      ])
    );
    return;
  }

  await ctx.reply(
    `⚡ LEDGER QUEST\n\n` +
    `Пять вопросов. Один квест в день.\n` +
    `Проверь знания о рынках, крипте, рисках и трейдинге.\n\n` +
    `Чем больше верных ответов, тем круче награда. Твой квест уже ждёт.`,
    Markup.inlineKeyboard([
      Markup.button.webApp("🚀 Открыть Ledger Quest", WEB_APP_URL)
    ])
  );
});

bot.action("claim_yes", async ctx => {
  await ctx.answerCbQuery();
  const id = String(ctx.from.id);

  // Mark as claimed under the lock, so double taps can't claim twice.
  const claim = await withUserLock(id, async () => {
    const user = await store.getUser(id);
    if (!user.reward) return { status: "none" };
    if (user.rewardClaimed) return { status: "already", reward: user.reward };
    user.rewardClaimed = true;
    await store.saveUser(user);
    await store.markRewardClaimed(id, user.rewardDay);
    return { status: "ok", reward: user.reward };
  });

  if (claim.status === "none") {
    await ctx.editMessageText("Похоже, награда не найдена. Пройди дневной квест до конца.");
    return;
  }

  if (claim.status === "already") {
    await ctx.editMessageText(
      `Эта награда уже забрана: ${claim.reward}`,
      adminLinkKeyboard(claim.reward)
    );
    return;
  }

  // Reliable automatic notification to the admin — keeps who/what info.
  if (ADMIN_CHAT_ID) {
    try {
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, buildAdminMessage(ctx, claim.reward));
    } catch (error) {
      console.error("Could not notify admin:", error.message);
    }
  } else {
    console.warn("ADMIN_CHAT_ID is not set — admin notification skipped.");
  }

  // Also offer the user a direct link to message the admin personally.
  if (ADMIN_USERNAME) {
    await ctx.editMessageText(
      "🎁 Отлично! Нажми кнопку ниже, чтобы забрать награду.",
      adminLinkKeyboard(claim.reward)
    );
  } else {
    await ctx.editMessageText(
      "🎁 Отлично! Мы уже получили информацию и скоро свяжемся с тобой."
    );
  }
});

bot.action("claim_later", async ctx => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    "Хорошо. Нажми «Забрать награду» ещё раз, когда будешь готов."
  );
});

bot.command("quest", async ctx => {
  await ctx.reply(
    "Квест дня готов.",
    Markup.inlineKeyboard([
      Markup.button.webApp("🧠 Начать квест", WEB_APP_URL)
    ])
  );
});

bot.command("stats", async ctx => {
  const id = String(ctx.from.id);
  const user = await withUserLock(id, async () => {
    const { user, changed } = await loadUser(id);
    if (changed) await store.saveUser(user);
    return user;
  });
  const total = todaysQuestions(user.day, id).length;
  await ctx.reply(
    `🏆 СТАТИСТИКА LEDGER QUEST\n\n` +
    `Опыт: ${user.xp} XP\n` +
    `Сегодня: ${user.score} из ${total}\n` +
    `Серия: ${user.streak} 🔥`
  );
});

bot.catch(err => console.error("Bot error:", err));

app.get("*splat", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------- Start ----------

async function main() {
  await store.init();
  console.log(`Storage: ${store.kind}`);
  if (store.kind === "memory") {
    console.warn("DATABASE_URL is not set — progress is kept in memory and is lost on restart.");
  }

  app.listen(PORT, async () => {
    console.log(`Ledger Quest running on port ${PORT}`);
    try {
      await initBotUsername();
      await configureBot();
      console.log("Telegram menu button configured.");
    } catch (error) {
      console.error("Could not configure Telegram menu button:", error.message);
    }
  });

  bot.launch().then(() => console.log("Telegram bot launched."));
}

main().catch(error => {
  console.error("Startup failed:", error);
  process.exit(1);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
