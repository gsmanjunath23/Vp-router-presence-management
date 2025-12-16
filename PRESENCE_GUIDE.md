# VoicePing Router - Presence System Guide

## Overview

This guide explains how to use the presence management system in VoicePing Router to track and display online/offline status of users in real-time.

**Features:**
- ✅ Real-time presence tracking (online/offline status)
- ✅ Automatic detection using existing WebSocket ping/pong
- ✅ Redis-based storage with TTL expiration
- ✅ Multi-server synchronization via Redis Pub/Sub
- ✅ HTTP API for bulk status queries
- ✅ WebSocket events for real-time updates
- ✅ No mobile app changes required

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Configuration](#configuration)
3. [Mobile App Integration](#mobile-app-integration)
4. [Web Dashboard Integration](#web-dashboard-integration)
5. [HTTP API Reference](#http-api-reference)
6. [WebSocket Events Reference](#websocket-events-reference)
7. [Testing](#testing)
8. [Troubleshooting](#troubleshooting)

---

## Architecture Overview

### How It Works

```
Mobile App          VoicePing Router              Redis              Web Dashboard
    |                      |                         |                      |
    |--CONNECT------------>|                         |                      |
    |                      |--SET presence:123------>|                      |
    |                      |  (TTL=360s)             |                      |
    |                      |                         |                      |
    |                      |--PUBLISH------------->  |                      |
    |                      |  presence:online        |                      |
    |                      |                         |                      |
    |<----PING-------------|                         |                      |
    |-----PONG------------>|                         |                      |
    |                      |--REFRESH TTL---------->|                      |
    |                      |  (reset to 360s)        |                      |
    |                      |                         |                      |
    |  (every 2 minutes)   |                         |                      |
    |                      |                         |                      |
    |--DISCONNECT--------->|                         |                      |
    |                      |--DEL presence:123------>|                      |
    |                      |                         |                      |
    |                      |--PUBLISH--------------->|                      |
    |                      |  presence:offline       |                      |
    |                      |                         |                      |
    |                      |                         |<--SUBSCRIBE---------|
    |                      |                         |   presence:updates   |
    |                      |                         |                      |
    |                      |                         |--NOTIFY------------->|
    |                      |                         |  {userId:123,        |
    |                      |                         |   status:'offline'}  |
```

### Detection Mechanism

**Using Existing PING/PONG:**
- Server sends PING every **2 minutes** (120 seconds)
- Mobile responds with PONG
- Each PONG refreshes the Redis TTL back to **6 minutes** (360 seconds)
- If mobile disconnects/crashes and stops responding:
  - TTL counts down from 360 → 0
  - After ~6 minutes, Redis key expires
  - User automatically marked offline

**Timing:**
- **Online detection**: Immediate (when user connects)
- **Offline detection**: Up to 6 minutes after last PONG

---

## Configuration

### Environment Variables

Add these to your `.env` file:

```bash
# Presence Configuration
PRESENCE_ENABLED=true           # Enable/disable presence system (default: true)
PRESENCE_TTL=360                # Time in seconds before marking offline (default: 360 = 6 minutes)
PING_INTERVAL=120000            # Ping interval in milliseconds (default: 120000 = 2 minutes)

# Redis Configuration (required for presence)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=                 # Leave empty if no password

# Server Configuration
PORT=3000
USE_AUTHENTICATION=false        # Set to true if using JWT auth
SECRET_KEY=your-secret-key      # Required if USE_AUTHENTICATION=true
```

### Adjusting Detection Speed

If you need faster offline detection, you can adjust the TTL:

```bash
# Faster detection (4 minutes)
PRESENCE_TTL=240

# Even faster (3 minutes) - but may have false positives on slow networks
PRESENCE_TTL=180
```

**⚠️ Important:** `PRESENCE_TTL` should be at least **2x** the `PING_INTERVAL` to avoid false offline detections due to network delays.

**Recommended formula:** `PRESENCE_TTL = PING_INTERVAL * 3`

---

## Mobile App Integration

### Overview

**Good news:** Mobile apps don't need any changes! The presence system uses the existing WebSocket connection and PING/PONG mechanism.

### What Happens Automatically

When your mobile app connects to VoicePing Router:

1. **Connection established** → User marked as **online** immediately
2. **Server sends PING every 2 minutes** → Mobile responds with PONG (handled by WebSocket library)
3. **Each PONG received** → Presence TTL refreshed (stays online)
4. **Connection closed** → User marked as **offline** immediately
5. **Connection lost/crashed** → User marked offline after 6 minutes (when TTL expires)

### Current Android SDK Usage

Your existing Android SDK code already handles everything:

```java
// Standard VoicePing SDK connection - no changes needed
VoicePingClient client = new VoicePingClient(serverUrl, userId, companyName);
client.connect();

// That's it! Presence tracking happens automatically
```

### Optional: Enable Faster Detection (Future Enhancement)

If you want faster offline detection (90 seconds instead of 6 minutes), the mobile SDK can send explicit heartbeat messages:

```java
// Optional: Send heartbeat every 30 seconds for faster detection
Timer heartbeatTimer = new Timer();
heartbeatTimer.scheduleAtFixedRate(new TimerTask() {
    @Override
    public void run() {
        if (client.isConnected()) {
            client.sendHeartbeat(); // Send MessageType.HEARTBEAT (30)
        }
    }
}, 0, 30000); // Every 30 seconds
```

**If implementing heartbeats, update server config:**
```bash
PRESENCE_TTL=90  # 3x the heartbeat interval (30s * 3 = 90s)
```

---

## Web Dashboard Integration

### Overview

Web dashboards can:
1. Query bulk user presence status via HTTP API
2. Subscribe to real-time presence updates via WebSocket
3. Display online/offline indicators

### Option 1: HTTP API (For Initial Load / Bulk Queries)

Use this when:
- Dashboard first loads
- User joins a new group
- Need to check status of many users at once

```javascript
// Fetch presence status for multiple users
async function fetchUserPresence(userIds) {
  const response = await fetch('http://your-router-url:3000/api/presence/status', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      userIds: userIds  // Array of user IDs, e.g., ['123', '456', '789']
    })
  });
  
  const data = await response.json();
  return data;
}

// Example usage
const userIds = ['123', '456', '789', '1011'];
const presenceData = await fetchUserPresence(userIds);

console.log(presenceData);
// Output:
// {
//   "123": {
//     "userId": "123",
//     "status": "online",
//     "lastSeen": "2025-12-12T10:30:45.123Z"
//   },
//   "456": {
//     "userId": "456",
//     "status": "offline",
//     "lastSeen": "2025-12-12T09:15:22.456Z"
//   },
//   "789": {
//     "userId": "789",
//     "status": "online",
//     "lastSeen": "2025-12-12T10:31:02.789Z"
//   },
//   "1011": {
//     "userId": "1011",
//     "status": "offline",
//     "lastSeen": null
//   }
// }
```

### Option 2: WebSocket (For Real-Time Updates)

Use this for:
- Real-time presence updates
- Show when users go online/offline instantly
- Update UI without polling

```javascript
// Connect to VoicePing Router
const ws = new WebSocket('ws://your-router-url:3000', ['web_dashboard_token', 'device_id']);

ws.onopen = () => {
  console.log('Connected to VoicePing Router');
};

ws.onmessage = (event) => {
  const buffer = event.data;
  
  // Decode MessagePack message
  const msg = msgpack.decode(new Uint8Array(buffer));
  
  // Check for presence update messages
  if (msg.messageType === 31) { // PRESENCE_UPDATE
    handlePresenceUpdate(msg);
  }
};

function handlePresenceUpdate(msg) {
  const userId = msg.fromId;
  const status = msg.status;      // 'online' or 'offline'
  const timestamp = msg.timestamp;
  
  console.log(`User ${userId} is now ${status} (at ${timestamp})`);
  
  // Update UI
  updateUserStatusInUI(userId, status);
}

function updateUserStatusInUI(userId, status) {
  const userElement = document.getElementById(`user-${userId}`);
  if (userElement) {
    const indicator = userElement.querySelector('.status-indicator');
    indicator.className = `status-indicator ${status}`;
    indicator.textContent = status;
  }
}
```

### Complete Web Dashboard Example

```html
<!DOCTYPE html>
<html>
<head>
  <title>VoicePing Presence Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/@msgpack/msgpack@2.7.1/dist.es5+umd/msgpack.min.js"></script>
  <style>
    .user-card {
      border: 1px solid #ddd;
      padding: 10px;
      margin: 5px;
      border-radius: 5px;
    }
    .status-indicator {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      margin-right: 5px;
    }
    .status-indicator.online {
      background-color: #4CAF50;
    }
    .status-indicator.offline {
      background-color: #9E9E9E;
    }
  </style>
</head>
<body>
  <h1>VoicePing Presence Dashboard</h1>
  
  <div id="users-container"></div>

  <script>
    const ROUTER_URL = 'ws://localhost:3000';
    const ROUTER_HTTP = 'http://localhost:3000';
    const TOKEN = 'dashboard_token_123';
    const DEVICE_ID = 'web_dashboard_1';
    
    let ws;
    let userStatuses = {};

    // Initialize
    async function init() {
      // 1. Fetch initial presence data via HTTP
      const groupUserIds = ['123', '456', '789', '1011', '1213'];
      await loadInitialPresence(groupUserIds);
      
      // 2. Connect WebSocket for real-time updates
      connectWebSocket();
    }

    // Load initial presence via HTTP API
    async function loadInitialPresence(userIds) {
      try {
        const response = await fetch(`${ROUTER_HTTP}/api/presence/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userIds })
        });
        
        const data = await response.json();
        userStatuses = data;
        
        // Render UI
        renderUsers();
      } catch (error) {
        console.error('Failed to fetch initial presence:', error);
      }
    }

    // Connect to WebSocket for real-time updates
    function connectWebSocket() {
      ws = new WebSocket(ROUTER_URL, [TOKEN, DEVICE_ID]);
      
      ws.onopen = () => {
        console.log('WebSocket connected');
      };
      
      ws.onmessage = (event) => {
        const buffer = event.data;
        const msg = MessagePack.decode(new Uint8Array(buffer));
        
        // Handle presence updates (MessageType.PRESENCE_UPDATE = 31)
        if (msg.messageType === 31) {
          handlePresenceUpdate(msg);
        }
      };
      
      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };
      
      ws.onclose = () => {
        console.log('WebSocket closed, reconnecting...');
        setTimeout(connectWebSocket, 3000);
      };
    }

    // Handle real-time presence updates
    function handlePresenceUpdate(msg) {
      const userId = msg.fromId;
      const status = msg.status;
      const timestamp = msg.timestamp;
      
      console.log(`Presence update: User ${userId} is ${status}`);
      
      // Update local state
      if (!userStatuses[userId]) {
        userStatuses[userId] = {};
      }
      userStatuses[userId].status = status;
      userStatuses[userId].lastSeen = timestamp;
      
      // Update UI
      updateUserStatus(userId, status);
    }

    // Render all users
    function renderUsers() {
      const container = document.getElementById('users-container');
      container.innerHTML = '';
      
      Object.entries(userStatuses).forEach(([userId, data]) => {
        const userCard = createUserCard(userId, data);
        container.appendChild(userCard);
      });
    }

    // Create user card element
    function createUserCard(userId, data) {
      const card = document.createElement('div');
      card.className = 'user-card';
      card.id = `user-${userId}`;
      
      const status = data.status || 'offline';
      const lastSeen = data.lastSeen ? new Date(data.lastSeen).toLocaleString() : 'Never';
      
      card.innerHTML = `
        <span class="status-indicator ${status}"></span>
        <strong>User ${userId}</strong>
        <br>
        <small>Status: ${status}</small>
        <br>
        <small>Last seen: ${lastSeen}</small>
      `;
      
      return card;
    }

    // Update single user status
    function updateUserStatus(userId, status) {
      const card = document.getElementById(`user-${userId}`);
      if (card) {
        const indicator = card.querySelector('.status-indicator');
        indicator.className = `status-indicator ${status}`;
        
        const statusText = card.querySelectorAll('small')[0];
        statusText.textContent = `Status: ${status}`;
        
        const lastSeenText = card.querySelectorAll('small')[1];
        lastSeenText.textContent = `Last seen: ${new Date().toLocaleString()}`;
      } else {
        // User not in list, add them
        userStatuses[userId] = { status, lastSeen: new Date().toISOString() };
        renderUsers();
      }
    }

    // Start the application
    init();
  </script>
