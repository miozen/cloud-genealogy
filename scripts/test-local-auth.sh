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

# This directory belongs only to this integration test. Starting fresh prevents
# old schema fixtures from affecting a later test run.
rm -rf "$state_dir"

clean_test_rows() {
  npx wrangler d1 execute DB --local --persist-to "$state_dir" --command "
    DELETE FROM person_media;
    DELETE FROM media_asset;
    DELETE FROM lineage_published_pointer;
    DELETE FROM lineage_succession_snapshot;
    DELETE FROM canonical_relation_snapshot;
    DELETE FROM branch_membership_snapshot;
    DELETE FROM branch_structure_snapshot;
    UPDATE lineage_revision SET based_on_revision_id = NULL;
    DELETE FROM lineage_revision;
    DELETE FROM branch;
    DELETE FROM lineage;
    DELETE FROM audit_log;
    DELETE FROM source_relation_semantic_rule;
    DELETE FROM source_person_link;
    UPDATE source_relation_claim SET supersedes_claim_id = NULL;
    UPDATE source_fact_claim SET supersedes_claim_id = NULL;
    UPDATE source_person_record SET supersedes_record_id = NULL;
    UPDATE genealogy_edition SET supersedes_edition_id = NULL;
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
  if [[ ${test_status:-0} -eq 0 ]]; then rm -f "$log_file"; else echo "Worker log retained: $log_file" >&2; fi
}
test_status=0
trap 'test_status=$?; shutdown' EXIT

npx wrangler d1 migrations apply DB --local --persist-to "$state_dir" >/dev/null
clean_test_rows
npx wrangler dev --local --port "$port" --persist-to "$state_dir" \
  --var AUTH_RATE_LIMIT_SECRET:local-integration-rate-limit-secret \
  --var BOOTSTRAP_SECRET:local-integration-bootstrap-secret \
  --var R2_S3_ACCOUNT_ID:0123456789abcdef0123456789abcdef \
  --var R2_S3_BUCKET:cloud-genealogy-local \
  --var R2_S3_ACCESS_KEY_ID:local-integration-access-key \
  --var R2_S3_SECRET_ACCESS_KEY:local-integration-secret-key >"$log_file" 2>&1 &
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
import { execFileSync } from "node:child_process";

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

const reviewerRegistration = await request("/api/auth/register", {
  method: "POST",
  body: { username: "local.reviewer", password, genealogyName: "本地复核管理员" },
});
expectStatus(reviewerRegistration, 201);

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

const mediaUploadAvailability = await request("/api/admin/media-assets/upload-availability", { cookie: adminCookie });
expectStatus(mediaUploadAvailability, 200);
assert.equal(mediaUploadAvailability.body.available, true);

const mediaIntent = await request("/api/admin/media-assets/upload-intents", {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { sha256: "a".repeat(64), byteSize: 128, mimeType: "image/jpeg", originalFilename: "本地媒体.jpg", visibility: "MEMBER" },
});
expectStatus(mediaIntent, 201);
assert.match(mediaIntent.body.mediaAsset.objectKey, /^media\/[0-9a-f-]{36}$/);
assert.match(mediaIntent.body.upload.url, /^https:\/\/cloud-genealogy-local\.0123456789abcdef0123456789abcdef\.r2\.cloudflarestorage\.com\/media\//);
assert.equal(mediaIntent.body.upload.requiredHeaders["content-type"], "image/jpeg");
assert.ok(mediaIntent.body.upload.requiredHeaders["x-amz-checksum-sha256"]);
const missingMediaCompletion = await request(`/api/admin/media-assets/${mediaIntent.body.mediaAsset.id}/complete`, { method: "POST", cookie: adminCookie, csrf: adminCsrf });
expectStatus(missingMediaCompletion, 409);
assert.equal(missingMediaCompletion.body.code, "media_upload_verification_failed");
expectStatus(await request(`/api/media-assets/${mediaIntent.body.mediaAsset.id}`, { cookie: adminCookie }), 404);
execFileSync("npx", ["wrangler", "r2", "object", "put", "cloud-genealogy-local/media/local-read-fixture", "--local", "--persist-to", ".wrangler/local-auth-integration", "--content-type", "image/jpeg", "--pipe"], { input: "local media fixture", stdio: "pipe" });
const localMediaAssetId = "99999999-9999-4999-8999-999999999999";
execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--persist-to", ".wrangler/local-auth-integration", "--command", `INSERT INTO media_asset (id, object_key, sha256, byte_size, mime_type, original_filename, visibility, state, created_by_account_id, created_at, upload_expires_at, finalized_at) SELECT '${localMediaAssetId}', 'media/local-read-fixture', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 19, 'image/jpeg', 'local.jpg', 'MEMBER', 'active', id, '2026-10-25T00:00:00.000Z', '2026-10-25T00:05:00.000Z', '2026-10-25T00:00:00.000Z' FROM account WHERE username = 'local.admin';`], { stdio: "pipe" });
expectStatus(await request(`/api/media-assets/${localMediaAssetId}`), 401);
const privateMediaRead = await fetch(`${baseUrl}/api/media-assets/${localMediaAssetId}`, { headers: { cookie: adminCookie } });
assert.equal(privateMediaRead.status, 200);
assert.equal(privateMediaRead.headers.get("content-type"), "image/jpeg");
assert.equal(await privateMediaRead.text(), "local media fixture");

const pending = await request("/api/admin/accounts/pending", { cookie: adminCookie });
expectStatus(pending, 200);
const member = pending.body.accounts.find((account) => account.username === "local.member");
assert.ok(member, "待审核账号必须可由管理员读取");
const reviewer = pending.body.accounts.find((account) => account.username === "local.reviewer");
assert.ok(reviewer, "复核管理员账号必须可由管理员读取");

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
const activeMediaAssets = await request("/api/admin/media-assets", { cookie: adminCookie });
expectStatus(activeMediaAssets, 200);
assert.equal(activeMediaAssets.body.mediaAssets.some((asset) => asset.id === localMediaAssetId && asset.active_link_count === 0), true);
const protectedMediaPerson = await request("/api/admin/persons", {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { displayName: "本地私密媒体人物", visibility: "ADMIN" },
});
expectStatus(protectedMediaPerson, 201);
const personMediaLink = await request(`/api/admin/persons/${protectedMediaPerson.body.person.id}/media`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { mediaAssetId: localMediaAssetId, role: "portrait", caption: "本地权限夹具" },
});
expectStatus(personMediaLink, 201);
const linkedPersonMedia = await request(`/api/admin/persons/${protectedMediaPerson.body.person.id}/media`, { cookie: adminCookie });
expectStatus(linkedPersonMedia, 200);
assert.equal(linkedPersonMedia.body.personMedia.length, 1);
const personMediaId = linkedPersonMedia.body.personMedia[0].id;
const reorderedPersonMedia = await request(`/api/admin/person-media/${personMediaId}/order`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf, body: { displayOrder: 7 },
});
expectStatus(reorderedPersonMedia, 200);
const linksAfterReorder = await request(`/api/admin/persons/${protectedMediaPerson.body.person.id}/media`, { cookie: adminCookie });
expectStatus(linksAfterReorder, 200);
assert.equal(linksAfterReorder.body.personMedia[0].display_order, 7);
const duplicatePersonMediaLink = await request(`/api/admin/persons/${protectedMediaPerson.body.person.id}/media`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { mediaAssetId: localMediaAssetId, role: "portrait" },
});
expectStatus(duplicatePersonMediaLink, 409);
assert.equal(duplicatePersonMediaLink.body.code, "person_media_already_linked");
const linkedMediaAssets = await request("/api/admin/media-assets", { cookie: adminCookie });
expectStatus(linkedMediaAssets, 200);
assert.equal(linkedMediaAssets.body.mediaAssets.find((asset) => asset.id === localMediaAssetId).active_link_count, 1);
const personName = await request(`/api/admin/persons/${personResult.body.person.id}/names`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { nameText: "本地人物谱名", nameKind: "genealogy", isPrimary: true, visibility: "MEMBER" },
});
expectStatus(personName, 201);
const personFact = await request(`/api/admin/persons/${personResult.body.person.id}/facts`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { factKind: "birth", dateText: "1901", datePrecision: "year", placeName: "本地测试村", placeKind: "village", visibility: "MEMBER" },
});
expectStatus(personFact, 201);
assert.ok(personFact.body.personFact.placeId);
const aliasName = await request(`/api/admin/persons/${personResult.body.person.id}/names`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { nameText: "本地人物别名", nameKind: "alias", visibility: "MEMBER" },
});
expectStatus(aliasName, 201);
const personDetail = await request(`/api/admin/persons/${personResult.body.person.id}`, { cookie: adminCookie });
expectStatus(personDetail, 200);
assert.equal(personDetail.body.names.length, 2);
assert.equal(personDetail.body.facts.length, 1);
expectStatus(await request(`/api/admin/person-names/${aliasName.body.personName.id}/retire`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
}), 200);
expectStatus(await request(`/api/admin/person-facts/${personFact.body.personFact.id}/retire`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
}), 200);
const retiredDetail = await request(`/api/admin/persons/${personResult.body.person.id}`, { cookie: adminCookie });
expectStatus(retiredDetail, 200);
assert.equal(retiredDetail.body.names.length, 1);
assert.equal(retiredDetail.body.facts.length, 0);
const places = await request("/api/admin/places?query=%E6%9C%AC%E5%9C%B0%E6%B5%8B%E8%AF%95%E6%9D%91", { cookie: adminCookie });
expectStatus(places, 200);
assert.equal(places.body.places.length, 1);
expectStatus(await request(`/api/admin/places/${personFact.body.personFact.placeId}/retire`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
}), 200);

