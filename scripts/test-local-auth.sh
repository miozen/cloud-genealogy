#!/usr/bin/env bash
set -euo pipefail

# Runs only against a separate Wrangler local-state directory. It neither
# reads nor writes preview/production resources or the normal local D1 state.
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

state_dir=".wrangler/local-auth-integration"
config_dir="$state_dir/config"
port="${LOCAL_AUTH_TEST_PORT:-8791}"
base_url="http://127.0.0.1:$port"
log_file="$(mktemp)"
worker_pid=""

export XDG_CONFIG_HOME="$config_dir"
export WRANGLER_SEND_METRICS=false

clean_test_rows() {
  npx wrangler d1 execute DB --local --persist-to "$state_dir" --command "
    DELETE FROM lineage_published_pointer;
    DELETE FROM lineage_succession_snapshot;
    DELETE FROM canonical_relation_snapshot;
    DELETE FROM branch_membership_snapshot;
    UPDATE lineage_revision SET based_on_revision_id = NULL;
    DELETE FROM lineage_revision;
    DELETE FROM branch;
    DELETE FROM lineage;
    DELETE FROM audit_log;
    DELETE FROM source_person_link;
    DELETE FROM source_relation_claim;
    DELETE FROM source_fact_claim;
    DELETE FROM source_person_record;
    DELETE FROM genealogy_edition;
    DELETE FROM genealogy;
    DELETE FROM auth_login_rate_limit;
    DELETE FROM auth_session;
    DELETE FROM account_person_link;
    DELETE FROM account_role;
    DELETE FROM account_scope;
    DELETE FROM person;
    DELETE FROM account;
  " >/dev/null
}

shutdown() {
  if [[ -n "$worker_pid" ]] && kill -0 "$worker_pid" 2>/dev/null; then
    kill "$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
  fi
  clean_test_rows 2>/dev/null || true
  rm -f "$log_file"
}
trap shutdown EXIT

npx wrangler d1 migrations apply DB --local --persist-to "$state_dir" >/dev/null
clean_test_rows
npx wrangler d1 execute DB --local --persist-to "$state_dir" --command "
  INSERT INTO lineage (id, name, created_at) VALUES ('11111111-1111-4111-8111-111111111111', '本地测试世系', '2026-01-01T00:00:00Z');
" >/dev/null

npx wrangler dev --local --port "$port" --persist-to "$state_dir" \
  --var AUTH_RATE_LIMIT_SECRET:local-integration-rate-limit-secret \
  --var BOOTSTRAP_SECRET:local-integration-bootstrap-secret >"$log_file" 2>&1 &
worker_pid="$!"

for _ in {1..40}; do
  if curl --silent --fail "$base_url/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

if ! curl --silent --fail "$base_url/api/health" >/dev/null; then
  echo "本地 Worker 未能启动：" >&2
  tail -n 80 "$log_file" >&2
  exit 1
fi

BASE_URL="$base_url" node --input-type=module <<'NODE'
import assert from "node:assert/strict";

const baseUrl = process.env.BASE_URL;

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
  return {
    response,
    body: text ? JSON.parse(text) : null,
    cookies: typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [],
  };
}

function expectStatus(result, expected) {
  assert.equal(result.response.status, expected, JSON.stringify(result.body));
}

function sessionCookie(result) {
  const entry = result.cookies.find((value) => value.startsWith("cg_session="));
  assert.ok(entry, "登录响应应设置会话 Cookie");
  return entry.split(";", 1)[0];
}

const password = "local-auth-integration-password";
const newPassword = "local-auth-integration-new-password";

expectStatus(await request("/api/health"), 200);

const bootstrap = await request("/api/setup/bootstrap", {
  method: "POST",
  bootstrapSecret: "local-integration-bootstrap-secret",
  body: { username: "local.admin", password, genealogyName: "本地管理员" },
});
expectStatus(bootstrap, 201);

const registration = await request("/api/auth/register", {
  method: "POST",
  body: {
    username: "local.member",
    password,
    genealogyName: "本地族人",
    branchName: "测试房",
    ancestorName: "测试祖先",
  },
});
expectStatus(registration, 201);
assert.equal(registration.body.status, "pending");

const pendingLogin = await request("/api/auth/login", {
  method: "POST",
  body: { username: "local.member", password },
});
expectStatus(pendingLogin, 403);
assert.equal(pendingLogin.body.code, "account_unavailable");
assert.equal(pendingLogin.cookies.length, 0);

const adminLogin = await request("/api/auth/login", {
  method: "POST",
  body: { username: "local.admin", password },
});
expectStatus(adminLogin, 200);
const adminCookie = sessionCookie(adminLogin);
const adminCsrf = adminLogin.body.csrfToken;

const pending = await request("/api/admin/accounts/pending", { cookie: adminCookie });
expectStatus(pending, 200);
const member = pending.body.accounts.find((account) => account.username === "local.member");
assert.ok(member, "待审核账号必须可由管理员读取");

const rejectedForMissingCsrf = await request("/api/admin/persons", {
  method: "POST",
  cookie: adminCookie,
  body: { displayName: "本地人物锚点", visibility: "MEMBER" },
});
expectStatus(rejectedForMissingCsrf, 403);
assert.equal(rejectedForMissingCsrf.body.code, "csrf_token_invalid");

