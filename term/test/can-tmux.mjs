// `test` thay thế, tự skip cả file khi máy không có tmux dùng được.
//
// VÌ SAO KHÔNG RÀO THEO NỀN TẢNG: một container CI Linux không cài tmux đâm
// vào đúng bức tường ấy, và câu hỏi thật là "máy này có tmux không", không
// phải "máy này có phải Windows không". `coTmux()` hỏi đúng câu đó.
//
// VÌ SAO LÀ MỘT WRAPPER CHỨ KHÔNG SỬA TỪNG LỜI GỌI `test`: daemon.test.js có
// 79 bài, remote-cli.test.js có 47. Thêm `{ skip }` vào từng chỗ là một diff
// khổng lồ trên các file test CÓ SẴN, và mỗi dòng đụng vào là một cơ hội làm
// yếu một khẳng định mà không ai nhận ra. Đổi đúng DÒNG IMPORT thì phần thân
// file không bị chạm tới một ký tự nào — và đó là tính chất mình muốn có khi
// sửa test của người khác.
//
// Trên máy CÓ tmux (macOS của dự án này, và mọi CI Linux có cài tmux) file này
// trả về đúng `test` gốc, nên không có gì đổi.
import { test as testGoc } from 'node:test';
import { coTmux } from '../src/tmux-co-khong.js';

export const coTmuxDungDuoc = coTmux();

const LY_DO = 'máy này không có tmux dùng được';

export function test(ten, ...conLai) {
  // node:test nhận `(tên, fn)`, `(tên, opts, fn)`, và cả `(tên, opts)`.
  const fn = typeof conLai[conLai.length - 1] === 'function' ? conLai.pop() : undefined;
  const opts = typeof conLai[0] === 'object' && conLai[0] !== null ? conLai[0] : {};
  if (coTmuxDungDuoc) return testGoc(ten, opts, fn);
  // Giữ nguyên `skip` đã có nếu bài tự skip vì lý do khác — ghi đè nó là nói
  // sai lý do trong báo cáo.
  return testGoc(ten, { ...opts, skip: opts.skip || LY_DO }, fn);
}

export default test;
