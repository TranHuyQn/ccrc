// Địa chỉ hub sẽ nghe.
//
// Vì sao tách ra khỏi index.js: nó có đúng một quyết định, và quyết định ấy sai
// thì hub biến mất khỏi mạng — thứ phải kiểm được bằng test rẻ, không phải bằng
// cách dựng hub rồi thử từ máy khác.
//
// Trước bản này `app.listen(PORT)` luôn nghe mọi interface, còn `CCRC_BIND` chỉ
// tác động vế `ports:` của docker-compose. Người vận hành chạy hub bằng Node
// trực tiếp (deploy/ccrc-hub.service) đặt CCRC_BIND=127.0.0.1 và tin rằng cổng
// đã đóng, trong khi nó vẫn mở ra cả LAN — một cái sai ÂM THẦM, đúng loại tệ
// nhất.
//
// Mặc định giữ nguyên `0.0.0.0`, và đó không phải là lười: trong container, app
// PHẢI nghe mọi interface thì cloudflared ở network khác mới gọi được
// `http://hub:8720`. Đổi mặc định thành loopback là làm chết mọi deployment
// Docker đang chạy — bao gồm cách README khuyến nghị.
export function listenAddr(env = process.env) {
  const v = typeof env.CCRC_BIND === 'string' ? env.CCRC_BIND.trim() : '';
  return v || '0.0.0.0';
}
