#!/usr/bin/env node
// playwright-test.js — Quick smoke test for VPN Panel admin functionality
// Usage: node playwright-test.js [base-url] [login] [password]
// Example: node playwright-test.js http://127.0.0.1:3129 admin password123

import { chromium } from 'playwright';

const BASE_URL = process.argv[2] || 'http://127.0.0.1:3129';
const LOGIN = process.argv[3] || 'admin';
const PASSWORD = process.argv[4] || 'admin';

async function main() {
  console.log('🧪 VPN Panel Playwright Test');
  console.log(`   URL: ${BASE_URL}`);
  console.log(`   Login: ${LOGIN}\n`);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const results = [];

  try {
    // Test 1: Login
    console.log('1️⃣  Testing login...');
    await page.goto(`${BASE_URL}/admin`, { timeout: 10000 });
    await page.waitForSelector('input[name="login"]', { timeout: 5000 });
    await page.fill('input[name="login"]', LOGIN);
    await page.fill('input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/admin', { timeout: 10000 });
    
    const isAdminPage = await page.url().includes('/admin');
    results.push({ test: 'Login', pass: isAdminPage, detail: isAdminPage ? 'Success' : 'Failed - not redirected to admin' });
    console.log(isAdminPage ? '   ✅ Login successful' : '   ❌ Login failed');

    // Test 2: Check endpoint health section exists
    console.log('2️⃣  Checking endpoint health section...');
    const healthSectionExists = await page.locator('text=Endpoint Health').isVisible().catch(() => false);
    results.push({ test: 'Health Section', pass: healthSectionExists, detail: healthSectionExists ? 'Visible' : 'Not found' });
    console.log(healthSectionExists ? '   ✅ Health section visible' : '   ❌ Health section not found');

    // Test 3: Quick Check button exists and is clickable
    console.log('3️⃣  Testing Quick Check button...');
    const quickCheckBtn = page.locator('#check-health-btn');
    const quickCheckVisible = await quickCheckBtn.isVisible().catch(() => false);
    results.push({ test: 'Quick Check Button', pass: quickCheckVisible, detail: quickCheckVisible ? 'Visible' : 'Not found' });
    console.log(quickCheckVisible ? '   ✅ Quick Check button visible' : '   ❌ Quick Check button not found');

    // Test 4: Run Benchmark button exists
    console.log('4️⃣  Testing Run Benchmark button...');
    const benchmarkBtn = page.locator('#run-bench-btn');
    const benchmarkVisible = await benchmarkBtn.isVisible().catch(() => false);
    results.push({ test: 'Benchmark Button', pass: benchmarkVisible, detail: benchmarkVisible ? 'Visible' : 'Not found' });
    console.log(benchmarkVisible ? '   ✅ Benchmark button visible' : '   ❌ Benchmark button not found');

    // Test 5: Probe section exists and Run Probe button is clickable
    console.log('5️⃣  Testing Probe section...');
    const probeSectionExists = await page.locator('text=Probe Results').isVisible().catch(() => false);
    const runProbeBtn = page.locator('#run-probe-btn');
    const runProbeVisible = await runProbeBtn.isVisible().catch(() => false);
    results.push({ test: 'Probe Section', pass: probeSectionExists && runProbeVisible, detail: probeSectionExists ? 'Section visible' : 'Not found' });
    console.log(probeSectionExists ? '   ✅ Probe section visible' : '   ❌ Probe section not found');
    console.log(runProbeVisible ? '   ✅ Run Probe button visible' : '   ❌ Run Probe button not found');

    // Test 6: Click Run Probe button (should not error)
    console.log('6️⃣  Testing Run Probe button click...');
    if (runProbeVisible) {
      try {
        await runProbeBtn.click();
        await page.waitForTimeout(2000);
        
        // Check if we got an error alert or if it started successfully
        const statusText = await page.locator('#probe-status').textContent().catch(() => '');
        const probeRunning = statusText.includes('Probe running') || statusText.includes('PID');
        results.push({ test: 'Run Probe Click', pass: probeRunning, detail: probeRunning ? 'Started successfully' : `Status: ${statusText || 'unknown'}` });
        console.log(probeRunning ? '   ✅ Probe started successfully' : `   ⚠️  Probe status: ${statusText || 'unknown'}`);
      } catch (err) {
        results.push({ test: 'Run Probe Click', pass: false, detail: err.message });
        console.log(`   ❌ Probe click failed: ${err.message}`);
      }
    }

    // Test 7: Check users section
    console.log('7️⃣  Checking users section...');
    const usersSectionExists = await page.locator('text=Users').isVisible().catch(() => false);
    results.push({ test: 'Users Section', pass: usersSectionExists, detail: usersSectionExists ? 'Visible' : 'Not found' });
    console.log(usersSectionExists ? '   ✅ Users section visible' : '   ❌ Users section not found');

    // Summary
    console.log('\n📊 Test Results Summary:');
    console.log('─'.repeat(60));
    const passed = results.filter(r => r.pass).length;
    const total = results.length;
    for (const r of results) {
      const icon = r.pass ? '✅' : '❌';
      console.log(`${icon} ${r.test.padEnd(25)} ${r.detail}`);
    }
    console.log('─'.repeat(60));
    console.log(`Total: ${passed}/${total} passed (${Math.round(passed/total*100)}%)\n`);

    if (passed === total) {
      console.log('🎉 All tests passed!');
    } else {
      console.log('⚠️  Some tests failed. Check the details above.');
    }

  } catch (err) {
    console.error('\n❌ Test suite failed:', err.message);
    results.push({ test: 'Suite', pass: false, detail: err.message });
  } finally {
    await browser.close();
  }

  // Exit with error code if any test failed
  const allPassed = results.every(r => r.pass);
  process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
