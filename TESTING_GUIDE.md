# Presence Management Testing Guide

## Quick Start

### Option 1: PowerShell Script (Comprehensive)

Run the automated test script:

```powershell
.\test-presence.ps1
```

This will verify:
- ✅ Docker containers are running
- ✅ Redis is responding
- ✅ HTTP API is working
- ✅ Presence system is initialized
- ✅ No Redis authentication errors

### Option 2: Node.js Script (API Only)

Test just the HTTP API:

```bash
node test-presence-simple.js
```

### Option 3: Manual Testing

## Manual Testing Steps

### 1. Check System Status

```bash
# Check containers are running
docker ps | findstr vp-router

# Check server logs
docker compose logs vp-router | findstr -i "presence"

# Check Redis
docker exec -it vp-router-presence-management-redis-1 redis-cli -p 6381 PING
```

### 2. Test HTTP API

**PowerShell:**
```powershell
$body = @{
    userIds = @("123", "456", "789")
} | ConvertTo-Json

Invoke-WebRequest -Uri "http://localhost:8088/api/presence/status" `
    -Method POST `
    -ContentType "application/json" `
    -Body $body
```

**curl (if installed):**
```bash
curl -X POST http://localhost:8088/api/presence/status \
  -H "Content-Type: application/json" \
  -d '{"userIds": ["123", "456", "789"]}'
```

**Expected Response:**
```json
{
  "123": {
    "userId": "123",
    "status": "offline",
    "lastSeen": null
  },
  "456": {
    "userId": "456",
    "status": "offline",
    "lastSeen": null
  },
  "789": {
    "userId": "789",
    "status": "offline",
    "lastSeen": null
  }
}
```

### 3. Check Redis Data

```bash
# Connect to Redis
docker exec -it vp-router-presence-management-redis-1 redis-cli -p 6381

# Inside Redis CLI:
PING                    # Should return PONG
KEYS presence:*         # Show all presence keys
KEYS *                  # Show all keys
GET presence:user:123   # Check specific user
TTL presence:user:123   # Check TTL of a key
```

### 4. Monitor Real-Time

Open 3 terminals:

**Terminal 1 - Server Logs:**
```bash
docker compose logs -f vp-router
```

**Terminal 2 - Redis Monitor:**
```bash
docker exec -it vp-router-presence-management-redis-1 redis-cli -p 6381 MONITOR
```

**Terminal 3 - API Polling:**
```powershell
while($true) { 
    $body = '{"userIds": ["123"]}' 
    Invoke-WebRequest -Uri "http://localhost:8088/api/presence/status" -Method POST -ContentType "application/json" -Body $body | Select-Object -ExpandProperty Content
    Start-Sleep -Seconds 5 
}
```

## Testing with Example Clients

### Mobile Client Example

Simulates a mobile user connecting and sending heartbeats:

```bash
node examples/mobile-client-presence.js
```

**What it does:**
- Connects to WebSocket server
- Sends heartbeat every 30 seconds
- Maintains online status
- Shows received presence updates

**What to observe:**
- Server logs: "User connected"
- Redis: `presence:user:123` key created with TTL
- API: User status shows "online"

### Web Dashboard Example

Simulates a web dashboard monitoring presence:

```bash
node examples/web-dashboard-presence.js
```

**What it does:**
- Connects to WebSocket server
- Receives initial presence snapshot
- Listens for real-time updates
- Displays online/offline changes

## Expected Results

### ✅ User Connects

**Server Logs:**
```
info: User 123 connected
info: Setting presence online for user 123
```

**Redis:**
```
SET presence:user:123 "1702281234567"
EXPIRE presence:user:123 360
```

**API Response:**
```json
{
  "123": {
    "userId": "123",
    "status": "online",
    "lastSeen": "2025-12-16T06:30:45.123Z"
  }
}
```

### ✅ User Sends Heartbeat (if implemented)

**Server Logs:**
```
info: Heartbeat received from user 123
info: Refreshing presence TTL for user 123
```

**Redis:**
```
EXPIRE presence:user:123 360  // TTL reset to 360 seconds
```

### ✅ User Sends PONG (existing ping/pong)

**Server Logs:**
```
info: [PONG DETECTED] User 123 responded to PING - refreshing presence
```

**Redis:**
```
EXPIRE presence:user:123 360  // TTL refreshed
```

### ✅ User Disconnects

**Server Logs:**
```
info: User 123 disconnected
info: Setting presence offline for user 123
```

**Redis:**
```
DEL presence:user:123
```

**API Response:**
```json
{
  "123": {
    "userId": "123",
    "status": "offline",
    "lastSeen": "2025-12-16T06:35:45.123Z"
  }
}
```

### ✅ TTL Expires (User goes offline)

**Server Logs:**
```
info: [TTL EXPIRED] User 123 went offline (key expired)
```

**Redis Keyspace Event:**
```
PUBLISH __keyspace@0__:presence:user:123 expired
```

**API Response:**
```json
{
  "123": {
    "userId": "123",
    "status": "offline",
    "lastSeen": "2025-12-16T06:32:45.123Z"
  }
}
```

## Troubleshooting

### Problem: API returns 404

**Solution:**
```bash
# Check if server is running
docker ps | findstr vp-router

