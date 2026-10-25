#!/usr/bin/env bash
set -euo pipefail

# Starts a disposable local fixture for manually checking the branch composer.
# It only uses Wrangler local bindings and removes its state on exit.
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

state_dir=".wrangler/local-branch-workbench-demo"
config_dir="$state_dir/config"
worker_port="8787"
vite_port="5173"
base_url="http://127.0.0.1:$worker_port"
worker_log="${TMPDIR:-/tmp}/cloud-genealogy-local-branch-worker-$$.log"
vite_log="${TMPDIR:-/tmp}/cloud-genealogy-local-branch-vite-$$.log"
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
  if [[ "$completed" == true ]]; then rm -f "$worker_log" "$vite_log"; else printf '演示启动未完成；诊断日志保留在：\n  %s\n  %s\n' "$worker_log" "$vite_log" >&2; fi
}
trap cleanup EXIT INT TERM

rm -rf "$state_dir"
npx wrangler d1 migrations apply DB --local --persist-to "$state_dir" >/dev/null
npx wrangler d1 execute DB --local --persist-to "$state_dir" --command "
  INSERT INTO lineage (id, name, created_at) VALUES ('71000000-0000-4000-8000-000000000001', '本地房支工作台演示世系', '2026-10-25T00:00:00Z');
  INSERT INTO person (id, display_name, visibility, created_at, updated_at) VALUES
    ('72000000-0000-4000-8000-000000000001', '演示始祖', 'MEMBER', '2026-10-25T00:00:00Z', '2026-10-25T00:00:00Z'),
    ('72000000-0000-4000-8000-000000000002', '演示成员', 'MEMBER', '2026-10-25T00:00:00Z', '2026-10-25T00:00:00Z');
  INSERT INTO branch (id, lineage_id, parent_branch_id, name, branch_kind, created_at) VALUES
    ('73000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', NULL, '演示总房', 'agnatic', '2026-10-25T00:00:00Z'),
    ('73000000-0000-4000-8000-000000000002', '71000000-0000-4000-8000-000000000001', '73000000-0000-4000-8000-000000000001', '演示成员房', 'agnatic', '2026-10-25T00:00:00Z');
" >/dev/null

npx wrangler dev --local --port "$worker_port" --persist-to "$state_dir" \
  --var AUTH_RATE_LIMIT_SECRET:local-branch-workbench-rate-limit-secret \
  --var BOOTSTRAP_SECRET:local-branch-workbench-bootstrap-secret >"$worker_log" 2>&1 &
worker_pid="$!"
for _ in {1..40}; do curl --silent --fail "$base_url/api/health" >/dev/null 2>&1 && break; sleep 0.25; done
if ! curl --silent --fail "$base_url/api/health" >/dev/null; then tail -n 80 "$worker_log" >&2; exit 1; fi

BASE_URL="$base_url" node --input-type=module <<'NODE'
import assert from "node:assert/strict";

