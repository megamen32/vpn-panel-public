#!/usr/bin/env node
// Read-only report from the existing telemetry database. Never prints credentials.
import pg from 'pg';

const options = Object.fromEntries(process.argv.slice(2).map(arg => {
  const [key, ...value] = arg.replace(/^--/, '').split('=');
  return [key, value.join('=')];
}));
const days = Number(options.days || 120);
if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error('--days must be 1..366');
const ids = options.endpoints ? options.endpoints.split(',') : null;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const endpoints = (await pool.query(
    'select id,label,kind,enabled from endpoints where ($1::text[] is null or id=any($1)) order by sort_order,id', [ids],
  )).rows;
  const parameters = [days, ids];
  const scope = `event_timestamp >= now()-($1::int*interval '1 day')
    and ($2::text[] is null or endpoint_id=any($2))`;
  const history = (await pool.query(`
    select endpoint_id,target_id,network_class,client,access_method,wire_method,
      date_trunc('day',event_timestamp)::date as day,
      count(*)::int as observations,
      count(*) filter(where coalesce((payload->>'eligible')::boolean,false))::int as passed,
      count(*) filter(where nullif(payload->>'error','') is not null)::int as runner_errors,
      min(event_timestamp) as first_at,max(event_timestamp) as last_at
    from vpn_test_events where event_type='endpoint_finished' and ${scope}
    group by 1,2,3,4,5,6,7 order by 7 desc,1,2`, parameters)).rows;
  const stages = (await pool.query(`
    select endpoint_id,target_id,network_class,client,access_method,wire_method,stage,
      count(*)::int as samples,
      count(*) filter(where coalesce((payload->>'contentOk')::boolean,
        (payload->>'content_ok')::boolean,(payload->>'ok')::boolean,false))::int as passed,
      round((percentile_cont(.5) within group(order by
        coalesce(nullif(payload->>'latencyMs','')::numeric,nullif(payload->>'latency_ms','')::numeric)))::numeric,1) as median_ms,
      round((percentile_cont(.95) within group(order by
        coalesce(nullif(payload->>'latencyMs','')::numeric,nullif(payload->>'latency_ms','')::numeric)))::numeric,1) as p95_ms,
      round((percentile_cont(.5) within group(order by nullif(payload->>'mbps','')::numeric)
        filter(where (payload->>'ok')::boolean))::numeric,2) as median_mbps,
      min(event_timestamp) as first_at,max(event_timestamp) as last_at
    from vpn_test_events where event_type='stage_finished' and ${scope}
    group by 1,2,3,4,5,6,7 order by 1,2,7`, parameters)).rows;
  // A verdict that was never refreshed must not read like a current one, so the
  // report separates endpoints measured inside the window from endpoints whose
  // last observation has aged out of it.
  const staleAfterMs = Number(options.staleHours || 12) * 3600 * 1000;
  const lastSeen = new Map();
  for (const row of history) {
    const at = new Date(row.last_at).getTime();
    if (!Number.isFinite(at)) continue;
    if (!lastSeen.has(row.endpoint_id) || at > lastSeen.get(row.endpoint_id)) lastSeen.set(row.endpoint_id, at);
  }
  const now = Date.now();
  const measuredInWindow = [...lastSeen.entries()]
    .filter(([, at]) => now - at <= staleAfterMs)
    .map(([endpoint]) => endpoint).sort();
  const staleEndpoints = [...lastSeen.entries()]
    .filter(([, at]) => now - at > staleAfterMs)
    .map(([endpoint, at]) => ({ endpoint, lastSeenAt: new Date(at).toISOString() }))
    .sort((a, b) => a.endpoint.localeCompare(b.endpoint));
  const neverMeasured = endpoints.filter((endpoint) => !lastSeen.has(endpoint.id)).map((endpoint) => endpoint.id);
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), windowDays: days,
    coverage: { staleAfterHours: staleAfterMs / 3600000, measuredInWindow, staleEndpoints, neverMeasured },
    notes: ['Compare only matching target/client/access/wire dimensions.',
      'Runner errors are not endpoint failures; speed includes successful downloads only.',
      'HTTP latency includes connection/TLS/response, not ICMP ping.',
      'Old or small samples are historical context, not current performance guarantees.'],
    endpoints, history, stages }, null, 2));
} finally { await pool.end(); }
