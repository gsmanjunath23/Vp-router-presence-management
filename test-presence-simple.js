#!/usr/bin/env node
/**
 * Simple JavaScript Test for Presence API
 * Tests the HTTP API endpoint with various scenarios
 */

const http = require("http");

const API_HOST = "localhost";
const API_PORT = 8088;
const API_PATH = "/api/presence/status";

console.log("\n========================================");
console.log("  Presence API Test (JavaScript)");
console.log("========================================\n");

let passed = 0;
let failed = 0;

function testAPI(testName, userIds) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({ userIds });

    const options = {
      hostname: API_HOST,
      port: API_PORT,
      path: API_PATH,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      }
    };

    console.log(`Testing: ${testName}`);
    console.log(`  Request: POST http://${API_HOST}:${API_PORT}${API_PATH}`);
    console.log(`  Payload: ${postData}`);

    const req = http.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        if (res.statusCode === 200) {
          console.log("  ✅ PASS: Status 200 OK");
          console.log("  Response:", data);
          passed++;
        } else {
          console.log(`  ❌ FAIL: Status ${res.statusCode}`);
          console.log("  Response:", data);
          failed++;
        }
        console.log("");
        resolve();
      });
    });

    req.on("error", (error) => {
      console.log("  ❌ ERROR:", error.message);
      failed++;
      console.log("");
      resolve();
    });

    req.write(postData);
    req.end();
  });
}

async function runTests() {
  // Test 1: Single user
  await testAPI("Single user query", ["123"]);

  // Test 2: Multiple users
  await testAPI("Multiple users query", ["123", "456", "789"]);

  // Test 3: Empty array
  await testAPI("Empty user array", []);

  // Test 4: Many users
  await testAPI("Large user array",
    Array.from({ length: 20 }, (_, i) => `user${i + 1}`)
  );

  // Summary
  console.log("========================================");
  console.log("  Test Summary");
  console.log("========================================\n");
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);

  if (failed === 0) {
    console.log("\n🎉 All tests passed!\n");
  } else {
    console.log("\n⚠️  Some tests failed.\n");
  }
}

runTests();