</body>
</html>
```

---

## HTTP API Reference

### POST /api/presence/status

Get presence status for multiple users.

**Endpoint:** `POST http://your-router-url:3000/api/presence/status`

**Request Headers:**
```
Content-Type: application/json
```

**Request Body:**
```json
{
  "userIds": ["123", "456", "789"]
}
```

**Response (200 OK):**
```json
{
  "123": {
    "userId": "123",
    "status": "online",
    "lastSeen": "2025-12-12T10:30:45.123Z"
  },
  "456": {
    "userId": "456",
    "status": "offline",
    "lastSeen": "2025-12-12T09:15:22.456Z"
  },
  "789": {
    "userId": "789",
    "status": "online",
    "lastSeen": "2025-12-12T10:31:02.789Z"
  }
}
```

**Response Fields:**
- `userId` (string): The user ID
- `status` (string): Either `"online"` or `"offline"`
- `lastSeen` (string | null): ISO 8601 timestamp of last activity, or `null` if never seen

**Error Response (500):**
```json
{
  "error": "Failed to fetch presence status",
  "details": "Error message"
}
```

**Example with cURL:**
```bash
curl -X POST http://localhost:3000/api/presence/status \
  -H "Content-Type: application/json" \
  -d '{"userIds": ["123", "456", "789"]}'
```