# Check server logs
docker compose logs vp-router

# Restart if needed
docker compose restart vp-router
```

### Problem: Redis AUTH errors

**Solution:**
```bash
# Edit .env file - comment out REDIS_PASSWORD
# REDIS_PASSWORD=localhost

# Rebuild
docker compose down
docker compose up --build -d
```

### Problem: No presence keys in Redis

**Reason:** No users connected yet (this is normal!)

**Solution:** 
- Connect a mobile client
- Or run the example: `node examples/mobile-client-presence.js`

### Problem: User stays online after disconnect

**Reasons:**
1. TTL hasn't expired yet (wait up to 6 minutes)
2. Keyspace notifications not enabled

**Solution:**
```bash
# Check Redis config
docker exec -it vp-router-presence-management-redis-1 redis-cli -p 6381 CONFIG GET notify-keyspace-events

# Should return: "Ex" or "Exe" or "AKE"
# If empty, restart server to enable it
```

### Problem: WebSocket won't connect

**Check:**
1. Port 8088 is not blocked by firewall
2. Token/authentication is valid
3. Server logs for connection errors

```bash
docker compose logs vp-router | findstr -i error
```

## Performance Testing

### Load Test API

```powershell
# Test with 100 requests
1..100 | ForEach-Object -Parallel {
    $body = '{"userIds": ["' + $_ + '"]}'
    Invoke-WebRequest -Uri "http://localhost:8088/api/presence/status" -Method POST -ContentType "application/json" -Body $body -UseBasicParsing | Out-Null
    Write-Host "Request $_ completed"
} -ThrottleLimit 10
```

### Monitor Redis Performance

```bash
docker exec -it vp-router-presence-management-redis-1 redis-cli -p 6381 INFO stats
```

## Integration Testing Checklist

- [ ] HTTP API responds to presence queries
- [ ] Redis stores presence data with correct TTL
- [ ] Users marked online when connecting
- [ ] Users marked offline when disconnecting
- [ ] TTL refreshes on PONG/heartbeat
- [ ] TTL expiry triggers offline status
- [ ] WebSocket broadcasts presence updates
- [ ] Multiple concurrent users work correctly
- [ ] Server restart doesn't break presence
- [ ] No memory leaks over time

## Automated CI/CD Testing

Add to your CI pipeline:

```yaml
# .github/workflows/test.yml
- name: Test Presence System
  run: |
    docker compose up -d
    sleep 10
    node test-presence-simple.js
```

## Success Criteria

✅ **System is working if:**
1. All tests in `test-presence.ps1` pass
2. API returns valid JSON for user queries
3. Redis is accessible and responding
4. Server logs show "Presence Manager initialized"
5. No Redis AUTH errors in logs

🎉 **You're ready for production!**
