import assert from "node:assert/strict";
import test from "node:test";
import type { DbPool } from "../src/db.js";
import { updateUser } from "../src/repository.js";

test("user endpoint resave preserves all data-driven public catalog relays", async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return sql.startsWith("select id::text from vpn_clients") ? { rows: [{ id: "client-1" }] } : { rows: [] };
    },
    release: () => undefined,
  };
  const pool = { connect: async () => client } as unknown as DbPool;

  await updateUser(pool, "account-1", { endpointIds: ["smart-us-relay"] });

  const removeStale = calls.find((call) => call.sql.startsWith("delete from client_profiles"));
  assert.ok(removeStale);
  assert.match(removeStale.sql, /public_catalog/);
  assert.deepEqual(removeStale.params, ["client-1", ["smart-us-relay"]]);
  assert.ok(calls.some((call) => call.sql.includes("insert into client_profiles") && call.sql.includes("public_catalog")));
});
