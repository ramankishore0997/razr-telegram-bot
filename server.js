const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { WebSocketServer } = require('ws');

const db = require('./src/db');
const botManager = require('./src/botManager');
const broadcastEngine = require('./src/broadcastEngine');

const fs = require('fs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Ensure uploads folder exists
const uploadsDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer storage config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${Date.now()}-${safeName}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB max file size
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Explicit root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// File Upload Endpoint
app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }
    const fileUrl = `/uploads/${req.file.filename}`;
    res.json({
      success: true,
      fileUrl,
      fileName: req.file.originalname,
      size: req.file.size,
      mimeType: req.file.mimetype
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// WebSocket connection handling
wss.on('connection', (ws) => {
  botManager.addWsClient(ws);
  ws.send(JSON.stringify({ type: 'connected', message: 'WebSocket Live Sync Active' }));
});

// ==========================================
// BOTS API
// ==========================================

// Get all bots with subscriber count & unread messages
app.get('/api/bots', async (req, res) => {
  try {
    const bots = await db.all(`
      SELECT 
        b.*,
        COUNT(DISTINCT s.id) as subscriber_count,
        COUNT(DISTINCT CASE WHEN m.direction = 'in' AND m.is_read = 0 THEN m.id END) as unread_count
      FROM bots b
      LEFT JOIN subscribers s ON s.bot_id = b.id
      LEFT JOIN messages m ON m.bot_id = b.id
      GROUP BY b.id
      ORDER BY b.created_at DESC
    `);
    
    // Add runtime active status
    const result = bots.map(b => ({
      ...b,
      is_running: botManager.activeBots.has(b.id)
    }));
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Add a new bot
app.post('/api/bots', async (req, res) => {
  try {
    const { token, name } = req.body;
    if (!token || !token.trim()) {
      return res.status(400).json({ success: false, error: 'Bot Token is required' });
    }

    const test = await botManager.testToken(token.trim());
    if (!test.success) {
      return res.status(400).json({ success: false, error: 'Invalid Bot Token. Telegram rejected it: ' + test.error });
    }

    const botName = name && name.trim() ? name.trim() : test.info.first_name;
    const botUsername = test.info.username || '';

    // Check if bot already exists in database
    let existing = await db.get('SELECT * FROM bots WHERE token = ?', [token.trim()]);
    if (existing) {
      await db.run('UPDATE bots SET name = ?, username = ?, is_active = 1 WHERE id = ?', [botName, botUsername, existing.id]);
    } else {
      await db.run(
        `INSERT INTO bots (name, username, token, is_active) VALUES (?, ?, ?, 1)`,
        [botName, botUsername, token.trim()]
      );
    }

    const newBot = await db.get('SELECT * FROM bots WHERE token = ?', [token.trim()]);
    if (!newBot) {
      throw new Error('Could not retrieve bot record after insertion');
    }

    await botManager.startBot(newBot.id, newBot.token);

    botManager.broadcastWs('bot_added', newBot);
    res.json({ success: true, data: newBot });
  } catch (err) {
    console.error('Error adding bot:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update bot settings (welcome message, flow, buttons, photo, admin alerts)
app.put('/api/bots/:id', async (req, res) => {
  try {
    const { name, welcome_message, welcome_photo, welcome_buttons, welcome_flow, admin_chat_id, admin_notifications, is_active } = req.body;
    const botId = req.params.id;

    await db.run(
      `UPDATE bots SET 
        name = COALESCE(?, name),
        welcome_message = COALESCE(?, welcome_message),
        welcome_photo = COALESCE(?, welcome_photo),
        welcome_buttons = COALESCE(?, welcome_buttons),
        welcome_flow = COALESCE(?, welcome_flow),
        admin_chat_id = COALESCE(?, admin_chat_id),
        admin_notifications = COALESCE(?, admin_notifications),
        is_active = COALESCE(?, is_active)
      WHERE id = ?`,
      [
        name,
        welcome_message,
        welcome_photo,
        typeof welcome_buttons === 'object' ? JSON.stringify(welcome_buttons) : welcome_buttons,
        typeof welcome_flow === 'object' ? JSON.stringify(welcome_flow) : welcome_flow,
        admin_chat_id,
        admin_notifications !== undefined ? Number(admin_notifications) : null,
        is_active,
        botId
      ]
    );

    const updated = await db.get('SELECT * FROM bots WHERE id = ?', [botId]);
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Send test notification to admin
app.post('/api/bots/:id/test-alert', async (req, res) => {
  try {
    const botId = req.params.id;
    const botRecord = await db.get('SELECT * FROM bots WHERE id = ?', [Number(botId)]);
    if (!botRecord) return res.status(404).json({ success: false, error: 'Bot not found' });
    if (!botRecord.admin_chat_id || !botRecord.admin_chat_id.trim()) {
      return res.status(400).json({ success: false, error: 'Please enter and save your Telegram Admin Chat ID first.' });
    }

    const botInstance = botManager.getBotInstance(botRecord.id);
    if (!botInstance) return res.status(400).json({ success: false, error: 'Bot is currently not connected' });

    await botInstance.telegram.sendMessage(
      botRecord.admin_chat_id.trim(),
      `🔔 <b>Test Notification from TeleManager</b>\n\n✅ <b>Alerts are working!</b>\nYou will receive instant alerts here on Telegram whenever a user sends a message to @${botRecord.username || 'your bot'}.`,
      { parse_mode: 'HTML' }
    );

    res.json({ success: true, message: 'Test alert sent to your Telegram account!' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to send alert: ' + err.message });
  }
});

// Delete a bot
app.delete('/api/bots/:id', async (req, res) => {
  try {
    const botId = req.params.id;
    await botManager.stopBot(Number(botId));
    await db.run('DELETE FROM bots WHERE id = ?', [botId]);
    res.json({ success: true, message: 'Bot deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// SUBSCRIBERS & LIVE CHAT API
// ==========================================

// Get conversations (subscribers with their latest message)
app.get('/api/bots/:botId/conversations', async (req, res) => {
  try {
    const botId = req.params.botId;
    const conversations = await db.all(`
      SELECT 
        s.*,
        (SELECT text FROM messages WHERE subscriber_id = s.id ORDER BY created_at DESC LIMIT 1) as last_message,
        (SELECT direction FROM messages WHERE subscriber_id = s.id ORDER BY created_at DESC LIMIT 1) as last_message_direction,
        (SELECT created_at FROM messages WHERE subscriber_id = s.id ORDER BY created_at DESC LIMIT 1) as last_message_time,
        (SELECT COUNT(*) FROM messages WHERE subscriber_id = s.id AND direction = 'in' AND is_read = 0) as unread_count
      FROM subscribers s
      WHERE s.bot_id = ?
      ORDER BY s.last_interaction DESC
    `, [botId]);

    res.json({ success: true, data: conversations });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get message history for a subscriber
app.get('/api/messages/:botId/:subscriberId', async (req, res) => {
  try {
    const { botId, subscriberId } = req.params;
    
    // Mark incoming messages as read
    await db.run(
      "UPDATE messages SET is_read = 1 WHERE bot_id = ? AND subscriber_id = ? AND direction = 'in'",
      [Number(botId), Number(subscriberId)]
    );

    const messages = await db.all(
      'SELECT * FROM messages WHERE bot_id = ? AND subscriber_id = ? ORDER BY created_at ASC',
      [Number(botId), Number(subscriberId)]
    );

    const subscriber = await db.get('SELECT * FROM subscribers WHERE id = ?', [Number(subscriberId)]);
    res.json({ success: true, subscriber, data: messages });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Send 1-on-1 direct reply from dashboard to user
app.post('/api/messages/send', async (req, res) => {
  try {
    const { botId, subscriberId, text, mediaUrl, mediaType } = req.body;
    if (!text && !mediaUrl) {
      return res.status(400).json({ success: false, error: 'Text or media is required' });
    }

    const message = await botManager.sendMessageToSubscriber(botId, subscriberId, text, mediaUrl, mediaType);
    res.json({ success: true, data: message });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Bulk Import Subscribers (SendPulse CSV / JSON migration)
app.post('/api/subscribers/import', async (req, res) => {
  try {
    const { botId, subscribers } = req.body; // array of { telegram_id, first_name, username }
    if (!botId || !Array.isArray(subscribers)) {
      return res.status(400).json({ success: false, error: 'Invalid import payload' });
    }

    let imported = 0;
    for (const sub of subscribers) {
      if (!sub.telegram_id) continue;
      try {
        await db.run(
          `INSERT OR IGNORE INTO subscribers (bot_id, telegram_id, first_name, username, last_interaction)
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [botId, String(sub.telegram_id), sub.first_name || '', sub.username || '']
        );
        imported++;
      } catch (e) {}
    }

    res.json({ success: true, importedCount: imported });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// BROADCAST & CAMPAIGNS API
// ==========================================

// Get all campaigns for a bot
app.get('/api/campaigns/:botId', async (req, res) => {
  try {
    const campaigns = await db.all(
      'SELECT * FROM campaigns WHERE bot_id = ? ORDER BY created_at DESC',
      [Number(req.params.botId)]
    );
    res.json({ success: true, data: campaigns });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get detailed subscriber-by-subscriber delivery report for a campaign
app.get('/api/campaigns/:campaignId/details', async (req, res) => {
  try {
    const campaignId = Number(req.params.campaignId);
    const campaign = await db.get('SELECT * FROM campaigns WHERE id = ?', [campaignId]);
    if (!campaign) {
      return res.status(404).json({ success: false, error: 'Campaign not found' });
    }

    const recipients = await db.all(
      'SELECT * FROM campaign_recipients WHERE campaign_id = ? ORDER BY delivered_at ASC',
      [campaignId]
    );

    res.json({ success: true, campaign, recipients });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Create and trigger a mass broadcast campaign
app.post('/api/campaigns', async (req, res) => {
  try {
    const { botId, title, text, photo_url, buttons } = req.body;
    if (!botId || !text || !text.trim()) {
      return res.status(400).json({ success: false, error: 'Bot ID and message text are required' });
    }

    const campaignTitle = title && title.trim() ? title.trim() : 'Broadcast ' + new Date().toLocaleString();
    const insert = await db.run(
      `INSERT INTO campaigns (bot_id, title, text, photo_url, buttons, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [
        Number(botId),
        campaignTitle,
        text.trim(),
        photo_url || '',
        typeof buttons === 'object' ? JSON.stringify(buttons) : (buttons || '[]')
      ]
    );

    let campaignId = insert.id;
    if (!campaignId) {
      const latest = await db.get('SELECT id FROM campaigns WHERE bot_id = ? ORDER BY id DESC LIMIT 1', [Number(botId)]);
      campaignId = latest?.id;
    }

    // Launch broadcast in background asynchronously
    broadcastEngine.startBroadcast(campaignId).catch(err => {
      console.error('Broadcast execution error:', err);
    });

    res.json({ success: true, campaignId, message: 'Broadcast queued and started successfully' });
  } catch (err) {
    console.error('Error creating campaign:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// OVERVIEW & STATS API
// ==========================================
app.get('/api/stats', async (req, res) => {
  try {
    const totalBots = await db.get('SELECT COUNT(*) as count FROM bots');
    const totalSubscribers = await db.get('SELECT COUNT(*) as count FROM subscribers');
    const totalMessages = await db.get('SELECT COUNT(*) as count FROM messages');
    const activeCampaigns = await db.get('SELECT COUNT(*) as count FROM campaigns WHERE status = "running"');

    res.json({
      success: true,
      stats: {
        bots: totalBots.count,
        subscribers: totalSubscribers.count,
        messages: totalMessages.count,
        activeCampaigns: activeCampaigns.count
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// SERVER INITIALIZATION
// ==========================================
const PORT = process.env.PORT || 3000;

async function startServer() {
  await db.initDb();
  await botManager.initAllBots();

  server.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`🚀 Telegram Multi-Bot Manager running at:`);
    console.log(`👉 http://localhost:${PORT}`);
    console.log(`=======================================================`);
  });
}

startServer();
