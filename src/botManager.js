const { Telegraf, Markup } = require('telegraf');
const db = require('./db');

class BotManager {
  constructor() {
    this.activeBots = new Map(); // botId -> { instance, info }
    this.wsClients = new Set();
  }

  // Register WebSocket client for live updates
  addWsClient(ws) {
    this.wsClients.add(ws);
    ws.on('close', () => this.wsClients.delete(ws));
  }

  // Broadcast WebSocket notification to connected dashboards
  broadcastWs(type, data) {
    const payload = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
    for (const client of this.wsClients) {
      if (client.readyState === 1) { // OPEN
        client.send(payload);
      }
    }
  }

  // Test and validate a token
  async testToken(token) {
    try {
      const testBot = new Telegraf(token);
      const info = await testBot.telegram.getMe();
      return { success: true, info };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // Initialize and start all active bots from the database
  async initAllBots() {
    const bots = await db.all('SELECT * FROM bots WHERE is_active = 1');
    console.log(`Starting ${bots.length} active Telegram bots...`);
    for (const bot of bots) {
      try {
        await this.startBot(bot.id, bot.token);
      } catch (err) {
        console.error(`Error launching bot ${bot.name} (ID ${bot.id}):`, err.message);
      }
    }
  }

  // Start a single bot instance
  async startBot(botId, token) {
    if (this.activeBots.has(botId)) {
      await this.stopBot(botId);
    }

    const botRecord = await db.get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!botRecord) throw new Error('Bot not found in database');

    const bot = new Telegraf(token);

    // Error handler
    bot.catch((err, ctx) => {
      console.error(`Telegram error for bot ID ${botId}:`, err);
    });

    // Helper to get or create subscriber
    const getOrCreateSubscriber = async (from) => {
      const telegramId = String(from.id);
      let sub = await db.get('SELECT * FROM subscribers WHERE bot_id = ? AND telegram_id = ?', [botId, telegramId]);
      
      if (!sub) {
        await db.run(
          `INSERT INTO subscribers (bot_id, telegram_id, first_name, last_name, username, last_interaction)
           VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [botId, telegramId, from.first_name || '', from.last_name || '', from.username || '']
        );
        sub = await db.get('SELECT * FROM subscribers WHERE bot_id = ? AND telegram_id = ?', [botId, telegramId]);
        if (sub) {
          this.broadcastWs('new_subscriber', { botId, subscriber: sub });
        }
      } else {
        await db.run(
          `UPDATE subscribers SET first_name = ?, last_name = ?, username = ?, is_blocked = 0, last_interaction = CURRENT_TIMESTAMP WHERE id = ?`,
          [from.first_name || '', from.last_name || '', from.username || '', sub.id]
        );
      }
      return sub;
    };

    // Handle /start command & Welcome flow
    bot.command('start', async (ctx) => {
      try {
        const sub = await getOrCreateSubscriber(ctx.from);
        if (!sub) return;
        
        // Save incoming /start message
        await db.run(
          `INSERT INTO messages (bot_id, subscriber_id, direction, text, media_type)
           VALUES (?, ?, 'in', '/start', 'text')`,
          [botId, sub.id]
        );
        this.broadcastWs('new_message', {
          botId,
          subscriberId: sub.id,
          message: {
            bot_id: botId,
            subscriber_id: sub.id,
            direction: 'in',
            text: '/start',
            media_type: 'text',
            created_at: new Date().toISOString()
          }
        });

        // Retrieve latest bot welcome config
        const currentBot = await db.get('SELECT * FROM bots WHERE id = ?', [botId]);
        if (!currentBot) return;

        let flow = [];
        try {
          flow = JSON.parse(currentBot.welcome_flow || '[]');
        } catch (e) {
          flow = [];
        }

        // Helper to format placeholders
        const formatText = (raw) => {
          if (!raw) return '';
          return raw
            .replace(/{first_name}/g, ctx.from.first_name || 'Friend')
            .replace(/{last_name}/g, ctx.from.last_name || '')
            .replace(/{username}/g, ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || 'Friend'));
        };

        // Helper to build keyboard
        const buildKeyboard = (btnList) => {
          if (!Array.isArray(btnList) || btnList.length === 0) return null;
          const valid = btnList.filter(b => b && b.text && b.text.trim());
          if (valid.length === 0) return null;
          const rows = valid.map(btn => {
            if (btn.url && btn.url.trim()) {
              return [Markup.button.url(btn.text.trim(), btn.url.trim())];
            }
            return [Markup.button.callback(btn.text.trim(), btn.callback_data || btn.text.trim())];
          });
          return Markup.inlineKeyboard(rows);
        };

        if (Array.isArray(flow) && flow.length > 0) {
          // Process multi-step sequence
          for (let i = 0; i < flow.length; i++) {
            const step = flow[i];
            const stepText = formatText(step.text || '');
            const keyboard = buildKeyboard(step.buttons);
            const extra = keyboard ? { parse_mode: 'HTML', ...keyboard } : { parse_mode: 'HTML' };
            const type = (step.type || 'text').toLowerCase();
            const mediaUrl = (step.media_url || '').trim();

            let sentType = 'text';
            let sentMedia = '';

            try {
              if (type === 'photo' && mediaUrl) {
                sentType = 'photo';
                sentMedia = mediaUrl;
                await ctx.replyWithPhoto(mediaUrl, { ...extra, caption: stepText });
              } else if ((type === 'document' || type === 'pdf') && mediaUrl) {
                sentType = 'document';
                sentMedia = mediaUrl;
                await ctx.replyWithDocument(mediaUrl, { ...extra, caption: stepText });
              } else {
                sentType = 'text';
                if (stepText) {
                  await ctx.reply(stepText, extra);
                }
              }

              // Save outgoing message
              await db.run(
                `INSERT INTO messages (bot_id, subscriber_id, direction, text, media_type, media_url)
                 VALUES (?, ?, 'out', ?, ?, ?)`,
                [botId, sub.id, stepText, sentType, sentMedia]
              );
              this.broadcastWs('new_message', {
                botId,
                subscriberId: sub.id,
                message: {
                  bot_id: botId,
                  subscriber_id: sub.id,
                  direction: 'out',
                  text: stepText,
                  media_type: sentType,
                  media_url: sentMedia,
                  created_at: new Date().toISOString()
                }
              });

              // Small delay between sequential messages
              if (i < flow.length - 1) {
                await new Promise(r => setTimeout(r, 450));
              }
            } catch (stepErr) {
              console.error(`Error sending welcome step #${i + 1}:`, stepErr.message);
            }
          }
        } else {
          // Legacy single welcome message fallback
          let welcomeText = formatText(currentBot.welcome_message || 'Hello {first_name}! Welcome to our bot 🎉');
          let keyboard = null;
          try {
            const buttons = JSON.parse(currentBot.welcome_buttons || '[]');
            keyboard = buildKeyboard(buttons);
          } catch (e) {}

          const extra = keyboard ? { parse_mode: 'HTML', ...keyboard } : { parse_mode: 'HTML' };
          let sentType = 'text';
          let sentMedia = currentBot.welcome_photo || '';

          if (sentMedia && sentMedia.trim().length > 0) {
            sentType = 'photo';
            await ctx.replyWithPhoto(sentMedia.trim(), { ...extra, caption: welcomeText });
          } else {
            await ctx.reply(welcomeText, extra);
          }

          await db.run(
            `INSERT INTO messages (bot_id, subscriber_id, direction, text, media_type, media_url)
             VALUES (?, ?, 'out', ?, ?, ?)`,
            [botId, sub.id, welcomeText, sentType, sentMedia]
          );
        }
      } catch (err) {
        console.error('Error handling /start:', err);
      }
    });

    // Handle regular text and media messages from users
    bot.on('message', async (ctx) => {
      try {
        if (ctx.message.text && ctx.message.text.startsWith('/start')) return;

        const sub = await getOrCreateSubscriber(ctx.from);
        let text = ctx.message.text || ctx.message.caption || '';
        let mediaType = 'text';
        let mediaUrl = '';

        if (ctx.message.photo) {
          mediaType = 'photo';
          const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
          try {
            const link = await ctx.telegram.getFileLink(fileId);
            mediaUrl = link.href;
          } catch (e) {}
        } else if (ctx.message.voice) {
          mediaType = 'voice';
          try {
            const link = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
            mediaUrl = link.href;
          } catch (e) {}
        } else if (ctx.message.video) {
          mediaType = 'video';
          try {
            const link = await ctx.telegram.getFileLink(ctx.message.video.file_id);
            mediaUrl = link.href;
          } catch (e) {}
        } else if (ctx.message.document) {
          mediaType = 'document';
          try {
            const link = await ctx.telegram.getFileLink(ctx.message.document.file_id);
            mediaUrl = link.href;
          } catch (e) {}
        }

        const msgRes = await db.run(
          `INSERT INTO messages (bot_id, subscriber_id, direction, text, media_type, media_url)
           VALUES (?, ?, 'in', ?, ?, ?)`,
          [botId, sub.id, text, mediaType, mediaUrl]
        );
        const incomingMsg = await db.get('SELECT * FROM messages WHERE id = ?', [msgRes.id]);
        this.broadcastWs('new_message', { botId, subscriberId: sub.id, message: incomingMsg });
      } catch (err) {
        console.error('Error handling incoming message:', err);
      }
    });

    // Start bot polling (captures any pending user messages from Telegram queue)
    bot.launch({ dropPendingUpdates: false }).catch(err => {
      console.error(`Failed to launch bot ID ${botId}:`, err.message);
    });

    const botInfo = await bot.telegram.getMe();
    this.activeBots.set(botId, { instance: bot, info: botInfo });
    console.log(`Bot connected: @${botInfo.username} (ID: ${botId})`);
    return botInfo;
  }

  // Stop a bot instance
  async stopBot(botId) {
    if (this.activeBots.has(botId)) {
      const { instance } = this.activeBots.get(botId);
      try {
        instance.stop();
      } catch (e) {}
      this.activeBots.delete(botId);
      console.log(`Stopped bot ID ${botId}`);
    }
  }

  // Send a 1-on-1 direct message from Dashboard to a subscriber
  async sendMessageToSubscriber(botId, subscriberId, text, mediaUrl = '', mediaType = 'text') {
    const active = this.activeBots.get(Number(botId));
    if (!active) throw new Error('Bot is not active or connected');

    const sub = await db.get('SELECT * FROM subscribers WHERE id = ? AND bot_id = ?', [subscriberId, botId]);
    if (!sub) throw new Error('Subscriber not found');

    const bot = active.instance;
    const chatId = sub.telegram_id;

    let sentMsg = null;
    try {
      if (mediaType === 'photo' && mediaUrl) {
        sentMsg = await bot.telegram.sendPhoto(chatId, mediaUrl, { caption: text || '', parse_mode: 'HTML' });
      } else {
        sentMsg = await bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML' });
      }

      // Save outgoing message in DB
      const result = await db.run(
        `INSERT INTO messages (bot_id, subscriber_id, direction, text, media_type, media_url)
         VALUES (?, ?, 'out', ?, ?, ?)`,
        [botId, subscriberId, text, mediaType, mediaUrl]
      );
      const newMsg = await db.get('SELECT * FROM messages WHERE id = ?', [result.id]);
      
      // Update last interaction
      await db.run('UPDATE subscribers SET last_interaction = CURRENT_TIMESTAMP WHERE id = ?', [subscriberId]);

      this.broadcastWs('new_message', { botId: Number(botId), subscriberId: Number(subscriberId), message: newMsg });
      return newMsg;
    } catch (err) {
      if (err.response && err.response.error_code === 403) {
        // User blocked the bot
        await db.run('UPDATE subscribers SET is_blocked = 1 WHERE id = ?', [subscriberId]);
        this.broadcastWs('subscriber_blocked', { botId: Number(botId), subscriberId: Number(subscriberId) });
      }
      throw err;
    }
  }

  // Get active bot instance
  getBotInstance(botId) {
    const active = this.activeBots.get(Number(botId));
    return active ? active.instance : null;
  }
}

module.exports = new BotManager();
