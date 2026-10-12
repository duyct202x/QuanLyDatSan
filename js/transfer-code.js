// TransferCode - Mã chuyển khoản riêng cho từng thành viên (dùng chung cho trình duyệt và Google Apps Script).
// KHÔNG sửa bản trong google_apps_script_prod.js - chạy `python tools/build_gas_backend.py` để sinh lại.
//
// Mỗi thành viên có 1 mã 5 ký tự cố định (members[].transferCode), ví dụ "K7X2Q", chèn vào nội dung chuyển khoản
// để biết CHÍNH XÁC ai đã chuyển (tên người có thể trùng, mã thì không).
// - Bảng ký tự bỏ các ký tự dễ nhầm khi đọc/chụp màn hình (0/O, 1/I/L, 2/Z, 5/S, 8/B) -> còn 25 ký tự.
// - Mã được sinh từ băm của id thành viên (ổn định) và dò lại nếu trùng; máy chủ là nơi cấp & ghi (không thể trùng).
// - Phụ thuộc AuthCore.sha256 (nạp trước).
var TransferCode = (function () {
  var ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679';
  var LENGTH = 5;
  var FORMAT = /^[ACDEFGHJKMNPQRTUVWXY34679]{5}$/;

  function fromSeed(seed, salt) {
    var hex = AuthCore.sha256('SP-TRANSFER:' + String(seed) + ':' + (salt || 0));
    var n = parseInt(hex.slice(0, 10), 16), out = '';
    for (var i = 0; i < LENGTH; i++) {
      out += ALPHABET.charAt(n % ALPHABET.length);
      n = Math.floor(n / ALPHABET.length);
    }
    return out;
  }

  function isValid(code) {
    return typeof code === 'string' && FORMAT.test(code);
  }

  // members: [{ id, transferCode? }]. Trả về { id: mã } cho người CHƯA có mã hợp lệ hoặc bị trùng.
  // Kết quả không phụ thuộc thứ tự mảng đầu vào; người có id nhỏ hơn được giữ mã khi trùng.
  function plan(members) {
    var list = (members || []).filter(function (m) { return m && m.id; }).slice().sort(function (a, b) {
      return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
    });
    var taken = {}, changes = {};
    list.forEach(function (m) {
      if (isValid(m.transferCode) && !taken[m.transferCode]) taken[m.transferCode] = String(m.id);
    });
    list.forEach(function (m) {
      if (isValid(m.transferCode) && taken[m.transferCode] === String(m.id)) return;
      var salt = 0, code;
      do { code = fromSeed(m.id, salt++); } while (taken[code]);
      taken[code] = String(m.id);
      changes[m.id] = code;
    });
    return changes;
  }

  // Mã dùng để HIỂN THỊ: mã đã lưu nếu hợp lệ, nếu chưa có thì mã dự kiến (trùng với mã máy chủ sẽ cấp, trừ khi va chạm)
  function codeOf(member, members) {
    if (member && isValid(member.transferCode)) return member.transferCode;
    if (!member || !member.id) return '';
    var list = (members || []).filter(function (m) { return m && m.id !== member.id; }).concat([{ id: member.id }]);
    return plan(list)[member.id] || fromSeed(member.id, 0);
  }

  return { ALPHABET: ALPHABET, LENGTH: LENGTH, fromSeed: fromSeed, isValid: isValid, plan: plan, codeOf: codeOf };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TransferCode;
