// Dấu vân tay của một bản cài: một chuỗi đổi khi và chỉ khi code đổi.
//
// Sinh ra để trả lời câu "máy này có đang chạy bản cũ không" — thứ mà
// PROTOCOL_VERSION không trả lời được, vì số đó chỉ tăng khi HỢP ĐỒNG giữa
// trang và daemon đổi. Một bản chỉ sửa lỗi giữ nguyên số ấy và trôi qua không
// ai biết.
//
// Vì sao không hash thẳng `ccrc-bundle.tar.gz`: `tar czf` trong
// docker/Dockerfile.hub không truyền --sort/--mtime, và gzip nhúng thời điểm
// nén, nên dựng lại đúng cùng một cây code vẫn ra một file khác. Lấy nó làm
// mốc thì mỗi lần build lại image là một lần giục người dùng cài lại vì không
// có gì cả. Làm cho tar dựng-lặp-lại-được thì phải kéo GNU tar vào image
// node:22-alpine (busybox tar không có --sort) — đắt hơn hẳn việc tự đọc file.
//
// Tính chất phải giữ bằng mọi giá: hub tính trên cây code của nó, máy dev tính
// trên thư mục cài của mình, và hai bên PHẢI ra cùng một chuỗi. Nên mọi thứ ở
// đây đều cố định: danh sách đường dẫn, thứ tự, cách loại trừ.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Đúng những gì docker/Dockerfile.hub gom vào gói cài, không hơn không kém.
// Thêm/bớt ở đó thì phải sửa cả ở đây, nếu không hai bên lệch nhau vĩnh viễn
// và lời nhắc cài lại sẽ hiện mãi.
const MUC = [
  'hook',
  'term',
  'shared',
  'deploy/commands',
  'deploy/ccrc',
  'setup-notify.sh',
  'remove-notify.sh',
];

// Thứ do VIỆC CÀI sinh ra, không thuộc gói cài — phải loại, nếu không máy vừa
// cài xong đã lệch dấu vân tay với hub ngay và lời nhắc "có bản mới" hiện
// vĩnh viễn. Đo thật 2026-08-17: `npm install --omit=dev` trong $DEST/term để
// lại CẢ HAI thứ dưới đây, còn gói cài thì không có cái nào.
//   node_modules      — máy dev có, hub không (.dockerignore bỏ)
//   package-lock.json — npm tự ghi ra khi cài phụ thuộc
// Còn lại chỉ là rác của hệ điều hành và công cụ.
const BO_QUA = new Set(['node_modules', 'package-lock.json', '.git', '.DS_Store']);

function gomFile(goc, tuongDoi, ra) {
  const day = path.join(goc, tuongDoi);
  const st = fs.statSync(day); // ném nếu không có — người gọi bắt
  if (st.isFile()) { ra.push(tuongDoi); return; }
  if (!st.isDirectory()) return; // symlink lạ, socket… không phải nội dung
  for (const ten of fs.readdirSync(day)) {
    if (BO_QUA.has(ten)) continue;
    gomFile(goc, path.posix.join(tuongDoi, ten), ra);
  }
}

/**
 * @param {string} goc thư mục gốc của bản cài (hoặc của cây nguồn)
 * @returns {string|null} sha256 dạng hex, hoặc null khi cây không đầy đủ —
 *   KHÔNG hash phần còn lại. Một bản cài dở dang (install.sh vừa `rm -rf`
 *   xong chưa kịp bung) không được sinh ra dấu vân tay trông hợp lệ, vì nó
 *   sẽ khác hub và giục người dùng cài lại đúng lúc họ đang cài.
 */
export function dauVanTay(goc) {
  try {
    const duongDan = [];
    for (const m of MUC) gomFile(goc, m, duongDan);
    // Sắp xếp là thứ làm kết quả độc lập với thứ tự readdir trả về, vốn khác
    // nhau giữa các hệ tập tin.
    duongDan.sort();

    const bam = crypto.createHash('sha256');
    for (const p of duongDan) {
      // Đường dẫn đi vào phép băm cùng nội dung: đổi tên một file mà giữ
      // nguyên nội dung vẫn phải ra dấu vân tay khác.
      bam.update(p, 'utf8');
      bam.update('\0');
      bam.update(crypto.createHash('sha256').update(fs.readFileSync(path.join(goc, p))).digest());
      bam.update('\n');
    }
    return bam.digest('hex');
  } catch {
    return null;
  }
}