**Example with JavaScript (fetch):**
```javascript
const response = await fetch('http://localhost:3000/api/presence/status', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ userIds: ['123', '456', '789'] })
});
const data = await response.json();
```

**Example with axios:**
```javascript
const { data } = await axios.post('http://localhost:3000/api/presence/status', {
  userIds: ['123', '456', '789']
});
```

---

## WebSocket Events Reference

### PRESENCE_UPDATE (MessageType 31)

Sent when a user's presence status changes (online → offline or offline → online).

**Message Structure (MessagePack encoded):**
```javascript
{
  messageType: 31,              // PRESENCE_UPDATE
  fromId: "123",                // User ID whose status changed
  toId: "",                     // Empty for broadcast
  status: "online",             // "online" or "offline"
  timestamp: "2025-12-12T10:30:45.123Z",  // ISO 8601 timestamp
  channelType: 1                // GROUP channel
}
```

**When It's Sent:**
- User connects → `status: "online"`
- User disconnects → `status: "offline"`
- User's TTL expires → `status: "offline"`

**Subscribing to Updates:**
```javascript
ws.onmessage = (event) => {
  const msg = msgpack.decode(new Uint8Array(event.data));
  
  if (msg.messageType === 31) {  // PRESENCE_UPDATE
    console.log(`User ${msg.fromId} is now ${msg.status}`);
    // Update your UI
  }
};
```