const baseUrl = process.env.BASE_URL;
async function request(path, { method = "GET", body, cookie, csrf, bootstrapSecret } = {}) {
  const response = await fetch(`${baseUrl}${path}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}), ...(bootstrapSecret ? { "x-bootstrap-secret": bootstrapSecret } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null, cookies: response.headers.getSetCookie() };
}
function cookie(result) { const value = result.cookies.find((entry) => entry.startsWith("cg_session="))?.split(";", 1)[0]; assert.ok(value); return value; }
function expect(result, status) { assert.equal(result.response.status, status, JSON.stringify(result.body)); }

expect(await request("/api/setup/bootstrap", { method: "POST", bootstrapSecret: "local-branch-workbench-bootstrap-secret", body: { username: "demo.branch.admin", password: "local-branch-workbench-password", genealogyName: "本地房支管理员" } }), 201);
const adminLogin = await request("/api/auth/login", { method: "POST", body: { username: "demo.branch.admin", password: "local-branch-workbench-password" } }); expect(adminLogin, 200);
const adminCookie = cookie(adminLogin); const adminCsrf = adminLogin.body.csrfToken;
const reviewerPerson = await request("/api/admin/persons", { method: "POST", cookie: adminCookie, csrf: adminCsrf, body: { displayName: "本地房支复核管理员", visibility: "MEMBER" } }); expect(reviewerPerson, 201);
expect(await request("/api/auth/register", { method: "POST", body: { username: "demo.branch.reviewer", password: "local-branch-workbench-password", genealogyName: "本地房支复核管理员" } }), 201);
const pending = await request("/api/admin/accounts/pending", { cookie: adminCookie }); expect(pending, 200);
const reviewer = pending.body.accounts.find((account) => account.username === "demo.branch.reviewer"); assert.ok(reviewer);
expect(await request(`/api/admin/accounts/${reviewer.id}/approve`, { method: "POST", cookie: adminCookie, csrf: adminCsrf, body: { personId: reviewerPerson.body.person.id, role: "admin", version: reviewer.version } }), 200);
const reviewerLogin = await request("/api/auth/login", { method: "POST", body: { username: "demo.branch.reviewer", password: "local-branch-workbench-password" } }); expect(reviewerLogin, 200);
const validFrom = new Date(Date.now() - 60_000).toISOString(); const validUntil = new Date(Date.now() + 86_400_000).toISOString();
expect(await request("/api/admin/lineages/71000000-0000-4000-8000-000000000001/reviewer-assignments", { method: "POST", cookie: adminCookie, csrf: adminCsrf, body: { reviewerAccountId: reviewer.id, validFrom, validUntil, reason: "本地房支工作台演示" } }), 201);
expect(await request("/api/admin/lineages/71000000-0000-4000-8000-000000000001/revisions/publish", { method: "POST", cookie: adminCookie, csrf: adminCsrf, body: { revisionId: "74000000-0000-4000-8000-000000000001", expectedPointerVersion: 0, edges: [{ parentPersonId: "72000000-0000-4000-8000-000000000001", childPersonId: "72000000-0000-4000-8000-000000000002" }] } }), 201);
NODE

npx wrangler d1 execute DB --local --persist-to "$state_dir" --command "
  INSERT INTO branch_membership_snapshot (id, revision_id, branch_id, person_id, membership_kind, created_at)
  VALUES ('75000000-0000-4000-8000-000000000001', '74000000-0000-4000-8000-000000000001', '73000000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000002', 'blood_primary', '2026-10-25T00:00:00Z');
" >/dev/null

BASE_URL="$base_url" node --input-type=module <<'NODE'
import assert from "node:assert/strict";
const login = await fetch(`${process.env.BASE_URL}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "demo.branch.admin", password: "local-branch-workbench-password" }) });
assert.equal(login.status, 200);
const cookie = login.headers.getSetCookie().find((entry) => entry.startsWith("cg_session="))?.split(";", 1)[0];
assert.ok(cookie);
const workbench = await fetch(`${process.env.BASE_URL}/api/admin/lineages/71000000-0000-4000-8000-000000000001/branch-workbench`, { headers: { cookie } });
assert.equal(workbench.status, 200);
const body = await workbench.json();
assert.equal(body.branches.find((branch) => branch.branchId === "73000000-0000-4000-8000-000000000002")?.membershipCount, 1);
NODE

npx vite --host 127.0.0.1 --port "$vite_port" --strictPort >"$vite_log" 2>&1 &
vite_pid="$!"
for _ in {1..40}; do curl --silent --fail "http://127.0.0.1:$vite_port/api/health" >/dev/null 2>&1 && break; sleep 0.25; done
if ! curl --silent --fail "http://127.0.0.1:$vite_port/api/health" >/dev/null; then tail -n 80 "$vite_log" >&2; exit 1; fi

if [[ "${LOCAL_BRANCH_WORKBENCH_DEMO_VERIFY_ONLY:-0}" == "1" ]]; then
  completed=true
  printf '本地房支工作台演示服务验证通过（Worker、Vite 与 /api 代理均可访问）。\n'
  exit 0
fi

completed=true
printf '\n本地房支工作台演示已启动（仅本机，不部署）。\n\n打开： http://127.0.0.1:%s\n登录： demo.branch.admin\n密码： local-branch-workbench-password\n\n验收建议：\n1. 选择“本地房支工作台演示世系”；先在编排器加入条目后清空，确认审核队列没有新增草稿。\n2. 单独退休“演示成员房”并创建草稿，确认预览显示成员依赖且提交不可用。\n3. 清空本地编排，重新编排“移除成员”加“退休”，确认 preview 通过；输入“演示成员房”后才可提交审核。\n按 Ctrl+C 结束演示并清理隔离状态。\n\n' "$vite_port"
wait "$vite_pid"
