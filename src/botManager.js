const fs = require('fs');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');
const db = require('./db');

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getMediaSource(mediaUrl) {
  if (!mediaUrl) return null;
  const clean = String(mediaUrl).trim();
  if (!clean) return null;
  if (clean.startsWith('/uploads/') || clean.startsWith('uploads/')) {
    const localPath = path.join(__dirname, '../public', clean.replace(/^\//, ''));
    if (fs.existsSync(localPath)) {
      return { source: localPath };
    }
    // File not found on disk, return null so Telegraf doesn't crash with invalid URL
    return null;
  }
  if (clean.startsWith('http://') || clean.startsWith('https://')) {
    return clean;
  }
  return null;
}

// Build inline keyboard with URL validation
function buildKeyboard(btnList) {
  if (!Array.isArray(btnList) || btnList.length === 0) return null;
  const valid = btnList.filter(b => b && b.text && String(b.text).trim());
  if (valid.length === 0) return null;
  const rows = valid.map(btn => {
    const text = String(btn.text).trim();
    let url = String(btn.url || '').trim();
    if (url) {
      if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('tg://')) {
        url = `https://${url}`;
      }
      return [Markup.button.url(text, url)];
    }
    return [Markup.button.callback(text, btn.callback_data || text)];
  });
  return Markup.inlineKeyboard(rows);
}

// Safely send a welcome sequence step (handles HTML errors & missing media gracefully)
async function sendSafeStep(ctx, step, formatText) {
  const rawText = step.text || '';
  const text = formatText(rawText);
  const keyboard = buildKeyboard(step.buttons);
  const type = (step.type || 'text').toLowerCase();
  const mediaUrl = String(step.media_url || '').trim();
  const mediaSource = getMediaSource(mediaUrl);

  let sentType = 'text';
  let sentMedia = '';

  const extraHtml = keyboard ? { parse_mode: 'HTML', ...keyboard } : { parse_mode: 'HTML' };
  const extraPlain = keyboard ? { ...keyboard } : {};

  // 1. Photo Step
  if (type === 'photo' && mediaSource) {
    sentType = 'photo';
    sentMedia = mediaUrl;
    try {
      await ctx.replyWithPhoto(mediaSource, { ...extraHtml, caption: text });
      return { sentType, sentMedia, text };
    } catch (err) {
      console.warn('Photo with HTML failed, retrying plain caption:', err.message);
      try {
        await ctx.replyWithPhoto(mediaSource, { ...extraPlain, caption: text });
        return { sentType, sentMedia, text };
      } catch (photoErr) {
        console.warn('Photo file send failed, falling back to text message:', photoErr.message);
      }
    }
  }

  // 2. Document / PDF Step
  if ((type === 'document' || type === 'pdf') && mediaSource) {
    sentType = 'document';
    sentMedia = mediaUrl;
    try {
      await ctx.replyWithDocument(mediaSource, { ...extraHtml, caption: text });
      return { sentType, sentMedia, text };
    } catch (err) {
      console.warn('Document with HTML failed, retrying plain caption:', err.message);
      try {
        await ctx.replyWithDocument(mediaSource, { ...extraPlain, caption: text });
        return { sentType, sentMedia, text };
      } catch (docErr) {
        console.warn('Document send failed, falling back to text message:', docErr.message);
      }
    }
  }

  // 3. Text Step (or fallback if media failed)
  sentType = 'text';
  const safeText = text && text.trim() ? text.trim() : '👋 Welcome!';
  try {
    await ctx.reply(safeText, extraHtml);
  } catch (htmlErr) {
    console.warn('HTML message reply failed, retrying plain text:', htmlErr.message);
    await ctx.reply(safeText, extraPlain);
  }
  return { sentType, sentMedia, text: safeText };
}

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
    if (this.activeBots.has(Number(botId))) {
      await this.stopBot(Number(botId));
    }

    const botRecord = await db.get('SELECT * FROM bots WHERE id = ?', [Number(botId)]);
    if (!botRecord) throw new Error('Bot not found in database');

    const bot = new Telegraf(token);

    // Error handler
    bot.catch((err, ctx) => {
      console.error(`Telegram error for bot ID ${botId}:`, err);
    });

    // Helper to get or create subscriber
    const getOrCreateSubscriber = async (from) => {
      if (!from || !from.id) return null;
      const telegramId = String(from.id);
      let sub = await db.get('SELECT * FROM subscribers WHERE bot_id = ? AND telegram_id = ?', [Number(botId), telegramId]);
      
      if (!sub) {
        await db.run(
          `INSERT INTO subscribers (bot_id, telegram_id, first_name, last_name, username, last_interaction)
           VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [Number(botId), telegramId, from.first_name || '', from.last_name || '', from.username || '']
        );
        sub = await db.get('SELECT * FROM subscribers WHERE bot_id = ? AND telegram_id = ?', [Number(botId), telegramId]);
        if (sub) {
          this.broadcastWs('new_subscriber', { botId: Number(botId), subscriber: sub });
        }
      } else {
        await db.run(
          `UPDATE subscribers SET first_name = ?, last_name = ?, username = ?, is_blocked = 0, last_interaction = CURRENT_TIMESTAMP WHERE id = ?`,
          [from.first_name || '', from.last_name || '', from.username || '', sub.id]
        );
      }
      return sub;
    };

    // Shared execution function for /start welcome flow (runs EVERY time user sends /start)
    const handleStartTrigger = async (ctx) => {
      try {
        const from = ctx.from;
        const sub = await getOrCreateSubscriber(from);
        const subId = sub ? sub.id : null;

        // Save incoming /start message
        if (subId) {
          await db.run(
            `INSERT INTO messages (bot_id, subscriber_id, direction, text, media_type)
             VALUES (?, ?, 'in', '/start', 'text')`,
            [Number(botId), subId]
          );
          this.broadcastWs('new_message', {
            botId: Number(botId),
            subscriberId: subId,
            message: {
              bot_id: Number(botId),
              subscriber_id: subId,
              direction: 'in',
              text: '/start',
              media_type: 'text',
              created_at: new Date().toISOString()
            }
          });
        }

        // Retrieve latest bot welcome config & admin settings
        const currentBot = await db.get('SELECT * FROM bots WHERE id = ?', [Number(botId)]);
        if (!currentBot) return;

        // Send Admin Telegram Alert on new subscriber / start
        if (currentBot.admin_chat_id && currentBot.admin_notifications !== 0) {
          const adminId = String(currentBot.admin_chat_id).trim();
          if (adminId && adminId !== String(from?.id)) {
            const botInfo = this.activeBots.get(Number(botId))?.info;
            const alertText = `🎉 <b>New Subscriber / Start Alert!</b>\n\n🤖 <b>Bot:</b> @${botInfo?.username || 'bot'}\n👤 <b>User:</b> ${from?.first_name || ''} ${from?.last_name || ''} (@${from?.username || 'none'})\n🆔 <b>Chat ID:</b> <code>${from?.id}</code>\n⏱️ <b>Time:</b> ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
            try {
              await bot.telegram.sendMessage(adminId, alertText, { parse_mode: 'HTML' });
            } catch (alertErr) {
              console.warn('Failed to send admin subscriber alert:', alertErr.message);
            }
          }
        }

        let flow = [];
        try {
          flow = JSON.parse(currentBot.welcome_flow || '[]');
        } catch (e) {
          flow = [];
        }

        // Helper to format placeholders
        const formatText = (raw) => {
          if (!raw) return '';
          return String(raw)
            .replace(/{first_name}/g, from?.first_name || 'Friend')
            .replace(/{last_name}/g, from?.last_name || '')
            .replace(/{username}/g, from?.username ? `@${from.username}` : (from?.first_name || 'Friend'));
        };

        if (Array.isArray(flow) && flow.length > 0) {
          // Process sequential flow steps
          for (let i = 0; i < flow.length; i++) {
            const stepResult = await sendSafeStep(ctx, flow[i], formatText);

            if (subId && stepResult) {
              await db.run(
                `INSERT INTO messages (bot_id, subscriber_id, direction, text, media_type, media_url)
                 VALUES (?, ?, 'out', ?, ?, ?)`,
                [Number(botId), subId, stepResult.text || '', stepResult.sentType || 'text', stepResult.sentMedia || '']
              );
              this.broadcastWs('new_message', {
                botId: Number(botId),
                subscriberId: subId,
                message: {
                  bot_id: Number(botId),
                  subscriber_id: subId,
                  direction: 'out',
                  text: stepResult.text || '',
                  media_type: stepResult.sentType || 'text',
                  media_url: stepResult.sentMedia || '',
                  created_at: new Date().toISOString()
                }
              });
            }

            // Delay between multiple sequential messages
            if (i < flow.length - 1) {
              await new Promise(r => setTimeout(r, 450));
            }
          }
        } else {
          // Legacy single welcome message fallback
          let buttons = [];
          try {
            buttons = JSON.parse(currentBot.welcome_buttons || '[]');
          } catch (e) {}

          const singleStep = {
            text: currentBot.welcome_message || 'Hello {first_name}! Welcome to our bot 🎉',
            type: currentBot.welcome_photo ? 'photo' : 'text',
            media_url: currentBot.welcome_photo || '',
            buttons: buttons
          };

          const stepResult = await sendSafeStep(ctx, singleStep, formatText);

          if (subId && stepResult) {
            await db.run(
              `INSERT INTO messages (bot_id, subscriber_id, direction, text, media_type, media_url)
               VALUES (?, ?, 'out', ?, ?, ?)`,
              [Number(botId), subId, stepResult.text || '', stepResult.sentType || 'text', stepResult.sentMedia || '']
            );
            this.broadcastWs('new_message', {
              botId: Number(botId),
              subscriberId: subId,
              message: {
                bot_id: Number(botId),
                subscriber_id: subId,
                direction: 'out',
                text: stepResult.text || '',
                media_type: stepResult.sentType || 'text',
                media_url: stepResult.sentMedia || '',
                created_at: new Date().toISOString()
              }
            });
          }
        }
      } catch (err) {
        console.error(`Error handling /start for bot ID ${botId}:`, err);
      }
    };

    // Register /start triggers
    bot.command('start', handleStartTrigger);
    bot.hears(/^\/start/i, handleStartTrigger);

    // Command to check Chat ID
    bot.command('myid', async (ctx) => {
      await ctx.reply(`🆔 <b>Your Telegram Chat ID:</b> <code>${ctx.from.id}</code>`, { parse_mode: 'HTML' });
    });

    // Command to automatically set this user as the notification admin
    bot.command('setadmin', async (ctx) => {
      try {
        const adminId = String(ctx.from.id);
        await db.run('UPDATE bots SET admin_chat_id = ?, admin_notifications = 1 WHERE id = ?', [adminId, Number(botId)]);
        await ctx.reply(
          `✅ <b>Admin Alerts Configured!</b>\n\nYour Telegram ID (<code>${adminId}</code>) is now set as the notification admin for this bot.\n\nYou will receive instant alerts here whenever any user sends a message!`,
          { parse_mode: 'HTML' }
        );
      } catch (e) {
        await ctx.reply(`❌ Failed to set admin: ${e.message}`);
      }
    });

    // Handle regular incoming text and media messages from users
    bot.on('message', async (ctx) => {
      try {
        const rawText = ctx.message.text || ctx.message.caption || '';
        // If it was already handled by /start or /setadmin or /myid, ignore here
        if (rawText.toLowerCase().startsWith('/start') || rawText.toLowerCase().startsWith('/setadmin') || rawText.toLowerCase().startsWith('/myid')) return;

        const sub = await getOrCreateSubscriber(ctx.from);
        if (!sub) return;

        let text = rawText;
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
          [Number(botId), sub.id, text, mediaType, mediaUrl]
        );
        const incomingMsg = await db.get('SELECT * FROM messages WHERE id = ?', [msgRes.id]);
        this.broadcastWs('new_message', { botId: Number(botId), subscriberId: sub.id, message: incomingMsg });

        // Forward Real-time Notification to Admin on Telegram
        const currentBot = await db.get('SELECT * FROM bots WHERE id = ?', [Number(botId)]);
        if (currentBot && currentBot.admin_chat_id && currentBot.admin_notifications !== 0) {
          const adminId = String(currentBot.admin_chat_id).trim();
          // Don't notify admin of their own messages
          if (adminId && adminId !== String(ctx.from.id)) {
            const botInfo = this.activeBots.get(Number(botId))?.info;
            const senderName = `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() || 'User';
            const username = ctx.from.username ? `@${ctx.from.username}` : 'No username';
            const msgPreview = text ? text : `[Sent a ${mediaType}]`;

            const alertText = `🔔 <b>New Message Received!</b>\n\n🤖 <b>Bot:</b> @${botInfo?.username || 'bot'}\n👤 <b>From:</b> ${senderName} (${username})\n🆔 <b>User ID:</b> <code>${ctx.from.id}</code>\n💬 <b>Message:</b>\n<i>${escapeHtml(msgPreview)}</i>\n\n⏱️ <b>Time:</b> ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

            try {
              await bot.telegram.sendMessage(adminId, alertText, { parse_mode: 'HTML' });
            } catch (alertErr) {
              console.warn('Failed to send admin notification:', alertErr.message);
            }
          }
        }
      } catch (err) {
        console.error('Error handling incoming message:', err);
      }
    });

    // Start bot polling (captures any pending user messages from Telegram queue)
    bot.launch({ dropPendingUpdates: false }).catch(err => {
      console.error(`Failed to launch bot ID ${botId}:`, err.message);
    });

    const botInfo = await bot.telegram.getMe();
    this.activeBots.set(Number(botId), { instance: bot, info: botInfo });
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
      const mediaSource = getMediaSource(mediaUrl);
      if (mediaType === 'photo' && mediaSource) {
        sentMsg = await bot.telegram.sendPhoto(chatId, mediaSource, { caption: text || '', parse_mode: 'HTML' });
      } else if ((mediaType === 'document' || mediaType === 'pdf') && mediaSource) {
        sentMsg = await bot.telegram.sendDocument(chatId, mediaSource, { caption: text || '', parse_mode: 'HTML' });
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
