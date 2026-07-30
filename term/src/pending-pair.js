// Cuộc ghép cặp đang dở, giữa `/remote pair` và `/remote pair xac-nhan <số>`.
//
// KHÔNG chứa bí mật: `sas` là con số đã hiện trên màn hình, `pubKey` là khoá
// công khai. Trộm được file này không ghép được gì — muốn ghép vẫn phải gõ
// đúng số mà chỉ điện thoại thật hiện ra. Đó là lý do nó được phép nằm trên
// đĩa, cùng lý do như devices.json.
//
// Bám đúng khuôn term/src/devices.js: đọc bọc try/catch, ghi qua temp +
// rename, mode 600, không hàm nào ném. File này nằm trên đường đi của
// `/remote pair xac-nhan` — thứ chạy trước khi biết gì về đúng/sai — nên một
// file hỏng phải nghĩa là "chưa có cuộc ghép nào đang dở" (bắt làm lại từ
// /remote pair), không phải một CLI chết.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeLabel } from './devices.js';

export function pendingPairPath(home) {
  if (home != null && typeof home !== 'string') {
    return path.join(os.homedir(), '.ccrc', 'pairing-pending.json');
  }
  return path.join(home || os.homedir(), '.ccrc', 'pairing-pending.json');
}

function normOpts(opts) {
  return opts && typeof opts === 'object' ? opts : {};
}

function fileFor(opts) {
  return opts.file || pendingPairPath(opts.home);
}

export function writePending(pending, opts) {
  opts = normOpts(opts);
  if (!pending || typeof pending !== 'object') return false;
  const {
    pairId, pubKey, label, sas, expiresAt,
  } = pending;
  if (typeof pairId !== 'string' || !pairId) return false;
  if (typeof pubKey !== 'string' || !pubKey) return false;
  if (typeof sas !== 'string' || !sas) return false;
  if (!Number.isFinite(expiresAt)) return false;

  let tmp;
  try {
    const file = fileFor(opts);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    tmp = `${file}.tmp`;
    const record = {
      // sanitizeLabel (src/devices.js): `label` là dữ liệu HUB — bên không
      // được tin — chảy thẳng tới cmdPairConfirm/say() (ccrc-term-cli.js) rồi
      // ra terminal của một agent Claude Code có quyền Bash. Cắt ở đây, ĐỘC
      // LẬP với addDevice's sanitize, cùng lý do: pending-pair.json cũng nằm
      // trên đường in ra ("gõ số này vào máy dev") trước khi tới addDevice.
      pairId, pubKey, label: sanitizeLabel(label), sas, expiresAt,
    };
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      if (tmp) fs.unlinkSync(tmp);
    } catch {
      // Ignore cleanup failure
    }
    return false;
  }
}

export function readPending(opts) {
  opts = normOpts(opts);
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(opts), 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    const {
      pairId, pubKey, label, sas, expiresAt,
    } = raw;
    if (typeof pairId !== 'string' || !pairId) return null;
    if (typeof pubKey !== 'string' || !pubKey) return null;
    if (typeof sas !== 'string' || !sas) return null;
    if (!Number.isFinite(expiresAt)) return null;
    if (Date.now() > expiresAt) return null;
    return {
      pairId, pubKey, label: typeof label === 'string' ? label : '', sas, expiresAt,
    };
  } catch {
    return null;
  }
}

export function clearPending(opts) {
  opts = normOpts(opts);
  try {
    fs.unlinkSync(fileFor(opts));
    return true;
  } catch (e) {
    // Không có gì để xoá cũng là đạt mục tiêu (không còn pending nào) — chỉ
    // một lỗi THẬT (quyền, đĩa hỏng) mới báo false.
    if (e && e.code === 'ENOENT') return true;
    return false;
  }
}
