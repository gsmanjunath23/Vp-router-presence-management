# Presence Management System - Implementation Guide

## Overview

This presence management system tracks real-time online/offline status of mobile users using:
- **WebSocket** for real-time communication
- **Redis TTL** for automatic offline detection
- **Redis Pub/Sub** for multi-server synchronization
- **HTTP API** for bulk status queries

---

## Architecture

### Components

1. **Mobile Clients (PTT Users)**
   - Send heartbeat every 30 seconds
   - Maintain online status via Redis TTL (60 seconds)
   - Can query presence status of other users

2. **Web Dashboard (Admins/Monitors)**
   - Receive initial snapshot of online users
   - Listen for real-time presence updates
   - **DO NOT send heartbeats**

3. **VoicePing Router (WebSocket Server)**
   - Handles WebSocket connections
   - Processes heartbeats from mobile
   - Broadcasts presence updates to web clients
   - Manages Redis presence data

4. **Redis**
   - Stores presence keys with TTL
   - Pub/Sub for cross-server communication
   - Keyspace notifications for TTL expiry detection

---

## Message Types

Added three new message types:

```typescript
MessageType.HEARTBEAT = 30          // Mobile → Server
MessageType.PRESENCE_UPDATE = 31    // Server → Clients
MessageType.PRESENCE_SNAPSHOT = 32  // Server → Web clients
```

---

## HTTP API

### Bulk Presence Status Check

**Endpoint:** `POST /api/presence/status`

**Purpose:** When a mobile user joins a group, fetch presence status of all group members

**Request:**
```json
{
  "userIds": ["user123", "user456", "user789"]
}
```

**Response:**
```json
{
  "success": true,
  "users": [
    {
      "userId": "user123",
      "status": "online",
      "lastSeen": 1702281234567,
      "deviceId": "device-abc-123"
    },
    {
      "userId": "user456",
      "status": "offline",
      "lastSeen": 1702280000000,
      "deviceId": "device-xyz-456"
    }
  ],
  "timestamp": 1702281234567
}
```

**Use Cases:**
- Mobile user opens a group chat → fetch presence of all members
- Mobile user views team list → show who's online
- Mobile app reconnects → sync presence state

---

## Configuration

### Environment Variables

```bash
# Enable/disable presence system
PRESENCE_ENABLED=true

# TTL for presence keys (seconds)
PRESENCE_TTL=60

# Existing Redis config
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
```

### Redis Configuration

**Enable keyspace notifications** for TTL expiry detection:
```bash
redis-cli CONFIG SET notify-keyspace-events Ex
```

Or add to `redis.conf`:
```
notify-keyspace-events Ex
```

---

## Client Implementation

### Mobile Client Flow

```javascript
// 1. Connect to WebSocket with JWT
const ws = new WebSocket('ws://server.com', {
  headers: {
    'token': jwtToken,  // JWT with role='mobile'
    'device_id': 'device-123'
  }
});

// 2. Start heartbeat on connect
ws.on('open', () => {
  startHeartbeat(); // Send every 30 seconds
});

// 3. Send heartbeat message
function sendHeartbeat() {
  const msg = notepack.encode([
    0,                    // channelType
    30,                   // messageType: HEARTBEAT
    userId,               // fromId
    0,                    // toId
    { type: 'heartbeat', timestamp: Date.now() }
  ]);
  ws.send(msg);
}

// 4. Fetch presence when needed
async function fetchGroupPresence(groupUserIds) {
  const response = await fetch('/api/presence/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userIds: groupUserIds })
  });
  return response.json();
}
```

### Web Dashboard Flow

```javascript
// 1. Connect to WebSocket with JWT
const ws = new WebSocket('ws://server.com', {
  headers: {
    'token': jwtToken,  // JWT with role='web' or 'dashboard'
    'device_id': 'web-dashboard-001'
  }
});

// 2. Receive initial snapshot
ws.on('message', (data) => {
  const decoded = notepack.decode(data);
  const messageType = decoded[1];
  
  if (messageType === 32) { // PRESENCE_SNAPSHOT
    const snapshot = decoded[5];
    displayOnlineUsers(snapshot.users);
  }
  
  if (messageType === 31) { // PRESENCE_UPDATE
    const update = decoded[5];
    updateUserStatus(update.userId, update.status);
  }
});

// 3. NO heartbeat sending for web clients!
```

