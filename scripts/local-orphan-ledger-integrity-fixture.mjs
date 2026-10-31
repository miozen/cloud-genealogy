// TEST ONLY: logical consistency checks; not provenance, authorization or rollback protection.
import { createHash } from "node:crypto";
import { fixtureCanonicalBytes, isFixtureScope } from "./local-orphan-signature-fixture.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const hex64 = /^[0-9a-f]{64}$/u;
export function fixtureRequestHash(kind, input) {
  return createHash("sha256").update(fixtureCanonicalBytes({ domain: "cg-local-idempotency-v1", kind, input })).digest("hex");
}
export function validateFixtureLedger(db) {
  try {
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("ledger_integrity_invalid");
    const challenges = db.prepare("SELECT challenge,run_id,root_id,attempt_id,consumed FROM fixture_challenge").all();
    const audit = db.prepare("SELECT challenge,action FROM fixture_challenge_audit").all();
    const requests = db.prepare("SELECT request_id,kind,input_hash,challenge,accepted FROM fixture_challenge_request").all();
    const entries = new Map();
    for (const row of challenges) {
      const scope = { runId: row.run_id, rootId: row.root_id, attemptId: row.attempt_id };
      if (typeof row.challenge !== "string" || !hex64.test(row.challenge) || !isFixtureScope(scope) || ![0, 1].includes(row.consumed) || entries.has(row.challenge)) throw new Error("ledger_integrity_invalid");
      entries.set(row.challenge, { scope, consumed: row.consumed, issued: 0, used: 0, requestKinds: new Set() });
    }
    for (const row of audit) {
      const target = entries.get(row.challenge);
      if (!target || !["issued", "consumed"].includes(row.action)) throw new Error("ledger_integrity_invalid");
      if (row.action === "issued") target.issued += 1; else target.used += 1;
    }
    for (const target of entries.values()) if (target.issued !== 1 || target.used !== target.consumed) throw new Error("ledger_integrity_invalid");
    for (const row of requests) {
      const target = entries.get(row.challenge);
      if (!target || typeof row.request_id !== "string" || !uuid.test(row.request_id) || !["issue", "consume"].includes(row.kind) || typeof row.input_hash !== "string" || !hex64.test(row.input_hash) || row.accepted !== 1 || target.requestKinds.has(row.kind)) throw new Error("ledger_integrity_invalid");
      if (row.kind === "issue" && row.input_hash !== fixtureRequestHash("issue", target.scope)) throw new Error("ledger_integrity_invalid");
      if (row.kind === "consume" && target.consumed !== 1) throw new Error("ledger_integrity_invalid");
      target.requestKinds.add(row.kind);
    }
  } catch (error) {
    if (error?.message === "ledger_integrity_invalid") throw error;
    throw new Error("ledger_integrity_unavailable");
  }
}
