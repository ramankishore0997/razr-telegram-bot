// State
let bots = [];
let activeBotId = null;
let currentTab = 'inbox';
let conversations = [];
let activeSubscriberId = null;
let activeSubscriber = null;
let subscribersList = [];
let campaigns = [];
let ws = null;

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
  lucide.createIcons();
  setupWebSocket();
  await loadBots();
});

// ==========================================
// WEBSOCKET SYNC
// ==========================================
function setupWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;
  
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    document.getElementById('wsStatusDot').className = 'w-2 h-2 rounded-full bg-emerald-400';
    document.getElementById('wsStatusText').innerText = 'Live Sync';
  };

  ws.onclose = () => {
    document.getElementById('wsStatusDot').className = 'w-2 h-2 rounded-full bg-amber-400';
    document.getElementById('wsStatusText').innerText = 'Reconnecting...';
    setTimeout(setupWebSocket, 3000);
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleWsEvent(data);
    } catch (e) {}
  };
}

function handleWsEvent(event) {
  const { type, data } = event;

  if (type === 'new_message') {
    // If message is for active bot
    if (data.botId === activeBotId) {
      // If currently chatting with this user, append message
      if (activeSubscriberId === data.subscriberId) {
        appendMessageToFeed(data.message);
      }
      loadConversations();
    }
  } else if (type === 'new_subscriber') {
    if (data.botId === activeBotId) {
      loadConversations();
      loadSubscribers();
    }
  } else if (type === 'campaign_update') {
    if (data.botId === activeBotId) {
      updateCampaignProgressUI(data);
    }
  }
}

// ==========================================
// MOBILE SIDEBAR & DRAWER
// ==========================================
function toggleMobileSidebar(show) {
  const sidebar = document.getElementById('appSidebar');
  const backdrop = document.getElementById('sidebarBackdrop');
  if (!sidebar || !backdrop) return;
  if (show) {
    sidebar.classList.remove('-translate-x-full');
    backdrop.classList.remove('hidden');
  } else {
    sidebar.classList.add('-translate-x-full');
    backdrop.classList.add('hidden');
  }
}

function backToConversationsList() {
  activeSubscriberId = null;
  const sidebar = document.getElementById('inboxSidebar');
  const thread = document.getElementById('inboxThread');
  if (sidebar && thread) {
    if (window.innerWidth < 768) {
      sidebar.style.display = 'flex';
      thread.style.display = 'none';
    } else {
      sidebar.style.display = 'flex';
      thread.style.display = 'flex';
    }
  }
  renderConversationsList();
}

// Window resize handler to maintain proper responsive layout
window.addEventListener('resize', () => {
  const sidebar = document.getElementById('inboxSidebar');
  const thread = document.getElementById('inboxThread');
  if (sidebar && thread && currentTab === 'inbox') {
    if (window.innerWidth >= 768) {
      sidebar.style.display = 'flex';
      thread.style.display = 'flex';
    } else {
      if (activeSubscriberId) {
        sidebar.style.display = 'none';
        thread.style.display = 'flex';
      } else {
        sidebar.style.display = 'flex';
        thread.style.display = 'none';
      }
    }
  }
});

// ==========================================
// TABS SWITCHING
// ==========================================
function switchTab(tabId) {
  currentTab = tabId;
  toggleMobileSidebar(false);

  document.querySelectorAll('.tab-view').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.nav-btn').forEach(el => {
    el.classList.remove('active', 'text-white');
    el.classList.add('text-slate-400');
  });

  // Sync mobile bottom navigation buttons
  document.querySelectorAll('.bottom-nav-btn').forEach(el => {
    el.classList.remove('active', 'text-sky-400');
    el.classList.add('text-slate-400');
  });
  const activeBottomBtn = document.getElementById(`bottom-tab-${tabId}`);
  if (activeBottomBtn) {
    activeBottomBtn.classList.remove('text-slate-400');
    activeBottomBtn.classList.add('active', 'text-sky-400');
  }

  const activeView = document.getElementById(`view-${tabId}`);
  const activeBtn = document.getElementById(`tab-${tabId}`);
  if (activeView) activeView.classList.remove('hidden');
  if (activeBtn) {
    activeBtn.classList.add('active', 'text-white');
    activeBtn.classList.remove('text-slate-400');
  }

  const titles = {
    inbox: 'Live Chat Inbox',
    broadcast: 'Mass Broadcast Campaign',
    welcome: 'Welcome Flow (/start)',
    subscribers: 'Subscribers Management',
    bots: 'Manage Connected Bots'
  };
  document.getElementById('headerTitle').innerText = titles[tabId] || 'Dashboard';

  // Responsive Inbox handling: if no user active on mobile, show list
  if (tabId === 'inbox') {
    const sidebar = document.getElementById('inboxSidebar');
    const thread = document.getElementById('inboxThread');
    if (sidebar && thread) {
      if (window.innerWidth < 768) {
        if (!activeSubscriberId) {
          sidebar.style.display = 'flex';
          thread.style.display = 'none';
        } else {
          sidebar.style.display = 'none';
          thread.style.display = 'flex';
        }
      } else {
        sidebar.style.display = 'flex';
        thread.style.display = 'flex';
      }
    }
    loadConversations();
  }
  if (tabId === 'broadcast') loadBroadcastTab();
  if (tabId === 'welcome') loadWelcomeTab();
  if (tabId === 'subscribers') loadSubscribers();
  if (tabId === 'bots') renderBotsGrid();
}

// ==========================================
// BOTS MANAGEMENT
// ==========================================
async function loadBots() {
  try {
    const res = await fetch('/api/bots');
    const json = await res.json();
    if (json.success) {
      bots = json.data;
      populateBotSelector();

      if (bots.length > 0) {
        if (!activeBotId || !bots.find(b => b.id === activeBotId)) {
          setActiveBot(bots[0].id);
        } else {
          setActiveBot(activeBotId);
        }
      } else {
        document.getElementById('currentBotName').innerText = 'No Bot Connected';
        switchTab('bots');
      }
    }
  } catch (err) {
    console.error('Failed to load bots:', err);
  }
}

function populateBotSelector() {
  const select = document.getElementById('activeBotSelect');
  const importSelect = document.getElementById('importBotSelect');
  select.innerHTML = '';
  importSelect.innerHTML = '';

  if (bots.length === 0) {
    select.innerHTML = '<option value="" disabled selected>No bots added</option>';
    importSelect.innerHTML = '<option value="" disabled selected>No bots added</option>';
    return;
  }

  bots.forEach(bot => {
    const opt = document.createElement('option');
    opt.value = bot.id;
    opt.innerText = `${bot.name} (@${bot.username || 'bot'})`;
    select.appendChild(opt);

    const importOpt = document.createElement('option');
    importOpt.value = bot.id;
    importOpt.innerText = `${bot.name} (@${bot.username || 'bot'})`;
    importSelect.appendChild(importOpt);
  });

  select.onchange = (e) => setActiveBot(Number(e.target.value));
}

