// Phân giải tên lệnh ra đường dẫn đầy đủ, và khởi chạy một tiến trình sống
// sót qua lúc phiên gọi nó đóng — chỉ dùng trên Windows, cho `ccrc-host`.
//
// Hai điều đã đo được, không phải đoán, và là toàn bộ lý do file này có hình
// dạng thế này:
//
//  1. `pty.spawn` KHÔNG tìm PATHEXT. `pty.spawn('cmd.exe', ...)` chạy được;
//     `pty.spawn('cmd', ...)` ném `File not found`. Nên một cái tên lệnh phải
//     được phân giải ra đường dẫn đầy đủ trước khi đưa cho pty. Một file
//     `.cmd` thì spawn THẲNG được — không cần bọc qua `cmd.exe /c`, và thêm
//     lớp bọc đó vào là thêm một tầng gián tiếp vĩnh viễn mà không có lý do.
//
//  2. `spawn(..., { detached: true })` không sống sót qua lúc phiên đóng.
//     Windows nhốt phiên gọi vào một Job Object, và Node không có cờ
//     breakaway để tiến trình con thoát khỏi đó — nên con chết theo cha. Nó
//     chết TRƯỚC CẢ dòng lệnh đầu tiên của mình, nên không log nào được tạo
//     và stderr rỗng trơn: trông y hệt "crash lúc nạp", chứ không phải "bị hệ
//     điều hành giết". `Win32_Process.Create` qua WMI không đi qua Job Object
//     của tiến trình gọi, nên tiến trình nó tạo ra sống sót.

import { execFileSync } from 'node:child_process';

/**
 * Phân giải tên lệnh (vd. 'node', 'cmd') ra đường dẫn tuyệt đối, bằng
 * where.exe. where.exe trả về NHIỀU DÒNG khi PATH có nhiều bản trùng tên —
 * lấy dòng đầu, đó là bản mà một shell thật sự sẽ chạy.
 *
 * Ném lỗi có tên lệnh trong câu, để người dùng biết chính xác thiếu cái gì.
 */