const secondPerson = await request("/api/admin/persons", {
  method: "POST",
  cookie: adminCookie,
  csrf: adminCsrf,
  body: { displayName: "本地承谱父", visibility: "MEMBER" },
});
expectStatus(secondPerson, 201);
const successorParent = await request("/api/admin/persons", {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { displayName: "本地嗣父", visibility: "MEMBER" },
});
expectStatus(successorParent, 201);
const spouse = await request("/api/admin/persons", {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { displayName: "本地配偶", visibility: "MEMBER" },
});
expectStatus(spouse, 201);

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
const relatedSourceRecord = await request(`/api/admin/genealogy-editions/${edition.body.edition.id}/source-person-records`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { sourceKey: "卷一-002", nameText: "本地承谱父", rawText: "本地测试父辈原文记载" },
});
expectStatus(relatedSourceRecord, 201);
const sourceLink = await request(`/api/admin/source-person-records/${sourceRecord.body.sourcePersonRecord.id}/links`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf, body: { personId: personResult.body.person.id },
});
expectStatus(sourceLink, 201);
assert.equal(sourceLink.body.sourcePersonLink.personId, personResult.body.person.id);
const sourceFactClaim = await request(`/api/admin/genealogy-editions/${edition.body.edition.id}/source-fact-claims`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { subjectRecordId: sourceRecord.body.sourcePersonRecord.id, factKind: "birth", rawText: "生于光绪二十七年" },
});
expectStatus(sourceFactClaim, 201);
const sourceRelationClaim = await request(`/api/admin/genealogy-editions/${edition.body.edition.id}/source-relation-claims`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { subjectRecordId: sourceRecord.body.sourcePersonRecord.id, relatedRecordId: relatedSourceRecord.body.sourcePersonRecord.id, relationKind: "biological_parent", rawText: "父某某" },
});
expectStatus(sourceRelationClaim, 201);
const semanticRule = await request("/api/admin/source-relation-semantics", {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { relationKind: "biological_parent", graphKind: "child_to_parent", parentKind: "biological_parent" },
});
expectStatus(semanticRule, 201);
const semanticRules = await request("/api/admin/source-relation-semantics", { cookie: adminCookie });
expectStatus(semanticRules, 200);
assert.equal(semanticRules.body.rules.some((rule) => rule.id === semanticRule.body.rule.id), true);
const supersedingFactClaim = await request(`/api/admin/genealogy-editions/${edition.body.edition.id}/source-fact-claims`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { subjectRecordId: sourceRecord.body.sourcePersonRecord.id, supersedesClaimId: sourceFactClaim.body.sourceFactClaim.id, factKind: "birth", rawText: "生年待考" },
});
expectStatus(supersedingFactClaim, 201);
const claims = await request(`/api/admin/genealogy-editions/${edition.body.edition.id}/source-claims`, { cookie: adminCookie });
expectStatus(claims, 200);
assert.equal(claims.body.factClaims.length, 2);
const historicalProjection = await request(`/api/admin/genealogy-editions/${edition.body.edition.id}/historical-projection`, { cookie: adminCookie });
expectStatus(historicalProjection, 200);
assert.equal(historicalProjection.body.view, "historical");
assert.equal(historicalProjection.body.relationClaims.length, 1);
assert.deepEqual(historicalProjection.body.projection.parentChildEdges, [{
  claimId: sourceRelationClaim.body.sourceRelationClaim.id,
  parentRecordId: relatedSourceRecord.body.sourcePersonRecord.id,
  childRecordId: sourceRecord.body.sourcePersonRecord.id,
  parentKind: "biological_parent",
  rawText: "父某某",
}]);
assert.equal(historicalProjection.body.projection.nodes.find((node) => node.sourceRecordId === relatedSourceRecord.body.sourcePersonRecord.id).confirmedPersonId, null);
expectStatus(await request(`/api/admin/source-relation-semantics/${semanticRule.body.rule.id}/retire`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
}), 200);
const projectionWithRetiredSemantic = await request(`/api/admin/genealogy-editions/${edition.body.edition.id}/historical-projection`, { cookie: adminCookie });
expectStatus(projectionWithRetiredSemantic, 200);
assert.deepEqual(projectionWithRetiredSemantic.body.projection.annotations, [{
  claimId: sourceRelationClaim.body.sourceRelationClaim.id,
  status: "pending_interpretation",
  relationKind: "biological_parent",
  rawText: "父某某",
}]);
expectStatus(await request(`/api/admin/source-relation-claims/${sourceRelationClaim.body.sourceRelationClaim.id}/retract`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
}), 200);