function setActiveBot(botId) {
  activeBotId = botId;
  const currentBot = bots.find(b => b.id === botId);
  if (currentBot) {
    document.getElementById('activeBotSelect').value = botId;
    document.getElementById('currentBotName').innerText = `${currentBot.name} (@${currentBot.username || 'bot'})`;
    
    // Refresh current active view
    switchTab(currentTab);
  }
}

// Open / Close Add Bot Modal
function openAddBotModal() {
  document.getElementById('modalAddBot').classList.remove('hidden');
  document.getElementById('addBotError').classList.add('hidden');
  document.getElementById('inputBotToken').value = '';
  document.getElementById('inputBotName').value = '';
}

function closeAddBotModal() {
  document.getElementById('modalAddBot').classList.add('hidden');
}

async function submitNewBot() {
  const token = document.getElementById('inputBotToken').value.trim();
  const name = document.getElementById('inputBotName').value.trim();
  const errDiv = document.getElementById('addBotError');
  const btn = document.getElementById('btnSubmitBot');

  if (!token) {
    errDiv.innerText = 'Please enter a Telegram Bot Token.';
    errDiv.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = 'Validating with Telegram...';
  errDiv.classList.add('hidden');

  try {
    const res = await fetch('/api/bots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, name })
    });
    const json = await res.json();
    if (json.success) {
      closeAddBotModal();
      await loadBots();
      setActiveBot(json.data.id);
    } else {
      errDiv.innerText = json.error || 'Failed to add bot';
      errDiv.classList.remove('hidden');
    }
  } catch (e) {
    errDiv.innerText = 'Network or server error.';
    errDiv.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Validate & Connect';
  }
}

async function deleteBot(botId) {
  if (!confirm('Are you sure you want to disconnect and delete this bot? Message history will be removed.')) return;
  try {
    await fetch(`/api/bots/${botId}`, { method: 'DELETE' });
    await loadBots();
  } catch (e) {
    alert('Failed to delete bot');
  }
}

function renderBotsGrid() {
  const container = document.getElementById('botsCardsGrid');
  if (bots.length === 0) {
    container.innerHTML = `
      <div class="col-span-2 bg-dark-800 border border-slate-800 rounded-2xl p-10 text-center space-y-4">
        <div class="w-12 h-12 rounded-full bg-slate-700/50 flex items-center justify-center mx-auto text-slate-400">
          <i data-lucide="bot" class="w-6 h-6"></i>
        </div>
        <div>
          <h4 class="text-base font-bold text-white">No Telegram Bots Connected</h4>
          <p class="text-xs text-slate-400 max-w-sm mx-auto mt-1">Get a bot token from @BotFather on Telegram and connect it here in 1 click.</p>
        </div>
        <button onclick="openAddBotModal()" class="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold py-2.5 px-5 rounded-xl shadow-lg inline-flex items-center gap-2">
          <i data-lucide="plus" class="w-4 h-4"></i> Connect Bot
        </button>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  container.innerHTML = bots.map(b => `
    <div class="bg-dark-800 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4 relative">
      <div class="flex items-start justify-between">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-sky-500 to-indigo-600 flex items-center justify-center font-bold text-white">
            <i data-lucide="bot" class="w-5 h-5"></i>
          </div>
          <div>
            <h4 class="font-bold text-white text-sm">${b.name}</h4>
            <a href="https://t.me/${b.username}" target="_blank" class="text-xs text-sky-400 hover:underline">@${b.username || 'unknown'}</a>
          </div>
        </div>
        <span class="px-2.5 py-0.5 rounded-full text-[11px] font-semibold ${b.is_running ? 'bg-emerald-900/40 text-emerald-400 border border-emerald-700' : 'bg-rose-900/40 text-rose-400 border border-rose-700'}">
          ${b.is_running ? '🟢 Connected' : '🔴 Stopped'}
        </span>
      </div>

      <div class="grid grid-cols-2 gap-3 pt-1">
        <div class="bg-dark-900/80 rounded-xl p-3 border border-slate-800">
          <span class="text-[10px] uppercase tracking-wider text-slate-400 block">Subscribers</span>
          <span class="text-base font-bold text-white">${b.subscriber_count || 0}</span>
        </div>
        <div class="bg-dark-900/80 rounded-xl p-3 border border-slate-800">
          <span class="text-[10px] uppercase tracking-wider text-slate-400 block">Unread Chats</span>
          <span class="text-base font-bold text-sky-400">${b.unread_count || 0}</span>
        </div>
      </div>

      <!-- Admin Telegram Notifications Box -->
      <div class="bg-dark-900/80 rounded-xl p-3.5 border border-slate-700/60 space-y-2">
        <div class="flex items-center justify-between">
          <label class="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
            <i data-lucide="bell-ring" class="w-3.5 h-3.5 text-amber-400"></i>
            <span>Instant Telegram Alerts</span>
          </label>
          <span class="text-[10px] text-slate-400">Or type <code class="text-sky-400">/setadmin</code> in bot</span>
        </div>
        <p class="text-[11px] text-slate-400">Get an instant notification on your Telegram whenever any user sends a message or starts the bot.</p>
        <div class="flex items-center gap-2 pt-1">
          <input type="text" id="adminChatId_${b.id}" value="${b.admin_chat_id || ''}" placeholder="Your Telegram Chat ID (e.g. 824408478)" class="flex-1 bg-dark-800 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-brand-500 font-mono">
          <button onclick="saveBotAdminAlerts(${b.id})" class="bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition shrink-0">
            Save
          </button>
          <button onclick="sendTestAdminAlert(${b.id})" class="bg-slate-700 hover:bg-slate-600 text-slate-200 px-2.5 py-1.5 rounded-lg text-xs font-medium transition shrink-0">
            Test Alert
          </button>
        </div>
      </div>

      <div class="pt-3 border-t border-slate-700/60 flex items-center justify-between">
        <button onclick="setActiveBot(${b.id}); switchTab('inbox');" class="text-xs text-sky-400 hover:text-sky-300 font-medium flex items-center gap-1.5">
          <i data-lucide="message-square" class="w-3.5 h-3.5"></i> Open Live Chat
        </button>
        <button onclick="deleteBot(${b.id})" class="text-xs text-rose-400 hover:text-rose-300 font-medium flex items-center gap-1">
          <i data-lucide="trash-2" class="w-3.5 h-3.5"></i> Remove
        </button>
      </div>
    </div>
  `).join('');

  lucide.createIcons();
}

async function saveBotAdminAlerts(botId) {
  const input = document.getElementById(`adminChatId_${botId}`);
  if (!input) return;
  const adminChatId = input.value.trim();

  try {
    const res = await fetch(`/api/bots/${botId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ admin_chat_id: adminChatId, admin_notifications: 1 })
    });
    const json = await res.json();
    if (json.success) {
      alert('✅ Admin Telegram Alerts ID saved successfully!');
      await loadBots();
    } else {
      alert('Error: ' + json.error);
    }
  } catch (e) {
    alert('Failed to save admin alert settings');
  }
}

async function sendTestAdminAlert(botId) {
  try {
    const res = await fetch(`/api/bots/${botId}/test-alert`, { method: 'POST' });
    const json = await res.json();
    if (json.success) {
      alert('✅ ' + json.message);
    } else {
      alert('❌ ' + json.error);
    }
  } catch (e) {
    alert('Network error while sending test alert');
  }
}

