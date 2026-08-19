// `test` thay thế, tự skip cả file khi máy không chạy được script `#!/bin/sh`.
//
// Cùng hình dạng với can-tmux.mjs, và cùng lý do chọn hình dạng ấy: đổi đúng
// DÒNG IMPORT thì thân file test có sẵn không bị chạm một ký tự nào, nên không
// có cơ hội làm yếu một khẳng định mà không ai nhận ra.
import { test as testGoc } from 'node:test';
import { coShebang, LY_DO_SHEBANG } from './co-shebang.mjs';

export const chayDuocShebang = coShebang();

export function test(ten, ...conLai) {
  const fn = typeof conLai[conLai.length - 1] === 'function' ? conLai.pop() : undefined;
  const opts = typeof conLai[0] === 'object' && conLai[0] !== null ? conLai[0] : {};
  if (chayDuocShebang) return testGoc(ten, opts, fn);
  return testGoc(ten, { ...opts, skip: opts.skip || LY_DO_SHEBANG }, fn);
}

export default test;
