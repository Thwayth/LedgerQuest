const tg = window.Telegram?.WebApp || null;

if (tg) {
  tg.ready();
  tg.expand();
  try {
    tg.setHeaderColor("#080b0d");
    tg.setBackgroundColor("#080b0d");
  } catch {}
}

// In a normal browser (outside Telegram) each browser gets its own demo id,
// so demo users don't share one progress.
function getDemoId() {
  const key = "lq-demo-id";
  try {
    let id = localStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

const authHeaders = tg?.initData
  ? { "X-Telegram-Init-Data": tg.initData }
  : { "X-Demo-Id": getDemoId() };

const XP_PER_CORRECT = 10;

const state = {
  user: null,
  botUsername: null,
  questions: [],
  total: 5,
  current: 0,
  score: 0,
  xp: 0,
  streak: 0,
  answered: {},
  reward: null,
  rewardClaimed: false,
  rewardTiers: []
};

const $ = id => document.getElementById(id);

// ---------- Avatar ----------
// A "living" host: changes emotion (LED color, glow, motion), types out
// remarks and comments on its own if the player goes quiet.

const pick = list => list[Math.floor(Math.random() * list.length)];

const LINES = {
  intro: [
    "Поехали. Посмотрим, что ты знаешь сегодня.",
    "Я уже подобрала вопросы. Начинаем?",
    "Кофе остыл, рынок открыт. Первый вопрос.",
    "Сегодня без поблажек. Готовься."
  ],
  next: [
    "Следующий. Тут есть подвох, присмотрись.",
    "Этот вопрос мне нравится.",
    "Детали решают всё.",
    "Думай как трейдер, а не как игрок.",
    "Спокойно. Прочитай все варианты."
  ],
  last: [
    "Последний вопрос. Соберись.",
    "Финальный ход. Не торопись."
  ],
  idle: [
    "Думаешь? Это хороший знак.",
    "Первая мысль не всегда верная…",
    "Я подожду. Рынок тоже умеет ждать.",
    "Подсказка: ищи вариант без слова «всегда».",
    "Хм. Интересно, что ты выберешь."
  ],
  correct: [
    "Точно в цель.",
    "Именно так. Чистая работа.",
    "Вот это уровень.",
    "Да! Так и есть."
  ],
  streak: [
    "Уже {n} подряд. Горячая серия 🔥",
    "{n} из {n}. Мне начинает нравиться.",
    "{n} верных подряд. Не сбавляй темп."
  ],
  wrong: [
    "Мимо. Но теперь ты это знаешь.",
    "Рынок учит дорого, а я бесплатно. Прочитай пояснение.",
    "Бывает. Главное понять, почему.",
    "Не в этот раз. Запомни это."
  ],
  wrongAgain: [
    "Ничего, следующий возьмём.",
    "Выдыхай. Сейчас отыграемся."
  ],
  error: [
    "Связь пропала. Нажми ответ ещё раз."
  ],
  resultPerfect: ["Идеально. Ни одной ошибки!", "Безупречно. Ты сегодня в форме."],
  resultGood: ["Сильный результат. Завтра добьём до идеала.", "Хорошо сыграно."],
  resultLow: ["Сегодня рынок победил. Завтра реванш.", "Каждая ошибка делает тебя сильнее."]
};

const MOOD_LABEL = {
  neutral: "ONLINE",
  thinking: "THINKING",
  happy: "PLEASED",
  excited: "IMPRESSED",
  sad: "HMM…",
  surprised: "OH!"
};

// Optional per-emotion portraits: put public/assets/avatar/<emotion>.jpg
// (neutral, thinking, happy, excited, sad, surprised) and they are used
// automatically instead of the default close-up.
const customPortraits = {};
Object.keys(MOOD_LABEL).forEach(emotion => {
  const img = new Image();
  img.onload = () => { customPortraits[emotion] = img.src; };
  img.src = `/assets/avatar/${emotion}.jpg`;
});

function applyPortrait(frame, emotion) {
  if (!frame) return;
  const src = customPortraits[emotion];
  frame.classList.toggle("custom", Boolean(src));
  frame.style.backgroundImage = src ? `url("${src}")` : "";
}

const avatar = {
  typingTimer: null,
  idleTimer: null,
  correctRun: 0,
  wrongRun: 0,

  setEmotion(emotion) {
    const stage = $("avatar");
    // Re-trigger the one-shot reaction animation even for the same emotion.
    stage.dataset.emotion = "neutral";
    void stage.offsetWidth;
    stage.dataset.emotion = emotion;
    $("avatar-mood").textContent = MOOD_LABEL[emotion] || "ONLINE";
    applyPortrait($("avatar-frame"), emotion);
  },

  say(text, emotion) {
    if (emotion) this.setEmotion(emotion);
    const el = $("bot-message");
    clearInterval(this.typingTimer);
    el.textContent = "";
    el.classList.add("typing");
    const chars = [...text];
    let i = 0;
    this.typingTimer = setInterval(() => {
      el.textContent += chars[i++] || "";
      if (i >= chars.length) {
        clearInterval(this.typingTimer);
        el.classList.remove("typing");
      }
    }, 22);
  },

  // If the player hasn't answered for a while, the host chimes in.
  armIdle() {
    this.disarmIdle();
    this.idleTimer = setTimeout(() => this.say(pick(LINES.idle), "thinking"), 11000);
  },
  disarmIdle() {
    clearTimeout(this.idleTimer);
  },

  onQuestion(index, total) {
    const line =
      index === total - 1 ? pick(LINES.last) :
      index === 0 || this.correctRun + this.wrongRun === 0 ? pick(LINES.intro) :
      pick(LINES.next);
    this.say(line, index === total - 1 ? "surprised" : "neutral");
    this.armIdle();
  },

  onAnswer(correct) {
    this.disarmIdle();
    if (correct) {
      this.correctRun += 1;
      this.wrongRun = 0;
      if (this.correctRun >= 2) {
        this.say(pick(LINES.streak).replaceAll("{n}", this.correctRun), "excited");
      } else {
        this.say(pick(LINES.correct), "happy");
      }
    } else {
      this.wrongRun += 1;
      this.correctRun = 0;
      this.say(pick(this.wrongRun >= 2 ? LINES.wrongAgain : LINES.wrong), "sad");
    }
  },

  onError() {
    this.say(pick(LINES.error), "surprised");
  },

  resultLine(score, total) {
    if (score === total) return { text: pick(LINES.resultPerfect), emotion: "excited" };
    if (score >= Math.ceil(total * 0.6)) return { text: pick(LINES.resultGood), emotion: "happy" };
    return { text: pick(LINES.resultLow), emotion: "sad" };
  }
};

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...authHeaders, ...(options.headers || {}) }
  });
  let data = {};
  try {
    data = await response.json();
  } catch {}
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function init() {
  const session = await api("/api/session", { method: "POST" });

  state.user = session.user;
  state.botUsername = session.botUsername || null;
  $("user-name").textContent = state.user.first_name || "Quest";

  const daily = await api("/api/daily");
  state.questions = daily.questions;
  state.total = daily.total || daily.questions.length;
  state.score = daily.score;
  state.xp = daily.xp;
  state.streak = daily.streak;
  state.reward = daily.reward || null;
  state.rewardClaimed = Boolean(daily.rewardClaimed);
  state.rewardTiers = daily.rewardTiers || [];

  // Rebuild which questions are already answered today,
  // so reopening the app doesn't restart from question 1.
  state.answered = {};
  (daily.answered || []).forEach(id => {
    state.answered[id] = true;
  });

  updateHeader();
  updateHome();

  $("start-btn").onclick = startQuest;
  $("back-btn").onclick = () => {
    avatar.disarmIdle();
    showScreen("home-screen");
  };
  $("next-btn").onclick = nextQuestion;
  $("home-btn").onclick = () => showScreen("home-screen");
  $("claim-btn").onclick = claimReward;

  document.querySelectorAll(".nav-item").forEach(btn => {
    btn.onclick = () => {
      if (btn.id === "stats-nav") {
        tg?.showAlert?.(`XP: ${state.xp}\nStreak: ${state.streak} days\nToday's score: ${state.score}/${state.total}`);
      } else {
        showScreen(btn.dataset.screen);
      }
    };
  });
}

