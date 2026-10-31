/* global Buffer */
// TEST FIXTURE ONLY: no credential store, CLI, approval, cleanup, or remote access.
import { createHash, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";

const protocol = "cloud-genealogy/local-orphan-review-test/v1";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const challengePattern = /^[0-9a-f]{64}$/u;
const hexSignature = /^[0-9a-f]{128}$/u;
const digest = (value) => createHash("sha256").update(value).digest("hex");
function canonical(value, depth = 0) {
  if (depth > 12) throw new Error("fixture_payload_invalid");
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) { if (value.length > 128 || Object.keys(value).length !== value.length) throw new Error("fixture_payload_invalid"); return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`; }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("fixture_payload_invalid");
  const keys = Object.keys(value).sort();
  if (keys.length > 32 || keys.some((key) => key === "__proto__" || key === "constructor" || key === "prototype")) throw new Error("fixture_payload_invalid");
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(",")}}`;
}
function bytes(value) {
  const result = Buffer.from(canonical(value), "utf8");
  if (result.length > 65536) throw new Error("fixture_payload_invalid");
  return result;
}
function exactKeys(value, keys) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(","); }
function scopeValid(scope) { return exactKeys(scope, ["runId", "rootId", "attemptId"]) && Object.values(scope).every((part) => typeof part === "string" && uuid.test(part)); }
function reportValid(report, scope) {
  return exactKeys(report, ["evidence", "sha256"]) && exactKeys(report.evidence, ["version", "fixtureOnly", "attemptId", "recordedState", "windowState", "expectedDirectory", "observedDirectory", "marker", "audit", "outcome", "remoteExecutionAvailable"]) && report.evidence.fixtureOnly === true && report.evidence.version === 1 && report.evidence.attemptId === scope.attemptId && report.evidence.outcome === "review_required" && report.evidence.remoteExecutionAvailable === false && typeof report.sha256 === "string" && report.sha256 === digest(JSON.stringify(report.evidence));
}

// Stateless cryptographic check for test fixtures; it does not consume a challenge.
export function verifyFixtureSignature(publicKey, envelope, expectedScope, expectedChallenge) {
  try {
    if (!publicKey || publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519" || !scopeValid(expectedScope) || typeof expectedChallenge !== "string" || !challengePattern.test(expectedChallenge)) return false;
    if (!exactKeys(envelope, ["payload", "signature"]) || typeof envelope.signature !== "string" || !hexSignature.test(envelope.signature)) return false;
    const p = envelope.payload;
    if (!exactKeys(p, ["protocol", "scope", "challenge", "report"]) || p.protocol !== protocol || !scopeValid(p.scope) || p.challenge !== expectedChallenge || canonical(expectedScope) !== canonical(p.scope) || !reportValid(p.report, p.scope)) return false;
    return verify(null, bytes(p), publicKey, Buffer.from(envelope.signature, "hex"));
  } catch { return false; }
}
export function isFixtureScope(scope) { return scopeValid(scope); }

// New in-memory keypair for each isolated test; private key is never exported.
export function createFixtureSigner() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    publicKey,
    signObservation(scope, challenge, report) {
      if (!scopeValid(scope) || typeof challenge !== "string" || !challengePattern.test(challenge) || !reportValid(report, scope)) throw new Error("fixture_input_invalid");
      const payload = { protocol, scope, challenge, report }; const signature = sign(null, bytes(payload), privateKey).toString("hex");
      return { payload, signature };
    },
  };
}

// Caller supplies the trusted public key. No key from the envelope is trusted.
// The challenge registry is volatile and provides no durable replay protection.
export function createFixtureVerifier(publicKey, { challengeFactory = () => randomBytes(32).toString("hex") } = {}) {
  if (!publicKey || publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") throw new Error("fixture_public_key_invalid");
  const pending = new Map(); const issued = new Set();
  return {
    issue(scope) {
      if (!scopeValid(scope)) throw new Error("fixture_scope_invalid");
      const challenge = challengeFactory();
      if (typeof challenge !== "string" || !challengePattern.test(challenge) || issued.has(challenge) || issued.size >= 1024) throw new Error("fixture_challenge_invalid");
      issued.add(challenge); pending.set(challenge, { ...scope }); return challenge;
    },
    verifyOnce(envelope) {
      try {
        const challenge = envelope?.payload?.challenge; const expected = pending.get(challenge);
        if (!expected || !verifyFixtureSignature(publicKey, envelope, expected, challenge)) return false;
        pending.delete(challenge); return true;
      } catch { return false; }
    },
  };
}
