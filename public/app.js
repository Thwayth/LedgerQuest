const tg = window.Telegram?.WebApp || null;

if (tg) {
  tg.ready();
  tg.expand();
  try {
    tg.setHeaderColor("#080b0d");
    tg.setBackgroundColor("#080b0d");
  } catch {}
}

const state = {
  user: null,
  botUsername: null,
  questions: [],
  current: 0,
  score: 0,
  xp: 0,
  streak: 0,
  answered: {},
  reward: null
};

const $ = id => document.getElementById(id);

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function init() {
  const session = await api("/api/session", {
    method: "POST",
    body: JSON.stringify({ initData: tg?.initData || "" })
  });

  state.user = session.user;
  state.botUsername = session.botUsername || null;
  $("user-name").textContent = state.user.first_name || "Quest";

  const daily = await api(`/api/daily?userId=${encodeURIComponent(state.user.id)}`);
  state.questions = daily.questions;
  state.score = daily.score;
  state.xp = daily.xp;
  state.streak = daily.streak;
  state.reward = daily.reward || null;

  // Rebuild which questions are already answered today,
  // so reopening the app doesn't restart from question 1.
  state.answered = {};
  (daily.answered || []).forEach(id => {
    state.answered[id] = true;
  });

  updateHeader();
  updateHome();

  $("start-btn").onclick = startQuest;
  $("back-btn").onclick = () => showScreen("home-screen");
  $("next-btn").onclick = nextQuestion;
  $("home-btn").onclick = () => showScreen("home-screen");
  $("claim-btn").onclick = claimReward;

  document.querySelectorAll(".nav-item").forEach(btn => {
    btn.onclick = () => {
      if (btn.id === "stats-nav") {
        tg?.showAlert?.(`XP: ${state.xp}\nStreak: ${state.streak} days\nToday's score: ${state.score}/5`);
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

function updateHome() {
  $("home-score").textContent = `${state.score} / 5 completed`;
  $("home-progress").style.width = `${(state.score / 5) * 100}%`;
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  $(id).classList.add("active");
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

  $("quiz-counter").textContent = `${String(state.current + 1).padStart(2,"0")} / 05`;
  $("quiz-progress").style.width = `${(state.current / 5) * 100}%`;
  $("question-category").textContent = q.category.toUpperCase();
  $("question-text").textContent = q.text;
  $("bot-message").textContent =
    state.current === 0 ? "Let's see what you know." :
    state.current === 4 ? "One last move. Think carefully." :
    "Stay sharp. The details matter.";

  const options = $("options");
  options.innerHTML = "";
  $("explanation").className = "explanation";
  $("explanation").textContent = "";
  $("next-btn").classList.add("hidden");

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

  const result = await api("/api/answer", {
    method: "POST",
    body: JSON.stringify({
      userId: state.user.id,
      questionId: q.id,
      optionIndex
    })
  });

  const buttons = [...document.querySelectorAll(".option")];
  buttons[result.correctIndex].classList.add("correct");
  if (!result.correct) buttons[optionIndex].classList.add("wrong");

  state.score = result.score;
  state.xp = result.xp;
  state.streak = result.streak;
  if (result.reward) state.reward = result.reward;

  $("bot-message").textContent = result.correct
    ? "Correct. Keep going."
    : "Not this time. Learn from it and continue.";

  $("explanation").textContent = result.explanation;
  $("explanation").classList.add("show");
  $("next-btn").classList.remove("hidden");
  $("next-btn").textContent = state.current === 4 ? "FINISH QUEST  →" : "CONTINUE  →";
  updateHeader();
}

function nextQuestion() {
  state.current += 1;
  if (state.current >= state.questions.length) showResult();
  else renderQuestion();
}

function showResult() {
  $("result-score").textContent = `${state.score}/5`;
  $("result-xp").textContent = `+${state.score * 10}`;
  $("result-streak").textContent = state.streak;
  $("result-title").textContent =
    state.score === 5 ? "Perfect run." :
    state.score >= 3 ? "Solid work." :
    "Keep building.";

  $("result-copy").textContent =
    `You completed today's Ledger Quest with ${state.score} correct answer${state.score === 1 ? "" : "s"}.`;

  if (state.reward) {
    $("reward-box").classList.remove("hidden");
    $("reward-title").textContent = state.reward;
    $("claim-btn").classList.remove("hidden");
  } else {
    $("reward-box").classList.add("hidden");
    $("claim-btn").classList.add("hidden");
  }

  updateHome();
  updateHeader();
  showScreen("result-screen");
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
