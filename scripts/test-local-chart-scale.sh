#!/usr/bin/env bash
set -euo pipefail

# A repeatable, local-only scale regression. It creates a separate D1 state,
# publishes a 1000-person snapshot through the authenticated API, then reads
# the hanging-chart projection and layout. It never uses --remote.
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

state_dir=".wrangler/local-chart-scale"
config_dir="$state_dir/config"
port="${LOCAL_CHART_SCALE_PORT:-8796}"
base_url="http://127.0.0.1:$port"
log_file="$(mktemp)"
worker_pid=""

export XDG_CONFIG_HOME="$config_dir"
export WRANGLER_SEND_METRICS=false

cleanup() {
  if [[ -n "$worker_pid" ]] && kill -0 "$worker_pid" 2>/dev/null; then
    kill "$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
  fi
  rm -rf "$state_dir"
  rm -f "$log_file"
}
trap cleanup EXIT

rm -rf "$state_dir"
npx wrangler d1 migrations apply DB --local --persist-to "$state_dir" >/dev/null

seed_sql="$(node --input-type=module <<'NODE'
const personId = (index) => `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const rows = Array.from({ length: 1000 }, (_, index) =>
  `('${personId(index)}', '规模测试人物${index}', 'MEMBER', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
);
process.stdout.write([
  "PRAGMA foreign_keys = ON;",
  "INSERT INTO lineage (id, name, created_at) VALUES ('20000000-0000-4000-8000-000000000001', '本地千人规模世系', '2026-01-01T00:00:00Z');",
  `INSERT INTO person (id, display_name, visibility, created_at, updated_at) VALUES ${rows.join(",")};`,
].join("\n"));
NODE
)"
npx wrangler d1 execute DB --local --persist-to "$state_dir" --command "$seed_sql" >/dev/null

npx wrangler dev --local --port "$port" --persist-to "$state_dir" \
  --var AUTH_RATE_LIMIT_SECRET:local-chart-scale-rate-limit-secret \
  --var BOOTSTRAP_SECRET:local-chart-scale-bootstrap-secret >"$log_file" 2>&1 &
worker_pid="$!"

for _ in {1..40}; do
  if curl --silent --fail "$base_url/api/health" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
if ! curl --silent --fail "$base_url/api/health" >/dev/null; then
  echo "本地规模测试 Worker 未能启动：" >&2
  tail -n 80 "$log_file" >&2
  exit 1
fi

BASE_URL="$base_url" node --input-type=module <<'NODE'
import assert from "node:assert/strict";

const baseUrl = process.env.BASE_URL;
const lineageId = "20000000-0000-4000-8000-000000000001";
const revisionId = "30000000-0000-4000-8000-000000000001";
const personId = (index) => `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

async function request(path, { method = "GET", body, cookie, csrf, bootstrapSecret } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { "x-csrf-token": csrf } : {}),
      ...(bootstrapSecret ? { "x-bootstrap-secret": bootstrapSecret } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null, cookies: response.headers.getSetCookie() };
}

const bootstrap = await request("/api/setup/bootstrap", {
  method: "POST", bootstrapSecret: "local-chart-scale-bootstrap-secret",
  body: { username: "scale.admin", password: "local-chart-scale-password", genealogyName: "规模管理员" },
});
assert.equal(bootstrap.response.status, 201);
const login = await request("/api/auth/login", {
  method: "POST", body: { username: "scale.admin", password: "local-chart-scale-password" },
});
assert.equal(login.response.status, 200);
const sessionCookie = login.cookies.find((cookie) => cookie.startsWith("cg_session="))?.split(";", 1)[0];
assert.ok(sessionCookie, "登录必须返回会话 Cookie");

const edges = Array.from({ length: 999 }, (_, offset) => ({
  parentPersonId: personId(Math.floor(offset / 3)),
  childPersonId: personId(offset + 1),
}));
const publishStartedAt = performance.now();
const publish = await request(`/api/admin/lineages/${lineageId}/revisions/publish`, {
  method: "POST", cookie: sessionCookie, csrf: login.body.csrfToken,
  body: { revisionId, expectedPointerVersion: 0, edges },
});
assert.equal(publish.response.status, 201, JSON.stringify(publish.body));
const publishElapsedMs = performance.now() - publishStartedAt;

const chartStartedAt = performance.now();
const chart = await request(`/api/admin/lineages/${lineageId}/hanging-chart`, { cookie: sessionCookie });
const chartElapsedMs = performance.now() - chartStartedAt;
assert.equal(chart.response.status, 200, JSON.stringify(chart.body));
assert.equal(chart.body.projection.nodes.length, 1000);
assert.equal(chart.body.layout.nodes.length, 1000);
assert.equal(chart.body.layout.connectors.length, 999);
assert.equal(new Set(chart.body.layout.nodes.map((node) => `${node.x}:${node.y}`)).size, 1000);
console.log(`本地千人吊线图验证通过：发布 ${publishElapsedMs.toFixed(1)}ms，读取与布局 ${chartElapsedMs.toFixed(1)}ms。`);
NODE