### PRESENCE_SNAPSHOT (MessageType 32)

Contains bulk presence data for multiple users. Currently used for debugging/admin tools.

**Message Structure:**
```javascript
{
  messageType: 32,              // PRESENCE_SNAPSHOT
  users: [
    { userId: "123", status: "online", lastSeen: "2025-12-12T10:30:45.123Z" },
    { userId: "456", status: "offline", lastSeen: "2025-12-12T09:15:22.456Z" }
  ]
}
```

---

## Testing

### 1. Test with Mobile App

1. **Connect mobile device** to VoicePing Router
2. **Check server logs** for:
   ```
   [PONG DETECTED] User 123 responded to PING - refreshing presence
   ```
3. **Query presence via HTTP:**
   ```bash
   curl -X POST http://localhost:3000/api/presence/status \
     -H "Content-Type: application/json" \
     -d '{"userIds": ["123"]}'
   ```
4. **Expected output:**
   ```json
   {
     "123": {
       "userId": "123",
       "status": "online",
       "lastSeen": "2025-12-12T10:30:45.123Z"
     }
   }
   ```

### 2. Test Offline Detection

1. **Connect mobile** → User shows as online
2. **Force close app** or **turn off WiFi/data**
3. **Wait 6 minutes** (PRESENCE_TTL)
4. **Query presence again** → User should show as offline

### 3. Test Real-Time Updates

1. **Open web dashboard** with WebSocket connection
2. **Connect/disconnect mobile** app
3. **Web dashboard should update** immediately showing status changes

### 4. Check Redis Data

```bash
# Connect to Redis CLI
redis-cli

# Check if user is online
GET presence:user:123

# Output: "1701516645123" (timestamp)
# If empty: User is offline

# Check TTL
TTL presence:user:123

# Output: Number of seconds until expiry (e.g., 356)
# Output: -2 means key doesn't exist (offline)

# List all online users
KEYS presence:user:*
```

### 5. Monitor Server Logs

```bash
# Start server with debug logging
DEBUG=vp:* npm start

# You should see:
# - "Presence refreshed for 123 via PONG" every 2 minutes
# - "User 123 marked as online" when connecting
# - "User 123 marked as offline" when disconnecting
```

---

## Troubleshooting

### Issue: Users showing as offline even though they're connected

**Possible causes:**
1. Redis not running or not accessible
2. PRESENCE_ENABLED set to false
3. Ping/pong not working

**Solutions:**
```bash
# Check Redis connection
redis-cli PING
# Should return: PONG

# Check environment variables
cat .env | grep PRESENCE

# Check server logs for errors
DEBUG=vp:* npm start
```

### Issue: Offline detection is too slow

**Solution:** Reduce PRESENCE_TTL

```bash
# In .env
PRESENCE_TTL=240  # 4 minutes instead of 6
```

⚠️ **Warning:** Too low TTL may cause false positives on slow networks.

### Issue: HTTP API returns empty results

