import test from "node:test";
import assert from "node:assert/strict";
import { vpsPage } from "../src/pages.js";
import type { VpsSystemStats, XrayUserTraffic, XrayInboundTraffic } from "../src/vps-ssh.js";

test("VPS page renders valid HTML with script block", () => {
  const input = {
    connected: true,
    system: {
      hostname: "test-server",
      os: "Ubuntu 22.04",
      uptime_seconds: 3600,
      cpu_count: 4,
      cpu_model: "Test CPU",
      cpu_load_1m: 1.5,
      cpu_load_5m: 1.2,
      cpu_load_15m: 1.0,
      mem_total_mb: 8000,
      mem_used_mb: 4000,
      mem_available_mb: 4000,
      disk_total_gb: 100,
      disk_used_gb: 50,
      disk_available_gb: 50,
      disk_use_percent: 50,
    },
    xray: {
      running: true,
      pid: 1234,
      memory_mb: 50,
      cpu_time: "0:01:00",
      uptime: "1 hour",
      version: "26.5.9",
    },
    singBox: {
      running: true,
      pid: 2345,
      memory_mb: 32,
      cpu_time: "0:00:30",
      uptime: "30 minutes",
      version: "1.13.14",
    },
    userTraffic: [],
    inboundTraffic: [],
    vpsLabel: "Test VPS",
  };

  const html = vpsPage(input);

  assert.ok(html.includes("<!doctype html>"), "Should include doctype");
  assert.ok(html.includes("<script>"), "Should include script tag");
  assert.ok(html.includes("</script>"), "Should close script tag");
  assert.ok(html.includes("function checkXrayUpdate()"), "Should define checkXrayUpdate function");
  assert.ok(html.includes("function loadXrayConfig()"), "Should define loadXrayConfig function");
  assert.ok(html.includes("function loadXrayLogs()"), "Should define loadXrayLogs function");
  assert.ok(html.includes("function loadSingBoxLogs()"), "Should define sing-box logs function");
  assert.ok(html.includes("/api/admin/vps/sing-box/update"), "Should define sing-box update path");
  assert.ok(html.includes("responseJson"), "Should surface non-2xx API responses");
  assert.ok(html.includes('id="admin-layout"'), "Should use the shared admin layout");
  assert.ok(html.includes('href="/admin/smart-dns"'), "Should keep the shared sidebar navigation");

  const scriptStart = html.indexOf("<script>");
  const scriptEnd = html.indexOf("</script>", scriptStart);
  const scriptContent = html.slice(scriptStart + 8, scriptEnd);

  assert.ok(scriptContent.includes("function checkXrayUpdate()"), "Script should contain checkXrayUpdate");

  console.log("Script content length:", scriptContent.length);
  console.log("Script starts with:", scriptContent.slice(0, 100));
  console.log("Script ends with:", scriptContent.slice(-100));
});

test("VPS page has proper quote escaping in inline events", () => {
  const input = {
    connected: true,
    system: {
      hostname: "test-server",
      os: "Ubuntu 22.04",
      uptime_seconds: 3600,
      cpu_count: 4,
      cpu_model: "Test CPU",
      cpu_load_1m: 1.5,
      cpu_load_5m: 1.2,
      cpu_load_15m: 1.0,
      mem_total_mb: 8000,
      mem_used_mb: 4000,
      mem_available_mb: 4000,
      disk_total_gb: 100,
      disk_used_gb: 50,
      disk_available_gb: 50,
      disk_use_percent: 50,
    },
    xray: {
      running: true,
      pid: 1234,
      memory_mb: 50,
      cpu_time: "0:01:00",
      uptime: "1 hour",
      version: "26.5.9",
    },
    userTraffic: [],
    inboundTraffic: [],
    vpsLabel: "Test VPS",
  };

  const html = vpsPage(input);

  assert.ok(html.includes("onclick='checkXrayUpdate()'") ||
            html.includes('onclick="checkXrayUpdate()"'), "Should have properly quoted onclick handler");
  assert.ok(html.includes("onclick='loadXrayConfig()'") ||
            html.includes('onclick="loadXrayConfig()"'), "Should have properly quoted loadXrayConfig handler");
  assert.ok(html.includes("onclick='loadXrayLogs()'") ||
            html.includes('onclick="loadXrayLogs()"'), "Should have properly quoted loadXrayLogs handler");
});

test("VPS page inline scripts parse without syntax errors", () => {
  const input = {
    connected: true,
    system: {
      hostname: "test-server",
      os: "Ubuntu 22.04",
      uptime_seconds: 3600,
      cpu_count: 4,
      cpu_model: "Test CPU",
      cpu_load_1m: 1.5,
      cpu_load_5m: 1.2,
      cpu_load_15m: 1.0,
      mem_total_mb: 8000,
      mem_used_mb: 4000,
      mem_available_mb: 4000,
      disk_total_gb: 100,
      disk_used_gb: 50,
      disk_available_gb: 50,
      disk_use_percent: 50,
    },
    xray: {
      running: true,
      pid: 1234,
      memory_mb: 50,
      cpu_time: "0:01:00",
      uptime: "1 hour",
      version: "26.5.9",
    },
    singBox: {
      running: true,
      pid: 2345,
      memory_mb: 32,
      cpu_time: "0:00:30",
      uptime: "30 minutes",
      version: "1.13.14",
    },
    userTraffic: [],
    inboundTraffic: [],
    vpsLabel: "Test VPS",
  };

  const html = vpsPage(input);
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

  assert.ok(scripts.length > 0, "Page should embed at least one script");
  scripts.forEach((script, index) => {
    assert.doesNotThrow(() => new Function(script), `inline script #${index} must parse`);
  });
});

test("VPS page update card HTML is valid", () => {
  const input = {
    connected: true,
    system: {
      hostname: "test-server",
      os: "Ubuntu 22.04",
      uptime_seconds: 3600,
      cpu_count: 4,
      cpu_model: "Test CPU",
      cpu_load_1m: 1.5,
      cpu_load_5m: 1.2,
      cpu_load_15m: 1.0,
      mem_total_mb: 8000,
      mem_used_mb: 4000,
      mem_available_mb: 4000,
      disk_total_gb: 100,
      disk_used_gb: 50,
      disk_available_gb: 50,
      disk_use_percent: 50,
    },
    xray: {
      running: true,
      pid: 1234,
      memory_mb: 50,
      cpu_time: "0:01:00",
      uptime: "1 hour",
      version: "26.5.9",
    },
    userTraffic: [],
    inboundTraffic: [],
    vpsLabel: "Test VPS",
  };

  const html = vpsPage(input);

  assert.ok(html.includes("xray-update-card"), "Should have update card element");
  assert.ok(html.includes("xray-update-content"), "Should have update content element");

  const updateCardStart = html.indexOf("xray-update-card");
  const updateCardEnd = html.indexOf("</div>", updateCardStart);

  assert.ok(updateCardStart > 0, "Update card should exist");
  assert.ok(updateCardEnd > updateCardStart, "Update card should have content");
});
