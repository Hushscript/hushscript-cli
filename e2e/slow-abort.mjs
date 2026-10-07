// Test-only preload (`node --import`): AbortController.abort() takes effect a minute late, so a first
// Ctrl-C winds down slowly enough for the test to send a second one while the CLI is still waiting.
const originalAbort = AbortController.prototype.abort;
const DELAY_MS = 60_000;

/**
 * @this {AbortController}
 * @param {unknown} [reason]
 */
AbortController.prototype.abort = function (reason) {
  setTimeout(() => {
    originalAbort.call(this, reason);
  }, DELAY_MS);
};
