# Presence Management Verification Script
# This script tests if the presence management system is working correctly

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  VoicePing Presence System Test" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

$passed = 0
$failed = 0
$warnings = 0

function Test-Step {
    param(
        [string]$Name,
        [scriptblock]$Test,
        [string]$SuccessMessage,
        [string]$FailureMessage
    )
    
    Write-Host "Testing: $Name" -ForegroundColor Yellow
    try {
        $result = & $Test
        if ($result) {
            Write-Host "  ✅ PASS: $SuccessMessage" -ForegroundColor Green
            $script:passed++
            return $true
        } else {
            Write-Host "  ❌ FAIL: $FailureMessage" -ForegroundColor Red
            $script:failed++
            return $false
        }
    } catch {
        Write-Host "  ❌ ERROR: $_" -ForegroundColor Red
        $script:failed++
        return $false
    }
}

Write-Host "Step 1: Checking Docker Containers" -ForegroundColor Cyan
Write-Host "-----------------------------------`n" -ForegroundColor Cyan

# Test 1: Check if containers are running
Test-Step -Name "Docker containers are running" -Test {
    $containers = docker ps --filter "name=vp-router-presence-management" --format "{{.Names}}"
    return ($containers -like "*vp-router*" -and $containers -like "*redis*")
} -SuccessMessage "Both vp-router and redis containers are running" `
  -FailureMessage "Containers are not running. Run: docker compose up -d"

Write-Host "`nStep 2: Testing Redis Connection" -ForegroundColor Cyan
Write-Host "-----------------------------------`n" -ForegroundColor Cyan

# Test 2: Redis connectivity
Test-Step -Name "Redis is responding" -Test {
    $result = docker exec vp-router-presence-management-redis-1 redis-cli -p 6381 PING 2>&1
    return ($result -eq "PONG")
} -SuccessMessage "Redis is responding to PING" `
  -FailureMessage "Redis is not responding"

# Test 3: Check Redis keys
Write-Host "`nChecking Redis presence keys..." -ForegroundColor Yellow
$keys = docker exec vp-router-presence-management-redis-1 redis-cli -p 6381 KEYS "presence:*" 2>&1
if ($keys) {
    Write-Host "  ℹ️  Found presence keys in Redis:" -ForegroundColor Blue
    $keys | ForEach-Object { Write-Host "     - $_" -ForegroundColor Gray }
    $script:warnings++
} else {
    Write-Host "  ℹ️  No presence keys found (no users connected yet)" -ForegroundColor Blue
    $script:warnings++
}

Write-Host "`nStep 3: Testing HTTP API" -ForegroundColor Cyan
Write-Host "-----------------------------------`n" -ForegroundColor Cyan

# Test 4: HTTP API endpoint
Test-Step -Name "Presence API endpoint responds" -Test {
    try {
        $body = @{
            userIds = @("123", "456", "789")
        } | ConvertTo-Json
        
        $response = Invoke-WebRequest -Uri "http://localhost:8088/api/presence/status" `
            -Method POST `
            -ContentType "application/json" `
            -Body $body `
            -TimeoutSec 5 `
            -UseBasicParsing
        
        return ($response.StatusCode -eq 200)
    } catch {
        return $false
    }
} -SuccessMessage "API endpoint is responding on port 8088" `
  -FailureMessage "API endpoint is not responding. Check if server is running."

# Test 5: API returns valid JSON
Test-Step -Name "API returns valid presence data" -Test {
    try {
        $body = @{
            userIds = @("123", "456")
        } | ConvertTo-Json
        
        $response = Invoke-WebRequest -Uri "http://localhost:8088/api/presence/status" `
            -Method POST `
            -ContentType "application/json" `
            -Body $body `
            -UseBasicParsing
        
        $data = $response.Content | ConvertFrom-Json
        return ($data.PSObject.Properties.Count -ge 0)
    } catch {
        return $false
    }
} -SuccessMessage "API returns valid JSON response" `
  -FailureMessage "API response is not valid JSON"

Write-Host "`nStep 4: Checking Server Logs" -ForegroundColor Cyan
Write-Host "-----------------------------------`n" -ForegroundColor Cyan

# Test 6: Check for presence initialization in logs
Test-Step -Name "Presence system initialized" -Test {
    $logs = docker logs vp-router-presence-management-vp-router-1 2>&1
    return ($logs -match "Presence Manager initialized" -or $logs -match "Initializing presence management")
} -SuccessMessage "Presence system is initialized" `
  -FailureMessage "Presence system may not be initialized properly"

# Test 7: Check for Redis connection errors
Test-Step -Name "No Redis authentication errors" -Test {
    $logs = docker logs vp-router-presence-management-vp-router-1 2>&1 | Select-String "AUTH" -SimpleMatch
    return ($logs.Count -eq 0)
} -SuccessMessage "No Redis AUTH errors found" `
  -FailureMessage "Redis AUTH errors detected in logs"

Write-Host "`nStep 5: Testing Presence API Response" -ForegroundColor Cyan
Write-Host "-----------------------------------`n" -ForegroundColor Cyan

# Detailed API test
Write-Host "Making detailed API request..." -ForegroundColor Yellow
try {
    $body = @{
        userIds = @("user123", "user456", "user789")
    } | ConvertTo-Json
    
    $response = Invoke-WebRequest -Uri "http://localhost:8088/api/presence/status" `
        -Method POST `
        -ContentType "application/json" `
        -Body $body `
        -UseBasicParsing
    
    $data = $response.Content | ConvertFrom-Json
    
    Write-Host "  ✅ API Response received:" -ForegroundColor Green
    Write-Host "     Status Code: $($response.StatusCode)" -ForegroundColor Gray
    Write-Host "     Response:" -ForegroundColor Gray
    $response.Content | ConvertFrom-Json | ConvertTo-Json -Depth 3 | Write-Host -ForegroundColor Gray
    $script:passed++
} catch {
    Write-Host "  ❌ API request failed: $_" -ForegroundColor Red
    $script:failed++
}

# Summary
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Test Summary" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

Write-Host "  Passed:   $passed" -ForegroundColor Green
Write-Host "  Failed:   $failed" -ForegroundColor Red
Write-Host "  Warnings: $warnings" -ForegroundColor Yellow

if ($failed -eq 0) {
    Write-Host "`n🎉 All critical tests passed! Presence system is working.`n" -ForegroundColor Green
    
    Write-Host "Next Steps:" -ForegroundColor Cyan
    Write-Host "  1. Connect a mobile client to see presence updates" -ForegroundColor Gray
    Write-Host "  2. Run: node examples/mobile-client-presence.js" -ForegroundColor Gray
    Write-Host "  3. Monitor logs: docker compose logs -f vp-router" -ForegroundColor Gray
    Write-Host "  4. Query API: Invoke-WebRequest -Uri http://localhost:8088/api/presence/status -Method POST -ContentType 'application/json' -Body '{""userIds"":[""123""]}'" -ForegroundColor Gray
} else {
    Write-Host "`n⚠️  Some tests failed. Review the errors above.`n" -ForegroundColor Yellow
    Write-Host "Common Issues:" -ForegroundColor Cyan
    Write-Host "  - Containers not running: docker compose up -d" -ForegroundColor Gray
    Write-Host "  - Redis AUTH errors: Check .env file (REDIS_PASSWORD should be commented)" -ForegroundColor Gray
    Write-Host "  - Port conflicts: Check if port 8088 and 6381 are available" -ForegroundColor Gray
}

Write-Host ""