// ==========================================
// LIVE CHAT INBOX
// ==========================================
async function loadConversations() {
  if (!activeBotId) return;
  try {
    const res = await fetch(`/api/bots/${activeBotId}/conversations`);
    const json = await res.json();
    if (json.success) {
      conversations = json.data;
      renderConversationsList();
    }
  } catch (err) {
    console.error('Failed to load conversations:', err);
  }
}

// Helper to compute user online / last active status
function getOnlineStatusInfo(lastInteraction, isBlocked) {
  if (isBlocked) {
    return {
      statusText: '🚫 Blocked Bot',
      badgeClass: 'bg-rose-900/40 text-rose-400 border-rose-800',
      dotClass: 'bg-rose-500',
      isOnline: false
    };
  }
  if (!lastInteraction) {
    return {
      statusText: '⚪ Offline (Never Active)',
      badgeClass: 'bg-slate-800 text-slate-400 border-slate-700',
      dotClass: 'bg-slate-500',
      isOnline: false
    };
  }

  const now = new Date();
  const last = new Date(lastInteraction);
  const diffMs = now - last;
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 5) {
    return {
      statusText: '🟢 Online / Active now',
      relativeText: 'Online now',
      badgeClass: 'bg-emerald-900/40 text-emerald-400 border-emerald-700',
      dotClass: 'bg-emerald-400',
      isOnline: true
    };
  } else if (diffMins < 60) {
    return {
      statusText: `🟡 Active ${diffMins}m ago`,
      relativeText: `${diffMins}m ago`,
      badgeClass: 'bg-amber-900/30 text-amber-400 border-amber-700/50',
      dotClass: 'bg-amber-400',
      isOnline: false
    };
  } else if (diffHours < 24) {
    return {
      statusText: `🟡 Active ${diffHours}h ago`,
      relativeText: `${diffHours}h ago`,
      badgeClass: 'bg-amber-900/20 text-amber-300 border-amber-700/40',
      dotClass: 'bg-amber-400',
      isOnline: false
    };
  } else if (diffDays === 1) {
    return {
      statusText: `⚪ Last seen yesterday, ${last.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
      relativeText: 'Yesterday',
      badgeClass: 'bg-slate-800 text-slate-400 border-slate-700',
      dotClass: 'bg-slate-500',
      isOnline: false
    };
  } else {
    return {
      statusText: `⚪ Last seen ${last.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${last.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
      relativeText: `${diffDays}d ago`,
      badgeClass: 'bg-slate-800 text-slate-400 border-slate-700',
      dotClass: 'bg-slate-500',
      isOnline: false
    };
  }
}

function renderConversationsList() {
  const container = document.getElementById('conversationsList');
  const search = (document.getElementById('chatSearchInput').value || '').toLowerCase();
  
  const filtered = conversations.filter(c => {
    const name = `${c.first_name || ''} ${c.last_name || ''}`.toLowerCase();
    const username = (c.username || '').toLowerCase();
    const id = (c.telegram_id || '').toLowerCase();
    return name.includes(search) || username.includes(search) || id.includes(search);
  });

  if (filtered.length === 0) {
    container.innerHTML = '<div class="p-8 text-center text-slate-500 text-xs">No conversations found.</div>';
    return;
  }

  container.innerHTML = filtered.map(c => {
    const isSelected = activeSubscriberId === c.id;
    const initial = (c.first_name || 'U').charAt(0).toUpperCase();
    const time = c.last_message_time ? new Date(c.last_message_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const hasUnread = c.unread_count > 0;
    const status = getOnlineStatusInfo(c.last_interaction, c.is_blocked);

    return `
      <div onclick="selectConversation(${c.id})" class="p-3.5 flex items-start gap-3 cursor-pointer transition ${isSelected ? 'bg-indigo-600/20 border-l-4 border-indigo-500' : 'hover:bg-dark-800/60'}">
        <div class="relative shrink-0">
          <div class="w-9 h-9 rounded-full bg-gradient-to-tr from-sky-500 to-indigo-600 flex items-center justify-center font-bold text-xs text-white">
            ${initial}
          </div>
          <span class="w-2.5 h-2.5 rounded-full ${status.dotClass} absolute -bottom-0.5 -right-0.5 border-2 border-dark-900" title="${status.statusText}"></span>
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between">
            <h4 class="text-xs font-semibold text-white truncate">${c.first_name || 'Anonymous User'}</h4>
            <span class="text-[10px] text-slate-400 shrink-0">${time || status.relativeText || ''}</span>
          </div>
          <p class="text-[11px] text-slate-400 truncate mt-0.5">
            ${c.last_message_direction === 'out' ? '<span class="text-sky-400 font-medium">You: </span>' : ''}${c.last_message || 'No messages yet'}
          </p>
        </div>
        ${hasUnread ? `<span class="w-2 h-2 rounded-full bg-sky-400 shrink-0 mt-1.5"></span>` : ''}
      </div>
    `;
  }).join('');
}

document.getElementById('chatSearchInput')?.addEventListener('input', renderConversationsList);

async function selectConversation(subscriberId) {
  activeSubscriberId = subscriberId;
  renderConversationsList();

  // On mobile screens, hide conversation list and show chat thread
  const sidebar = document.getElementById('inboxSidebar');
  const thread = document.getElementById('inboxThread');
  if (sidebar && thread) {
    if (window.innerWidth < 768) {
      sidebar.style.display = 'none';
      thread.style.display = 'flex';
    } else {
      sidebar.style.display = 'flex';
      thread.style.display = 'flex';
    }
  }

  const feed = document.getElementById('messagesFeed');
  feed.innerHTML = '<div class="h-full flex items-center justify-center text-slate-500 text-xs">Loading messages...</div>';

  try {
    const res = await fetch(`/api/messages/${activeBotId}/${subscriberId}`);
    const json = await res.json();
    if (json.success) {
      activeSubscriber = json.subscriber;
      const status = getOnlineStatusInfo(activeSubscriber.last_interaction, activeSubscriber.is_blocked);
      
      // Update Chat Header with rich Last Seen / Online badge
      document.getElementById('chatUserName').innerText = `${activeSubscriber.first_name || 'User'} ${activeSubscriber.last_name || ''}`;
      document.getElementById('chatUserMeta').innerHTML = `
        <span class="inline-flex items-center gap-1.5 ${status.isOnline ? 'text-emerald-400 font-medium' : 'text-slate-400'}">
          <span class="w-1.5 h-1.5 rounded-full ${status.dotClass}"></span>
          <span>${status.statusText}</span>
        </span>
        <span class="text-slate-600 mx-1">•</span>
        <span class="text-slate-400">@${activeSubscriber.username || 'none'}</span>
        <span class="text-slate-600 mx-1">•</span>
        <span class="text-slate-500 font-mono">ID: ${activeSubscriber.telegram_id}</span>
      `;
      document.getElementById('chatUserAvatar').innerText = (activeSubscriber.first_name || 'U').charAt(0).toUpperCase();

      // Update Block / Unblock Button in Header
      const headerActions = document.getElementById('chatHeaderActions');
      const btnToggleBlock = document.getElementById('btnToggleBlock');
      const btnToggleBlockText = document.getElementById('btnToggleBlockText');
      const blockedBanner = document.getElementById('blockedUserBanner');
      const chatInputText = document.getElementById('chatInputText');
      const btnSendReply = document.getElementById('btnSendReply');

      if (headerActions) headerActions.classList.remove('hidden');

      if (activeSubscriber.is_blocked) {
        btnToggleBlockText.innerText = 'Unblock User';
        btnToggleBlock.className = 'px-2.5 py-1 rounded-lg text-xs font-medium border flex items-center gap-1.5 transition bg-rose-900/40 text-rose-300 border-rose-700 hover:bg-rose-900/70';
        if (blockedBanner) blockedBanner.classList.remove('hidden');
        if (chatInputText) {
          chatInputText.disabled = true;
          chatInputText.placeholder = 'User is blocked. Unblock them to reply...';
        }
        if (btnSendReply) btnSendReply.disabled = true;
      } else {
        btnToggleBlockText.innerText = 'Block User';
        btnToggleBlock.className = 'px-2.5 py-1 rounded-lg text-xs font-medium border flex items-center gap-1.5 transition bg-dark-900 border-slate-700 text-slate-300 hover:text-rose-400 hover:border-rose-700';
        if (blockedBanner) blockedBanner.classList.add('hidden');
        if (chatInputText) {
          chatInputText.disabled = false;
          chatInputText.placeholder = 'Type reply... (Enter to send)';
        }
        if (btnSendReply) btnSendReply.disabled = false;
      }

      // Render Messages
      renderMessagesFeed(json.data);
      lucide.createIcons();
    }
  } catch (e) {
    feed.innerHTML = '<div class="h-full flex items-center justify-center text-rose-400 text-xs">Failed to load chat history.</div>';
  }
}

// Toggle block active chatting user
async function toggleBlockActiveUser() {
  if (!activeSubscriberId) return;
  const isCurrentlyBlocked = activeSubscriber && activeSubscriber.is_blocked;
  const actionName = isCurrentlyBlocked ? 'unblock' : 'block';

  if (!confirm(`Are you sure you want to ${actionName} this user? ${isCurrentlyBlocked ? 'They will be able to message the bot again.' : 'They will NOT be able to message the bot, and will be excluded from all broadcasts.'}`)) {
    return;
  }

  try {
    const res = await fetch(`/api/subscribers/${activeSubscriberId}/toggle-block`, { method: 'POST' });
    const json = await res.json();
    if (json.success) {
      await loadConversations();
      await selectConversation(activeSubscriberId);
      if (currentTab === 'subscribers') await loadSubscribers();
    } else {
      alert('Failed: ' + json.error);
    }
  } catch (err) {
    alert('Error updating user block status');
  }
}

// Toggle block from subscribers table
async function toggleBlockSubscriber(subId, event) {
  if (event) event.stopPropagation();
  try {
    const res = await fetch(`/api/subscribers/${subId}/toggle-block`, { method: 'POST' });
    const json = await res.json();
    if (json.success) {
      await loadSubscribers();
      if (activeSubscriberId === subId) {
        await selectConversation(subId);
      }
      loadConversations();
    } else {
      alert('Failed: ' + json.error);
    }
  } catch (err) {
    alert('Error updating user block status');
  }
}

function renderMessagesFeed(messages) {
  const feed = document.getElementById('messagesFeed');
  if (messages.length === 0) {
    feed.innerHTML = '<div class="h-full flex items-center justify-center text-slate-500 text-xs">No messages yet. Say hi!</div>';
    return;
  }

  feed.innerHTML = messages.map(m => {
    const isOut = m.direction === 'out';
    const time = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    let mediaHtml = '';
    if (m.media_type === 'photo' && m.media_url) {
      mediaHtml = `<img src="${m.media_url}" class="max-w-xs rounded-lg mb-1.5 max-h-60 object-cover" />`;
    }

    return `
      <div class="flex flex-col ${isOut ? 'items-end' : 'items-start'}">
        <div class="max-w-md px-4 py-2.5 rounded-2xl ${isOut ? 'chat-bubble-out' : 'chat-bubble-in'} shadow-md">
          ${mediaHtml}
          <div class="text-xs leading-relaxed whitespace-pre-wrap">${escapeHtml(m.text || '')}</div>
          <div class="text-[9px] opacity-60 text-right mt-1">${time}</div>
        </div>
      </div>
    `;
  }).join('');

  feed.scrollTop = feed.scrollHeight;
}

function appendMessageToFeed(m) {
  const feed = document.getElementById('messagesFeed');
  const isOut = m.direction === 'out';
  const time = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const msgDiv = document.createElement('div');
  msgDiv.className = `flex flex-col ${isOut ? 'items-end' : 'items-start'}`;
  msgDiv.innerHTML = `
    <div class="max-w-md px-4 py-2.5 rounded-2xl ${isOut ? 'chat-bubble-out' : 'chat-bubble-in'} shadow-md">
      <div class="text-xs leading-relaxed whitespace-pre-wrap">${escapeHtml(m.text || '')}</div>
      <div class="text-[9px] opacity-60 text-right mt-1">${time}</div>
    </div>
  `;
  feed.appendChild(msgDiv);
  feed.scrollTop = feed.scrollHeight;
}

async function handleSendMessage(e) {
  e.preventDefault();
  if (!activeBotId || !activeSubscriberId) {
    alert('Please select a conversation first.');
    return;
  }

  const textInput = document.getElementById('chatInputText');
  const text = textInput.value.trim();
  if (!text) return;

  textInput.value = '';
  const btn = document.getElementById('btnSendReply');
  btn.disabled = true;

  try {
    const res = await fetch('/api/messages/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        botId: activeBotId,
        subscriberId: activeSubscriberId,
        text
      })
    });
    const json = await res.json();
    if (!json.success) {
      alert('Failed to send message: ' + (json.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Error sending message');
  } finally {
    btn.disabled = false;
  }
}

// Enter to send
document.getElementById('chatInputText')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSendMessage(e);
  }
});

