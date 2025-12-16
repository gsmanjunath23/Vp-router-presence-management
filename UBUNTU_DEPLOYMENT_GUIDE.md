# Deploy VoicePing Router to Ubuntu Server (119)

Complete beginner guide to deploy on your company's Ubuntu server.

## Prerequisites
- Ubuntu server IP address (e.g., 119.x.x.x)
- Username and password for the server
- SSH access or direct terminal access

---

## Step 1: Connect to Ubuntu Server

### Option A: Using Windows PowerShell (from your local machine)

```powershell
# Connect via SSH
ssh username@119.x.x.x

# Example:
# ssh admin@119.45.67.89

# Enter password when prompted
```

### Option B: Direct Access
If you have physical or remote desktop access, open Terminal directly on the server.

---

## Step 2: Update Ubuntu System

Once connected to the server, run these commands:

```bash
# Update package list
sudo apt-get update

# Upgrade existing packages (optional but recommended)
sudo apt-get upgrade -y
```

---

## Step 3: Install Docker

```bash
# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Add your user to docker group (replace 'username' with your actual username)
sudo usermod -aG docker $USER

# Install Docker Compose
sudo apt-get install docker-compose -y

# Verify installation
docker --version
docker-compose --version
```

**Important:** After adding user to docker group, logout and login again:
```bash
exit
# Then reconnect with ssh
```

---

## Step 4: Install Git

```bash
sudo apt-get install git -y
git --version
```

---

## Step 5: Clone Your Repository

```bash
# Go to home directory
cd ~

# Clone repository
git clone https://github.com/SmartWalkieOrg/voiceping-router.git

# Go into project folder
cd voiceping-router

# Switch to m_dev branch
git checkout m_dev

# Verify files
ls -la
```

---

## Step 6: Configure Environment

### Create .env file

```bash
# Copy example file
cp .env.example .env

# Edit the file
nano .env
```

### Add Configuration

Paste this into the file:

```bash
# Redis
REDIS_HOST=redis
REDIS_PASSWORD=
REDIS_PORT=6379
SECRET_KEY=voiceping-2025-secure-key-119server

# Presence Management
PRESENCE_ENABLED=true
PRESENCE_TTL=360
PING_INTERVAL=120000

# DynamoDB Integration
DYNAMODB_ENABLED=true
AWS_REGION=ap-northeast-1
NODE_ENV=production

# DynamoDB Tables
USERS_TABLE_DEV=Users-Dev
USERS_TABLE_TEST=Users-Test
USERS_TABLE_STAGE=Users-Stage
USERS_TABLE_PROD=Users-Prod

# AWS Credentials
AWS_ACCESS_KEY_ID=your-aws-access-key-id
AWS_SECRET_ACCESS_KEY=your-aws-secret-access-key

# Encryption
ENCRYPTION_KEY=your-encryption-key-here

# Server
PORT=3000
NETWORK=voiceping-lite
```

**Save the file:**
- Press `Ctrl + X`
- Press `Y` (to confirm)
- Press `Enter` (to save)

---

## Step 7: Check Port 8080 Availability

```bash
# Check if port 8080 is free
sudo lsof -i :8080

# If something is using it, either:
# 1. Stop that service
# 2. Or change port in docker-compose.yml to 8081 or 9000
```

### To use different port (if 8080 is busy):

```bash
nano docker-compose.yml
```

Change line:
```yaml
ports:
  - "8080:3000"
```

To:
```yaml
ports:
  - "9000:3000"  # or any available port
```

Save with `Ctrl+X`, `Y`, `Enter`.

---

## Step 8: Build and Deploy

```bash
# Make sure you're in the project directory
cd ~/voiceping-router

# Build Docker image (takes 5-10 minutes first time)
docker-compose build

# Start services
docker-compose up -d

# Check if containers are running
docker-compose ps
```

You should see:
```
NAME                    STATUS              PORTS
voiceping-router-1      Up                  0.0.0.0:8080->3000/tcp
redis-1                 Up                  6379/tcp
```

---

## Step 9: Check Logs

```bash
# View logs
docker-compose logs -f vp-router

# Press Ctrl+C to exit logs view
```

**Look for SUCCESS messages:**
- ✓ `"VoicePing router listening on port 3000"`
- ✓ `"DynamoDB integration enabled for environment: production"`
- ✓ `"Presence Manager initialized with TTL=360"`

---

## Step 10: Test the Deployment

### From the Ubuntu server itself (when logged in via SSH):

```bash
# Test health endpoint
curl http://localhost:8080/health

# Should return: {"status":"ok"}

# Test presence API
curl -X POST http://localhost:8080/api/presence/status \
  -H "Content-Type: application/json" \
  -d '{"userIds": ["test123"]}'
```

