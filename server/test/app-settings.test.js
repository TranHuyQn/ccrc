// Trang Cài đặt là màn hình thứ hai trong cùng một file HTML. Hai chuyện phải
// đúng và không có gì khác bắt được: nó dùng pushState chứ không replaceState
// (replaceState làm nút Back rời khỏi trang, đúng cái người dùng không định
// làm), và nó KHÔNG đổi đường dẫn (vì /link dùng chung file này).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAppPage } from './dom-harness.mjs';

const moCaiDat = (page) => page.byId['settings-open'].onclick();

test('bấm ⚙ thì hiện Cài đặt, ẩn danh sách', () => {
  const page = loadAppPage({});
  page.byId.main.classList.remove('hidden');
  moCaiDat(page);
  assert.equal(page.byId.settings.classList.contains('hidden'), false);
  assert.equal(page.byId.main.classList.contains('hidden'), true);
});

test('mở Cài đặt đẩy một mục vào lịch sử, và KHÔNG đổi đường dẫn', () => {
  const page = loadAppPage({});
  moCaiDat(page);
  assert.equal(page.pushCalls.length, 1, 'phải pushState — replaceState làm Back rời khỏi trang');
  assert.equal(page.pushCalls[0].url, '/', 'không được đổi đường dẫn: /link dùng chung file này');
});

test('nút Back của điện thoại đóng Cài đặt, quay về danh sách', () => {
  const page = loadAppPage({});
  page.byId.main.classList.remove('hidden');
  moCaiDat(page);
  page.window.dispatch('popstate', { state: null });
  assert.equal(page.byId.settings.classList.contains('hidden'), true);
  assert.equal(page.byId.main.classList.contains('hidden'), false);
});

test('nút ‹ đóng bằng đường history.back(), không tự ẩn tay', () => {
  const page = loadAppPage({});
  page.byId.main.classList.remove('hidden');
  moCaiDat(page);
  page.byId['settings-close'].onclick();
  assert.equal(page.byId.settings.classList.contains('hidden'), true,
    'back() phải bắn popstate và popstate mới là chỗ đóng — một đường duy nhất');
  assert.equal(page.byId.main.classList.contains('hidden'), false);
});

test('bấm ⚙ hai lần không đẩy hai mục vào lịch sử', () => {
  const page = loadAppPage({});
  moCaiDat(page);
  moCaiDat(page);
  assert.equal(page.pushCalls.length, 1, 'hai mục thì phải bấm Back hai lần mới ra — bẫy quen thuộc');
});
