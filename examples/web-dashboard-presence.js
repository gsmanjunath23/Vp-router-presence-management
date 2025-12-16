/**
 * WEB DASHBOARD - Presence Example
 * 
 * Web clients:
 * - DO NOT send heartbeat
 * - Receive initial snapshot of online users on connect
 * - Listen for real-time presence updates
 * - Update UI when users go online/offline
 */

const WebSocket = require('ws');
const notepack = require('notepack');

class WebPresenceDashboard {
  constructor(wsUrl, jwtToken) {
    this.wsUrl = wsUrl;
    this.token = jwtToken;
    this.ws = null;
    this.onlineUsers = new Map();
    this.connected = false;
  }

  connect() {
    // Connect with JWT token (role should be 'web' or 'dashboard' in token)
    this.ws = new WebSocket(this.wsUrl, {
      headers: {
        'token': this.token,
        'device_id': 'web-dashboard-001'
      }
    });

    this.ws.on('open', () => {
      console.log('✅ Connected to VoicePing Router');
      console.log('📡 Waiting for presence snapshot...');
      this.connected = true;
    });

    this.ws.on('message', (data) => {
      this.handleMessage(data);
    });

    this.ws.on('error', (error) => {
      console.error('❌ WebSocket error:', error);
    });

    this.ws.on('close', () => {
      console.log('🔌 Disconnected from server');
      this.connected = false;
      
      // Reconnect after 5 seconds
      setTimeout(() => this.connect(), 5000);
    });
  }

  handleMessage(data) {
    try {
      const decoded = notepack.decode(data);
      const messageType = decoded[1];

      switch (messageType) {
        case 32: // PRESENCE_SNAPSHOT
          this.handlePresenceSnapshot(decoded[5]);
          break;
        case 31: // PRESENCE_UPDATE
          this.handlePresenceUpdate(decoded[5]);
          break;
        default:
          console.log('📨 Received message type:', messageType);
      }
    } catch (err) {
      console.error('Error decoding message:', err);
    }
  }

  handlePresenceSnapshot(snapshot) {
    console.log('\n📸 Received presence snapshot');
    console.log(`   Total online users: ${snapshot.totalOnline}`);
    console.log(`   Timestamp: ${new Date(snapshot.timestamp).toLocaleString()}`);
    
    // Clear existing list
    this.onlineUsers.clear();
    
    // Populate with all online users
    snapshot.users.forEach(user => {
      this.onlineUsers.set(user.userId, {
        userId: user.userId,
        status: user.status,
        lastSeen: user.lastSeen,
        deviceId: user.deviceId
      });
    });

    this.displayOnlineUsers();
  }

  handlePresenceUpdate(update) {
    const { userId, status, lastSeen, deviceId } = update;
    
    if (status === 'online') {
      // User came online
      this.onlineUsers.set(userId, {
        userId,
        status,
        lastSeen: lastSeen || Date.now(),
        deviceId
      });
      console.log(`\n✅ ${userId} came online`);
      this.showNotification(`${userId} is now online`, 'online');
    } else if (status === 'offline') {
      // User went offline
      this.onlineUsers.delete(userId);
      console.log(`\n❌ ${userId} went offline`);
      this.showNotification(`${userId} is now offline`, 'offline');
    }

    this.displayOnlineUsers();
  }

  displayOnlineUsers() {
    console.log('\n👥 Currently Online Users:');
    console.log('─'.repeat(70));
    
    if (this.onlineUsers.size === 0) {
      console.log('   No users online');
    } else {
      this.onlineUsers.forEach((user, userId) => {
        const lastSeenDate = new Date(user.lastSeen);
        const timeAgo = this.getTimeAgo(user.lastSeen);
        console.log(`   🟢 ${userId.padEnd(20)} | Last seen: ${timeAgo.padEnd(20)} | Device: ${user.deviceId || 'N/A'}`);
      });
    }
    
    console.log('─'.repeat(70));
    console.log(`   Total: ${this.onlineUsers.size} users online\n`);
  }

  showNotification(message, type) {
    const emoji = type === 'online' ? '🟢' : '🔴';
    console.log(`\n${emoji} NOTIFICATION: ${message}`);
  }

  getTimeAgo(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;
    
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (seconds < 60) {
      return `${seconds}s ago`;
    } else if (minutes < 60) {
      return `${minutes}m ago`;
    } else {
      return `${hours}h ago`;
    }
  }

  getOnlineUsersList() {
    return Array.from(this.onlineUsers.values());
  }

  isUserOnline(userId) {
    return this.onlineUsers.has(userId);
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

// USAGE EXAMPLE FOR WEB DASHBOARD
const dashboard = new WebPresenceDashboard(
  'ws://localhost:3000',
  'web-admin-token' // JWT token with role='web' or 'dashboard'
);

dashboard.connect();

// Example: Check if specific user is online
setInterval(() => {
  const userToCheck = 'user123';
  const isOnline = dashboard.isUserOnline(userToCheck);
  // console.log(`User ${userToCheck} is ${isOnline ? 'ONLINE' : 'OFFLINE'}`);
}, 10000);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down dashboard...');
  dashboard.disconnect();
  process.exit(0);
});