---

## How It Works

### Mobile User Comes Online

```
1. Mobile connects to WebSocket
2. Server detects role='mobile' from JWT
3. Server calls: presenceManager.setUserOnline(userId)
4. Redis: SET presence:user:123 "1" EX 60
5. Redis: HSET presence:meta:123 status "online" lastSeen 1702281234567
6. Redis: PUBLISH presence:online {"userId":"123","status":"online"}
7. All servers receive Pub/Sub notification
8. Servers broadcast to all connected web clients
```

### Mobile Sends Heartbeat

```
1. Mobile sends HEARTBEAT message every 30s
2. Server receives heartbeat
3. Server calls: presenceManager.refreshHeartbeat(userId)
4. Redis: EXPIRE presence:user:123 60  (reset TTL)
5. Redis: HSET presence:meta:123 lastSeen 1702281234567
```

### User Goes Offline (No Heartbeat)

```
1. Mobile stops sending heartbeats (network drop, app killed, etc.)
2. After 60 seconds, Redis TTL expires
3. Redis sends keyspace notification: __keyevent@0__:expired
4. Server receives notification
5. Server calls: presenceManager.setUserOffline(userId)
6. Redis: DEL presence:user:123
7. Redis: PUBLISH presence:offline {"userId":"123","status":"offline"}
8. All servers broadcast offline status to web clients
```

### Web Dashboard Connects

```
1. Web connects to WebSocket
2. Server detects role='web' from JWT
3. Server adds to webClients list
4. Server calls: presenceManager.getPresenceSnapshot()
5. Server sends PRESENCE_SNAPSHOT to web client
6. Web client displays all online users
7. Web client listens for PRESENCE_UPDATE messages
```

---

## Redis Keys Structure

```
# Presence indicator (TTL=60s)
presence:user:123 = "1"

# User metadata (persistent)
presence:meta:123 = {
  status: "online",
  lastSeen: 1702281234567,
  deviceId: "device-abc-123",
  role: "mobile"
}

# Pub/Sub channels
presence:online    → User came online notifications
presence:offline   → User went offline notifications
presence:updates   → All presence changes
```

---

## Multi-Server Setup

### Load Balancer Configuration (Nginx)

```nginx
upstream voiceping_backend {
    ip_hash;  # Sticky sessions
    server ws-server-1:3000;
    server ws-server-2:3000;
    server ws-server-3:3000;
}

server {
    listen 80;
    
    location / {
        proxy_pass http://voiceping_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }
}
```

### Why It Works Across Multiple Servers

1. **Redis as Single Source of Truth**
   - All servers read/write to same Redis
   - Presence data is shared

2. **Redis Pub/Sub for Synchronization**
   - When Server 1 detects user online → publishes to Redis
   - Server 2 and 3 receive notification → broadcast to their web clients

3. **Sticky Sessions**
   - Each client stays connected to same server
   - Server knows which clients to broadcast to

---

## Failure Scenarios

### Network Drop (Mobile)
```
Mobile loses network → No heartbeats sent → TTL expires after 60s 
→ Server marks offline → Web clients notified
```

### App Killed (Mobile)
```
WebSocket connection closes → Server's onclose handler 
→ Immediately mark offline → Don't wait for TTL
```

### Server Crash
```
Server crashes → All connections drop → Clients reconnect to another server
→ Mobile sends heartbeat → Marked online again
→ Web receives new snapshot
```

### Redis Failure
```
Redis unavailable → Presence operations fail gracefully
→ PTT functionality continues working (not affected)
→ When Redis recovers → Heartbeats rebuild presence state
```

---

## Testing

### Test Heartbeat Flow

```bash
# Terminal 1: Start server
npm run dev

# Terminal 2: Start mobile client
node examples/mobile-client-presence.js

# Terminal 3: Start web dashboard
node examples/web-dashboard-presence.js

# Observe:
# - Mobile sends heartbeat every 30s
# - Web receives initial snapshot
# - Kill mobile client → Web sees offline update after 60s
```

### Test Bulk API

```bash
# Fetch presence for multiple users
curl -X POST http://localhost:3000/api/presence/status \
  -H "Content-Type: application/json" \
  -d '{"userIds": ["user123", "user456", "user789"]}'
```

### Test TTL Expiry

