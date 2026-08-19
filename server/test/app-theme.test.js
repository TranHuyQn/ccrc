// Ba lựa chọn giao diện. Điều đáng canh không phải "đặt được thuộc tính" mà là
// hai chuyện dễ quên: "theo thiết bị" phải GỠ HẲN data-theme (để lại là CSS hệ
// thống không bao giờ thắng được nữa), và thẻ theme-color phải đổi theo — CSS
// tự đổi màu, thẻ meta thì không, và thanh trạng thái PWA trên iPhone lấy màu
// từ đúng thẻ đó.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAppPage } from './dom-harness.mjs';

const TOI = '#101318';
const SANG = '#f6f4f2';
const theme = (page) => page.document.documentElement.getAttribute('data-theme');
const mauThanh = (page) => page.byId['theme-meta'].getAttribute('content');

test('mặc định là "theo thiết bị": không đặt data-theme', () => {
  const page = loadAppPage({});
  assert.equal(theme(page), null);
  assert.equal(page.byId['theme-select'].value, 'auto');
});

test('chọn Sáng: đặt data-theme=light, đổi cả màu thanh trạng thái, và nhớ lại', () => {
  const page = loadAppPage({});
  page.byId['theme-select'].value = 'light';
  page.byId['theme-select'].onchange();
  assert.equal(theme(page), 'light');
  assert.equal(mauThanh(page), SANG);
  assert.equal(page.localStorage.getItem('ccrc_theme'), 'light');
});

test('chọn Tối: đặt data-theme=dark dù hệ thống đang để sáng', () => {
  const page = loadAppPage({ media: { '(prefers-color-scheme: dark)': false } });
  page.byId['theme-select'].value = 'dark';
  page.byId['theme-select'].onchange();
  assert.equal(theme(page), 'dark');
  assert.equal(mauThanh(page), TOI);
});

test('quay lại "theo thiết bị" thì GỠ HẲN data-theme', () => {
  const page = loadAppPage({});
  page.byId['theme-select'].value = 'light';
  page.byId['theme-select'].onchange();
  page.byId['theme-select'].value = 'auto';
  page.byId['theme-select'].onchange();
  assert.equal(theme(page), null, 'để lại data-theme="light" thì cài đặt hệ thống không bao giờ thắng nữa');
});

test('mở lại app: đọc lựa chọn đã lưu, áp ngay, và dropdown khớp', () => {
  const page = loadAppPage({ storeSeed: { ccrc_theme: 'light' } });
  assert.equal(theme(page), 'light');
  assert.equal(page.byId['theme-select'].value, 'light');
});

test('"theo thiết bị" + hệ thống đổi sang tối → màu thanh trạng thái đổi theo', () => {
  const page = loadAppPage({ media: { '(prefers-color-scheme: dark)': false } });
  assert.equal(mauThanh(page), SANG);
  const l = page.window.mediaListeners.find((x) => x.query === '(prefers-color-scheme: dark)');
  assert.ok(l, 'phải nghe hệ thống đổi — CSS tự đổi, thẻ meta thì không');
  l.fn({ matches: true });
  assert.equal(mauThanh(page), TOI);
});