**Note:** `localhost` or `127.0.0.1` works ONLY when running commands ON the server (via SSH terminal).

### From your Windows machine (or any other device):

```powershell
# Test from your local machine (replace 119.x.x.x with actual IP)
curl http://119.x.x.x:8080/health

# Replace 119.x.x.x with your server's actual IP address
# Example: curl http://119.45.67.89:8080/health
```

**Summary:**
- **ON the server (SSH):** Use `localhost:8080`
- **FROM your computer:** Use `119.x.x.x:8080` (server's IP)
- **FROM mobile app:** Use `ws://119.x.x.x:8080` (server's IP)


---

## Step 11: Configure Firewall

Allow external connections on port 8080:

```bash
# Check if firewall is active
sudo ufw status

# If active, allow port 8080
sudo ufw allow 8080/tcp

# Verify
sudo ufw status
```

---

## Step 12: Get Server IP Address

```bash
# Get server's IP address
hostname -I

# Or
ip addr show

# Look for IP like: 119.x.x.x or 192.168.x.x
```

---

## Step 13: Connect Your Mobile App

Update your mobile app configuration to connect to:

```
ws://119.x.x.x:8080
```

Replace `119.x.x.x` with your actual server IP.

---

## Useful Commands

### View Logs
```bash
# All logs
docker-compose logs -f

# Only router logs
docker-compose logs -f vp-router

# Last 100 lines
docker-compose logs --tail=100 vp-router
```

### Restart Service
```bash
docker-compose restart vp-router
```

### Stop Service
```bash
docker-compose down
```

### Start Service
```bash
docker-compose up -d
```

### Update Code
```bash
cd ~/voiceping-router
git pull origin m_dev
docker-compose down
docker-compose build
docker-compose up -d
```

### Check Container Status
```bash
docker-compose ps
```

### Check Resource Usage
```bash
docker stats
```

---

## Auto-Start on Server Reboot

Make service start automatically when server reboots:

```bash
# Create systemd service
sudo nano /etc/systemd/system/voiceping-router.service
```

Paste this (replace `username` with your actual username):

```ini
[Unit]
Description=VoicePing Router
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/home/username/voiceping-router
ExecStart=/usr/bin/docker-compose up -d
ExecStop=/usr/bin/docker-compose down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
```

Save and enable:

```bash
# Reload systemd
sudo systemctl daemon-reload

# Enable service
sudo systemctl enable voiceping-router.service

# Start service
sudo systemctl start voiceping-router.service

# Check status
sudo systemctl status voiceping-router.service
```

---

## Troubleshooting

### Problem 1: Cannot connect from outside

**Solution:**
```bash
# Check if service is listening
sudo netstat -tulpn | grep 8080

# Should show: 0.0.0.0:8080 (not 127.0.0.1:8080)

# Check firewall
sudo ufw status

# Allow port if needed
sudo ufw allow 8080/tcp
```

### Problem 2: Container keeps restarting

**Solution:**
```bash
# Check logs for errors
docker-compose logs --tail=50 vp-router

# Common issues:
# - Redis not starting: Check redis logs
# - Build failed: Rebuild with --no-cache
```

### Problem 3: Out of disk space

**Solution:**
```bash
# Check disk space
df -h

# Clean Docker
docker system prune -a
```

### Problem 4: DynamoDB not updating

**Solution:**
```bash
# Check logs
docker-compose logs vp-router | grep DynamoDB

# Verify .env file
cat .env | grep DYNAMODB_ENABLED
# Should show: DYNAMODB_ENABLED=true

# Check AWS credentials
cat .env | grep AWS_ACCESS_KEY_ID
```

---

## Quick Reference Card

```bash
# Connect to server
ssh username@119.x.x.x

# Go to project
cd ~/voiceping-router

# View logs
docker-compose logs -f vp-router

# Restart
docker-compose restart

# Stop
docker-compose down

# Start
docker-compose up -d

# Update code
git pull && docker-compose down && docker-compose build && docker-compose up -d

# Check status
docker-compose ps

# Test locally
curl http://localhost:8080/health
```

---

## Summary

After following these steps:

1. ✅ Docker installed on Ubuntu server
2. ✅ Code cloned from GitHub
3. ✅ Environment configured with AWS credentials
4. ✅ Service running on port 8080
5. ✅ Firewall configured
6. ✅ Auto-start enabled

**Your WebSocket URL:** `ws://119.x.x.x:8080`

**Your API URL:** `http://119.x.x.x:8080`

**Health Check:** `http://119.x.x.x:8080/health`

Replace `119.x.x.x` with your actual server IP address.

---

## Need Help?

Check logs first:
```bash
docker-compose logs -f vp-router
```

Look for error messages and compare with troubleshooting section above.