// ==========================================
// MASS BROADCAST CAMPAIGN
// ==========================================
async function loadBroadcastTab() {
  if (!activeBotId) return;
  loadAudienceCount();
  loadCampaignsList();
}

async function loadAudienceCount() {
  try {
    const res = await fetch(`/api/bots/${activeBotId}/conversations`);
    const json = await res.json();
    if (json.success) {
      const activeCount = json.data.filter(s => !s.is_blocked).length;
      document.getElementById('bcAudienceCount').innerText = activeCount;
    }
  } catch (e) {}
}

let broadcastButtons = [];

function addBroadcastButtonRow() {
  broadcastButtons.push({ text: '', url: '' });
  renderBroadcastButtons();
}

function removeBroadcastButton(index) {
  broadcastButtons.splice(index, 1);
  renderBroadcastButtons();
}

function renderBroadcastButtons() {
  const container = document.getElementById('bcButtonsContainer');
  container.innerHTML = broadcastButtons.map((btn, idx) => `
    <div class="flex items-center gap-2">
      <input type="text" placeholder="Button Text (e.g. Visit Website)" value="${btn.text}" oninput="broadcastButtons[${idx}].text = this.value" class="flex-1 bg-dark-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-brand-500">
      <input type="url" placeholder="https://example.com" value="${btn.url}" oninput="broadcastButtons[${idx}].url = this.value" class="flex-1 bg-dark-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white focus:outline-none focus:border-brand-500">
      <button type="button" onclick="removeBroadcastButton(${idx})" class="text-rose-400 hover:text-rose-300 p-1">
        <i data-lucide="x" class="w-4 h-4"></i>
      </button>
    </div>
  `).join('');
  lucide.createIcons();
}