const lineageCreate = await request("/api/admin/lineages", {
  method: "POST", cookie: adminCookie, csrf: adminCsrf, body: { name: "本地测试世系" },
});
expectStatus(lineageCreate, 201);
const lineageId = lineageCreate.body.lineage.id;
const lineages = await request("/api/admin/lineages", { cookie: adminCookie });
expectStatus(lineages, 200);
assert.equal(lineages.body.lineages.some((lineage) => lineage.id === lineageId && lineage.published_revision_id === null), true);
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
    relations: [
      { subjectPersonId: secondPerson.body.person.id, relatedPersonId: personResult.body.person.id, relationKind: "biological_parent" },
      { subjectPersonId: secondPerson.body.person.id, relatedPersonId: successorParent.body.person.id, relationKind: "successor_parent" },
      { subjectPersonId: secondPerson.body.person.id, relatedPersonId: spouse.body.person.id, relationKind: "spouse" },
    ],
  },
});
expectStatus(validPublish, 201);
const canonicalProjection = await request(`/api/admin/lineages/${lineageId}/projection`, { cookie: adminCookie });
expectStatus(canonicalProjection, 200);
assert.equal(canonicalProjection.body.view, "canonical");
assert.equal(canonicalProjection.body.edges.length, 1);
expectStatus(await request(`/api/admin/source-person-records/${relatedSourceRecord.body.sourcePersonRecord.id}/links`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf, body: { personId: secondPerson.body.person.id },
}), 201);
expectStatus(await request("/api/admin/source-relation-semantics", {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { relationKind: "biological_parent", graphKind: "child_to_parent", parentKind: "biological_parent" },
}), 201);
const comparisonClaim = await request(`/api/admin/genealogy-editions/${edition.body.edition.id}/source-relation-claims`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { subjectRecordId: sourceRecord.body.sourcePersonRecord.id, relatedRecordId: relatedSourceRecord.body.sourcePersonRecord.id, relationKind: "biological_parent", rawText: "父某某（比较）" },
});
expectStatus(comparisonClaim, 201);
const historicalComparison = await request(`/api/admin/lineages/${lineageId}/historical-comparison?editionId=${edition.body.edition.id}`, { cookie: adminCookie });
expectStatus(historicalComparison, 200);
assert.deepEqual(historicalComparison.body.comparison.canonicalEdges.map((edge) => edge.status), ["canonical_only"]);
assert.deepEqual(historicalComparison.body.comparison.historicalEdges.map((edge) => edge.status), ["historical_only"]);

// Seed this fixture through the isolated local D1 only.  Using a separate
// edition keeps the 100-node/200-claim boundary assertions deterministic and
// avoids turning this regression test into hundreds of HTTP setup requests.
const boundedEdition = await request(`/api/admin/genealogies/${genealogy.body.genealogy.id}/editions`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf, body: { title: "历史读取边界测试", editionLabel: "local-bounds" },
});
expectStatus(boundedEdition, 201);
const boundedEditionId = boundedEdition.body.edition.id;
const boundedRecords = Array.from({ length: 101 }, (_, index) => {
  const suffix = String(index).padStart(3, "0");
  return `INSERT INTO source_person_record (id, edition_id, source_key, name_text, raw_text, created_at) VALUES ('local-bound-node-${suffix}', '${boundedEditionId}', 'bound-${suffix}', '边界人物 ${suffix}', 'local bound fixture', '2000-01-01T00:00:00.000Z');`;
});
const boundedClaims = Array.from({ length: 201 }, (_, index) => {
  const suffix = String(index).padStart(3, "0");
  return `INSERT INTO source_relation_claim (id, edition_id, subject_record_id, related_record_id, relation_kind, raw_text, created_at) VALUES ('local-bound-claim-${suffix}', '${boundedEditionId}', 'local-bound-node-000', 'local-bound-node-001', 'biological_parent', 'local bound claim ${suffix}', '2021-01-01T00:00:00.000Z');`;
});
const rootedFixture = [
  "INSERT INTO source_person_record (id, edition_id, source_key, name_text, raw_text, created_at) VALUES ('local-root-a', '" + boundedEditionId + "', 'root-a', '根 A', 'local root fixture', '2022-01-01T00:00:00.000Z');",
  "INSERT INTO source_person_record (id, edition_id, source_key, name_text, raw_text, created_at) VALUES ('local-root-b', '" + boundedEditionId + "', 'root-b', '根 B', 'local root fixture', '2022-01-01T00:00:01.000Z');",
  "INSERT INTO source_person_record (id, edition_id, source_key, name_text, raw_text, created_at) VALUES ('local-root-c', '" + boundedEditionId + "', 'root-c', '根 C', 'local root fixture', '2022-01-01T00:00:02.000Z');",
  "INSERT INTO source_relation_claim (id, edition_id, subject_record_id, related_record_id, relation_kind, raw_text, created_at) VALUES ('local-root-claim-ab', '" + boundedEditionId + "', 'local-root-a', 'local-root-b', 'biological_parent', 'A 之父为 B', '2022-01-01T00:00:00.000Z');",
  "INSERT INTO source_relation_claim (id, edition_id, subject_record_id, related_record_id, relation_kind, raw_text, created_at) VALUES ('local-root-claim-bc', '" + boundedEditionId + "', 'local-root-b', 'local-root-c', 'biological_parent', 'B 之父为 C', '2022-01-01T00:00:01.000Z');",
];
execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--persist-to", ".wrangler/local-auth-integration", "--command", [...boundedRecords, ...boundedClaims, ...rootedFixture].join("\n")], { stdio: "pipe" });

const boundedHistoricalProjection = await request(`/api/admin/genealogy-editions/${boundedEditionId}/historical-projection`, { cookie: adminCookie });
expectStatus(boundedHistoricalProjection, 200);
assert.equal(boundedHistoricalProjection.body.truncated, true);
assert.equal(boundedHistoricalProjection.body.projection.nodes.length, 100);
assert.equal(boundedHistoricalProjection.body.relationClaims.length, 200);
const boundedNodeIds = new Set(boundedHistoricalProjection.body.projection.nodes.map((node) => node.sourceRecordId));
assert.equal(boundedHistoricalProjection.body.relationClaims.every((claim) => boundedNodeIds.has(claim.subject_record_id) && (claim.related_record_id === null || boundedNodeIds.has(claim.related_record_id))), true);
assert.equal(boundedNodeIds.has("local-bound-node-100"), false);

