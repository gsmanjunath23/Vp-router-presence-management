/**
 * MOBILE CLIENT - Presence Example
 * 
 * Mobile clients:
 * - Send heartbeat every 30 seconds
 * - Maintain online status via Redis TTL
 * - Can fetch presence status of other users via HTTP API
 */

const WebSocket = require('ws');
const notepack = require('notepack');
const axios = require('axios');

class MobilePresenceClient {
  constructor(wsUrl, apiUrl, jwtToken) {
    this.wsUrl = wsUrl;
    this.apiUrl = apiUrl;
    this.token = jwtToken;
    this.ws = null;
    this.heartbeatInterval = null;
    this.userId = null;
  }

  connect() {
    // Connect with JWT token in headers
    this.ws = new WebSocket(this.wsUrl, {
      headers: {
        'token': this.token,
        'device_id': 'mobile-device-123'
      }
    });

    this.ws.on('open', () => {
      console.log('✅ Connected to VoicePing Router');
      
      // Extract userId from token (in production, decode JWT properly)
      this.userId = this.extractUserIdFromToken(this.token);
      
      // Start sending heartbeats
      this.startHeartbeat();
    });

    this.ws.on('message', (data) => {
      this.handleMessage(data);
    });

    this.ws.on('error', (error) => {
      console.error('❌ WebSocket error:', error);
    });

    this.ws.on('close', () => {
      console.log('🔌 Disconnected');
      this.stopHeartbeat();
      
      // Reconnect after 5 seconds
      setTimeout(() => this.connect(), 5000);
    });
  }

  startHeartbeat() {
    // Send heartbeat every 30 seconds
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, 30000);

    // Send first heartbeat immediately
    this.sendHeartbeat();
  }

  sendHeartbeat() {
    const message = {
      messageType: 30, // HEARTBEAT
      channelType: 0,
      fromId: this.userId,
      toId: 0,
      payload: {
        type: 'heartbeat',
        timestamp: Date.now(),
        metadata: {
          battery: 85,
          networkType: 'wifi',
          appVersion: '2.1.0'
        }
      }
    };

    const packed = notepack.encode([
      message.channelType,
      message.messageType,
      message.fromId,
      message.toId,
      message.payload
    ]);

    this.ws.send(packed);
    console.log('💓 Heartbeat sent');
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  handleMessage(data) {
    try {
      const decoded = notepack.decode(data);
      const messageType = decoded[1];

      switch (messageType) {
        case 31: // PRESENCE_UPDATE
          this.handlePresenceUpdate(decoded[5]);
          break;
        case 3: // AUDIO
          console.log('🎤 Received audio message');
          break;
        default:
          console.log('📨 Received message type:', messageType);
      }
    } catch (err) {
      console.error('Error decoding message:', err);
    }
  }

  handlePresenceUpdate(payload) {
    console.log('👤 Presence update:', payload);
    // Update local presence state
    if (payload.status === 'online') {
      console.log(`✅ User ${payload.userId} came online`);
    } else {
      console.log(`❌ User ${payload.userId} went offline`);
    }
  }

  // Fetch presence status for multiple users via HTTP API
  async fetchPresenceStatus(userIds) {
    try {
      const response = await axios.post(`${this.apiUrl}/api/presence/status`, {
        userIds: userIds
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        }
      });

      console.log('📊 Presence status:', response.data);
      return response.data.users;
    } catch (error) {
      console.error('Failed to fetch presence status:', error.message);
      return [];
    }
  }

  extractUserIdFromToken(token) {
    // In production, decode JWT properly
    // For demo, just return the token as userId
    return token;
  }

  disconnect() {
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
    }
  }
}

// USAGE EXAMPLE
const client = new MobilePresenceClient(
  'ws://localhost:3000',
  'http://localhost:3000',
  'user123' // JWT token (in production, use real JWT)
);

client.connect();

// Example: Fetch presence status for team members when user opens a group
setTimeout(async () => {
  console.log('\n🔍 Fetching presence status for team members...');
  const teamUserIds = ['user456', 'user789', 'user101'];
  const statuses = await client.fetchPresenceStatus(teamUserIds);
  
  statuses.forEach(user => {
    console.log(`  ${user.userId}: ${user.status} (last seen: ${new Date(user.lastSeen).toLocaleString()})`);
  });
}, 5000);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  client.disconnect();
  process.exit(0);
});
