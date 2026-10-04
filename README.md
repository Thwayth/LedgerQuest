# Ledger Quest

Telegram Mini App MVP with:
- Telegram bot
- Daily 5-question quest, random per player, from a question pool
- XP and streak
- Premium fintech UI
- Ledger Bot character
- Telegram menu button
- Demo mode in a normal browser
- **Arena** tab: Angry-Birds-style mini-game with a server-side deposit bonus

## 1. Create the bot
Open @BotFather in Telegram:
1. `/newbot`
2. Choose name: `Ledger Quest`
3. Choose a username ending in `bot`
4. Copy the token.

Never publish the token to GitHub.

## 2. Local run
Install Node.js 20+.

```bash
npm install
```

Copy `.env.example` to `.env` and fill at least:
- BOT_TOKEN
- WEB_APP_URL

All other variables are optional and explained in `.env.example`.

For local browser testing, you can use a temporary HTTPS tunnel. Telegram Mini Apps require an HTTPS URL.

Then:

```bash
npm start
```

## 3. Deploy
Recommended first MVP deployment: Render Web Service.

Build command:
```bash
npm install
```

Start command:
```bash
npm start
```

Environment variables:
```text
BOT_TOKEN=your_bot_token
WEB_APP_URL=https://your-render-service.onrender.com
PORT=10000
DATABASE_URL=postgresql://...
ADMIN_CHAT_ID=your_numeric_telegram_id
ADMIN_USERNAME=your_username
QUEST_TZ=Europe/Kyiv
ALLOW_DEMO=false
```

After deployment, open the bot and press `/start`.

## Database
Set `DATABASE_URL` to any PostgreSQL database (Supabase, Render Postgres, ...).
The `lq_users` table is created automatically on startup.

Without `DATABASE_URL` the app still runs, but keeps progress in memory:
XP, streaks and unclaimed rewards are lost on every restart or redeploy.
Use that only for local testing.

## Security
- The server identifies users only from Telegram `initData`, validated with the bot token
  and rejected when older than `INIT_DATA_MAX_AGE_SECONDS`. User ids sent by the client are ignored.
- Each reward can be claimed once; the admin is notified once per reward.
- Browser demo users get separate `demo-...` ids and can't affect real Telegram users.
  Set `ALLOW_DEMO=false` in production to disable demo mode completely.

## Questions
Questions live in `questions.js`. Every day each player gets their own random
`QUESTIONS_PER_DAY` questions from the pool, with shuffled answer options.
The set stays the same if the player reopens the app on the same day.
Add more questions to the pool to make the rotation less repetitive.

## Rewards
The reward tier depends on the number of correct answers (0 correct = no reward):

| Correct | Tier |
|---|---|
| 1 | COMMON |
| 2 | UNCOMMON |
| 3 | RARE |
| 4 | EPIC |
| 5 | LEGENDARY |

Each tier has several possible rewards (`variants` in `rewards.js`), so the
same score doesn't always hand out the exact same prize — one variant is
picked per player per day (seeded by day + user id, so it's stable if they
reopen the app the same day, but varies day to day and between players).
Add/edit variants in `rewards.js`; titles must stay unique across the file.

## Ranks
XP now means something: it moves the player up a rank, shown instead of a
bare number in the top pill and on the profile screen (with a progress bar
to the next rank).

| Rank | XP |
|---|---|
| 🌱 Новичок | 0 |
| 📈 Трейдер | 150 |
| 🧠 Аналитик | 400 |
| 🎯 Профи | 800 |
| 🐋 Кит | 1500 |

From **Аналитик** up, a strong result also nudges the reward a tier higher
(e.g. an Аналитик who gets 4/5 correct receives the LEGENDARY reward instead
of EPIC). Higher ranks get a bigger nudge and it kicks in at a lower score —
see `boostForRank` in `ranks.js`. Edit rank names/thresholds in `RANKS`,
same file.

## Render free plan: cold starts
On the free plan Render puts the service to sleep after 15 minutes without traffic.
The next visitor sees Render's "application loading" screen for ~30–60 seconds,
and the bot doesn't answer while the service sleeps.

Options:
- upgrade the service to a paid instance (no sleep), or
- ping `https://<your-service>.onrender.com/healthz` every 10 minutes with a free
  uptime monitor (cron-job.org, UptimeRobot). One always-on service fits into
  the free 750 instance hours per month.

## Avatar emotions
During the quiz the host reacts with emotions: `neutral`, `thinking`, `happy`,
`excited`, `sad`, `surprised`. By default it uses a close-up of `ledger-bot.png`
and shows the mood with the headphone LED color, glow and motion.

To give the host real facial expressions, add square portraits (same framing,
~720×720) to `public/assets/avatar/<emotion>.jpg`, e.g. `happy.jpg`, `sad.jpg`.
Any file that exists is picked up automatically; missing ones fall back to the default.
Remarks are in `LINES` in `public/app.js`.

## Arena (mini-game tab)
The **АРЕНА** tab in the bottom nav opens the arena mini-game: 8 levels in
4 difficulty tiers, knock down neon towers with a slingshot and collect the
crypto coins. Stars per level, and each star adds a deposit bonus.

- Game: `public/arena/index.html` (single file, Planck.js from the CDN) and
  `public/arena/api.js`; served at `/arena/` and loaded into the tab in a frame.
- Server: `arena-api.js`, mounted by `server.js` at `/api/game/*`
  (`level-start`, `level-complete`, `profile`).
- The bonus is computed **only on the server**: it verifies the Telegram
  `initData` signature, checks the result is plausible (single-use run,
  minimum time, shot/coin counts, level unlocked, rate limit), works out the
  stars itself and credits only new stars: easy 0.1% / medium 0.2% /
  hard 0.35% / expert 0.5% per star, capped at 5.0% in total.
- Storage: table `lq_arena_players` in the same `DATABASE_URL` database
  (created automatically); in memory without it.
- Outside Telegram (demo mode) the game is playable, but no bonus is credited.
- How the bonus is applied to a deposit is described to players in the game
  (`BONUS_TERMS` in `public/arena/index.html`) — confirm that wording.
- Tests: `npm run test:arena`. Standalone dev server for the game only:
  `BOT_TOKEN=123:abc npm run arena` → http://localhost:3000/arena/

## Next version
- admin panel
- categories and difficulty
- achievements
- leaderboard
- referral system
- Telegram Stars / rewards if needed
- push reminder for the daily quest