**Possible causes:**
1. Users haven't connected yet
2. CORS blocking the request
3. Wrong user IDs

**Solutions:**
```bash
# Check if any users are online
redis-cli KEYS presence:user:*

# Test with cURL to bypass CORS
curl -X POST http://localhost:3000/api/presence/status \
  -H "Content-Type: application/json" \
  -d '{"userIds": ["123"]}'
```

### Issue: WebSocket not receiving presence updates

**Possible causes:**
1. Not subscribed to presence channel
2. MessagePack decoding issue
3. Wrong messageType filter

**Solutions:**
```javascript
// Check raw messages
ws.onmessage = (event) => {
  console.log('Raw message:', event.data);
  const msg = msgpack.decode(new Uint8Array(event.data));
  console.log('Decoded:', msg);
  console.log('Message type:', msg.messageType);
};
```

### Issue: False offline detections

**Cause:** Network instability causing ping/pong delays

**Solution:** Increase PRESENCE_TTL

```bash
# In .env
PRESENCE_TTL=480  # 8 minutes for unstable networks
```

### Issue: Users stuck as "online" after disconnecting

**Possible causes:**
1. Redis keyspace notifications not enabled
2. TTL not set correctly
3. Redis eviction policy issues

**Solutions:**
```bash
# Enable Redis keyspace notifications
redis-cli CONFIG SET notify-keyspace-events Ex

# Check Redis config
redis-cli CONFIG GET notify-keyspace-events

# Check maxmemory policy
redis-cli CONFIG GET maxmemory-policy
# Should NOT be "noeviction"
```

---

## Performance Considerations

### Scalability

**Single Server:**
- Can handle 10,000+ concurrent connections
- Minimal overhead (~50 bytes per PONG every 2 minutes)

**Multi-Server Setup:**
- Use shared Redis instance
- Presence updates automatically synced via Pub/Sub
- Each server handles its own connected clients

### Redis Memory Usage

**Per user:**
- Presence key: ~50 bytes
- Metadata key: ~100 bytes
- **Total:** ~150 bytes per online user

**10,000 users:**
- ~1.5 MB total memory usage
- Negligible compared to other data

### Network Bandwidth

**Per user:**
- PING: ~10 bytes every 2 minutes
- PONG: ~10 bytes every 2 minutes
- **Total:** ~20 bytes/2min = 10 bytes/min = ~0.17 bytes/sec

**10,000 users:**
- ~1.7 KB/sec total bandwidth
- Negligible impact

---

## Best Practices

### For Mobile Apps

1. ✅ **Use existing connection** - don't create separate connection for presence
2. ✅ **Handle reconnection** - presence will automatically update on reconnect
3. ✅ **Don't implement custom heartbeat** unless you need <6min detection
4. ⚠️ **Test on poor networks** - ensure PONG responses work reliably

### For Web Dashboards

1. ✅ **Use HTTP API for initial load** - bulk query when page loads
2. ✅ **Use WebSocket for updates** - real-time status changes
3. ✅ **Cache presence data locally** - reduce API calls
4. ✅ **Implement reconnection logic** - handle WebSocket disconnects
5. ⚠️ **Don't poll HTTP API** - use WebSocket for real-time instead

### For Production Deployment

1. ✅ **Enable Redis persistence** - avoid losing presence data on restart
2. ✅ **Monitor Redis memory** - set appropriate maxmemory limits
3. ✅ **Set up Redis Pub/Sub** - required for multi-server setups
4. ✅ **Configure CORS properly** - if using HTTP API from web
5. ✅ **Monitor TTL expiry** - tune PRESENCE_TTL based on your needs
6. ⚠️ **Load test** - verify performance with expected user count

---

## Summary

### For Mobile Developers

**Nothing to do!** Your existing VoicePing SDK integration automatically provides presence tracking.

### For Web Developers

**Two steps:**
1. **Initial load:** Call HTTP API to get bulk presence status
2. **Real-time updates:** Connect WebSocket and listen for MessageType 31

### Configuration

```bash
# Recommended settings for production
PRESENCE_ENABLED=true
PRESENCE_TTL=360      # 6 minutes
PING_INTERVAL=120000  # 2 minutes
REDIS_HOST=localhost
REDIS_PORT=6379
```

### Support

For issues or questions:
- Check server logs: `DEBUG=vp:* npm start`
- Verify Redis: `redis-cli KEYS presence:*`
- Test HTTP API: `curl -X POST http://localhost:3000/api/presence/status`

---

**Last Updated:** December 12, 2025
**VoicePing Router Version:** 1.0.0+presence