export function resolveCommand(name) {
  let stdout;
  try {
    stdout = execFileSync('where.exe', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new Error(`Không tìm thấy lệnh "${name}" trên PATH. Cài đặt nó, hoặc sửa PATH rồi thử lại.`);
  }
  const dongDau = stdout
    .split(/\r?\n/)
    .map((dong) => dong.trim())
    .find((dong) => dong.length > 0);
  if (!dongDau) {
    throw new Error(`Không tìm thấy lệnh "${name}" trên PATH. Cài đặt nó, hoặc sửa PATH rồi thử lại.`);
  }
  return dongDau;
}

// Escape một tham số theo đúng quy tắc CommandLineToArgvW mà CreateProcess
// dùng để tách argv — không phải quy tắc của cmd.exe hay của shell nào khác.
// Đây là lớp escape DUY NHẤT áp cho từng phần tử của mảng args; cwd/command
// tự nó không đi qua đây vì chúng không phải một phần tử argv.
function quoteArg(arg) {
  const s = String(arg);
  if (s.length > 0 && !/[\s"]/.test(s)) return s;
  let ketQua = '"';
  let i = 0;
  while (i < s.length) {
    let soBackslash = 0;
    while (i < s.length && s[i] === '\\') {
      soBackslash += 1;
      i += 1;
    }
    if (i === s.length) {
      // Backslash cuối chuỗi: nhân đôi, vì dấu ngoặc đóng ta thêm sau sẽ biến
      // chúng thành ký tự đặc biệt nếu không nhân đôi.
      ketQua += '\\'.repeat(soBackslash * 2);
    } else if (s[i] === '"') {
      ketQua += '\\'.repeat(soBackslash * 2 + 1) + '"';
      i += 1;
    } else {
      ketQua += '\\'.repeat(soBackslash) + s[i];
      i += 1;
    }
  }
  ketQua += '"';
  return ketQua;
}

function xayDongLenh(command, args) {
  return [command, ...args].map(quoteArg).join(' ');
}

// Escape để nhét một chuỗi vào literal PowerShell dạng nháy đơn — quy tắc
// khác hẳn quoteArg ở trên: chỉ cần nhân đôi dấu nháy đơn, PowerShell không
// diễn giải bất cứ gì khác bên trong nháy đơn (không nội suy biến).
function nhayDonPS(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// DETACHED_PROCESS. Tiến trình tạo ra KHÔNG nhận console nào cả.
//
// Vì sao cần: `Win32_Process.Create` mặc định cấp cho tiến trình con một
// console mới, và trên máy có màn hình nó hiện ra thành MỘT CỬA SỔ node.exe
// nữa mỗi lần gõ `ccrc` — người dùng thấy ngay và hỏi tại sao.
//
// Đã đo trên máy Windows thật, đếm conhost con của tiến trình vừa tạo:
//   không cờ gì            -> 1 conhost   (đúng cửa sổ thừa ấy)
//   ShowWindow = 0         -> 1 conhost   (SW_HIDE KHÔNG chặn việc tạo console)
//   CreateFlags = 0x8000000 (CREATE_NO_WINDOW) -> ReturnValue 21, tham số sai
//   CreateFlags = 8        -> 0 conhost   ✅
//
// Và câu hỏi thật sự đáng lo — ConPTY có sống nổi khi cha không có console
// không — cũng đã đo: chạy node-pty trong một tiến trình DETACHED, nó vẫn
// spawn được cmd.exe và nhận về 3 chunk / 261 byte. node-pty tự dựng
// pseudoconsole riêng, không mượn console của tiến trình.
const DETACHED_PROCESS = 8;

function xayScriptPS({ commandLine, cwd, envVars }) {
  const dong = ["$ErrorActionPreference = 'Stop'"];
  const doiSo = [`CommandLine = ${nhayDonPS(commandLine)}`];
  if (cwd) doiSo.push(`CurrentDirectory = ${nhayDonPS(cwd)}`);
  // ProcessStartupInformation dựng KHÔNG ĐIỀU KIỆN: trước đây nó chỉ tồn tại
  // khi có biến môi trường, nên cờ cửa sổ không có chỗ nào để bám vào.
  const props = [`CreateFlags = [uint32]${DETACHED_PROCESS}`];
  if (envVars && envVars.length > 0) {
    props.push(`EnvironmentVariables = @(${envVars.map(nhayDonPS).join(', ')})`);
  }
  dong.push(
    `$su = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ${props.join('; ')} }`,
  );
  doiSo.push('ProcessStartupInformation = $su');
  dong.push(`$ket = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ ${doiSo.join('; ')} }`);
  dong.push('[PSCustomObject]@{ ProcessId = $ket.ProcessId; ReturnValue = $ket.ReturnValue } | ConvertTo-Json -Compress');
  return dong.join('\n');
}

function chayPowerShell(script) {
  // -EncodedCommand nhận Base64 của UTF-16LE: đi vòng qua toàn bộ chuyện
  // escape của lớp shell trung gian (kể cả ssh/cmd nếu ai đó gọi qua đó) —
  // script tới PowerShell nguyên vẹn bất kể nó chứa dấu nháy hay khoảng trắng.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  try {
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    const chiTiet = err.stderr || err.message;
    throw new Error(`Gọi PowerShell/WMI thất bại: ${chiTiet}`);
  }
}

function xayMangEnv(env) {
  return Object.entries(env)
    .filter(([, gia]) => gia !== undefined && gia !== null)
    .map(([ten, gia]) => `${ten}=${gia}`);
}

/**
 * Khởi chạy `command` qua WMI `Win32_Process.Create` — tiến trình tạo ra
 * KHÔNG phải con của tiến trình Node gọi hàm này, nên không bị Job Object của
 * phiên hiện tại trói, nên sống sót qua lúc phiên đóng. Đây là lý do duy nhất
 * hàm này tồn tại thay vì `child_process.spawn(..., { detached: true })`.
 *
 * `env` mặc định là `process.env`, giống quy ước của `child_process.spawn` —
 * bỏ qua nó sẽ khiến tiến trình chỉ thấy môi trường (nghèo nàn) của tiến
 * trình WMI, không phải môi trường của người gọi.
 *
 * Trả về pid (số > 0). Ném lỗi CÓ KÈM CON SỐ `ReturnValue` khi WMI báo thất
 * bại — nuốt nó là để người dùng nhìn một tiến trình không bao giờ khởi động
 * mà không một lời giải thích.
 */
export function launchSurviving({ command, args = [], cwd, env = process.env }) {
  const commandLine = xayDongLenh(command, args);
  const envVars = xayMangEnv(env || {});
  const script = xayScriptPS({ commandLine, cwd, envVars });
  const stdout = chayPowerShell(script);

  let ket;
  try {
    ket = JSON.parse(stdout);
  } catch {
    throw new Error(`Không đọc được kết quả WMI (không phải JSON): ${stdout}`);
  }

  const { ProcessId, ReturnValue } = ket;
  if (ReturnValue !== 0) {
    throw new Error(`Win32_Process.Create thất bại với ReturnValue=${ReturnValue} (lệnh: ${commandLine})`);
  }
  if (!(ProcessId > 0)) {
    throw new Error(`Win32_Process.Create không trả về ProcessId hợp lệ (nhận: ${ProcessId})`);
  }
  return ProcessId;
}
