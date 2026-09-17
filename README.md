# TelePulse - Multi-Bot Telegram Management Platform

A modern, full-featured web platform to manage multiple Telegram bots from a unified dashboard. Features Live 1-on-1 Chat (WhatsApp Web style), Custom Welcome Flows (/start), Mass Broadcasting with safe rate-limiting, and Audience Management.

---

## 🌟 Features
- **Multi-Bot Management**: Connect unlimited Telegram bots via tokens from `@BotFather`.
- **Live 1-on-1 Chat**: Reply directly to bot users in real-time from the web dashboard.
- **Welcome Message Builder**: Set custom welcome text, photo headers, and clickable inline buttons.
- **Mass Broadcast Engine**: Send campaigns to all subscribers with automatic throttling (~25 msg/sec).
- **SendPulse Migration / Audience Import**: One-click import for SendPulse CSV / Telegram user lists.
- **Dual Database Support**: SQLite for local PC usage, PostgreSQL for 100% permanent 24/7 cloud hosting.

---

## 🚀 How to Deploy on Render (100% Free 24/7 Hosting)

1. **Create Free PostgreSQL Database on Render**:
   - Go to [dashboard.render.com](https://dashboard.render.com) -> **New +** -> **PostgreSQL**.
   - Give it a name (e.g. `telebot-db`) and click **Create Database**.
   - Copy the **Internal Database URL** (or External Database URL).

2. **Deploy the Web Service on Render**:
   - In Render dashboard, click **New +** -> **Web Service**.
   - Connect your GitHub repository: `ramankishore0997/razr-telegram-bot`.
   - Settings:
     - **Runtime**: `Node`
     - **Build Command**: `npm install`
     - **Start Command**: `node server.js`
   - Under **Environment Variables**:
     - Add `DATABASE_URL` = *(paste the PostgreSQL Database URL from step 1)*
     - Add `NODE_ENV` = `production`
   - Click **Deploy Web Service**.

Your Telegram Bot Manager will now be live 24/7 with permanent cloud database storage!

---

## 💻 How to Run Locally on PC

```bash
# 1. Install dependencies
npm install

# 2. Start server
npm start
```
Open [http://localhost:3000](http://localhost:3000) in your browser.
