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
  rank: { index: 0, name: "Новичок", icon: "🌱", nextName: "Трейдер", xpToNext: 150, progress: 0 },
  streak: 0,
  answered: {},
  reward: null,
  rewardClaimed: false,
  rewardTiers: []
};

const $ = id => document.getElementById(id);

// Russian plural: plural(3, ["ответ", "ответа", "ответов"]) -> "ответа"
function plural(n, forms) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

const TIER_LABEL = {
  COMMON: "ОБЫЧНАЯ",
  UNCOMMON: "НЕОБЫЧНАЯ",
  RARE: "РЕДКАЯ",
  EPIC: "ЭПИЧЕСКАЯ",
  LEGENDARY: "ЛЕГЕНДАРНАЯ"
};

// ---------- Avatar ----------
// A "living" host. Each emotion changes the ear LED and eye glow color,
// motion and particles; remarks are typed out and react to the category,
// answer speed, streaks, taps and silence.

const pick = list => list[Math.floor(Math.random() * list.length)];

const LINES = {
  greet: {
    morning: ["Доброе утро. Кофе допит? Тогда начинаем.", "Утро, рынок только просыпает. А ты уже здесь."],
    day: ["Привет. Пять вопросов, и день станет продуктивнее.", "О, ты вовремя. Я как раз подобрала вопросы."],
    evening: ["Добрый вечер. Самое время проверить голову.", "Вечерняя сессия? Уважаю."],
    night: ["Не спится? Рынок тоже никогда не спит.", "Ночной трейдер. Проверим, не устал ли мозг."]
  },
  category: {
    "Рынки": ["Вопрос про рынки. Тут важна логика, а не удача.", "Рынки. Думай о причинах и следствиях."],
    "Крипто": ["Крипта — моя стихия. Посмотрим, твоя ли тоже.", "Крипто‑вопрос. Не верь хайпу, верь фактам."],
    "Риски": ["Про риски. Самое скучное и самое важное.", "Риск‑менеджмент. Тот, кто это знает, живёт дольше."],
    "Трейдинг": ["Трейдинг. Вспомни, как устроен стакан.", "Базовая механика торговли. Не торопись."],
    "Биткоин": ["Биткоин. Классика, которую должен знать каждый.", "Вопрос про первую криптовалюту. Легко? Проверим."]
  },
  next: [
    "Следующий. Тут есть подвох, присмотрись.",
    "Этот вопрос мне нравится.",
    "Детали решают всё.",
    "Думай как трейдер, а не как игрок.",
    "Спокойно. Прочитай все варианты."
  ],
  last: ["Последний вопрос. Соберись.", "Финальный ход. Всё решится сейчас."],
  lastWorried: ["Последний шанс отыграться. Я в тебя верю… кажется.", "Финал. Давай без ошибок, ладно?"],
  idle: [
    "Думаешь? Это хороший знак.",
    "Первая мысль не всегда верная…",
    "Я подожду. Рынок тоже умеет ждать.",
    "Подсказка: ищи вариант без слова «всегда».",
    "Тик‑так. Шучу, таймера нет."
  ],
  idleLong: [
    "Ты там не уснул? Я всё ещё жду.",
    "Кажется, я знаю ответ. Но не скажу.",
    "Могу пока посчитать спред. Или просто подождать."
  ],
  correct: ["Точно в цель.", "Именно так. Чистая работа.", "Вот это уровень.", "Да! Так и есть."],
  fast: ["Молниеносно! Ты это знал заранее?", "Меньше трёх секунд. Впечатляет.", "Быстро и верно. Так и надо."],
  slow: ["Долго думал, но результат того стоил.", "Не спеша и в точку. Мне нравится."],
  streak: [
    "Уже {n} подряд. Горячая серия 🔥",
    "{n} из {n}. Мне начинает нравиться.",
    "{n} верных подряд. Не сбавляй темп."
  ],
  proud: ["Четыре подряд. Я почти горжусь тобой. Почти.", "Серия, достойная легенды. Продолжай."],
  rankUp: [
    "Новый ранг: {rank}! Награды теперь щедрее.",
    "Опа. Ранг {rank}. Рынок, готовься.",
    "{rank} — уже неплохо. Дальше будет интереснее."
  ],
  wrong: [
    "Мимо. Но теперь ты это знаешь.",
    "Рынок учит дорого, а я бесплатно. Прочитай пояснение.",
    "Бывает. Главное понять, почему.",
    "Не в этот раз. Запомни это."
  ],
  wrongFast: ["Слишком быстро нажал. Рынок наказывает за спешку.", "Поспешил. Читай варианты до конца."],
  wrongAgain: ["Ничего, следующий возьмём.", "Выдыхай. Сейчас отыграемся."],
  poke: ["Эй! Я вообще‑то работаю.", "Щекотно.", "Это был мой наушник.", "Я не кнопка ответа, если что.", "Хм? Сосредоточься на вопросе."],
  pokeAngry: ["Всё, я обиделась. На три секунды.", "Ещё раз ткнёшь — поставлю тебе минус XP. Шучу. Наверное."],
  error: ["Связь пропала. Нажми ответ ещё раз."],
  resultPerfect: ["Идеально. Ни одной ошибки!", "Безупречно. Ты сегодня в форме."],
  resultGood: ["Сильный результат. Завтра добьём до идеала.", "Хорошо сыграно."],
  resultLow: ["Сегодня рынок победил. Завтра реванш.", "Каждая ошибка делает тебя сильнее."]
};

