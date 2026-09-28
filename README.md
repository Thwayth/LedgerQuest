# Ledger Quest

Telegram Mini App MVP with:
- Telegram bot
- Daily 5-question quest, random per player, from a question pool
- XP and streak
- Premium fintech UI
- Ledger Bot character
- Telegram menu button
- Demo mode in a normal browser

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
The reward depends on the number of correct answers (0 correct = no reward):

| Correct | Tier | Reward |
|---|---|---|
| 1 | COMMON | Гайд «5 ошибок, которые сливают депозит» |
| 2 | UNCOMMON | Разбор твоей монеты от аналитика |
| 3 | RARE | Доступ в закрытое комьюнити на 7 дней |
| 4 | EPIC | Сделка на 5X |
| 5 | LEGENDARY | Сигнал на 300% |

Edit titles and descriptions in `rewards.js`.

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

## Next version
- admin panel
- categories and difficulty
- achievements
- leaderboard
- referral system
- Telegram Stars / rewards if needed
- push reminder for the daily quest
