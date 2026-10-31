/* global process */
// Test supervisor: volatile anchor, exclusively held in this process.
let current = null; let pending = null;
const digest = (value) => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
process.on("message", ({ id, kind, before, after }) => {
  let ok = false;
  if (kind === "bootstrap" && current === null && pending === null && digest(before)) { current = before; ok = true; }
  else if (kind === "check") ok = current !== null && pending === null && current === before;
  else if (kind === "prepare" && current !== null && pending === null && current === before && digest(after) && after !== before) { pending = { before, after }; ok = true; }
  else if (kind === "finalize" && pending !== null && pending.before === before && pending.after === after) { current = after; pending = null; ok = true; }
  else if (kind === "inspect") {
    const comparison = pending === null ? "unavailable" : before === pending.before ? "matches_before" : before === pending.after ? "matches_after" : "mismatch";
    process.send({ id, comparison }); return;
  }
  else if (kind === "observe") {
    const state = current === null ? "uninitialized" : pending ? "pending" : "ready";
    const comparison = state === "uninitialized" ? "unavailable" : state === "pending" ? before === pending.before ? "matches_before" : before === pending.after ? "matches_after" : "mismatch" : before === current ? "matches_current" : "mismatch";
    process.send({ id, state, comparison }); return;
  }
  else if (kind === "status") { process.send({ id, state: current === null ? "uninitialized" : pending ? "pending" : "ready" }); return; }
  process.send({ id, ok });
});
process.send({ ready: true });