// Mood label shown above the remark, and the particles each mood emits.
const MOODS = {
  neutral:   { label: "НА СВЯЗИ",   fx: null },
  thinking:  { label: "ДУМАЕТ",     fx: { glyphs: ["?", "…"], count: 3, kind: "float" } },
  happy:     { label: "РАДУЕТСЯ",   fx: { glyphs: ["✦", "+"], count: 6, kind: "burst" } },
  excited:   { label: "В ВОСТОРГЕ", fx: { glyphs: ["✦", "★", "🔥"], count: 12, kind: "burst" } },
  proud:     { label: "ГОРДИТСЯ",   fx: { glyphs: ["♛", "✦", "★"], count: 14, kind: "burst" } },
  sad:       { label: "РАССТРОЕНА", fx: { glyphs: ["·", "|"], count: 8, kind: "rain" } },
  surprised: { label: "УДИВЛЕНА",   fx: { glyphs: ["!"], count: 2, kind: "float" } },
  worried:   { label: "ВОЛНУЕТСЯ",  fx: { glyphs: ["~"], count: 3, kind: "float" } },
  smug:      { label: "ХИТРИТ",     fx: { glyphs: ["♪"], count: 2, kind: "float" } },
  annoyed:   { label: "ВОРЧИТ",     fx: { glyphs: ["#", "%", "!"], count: 4, kind: "burst" } }
};

