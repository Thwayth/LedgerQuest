import "dotenv/config";

import express from "express";
import crypto from "crypto";
import { Telegraf, Markup } from "telegraf";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEB_APP_URL = process.env.WEB_APP_URL;
const PORT = Number(process.env.PORT || 10000);

// Optional: your personal numeric Telegram ID, so the bot can notify you
// when someone claims a reward.
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || null;

// Optional: your public Telegram @username (without the @), used to build
// a "message me" link so the user can open a chat with you directly.
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || null;

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

const bot = new Telegraf(BOT_TOKEN);

// Filled in once at startup via bot.telegram.getMe().
let BOT_USERNAME = null;

// Demo storage for MVP.
// Later we can replace this with Supabase/PostgreSQL so progress survives redeploys.
const users = new Map();

const QUESTIONS = [
  {
    id: "q1",
    category: "Markets",
    text: "Если рыночная доходность облигаций растёт, что обычно происходит с ценой уже выпущенной облигации?",
    options: ["Растёт", "Падает", "Не меняется", "Всегда удваивается"],
    correct: 1,
    explanation: "Цена существующей облигации обычно движется в обратную сторону относительно рыночной доходности."
  },
  {
    id: "q2",
    category: "Crypto",
    text: "Что означает высокая ликвидность торговой пары?",
    options: [
      "Всегда высокий рост цены",
      "Мало заявок в стакане",
      "Большой объём заявок и обычно меньшее проскальзывание",
      "Гарантированную прибыль"
    ],
    correct: 2,
    explanation: "Глубокий рынок обычно позволяет исполнять ордера с меньшим ценовым воздействием."
  },
  {
    id: "q3",
    category: "Risk",
    text: "Что произойдёт с риском позиции, если увеличить размер позиции при неизменном стоп-лоссе?",
    options: [
      "Риск обычно увеличится",
      "Риск исчезнет",
      "Риск всегда останется тем же",
      "Стоп автоматически станет шире"
    ],
    correct: 0,
    explanation: "При большем размере позиции потенциальный денежный убыток до стопа обычно становится больше."
  },
  {
    id: "q4",
    category: "Trading",
    text: "Что такое проскальзывание (slippage)?",
    options: [
      "Разница между ожидаемой и фактической ценой исполнения",
      "Комиссия биржи",
      "Размер депозита",
      "Время работы биржи"
    ],
    correct: 0,
    explanation: "Slippage — это отклонение фактической цены исполнения от ожидаемой."
  },
  {
    id: "q5",
    category: "Bitcoin",
    text: "Что означает термин market order?",
    options: [
      "Ордер исполняется по доступным рыночным ценам",
      "Ордер исполняется только по заданной цене",
      "Ордер действует ровно сутки",
      "Ордер отменяет все позиции"
    ],
    correct: 0,
    explanation: "Market order стремится исполниться сразу по доступным ценам рынка."
  }
];

// Daily completion rewards. One is picked at random each time
// a user finishes today's quest for the first time.
const REWARDS = [
  "Сигнал на 300/400/500%",
  "Доступ в закрытое сообщество",
  "Сделка на 5X"
];

function pickRandomReward() {
  return REWARDS[Math.floor(Math.random() * REWARDS.length)];
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getUser(id) {
  if (!users.has(id)) {
    users.set(id, {
      id,
      xp: 0,
      streak: 0,
      lastCompletedDate: null,
      day: null,
      answers: {},
      score: 0,
      reward: null
    });
  }
  return users.get(id);
}

function buildWinMessage(ctx, reward) {
  const who = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || "без имени";
  return (
    `🎁 Выигрыш в Ledger Quest\n\n` +
    `Пользователь: ${who}\n` +
    `Telegram ID: ${ctx.from.id}\n` +
    `Награда: ${reward}`
  );
}

// Telegram Web App initData validation.
// Never trust initDataUnsafe on the server.
function validateInitData(initData) {
  if (!initData) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;

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
    calculatedHash.length !== hash.length ||
    !crypto.timingSafeEqual(
      Buffer.from(calculatedHash, "hex"),
      Buffer.from(hash, "hex")
    )
  ) {
    return null;
  }

  const userRaw = params.get("user");
  if (!userRaw) return null;

  try {
    return JSON.parse(userRaw);
  } catch {
    return null;
  }
}

function publicQuestions() {
  return QUESTIONS.map(q => ({
    id: q.id,
    category: q.category,
    text: q.text,
    options: q.options
  }));
}

app.post("/api/session", (req, res) => {
  const tgUser = validateInitData(req.body?.initData);

  // Browser demo mode: lets us design/test outside Telegram.
  // Production can be changed to reject this mode.
  if (!tgUser) {
    return res.json({
      demo: true,
      botUsername: BOT_USERNAME,
      user: {
        id: "browser-demo",
        first_name: "Quest",
        username: "demo"
      }
    });
  }

  getUser(String(tgUser.id));
  res.json({ demo: false, botUsername: BOT_USERNAME, user: tgUser });
});

