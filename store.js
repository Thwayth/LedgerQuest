// User progress storage.
// If DATABASE_URL is set (Supabase, Render Postgres, any PostgreSQL),
// progress is stored there and survives restarts/redeploys.
// Otherwise it falls back to in-memory storage (fine for local testing only).

import pg from "pg";

function emptyUser(id) {
  return {
    id,
    xp: 0,
    streak: 0,
    bestStreak: 0,
    questsCompleted: 0,
    lastCompletedDate: null,
    day: null,
    answers: {},
    score: 0,
    reward: null,
    rewardDay: null,
    rewardClaimed: false
  };
}

// Reward history entries:
// { day, title, tier, score, total, status: "pending" | "claimed" | "expired", createdAt, claimedAt }

class MemoryStore {
  constructor() {
    this.users = new Map();
    this.rewards = new Map();
    this.kind = "memory";
  }
  async init() {}
  async getUser(id) {
    const existing = this.users.get(id);
    return existing ? { ...emptyUser(id), ...structuredClone(existing) } : emptyUser(id);
  }
  async saveUser(user) {
    this.users.set(user.id, structuredClone(user));
  }

  async addReward(userId, entry) {
    const list = this.rewards.get(userId) || [];
    // A newer reward replaces any older one that was never claimed.
    list.forEach(r => { if (r.status === "pending") r.status = "expired"; });
    list.push({ ...entry, status: "pending", createdAt: new Date().toISOString(), claimedAt: null });
    this.rewards.set(userId, list);
  }
  async markRewardClaimed(userId, day) {
    const r = (this.rewards.get(userId) || []).find(x => x.day === day && x.status === "pending");
    if (r) {
      r.status = "claimed";
      r.claimedAt = new Date().toISOString();
    }
  }
  async listRewards(userId, limit = 50) {
    return structuredClone((this.rewards.get(userId) || []).slice(-limit).reverse());
  }
}

class PostgresStore {
  constructor(connectionString) {
    this.kind = "postgres";
    const needsSsl = !/localhost|127\.0\.0\.1/.test(connectionString);
    this.pool = new pg.Pool({
      connectionString,
      ssl: needsSsl ? { rejectUnauthorized: false } : false
    });
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS lq_users (
        id                  TEXT PRIMARY KEY,
        xp                  INTEGER NOT NULL DEFAULT 0,
        streak              INTEGER NOT NULL DEFAULT 0,
        last_completed_date TEXT,
        day                 TEXT,
        answers             JSONB NOT NULL DEFAULT '{}'::jsonb,
        score               INTEGER NOT NULL DEFAULT 0,
        reward              TEXT,
        reward_day          TEXT,
        reward_claimed      BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Columns added after the first release.
    await this.pool.query(`
      ALTER TABLE lq_users
        ADD COLUMN IF NOT EXISTS best_streak      INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS quests_completed INTEGER NOT NULL DEFAULT 0
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS lq_rewards (
        id         BIGSERIAL PRIMARY KEY,
        user_id    TEXT NOT NULL,
        day        TEXT NOT NULL,
        title      TEXT NOT NULL,
        tier       TEXT,
        score      INTEGER NOT NULL,
        total      INTEGER NOT NULL,
        status     TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        claimed_at TIMESTAMPTZ
      )
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS lq_rewards_user_idx ON lq_rewards (user_id, id DESC)`);
  }

  async getUser(id) {
    const { rows } = await this.pool.query("SELECT * FROM lq_users WHERE id = $1", [id]);
    if (!rows.length) return emptyUser(id);
    const r = rows[0];
    return {
      id: r.id,
      xp: r.xp,
      streak: r.streak,
      bestStreak: r.best_streak,
      questsCompleted: r.quests_completed,
      lastCompletedDate: r.last_completed_date,
      day: r.day,
      answers: r.answers || {},
      score: r.score,
      reward: r.reward,
      rewardDay: r.reward_day,
      rewardClaimed: r.reward_claimed
    };
  }

  async saveUser(u) {
    await this.pool.query(
      `INSERT INTO lq_users
         (id, xp, streak, last_completed_date, day, answers, score, reward, reward_day, reward_claimed,
          best_streak, quests_completed, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
       ON CONFLICT (id) DO UPDATE SET
         xp = EXCLUDED.xp,
         streak = EXCLUDED.streak,
         last_completed_date = EXCLUDED.last_completed_date,
         day = EXCLUDED.day,
         answers = EXCLUDED.answers,
         score = EXCLUDED.score,
         reward = EXCLUDED.reward,
         reward_day = EXCLUDED.reward_day,
         reward_claimed = EXCLUDED.reward_claimed,
         best_streak = EXCLUDED.best_streak,
         quests_completed = EXCLUDED.quests_completed,
         updated_at = NOW()`,
      [
        u.id, u.xp, u.streak, u.lastCompletedDate, u.day,
        JSON.stringify(u.answers || {}), u.score,
        u.reward, u.rewardDay, u.rewardClaimed,
        u.bestStreak || 0, u.questsCompleted || 0
      ]
    );
  }

  async addReward(userId, entry) {
    // A newer reward replaces any older one that was never claimed.
    await this.pool.query(
      `UPDATE lq_rewards SET status = 'expired' WHERE user_id = $1 AND status = 'pending'`,
      [userId]
    );
    await this.pool.query(
      `INSERT INTO lq_rewards (user_id, day, title, tier, score, total) VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId, entry.day, entry.title, entry.tier, entry.score, entry.total]
    );
  }

  async markRewardClaimed(userId, day) {
    await this.pool.query(
      `UPDATE lq_rewards SET status = 'claimed', claimed_at = NOW()
       WHERE user_id = $1 AND day = $2 AND status = 'pending'`,
      [userId, day]
    );
  }

  async listRewards(userId, limit = 50) {
    const { rows } = await this.pool.query(
      `SELECT day, title, tier, score, total, status, created_at, claimed_at
       FROM lq_rewards WHERE user_id = $1 ORDER BY id DESC LIMIT $2`,
      [userId, limit]
    );
    return rows.map(r => ({
      day: r.day,
      title: r.title,
      tier: r.tier,
      score: r.score,
      total: r.total,
      status: r.status,
      createdAt: r.created_at,
      claimedAt: r.claimed_at
    }));
  }
}

export function createStore() {
  const url = process.env.DATABASE_URL;
  return url ? new PostgresStore(url) : new MemoryStore();
}