const rootedHistoricalProjection = await request(`/api/admin/genealogy-editions/${boundedEditionId}/historical-projection?rootRecordId=local-root-a`, { cookie: adminCookie });
expectStatus(rootedHistoricalProjection, 200);
assert.equal(rootedHistoricalProjection.body.rootRecordId, "local-root-a");
assert.equal(rootedHistoricalProjection.body.truncated, false);
assert.deepEqual(new Set(rootedHistoricalProjection.body.projection.nodes.map((node) => node.sourceRecordId)), new Set(["local-root-a", "local-root-b", "local-root-c"]));
assert.equal(rootedHistoricalProjection.body.relationClaims.every((claim) => ["local-root-a", "local-root-b", "local-root-c"].includes(claim.subject_record_id) && (claim.related_record_id === null || ["local-root-a", "local-root-b", "local-root-c"].includes(claim.related_record_id))), true);
const hangingChart = await request(`/api/admin/lineages/${lineageId}/hanging-chart?rootPersonId=${personResult.body.person.id}`, { cookie: adminCookie });
expectStatus(hangingChart, 200);
assert.equal(hangingChart.body.view, "canonical");
assert.equal(hangingChart.body.revisionId, validPublish.body.revisionId);
assert.deepEqual(hangingChart.body.projection.nodes.map((node) => node.personId), [personResult.body.person.id, secondPerson.body.person.id]);
assert.equal(hangingChart.body.layout.connectors.length, 1);
const kinship = await request(`/api/admin/lineages/${lineageId}/kinship?personId=${secondPerson.body.person.id}`, { cookie: adminCookie });
expectStatus(kinship, 200);
assert.equal(kinship.body.view, "kinship");
assert.equal(kinship.body.radius, 1);
assert.equal(kinship.body.truncated, false);
assert.deepEqual(kinship.body.relations, [
  { subjectPersonId: secondPerson.body.person.id, relatedPersonId: personResult.body.person.id, relationKind: "biological_parent" },
  { subjectPersonId: secondPerson.body.person.id, relatedPersonId: successorParent.body.person.id, relationKind: "successor_parent" },
  { subjectPersonId: secondPerson.body.person.id, relatedPersonId: spouse.body.person.id, relationKind: "spouse" },
]);
const expandedKinship = await request(`/api/admin/lineages/${lineageId}/kinship?personId=${secondPerson.body.person.id}&radius=2`, { cookie: adminCookie });
expectStatus(expandedKinship, 200);
assert.equal(expandedKinship.body.radius, 2);
assert.equal(expandedKinship.body.nodes.find((node) => node.id === secondPerson.body.person.id)?.distance, 0);
const invalidRadius = await request(`/api/admin/lineages/${lineageId}/kinship?personId=${secondPerson.body.person.id}&radius=3`, { cookie: adminCookie });
expectStatus(invalidRadius, 400);
assert.equal(invalidRadius.body.code, "validation_failed");
const reversedParentProposal = await request(`/api/admin/lineages/${lineageId}/change-requests`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { reason: "反向父母关系必须在预览中报错", items: [{ operation: "relation_add", subjectPersonId: personResult.body.person.id, relatedPersonId: secondPerson.body.person.id, relationKind: "biological_parent" }] },
});
expectStatus(reversedParentProposal, 201);
const reversedParentPreview = await request(`/api/admin/change-requests/${reversedParentProposal.body.changeRequest.id}/preview`, { cookie: adminCookie });
expectStatus(reversedParentPreview, 200);
assert.equal(reversedParentPreview.body.preview.valid, false);
assert.equal(reversedParentPreview.body.preview.issues.some((issue) => issue.code === "canonical_parent_direction_conflicts_succession"), true);
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
const kinshipAfterRollback = await request(`/api/admin/lineages/${lineageId}/kinship?personId=${secondPerson.body.person.id}`, { cookie: adminCookie });
expectStatus(kinshipAfterRollback, 200);
assert.deepEqual(kinshipAfterRollback.body.relations, kinship.body.relations);
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
const adoptiveParent = await request("/api/admin/persons", {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { displayName: "本地养父", visibility: "MEMBER" },
});
expectStatus(adoptiveParent, 201);
const reviewerPerson = await request("/api/admin/persons", {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { displayName: "本地复核管理员人物", visibility: "MEMBER" },
});
expectStatus(reviewerPerson, 201);
expectStatus(await request(`/api/admin/accounts/${reviewer.id}/approve`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { personId: reviewerPerson.body.person.id, role: "admin", version: reviewer.version },
}), 200);
const reviewerLogin = await request("/api/auth/login", {
  method: "POST",
  body: { username: "local.reviewer", password },
});
expectStatus(reviewerLogin, 200);
const reviewerCookie = sessionCookie(reviewerLogin);
const reviewerCsrf = reviewerLogin.body.csrfToken;
const reviewerAssignment = await request(`/api/admin/lineages/${lineageId}/reviewer-assignments`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: {
    reviewerAccountId: reviewer.id,
    validFrom: "2026-10-01T00:00:00.000Z",
    validUntil: "2026-12-29T00:00:00.000Z",
    reason: "本地审核人指派验证",
  },
});
expectStatus(reviewerAssignment, 201);
const reviewerCandidates = await request("/api/admin/accounts/reviewers", { cookie: adminCookie });
expectStatus(reviewerCandidates, 200);
assert.equal(reviewerCandidates.body.accounts.some((candidate) => candidate.id === reviewer.id), true);
const reviewerAssignments = await request(`/api/admin/lineages/${lineageId}/reviewer-assignments`, { cookie: adminCookie });
expectStatus(reviewerAssignments, 200);
assert.equal(reviewerAssignments.body.assignments.some((assignment) => assignment.id === reviewerAssignment.body.assignment.id), true);
const unknownPersonProposal = await request(`/api/admin/lineages/${lineageId}/change-requests`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { reason: "未知人物必须明确拒绝", items: [{ operation: "succession_add", subjectPersonId: personResult.body.person.id, relatedPersonId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }] },
});
expectStatus(unknownPersonProposal, 404);
assert.equal(unknownPersonProposal.body.code, "change_person_not_found");
const duplicateProposal = await request(`/api/admin/lineages/${lineageId}/change-requests`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: {
    reason: "重复条目必须在写入前拒绝",
    items: [
      { operation: "relation_add", subjectPersonId: secondPerson.body.person.id, relatedPersonId: adoptiveParent.body.person.id, relationKind: "adoptive_parent" },
      { operation: "relation_add", subjectPersonId: secondPerson.body.person.id, relatedPersonId: adoptiveParent.body.person.id, relationKind: "adoptive_parent" },
    ],
  },
});
expectStatus(duplicateProposal, 400);
assert.equal(duplicateProposal.body.code, "validation_failed");
const changeRequest = await request(`/api/admin/lineages/${lineageId}/change-requests`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: {
    reason: "补充已核验的养父关系",
    items: [{ operation: "relation_add", subjectPersonId: secondPerson.body.person.id, relatedPersonId: adoptiveParent.body.person.id, relationKind: "adoptive_parent" }],
  },
});
expectStatus(changeRequest, 201);
const changeRequestQueue = await request(`/api/admin/change-requests?lineageId=${lineageId}`, { cookie: adminCookie });
expectStatus(changeRequestQueue, 200);
assert.equal(changeRequestQueue.body.changeRequests.some((item) => item.id === changeRequest.body.changeRequest.id && item.state === "draft"), true);
const changePreview = await request(`/api/admin/change-requests/${changeRequest.body.changeRequest.id}/preview`, { cookie: adminCookie });
expectStatus(changePreview, 200);
assert.equal(changePreview.body.preview.valid, true);
assert.equal(changePreview.body.preview.relations.length, 4);
expectStatus(await request(`/api/admin/change-requests/${changeRequest.body.changeRequest.id}/submit`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf, body: { version: 1 },
}), 200);
const selfApproval = await request(`/api/admin/change-requests/${changeRequest.body.changeRequest.id}/approve`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf, body: { version: 2 },
});
expectStatus(selfApproval, 403);
assert.equal(selfApproval.body.code, "self_review_forbidden");
const changeApproval = await request(`/api/admin/change-requests/${changeRequest.body.changeRequest.id}/approve`, {
  method: "POST", cookie: reviewerCookie, csrf: reviewerCsrf, body: { version: 2 },
});
expectStatus(changeApproval, 200);
const changePublish = await request(`/api/admin/change-requests/${changeRequest.body.changeRequest.id}/publish`, {
  method: "POST", cookie: reviewerCookie, csrf: reviewerCsrf,
  body: { version: changeApproval.body.version, revisionId: "66666666-6666-4666-8666-666666666666" },
});
expectStatus(changePublish, 201);
const kinshipAfterChangeRequest = await request(`/api/admin/lineages/${lineageId}/kinship?personId=${secondPerson.body.person.id}`, { cookie: adminCookie });
expectStatus(kinshipAfterChangeRequest, 200);
assert.equal(kinshipAfterChangeRequest.body.relations.some((relation) => relation.relatedPersonId === adoptiveParent.body.person.id && relation.relationKind === "adoptive_parent"), true);
const discardedChangeRequest = await request(`/api/admin/lineages/${lineageId}/change-requests`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { reason: "创建者放弃的草稿必须保留审计", items: [{ operation: "relation_remove", subjectPersonId: secondPerson.body.person.id, relatedPersonId: adoptiveParent.body.person.id, relationKind: "adoptive_parent" }] },
});
expectStatus(discardedChangeRequest, 201);
const discardedByReviewer = await request(`/api/admin/change-requests/${discardedChangeRequest.body.changeRequest.id}/discard`, {
  method: "POST", cookie: reviewerCookie, csrf: reviewerCsrf, body: { version: 1 },
});
expectStatus(discardedByReviewer, 403);
const discarded = await request(`/api/admin/change-requests/${discardedChangeRequest.body.changeRequest.id}/discard`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf, body: { version: 1 },
});
expectStatus(discarded, 200);
assert.equal(discarded.body.state, "discarded");
const discardedPreview = await request(`/api/admin/change-requests/${discardedChangeRequest.body.changeRequest.id}/preview`, { cookie: adminCookie });
expectStatus(discardedPreview, 200);
expectStatus(await request(`/api/admin/change-requests/${discardedChangeRequest.body.changeRequest.id}/submit`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf, body: { version: discarded.body.version },
}), 409);
const discardedQueue = await request(`/api/admin/change-requests?lineageId=${lineageId}`, { cookie: adminCookie });
expectStatus(discardedQueue, 200);
assert.equal(discardedQueue.body.changeRequests.some((item) => item.id === discardedChangeRequest.body.changeRequest.id && item.state === "draft" && item.discarded_at && item.discarded_by_account_id), true);
const invalidChangeRequest = await request(`/api/admin/lineages/${lineageId}/change-requests`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { reason: "成环候选不得通过审核", items: [{ operation: "succession_add", subjectPersonId: secondPerson.body.person.id, relatedPersonId: personResult.body.person.id }] },
});
expectStatus(invalidChangeRequest, 201);
expectStatus(await request(`/api/admin/change-requests/${invalidChangeRequest.body.changeRequest.id}/submit`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf, body: { version: 1 },
}), 200);
const invalidApproval = await request(`/api/admin/change-requests/${invalidChangeRequest.body.changeRequest.id}/approve`, {
  method: "POST", cookie: reviewerCookie, csrf: reviewerCsrf, body: { version: 2 },
});
expectStatus(invalidApproval, 400);
assert.equal(invalidApproval.body.code, "revision_invalid");
const invalidRejection = await request(`/api/admin/change-requests/${invalidChangeRequest.body.changeRequest.id}/reject`, {
  method: "POST", cookie: reviewerCookie, csrf: reviewerCsrf, body: { version: 2, reviewNote: "候选关系形成承谱环。" },
});
expectStatus(invalidRejection, 200);
const staleChangeRequest = await request(`/api/admin/lineages/${lineageId}/change-requests`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { reason: "用于验证陈旧基准冲突", items: [{ operation: "relation_remove", subjectPersonId: secondPerson.body.person.id, relatedPersonId: adoptiveParent.body.person.id, relationKind: "adoptive_parent" }] },
});
expectStatus(staleChangeRequest, 201);
expectStatus(await request(`/api/admin/change-requests/${staleChangeRequest.body.changeRequest.id}/submit`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf, body: { version: 1 },
}), 200);
const localOnlyPublish = await request(`/api/admin/lineages/${lineageId}/revisions/publish`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { revisionId: "77777777-7777-4777-8777-777777777777", expectedPointerVersion: 3, edges: [{ parentPersonId: personResult.body.person.id, childPersonId: secondPerson.body.person.id }] },
});
expectStatus(localOnlyPublish, 201);
const staleApproval = await request(`/api/admin/change-requests/${staleChangeRequest.body.changeRequest.id}/approve`, {
  method: "POST", cookie: reviewerCookie, csrf: reviewerCsrf, body: { version: 2 },
});
expectStatus(staleApproval, 409);
assert.equal(staleApproval.body.code, "change_request_conflicted");
const conflictedPreview = await request(`/api/admin/change-requests/${staleChangeRequest.body.changeRequest.id}/preview`, { cookie: adminCookie });
expectStatus(conflictedPreview, 200);
assert.equal(conflictedPreview.body.changeRequest.state, "conflicted");
const rejectedChangeRequest = await request(`/api/admin/lineages/${lineageId}/change-requests`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { reason: "用于验证驳回", items: [{ operation: "relation_add", subjectPersonId: secondPerson.body.person.id, relatedPersonId: adoptiveParent.body.person.id, relationKind: "adoptive_parent" }] },
});
expectStatus(rejectedChangeRequest, 201);
expectStatus(await request(`/api/admin/change-requests/${rejectedChangeRequest.body.changeRequest.id}/submit`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf, body: { version: 1 },
}), 200);
const rejection = await request(`/api/admin/change-requests/${rejectedChangeRequest.body.changeRequest.id}/reject`, {
  method: "POST", cookie: reviewerCookie, csrf: reviewerCsrf, body: { version: 2, reviewNote: "证据不足，暂不发布。" },
});
expectStatus(rejection, 200);
assert.equal(rejection.body.state, "rejected");
const rollbackChangeRequest = await request(`/api/admin/lineages/${lineageId}/revisions/44444444-4444-4444-8444-444444444444/rollback-change-request`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { reason: "恢复已审核的亲属关系快照" },
});
expectStatus(rollbackChangeRequest, 201);
assert.equal(rollbackChangeRequest.body.changeRequest.itemCount, 3);
expectStatus(await request(`/api/admin/change-requests/${rollbackChangeRequest.body.changeRequest.id}/submit`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf, body: { version: 1 },
}), 200);
const rollbackChangeApproval = await request(`/api/admin/change-requests/${rollbackChangeRequest.body.changeRequest.id}/approve`, {
  method: "POST", cookie: reviewerCookie, csrf: reviewerCsrf, body: { version: 2 },
});
expectStatus(rollbackChangeApproval, 200);
const rollbackChangePublish = await request(`/api/admin/change-requests/${rollbackChangeRequest.body.changeRequest.id}/publish`, {
  method: "POST", cookie: reviewerCookie, csrf: reviewerCsrf,
  body: { version: rollbackChangeApproval.body.version, revisionId: "88888888-8888-4888-8888-888888888888" },
});
expectStatus(rollbackChangePublish, 201);
const kinshipAfterRollbackChangeRequest = await request(`/api/admin/lineages/${lineageId}/kinship?personId=${secondPerson.body.person.id}`, { cookie: adminCookie });
expectStatus(kinshipAfterRollbackChangeRequest, 200);
const relationKey = (relation) => `${relation.subjectPersonId}\u0000${relation.relatedPersonId}\u0000${relation.relationKind}`;
assert.deepEqual(kinshipAfterRollbackChangeRequest.body.relations.toSorted((left, right) => relationKey(left).localeCompare(relationKey(right))), kinship.body.relations.toSorted((left, right) => relationKey(left).localeCompare(relationKey(right))));

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