function updateHeader() {
  $("top-xp").textContent = `${state.xp} XP`;
  $("top-streak").textContent = `${state.streak} 🔥`;
}

function answeredCount() {
  return Object.keys(state.answered).length;
}

function updateHome() {
  const done = answeredCount();
  $("home-count").textContent = String(state.total).padStart(2, "0");
  $("home-score").textContent = `${done} / ${state.total} completed`;
  $("home-progress").style.width = `${(done / state.total) * 100}%`;
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  $(id).classList.add("active");
  document.body.classList.toggle("quiz-mode", id === "quiz-screen");
  if (id !== "quiz-screen") $("next-dock").classList.add("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function startQuest() {
  // Resume at the first question that hasn't been answered today yet,
  // instead of always restarting at question 1.
  const nextIndex = state.questions.findIndex(q => !state.answered[q.id]);

  if (nextIndex === -1) {
    // Every question today is already answered.
    showResult();
    return;
  }

  state.current = nextIndex;
  showScreen("quiz-screen");
  renderQuestion();
}

function renderQuestion() {
  const q = state.questions[state.current];
  if (!q) return showResult();

  const pad = n => String(n).padStart(2, "0");
  $("quiz-counter").textContent = `${pad(state.current + 1)} / ${pad(state.total)}`;
  $("quiz-progress").style.width = `${(state.current / state.total) * 100}%`;
  $("question-category").textContent = q.category.toUpperCase();
  $("question-text").textContent = q.text;
  avatar.onQuestion(state.current, state.total);

  const options = $("options");
  options.innerHTML = "";
  $("explanation").className = "explanation";
  $("explanation").textContent = "";
  $("next-dock").classList.add("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });

  q.options.forEach((text, index) => {
    const btn = document.createElement("button");
    btn.className = "option";
    btn.textContent = `${String.fromCharCode(65 + index)}  ${text}`;
    btn.onclick = () => answerQuestion(index);
    options.appendChild(btn);
  });
}

async function answerQuestion(optionIndex) {
  const q = state.questions[state.current];
  if (state.answered[q.id]) return;

  state.answered[q.id] = true;
  document.querySelectorAll(".option").forEach(btn => btn.classList.add("disabled"));

  let result;
  try {
    result = await api("/api/answer", {
      method: "POST",
      body: JSON.stringify({ questionId: q.id, optionIndex })
    });
  } catch (err) {
    // Don't leave the question stuck: unlock it so the user can try again.
    delete state.answered[q.id];
    document.querySelectorAll(".option").forEach(btn => btn.classList.remove("disabled"));
    avatar.onError();
    tg?.showAlert?.(err.message || "Something went wrong. Please try again.");
    return;
  }

  const buttons = [...document.querySelectorAll(".option")];
  buttons[result.correctIndex].classList.add("correct");
  if (!result.correct) buttons[optionIndex].classList.add("wrong");

  state.score = result.score;
  state.xp = result.xp;
  state.streak = result.streak;
  if (result.reward) {
    state.reward = result.reward;
    state.rewardClaimed = Boolean(result.rewardClaimed);
  }

  avatar.onAnswer(result.correct);
  tg?.HapticFeedback?.notificationOccurred?.(result.correct ? "success" : "error");

  $("explanation").textContent = result.explanation;
  $("explanation").classList.add("show");
  $("next-btn").textContent = state.current === state.total - 1 ? "FINISH QUEST  →" : "CONTINUE  →";
  $("next-dock").classList.remove("hidden");
  // Bring the explanation into view above the docked button.
  $("explanation").scrollIntoView({ behavior: "smooth", block: "center" });
  updateHeader();
}

function nextQuestion() {
  state.current += 1;
  if (state.current >= state.questions.length) showResult();
  else renderQuestion();
}

function showResult() {
  avatar.disarmIdle();
  $("result-score").textContent = `${state.score}/${state.total}`;
  $("result-xp").textContent = `+${state.score * XP_PER_CORRECT}`;
  $("result-streak").textContent = state.streak;
  $("result-title").textContent =
    state.score === state.total ? "Perfect run." :
    state.score >= Math.ceil(state.total * 0.6) ? "Solid work." :
    "Keep building.";

  const line = avatar.resultLine(state.score, state.total);
  $("result-avatar").dataset.emotion = line.emotion;
  applyPortrait($("result-avatar").querySelector(".avatar-frame"), line.emotion);
  $("result-quote").textContent = `«${line.text}»`;

  $("result-copy").textContent =
    `You completed today's Ledger Quest with ${state.score} correct answer${state.score === 1 ? "" : "s"}.`;

  renderReward();

  updateHome();
  updateHeader();
  showScreen("result-screen");
}

// Reward card: tier color, title, a 5-step ladder and a hint at the top reward.
function renderReward() {
  const reward = state.reward;
  $("no-reward").classList.toggle("hidden", Boolean(reward));
  $("reward-box").classList.toggle("hidden", !reward);
  // Already claimed: keep showing the reward, but hide the claim button.
  $("claim-btn").classList.toggle("hidden", !reward || state.rewardClaimed);
  if (!reward) return;

  const tiers = state.rewardTiers;
  const level = tiers.findIndex(t => t.title === reward.title) + 1;

  $("reward-box").dataset.tier = reward.tier || "";
  $("reward-tier").textContent = reward.tier || "";
  $("reward-tier").classList.toggle("hidden", !reward.tier);
  $("reward-title").textContent = reward.title;
  $("reward-note").textContent = state.rewardClaimed ? "Награда уже забрана." : reward.note || "";

  const ladder = $("reward-ladder");
  ladder.innerHTML = "";
  ladder.classList.toggle("hidden", !level || !tiers.length);
  tiers.forEach((_, i) => {
    const step = document.createElement("span");
    if (i < level) step.classList.add("on");
    if (i === level - 1) step.classList.add("current");
    ladder.appendChild(step);
  });

  const top = tiers[tiers.length - 1];
  const next = $("reward-next");
  if (level && top && level < tiers.length) {
    next.innerHTML = "";
    next.append("За идеальный результат: ");
    const b = document.createElement("b");
    b.textContent = top.title;
    next.append(b);
    next.classList.remove("hidden");
  } else {
    next.classList.add("hidden");
  }
}

function claimReward() {
  if (!state.botUsername) {
    tg?.showAlert?.("Could not open Telegram chat. Please try again later.");
    return;
  }

  const url = `https://t.me/${state.botUsername}?start=claim`;

  if (tg?.openTelegramLink) {
    tg.openTelegramLink(url);
    // Close the Mini App right away instead of leaving it hanging open
    // in the background after the user is sent to the bot chat.
    tg.close();
  } else {
    window.open(url, "_blank");
  }
}

init().catch(err => {
  console.error(err);
  document.body.innerHTML = `
    <div style="color:#fff;font-family:Inter,sans-serif;padding:30px;background:#080b0d;min-height:100vh">
      <h2>Ledger Quest</h2>
      <p style="color:#9aa">Could not start the app.</p>
      <p style="color:#f77;font-size:12px">${err.message}</p>
    </div>`;
});