```bash
# In Redis CLI, watch for expirations
redis-cli --csv psubscribe '__key*__:*'

# Stop mobile client heartbeats
# After 60 seconds, see expiration event
```

---

## Performance Optimization

### For Thousands of Users

1. **Batch Presence Updates**
   ```typescript
   // Collect updates for 1 second, then broadcast batch
   const pendingUpdates = [];
   setInterval(() => {
     if (pendingUpdates.length > 0) {
       broadcastBatch(pendingUpdates);
     }
   }, 1000);
   ```

2. **Selective Broadcasting**
   ```typescript
   // Only send updates to web clients interested in specific groups
   if (webClient.subscribedGroups.includes(user.groupId)) {
     webClient.send(update);
   }
   ```

3. **Cache Snapshots**
   ```typescript
   // Cache snapshot for 5 seconds
   let cachedSnapshot = null;
   let cacheTime = 0;
   if (Date.now() - cacheTime < 5000) {
     return cachedSnapshot;
   }
   ```

4. **Redis Pipeline**
   ```typescript
   // Use pipeline for multiple operations
   const pipeline = redis.pipeline();
   pipeline.set(key1, val1);
   pipeline.hset(key2, field, val2);
   await pipeline.exec();
   ```

---

## Security

### JWT Validation

```typescript
// Validate JWT on connection
const decoded = jwt.verify(token, SECRET_KEY);

// Check role
if (decoded.role === 'web' && msg.type === 'heartbeat') {
  return reject('Web clients cannot send heartbeat');
}
```

### Rate Limiting

```typescript
// Prevent heartbeat spam
const lastHeartbeat = heartbeatMap.get(userId);
if (Date.now() - lastHeartbeat < 25000) {
  return; // Too fast, ignore
}
```

### Input Validation

```typescript
// Validate userIds array
if (!Array.isArray(userIds) || userIds.length > 100) {
  return error('Invalid userIds');
}
```

---

## Monitoring Metrics

Track these metrics:

- `presence.online.total` - Total online users
- `presence.heartbeat.received` - Heartbeats per second
- `presence.ttl.expired` - Users marked offline via TTL
- `presence.update.latency` - Time to broadcast updates
- `presence.api.requests` - Bulk status API calls

---

## Migration Guide

### Existing Deployments

1. **Add environment variables**
   ```bash
   PRESENCE_ENABLED=true
   PRESENCE_TTL=60
   ```

2. **Enable Redis keyspace notifications**
   ```bash
   redis-cli CONFIG SET notify-keyspace-events Ex
   ```

3. **Update mobile SDK**
   - Add heartbeat sending logic
   - Add HTTP API call for presence fetch

4. **Update web dashboard**
   - Listen for presence messages
   - Display online users

5. **Deploy server updates**
   ```bash
   npm run build
   npm run start
   ```

### Backward Compatibility

- Old mobile clients (no heartbeat) → Won't appear online (no breaking changes)
- Old web clients → Ignore new message types (no breaking changes)
- PTT functionality → Completely unaffected

---

## Troubleshooting

### Users not appearing online

1. Check Redis keyspace notifications:
   ```bash
   redis-cli CONFIG GET notify-keyspace-events
   ```

2. Verify heartbeat messages:
   ```bash
   # Enable debug logging
   DEBUG=vp:presence npm run dev
   ```

3. Check Redis keys:
   ```bash
   redis-cli KEYS "presence:user:*"
   redis-cli TTL presence:user:123
   ```

### Web clients not receiving updates

1. Verify Pub/Sub subscriptions:
   ```bash
   redis-cli PUBSUB CHANNELS
   ```

2. Check web client registration:
   ```bash
   # Look for "WEB CLIENT registered" in logs
   ```

3. Test Pub/Sub manually:
   ```bash
   redis-cli PUBLISH presence:updates '{"userId":"test","status":"online"}'
   ```

---

## Summary

✅ **Mobile users**: Send heartbeat every 30s to maintain online status  
✅ **Web dashboards**: Receive snapshot + real-time updates (no heartbeat)  
✅ **HTTP API**: Bulk presence check for group members  
✅ **Redis TTL**: Automatic offline detection after 60s  
✅ **Multi-server**: Works across load-balanced servers via Pub/Sub  
✅ **Non-breaking**: Existing PTT functionality unaffected  

The system is production-ready and scales to thousands of users!
