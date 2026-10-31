// Test convenience boundary only: it hides legacy methods from its callers,
// but cannot stop direct imports, database access, or a compromised process.
import { guardedFixtureConsume, guardedFixtureIssue, inspectFixturePending, observeFixtureState } from "./local-orphan-anchor-fixture.mjs";

export function createLocalGuardedFacade(fixture, anchor, hooks = {}) {
  const facade = Object.create(null);
  Object.assign(facade, {
    issue: (scope) => guardedFixtureIssue(fixture, scope, anchor, hooks),
    consume: (envelope) => guardedFixtureConsume(fixture, envelope, anchor, hooks),
    inspect: () => inspectFixturePending(fixture, anchor),
    observe: () => observeFixtureState(fixture, anchor),
  });
  return Object.freeze(facade);
}
