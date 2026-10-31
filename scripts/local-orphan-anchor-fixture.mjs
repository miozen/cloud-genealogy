// TEST ONLY: guarded consumption against an independent process's volatile anchor.
// The original challenge fixture remains independently accessible and unguarded.
import { createHash } from "node:crypto";
import { verifyFixtureSignature } from "./local-orphan-signature-fixture.mjs";

export function challengeLedgerDigest(db) {
  const tables = [
    db.prepare("SELECT id,root_dev,root_ino,capability_hash,key_hash FROM fixture_challenge_meta ORDER BY id").all(),
    db.prepare("SELECT challenge,run_id,root_id,attempt_id,consumed FROM fixture_challenge ORDER BY challenge").all(),
    db.prepare("SELECT id,challenge,action FROM fixture_challenge_audit ORDER BY id").all(),
    db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),
  ];
  return createHash("sha256").update(JSON.stringify({ domain: "cg-test-challenge-ledger-v1", tables })).digest("hex");
}

// An SQLite write lock is held during the IPC exchange. prepare is intentionally
// recorded by the supervisor before COMMIT. An interrupted prepared transition
// remains blocked; no automatic reconciliation or reinitialization is provided.
export async function guardedFixtureConsume(fixture, envelope, anchor, { beforeCommit = () => {}, afterCommit = () => {} } = {}) {
  const challenge = envelope?.payload?.challenge;
  if (typeof challenge !== "string" || !/^[0-9a-f]{64}$/u.test(challenge)) return false;
  fixture.db.exec("BEGIN IMMEDIATE"); let transaction = true;
  try {
    const before = challengeLedgerDigest(fixture.db);
    if (await anchor.check(before) !== true) throw new Error("anchor_state_unavailable_or_mismatch");
    const row = fixture.db.prepare("SELECT run_id,root_id,attempt_id,consumed FROM fixture_challenge WHERE challenge=?").get(challenge);
    const scope = row && { runId: row.run_id, rootId: row.root_id, attemptId: row.attempt_id };
    if (!row || row.consumed !== 0 || !verifyFixtureSignature(fixture.publicKey, envelope, scope, challenge)) {
      fixture.db.exec("ROLLBACK"); transaction = false; return false;
    }
    if (fixture.db.prepare("UPDATE fixture_challenge SET consumed=1 WHERE challenge=? AND consumed=0").run(challenge).changes !== 1) throw new Error("challenge_state_changed");
    fixture.db.prepare("INSERT INTO fixture_challenge_audit(challenge,action) VALUES(?,'consumed')").run(challenge);
    const after = challengeLedgerDigest(fixture.db);
    if (await anchor.prepare(before, after) !== true) throw new Error("anchor_prepare_refused");
    beforeCommit(); fixture.db.exec("COMMIT"); transaction = false;
    afterCommit();
    if (await anchor.finalize(before, after) !== true) throw new Error("anchor_finalize_refused");
    return true;
  } catch (error) { if (transaction) fixture.db.exec("ROLLBACK"); throw error; }
}