const personResult = await request("/api/admin/persons", {
  method: "POST",
  cookie: adminCookie,
  csrf: adminCsrf,
  body: { displayName: "本地人物锚点", visibility: "MEMBER" },
});
expectStatus(personResult, 201);

const secondPerson = await request("/api/admin/persons", {
  method: "POST",
  cookie: adminCookie,
  csrf: adminCsrf,
  body: { displayName: "本地承谱父", visibility: "MEMBER" },
});
expectStatus(secondPerson, 201);

const genealogy = await request("/api/admin/genealogies", {
  method: "POST", cookie: adminCookie, csrf: adminCsrf, body: { title: "本地测试谱书" },
});
expectStatus(genealogy, 201);
const edition = await request(`/api/admin/genealogies/${genealogy.body.genealogy.id}/editions`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf, body: { title: "民国续修本", editionLabel: "测试版" },
});
expectStatus(edition, 201);
const sourceRecord = await request(`/api/admin/genealogy-editions/${edition.body.edition.id}/source-person-records`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { sourceKey: "卷一-001", nameText: "本地人物锚点", rawText: "本地测试原文记载" },
});
expectStatus(sourceRecord, 201);
const sourceLink = await request(`/api/admin/source-person-records/${sourceRecord.body.sourcePersonRecord.id}/links`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf, body: { personId: personResult.body.person.id },
});
expectStatus(sourceLink, 201);
assert.equal(sourceLink.body.sourcePersonLink.personId, personResult.body.person.id);

const lineageId = "11111111-1111-4111-8111-111111111111";
expectStatus(await request(`/api/admin/lineages/${lineageId}/revisions/preview`, {
  method: "POST",
  cookie: adminCookie,
  body: { edges: [] },
}), 403);
const invalidPublish = await request(`/api/admin/lineages/${lineageId}/revisions/publish`, {
  method: "POST",
  cookie: adminCookie,
  csrf: adminCsrf,
  body: {
    revisionId: "22222222-2222-4222-8222-222222222222",
    expectedPointerVersion: 0,
    edges: [
      { parentPersonId: personResult.body.person.id, childPersonId: secondPerson.body.person.id },
      { parentPersonId: secondPerson.body.person.id, childPersonId: personResult.body.person.id },
    ],
  },
});
expectStatus(invalidPublish, 400);
assert.equal(invalidPublish.body.code, "revision_invalid");
const validPublish = await request(`/api/admin/lineages/${lineageId}/revisions/publish`, {
  method: "POST",
  cookie: adminCookie,
  csrf: adminCsrf,
  body: {
    revisionId: "33333333-3333-4333-8333-333333333333",
    expectedPointerVersion: 0,
    edges: [{ parentPersonId: personResult.body.person.id, childPersonId: secondPerson.body.person.id }],
  },
});
expectStatus(validPublish, 201);
const rollback = await request(`/api/admin/lineages/${lineageId}/revisions/rollback`, {
  method: "POST",
  cookie: adminCookie,
  csrf: adminCsrf,
  body: {
    targetRevisionId: "33333333-3333-4333-8333-333333333333",
    newRevisionId: "44444444-4444-4444-8444-444444444444",
    expectedPointerVersion: 1,
  },
});
expectStatus(rollback, 201);
assert.equal(rollback.body.revisionId, "44444444-4444-4444-8444-444444444444");
const stalePublish = await request(`/api/admin/lineages/${lineageId}/revisions/publish`, {
  method: "POST",
  cookie: adminCookie,
  csrf: adminCsrf,
  body: {
    revisionId: "55555555-5555-4555-8555-555555555555",
    expectedPointerVersion: 1,
    edges: [{ parentPersonId: personResult.body.person.id, childPersonId: secondPerson.body.person.id }],
  },
});
expectStatus(stalePublish, 409);
assert.equal(stalePublish.body.code, "revision_conflict");

const approval = await request(`/api/admin/accounts/${member.id}/approve`, {
  method: "POST",
  cookie: adminCookie,
  csrf: adminCsrf,
  body: { personId: personResult.body.person.id, role: "editor", version: member.version },
});
expectStatus(approval, 200);

const memberLogin = await request("/api/auth/login", {
  method: "POST",
  body: { username: "local.member", password },
});
expectStatus(memberLogin, 200);
const memberCookie = sessionCookie(memberLogin);
const memberCsrf = memberLogin.body.csrfToken;

const identity = await request("/api/me", { cookie: memberCookie });
expectStatus(identity, 200);
assert.deepEqual(identity.body.account.roles.sort(), ["editor", "member"]);

const passwordReset = await request(`/api/admin/accounts/${member.id}/reset-password`, {
  method: "POST",
  cookie: adminCookie,
  csrf: adminCsrf,
  body: { password: newPassword },
});
expectStatus(passwordReset, 204);

expectStatus(await request("/api/me", { cookie: memberCookie }), 401);
expectStatus(
  await request("/api/auth/login", { method: "POST", body: { username: "local.member", password } }),
  401,
);

const relogin = await request("/api/auth/login", {
  method: "POST",
  body: { username: "local.member", password: newPassword },
});
expectStatus(relogin, 200);
const refreshedCookie = sessionCookie(relogin);

expectStatus(
  await request("/api/auth/logout", { method: "POST", cookie: refreshedCookie, csrf: relogin.body.csrfToken }),
  204,
);
expectStatus(await request("/api/me", { cookie: refreshedCookie }), 401);

console.log("本地认证集成流程通过。");
NODE
