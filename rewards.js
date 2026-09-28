// Rewards for finishing the daily quest, by number of correct answers.
// The better the result, the rarer the reward.
//
// To change a reward, edit its title/note here. The title is what the
// player sees, what the bot shows and what the admin gets in the notification.
// Keep titles unique — the saved reward is looked up by its title.

export const REWARD_TIERS = [
  // 0 correct answers: no reward.
  null,
  {
    score: 1,
    tier: "COMMON",
    title: "Гайд «5 ошибок, которые сливают депозит»",
    note: "Короткая шпаргалка от команды: где новички теряют деньги чаще всего."
  },
  {
    score: 2,
    tier: "UNCOMMON",
    title: "Разбор твоей монеты от аналитика",
    note: "Назови любую монету: разберём уровни, объёмы и сценарии."
  },
  {
    score: 3,
    tier: "RARE",
    title: "Доступ в закрытое комьюнити на 7 дней",
    note: "Чат с командой, разборы рынка и идеи раньше остальных."
  },
  {
    score: 4,
    tier: "EPIC",
    title: "Сделка на 5X",
    note: "Готовый сетап от команды: вход, стоп и цели."
  },
  {
    score: 5,
    tier: "LEGENDARY",
    title: "Сигнал на 300%",
    note: "Главный сигнал дня с целью +300% — только за идеальный результат."
  }
];

const MAX_TIER = REWARD_TIERS.length - 1;

// Picks the reward for a result. If a quest has more or fewer than 5
// questions, the score is scaled to the 0–5 range.
export function rewardForScore(score, total) {
  if (!total || score <= 0) return null;
  const level = Math.max(1, Math.min(MAX_TIER, Math.round((score / total) * MAX_TIER)));
  return REWARD_TIERS[level];
}

// Full reward info (tier, note) for a saved reward title.
// Older saved rewards that aren't in the table still show, without a tier.
export function rewardInfo(title) {
  if (!title) return null;
  return REWARD_TIERS.find(r => r?.title === title) || { tier: null, title, note: "" };
}
