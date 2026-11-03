# Sniper Bot

A Discord bot that automatically bans people who join your server with a username or display name on your server's ban list

## Setup

1. Copy `.env.example` to a new file called `.env` and put your bot token in it:
   ```
   DISCORD_TOKEN=token
   ```
2. In the [Discord Developer Portal](https://discord.com/developers/applications), open your bot, go to **Bot**, and under **Privileged Gateway Intents** turn on **Server Members Intent** and **Message Content Intent**, then save.
3. Install dependencies:
   ```
   npm install
   ```
4. Start the bot:
   ```
   node bot.js
   ```