async function triggerBroadcast() {
  if (!activeBotId) return;
  const text = document.getElementById('bcText').value.trim();
  const title = document.getElementById('bcTitle').value.trim();
  const photo_url = document.getElementById('bcPhotoUrl').value.trim();

  if (!text) {
    alert('Please enter a message to broadcast.');
    return;
  }

  if (!confirm('Are you sure you want to send this broadcast to ALL active subscribers?')) return;

  const validButtons = broadcastButtons.filter(b => b.text.trim() && b.url.trim());
  const btn = document.getElementById('btnStartBroadcast');
  btn.disabled = true;

  try {
    const res = await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        botId: activeBotId,
        title,
        text,
        photo_url,
        buttons: validButtons
      })
    });
    const json = await res.json();
    if (json.success) {
      alert('Broadcast campaign started!');
      document.getElementById('bcText').value = '';
      document.getElementById('bcTitle').value = '';
      document.getElementById('bcPhotoUrl').value = '';
      broadcastButtons = [];
      renderBroadcastButtons();
      loadCampaignsList();
    } else {
      alert('Failed: ' + json.error);
    }
  } catch (e) {
    alert('Failed to launch broadcast');
  } finally {
    btn.disabled = false;
  }
}

async function loadCampaignsList() {
  try {
    const res = await fetch(`/api/campaigns/${activeBotId}`);
    const json = await res.json();
    if (json.success) {
      campaigns = json.data;
      renderCampaignsList();
    }
  } catch (e) {}
}

