const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { WebSocketServer } = require('ws');

const db = require('./src/db');
const botManager = require('./src/botManager');
const broadcastEngine = require('./src/broadcastEngine');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Explicit root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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

    const insert = await db.run(
      `INSERT INTO bots (name, username, token, is_active) VALUES (?, ?, ?, 1)`,
      [botName, botUsername, token.trim()]
    );

    const newBot = await db.get('SELECT * FROM bots WHERE id = ?', [insert.id]);
    await botManager.startBot(newBot.id, newBot.token);

    botManager.broadcastWs('bot_added', newBot);
    res.json({ success: true, data: newBot });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      return res.status(400).json({ success: false, error: 'This bot token is already added.' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update bot settings (welcome message, buttons, photo)
app.put('/api/bots/:id', async (req, res) => {
  try {
    const { name, welcome_message, welcome_photo, welcome_buttons, is_active } = req.body;
    const botId = req.params.id;

    await db.run(
      `UPDATE bots SET 
        name = COALESCE(?, name),
        welcome_message = COALESCE(?, welcome_message),
        welcome_photo = COALESCE(?, welcome_photo),
        welcome_buttons = COALESCE(?, welcome_buttons),
        is_active = COALESCE(?, is_active)
      WHERE id = ?`,
      [
        name,
        welcome_message,
        welcome_photo,
        typeof welcome_buttons === 'object' ? JSON.stringify(welcome_buttons) : welcome_buttons,
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
      'UPDATE messages SET is_read = 1 WHERE bot_id = ? AND subscriber_id = ? AND direction = "in"',
      [botId, subscriberId]
    );

    const messages = await db.all(
      'SELECT * FROM messages WHERE bot_id = ? AND subscriber_id = ? ORDER BY created_at ASC',
      [botId, subscriberId]
    );

    const subscriber = await db.get('SELECT * FROM subscribers WHERE id = ?', [subscriberId]);
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
      [req.params.botId]
    );
    res.json({ success: true, data: campaigns });
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
        botId,
        campaignTitle,
        text.trim(),
        photo_url || '',
        typeof buttons === 'object' ? JSON.stringify(buttons) : (buttons || '[]')
      ]
    );

    // Launch broadcast in background asynchronously
    broadcastEngine.startBroadcast(insert.id).catch(err => {
      console.error('Broadcast execution error:', err);
    });

    res.json({ success: true, campaignId: insert.id, message: 'Broadcast queued and started successfully' });
  } catch (err) {
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
