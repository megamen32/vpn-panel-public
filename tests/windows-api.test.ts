import test from "node:test";
import assert from "node:assert/strict";
import fastify from "fastify";
import { registerWindowsRoutes } from "../src/windows-api.js";
import { bezWindowsInstallerScript } from "../src/windows-installer.js";

test("windows API serves the PowerShell bootstrap as no-store plain text", async () => {
  const app = fastify();
  registerWindowsRoutes(app, { baseUrl: "https://vpn.bezrabotnyi.com" });

  const response = await app.inject({ method: "GET", url: "/install/bez-windows" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.body, bezWindowsInstallerScript("https://vpn.bezrabotnyi.com"));
  assert.ok(response.body.includes("$BaseUrl = 'https://vpn.bezrabotnyi.com'"));
  assert.ok(response.body.includes("function Install-Bez"));
  await app.close();
});
