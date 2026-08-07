import test from 'node:test';
import assert from 'node:assert/strict';
import { newConversation } from '../shared/lib/helpers.mjs';

test('newConversation clicks the create button once while waiting for the new view', async () => {
  let clicks = 0;
  let visibilityChecks = 0;
  const input = {
    last() { return this; },
    async count() { return 1; },
    async isVisible() { visibilityChecks += 1; return clicks === 1 && visibilityChecks >= 2; },
    async isDisabled() { return false; },
  };
  const newChat = {
    async isVisible() { return true; },
    async click() { clicks += 1; },
  };
  const page = {
    async goto() {},
    getByRole() { return newChat; },
    locator(selector) {
      assert.match(selector, /textarea/);
      return input;
    },
    async waitForTimeout() {},
  };

  await newConversation(page);

  assert.equal(clicks, 1);
});
