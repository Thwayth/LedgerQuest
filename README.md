# Ledger Quest

Telegram Mini App MVP with:
- Telegram bot
- Daily 5-question quest, rotated every day from a question pool
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
Questions live in `questions.js`. Every day `QUESTIONS_PER_DAY` questions are picked
from the pool and their answer options are shuffled, the same for everyone that day.
Add more questions to the pool to make the rotation less repetitive.

## Next version
- admin panel
- categories and difficulty
- achievements
- leaderboard
- referral system
- Telegram Stars / rewards if needed
- push reminder for the daily quest