function renderCampaignsList() {
  const container = document.getElementById('campaignsList');
  if (campaigns.length === 0) {
    container.innerHTML = '<div class="bg-dark-800/50 border border-slate-800 rounded-xl p-6 text-center text-slate-500 text-xs">No broadcast campaigns yet.</div>';
    return;
  }

  container.innerHTML = campaigns.map(c => {
    const pct = c.total_target > 0 ? Math.round((c.total_sent / c.total_target) * 100) : 100;
    const isRunning = c.status === 'running';

    return `
      <div id="campaign-card-${c.id}" class="bg-dark-800 border border-slate-800 rounded-xl p-5 shadow-lg space-y-3">
        <div class="flex items-center justify-between">
          <div>
            <h5 class="font-bold text-sm text-white">${c.title}</h5>
            <span class="text-[11px] text-slate-400">${new Date(c.created_at).toLocaleString()}</span>
          </div>
          <div class="flex items-center gap-2">
            <span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase ${c.status === 'completed' ? 'bg-emerald-900/40 text-emerald-400 border border-emerald-700' : (isRunning ? 'bg-sky-900/40 text-sky-400 border border-sky-700 animate-pulse' : 'bg-slate-700 text-slate-300')}">
              ${c.status}
            </span>
            <button onclick="openCampaignReport(${c.id})" class="bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-300 px-3 py-1 rounded-lg text-xs font-semibold flex items-center gap-1 transition">
              <i data-lucide="bar-chart-2" class="w-3.5 h-3.5"></i> Details
            </button>
          </div>
        </div>

        <p class="text-xs text-slate-300 line-clamp-2 bg-dark-900/50 p-2.5 rounded-lg border border-slate-800/80 font-mono">${escapeHtml(c.text)}</p>

        <!-- Progress Bar -->
        <div class="space-y-1.5">
          <div class="flex justify-between text-[11px] text-slate-400">
            <span>Delivered: <b class="text-emerald-400">${c.total_sent}</b> / ${c.total_target}</span>
            <span>Blocked: <b class="text-rose-400">${c.total_blocked}</b> | Failed: <b class="text-amber-400">${c.total_failed || 0}</b></span>
          </div>
          <div class="w-full bg-dark-900 rounded-full h-2 overflow-hidden border border-slate-800">
            <div class="bg-gradient-to-r from-sky-500 to-indigo-500 h-2 rounded-full transition-all duration-300" style="width: ${pct}%"></div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  lucide.createIcons();
}

function updateCampaignProgressUI(data) {
  loadCampaignsList();
}

// Detailed Campaign Delivery Report Modal
let activeReportRecipients = [];

async function openCampaignReport(campaignId) {
  document.getElementById('modalCampaignReport').classList.remove('hidden');
  const tbody = document.getElementById('reportTableBody');
  tbody.innerHTML = '<tr><td colspan="5" class="p-6 text-center text-slate-400 text-xs">Loading delivery details...</td></tr>';

  try {
    const res = await fetch(`/api/campaigns/${campaignId}/details`);
    const json = await res.json();
    if (json.success) {
      const { campaign, recipients } = json;
      activeReportRecipients = recipients;

      document.getElementById('reportModalTitle').innerText = campaign.title;
      document.getElementById('reportModalDate').innerText = `Sent on ${new Date(campaign.created_at).toLocaleString()}`;
      document.getElementById('reportModalStatus').innerText = campaign.status;

      document.getElementById('reportMetricTarget').innerText = campaign.total_target || recipients.length;
      document.getElementById('reportMetricSent').innerText = campaign.total_sent || 0;
      document.getElementById('reportMetricBlocked').innerText = campaign.total_blocked || 0;
      document.getElementById('reportMetricFailed').innerText = campaign.total_failed || 0;

      renderReportTable(recipients);
    }
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="5" class="p-6 text-center text-rose-400 text-xs">Failed to load report.</td></tr>';
  }
}

function closeCampaignReport() {
  document.getElementById('modalCampaignReport').classList.add('hidden');
}

function renderReportTable(list) {
  const tbody = document.getElementById('reportTableBody');
  if (!list || list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="p-6 text-center text-slate-500 text-xs">No delivery records found for this campaign.</td></tr>';
    return;
  }

  tbody.innerHTML = list.map(r => {
    const isDelivered = r.status === 'delivered';
    const isBlocked = r.status === 'blocked';
    const time = r.delivered_at ? new Date(r.delivered_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-';

    return `
      <tr class="hover:bg-dark-800/50 transition">
        <td class="p-3 font-medium text-white flex items-center gap-2">
          <div class="w-6 h-6 rounded-full bg-gradient-to-tr from-sky-500 to-indigo-600 flex items-center justify-center text-[10px] font-bold text-white">
            ${(r.first_name || 'U').charAt(0).toUpperCase()}
          </div>
          <span>${r.first_name || 'User'}</span>
          <span class="text-slate-500 text-[11px]">${r.username ? '@' + r.username : ''}</span>
        </td>
        <td class="p-3 font-mono text-slate-400 text-[11px]">${r.telegram_id}</td>
        <td class="p-3">
          <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold ${isDelivered ? 'bg-emerald-900/40 text-emerald-400 border border-emerald-800' : (isBlocked ? 'bg-rose-900/40 text-rose-400 border border-rose-800' : 'bg-amber-900/40 text-amber-400 border border-amber-800')}">
            ${isDelivered ? '✅ Delivered' : (isBlocked ? '❌ Blocked' : '⚠️ Failed')}
          </span>
        </td>
        <td class="p-3 text-slate-400 text-[11px]">${time}</td>
        <td class="p-3 text-[11px] text-slate-400 truncate max-w-xs">${r.error_message || 'Successfully sent'}</td>
      </tr>
    `;
  }).join('');
}

function filterReportTable() {
  const q = (document.getElementById('reportSearchInput').value || '').toLowerCase();
  const filtered = activeReportRecipients.filter(r => {
    const full = `${r.first_name} ${r.username} ${r.telegram_id} ${r.status}`.toLowerCase();
    return full.includes(q);
  });
  renderReportTable(filtered);
}

// ==========================================
// MULTI-MESSAGE WELCOME FLOW BUILDER
// ==========================================
let welcomeSteps = [];

async function loadWelcomeTab() {
  if (!activeBotId) return;
  const currentBot = bots.find(b => b.id === activeBotId);
  if (!currentBot) return;

  try {
    welcomeSteps = JSON.parse(currentBot.welcome_flow || '[]');
  } catch (e) {
    welcomeSteps = [];
  }

  // If no sequence steps exist yet, migrate from legacy welcome message
  if (!Array.isArray(welcomeSteps) || welcomeSteps.length === 0) {
    let legacyButtons = [];
    try { legacyButtons = JSON.parse(currentBot.welcome_buttons || '[]'); } catch (e) {}
    
    welcomeSteps = [
      {
        id: Date.now(),
        type: currentBot.welcome_photo ? 'photo' : 'text',
        media_url: currentBot.welcome_photo || '',
        text: currentBot.welcome_message || 'Hello {first_name}! Welcome to our bot 🎉',
        buttons: Array.isArray(legacyButtons) ? legacyButtons : []
      }
    ];
  }

  renderWelcomeSteps();
  renderPreviewFlow();
}

function addWelcomeStep() {
  welcomeSteps.push({
    id: Date.now(),
    type: 'text',
    media_url: '',
    text: '',
    buttons: []
  });
  renderWelcomeSteps();
  renderPreviewFlow();
}

function removeWelcomeStep(idx) {
  if (welcomeSteps.length <= 1) {
    alert('You need at least one welcome message.');
    return;
  }
  welcomeSteps.splice(idx, 1);
  renderWelcomeSteps();
  renderPreviewFlow();
}

function setStepType(idx, type) {
  welcomeSteps[idx].type = type;
  renderWelcomeSteps();
  renderPreviewFlow();
}

function addStepButton(stepIdx) {
  if (!welcomeSteps[stepIdx].buttons) welcomeSteps[stepIdx].buttons = [];
  welcomeSteps[stepIdx].buttons.push({ text: 'Visit Website', url: 'https://' });
  renderWelcomeSteps();
  renderPreviewFlow();
}

function removeStepButton(stepIdx, btnIdx) {
  welcomeSteps[stepIdx].buttons.splice(btnIdx, 1);
  renderWelcomeSteps();
  renderPreviewFlow();
}

async function handleStepFileUpload(idx, input) {
  const file = input.files[0];
  if (!file) return;

  const step = welcomeSteps[idx];
  const originalText = step.text;
  
  const statusEl = document.getElementById(`upload-status-${idx}`);
  if (statusEl) {
    statusEl.innerHTML = '<span class="text-amber-400 animate-pulse">⏳ Uploading file...</span>';
    statusEl.classList.remove('hidden');
  }

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });
    const json = await res.json();
    if (json.success) {
      step.media_url = json.fileUrl;
      step.fileName = json.fileName;
      if (statusEl) {
        statusEl.innerHTML = `<span class="text-emerald-400">✅ Uploaded: <b>${json.fileName}</b> (${Math.round(json.size / 1024)} KB)</span>`;
      }
      renderWelcomeSteps();
      renderPreviewFlow();
    } else {
      alert('Upload failed: ' + json.error);
      if (statusEl) statusEl.classList.add('hidden');
    }
  } catch (err) {
    alert('Failed to upload file');
    if (statusEl) statusEl.classList.add('hidden');
  }
}

async function handleBroadcastFileUpload(input) {
  const file = input.files[0];
  if (!file) return;

  const statusEl = document.getElementById('bcUploadStatus');
  if (statusEl) {
    statusEl.innerHTML = '<span class="text-amber-400 animate-pulse">⏳ Uploading file...</span>';
    statusEl.classList.remove('hidden');
  }

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });
    const json = await res.json();
    if (json.success) {
      document.getElementById('bcPhotoUrl').value = json.fileUrl;
      if (statusEl) {
        statusEl.innerHTML = `<span class="text-emerald-400">✅ File Ready: <b>${json.fileName}</b> (${Math.round(json.size / 1024)} KB)</span>`;
      }
    } else {
      alert('Upload failed: ' + json.error);
      if (statusEl) statusEl.classList.add('hidden');
    }
  } catch (err) {
    alert('Failed to upload file');
    if (statusEl) statusEl.classList.add('hidden');
  }
}

function renderWelcomeSteps() {
  const container = document.getElementById('welcomeStepsContainer');
  if (!container) return;

  container.innerHTML = welcomeSteps.map((step, idx) => {
    const isPhoto = step.type === 'photo';
    const isDoc = step.type === 'document' || step.type === 'pdf';
    const isText = step.type === 'text';
    const buttons = step.buttons || [];
    const hasFile = step.media_url && step.media_url.trim().length > 0;
    const displayName = step.fileName || (step.media_url ? step.media_url.split('/').pop().split('?')[0] : '');

    return `
      <div class="bg-dark-800 border border-slate-700/80 rounded-2xl p-5 shadow-xl space-y-4 relative">
        <!-- Step Header -->
        <div class="flex items-center justify-between border-b border-slate-700/60 pb-3">
          <div class="flex items-center gap-2">
            <span class="w-6 h-6 rounded-full bg-indigo-600/30 text-indigo-400 font-bold text-xs flex items-center justify-center border border-indigo-500/30">
              ${idx + 1}
            </span>
            <h4 class="text-sm font-semibold text-white">Message #${idx + 1}</h4>
          </div>

          <!-- Type Selector Pills -->
          <div class="flex items-center gap-1.5 bg-dark-900 p-1 rounded-xl border border-slate-700">
            <button type="button" onclick="setStepType(${idx}, 'text')" class="px-2.5 py-1 rounded-lg text-xs font-medium transition ${isText ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'}">
              📝 Text
            </button>
            <button type="button" onclick="setStepType(${idx}, 'photo')" class="px-2.5 py-1 rounded-lg text-xs font-medium transition ${isPhoto ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-white'}">
              🖼️ Image
            </button>
            <button type="button" onclick="setStepType(${idx}, 'document')" class="px-2.5 py-1 rounded-lg text-xs font-medium transition ${isDoc ? 'bg-amber-600 text-white' : 'text-slate-400 hover:text-white'}">
              📄 PDF / Document
            </button>
          </div>

          <button type="button" onclick="removeWelcomeStep(${idx})" class="text-rose-400 hover:text-rose-300 p-1 text-xs flex items-center gap-1">
            <i data-lucide="trash-2" class="w-4 h-4"></i>
          </button>
        </div>

        <!-- Direct File Upload Box (If Image or Document) -->
        ${(isPhoto || isDoc) ? `
          <div class="bg-dark-900/90 border border-slate-700/80 rounded-xl p-4 space-y-3">
            <div class="flex items-center justify-between">
              <label class="block text-xs font-semibold ${isPhoto ? 'text-sky-400' : 'text-amber-400'}">
                ${isPhoto ? '🖼️ Upload Image File' : '📄 Upload PDF / Document File'}
              </label>
              <span class="text-[10px] text-slate-400">Directly from your PC / Phone</span>
            </div>

            <div class="flex items-center gap-3">
              <label class="cursor-pointer bg-dark-800 hover:bg-slate-700 border border-slate-600 px-4 py-2 rounded-xl text-xs font-medium text-white flex items-center gap-2 shadow transition">
                <i data-lucide="upload" class="w-3.5 h-3.5 text-sky-400"></i>
                <span>${hasFile ? '📁 Change File' : '📁 Choose File to Upload'}</span>
                <input type="file" accept="${isPhoto ? 'image/*' : '.pdf,.doc,.docx,.txt,.zip'}" onchange="handleStepFileUpload(${idx}, this)" class="hidden">
              </label>

              <div id="upload-status-${idx}" class="text-xs truncate flex-1 ${hasFile ? '' : 'hidden'}">
                ${hasFile ? `<span class="text-emerald-400 font-medium truncate block">✅ Ready: <b>${displayName}</b></span>` : ''}
              </div>
            </div>
          </div>
        ` : ''}

        <!-- Message / Caption Text -->
        <div>
          <div class="flex items-center justify-between mb-1">
            <label class="block text-[11px] font-medium text-slate-300">
              ${(isPhoto || isDoc) ? 'Caption Text (Optional)' : 'Message Text'}
            </label>
            <span class="text-[10px] text-slate-400">Use <code class="text-sky-400">{first_name}</code></span>
          </div>
          <textarea rows="3" placeholder="${(isPhoto || isDoc) ? 'Add a caption for this file...' : 'Type your message here...'}" oninput="welcomeSteps[${idx}].text = this.value; renderPreviewFlow();" class="w-full bg-dark-900 border border-slate-700 rounded-lg p-2.5 text-xs text-white focus:outline-none focus:border-brand-500 font-mono">${escapeHtml(step.text || '')}</textarea>
        </div>

        <!-- Inline Buttons for this step -->
        <div class="space-y-2 pt-1 border-t border-slate-800">
          <div class="flex items-center justify-between">
            <label class="block text-[11px] font-medium text-slate-400">Interactive Buttons (Optional)</label>
            <button type="button" onclick="addStepButton(${idx})" class="text-[11px] text-sky-400 hover:text-sky-300 flex items-center gap-1 font-medium">
              <i data-lucide="plus" class="w-3 h-3"></i> Add Button
            </button>
          </div>

          <div class="space-y-1.5">
            ${buttons.map((btn, bIdx) => `
              <div class="flex items-center gap-2">
                <input type="text" placeholder="Button Text" value="${btn.text || ''}" oninput="welcomeSteps[${idx}].buttons[${bIdx}].text = this.value; renderPreviewFlow();" class="flex-1 bg-dark-900 border border-slate-700 rounded-lg px-2.5 py-1 text-xs text-white focus:outline-none focus:border-brand-500">
                <input type="url" placeholder="https://example.com" value="${btn.url || ''}" oninput="welcomeSteps[${idx}].buttons[${bIdx}].url = this.value; renderPreviewFlow();" class="flex-1 bg-dark-900 border border-slate-700 rounded-lg px-2.5 py-1 text-xs text-white focus:outline-none focus:border-brand-500">
                <button type="button" onclick="removeStepButton(${idx}, ${bIdx})" class="text-rose-400 hover:text-rose-300 p-1">
                  <i data-lucide="x" class="w-3.5 h-3.5"></i>
                </button>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;
  }).join('');

  lucide.createIcons();
}

function renderPreviewFlow() {
  const container = document.getElementById('previewFlowFeed');
  if (!container) return;

  if (welcomeSteps.length === 0) {
    container.innerHTML = '<div class="p-6 text-center text-slate-400 text-xs">No welcome messages configured.</div>';
    return;
  }

  container.innerHTML = welcomeSteps.map((step, idx) => {
    const isPhoto = step.type === 'photo';
    const isDoc = step.type === 'document' || step.type === 'pdf';
    const text = (step.text || '').replace(/{first_name}/g, 'Rahul').replace(/{username}/g, '@rahul123');
    const buttons = step.buttons || [];

    let mediaBadge = '';
    if (isPhoto && step.media_url) {
      mediaBadge = `
        <div class="rounded-lg overflow-hidden max-h-40 border border-slate-700 mb-2">
          <img src="${step.media_url}" alt="Image preview" class="w-full h-full object-cover" onerror="this.src='https://placehold.co/400x200?text=Invalid+Image+URL'">
        </div>
      `;
    } else if (isDoc) {
      mediaBadge = `
        <div class="bg-[#1e2c3a] border border-slate-600/50 rounded-lg p-2.5 mb-2 flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center shrink-0">
            <i data-lucide="file-text" class="w-4 h-4"></i>
          </div>
          <div class="flex-1 min-w-0">
            <span class="text-xs font-semibold text-white truncate block">${step.media_url ? step.media_url.split('/').pop().split('?')[0] || 'Document.pdf' : 'Document.pdf'}</span>
            <span class="text-[10px] text-slate-400">PDF / Document</span>
          </div>
        </div>
      `;
    }

    let buttonsHtml = '';
    if (buttons.length > 0) {
      buttonsHtml = `
        <div class="space-y-1 pt-2 border-t border-slate-700/40 mt-2">
          ${buttons.map(b => `
            <div class="w-full bg-[#2b5278] hover:bg-[#346290] text-center text-[11px] text-sky-200 font-medium py-1.5 rounded-lg flex items-center justify-center gap-1">
              <span>${b.text || 'Button'}</span>
              <i data-lucide="external-link" class="w-2.5 h-2.5 text-sky-300"></i>
            </div>
          `).join('')}
        </div>
      `;
    }

    return `
      <div class="bg-[#242f3d] rounded-xl p-3 border border-slate-700/40 shadow-sm space-y-1">
        <div class="flex items-center justify-between text-[9px] text-sky-400 font-mono font-bold uppercase tracking-wider mb-1">
          <span>Msg #${idx + 1} • ${step.type}</span>
        </div>
        ${mediaBadge}
        ${text ? `<div class="text-xs text-slate-100 whitespace-pre-line leading-relaxed font-sans">${escapeHtml(text)}</div>` : ''}
        ${buttonsHtml}
      </div>
    `;
  }).join('');

  lucide.createIcons();
}

async function saveWelcomeSettings() {
  if (!activeBotId) return;

  // Clean steps
  const validSteps = welcomeSteps.map(s => ({
    id: s.id || Date.now(),
    type: s.type || 'text',
    media_url: (s.media_url || '').trim(),
    text: (s.text || '').trim(),
    buttons: (s.buttons || []).filter(b => b && b.text && b.text.trim())
  }));

  try {
    const res = await fetch(`/api/bots/${activeBotId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        welcome_flow: validSteps,
        welcome_message: validSteps[0]?.text || '',
        welcome_photo: validSteps[0]?.type === 'photo' ? validSteps[0]?.media_url : '',
        welcome_buttons: validSteps[0]?.buttons || []
      })
    });
    const json = await res.json();
    if (json.success) {
      alert('Welcome message sequence saved successfully!');
      await loadBots();
    } else {
      alert('Failed: ' + json.error);
    }
  } catch (e) {
    alert('Failed to save settings');
  }
}