// Optional per-emotion portraits: put public/assets/avatar/<emotion>.jpg
// (any of the keys in MOODS) and they are used instead of the default close-up.
const customPortraits = {};
Object.keys(MOODS).forEach(emotion => {
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

const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const avatar = {
  typingTimer: null,
  idleTimer: null,
  idleLongTimer: null,
  moodTimer: null,
  questionShownAt: 0,
  correctRun: 0,
  wrongRun: 0,
  wrongTotal: 0,
  pokes: [],
  greeted: false,

  setEmotion(emotion) {
    const stage = $("avatar");
    // Re-trigger the one-shot reaction animation even for the same emotion.
    stage.dataset.emotion = "neutral";
    void stage.offsetWidth;
    stage.dataset.emotion = emotion;
    $("avatar-mood").textContent = MOODS[emotion]?.label || "НА СВЯЗИ";
    applyPortrait($("avatar-frame"), emotion);
    this.particles(emotion);
  },

  // Small glyphs that burst, float up or drizzle down, depending on the mood.
  particles(emotion) {
    const fx = MOODS[emotion]?.fx;
    const layer = $("avatar-fx");
    if (!fx || !layer || reducedMotion) return;
    for (let i = 0; i < fx.count; i++) {
      const p = document.createElement("span");
      p.className = `fx fx-${fx.kind}`;
      p.textContent = pick(fx.glyphs);
      p.style.setProperty("--x", `${fx.kind === "rain" ? Math.random() * 100 : 20 + Math.random() * 60}%`);
      p.style.setProperty("--y", `${fx.kind === "rain" ? -5 : 30 + Math.random() * 25}%`);
      p.style.setProperty("--dx", `${(Math.random() - 0.5) * 160}px`);
      p.style.setProperty("--dy", `${-40 - Math.random() * 90}px`);
      p.style.setProperty("--d", `${Math.random() * 0.35}s`);
      p.style.setProperty("--s", `${0.8 + Math.random() * 0.8}`);
      layer.appendChild(p);
      setTimeout(() => p.remove(), 2200);
    }
  },

  say(text, emotion) {
    if (emotion) this.setEmotion(emotion);
    const el = $("bot-message");
    const stage = $("avatar");
    clearInterval(this.typingTimer);
    el.textContent = "";
    el.classList.add("typing");
    stage.classList.add("speaking");
    const chars = [...text];
    let i = 0;
    this.typingTimer = setInterval(() => {
      el.textContent += chars[i++] || "";
      if (i >= chars.length) {
        clearInterval(this.typingTimer);
        el.classList.remove("typing");
        stage.classList.remove("speaking");
      }
    }, 22);
  },

  // After a strong reaction, drift back to a calm state.
  settle(delay = 3200) {
    clearTimeout(this.moodTimer);
    this.moodTimer = setTimeout(() => {
      const stage = $("avatar");
      if (!["neutral", "thinking"].includes(stage.dataset.emotion)) this.setEmotion("neutral");
    }, delay);
  },

  // If the player goes quiet, the host chimes in, then teases a bit later.
  armIdle() {
    this.disarmIdle();
    this.idleTimer = setTimeout(() => this.say(pick(LINES.idle), "thinking"), 11000);
    this.idleLongTimer = setTimeout(() => this.say(pick(LINES.idleLong), "smug"), 26000);
  },
  disarmIdle() {
    clearTimeout(this.idleTimer);
    clearTimeout(this.idleLongTimer);
  },

  greeting() {
    const h = new Date().getHours();
    const part = h < 5 ? "night" : h < 12 ? "morning" : h < 18 ? "day" : h < 23 ? "evening" : "night";
    return pick(LINES.greet[part]);
  },

  onQuestion(index, total, category) {
    clearTimeout(this.moodTimer);
    this.questionShownAt = Date.now();
    const isLast = index === total - 1;
    let line;
    let emotion = "neutral";

    if (!this.greeted) {
      line = this.greeting();
      this.greeted = true;
    } else if (isLast && this.wrongTotal >= 2) {
      line = pick(LINES.lastWorried);
      emotion = "worried";
    } else if (isLast) {
      line = pick(LINES.last);
      emotion = "surprised";
    } else if (LINES.category[category] && Math.random() < 0.6) {
      line = pick(LINES.category[category]);
    } else {
      line = pick(LINES.next);
    }

    this.say(line, emotion);
    this.armIdle();
  },

  onAnswer(correct, newRank) {
    this.disarmIdle();
    const seconds = (Date.now() - this.questionShownAt) / 1000;

    if (newRank) {
      this.say(pick(LINES.rankUp).replace("{rank}", `${newRank.icon} ${newRank.name}`), "proud");
      this.settle(4500);
      return;
    }

    if (correct) {
      this.correctRun += 1;
      this.wrongRun = 0;
      if (this.correctRun >= 4) this.say(pick(LINES.proud), "proud");
      else if (this.correctRun >= 2) this.say(pick(LINES.streak).replaceAll("{n}", this.correctRun), "excited");
      else if (seconds < 3) this.say(pick(LINES.fast), "surprised");
      else if (seconds > 20) this.say(pick(LINES.slow), "happy");
      else this.say(pick(LINES.correct), "happy");
    } else {
      this.wrongRun += 1;
      this.wrongTotal += 1;
      this.correctRun = 0;
      if (seconds < 2.5) this.say(pick(LINES.wrongFast), "annoyed");
      else this.say(pick(this.wrongRun >= 2 ? LINES.wrongAgain : LINES.wrong), "sad");
    }
    this.settle(4500);
  },

  // Tapping the host: a few quips, then mild annoyance if it keeps happening.
  poke() {
    const now = Date.now();
    this.pokes = this.pokes.filter(t => now - t < 4000);
    this.pokes.push(now);
    tg?.HapticFeedback?.impactOccurred?.("light");
    if (this.pokes.length >= 4) {
      this.pokes = [];
      this.say(pick(LINES.pokeAngry), "annoyed");
    } else {
      this.say(pick(LINES.poke), pick(["surprised", "smug"]));
    }
    this.settle();
  },

  onError() {
    this.say(pick(LINES.error), "worried");
  },

  resultLine(score, total) {
    if (score === total) return { text: pick(LINES.resultPerfect), emotion: "proud" };
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
  if (!response.ok) throw new Error(data.error || "Не удалось выполнить запрос.");
  return data;
}

function showNotice(text) {
  if (tg?.showAlert) return tg.showAlert(text);
  const t = $("toast");
  t.textContent = text;
  t.classList.remove("hidden");
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => t.classList.add("hidden"), 4200);
}

async function init() {
  const session = await api("/api/session", { method: "POST" });

  state.user = session.user;
  state.botUsername = session.botUsername || null;
  $("user-name").textContent = state.user.first_name || "трейдер";

  const daily = await api("/api/daily");
  state.questions = daily.questions;
  state.total = daily.total || daily.questions.length;
  state.score = daily.score;
  state.xp = daily.xp;
  if (daily.rank) state.rank = daily.rank;
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
  $("avatar").onclick = () => avatar.poke();

  document.querySelectorAll(".nav-item").forEach(btn => {
    btn.onclick = () => openScreen(btn.dataset.screen);
  });
  $("top-pill").onclick = () => openScreen("profile-screen");
  $("top-pill").onkeydown = e => { if (e.key === "Enter" || e.key === " ") openScreen("profile-screen"); };
}

function openScreen(id) {
  if (id === "profile-screen") openProfile();
  else showScreen(id);
}

function updateHeader() {
  $("top-rank").textContent = `${state.rank.icon} ${state.rank.name}`;
  $("top-xp").textContent = `${state.xp} XP`;
  $("top-streak").textContent = `${state.streak} 🔥`;
}

function answeredCount() {
  return Object.keys(state.answered).length;
}

function updateHome() {
  const done = answeredCount();
  $("home-count").textContent = String(state.total).padStart(2, "0");
  $("home-score").textContent = `Пройдено ${done} из ${state.total}`;
  $("home-progress").style.width = `${(done / state.total) * 100}%`;
  $("start-btn").firstChild.textContent =
    done === 0 ? "НАЧАТЬ КВЕСТ " : done < state.total ? "ПРОДОЛЖИТЬ КВЕСТ " : "СМОТРЕТЬ ИТОГИ ";
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  $(id).classList.add("active");
  document.body.classList.toggle("quiz-mode", id === "quiz-screen");
  if (id !== "quiz-screen") $("next-dock").classList.add("hidden");
  document.querySelectorAll(".nav-item").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.screen === id);
  });
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
  $("quiz-counter").textContent = `ВОПРОС ${pad(state.current + 1)} / ${pad(state.total)}`;
  $("quiz-progress").style.width = `${(state.current / state.total) * 100}%`;
  $("question-category").textContent = q.category.toUpperCase();
  $("question-text").textContent = q.text;
  avatar.onQuestion(state.current, state.total, q.category);

  const options = $("options");
  options.innerHTML = "";
  $("explanation").className = "explanation";
  $("explanation").textContent = "";
  $("next-dock").classList.add("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });

  q.options.forEach((text, index) => {
    const btn = document.createElement("button");
    btn.className = "option";
    btn.textContent = `${"АБВГДЕ"[index]}  ${text}`;
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
    showNotice(err.message || "Что-то пошло не так. Попробуй ещё раз.");
    return;
  }

  const buttons = [...document.querySelectorAll(".option")];
  buttons[result.correctIndex].classList.add("correct");
  if (!result.correct) buttons[optionIndex].classList.add("wrong");

  state.score = result.score;
  state.xp = result.xp;
  const rankedUp = result.rank && result.rank.index > state.rank.index;
  if (result.rank) state.rank = result.rank;
  state.streak = result.streak;
  if (result.reward) {
    state.reward = result.reward;
    state.rewardClaimed = Boolean(result.rewardClaimed);
  }

  avatar.onAnswer(result.correct, rankedUp ? state.rank : null);
  tg?.HapticFeedback?.notificationOccurred?.(result.correct ? "success" : "error");

  $("explanation").textContent = result.explanation;
  $("explanation").classList.add("show");
  $("next-btn").firstChild.textContent = state.current === state.total - 1 ? "ЗАВЕРШИТЬ КВЕСТ " : "ДАЛЕЕ ";
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
    state.score === state.total ? "Идеально." :
    state.score >= Math.ceil(state.total * 0.6) ? "Хорошая работа." :
    "Есть куда расти.";

  const line = avatar.resultLine(state.score, state.total);
  $("result-avatar").dataset.emotion = line.emotion;
  applyPortrait($("result-avatar").querySelector(".avatar-frame"), line.emotion);
  $("result-quote").textContent = `«${line.text}»`;

  $("result-copy").textContent =
    `Правильных ${plural(state.score, ["ответ", "ответа", "ответов"])}: ${state.score} из ${state.total}.`;

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
  const level = tiers.findIndex(t => t.tier === reward.tier) + 1;

  $("reward-box").dataset.tier = reward.tier || "";
  $("reward-tier").textContent = TIER_LABEL[reward.tier] || reward.tier || "";
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
    next.append("За идеальный результат, например: ");
    const b = document.createElement("b");
    b.textContent = top.example;
    next.append(b);
    next.classList.remove("hidden");
  } else {
    next.classList.add("hidden");
  }
}

