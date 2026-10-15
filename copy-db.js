/* One-off: copies players into the new Whale Union Games database.
   Runs only when TARGET_DATABASE_URL is set; every minute it upserts
   users, rewards and arena players into the new tables (wu_*), so the
   new database stays current until this service is switched off. */
import pg from "pg";

const PAIRS = [
  { from: "lq_users", to: "wu_users", key: "id" },
  { from: "lq_rewards", to: "wu_rewards", key: "id" },
  { from: "lq_arena_players", to: "wu_arena_players", key: "id" }
];

const DDL = [
  `CREATE TABLE IF NOT EXISTS wu_users (
     id TEXT PRIMARY KEY, xp INTEGER NOT NULL DEFAULT 0, streak INTEGER NOT NULL DEFAULT 0,
     last_completed_date TEXT, day TEXT, answers JSONB NOT NULL DEFAULT '{}'::jsonb,
     score INTEGER NOT NULL DEFAULT 0, reward TEXT, reward_day TEXT,
     reward_claimed BOOLEAN NOT NULL DEFAULT FALSE, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     best_streak INTEGER NOT NULL DEFAULT 0, quests_completed INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS wu_rewards (
     id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL, day TEXT NOT NULL, title TEXT NOT NULL,
     tier TEXT, score INTEGER NOT NULL, total INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), claimed_at TIMESTAMPTZ)`,
  `CREATE INDEX IF NOT EXISTS wu_rewards_user_idx ON wu_rewards (user_id, id DESC)`,
  `CREATE TABLE IF NOT EXISTS wu_arena_players (
     id TEXT PRIMARY KEY, bonus_bp INTEGER NOT NULL DEFAULT 0, data JSONB NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
];

async function copyOnce(src, dst) {
  for (const d of DDL) await dst.query(d);
  const report = [];
  for (const { from, to, key } of PAIRS) {
    const exists = await src.query("SELECT to_regclass($1) AS t", [from]);
    if (!exists.rows[0].t) { report.push(`${from}: missing`); continue; }
    const { rows } = await src.query(`SELECT * FROM ${from}`);
    for (const row of rows) {
      const cols = Object.keys(row);
      const vals = cols.map(c => (row[c] !== null && typeof row[c] === "object" && !(row[c] instanceof Date)) ? JSON.stringify(row[c]) : row[c]);
      const set = cols.filter(c => c !== key).map(c => `${c} = EXCLUDED.${c}`).join(", ");
      await dst.query(
        `INSERT INTO ${to} (${cols.join(",")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(",")})
         ON CONFLICT (${key}) DO UPDATE SET ${set}`, vals);
    }
    report.push(`${from}→${to}: ${rows.length}`);
  }
  await dst.query(`SELECT setval(pg_get_serial_sequence('wu_rewards','id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM wu_rewards), 1))`);
  return report.join(", ");
}

export function startCopyToNewDb() {
  const target = process.env.TARGET_DATABASE_URL;
  const source = process.env.DATABASE_URL;
  if (!target || !source) return;
  const ssl = url => (/localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false });
  const src = new pg.Pool({ connectionString: source, ssl: ssl(source), max: 2 });
  const dst = new pg.Pool({ connectionString: target, ssl: ssl(target), max: 2 });
  const run = async () => {
    try { console.log(`[copy-db] ${new Date().toISOString()} ${await copyOnce(src, dst)}`); }
    catch (e) { console.error("[copy-db] failed:", e.message); }
  };
  run();
  setInterval(run, 60000);
}
