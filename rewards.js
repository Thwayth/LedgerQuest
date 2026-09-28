// Rewards for finishing the daily quest, by number of correct answers.
// The better the result, the rarer the reward.
//
// Each tier has several possible rewards (variants) so the same score
// doesn't always hand out the exact same prize. One is picked per player
// per day with a seeded random pick, so it's stable if they reopen the
// app the same day, but varies day to day and between players.
//
// To add/edit a reward, edit its variant here. Titles must stay unique
// across the whole file — a claimed/history reward is looked up by title.

export const REWARD_TIERS = [
  // 0 correct answers: no reward.
  null,
  {
    score: 1,
    tier: "COMMON",
    variants: [
      {
        title: "Гайд «5 ошибок, которые сливают депозит»",
        note: "Короткая шпаргалка от команды: где новички теряют деньги чаще всего."
      },
      {
        title: "Чек-лист «Как проверить монету за 5 минут перед покупкой»",
        note: "Что смотреть в первую очередь, чтобы не купить пустышку."
      },
      {
        title: "Мини-гайд «Как выставить стоп-лосс, чтобы он не выбивал зря»",
        note: "Простая схема расчёта стопа под волатильность актива."
      },
      {
        title: "Подборка «3 бесплатных инструмента для анализа рынка»",
        note: "Сервисы, которыми пользуется сама команда."
      }
    ]
  },
  {
    score: 2,
    tier: "UNCOMMON",
    variants: [
      {
        title: "Разбор твоей монеты от аналитика",
        note: "Назови любую монету: разберём уровни, объёмы и сценарии."
      },
      {
        title: "Экспресс-разбор твоего портфеля",
        note: "Пришли список активов — укажем, что стоит пересмотреть."
      },
      {
        title: "Персональный разбор графика на выбор",
        note: "Любой тайфрейм, любая пара — покажем, что видит аналитик."
      },
      {
        title: "Разбор твоей последней сделки",
        note: "Разберём вход, стоп и выход — покажем, что можно было сделать лучше."
      }
    ]
  },
  {
    score: 3,
    tier: "RARE",
    variants: [
      {
        title: "Доступ в закрытое комьюнити на 7 дней",
        note: "Чат с командой, разборы рынка и идеи раньше остальных."
      },
      {
        title: "Приватный чат с аналитиками на 7 дней",
        note: "Личные вопросы напрямую команде, без очереди."
      },
      {
        title: "VIP-доступ к утренним разборам рынка на неделю",
        note: "Короткий разбор ситуации на рынке каждое утро."
      },
      {
        title: "Место в закрытом вебинаре по риск-менеджменту",
        note: "Разбор реальных кейсов и ответы на вопросы вживую."
      }
    ]
  },
  {
    score: 4,
    tier: "EPIC",
    variants: [
      {
        title: "Сделка на 5X",
        note: "Готовый сетап от команды: вход, стоп и цели."
      },
      {
        title: "Точка входа + два тейк-профита от аналитика",
        note: "Конкретный уровень входа и два ориентира на фиксацию прибыли."
      },
      {
        title: "Разбор сделки с плечом от команды",
        note: "Готовый план: размер позиции, плечо, стоп — под твой депозит."
      },
      {
        title: "Приоритетный сигнал недели",
        note: "Одна из лучших идей команды на этой неделе — до остальных подписчиков."
      }
    ]
  },
  {
    score: 5,
    tier: "LEGENDARY",
    variants: [
      {
        title: "Сигнал на 300%",
        note: "Главный сигнал дня с целью +300% — только за идеальный результат."
      },
      {
        title: "Инсайдерский сигнал недели",
        note: "То, что команда обычно не публикует — только для лучших игроков дня."
      },
      {
        title: "Персональная стратегия под твой депозит",
        note: "Аналитик распишет план под твой капитал и цели на месяц."
      },
      {
        title: "VIP-статус на месяц + все сигналы без задержки",
        note: "Полный доступ к сигналам и разборам команды на 30 дней."
      }
    ]
  }
];

const MAX_TIER = REWARD_TIERS.length - 1;

// Small deterministic PRNG (mulberry32), same approach as questions.js —
// duplicated here so this file has no dependency on it.
function seededRandom(seedStr) {
  let h = 2166136261;
  for (const ch of seedStr) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Maps a result to a tier level (1..5). If a quest has more or fewer than
// 5 questions, the score is scaled to the 0–5 range. 0 correct -> 0 (no reward).
export function levelForScore(score, total) {
  if (!total || score <= 0) return 0;
  return Math.max(1, Math.min(MAX_TIER, Math.round((score / total) * MAX_TIER)));
}

// Picks one variant for a tier level. With a seed, the pick is stable for
// that seed (e.g. same player + same day) but effectively random across
// different seeds — without one, it's plain random.
export function rewardForLevel(level, seed) {
  const tierDef = REWARD_TIERS[level];
  if (!tierDef) return null;
  const rand = seed ? seededRandom(`ledger-quest-reward:${seed}`) : Math.random;
  const variant = tierDef.variants[Math.floor(rand() * tierDef.variants.length)] || tierDef.variants[0];
  return { score: tierDef.score, tier: tierDef.tier, title: variant.title, note: variant.note };
}

// Picks the reward for a result (score/total), optionally seeded so the
// same player gets the same reward if they reload the app the same day.
export function rewardForScore(score, total, seed) {
  const level = levelForScore(score, total);
  if (level <= 0) return null;
  return rewardForLevel(level, seed);
}

// Full reward info (tier, note) for a saved reward title — searches every
// variant. Older saved rewards that no longer match any variant still show,
// without a tier.
export function rewardInfo(title) {
  if (!title) return null;
  for (const tierDef of REWARD_TIERS) {
    if (!tierDef) continue;
    const variant = tierDef.variants.find(v => v.title === title);
    if (variant) return { tier: tierDef.tier, title: variant.title, note: variant.note };
  }
  return { tier: null, title, note: "" };
}

// One representative title per tier, for UI that needs to show an example
// of what a tier looks like without committing to which variant is earned.
export function exampleTitle(tier) {
  const tierDef = REWARD_TIERS.find(t => t?.tier === tier);
  return tierDef?.variants[0]?.title || "";
}