// ---------- Profile & reward history ----------

const TIER_GEM = { COMMON: "◇", UNCOMMON: "◆", RARE: "◈", EPIC: "✦", LEGENDARY: "♛" };
const STATUS_LABEL = { claimed: "ЗАБРАНА", pending: "ЗАБРАТЬ", expired: "СГОРЕЛА" };

function formatDay(day) {
  const [y, m, d] = day.split("-").map(Number);
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

async function openProfile() {
  showScreen("profile-screen");
  $("profile-name").textContent = state.user?.first_name || "трейдер";
  let profile;
  try {
    profile = await api("/api/profile");
  } catch (err) {
    showNotice(err.message || "Не удалось загрузить профиль.");
    return;
  }

  $("p-xp").textContent = profile.xp;
  $("p-streak").textContent = profile.streak;
  $("p-best").textContent = profile.bestStreak;
  $("p-quests").textContent = profile.questsCompleted;

  if (profile.rank) {
    state.rank = profile.rank;
    const rank = profile.rank;
    $("p-rank-icon").textContent = rank.icon;
    $("p-rank-name").textContent = rank.name;
    $("p-rank-fill").style.width = `${Math.round(rank.progress * 100)}%`;
    $("p-rank-next").textContent = rank.nextName
      ? `До ранга «${rank.nextName}»: ${rank.xpToNext} XP`
      : "Максимальный ранг достигнут";
    updateHeader();
  }

  const list = $("history-list");
  list.innerHTML = "";
  $("history-empty").classList.toggle("hidden", profile.rewards.length > 0);
  $("history-count").textContent = profile.rewards.length
    ? `забрано ${profile.rewardsClaimed} из ${profile.rewards.length}`
    : "";

  profile.rewards.forEach(r => {
    const item = document.createElement("div");
    item.className = `h-item ${r.status}`;
    item.dataset.tier = r.tier || "";

    const gem = document.createElement("div");
    gem.className = "h-gem";
    gem.textContent = TIER_GEM[r.tier] || "◇";

    const body = document.createElement("div");
    const title = document.createElement("div");
    title.className = "h-title";
    title.textContent = r.title;
    const meta = document.createElement("div");
    meta.className = "h-meta";
    meta.textContent = `${formatDay(r.day)} · ${r.score} из ${r.total} · ${(TIER_LABEL[r.tier] || "").toLowerCase()}`;
    body.append(title, meta);

    const status = document.createElement(r.status === "pending" ? "button" : "span");
    status.className = `h-status ${r.status}`;
    status.textContent = STATUS_LABEL[r.status] || r.status;
    if (r.status === "pending") status.onclick = claimReward;

    item.append(gem, body, status);
    list.appendChild(item);
  });
}

function claimReward() {
  if (!state.botUsername) {
    showNotice("Не удалось открыть чат с ботом. Попробуй чуть позже.");
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
  const box = document.createElement("div");
  box.style.cssText = "color:#fff;font-family:Inter,sans-serif;padding:30px;background:#080b0d;min-height:100vh";
  box.innerHTML = `<h2>Ledger Quest</h2><p style="color:#9aa">Не удалось запустить приложение. Закрой его и открой снова.</p><p style="color:#f77;font-size:12px"></p>`;
  box.lastElementChild.textContent = err.message;
  document.body.replaceChildren(box);
});
