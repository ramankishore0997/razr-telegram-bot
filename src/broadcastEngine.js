const db = require('./db');
const botManager = require('./botManager');
const { Markup } = require('telegraf');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class BroadcastEngine {
  constructor() {
    this.isProcessing = false;
  }

  async startBroadcast(campaignId) {
    const campaign = await db.get('SELECT * FROM campaigns WHERE id = ?', [campaignId]);
    if (!campaign) throw new Error('Campaign not found');

    const botId = campaign.bot_id;
    const bot = botManager.getBotInstance(botId);
    if (!bot) throw new Error('Bot instance is not connected');

    // Get all non-blocked subscribers
    const subscribers = await db.all('SELECT * FROM subscribers WHERE bot_id = ? AND is_blocked = 0', [botId]);
    
    await db.run(
      'UPDATE campaigns SET status = "running", total_target = ? WHERE id = ?',
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

    // Parse buttons if any
    let extra = { parse_mode: 'HTML' };
    try {
      const buttons = JSON.parse(campaign.buttons || '[]');
      if (Array.isArray(buttons) && buttons.length > 0) {
        const inlineRows = buttons.map(btn => {
          if (btn.url) return [Markup.button.url(btn.text, btn.url)];
          return [Markup.button.callback(btn.text, btn.callback_data || btn.text)];
        });
        extra.reply_markup = Markup.inlineKeyboard(inlineRows).reply_markup;
      }
    } catch (e) {}

    // Process broadcast queue with safe throttling (40ms per msg => ~25 msg/sec)
    for (let i = 0; i < subscribers.length; i++) {
      const sub = subscribers[i];
      const chatId = sub.telegram_id;

      // Personalize message
      let text = campaign.text
        .replace(/{first_name}/g, sub.first_name || 'Friend')
        .replace(/{last_name}/g, sub.last_name || '')
        .replace(/{username}/g, sub.username ? `@${sub.username}` : (sub.first_name || 'Friend'));

      try {
        if (campaign.photo_url && campaign.photo_url.trim().length > 0) {
          await bot.telegram.sendPhoto(chatId, campaign.photo_url, { ...extra, caption: text });
        } else {
          await bot.telegram.sendMessage(chatId, text, extra);
        }
        sent++;
      } catch (err) {
        if (err.response && (err.response.error_code === 403 || err.description?.includes('blocked') || err.description?.includes('deactivated'))) {
          blocked++;
          await db.run('UPDATE subscribers SET is_blocked = 1 WHERE id = ?', [sub.id]);
        } else {
          failed++;
          console.error(`Broadcast fail for user ${chatId}:`, err.message);
        }
      }

      // Live progress broadcast every 5 messages or last message
      if (i % 5 === 0 || i === subscribers.length - 1) {
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
      `UPDATE campaigns SET status = "completed", total_sent = ?, total_blocked = ?, total_failed = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`,
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

    console.log(`Campaign #${campaignId} completed. Sent: ${sent}, Blocked: ${blocked}, Failed: ${failed}`);
    return { sent, blocked, failed };
  }
}

module.exports = new BroadcastEngine();
