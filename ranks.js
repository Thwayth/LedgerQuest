// Ranks turn a raw XP counter into progress that means something.
// Higher ranks also make top rewards a bit more likely for a strong result
// (see boostedRewardForScore below).

import { REWARD_TIERS, levelForScore, rewardForLevel } from "./rewards.js";

export const RANKS = [
  { name: "Новичок", icon: "🌱", min: 0 },
  { name: "Трейдер", icon: "📈", min: 150 },
  { name: "Аналитик", icon: "🧠", min: 400 },
  { name: "Профи", icon: "🎯", min: 800 },
  { name: "Кит", icon: "🐋", min: 1500 }
];

// Resolves a rank from total XP, plus progress toward the next one.
export function rankForXp(xp) {
  let index = 0;
  for (let i = 0; i < RANKS.length; i++) {
    if (xp >= RANKS[i].min) index = i;
  }
  const current = RANKS[index];
  const next = RANKS[index + 1] || null;
  const progress = next
    ? Math.max(0, Math.min(1, (xp - current.min) / (next.min - current.min)))
    : 1;

  return {
    index,
    name: current.name,
    icon: current.icon,
    minXp: current.min,
    nextName: next ? next.name : null,
    nextXp: next ? next.min : null,
    xpToNext: next ? Math.max(0, next.min - xp) : 0,
    progress
  };
}

// From "Аналитик" up, a strong result nudges the reward up the ladder —
// e.g. an Аналитик with 4/5 correct gets the LEGENDARY reward instead of EPIC.
// Bigger rank, bigger nudge; a weak result still gets no boost at all.
function boostForRank(rankIndex, ratio) {
  if (rankIndex === 2) return ratio >= 0.8 ? 1 : 0;
  if (rankIndex === 3) return ratio >= 0.8 ? 2 : ratio >= 0.6 ? 1 : 0;
  if (rankIndex === 4) return ratio >= 0.8 ? 3 : ratio >= 0.6 ? 2 : ratio > 0 ? 1 : 0;
  return 0;
}

export function boostedRewardForScore(score, total, rankIndex, seed) {
  const level = levelForScore(score, total);
  if (level <= 0) return null;

  const ratio = total ? score / total : 0;
  const boost = boostForRank(rankIndex, ratio);
  const boostedLevel = Math.min(REWARD_TIERS.length - 1, level + boost);
  return rewardForLevel(boostedLevel, seed);
}