// ==========================================
// SUBSCRIBERS TABLE
// ==========================================
async function loadSubscribers() {
  if (!activeBotId) return;
  try {
    const res = await fetch(`/api/bots/${activeBotId}/conversations`);
    const json = await res.json();
    if (json.success) {
      subscribersList = json.data;
      renderSubscribersTable(subscribersList);
    }
  } catch (e) {}
}

function renderSubscribersTable(list) {
  const tbody = document.getElementById('subscribersTableBody');
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="p-6 text-center text-slate-500 text-xs">No subscribers found for this bot.</td></tr>';
    return;
  }

  tbody.innerHTML = list.map(s => {
    const status = getOnlineStatusInfo(s.last_interaction, s.is_blocked);
    const fullDate = s.last_interaction ? new Date(s.last_interaction).toLocaleString() : 'Never';

    return `
      <tr class="hover:bg-dark-900/40 transition">
        <td class="p-3.5 font-medium text-white flex items-center gap-2.5">
          <div class="relative shrink-0">
            <div class="w-7 h-7 rounded-full bg-gradient-to-tr from-sky-500 to-indigo-600 flex items-center justify-center text-[10px] font-bold text-white">
              ${(s.first_name || 'U').charAt(0).toUpperCase()}
            </div>
            <span class="w-2 h-2 rounded-full ${status.dotClass} absolute -bottom-0.5 -right-0.5 border-2 border-dark-900" title="${status.statusText}"></span>
          </div>
          <span class="truncate">${s.first_name || ''} ${s.last_name || ''}</span>
        </td>
        <td class="p-3.5 font-mono text-slate-400">${s.telegram_id}</td>
        <td class="p-3.5 text-sky-400">${s.username ? `@${s.username}` : '-'}</td>
        <td class="p-3.5">
          <span class="px-2 py-0.5 rounded-full text-[10px] font-semibold ${s.is_blocked ? 'bg-rose-900/40 text-rose-400 border border-rose-800' : 'bg-emerald-900/40 text-emerald-400 border border-emerald-800'}">
            ${s.is_blocked ? '🚫 Blocked' : '✅ Active'}
          </span>
        </td>
        <td class="p-3.5">
          <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border ${status.badgeClass}" title="Last Activity: ${fullDate}">
            <span class="w-1.5 h-1.5 rounded-full ${status.dotClass}"></span>
            <span>${status.statusText}</span>
          </span>
        </td>
        <td class="p-3.5 text-right">
          <div class="inline-flex items-center gap-2">
            <button onclick="toggleBlockSubscriber(${s.id}, event)" class="px-2.5 py-1 rounded-lg text-[11px] font-medium border transition ${s.is_blocked ? 'bg-rose-900/30 text-rose-300 border-rose-700 hover:bg-rose-900/60' : 'bg-dark-800 text-slate-400 border-slate-700 hover:text-rose-400 hover:border-rose-700'}">
              ${s.is_blocked ? 'Unblock' : 'Block'}
            </button>
            <button onclick="selectConversation(${s.id}); switchTab('inbox');" class="bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-400 px-3 py-1 rounded-lg text-[11px] font-medium transition">
              Chat
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function filterSubscribersTable() {
  const q = document.getElementById('subSearchInput').value.toLowerCase();
  const filtered = subscribersList.filter(s => {
    const full = `${s.first_name} ${s.last_name} ${s.username} ${s.telegram_id}`.toLowerCase();
    return full.includes(q);
  });
  renderSubscribersTable(filtered);
}

// ==========================================
// IMPORT SUBSCRIBERS MODAL (SendPulse)
// ==========================================
function openImportModal() {
  document.getElementById('modalImport').classList.remove('hidden');
  document.getElementById('importResultMsg').classList.add('hidden');
  document.getElementById('importRawData').value = '';
}

function closeImportModal() {
  document.getElementById('modalImport').classList.add('hidden');
}

async function submitImport() {
  const botId = document.getElementById('importBotSelect').value;
  const raw = document.getElementById('importRawData').value.trim();
  const msgDiv = document.getElementById('importResultMsg');
  const btn = document.getElementById('btnSubmitImport');

  if (!botId || !raw) {
    alert('Please select a bot and paste subscriber data.');
    return;
  }

  // Parse lines: handles CSV formats (id, first_name, username) or raw IDs
  const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const subscribers = [];

  for (const line of lines) {
    if (line.toLowerCase().startsWith('telegram_id') || line.toLowerCase().startsWith('id')) continue; // skip header
    const parts = line.split(/[,\t]/).map(p => p.trim());
    const telegram_id = parts[0];
    const first_name = parts[1] || '';
    const username = parts[2] || '';
    if (telegram_id) {
      subscribers.push({ telegram_id, first_name, username });
    }
  }

  if (subscribers.length === 0) {
    alert('No valid subscribers found in input.');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = 'Importing...';

  try {
    const res = await fetch('/api/subscribers/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botId, subscribers })
    });
    const json = await res.json();
    if (json.success) {
      msgDiv.className = 'p-3 bg-emerald-900/30 border border-emerald-700 text-emerald-300 rounded-lg text-xs';
      msgDiv.innerText = `Successfully imported ${json.importedCount} subscribers!`;
      msgDiv.classList.remove('hidden');
      loadSubscribers();
      loadConversations();
    } else {
      msgDiv.className = 'p-3 bg-rose-900/30 border border-rose-700 text-rose-300 rounded-lg text-xs';
      msgDiv.innerText = json.error || 'Import failed';
      msgDiv.classList.remove('hidden');
    }
  } catch (e) {
    alert('Failed to process import');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Start Import';
  }
}

// Helper
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