expectStatus(await request(`/api/media-assets/${localMediaAssetId}`, { cookie: memberCookie }), 403);
const retiredPersonMedia = await request(`/api/admin/person-media/${personMediaId}/retire`, { method: "POST", cookie: adminCookie, csrf: adminCsrf });
expectStatus(retiredPersonMedia, 200);
assert.equal(retiredPersonMedia.body.mediaAssetState, "retired");
assert.ok(retiredPersonMedia.body.cleanupAfter);
const linksAfterRetirement = await request(`/api/admin/persons/${protectedMediaPerson.body.person.id}/media`, { cookie: adminCookie });
expectStatus(linksAfterRetirement, 200);
assert.equal(linksAfterRetirement.body.personMedia.length, 0);
expectStatus(await request(`/api/media-assets/${localMediaAssetId}`, { cookie: adminCookie }), 404);

const expiredCleanupAssetId = "abababab-abab-4bab-8bab-abababababab";
const cleanupAuditCountBefore = JSON.parse(execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--persist-to", ".wrangler/local-auth-integration", "--command", "SELECT COUNT(*) AS count FROM audit_log;", "--json"], { encoding: "utf8" }))[0].results[0].count;
execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--persist-to", ".wrangler/local-auth-integration", "--command", `
  INSERT INTO media_asset (id, object_key, sha256, byte_size, mime_type, original_filename, visibility, state, created_by_account_id, created_at, upload_expires_at, finalized_at, retired_at, cleanup_after)
  SELECT '${expiredCleanupAssetId}', 'media/expired-cleanup-preview-fixture', '${"b".repeat(64)}', 128, 'image/jpeg', 'expired-preview.jpg', 'MEMBER', 'retired', id, '2026-01-01T00:00:00.000Z', '2026-01-01T00:05:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2000-01-01T00:00:00.000Z' FROM account WHERE username = 'local.admin';
  INSERT INTO person_media (id, person_id, media_asset_id, role, display_order, created_by_account_id, created_at, retired_at)
  SELECT 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd', '${protectedMediaPerson.body.person.id}', '${expiredCleanupAssetId}', 'document', 0, id, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z' FROM account WHERE username = 'local.admin';
`], { stdio: "pipe" });
const cleanupPreview = await request("/api/admin/media-assets/cleanup-preview", { cookie: adminCookie });
expectStatus(cleanupPreview, 200);
assert.equal(cleanupPreview.body.candidates.some((asset) => asset.id === expiredCleanupAssetId && asset.retired_link_count === 1), true);
assert.equal(cleanupPreview.body.candidates.some((asset) => asset.id === localMediaAssetId), false);
const cleanupAuditCountAfter = JSON.parse(execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--persist-to", ".wrangler/local-auth-integration", "--command", "SELECT COUNT(*) AS count FROM audit_log;", "--json"], { encoding: "utf8" }))[0].results[0].count;
assert.equal(cleanupAuditCountAfter, cleanupAuditCountBefore);
const cleanupRun = await request("/api/admin/media-cleanup-runs", {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { backupRecoveryPoint: "local-recovery-drill-2026-10-25", backupPackageSha256: "c".repeat(64) },
});
expectStatus(cleanupRun, 201);
assert.equal(cleanupRun.body.cleanupRun.state, "pending_confirmation");
assert.equal(cleanupRun.body.cleanupRun.candidateCount, 1);
const frozenCleanupRun = await request(`/api/admin/media-cleanup-runs/${cleanupRun.body.cleanupRun.id}`, { cookie: adminCookie });
expectStatus(frozenCleanupRun, 200);
assert.equal(frozenCleanupRun.body.items.length, 1);
assert.equal(frozenCleanupRun.body.items[0].media_asset_id, expiredCleanupAssetId);
const selfCleanupConfirmation = await request(`/api/admin/media-cleanup-runs/${cleanupRun.body.cleanupRun.id}/confirm`, { method: "POST", cookie: adminCookie, csrf: adminCsrf });
expectStatus(selfCleanupConfirmation, 409);
assert.equal(selfCleanupConfirmation.body.code, "media_cleanup_second_confirmer_invalid");
const confirmedCleanupRun = await request(`/api/admin/media-cleanup-runs/${cleanupRun.body.cleanupRun.id}/confirm`, { method: "POST", cookie: reviewerCookie, csrf: reviewerCsrf });
expectStatus(confirmedCleanupRun, 200);
assert.equal(confirmedCleanupRun.body.cleanupRun.state, "confirmed");
const cleanupAuditActions = JSON.parse(execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--persist-to", ".wrangler/local-auth-integration", "--command", `SELECT COUNT(*) AS count FROM audit_log WHERE object_id = '${cleanupRun.body.cleanupRun.id}' AND action IN ('media.cleanup_run_frozen', 'media.cleanup_run_confirmed');`, "--json"], { encoding: "utf8" }))[0].results[0].count;
assert.equal(cleanupAuditActions, 2);

const identity = await request("/api/me", { cookie: memberCookie });
expectStatus(identity, 200);
assert.deepEqual(identity.body.account.roles.sort(), ["editor", "member"]);

const outOfScopeEditorProposal = await request(`/api/admin/lineages/${lineageId}/change-requests`, {
  method: "POST", cookie: memberCookie, csrf: memberCsrf,
  body: { reason: "范围外提案必须被拒绝", items: [{ operation: "relation_add", subjectPersonId: secondPerson.body.person.id, relatedPersonId: adoptiveParent.body.person.id, relationKind: "adoptive_parent" }] },
});
expectStatus(outOfScopeEditorProposal, 403);
assert.equal(outOfScopeEditorProposal.body.code, "scope_forbidden");

const scopes = await request(`/api/admin/accounts/${member.id}/scopes`, {
  method: "PUT", cookie: adminCookie, csrf: adminCsrf,
  body: {
    version: member.version + 1,
    scopes: [
      { scopeType: "person", scopeId: secondPerson.body.person.id },
      { scopeType: "person", scopeId: adoptiveParent.body.person.id },
    ],
  },
});
expectStatus(scopes, 200);
assert.equal(scopes.body.version, member.version + 2);

const editorChangeRequest = await request(`/api/admin/lineages/${lineageId}/change-requests`, {
  method: "POST", cookie: memberCookie, csrf: memberCsrf,
  body: { reason: "编辑员在获授人物范围内补充养父关系", items: [{ operation: "relation_add", subjectPersonId: secondPerson.body.person.id, relatedPersonId: adoptiveParent.body.person.id, relationKind: "adoptive_parent" }] },
});
expectStatus(editorChangeRequest, 201);
expectStatus(await request(`/api/admin/change-requests/${editorChangeRequest.body.changeRequest.id}/preview`, { cookie: memberCookie }), 200);
expectStatus(await request(`/api/admin/change-requests/${editorChangeRequest.body.changeRequest.id}/submit`, {
  method: "POST", cookie: memberCookie, csrf: memberCsrf, body: { version: 1 },
}), 200);
const editorApproval = await request(`/api/admin/change-requests/${editorChangeRequest.body.changeRequest.id}/approve`, {
  method: "POST", cookie: reviewerCookie, csrf: reviewerCsrf, body: { version: 2 },
});
expectStatus(editorApproval, 200);
expectStatus(await request(`/api/admin/change-requests/${editorChangeRequest.body.changeRequest.id}/publish`, {
  method: "POST", cookie: reviewerCookie, csrf: reviewerCsrf,
  body: { version: editorApproval.body.version, revisionId: "99999999-9999-4999-8999-999999999999" },
}), 201);
const duplicateRevisionRequest = await request(`/api/admin/lineages/${lineageId}/change-requests`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { reason: "重复 revision ID 的批次必须完整回滚", items: [{ operation: "relation_remove", subjectPersonId: secondPerson.body.person.id, relatedPersonId: adoptiveParent.body.person.id, relationKind: "adoptive_parent" }] },
});
expectStatus(duplicateRevisionRequest, 201);
expectStatus(await request(`/api/admin/change-requests/${duplicateRevisionRequest.body.changeRequest.id}/submit`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf, body: { version: 1 },
}), 200);
const duplicateRevisionApproval = await request(`/api/admin/change-requests/${duplicateRevisionRequest.body.changeRequest.id}/approve`, {
  method: "POST", cookie: reviewerCookie, csrf: reviewerCsrf, body: { version: 2 },
});
expectStatus(duplicateRevisionApproval, 200);
const duplicateRevisionPublish = await request(`/api/admin/change-requests/${duplicateRevisionRequest.body.changeRequest.id}/publish`, {
  method: "POST", cookie: reviewerCookie, csrf: reviewerCsrf,
  body: { version: duplicateRevisionApproval.body.version, revisionId: "99999999-9999-4999-8999-999999999999" },
});
expectStatus(duplicateRevisionPublish, 409);
assert.equal(duplicateRevisionPublish.body.code, "change_request_conflicted");

const membershipBranchId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const membershipChangeRequest = await request(`/api/admin/lineages/${lineageId}/change-requests`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: {
    reason: "创建房支并补充已审核成员",
    structureItems: [{ operation: "create", branchId: membershipBranchId, parentBranchId: null, name: "本地成员测试房", branchKind: "agnatic" }],
    membershipItems: [{ operation: "add", branchId: membershipBranchId, personId: adoptiveParent.body.person.id, membershipKind: "migration" }],
  },
});
expectStatus(membershipChangeRequest, 201);
const membershipPreview = await request(`/api/admin/change-requests/${membershipChangeRequest.body.changeRequest.id}/preview`, { cookie: adminCookie });
expectStatus(membershipPreview, 200);
assert.equal(membershipPreview.body.preview.memberships.some((membership) => membership.branchId === membershipBranchId && membership.personId === adoptiveParent.body.person.id && membership.membershipKind === "migration"), true);
expectStatus(await request(`/api/admin/change-requests/${membershipChangeRequest.body.changeRequest.id}/submit`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf, body: { version: 1 },
}), 200);
const membershipApproval = await request(`/api/admin/change-requests/${membershipChangeRequest.body.changeRequest.id}/approve`, {
  method: "POST", cookie: reviewerCookie, csrf: reviewerCsrf, body: { version: 2 },
});
expectStatus(membershipApproval, 200);
expectStatus(await request(`/api/admin/change-requests/${membershipChangeRequest.body.changeRequest.id}/publish`, {
  method: "POST", cookie: reviewerCookie, csrf: reviewerCsrf,
  body: { version: membershipApproval.body.version, revisionId: "abababab-abab-4bab-8bab-abababababab" },
}), 201);
const membershipSnapshot = execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--persist-to", ".wrangler/local-auth-integration", "--command",
  `SELECT branch_id, person_id, membership_kind FROM branch_membership_snapshot WHERE revision_id = 'abababab-abab-4bab-8bab-abababababab';`,
], { encoding: "utf8" });
assert.match(membershipSnapshot, new RegExp(membershipBranchId));
assert.match(membershipSnapshot, /migration/);
const structureSnapshot = execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--persist-to", ".wrangler/local-auth-integration", "--command",
  `SELECT branch_id, name, branch_kind FROM branch_structure_snapshot WHERE revision_id = 'abababab-abab-4bab-8bab-abababababab';`,
], { encoding: "utf8" });
assert.match(structureSnapshot, new RegExp(membershipBranchId));
assert.match(structureSnapshot, /本地成员测试房/);
const branchWorkbench = await request(`/api/admin/lineages/${lineageId}/branch-workbench`, { cookie: adminCookie });
expectStatus(branchWorkbench, 200);
assert.equal(branchWorkbench.body.revisionId, "abababab-abab-4bab-8bab-abababababab");
assert.equal(branchWorkbench.body.branches.some((branch) => branch.branchId === membershipBranchId && branch.membershipCount === 1 && branch.accountScopeCount === 0), true);
assert.equal(branchWorkbench.body.memberships.some((membership) => membership.branchId === membershipBranchId && membership.personId === adoptiveParent.body.person.id && membership.personDisplayName === adoptiveParent.body.person.displayName), true);
const structureDraft = await request(`/api/admin/lineages/${lineageId}/change-requests`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { reason: "预览房支改名草稿", structureItems: [{ operation: "rename", branchId: membershipBranchId, name: "本地成员测试房（新名）" }] },
});
expectStatus(structureDraft, 201);
const structureDraftPreview = await request(`/api/admin/change-requests/${structureDraft.body.changeRequest.id}/preview`, { cookie: adminCookie });
expectStatus(structureDraftPreview, 200);
assert.equal(structureDraftPreview.body.preview.branchStructure.branches.some((branch) => branch.branchId === membershipBranchId && branch.name === "本地成员测试房（新名）"), true);
const structureSubmit = await request(`/api/admin/change-requests/${structureDraft.body.changeRequest.id}/submit`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf, body: { version: 1 },
});
expectStatus(structureSubmit, 200);
const structureApproval = await request(`/api/admin/change-requests/${structureDraft.body.changeRequest.id}/approve`, {
  method: "POST", cookie: reviewerCookie, csrf: reviewerCsrf, body: { version: 2 },
});
expectStatus(structureApproval, 200);
expectStatus(await request(`/api/admin/change-requests/${structureDraft.body.changeRequest.id}/publish`, {
  method: "POST", cookie: reviewerCookie, csrf: reviewerCsrf,
  body: { version: structureApproval.body.version, revisionId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd" },
}), 201);
const publishedStructure = execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--persist-to", ".wrangler/local-auth-integration", "--command",
  `SELECT name FROM branch WHERE id = '${membershipBranchId}';`,
], { encoding: "utf8" });
assert.match(publishedStructure, /本地成员测试房（新名）/);

const retirementWithMember = await request(`/api/admin/lineages/${lineageId}/change-requests`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { reason: "有成员的房支不得退休", structureItems: [{ operation: "retire", branchId: membershipBranchId }] },
});
expectStatus(retirementWithMember, 201);
const memberRetirementPreview = await request(`/api/admin/change-requests/${retirementWithMember.body.changeRequest.id}/preview`, { cookie: adminCookie });
expectStatus(memberRetirementPreview, 200);
assert.equal(memberRetirementPreview.body.preview.valid, false);
assert.deepEqual(memberRetirementPreview.body.preview.retirementDependencies, [{ branchId: membershipBranchId, membershipCount: 1, accountScopeCount: 0, blockingCodes: ["branch_membership_in_use"] }]);
expectStatus(await request(`/api/admin/change-requests/${retirementWithMember.body.changeRequest.id}/submit`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf, body: { version: 1 },
}), 200);
const memberRetirementApproval = await request(`/api/admin/change-requests/${retirementWithMember.body.changeRequest.id}/approve`, {
  method: "POST", cookie: reviewerCookie, csrf: reviewerCsrf, body: { version: 2 },
});
expectStatus(memberRetirementApproval, 409);
assert.equal(memberRetirementApproval.body.code, "branch_retirement_in_use");

const branchScope = await request(`/api/admin/accounts/${member.id}/scopes`, {
  method: "PUT", cookie: adminCookie, csrf: adminCsrf,
  body: {
    version: scopes.body.version,
    scopes: [
      { scopeType: "person", scopeId: secondPerson.body.person.id },
      { scopeType: "person", scopeId: adoptiveParent.body.person.id },
      { scopeType: "branch", scopeId: membershipBranchId },
    ],
  },
});
expectStatus(branchScope, 200);
const retirementWithScope = await request(`/api/admin/lineages/${lineageId}/change-requests`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: {
    reason: "有账号范围引用的房支不得退休",
    structureItems: [{ operation: "retire", branchId: membershipBranchId }],
    membershipItems: [{ operation: "remove", branchId: membershipBranchId, personId: adoptiveParent.body.person.id, membershipKind: "migration" }],
  },
});
expectStatus(retirementWithScope, 201);
const scopeRetirementPreview = await request(`/api/admin/change-requests/${retirementWithScope.body.changeRequest.id}/preview`, { cookie: adminCookie });
expectStatus(scopeRetirementPreview, 200);
assert.equal(scopeRetirementPreview.body.preview.valid, false);
assert.deepEqual(scopeRetirementPreview.body.preview.retirementDependencies, [{ branchId: membershipBranchId, membershipCount: 0, accountScopeCount: 1, blockingCodes: ["branch_account_scope_in_use"] }]);
expectStatus(await request(`/api/admin/change-requests/${retirementWithScope.body.changeRequest.id}/submit`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf, body: { version: 1 },
}), 200);
const scopeRetirementApproval = await request(`/api/admin/change-requests/${retirementWithScope.body.changeRequest.id}/approve`, {
  method: "POST", cookie: reviewerCookie, csrf: reviewerCsrf, body: { version: 2 },
});
expectStatus(scopeRetirementApproval, 409);
assert.equal(scopeRetirementApproval.body.code, "branch_retirement_in_use");

const restoredScopes = await request(`/api/admin/accounts/${member.id}/scopes`, {
  method: "PUT", cookie: adminCookie, csrf: adminCsrf,
  body: {
    version: branchScope.body.version,
    scopes: [
      { scopeType: "person", scopeId: secondPerson.body.person.id },
      { scopeType: "person", scopeId: adoptiveParent.body.person.id },
    ],
  },
});
expectStatus(restoredScopes, 200);
const retirement = await request(`/api/admin/lineages/${lineageId}/change-requests`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: {
    reason: "迁出成员并退休房支",
    structureItems: [{ operation: "retire", branchId: membershipBranchId }],
    membershipItems: [{ operation: "remove", branchId: membershipBranchId, personId: adoptiveParent.body.person.id, membershipKind: "migration" }],
  },
});
expectStatus(retirement, 201);
const retirementPreview = await request(`/api/admin/change-requests/${retirement.body.changeRequest.id}/preview`, { cookie: adminCookie });
expectStatus(retirementPreview, 200);
assert.equal(retirementPreview.body.preview.valid, true);
assert.deepEqual(retirementPreview.body.preview.retirementDependencies, [{ branchId: membershipBranchId, membershipCount: 0, accountScopeCount: 0, blockingCodes: [] }]);
expectStatus(await request(`/api/admin/change-requests/${retirement.body.changeRequest.id}/submit`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf, body: { version: 1 },
}), 200);
const retirementApproval = await request(`/api/admin/change-requests/${retirement.body.changeRequest.id}/approve`, {
  method: "POST", cookie: reviewerCookie, csrf: reviewerCsrf, body: { version: 2 },
});
expectStatus(retirementApproval, 200);
expectStatus(await request(`/api/admin/change-requests/${retirement.body.changeRequest.id}/publish`, {
  method: "POST", cookie: reviewerCookie, csrf: reviewerCsrf,
  body: { version: retirementApproval.body.version, revisionId: "dededede-dede-4ede-8ede-dededededede" },
}), 201);
const retiredBranch = execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--persist-to", ".wrangler/local-auth-integration", "--command",
  `SELECT retired_at FROM branch WHERE id = '${membershipBranchId}';`,
], { encoding: "utf8" });
assert.match(retiredBranch, /2026-/);
const retirementSnapshot = execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--persist-to", ".wrangler/local-auth-integration", "--command",
  `SELECT retired_at FROM branch_structure_snapshot WHERE revision_id = 'dededede-dede-4ede-8ede-dededededede' AND branch_id = '${membershipBranchId}';`,
], { encoding: "utf8" });
assert.match(retirementSnapshot, /2026-/);
const retiredMembership = execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--persist-to", ".wrangler/local-auth-integration", "--command",
  `SELECT COUNT(*) AS member_count FROM branch_membership_snapshot WHERE revision_id = 'dededede-dede-4ede-8ede-dededededede' AND branch_id = '${membershipBranchId}';`,
], { encoding: "utf8" });
assert.match(retiredMembership, /"member_count": 0/);

expectStatus(await request(`/api/admin/reviewer-assignments/${reviewerAssignment.body.assignment.id}/revoke`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { version: reviewerAssignment.body.assignment.version, reason: "本地撤销审核人指派验证" },
}), 200);
const noReviewerProposal = await request(`/api/admin/lineages/${lineageId}/change-requests`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf,
  body: { reason: "没有有效审核人时不得提交", items: [{ operation: "relation_remove", subjectPersonId: secondPerson.body.person.id, relatedPersonId: adoptiveParent.body.person.id, relationKind: "adoptive_parent" }] },
});
expectStatus(noReviewerProposal, 201);
const noReviewerSubmit = await request(`/api/admin/change-requests/${noReviewerProposal.body.changeRequest.id}/submit`, {
  method: "POST", cookie: adminCookie, csrf: adminCsrf, body: { version: 1 },
});
expectStatus(noReviewerSubmit, 409);
assert.equal(noReviewerSubmit.body.code, "reviewer_assignment_required");

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

# The failed publish reuses an existing revision ID. D1 batch semantics must
# leave the pointer, approved request, and audit trail unchanged together.
npx wrangler d1 execute DB --local --persist-to "$state_dir" --command "
  SELECT (SELECT revision_id FROM lineage_published_pointer LIMIT 1) AS revision_id,
         (SELECT state FROM change_request WHERE reason = '重复 revision ID 的批次必须完整回滚') AS request_state,
         (SELECT COUNT(*) FROM audit_log WHERE action = 'lineage.change_request_published' AND metadata_json LIKE '%99999999-9999-4999-8999-999999999999%') AS publish_audits;
" > "$state_dir/publish-batch-result.json"
rg -q '"revision_id":\s*"99999999-9999-4999-8999-999999999999"' "$state_dir/publish-batch-result.json"
rg -q '"request_state":\s*"approved"' "$state_dir/publish-batch-result.json"
rg -q '"publish_audits":\s*1' "$state_dir/publish-batch-result.json"
