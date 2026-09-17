const fs = require('fs');
const path = require('path');
const db = require('./db');
const botManager = require('./botManager');
const { Markup } = require('telegraf');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getMediaSource(mediaUrl) {
  if (!mediaUrl) return null;
  const clean = String(mediaUrl).trim();
  if (!clean) return null;
  if (clean.startsWith('/uploads/') || clean.startsWith('uploads/')) {
    const localPath = path.join(__dirname, '../public', clean.replace(/^\//, ''));
    if (fs.existsSync(localPath)) {
      return { source: localPath };
    }
    return null;
  }
  if (clean.startsWith('http://') || clean.startsWith('https://')) {
    return clean;
  }
  return null;
}

class BroadcastEngine {
  constructor() {
    this.isProcessing = false;
  }

  async startBroadcast(campaignId) {
    const campaign = await db.get('SELECT * FROM campaigns WHERE id = ?', [Number(campaignId)]);
    if (!campaign) throw new Error('Campaign not found');

    const botId = Number(campaign.bot_id);
    let bot = botManager.getBotInstance(botId);
    
    // If bot instance not in memory, ensure it is started
    if (!bot) {
      const botRecord = await db.get('SELECT * FROM bots WHERE id = ?', [botId]);
      if (botRecord) {
        await botManager.startBot(botRecord.id, botRecord.token);
        bot = botManager.getBotInstance(botId);
      }
    }
    if (!bot) throw new Error('Bot instance is not connected. Please verify bot status.');

    // Get all non-blocked subscribers for this bot
    const subscribers = await db.all('SELECT * FROM subscribers WHERE bot_id = ? AND is_blocked = 0', [botId]);
    
    await db.run(
      "UPDATE campaigns SET status = 'running', total_target = ? WHERE id = ?",
      [subscribers.length, campaignId]
    );

    botManager.broadcastWs('campaign_update', {
      campaignId,
      botId,
      status: 'running',
      totalTarget: subscribers.length,
      totalSent: 0,
      totalBlocked: 0,
      totalFailed: 0,
      progress: 0
    });

    let sent = 0;
    let blocked = 0;
    let failed = 0;

    // Parse buttons if any with URL validation
    let keyboardMarkup = null;
    try {
      const buttons = JSON.parse(campaign.buttons || '[]');
      if (Array.isArray(buttons) && buttons.length > 0) {
        const inlineRows = buttons.filter(b => b && b.text).map(btn => {
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
        if (inlineRows.length > 0) {
          keyboardMarkup = Markup.inlineKeyboard(inlineRows).reply_markup;
        }
      }
    } catch (e) {}

    const extraHtml = keyboardMarkup ? { parse_mode: 'HTML', reply_markup: keyboardMarkup } : { parse_mode: 'HTML' };
    const extraPlain = keyboardMarkup ? { reply_markup: keyboardMarkup } : {};

    // Process broadcast queue with safe throttling (40ms per msg => ~25 msg/sec)
    for (let i = 0; i < subscribers.length; i++) {
      const sub = subscribers[i];
      const chatId = sub.telegram_id;

      // Personalize message
      let text = (campaign.text || '')
        .replace(/{first_name}/g, sub.first_name || 'Friend')
        .replace(/{last_name}/g, sub.last_name || '')
        .replace(/{username}/g, sub.username ? `@${sub.username}` : (sub.first_name || 'Friend'));

      if (!text.trim()) text = '📢 Special Announcement';

      try {
        const mediaSource = getMediaSource(campaign.photo_url);
        if (mediaSource) {
          const isDoc = String(campaign.photo_url).toLowerCase().endsWith('.pdf') || 
                        String(campaign.photo_url).toLowerCase().endsWith('.doc') || 
                        String(campaign.photo_url).toLowerCase().endsWith('.docx');
          if (isDoc) {
            try {
              await bot.telegram.sendDocument(chatId, mediaSource, { ...extraHtml, caption: text });
            } catch (err) {
              await bot.telegram.sendDocument(chatId, mediaSource, { ...extraPlain, caption: text });
            }
          } else {
            try {
              await bot.telegram.sendPhoto(chatId, mediaSource, { ...extraHtml, caption: text });
            } catch (err) {
              await bot.telegram.sendPhoto(chatId, mediaSource, { ...extraPlain, caption: text });
            }
          }
        } else {
          try {
            await bot.telegram.sendMessage(chatId, text, extraHtml);
          } catch (err) {
            await bot.telegram.sendMessage(chatId, text, extraPlain);
          }
        }
        sent++;

        // Log successful delivery
        await db.run(
          `INSERT INTO campaign_recipients (campaign_id, subscriber_id, telegram_id, first_name, username, status)
           VALUES (?, ?, ?, ?, ?, 'delivered')`,
          [campaignId, sub.id, chatId, sub.first_name || '', sub.username || '']
        );

        // Save in messages history
        await db.run(
          `INSERT INTO messages (bot_id, subscriber_id, direction, text, media_type, media_url)
           VALUES (?, ?, 'out', ?, ?, ?)`,
          [botId, sub.id, text, campaign.photo_url ? 'photo' : 'text', campaign.photo_url || '']
        );
      } catch (err) {
        if (err.response && (err.response.error_code === 403 || err.description?.includes('blocked') || err.description?.includes('deactivated'))) {
          blocked++;
          await db.run('UPDATE subscribers SET is_blocked = 1 WHERE id = ?', [sub.id]);
          await db.run(
            `INSERT INTO campaign_recipients (campaign_id, subscriber_id, telegram_id, first_name, username, status, error_message)
             VALUES (?, ?, ?, ?, ?, 'blocked', 'User blocked the bot')`,
            [campaignId, sub.id, chatId, sub.first_name || '', sub.username || '']
          );
        } else {
          failed++;
          console.error(`Broadcast fail for user ${chatId}:`, err.message);
          await db.run(
            `INSERT INTO campaign_recipients (campaign_id, subscriber_id, telegram_id, first_name, username, status, error_message)
             VALUES (?, ?, ?, ?, ?, 'failed', ?)`,
            [campaignId, sub.id, chatId, sub.first_name || '', sub.username || '', err.message || 'Send error']
          );
        }
      }

      // Live progress broadcast every 3 messages or last message
      if (i % 3 === 0 || i === subscribers.length - 1) {
        const progress = Math.round(((i + 1) / subscribers.length) * 100);
        botManager.broadcastWs('campaign_update', {
          campaignId,
          botId,
          status: 'running',
          totalTarget: subscribers.length,
          totalSent: sent,
          totalBlocked: blocked,
          totalFailed: failed,
          progress
        });
      }

      // Safe Telegram rate-limiting delay
      await sleep(40);
    }

    // Mark completed
    await db.run(
      "UPDATE campaigns SET status = 'completed', total_sent = ?, total_blocked = ?, total_failed = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?",
      [sent, blocked, failed, campaignId]
    );

    botManager.broadcastWs('campaign_update', {
      campaignId,
      botId,
      status: 'completed',
      totalTarget: subscribers.length,
      totalSent: sent,
      totalBlocked: blocked,
      totalFailed: failed,
      progress: 100
    });

    console.log(`Campaign #${campaignId} finished. Delivered: ${sent}, Blocked: ${blocked}, Failed: ${failed}`);
    return { sent, blocked, failed };
  }
}

module.exports = new BroadcastEngine();