app.get("/api/daily", (req, res) => {
  const userId = String(req.query.userId || "browser-demo");
  const user = getUser(userId);
  const day = todayKey();

  if (user.day !== day) {
    user.day = day;
    user.answers = {};
    user.score = 0;
    user.reward = null;
  }

  res.json({
    day,
    questions: publicQuestions(),
    score: user.score,
    xp: user.xp,
    streak: user.streak,
    answered: Object.keys(user.answers),
    reward: user.reward,
    completed: Object.keys(user.answers).length === QUESTIONS.length
  });
});

app.post("/api/answer", (req, res) => {
  const { userId = "browser-demo", questionId, optionIndex } = req.body || {};
  const user = getUser(String(userId));

  const question = QUESTIONS.find(q => q.id === questionId);
  if (!question) return res.status(400).json({ error: "Question not found" });

  const index = Number(optionIndex);
  if (!Number.isInteger(index) || index < 0 || index >= question.options.length) {
    return res.status(400).json({ error: "Invalid option" });
  }

  if (user.answers[questionId] !== undefined) {
    return res.status(400).json({ error: "Already answered" });
  }

  const correct = index === question.correct;
  user.answers[questionId] = index;
  if (correct) {
    user.score += 1;
    user.xp += 10;
  }

  const finished = Object.keys(user.answers).length === QUESTIONS.length;
  if (finished && user.lastCompletedDate !== user.day) {
    user.streak += 1;
    user.lastCompletedDate = user.day;
    user.reward = pickRandomReward();
  }

  res.json({
    correct,
    correctIndex: question.correct,
    explanation: question.explanation,
    score: user.score,
    xp: user.xp,
    streak: user.streak,
    finished,
    reward: user.reward
  });
});

// Set the Telegram bot menu button to open the Mini App.
async function configureBot() {
  await bot.telegram.setChatMenuButton({
    menuButton: {
      type: "web_app",
      text: "Open Quest",
      web_app: { url: WEB_APP_URL }
    }
  });

  await bot.telegram.setMyCommands([
    { command: "start", description: "Start Ledger Quest" },
    { command: "quest", description: "Open today's quest" },
    { command: "stats", description: "Show your stats" }
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
    const user = getUser(String(ctx.from.id));

    if (!user.reward) {
      await ctx.reply(
        "Похоже, у тебя ещё нет полученной награды сегодня. Сначала пройди дневной квест до конца."
      );
      return;
    }

    await ctx.reply(
      "Готов ли ты забрать выигрыш?",
      Markup.inlineKeyboard([
        [Markup.button.callback("Да", "claim_yes")],
        [Markup.button.callback("Позже", "claim_later")]
      ])
    );
    return;
  }

  await ctx.reply(
    `⚡ LEDGER QUEST\n\n` +
    `Five questions. One daily quest.\n` +
    `Test your knowledge of markets, crypto, risk and trading.\n\n` +
    `Your daily challenge is waiting.`,
    Markup.inlineKeyboard([
      Markup.button.webApp("🚀 Open Ledger Quest", WEB_APP_URL)
    ])
  );
});

bot.action("claim_yes", async ctx => {
  await ctx.answerCbQuery();

  const user = getUser(String(ctx.from.id));

  if (!user.reward) {
    await ctx.editMessageText(
      "Похоже, награда уже не найдена. Попробуй пройти квест заново."
    );
    return;
  }

  const message = buildWinMessage(ctx, user.reward);

  // Reliable automatic notification to the admin.
  if (ADMIN_CHAT_ID) {
    try {
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, message);
    } catch (error) {
      console.error("Could not notify admin:", error.message);
    }
  } else {
    console.warn("ADMIN_CHAT_ID is not set — admin notification skipped.");
  }

  // Also offer the user a direct link to message the admin personally,
  // with the win details pre-filled in the message box.
  if (ADMIN_USERNAME) {
    const url = `https://t.me/${ADMIN_USERNAME}?text=${encodeURIComponent(message)}`;
    await ctx.editMessageText(
      "🎁 Отлично! Нажми кнопку ниже, чтобы написать мне лично.",
      Markup.inlineKeyboard([Markup.button.url("Написать мне", url)])
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
    "Хорошо. Нажми Claim Reward ещё раз, когда будешь готов забрать выигрыш."
  );
});

bot.command("quest", async ctx => {
  await ctx.reply(
    "Your daily quest is ready.",
    Markup.inlineKeyboard([
      Markup.button.webApp("🧠 Start Quest", WEB_APP_URL)
    ])
  );
});

bot.command("stats", async ctx => {
  const user = getUser(String(ctx.from.id));
  await ctx.reply(
    `🏆 LEDGER QUEST STATS\n\n` +
    `XP: ${user.xp}\n` +
    `Today's score: ${user.score}/5\n` +
    `Streak: ${user.streak} 🔥`
  );
});

bot.catch(err => console.error("Bot error:", err));

app.get("*splat", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

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

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
