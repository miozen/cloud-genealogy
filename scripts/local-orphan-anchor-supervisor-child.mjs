/* global process */
// Test supervisor: volatile anchor, exclusively held in this process.
let current = null; let pending = null; const bindings = new Map(); const bindingLimit = 128;
const digest = (value) => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
const uuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
const validBinding = (value) => value && typeof value === "object" && Object.keys(value).sort().join(",") === "hash,requestId" && uuid(value.requestId) && digest(value.hash);
process.on("message", ({ id, kind, before, after, binding }) => {
  let ok = false;
  if (kind === "bootstrap" && current === null && pending === null && digest(before)) { current = before; ok = true; }
  else if (kind === "check") ok = current !== null && pending === null && current === before;
  else if (kind === "prepare" && current !== null && pending === null && current === before && digest(after) && after !== before && (binding === undefined || (validBinding(binding) && !bindings.has(binding.requestId) && bindings.size < bindingLimit))) { pending = { before, after, binding: binding ?? null }; ok = true; }
  else if (kind === "finalize" && pending !== null && pending.before === before && pending.after === after) { if (pending.binding) bindings.set(pending.binding.requestId, pending.binding.hash); current = after; pending = null; ok = true; }
  else if (kind === "binding") {
    const saved = bindings.get(before); const status = current === null || pending !== null || !uuid(before) ? "unavailable" : saved === undefined ? "missing" : after === null ? "present" : saved === after ? "match" : "mismatch";
    process.send({ id, status }); return;
  }
  // Deliberately unsafe fault injection: the test process controls this supervisor.
  else if (kind === "test_forget" && current !== null && pending === null && uuid(before)) ok = bindings.delete(before);
  else if (kind === "test_rebase" && current !== null && pending === null && digest(before)) { current = before; ok = true; }
  else if (kind === "test_force_binding" && current !== null && pending === null && uuid(before) && digest(after)) { bindings.set(before, after); ok = true; }
  else if (kind === "inspect") {
    const comparison = pending === null ? "unavailable" : before === pending.before ? "matches_before" : before === pending.after ? "matches_after" : "mismatch";
    process.send({ id, comparison }); return;
  }
  else if (kind === "observe") {
    const state = current === null ? "uninitialized" : pending ? "pending" : "ready";
    const comparison = state === "uninitialized" ? "unavailable" : state === "pending" ? before === pending.before ? "matches_before" : before === pending.after ? "matches_after" : "mismatch" : before === current ? "matches_current" : "mismatch";
    process.send({ id, state, comparison }); return;
  }
  else if (kind === "capacity") {
    const state = current === null ? "uninitialized" : pending ? "pending" : "ready";
    const comparison = state === "uninitialized" ? "unavailable" : state === "pending" ? before === pending.before ? "matches_before" : before === pending.after ? "matches_after" : "mismatch" : before === current ? "matches_current" : "mismatch";
    const used = state === "uninitialized" ? null : bindings.size; const reserved = state === "uninitialized" ? null : pending?.binding ? 1 : 0;
    const remaining = used === null ? null : bindingLimit - used - reserved;
    process.send({ id, state, comparison, used, reserved, limit: bindingLimit, remaining }); return;
  }
  else if (kind === "status") { process.send({ id, state: current === null ? "uninitialized" : pending ? "pending" : "ready" }); return; }
  process.send({ id, ok });
});
process.send({ ready: true });
