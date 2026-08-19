import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { ccrcHome } from '../../shared/home.js';

test('mặc định là thư mục nhà của hệ điều hành', () => {
  assert.equal(ccrcHome({}), os.homedir());
});

test('CCRC_HOME đè lên, kể cả khi HOME nói khác', () => {
  // Đây là toàn bộ lý do hàm này tồn tại: trên Windows, đặt HOME KHÔNG đổi
  // được os.homedir() (nó đọc USERPROFILE), nên test không cô lập nổi và
  // ghi thẳng vào hồ sơ thật của người dùng. Đã xảy ra một lần, 2026-08-18.
  assert.equal(ccrcHome({ CCRC_HOME: '/tmp/gia', HOME: '/tmp/khac' }), '/tmp/gia');
});

test('chuỗi rỗng hoặc kiểu sai thì bỏ qua, không biến thành đường dẫn rỗng', () => {
  // Một biến môi trường đặt hụt (`CCRC_HOME=`) mà được tin là sẽ ghi vào
  // `/.ccrc` ở gốc ổ đĩa — hỏng theo kiểu khó lần ra nhất.
  assert.equal(ccrcHome({ CCRC_HOME: '' }), os.homedir());
  assert.equal(ccrcHome({ CCRC_HOME: '   ' }), os.homedir());
});
