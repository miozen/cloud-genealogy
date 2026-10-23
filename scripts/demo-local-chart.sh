#!/usr/bin/env bash
set -euo pipefail

# Starts a disposable local browser demo for the P0-3 hanging chart. It uses
# only Wrangler local state and removes it when the demo stops.
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

state_dir=".wrangler/local-chart-demo"
config_dir="$state_dir/config"
worker_port="8787"
vite_port="5173"
base_url="http://127.0.0.1:$worker_port"
worker_log="${TMPDIR:-/tmp}/cloud-genealogy-local-chart-worker-$$.log"
vite_log="${TMPDIR:-/tmp}/cloud-genealogy-local-chart-vite-$$.log"
worker_pid=""
vite_pid=""
completed=false

export XDG_CONFIG_HOME="$config_dir"
export WRANGLER_SEND_METRICS=false

cleanup() {
  for pid in "$vite_pid" "$worker_pid"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  rm -rf "$state_dir"
  if [[ "$completed" == true ]]; then
    rm -f "$worker_log" "$vite_log"
  else
    printf '演示启动未完成；诊断日志保留在：\n  %s\n  %s\n' "$worker_log" "$vite_log" >&2
  fi
}
trap cleanup EXIT INT TERM

rm -rf "$state_dir"
printf '正在创建隔离的本地演示数据…\n'
npx wrangler d1 migrations apply DB --local --persist-to "$state_dir" >/dev/null

seed_file="$state_dir/local-chart-demo-seed.sql"
node --input-type=module >"$seed_file" <<'NODE'
const personId = (index) => `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const rows = Array.from({ length: 1000 }, (_, index) =>
  `('${personId(index)}', '演示族人${index + 1}', 'MEMBER', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
);
const personInserts = Array.from({ length: Math.ceil(rows.length / 100) }, (_, index) =>
  `INSERT INTO person (id, display_name, visibility, created_at, updated_at) VALUES ${rows.slice(index * 100, (index + 1) * 100).join(",")};`,
);
process.stdout.write([
  "PRAGMA foreign_keys = ON;",
  "INSERT INTO lineage (id, name, created_at) VALUES ('50000000-0000-4000-8000-000000000001', '本地千人演示世系', '2026-01-01T00:00:00Z');",
  ...personInserts,
].join("\n"));
NODE
npx wrangler d1 execute DB --local --persist-to "$state_dir" --file "$seed_file" >/dev/null

printf '正在启动本地 Worker（http://127.0.0.1:%s）…\n' "$worker_port"
npx wrangler dev --local --port "$worker_port" --persist-to "$state_dir" \
  --var AUTH_RATE_LIMIT_SECRET:local-chart-demo-rate-limit-secret \
  --var BOOTSTRAP_SECRET:local-chart-demo-bootstrap-secret >"$worker_log" 2>&1 &
worker_pid="$!"
for _ in {1..40}; do
  if curl --silent --fail "$base_url/api/health" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
if ! curl --silent --fail "$base_url/api/health" >/dev/null; then
  echo "本地 Worker 未能启动：" >&2
  tail -n 80 "$worker_log" >&2
  exit 1
fi

printf '正在发布演示世系…\n'
BASE_URL="$base_url" node --input-type=module <<'NODE'
import assert from "node:assert/strict";

const baseUrl = process.env.BASE_URL;
const lineageId = "50000000-0000-4000-8000-000000000001";
const revisionId = "60000000-0000-4000-8000-000000000001";
const personId = (index) => `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

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
  method: "POST", bootstrapSecret: "local-chart-demo-bootstrap-secret",
  body: { username: "demo.admin", password: "local-chart-demo-password", genealogyName: "本地演示管理员" },
});
assert.equal(bootstrap.response.status, 201, JSON.stringify(bootstrap.body));
const login = await request("/api/auth/login", {
  method: "POST", body: { username: "demo.admin", password: "local-chart-demo-password" },
});
assert.equal(login.response.status, 200, JSON.stringify(login.body));
const cookie = login.cookies.find((value) => value.startsWith("cg_session="))?.split(";", 1)[0];
assert.ok(cookie, "本地演示管理员必须能取得会话");
const edges = Array.from({ length: 999 }, (_, offset) => ({
  parentPersonId: personId(Math.floor(offset / 3)),
  childPersonId: personId(offset + 1),
}));
const publish = await request(`/api/admin/lineages/${lineageId}/revisions/publish`, {
  method: "POST", cookie, csrf: login.body.csrfToken,
  body: { revisionId, expectedPointerVersion: 0, edges },
});
assert.equal(publish.response.status, 201, JSON.stringify(publish.body));
NODE

printf '正在启动本地网页（http://127.0.0.1:%s）…\n' "$vite_port"
npx vite --host 127.0.0.1 --port "$vite_port" --strictPort >"$vite_log" 2>&1 &
vite_pid="$!"
for _ in {1..40}; do
  if curl --silent --fail "http://127.0.0.1:$vite_port" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
if ! curl --silent --fail "http://127.0.0.1:$vite_port" >/dev/null; then
  echo "本地 Vite 未能启动：" >&2
  tail -n 80 "$vite_log" >&2
  exit 1
fi

if ! curl --silent --fail "http://127.0.0.1:$vite_port/api/health" >/dev/null; then
  printf 'Vite 未能将 /api 请求代理至本地 Worker：\n' >&2
  tail -n 80 "$vite_log" >&2
  exit 1
fi

if [[ "${LOCAL_CHART_DEMO_VERIFY_ONLY:-0}" == "1" ]]; then
  completed=true
  printf '本地千人吊线图演示服务验证通过（Worker、Vite 与 /api 代理均可访问）。\n'
  exit 0
fi

completed=true
printf '\n本地千人吊线图演示已启动（仅本机，不部署）。\n\n打开： http://127.0.0.1:%s\n登录： demo.admin\n密码： local-chart-demo-password\n\n登录后，在“传统吊线图”中选择“本地千人演示世系”，点击“载入吊线图”。\n可测试拖拽、缩放、姓名定位、人物资料侧栏与 SVG 导出。\n按 Ctrl+C 结束演示并清理隔离的本地 D1/R2 状态。\n\n' "$vite_port"

wait "$vite_pid"
