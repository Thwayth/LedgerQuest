# Ledger Quest

Telegram Mini App MVP with:
- Telegram bot
- Daily 5-question quest
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

Copy `.env.example` to `.env` and fill:
- BOT_TOKEN
- WEB_APP_URL

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
```

After deployment, open the bot and press `/start`.

## Important
The MVP stores progress in memory. It is intentionally simple for the first version. Before a public launch, move users/questions/results to Supabase or PostgreSQL so data survives restarts and redeployments.

## Next version
- Supabase database
- real daily question rotation
- admin panel
- categories and difficulty
- achievements
- leaderboard
- referral system
- Telegram Stars / rewards if needed
- anti-cheat server validation
- push reminder for the daily quest
