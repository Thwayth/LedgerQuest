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
    lastCompletedDate: null,
    day: null,
    answers: {},
    score: 0,
    reward: null,
    rewardDay: null,
    rewardClaimed: false
  };
}

class MemoryStore {
  constructor() {
    this.users = new Map();
    this.kind = "memory";
  }
  async init() {}
  async getUser(id) {
    const existing = this.users.get(id);
    return existing ? structuredClone(existing) : emptyUser(id);
  }
  async saveUser(user) {
    this.users.set(user.id, structuredClone(user));
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
  }

  async getUser(id) {
    const { rows } = await this.pool.query("SELECT * FROM lq_users WHERE id = $1", [id]);
    if (!rows.length) return emptyUser(id);
    const r = rows[0];
    return {
      id: r.id,
      xp: r.xp,
      streak: r.streak,
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
         (id, xp, streak, last_completed_date, day, answers, score, reward, reward_day, reward_claimed, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
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
         updated_at = NOW()`,
      [
        u.id, u.xp, u.streak, u.lastCompletedDate, u.day,
        JSON.stringify(u.answers || {}), u.score,
        u.reward, u.rewardDay, u.rewardClaimed
      ]
    );
  }
}

export function createStore() {
  const url = process.env.DATABASE_URL;
  return url ? new PostgresStore(url) : new MemoryStore();
}
