import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activateChatInput,
  assertCurrentConversation,
  CONVERSATION_MISMATCH_ERROR_CODE,
  newConversation,
  selectChatCategory,
  selectMonitoringConversation,
} from '../shared/lib/helpers.mjs';

function collection(items) {
  return {
    async count() { return items.length; },
    nth(index) { return items[index]; },
  };
}

function action(label, onClick, initialSelected = false) {
  let selected = initialSelected;
  return {
    async innerText() { return label; },
    async isVisible() { return true; },
    async getAttribute(name) { return name === 'class' ? `chat-action${selected ? ' selected' : ''}` : null; },
    async click() { selected = true; onClick?.(); },
  };
}

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

test('selectChatCategory clicks and confirms only the requested category', async () => {
  const clicked = [];
  const actions = [
    action('数据建模', () => clicked.push('数据建模')),
    action('材料计算', () => clicked.push('材料计算')),
  ];
  const page = {
    locator(selector) {
      assert.match(selector, /chat-action/);
      return collection(actions);
    },
    getByText() { return collection([]); },
    async waitForTimeout() {},
  };

  assert.equal(await selectChatCategory(page, '材料计算', 100), true);
  assert.deepEqual(clicked, ['材料计算']);
});

test('newConversation activates the requested category instead of data modeling', async () => {
  let newChatClicks = 0;
  let inputEnabled = false;
  const clicked = [];
  const actions = [
    action('数据建模', () => clicked.push('数据建模')),
    action('材料计算', () => {
      clicked.push('材料计算');
      inputEnabled = true;
    }),
  ];
  const input = {
    last() { return this; },
    async count() { return 1; },
    async isVisible() { return newChatClicks === 1; },
    async isDisabled() { return !inputEnabled; },
  };
  const newChat = {
    async isVisible() { return true; },
    async click() { newChatClicks += 1; },
  };
  const page = {
    async goto() {},
    getByRole() { return newChat; },
    getByText() { return collection([]); },
    locator(selector) {
      if (/chat-action/.test(selector)) return collection(actions);
      return input;
    },
    async waitForTimeout() {},
  };

  await newConversation(page, '材料计算');

  assert.equal(newChatClicks, 1);
  assert.deepEqual(clicked, ['材料计算']);
  assert.equal(inputEnabled, true);
});

test('activateChatInput does not fall back to another category when a target is explicit', async () => {
  const clicked = [];
  const actions = [action('数据建模', () => clicked.push('数据建模'))];
  const input = {
    last() { return this; },
    async isVisible() { return true; },
    async isDisabled() { return true; },
  };
  const page = {
    locator(selector) {
      if (/chat-action/.test(selector)) return collection(actions);
      return input;
    },
    getByText() { return collection([]); },
    async waitForTimeout() {},
  };

  await assert.rejects(
    activateChatInput(page, '材料计算', 5),
    /无法选择“材料计算”聊天分类/,
  );
  assert.deepEqual(clicked, []);
});

test('activateChatInput replaces a previously selected category even when input is enabled', async () => {
  const clicked = [];
  const actions = [
    action('数据建模', () => clicked.push('数据建模'), true),
    action('材料计算', () => clicked.push('材料计算')),
  ];
  const input = {
    last() { return this; },
    async isVisible() { return true; },
    async isDisabled() { return false; },
  };
  const page = {
    locator(selector) {
      if (/chat-action/.test(selector)) return collection(actions);
      return input;
    },
    getByText() { return collection([]); },
    async waitForTimeout() {},
  };

  assert.equal(await activateChatInput(page, '材料计算', 100), '材料计算');
  assert.deepEqual(clicked, ['材料计算']);
});

test('assertCurrentConversation marks a conversation mismatch as a prerequisite error', async () => {
  const page = {
    async evaluate() { return 'other-conversation'; },
    async waitForTimeout() {},
  };

  await assert.rejects(
    assertCurrentConversation(page, 'expected-conversation', 1),
    (error) => {
      assert.equal(error.code, CONVERSATION_MISMATCH_ERROR_CODE);
      assert.match(error.message, /当前页面会话与自动化专用会话不一致/);
      return true;
    },
  );
});

test('selectMonitoringConversation accepts a title attribute with message-count suffix and verifies id', async () => {
  let currentConversationId = 'other-conversation';
  let clicks = 0;
  const titleNode = {
    async innerText() { return ''; },
  };
  const item = {
    locator() {
      return { first() { return titleNode; } };
    },
    async getAttribute(name) {
      return name === 'title' ? '【自动化测试】材料计算\n3 条消息' : null;
    },
    async innerText() { return '【自动化测试】材料计算\n3 条消息'; },
    async click() {
      clicks += 1;
      currentConversationId = 'material-conversation';
    },
  };
  const input = {
    last() { return this; },
    async waitFor() {},
    async isVisible() { return true; },
    async isDisabled() { return false; },
  };
  const page = {
    locator(selector) {
      if (/chat-item/.test(selector)) return collection([item]);
      return input;
    },
    async evaluate(_callback, argument) {
      if (typeof argument === 'string' && argument === 'ximu:selected-conversation-id') {
        return currentConversationId;
      }
      throw new Error('unexpected evaluate call');
    },
    async waitForTimeout() {},
  };

  const selected = await selectMonitoringConversation(page, {
    conversationId: 'material-conversation',
    title: '【自动化测试】材料计算',
    maxRounds: 1,
  });

  assert.equal(selected, true);
  assert.equal(clicks, 1);
  assert.equal(currentConversationId, 'material-conversation');
});
