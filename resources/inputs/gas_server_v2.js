/**
 * Google Apps Script Backend v2 - SMASH PRO Badminton Management System
 * (Tệp nguồn. Tệp để dán vào Apps Script là google_apps_script_prod.js, sinh bằng tools/build_gas_backend.py)
 *
 * Kiến trúc lưu trữ v2:
 *  - Mỗi bản ghi (thành viên, buổi đánh, giao dịch...) là 1 DÒNG trong sheet "<môi trường>_v2":
 *      A: COL | B: KEY | C: SEQ (số thứ tự thay đổi) | D..: JSON bản ghi (chia nhỏ nếu dài)
 *  - Mỗi lần ghi chỉ cập nhật các dòng thay đổi (không ghi lại toàn bộ CSDL).
 *  - SEQ tăng dần theo từng lần ghi -> máy trạm chỉ tải phần thay đổi (?since=SEQ).
 *  - Xung đột được giải theo từng TRƯỜNG dữ liệu bằng đồng hồ HLC (SyncCore v2):
 *    máy cũ chỉ gửi trường nó thực sự sửa, nên không thể ghi đè dữ liệu mới của máy khác.
 *  - Sheet cũ (v1, JSON nguyên khối) được GIỮ NGUYÊN làm bản sao lưu; lần chạy đầu tự chuyển dữ liệu sang v2.
 *  - Thiết bị chưa cập nhật mã mới (v1) chỉ được ĐỌC dữ liệu công khai, không được ghi.
 *
 * Bảo mật:
 *  - Đăng nhập/đăng ký/đổi mật khẩu chỉ xử lý trên máy chủ; máy chủ cấp token ký HMAC (bí mật trong ScriptProperties).
 *  - Mọi op ghi phải kèm token hợp lệ; quyền xét theo vai trò HIỆN TẠI trong CSDL (admin/thủ quỹ/thành viên).
 *  - Mật khẩu lưu dạng băm lặp có muối ($kdf1$) và KHÔNG BAO GIỜ được trả về; SĐT/email/ảnh biên lai
 *    chỉ trả cho Ban quản trị hoặc chính chủ. Mật khẩu yếu (admin, 123456, SĐT...) bị buộc đổi khi đăng nhập.
 *  - Quên mật khẩu admin: chạy hàm datLaiMatKhauAdmin() trong trình soạn thảo Apps Script.
 *
 * Hướng dẫn triển khai:
 * 1. Mở Google Sheet -> Tiện ích mở rộng -> Apps Script.
 * 2. Dán toàn bộ nội dung google_apps_script_prod.js vào Code.gs (thay thế mã cũ).
 * 3. "Triển khai" -> "Quản lý triển khai" -> Sửa -> Phiên bản mới (giữ nguyên URL).
 * 4. Quyền truy cập: "Bất kỳ ai" (Anyone).
 */

var SHEET_PROD = "CSDL_VanHanh_Prod";
var SHEET_TEST = "CSDL_KiemThu_Test";
var CHUNK_SIZE = 40000;     // v1: kích thước mảnh JSON
var CELL_LIMIT = 45000;     // v2: tối đa ký tự mỗi ô (giới hạn Google Sheets là 50.000)
var LOG_MAX_ROWS = 5000;
var CACHE_TTL = 21600;      // 6 giờ

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function resolveSheetName(param) {
  return (String(param || "Prod").toLowerCase().indexOf("test") !== -1) ? SHEET_TEST : SHEET_PROD;
}

// ======================================================================
// v1 (JSON nguyên khối) - chỉ dùng để đọc khi chuyển dữ liệu sang v2
// ======================================================================
function readMetaV1(sheet) {
  var meta = sheet.getRange(2, 2, 1, 3).getValues()[0];
  return { revision: Number(meta[1]) || 0, chunkCount: Number(meta[2]) || 1 };
}

function readJsonV1(sheet, chunkCount) {
  var values = sheet.getRange(2, 1, chunkCount, 1).getValues();
  return values.map(function (r) { return r[0] ? r[0].toString() : ""; }).join("");
}

// ======================================================================
// v2: kho bản ghi theo dòng
// ======================================================================
function recordsSheet(env) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = env + "_v2";
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange("A:Z").setNumberFormat("@"); // Lưu dạng văn bản, tránh Sheets tự đổi sang số/ngày
    sheet.getRange(1, 1, 1, 4).setValues([["COL", "KEY", "SEQ", "JSON"]]);
    sheet.getRange(1, 1, 1, 4).setFontWeight("bold").setBackground("#4f46e5").setFontColor("#ffffff");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function logSheet(env) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = env + "_v2_log";
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, 6).setValues([["THOI_GIAN", "SEQ", "THIET_BI", "SO_OP", "SO_BAN_GHI_DOI", "OP_IDS"]]);
    sheet.getRange(1, 1, 1, 6).setFontWeight("bold");
  }
  return sheet;
}

function readStore(sheet) {
  var store = { records: {}, rows: {}, width: Math.max(sheet.getLastColumn(), 4), lastRow: sheet.getLastRow() };
  if (store.lastRow < 2) return store;
  var values = sheet.getRange(2, 1, store.lastRow - 1, store.width).getValues();
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (row[0] === "" || row[0] === null) continue;
    var json = "";
    for (var j = 3; j < row.length && row[j] !== ""; j++) json += String(row[j]);
    var rec;
    try { rec = JSON.parse(json); } catch (e) { continue; } // Dòng hỏng: bỏ qua, không làm sập toàn bộ
    rec.s = Number(row[2]) || 0;
    var rk = SyncCore.recKey(String(row[0]), String(row[1]));
    store.records[rk] = rec;
    store.rows[rk] = i + 2;
  }
  return store;
}

function rowValues(rk, rec) {
  var ck = SyncCore.splitRecKey(rk);
  var json = JSON.stringify({ d: rec.d, f: rec.f, x: rec.x || "", c: rec.c || "" });
  var vals = [ck.col, ck.key, String(rec.s)];
  for (var i = 0; i < json.length; i += CELL_LIMIT) vals.push(json.substring(i, i + CELL_LIMIT));
  return vals;
}

function writeRecords(sheet, store, changedKeys) {
  var appends = [];
  var width = store.width;
  var rowsByKey = changedKeys.map(function (rk) {
    var vals = rowValues(rk, store.records[rk]);
    if (vals.length > width) width = vals.length;
    return { rk: rk, vals: vals };
  });
  if (width > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  rowsByKey.forEach(function (item) {
    var vals = item.vals;
    while (vals.length < width) vals.push(""); // Xóa phần thừa của JSON cũ dài hơn
    var row = store.rows[item.rk];
    if (row) {
      var range = sheet.getRange(row, 1, 1, width);
      range.setNumberFormat("@");
      range.setValues([vals]);
    } else {
      appends.push(vals);
    }
  });
  if (appends.length) {
    var start = Math.max(store.lastRow, 1) + 1;
    var range = sheet.getRange(start, 1, appends.length, width);
    range.setNumberFormat("@");
    range.setValues(appends);
    appends.forEach(function (vals, i) { store.rows[SyncCore.recKey(vals[0], vals[1])] = start + i; });
    store.lastRow = start + appends.length - 1;
  }
  store.width = width;
}

// ---------------- SEQ (lưu trong ScriptProperties, đệm bằng CacheService cho lệnh đọc nhanh) ----------------
function getSeq(env, authoritative) {
  var cache = CacheService.getScriptCache();
  if (!authoritative) {
    var c = cache.get("v2seq:" + env);
    if (c !== null) return Number(c) || 0;
  }
  var n = Number(PropertiesService.getScriptProperties().getProperty("v2seq:" + env)) || 0;
  cache.put("v2seq:" + env, String(n), CACHE_TTL);
  return n;
}

function setSeq(env, n) {
  PropertiesService.getScriptProperties().setProperty("v2seq:" + env, String(n));
  CacheService.getScriptCache().put("v2seq:" + env, String(n), CACHE_TTL);
}


// ======================================================================
// Trạng thái kho trong 1 request (đọc 1 lần, ghi các dòng thay đổi)
// ======================================================================
function loadState(env) {
  var sheet = recordsSheet(env);
  return { env: env, sheet: sheet, store: readStore(sheet), seq: getSeq(env, true), changed: {} };
}

function applyToState(state, ops) {
  SyncCore.applyOps(state.store.records, ops, SyncCore.makeClamp(Date.now()))
    .forEach(function (rk) { state.changed[rk] = true; });
}

// Ghi các bản ghi thay đổi, tăng SEQ. Gọi khi đang giữ khóa.
function persistState(state, deviceId, logOps) {
  var keys = Object.keys(state.changed);
  if (keys.length) {
    state.seq++;
    keys.forEach(function (rk) { state.store.records[rk].s = state.seq; });
    writeRecords(state.sheet, state.store, keys);
    SpreadsheetApp.flush();
    setSeq(state.env, state.seq); // Đặt SEQ SAU khi các dòng đã ghi xong -> lệnh đọc không bỏ sót
    state.changed = {};
  }
  if (logOps) appendLog(state.env, state.seq, deviceId, logOps, keys.length);
}

// Op do máy chủ tạo (đăng ký, đổi mật khẩu...): HLC luôn mới hơn bản ghi hiện có
function serverOp(state, col, key, t, set, unset) {
  var clock = SyncCore.createClock("server");
  var rec = state.store.records[SyncCore.recKey(col, key)];
  if (rec) clock.observe(SyncCore.recordHlcMax(rec));
  var h = clock.now();
  var op = { col: col, key: key, t: t, h: h, c: h, set: set || {} };
  if (unset) op.unset = unset;
  applyToState(state, [op]);
}

// ---------------- Chuyển dữ liệu v1 -> v2 & nâng cấp mật khẩu (không xóa sheet cũ) ----------------
// Nguyên tắc an toàn:
//  - Chỉ NHẬP dữ liệu v1 khi kho v2 chưa có bản ghi nào (không bao giờ ghi đè dữ liệu v2 đang dùng).
//  - Không dựa vào cờ "đã chuyển": kho v2 còn trống thì mỗi lần truy cập đều thử nhập lại.
//  - Tìm sheet v1 theo tên chuẩn, nếu không có thì theo tiêu đề DATA_JSON; đọc JSON từ các ô liên tiếp
//    (không tin ô D2 ghi số mảnh). Sheet v1 không bao giờ bị sửa/xóa.
function isMigrated(env) {
  var props = PropertiesService.getScriptProperties();
  return !!props.getProperty("v2migrated:" + env) && !!props.getProperty("v2auth:" + env) && getSeq(env, false) > 0;
}

function liveRecordCount(store) {
  var n = 0;
  Object.keys(store.records).forEach(function (rk) { if (SyncCore.isLive(store.records[rk])) n++; });
  return n;
}

// Đọc ảnh chụp CSDL v1 từ một sheet: tìm ô bắt đầu bằng "{" rồi ghép các ô liên tiếp phía dưới cùng cột
function readSnapshotFromSheet(sheet) {
  var lastRow = sheet.getLastRow(), lastCol = Math.min(sheet.getLastColumn(), 10);
  if (lastRow < 1 || lastCol < 1) return null;
  var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  for (var c = 0; c < lastCol; c++) {
    for (var r = 0; r < lastRow; r++) {
      var cell = values[r][c];
      if (typeof cell !== "string" || cell.charAt(0) !== "{") continue;
      var json = "";
      for (var k = r; k < lastRow && values[k][c] !== "" && values[k][c] !== null; k++) {
        json += String(values[k][c]);
        try {
          var obj = JSON.parse(json);
          if (obj && typeof obj === "object" && (obj.users || obj.members || obj.sessions || obj.clubInfo)) {
            return { snap: obj, chars: json.length, cell: String.fromCharCode(65 + c) + (r + 1), cells: k - r + 1 };
          }
        } catch (e) { /* chưa đủ mảnh, ghép tiếp */ }
      }
    }
  }
  return null;
}

// Tìm dữ liệu v1 cho môi trường (Prod không bao giờ lấy sheet Test và ngược lại)
function findV1Snapshot(env) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var exact = ss.getSheetByName(env);
  var wantTest = env === SHEET_TEST;
  var candidates = exact ? [exact] : [];
  (ss.getSheets ? ss.getSheets() : []).forEach(function (sh) {
    var name = sh.getName();
    if (sh === exact || /_v2(_log)?$/.test(name)) return;
    if (/test|kiemthu/i.test(name) !== wantTest) return;
    var a1 = sh.getLastRow() >= 1 ? String(sh.getRange(1, 1, 1, 1).getValues()[0][0]) : "";
    if (a1 === "DATA_JSON") candidates.push(sh);
  });
  for (var i = 0; i < candidates.length; i++) {
    var found = readSnapshotFromSheet(candidates[i]);
    if (found) {
      found.sheet = candidates[i].getName();
      return found;
    }
  }
  return null;
}

function ensureMigrated(env) {
  if (isMigrated(env)) return;
  var props = PropertiesService.getScriptProperties();
  var state = loadState(env);
  var imported = null;
  if (liveRecordCount(state.store) === 0) {
    imported = findV1Snapshot(env);
    if (imported) applyToState(state, SyncCore.legacySnapshotToOps(imported.snap, "migr"));
  }
  // Bọc mọi mật khẩu cũ (thô / sha256 không muối) bằng băm lặp có muối - không cần biết mật khẩu gốc
  Object.keys(state.store.records).forEach(function (rk) {
    var ck = SyncCore.splitRecKey(rk);
    var rec = state.store.records[rk];
    if (ck.col !== "users" || !rec.d.password || AuthCore.isKdf(rec.d.password)) return;
    rec.d.password = AuthCore.wrapLegacy(rec.d.password, ck.key);
    state.changed[rk] = true;
  });
  persistState(state, "migration", imported ? [{ id: "import:" + imported.sheet }] : null);
  // Chỉ coi là xong khi kho v2 đã có dữ liệu (CSDL mới hoàn toàn thì tiếp tục kiểm tra, chi phí nhỏ)
  if (liveRecordCount(state.store) > 0) {
    props.setProperty("v2migrated:" + env, String(Date.now()));
    props.setProperty("v2auth:" + env, String(Date.now()));
  }
}

// Chạy THỦ CÔNG trong trình soạn thảo Apps Script: CHỈ ĐỌC, ghi kết quả vào nhật ký (Ctrl+Enter để xem).
// Không in nội dung dữ liệu, chỉ in tên sheet, số dòng, số bản ghi.
function kiemTraDuLieu() {
  var env = SHEET_PROD;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var props = PropertiesService.getScriptProperties();
  var report = { sheets: [], flags: {}, v1: null, v2: { rows: 0 } };
  (ss.getSheets ? ss.getSheets() : []).forEach(function (sh) {
    report.sheets.push({ name: sh.getName(), rows: sh.getLastRow(), cols: sh.getLastColumn() });
  });
  ["v2migrated:", "v2auth:", "v2seq:"].forEach(function (k) { report.flags[k + env] = props.getProperty(k + env); });
  var found = findV1Snapshot(env);
  if (found) {
    var counts = {};
    SyncCore.COLLECTIONS.forEach(function (col) { counts[col] = Array.isArray(found.snap[col]) ? found.snap[col].length : 0; });
    var odd = Object.keys(found.snap).filter(function (k) { return ["v", "action", "username", "password", "ops", "auth", "token", "oldPassword", "newPassword"].indexOf(k) !== -1; });
    report.v1 = { sheet: found.sheet, cell: found.cell, cells: found.cells, chars: found.chars, counts: counts, unexpectedKeys: odd };
  }
  var v2 = ss.getSheetByName(env + "_v2");
  if (v2) {
    var store = readStore(v2);
    report.v2 = { rows: Math.max(v2.getLastRow() - 1, 0), parsed: Object.keys(store.records).length, live: liveRecordCount(store) };
  }
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

// Chạy THỦ CÔNG khi muốn nhập lại dữ liệu từ sheet v1 vào kho v2 (hợp nhất theo từng trường, không xóa gì).
// tenSheet: để trống = tự tìm. Dùng khi kho v2 đã có một ít dữ liệu mới nhưng thiếu dữ liệu cũ.
function khoiPhucTuSheetV1(tenSheet) {
  var env = SHEET_PROD;
  var result = withLock(function () {
    var found = null;
    if (tenSheet) {
      var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tenSheet);
      found = sh ? readSnapshotFromSheet(sh) : null;
      if (found) found.sheet = tenSheet;
    } else {
      found = findV1Snapshot(env);
    }
    if (!found) throw new Error("Không tìm thấy dữ liệu v1 hợp lệ" + (tenSheet ? " trong sheet " + tenSheet : ""));
    var state = loadState(env);
    applyToState(state, SyncCore.legacySnapshotToOps(found.snap, "restore"));
    Object.keys(state.store.records).forEach(function (rk) {
      var ck = SyncCore.splitRecKey(rk);
      var rec = state.store.records[rk];
      if (ck.col === "users" && rec.d.password && !AuthCore.isKdf(rec.d.password)) {
        rec.d.password = AuthCore.wrapLegacy(rec.d.password, ck.key);
        state.changed[rk] = true;
      }
    });
    var changed = Object.keys(state.changed).length;
    persistState(state, "restore", [{ id: "restore:" + found.sheet }]);
    return { sheet: found.sheet, changed: changed, seq: state.seq };
  });
  Logger.log("Đã nhập lại dữ liệu từ sheet " + result.sheet + ": " + result.changed + " bản ghi thay đổi (seq " + result.seq + ").");
  return result;
}

function withLock(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error("Máy chủ đang bận, vui lòng thử lại.");
  try { return fn(); } finally { lock.releaseLock(); }
}

// ======================================================================
// XÁC THỰC & PHÂN QUYỀN (máy chủ là nơi duy nhất kiểm tra mật khẩu và quyền ghi)
// ======================================================================
var TOKEN_TTL = 30 * 24 * 60 * 60 * 1000;
var LOGIN_MAX_FAILS = 5;
var LOGIN_LOCK_SECONDS = 900;
var REGISTER_MAX_PER_HOUR = 30;
var STAFF_ROLES = { admin: true, treasurer: true };
var SECRET_USER_FIELDS = ["password", "pwv"];
var CONTACT_FIELDS = ["phone", "email"];
var PROFILE_FIELDS = { name: true, phone: true, email: true, avatar: true, note: true, themePreference: true };
// Trường thành viên tự sửa được trên tài khoản của mình (ngoài hồ sơ): gửi / hủy yêu cầu làm thành viên cố định
var SELF_USER_FIELDS = { fixedRequest: true, fixedRequestAt: true };

function authSecret() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty("authSecret");
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty("authSecret", secret);
  }
  return secret;
}

function liveUser(state, username) {
  if (!username) return null;
  var rec = state.store.records[SyncCore.recKey("users", String(username))];
  if (!rec || !SyncCore.isLive(rec)) return null;
  return { rec: rec, obj: SyncCore.decode("users", rec.d) };
}

function findLoginUser(state, input) {
  var lower = String(input || "").trim().toLowerCase();
  var digits = lower.replace(/\D/g, "");
  if (!lower) return null;
  var found = null;
  Object.keys(state.store.records).forEach(function (rk) {
    if (found) return;
    var ck = SyncCore.splitRecKey(rk);
    if (ck.col !== "users") return;
    var rec = state.store.records[rk];
    if (!SyncCore.isLive(rec)) return;
    var u = SyncCore.decode("users", rec.d);
    var phone = String(u.phone || "").replace(/\D/g, "");
    if (String(u.username || "").toLowerCase() === lower || (digits.length >= 9 && digits === lower && phone === digits)) {
      found = { rec: rec, obj: u };
    }
  });
  return found;
}

function publicUser(u) {
  var copy = {};
  Object.keys(u).forEach(function (k) { if (SECRET_USER_FIELDS.indexOf(k) === -1) copy[k] = u[k]; });
  return copy;
}

function issueToken(user, mustChange) {
  return AuthCore.signToken({ u: user.username, pv: Number(user.pwv) || 0, exp: Date.now() + TOKEN_TTL, mc: mustChange ? 1 : 0 }, authSecret());
}

// Token -> danh tính. Vai trò luôn đọc từ CSDL hiện tại (hạ quyền / xóa tài khoản có hiệu lực ngay).
// Đổi mật khẩu (pwv tăng) làm mọi token cũ mất hiệu lực.
function identityFromToken(state, token) {
  if (!token) return null;
  var p = AuthCore.verifyToken(token, authSecret(), Date.now());
  if (!p) return null;
  var u = liveUser(state, p.u);
  if (!u || (Number(u.obj.pwv) || 0) !== (Number(p.pv) || 0)) return null;
  var staff = !!STAFF_ROLES[u.obj.role];
  return {
    username: u.obj.username, userId: u.obj.id, memberId: u.obj.memberId, role: u.obj.role, type: u.obj.type,
    staff: staff, admin: u.obj.role === "admin", mustChange: !!p.mc,
    finance: staff || u.obj.type === "fixed" // Quyền xem sổ quỹ (giống canViewFinance ở giao diện)
  };
}

function clubInfo(state) {
  var rec = state.store.records[SyncCore.recKey(SyncCore.CLUB_COL, SyncCore.CLUB_KEY)];
  return rec && SyncCore.isLive(rec) ? SyncCore.decode(SyncCore.CLUB_COL, rec.d) : {};
}

function clubFee(club) {
  return Number(club.monthlyFee || club.monthlyFundFee) || 20000;
}

function opPaths(op) {
  return Object.keys(op.set || {}).concat(op.unset || []).concat(Object.keys(op.fill || {}));
}

// Kiểm tra (và chuẩn hóa) 1 op. Trả về null nếu hợp lệ, "auth" nếu cần đăng nhập, hoặc lý do từ chối.
function authorizeOp(state, op, who, club) {
  if (!who || who.mustChange) return "auth";
  if (op.t === "reset") return who.admin ? null : "forbidden";
  if (SyncCore.COLLECTIONS.indexOf(op.col) === -1 && op.col !== SyncCore.CLUB_COL) return "forbidden";
  var rec = state.store.records[SyncCore.recKey(op.col, String(op.key))];
  var live = !!rec && SyncCore.isLive(rec);
  var cur = live ? SyncCore.decode(op.col, rec.d) : null;
  var paths = opPaths(op);

  if (op.col === "users") {
    if (paths.indexOf("pwv") !== -1) return "forbidden";
    if (paths.indexOf("password") !== -1) {
      // Chỉ Ban quản trị đặt mật khẩu qua dữ liệu (thêm/sửa thành viên); mật khẩu luôn được băm lại trên máy chủ
      if (!who.staff || (op.unset || []).indexOf("password") !== -1) return "forbidden";
      if (cur && cur.role === "admin" && !who.admin) return "forbidden";
      ["set", "fill"].forEach(function (k) {
        if (op[k] && op[k].password !== undefined) op[k].password = AuthCore.protect(op[k].password, op.key);
      });
      op.set = op.set || {};
      op.set.pwv = (cur && Number(cur.pwv) || 0) + 1;
    }
    // "put" lên tài khoản đang có: không được vô tình xóa mật khẩu
    if (op.t === "put" && live) {
      op.t = "patch";
      op.unset = Object.keys(rec.d).filter(function (p) { return !(p in op.set) && SECRET_USER_FIELDS.indexOf(p) === -1; });
    }
  }

  if (who.staff) {
    if (op.col === "users" || op.col === "members") {
      var newRole = (op.set && op.set.role) || (op.fill && op.fill.role);
      if (!who.admin && ((cur && cur.role === "admin") || newRole === "admin")) return "forbidden";
    }
    return null;
  }
  return authorizeMemberOp(state, op, who, rec, live, cur, club);
}

// ---------------- Kiểm tra định dạng dữ liệu do thành viên gửi lên ----------------
var SAFE_ID = /^[A-Za-z0-9_.:\-]{1,100}$/;
var VOTE_STATUS = { going: 1, not_going: 1, maybe: 1, poll: 1 };

function isStr(v, max) { return typeof v === "string" && v.length <= max; }
function isOptStr(v, max) { return v === undefined || v === null || isStr(v, max); }
function isSafeUrl(v, maxLen) {
  if (v === undefined || v === null || v === "") return true;
  if (typeof v !== "string" || v.length > maxLen) return false;
  return /^https:\/\/[^\s"'<>]+$/i.test(v) || /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+\/=]+$/.test(v);
}
function onlyKeys(obj, allowed) {
  return Object.keys(obj).every(function (k) { return allowed.indexOf(k) !== -1; });
}
function isIdList(v) {
  return v === undefined || (Array.isArray(v) && v.length <= 30 && v.every(function (x) { return typeof x === "string" && SAFE_ID.test(x); }));
}

var PROFILE_CHECKS = {
  name: function (v) { return isStr(v, 100) && v.trim().length >= 2; },
  phone: function (v) { return v === "" || (typeof v === "string" && /^[0-9+ .\-]{0,20}$/.test(v)); },
  email: function (v) { return v === "" || (isStr(v, 120) && /^[^\s@<>"']+@[^\s@<>"']+$/.test(v)); },
  avatar: function (v) { return isSafeUrl(v, 300000); },
  note: function (v) { return isOptStr(v, 500); },
  themePreference: function (v) { return v === "light" || v === "dark"; }
};

function validVote(v, memberId) {
  return !!v && typeof v === "object" && v.memberId === memberId &&
    onlyKeys(v, ["memberId", "status", "guests", "note", "votedAt", "selectedOptions", "notGoing"]) &&
    (v.status === undefined || !!VOTE_STATUS[v.status]) &&
    (v.guests === undefined || (typeof v.guests === "number" && v.guests >= 0 && v.guests <= 20)) &&
    isOptStr(v.note, 300) && isOptStr(v.votedAt, 30) && isIdList(v.selectedOptions) &&
    (v.notGoing === undefined || typeof v.notGoing === "boolean");
}

function validHistory(h, memberId) {
  return !!h && typeof h === "object" && h.memberId === memberId &&
    onlyKeys(h, ["id", "memberId", "memberName", "avatar", "status", "actionText", "guests", "note", "votedAt", "selectedOptions"]) &&
    (h.id === undefined || (typeof h.id === "string" && SAFE_ID.test(h.id))) &&
    isOptStr(h.memberName, 100) && isSafeUrl(h.avatar, 300000) && (h.status === undefined || !!VOTE_STATUS[h.status]) &&
    isOptStr(h.actionText, 200) && isOptStr(h.note, 300) && isOptStr(h.votedAt, 30) && isIdList(h.selectedOptions) &&
    (h.guests === undefined || (typeof h.guests === "number" && h.guests >= 0 && h.guests <= 20));
}

function sessionStartMs(session) {
  var d = String(session.date || "").trim(), t = String(session.startTime || "18:00").trim();
  if (d.indexOf("/") !== -1) {
    var parts = d.split("/");
    if (parts.length === 3) d = parts[2] + "-" + ("0" + parts[1]).slice(-2) + "-" + ("0" + parts[0]).slice(-2);
  }
  if (t.length === 5) t += ":00";
  return new Date(d + "T" + t + "+07:00").getTime(); // Giờ Việt Nam
}

// "YYYY-MM-DDTHH:mm" theo giờ Việt Nam -> ms (NaN nếu trống/sai)
function parseVnDateTime(str) {
  var m = String(str || "").trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  return m ? new Date(m[1] + "T" + m[2] + ":00+07:00").getTime() : NaN;
}

// Khóa bình chọn giống giao diện: đã chốt/hủy/diễn ra, hoặc còn dưới voteLockHours trước giờ đánh
var VOTE_LOCK_GRACE_MS = 2 * 60 * 1000;
function isVoteLocked(session, club) {
  if (!session) return true;
  if (session.status === "completed" || session.status === "cancelled" || session.status === "locked") return true;
  // Hẹn giờ mở bình chọn: chưa tới giờ thì chưa nhận phiếu
  var openAt = parseVnDateTime(session.voteOpenAt);
  if (!isNaN(openAt) && Date.now() < openAt - VOTE_LOCK_GRACE_MS) return true;
  var start = sessionStartMs(session);
  if (isNaN(start)) return false; // Không xác định được giờ: giao diện cũng không khóa
  var hours = Number(club.voteLockHours) || 48;
  return Date.now() > start - hours * 3600 * 1000 + VOTE_LOCK_GRACE_MS;
}

function mergeObjects(list) {
  var out = {};
  list.forEach(function (o) { Object.keys(o || {}).forEach(function (k) { out[k] = o[k]; }); });
  return out;
}

function authorizeMemberOp(state, op, who, rec, live, cur, club) {
  var set = op.set || {}, unset = op.unset || [], fill = op.fill || {};
  var setKeys = Object.keys(set), fillKeys = Object.keys(fill);
  if (op.t === "del") return "forbidden";

  if (op.col === "users" || op.col === "members") {
    var mine = op.col === "users" ? op.key === who.username : op.key === who.memberId;
    if (!mine || !live || op.t !== "patch" || fillKeys.length) return "forbidden";
    var allowedField = function (p) { return PROFILE_FIELDS[p] || (op.col === "users" && SELF_USER_FIELDS[p]); };
    if (setKeys.concat(unset).some(function (p) { return !allowedField(p); })) return "forbidden";
    if (unset.indexOf("name") !== -1) return "invalid";
    if (setKeys.some(function (p) { return PROFILE_FIELDS[p] && !PROFILE_CHECKS[p](set[p]); })) return "invalid";
    if ("fixedRequest" in set) {
      // Chỉ được chuyển sang "chờ duyệt" (khi chưa là cố định) hoặc tự hủy yêu cầu; KHÔNG tự duyệt
      if (!(set.fixedRequest === "pending" || set.fixedRequest === "cancelled")) return "invalid";
      if (set.fixedRequest === "pending" && cur && cur.type === "fixed") return "invalid";
    }
    if ("fixedRequestAt" in set && !isOptStr(set.fixedRequestAt, 40)) return "invalid";
    return null;
  }

  if (op.col === "sessions") {
    if (!live || op.t !== "patch" || fillKeys.length) return "forbidden";
    if (isVoteLocked(cur, club)) return "vote_locked";
    var myKeys = [who.memberId, who.userId, who.username];
    var me = state.store.records[SyncCore.recKey("members", String(who.memberId))];
    var meObj = me && SyncCore.isLive(me) ? SyncCore.decode("members", me.d) : {};
    for (var i = 0; i < setKeys.length; i++) {
      var p = setKeys[i], v = set[p];
      if (p === "votes#" || p === "voteHistory#") {
        var okOrder = Array.isArray(v) && v.length <= 500 && v.every(function (x) { return typeof x === "string" && x.length <= 300; });
        if (!okOrder) return "invalid";
        continue;
      }
      if (p.indexOf("votes#") === 0) {
        if (p.slice(6) !== who.memberId) return "forbidden";
        if (!validVote(v, who.memberId)) return "invalid";
      } else if (p.indexOf("voteHistory#") === 0) {
        if (p in rec.f || !SAFE_ID.test(p.slice(12))) return "forbidden"; // Lịch sử chỉ được thêm, không sửa
        if (!validHistory(v, who.memberId)) return "invalid";
        // Tên/ảnh trong lịch sử lấy từ hồ sơ trên máy chủ (không cho mạo danh)
        v.memberName = meObj.name || v.memberName || "";
        v.avatar = meObj.avatar || "";
      } else {
        return "forbidden";
      }
    }
    for (var j = 0; j < unset.length; j++) {
      if (unset[j].indexOf("votes#") !== 0 || myKeys.indexOf(unset[j].slice(6)) === -1) return "forbidden";
    }
    return null;
  }

  if (op.col === "monthlyContributions") {
    var due = mergeObjects([cur, fill, set]);
    if (due.memberId !== who.memberId || (cur && cur.memberId !== who.memberId)) return "forbidden";
    if (op.t === "put" && live) return "forbidden";
    if (!live && !(/^\d{4}-\d{2}$/.test(String(due.month)) && op.key === "due_" + due.month + "_" + who.memberId && due.id === op.key)) return "invalid";
    if (!isOptStr(due.note, 300) || !isOptStr(due.method, 100) || !isOptStr(due.paidAt, 30) || !isSafeUrl(due.billImage, 1500000)) return "invalid";
    var auto = club.autoApprove === true;
    var allowed = { status: 1, paidAt: 1, method: 1, billImage: 1, note: 1 };
    if (auto) { allowed.approvedBy = 1; allowed.approvedAt = 1; }
    if (!live) { allowed.id = 1; allowed.month = 1; allowed.memberId = 1; allowed.amount = 1; }
    var keys = setKeys.concat(unset);
    for (var k = 0; k < keys.length; k++) if (!allowed[keys[k]]) return "forbidden";
    if (!live) {
      // Trường nền (fill) ngoài danh sách chỉ được là giá trị rỗng
      for (var f = 0; f < fillKeys.length; f++) {
        if (!allowed[fillKeys[f]] && fill[fillKeys[f]] !== null && fill[fillKeys[f]] !== "") return "forbidden";
      }
      if (Number(due.amount) !== clubFee(club)) return "forbidden";
    }
    if (due.status !== (cur && cur.status) && !(due.status === "pending" || (auto && due.status === "paid"))) return "forbidden";
    return null;
  }

  if (op.col === "transactions") {
    // Chỉ khi CLB bật tự động duyệt: thành viên tạo phiếu thu quỹ của chính mình
    if (club.autoApprove !== true || unset.length) return "forbidden";
    var tx = mergeObjects([cur, fill, set]);
    if (!SAFE_ID.test(String(op.key)) || tx.id !== op.key ||
      !onlyKeys(tx, ["id", "dueId", "date", "type", "category", "title", "amount", "createdBy", "note"]) ||
      !isOptStr(tx.title, 200) || !isOptStr(tx.note, 300) || !isOptStr(tx.category, 50) || !isOptStr(tx.createdBy, 100) || !isOptStr(tx.date, 30)) return "invalid";
    var dueRec = tx.dueId ? state.store.records[SyncCore.recKey("monthlyContributions", String(tx.dueId))] : null;
    var dueObj = dueRec && SyncCore.isLive(dueRec) ? SyncCore.decode("monthlyContributions", dueRec.d) : null;
    var owner = dueObj ? dueObj.memberId : String(tx.dueId || "").split("_").slice(2).join("_");
    var amount = dueObj ? Number(dueObj.amount) : clubFee(club);
    if (!tx.dueId || owner !== who.memberId || tx.type !== "income" || Number(tx.amount) !== amount) return "forbidden";
    return null;
  }

  return "forbidden"; // club, inventory: chỉ Ban quản trị
}

// Áp các op hợp lệ theo thứ tự. Trả về id đã xử lý / bị từ chối / chờ đăng nhập.
function processOps(state, ops, auth, deviceId) {
  var identities = {};
  Object.keys(auth || {}).forEach(function (u) {
    var who = identityFromToken(state, auth[u]);
    if (who && who.username === u) identities[u] = who;
  });
  var club = clubInfo(state);
  var res = { acked: [], rejected: [], deferred: [] };
  (ops || []).forEach(function (op) {
    if (!op) return;
    var who = identities[op.u] || null;
    var reason = null, toApply = [op];
    if (op.t === "legacy") {
      if (!who || who.mustChange) reason = "auth";
      else if (!who.staff) reason = "forbidden";
      else {
        // Ảnh chụp v1 chưa gửi: KHÔNG cho đặt mật khẩu/quyền từ dữ liệu cũ
        toApply = SyncCore.legacySnapshotToOps(op.snap, "legacy-" + String(deviceId || "").slice(0, 12), Date.now());
        toApply.forEach(function (o) {
          if (o.col === "users" && o.set) SECRET_USER_FIELDS.concat(["role"]).forEach(function (p) { delete o.set[p]; });
        });
        toApply = toApply.filter(function (o) { return !authorizeOp(state, o, who, club); });
      }
    } else {
      reason = authorizeOp(state, op, who, club);
    }
    if (reason === "auth") { res.deferred.push(op.id); return; }
    if (reason) { res.rejected.push({ id: op.id, reason: reason }); return; }
    applyToState(state, toApply);
    if (op.id) res.acked.push(op.id);
  });
  return res;
}

// ---------------- Lọc dữ liệu trả về theo người xem ----------------
// - Mật khẩu KHÔNG BAO GIỜ rời máy chủ.
// - Khách (chưa đăng nhập): chỉ xem lịch đánh. Không có tên/thông tin thành viên, không có sổ thu chi/quỹ tháng.
// - Thành viên: thấy danh sách thành viên; SĐT/email/ảnh biên lai chỉ của chính mình.
//   Sổ thu chi & quỹ tháng chỉ cho thành viên cố định và Ban quản trị.
// - Ban quản trị: đầy đủ (trừ mật khẩu).
var FINANCE_COLS = { transactions: true, monthlyContributions: true };
var GUEST_MEMBER_FIELDS = { id: true, type: true };
var GUEST_VOTE_FIELDS = ["memberId", "status", "guests", "notGoing", "selectedOptions"];
var GUEST_HIDDEN_SESSION_FIELDS = { billSplit: true, timeChangeHistory: true, notices: true, mailed: true };

function viewerScope(viewer) {
  if (!viewer) return "guest";
  if (viewer.staff) return "staff";
  return viewer.finance ? "fixed" : "member";
}

// Trả về bản ghi đã lọc, hoặc null nếu người xem không được thấy bản ghi này
function filterRecord(col, key, rec, viewer) {
  var scope = viewerScope(viewer);
  if (FINANCE_COLS[col] && scope !== "staff" && scope !== "fixed") return null;
  if (col === "users" && scope === "guest") return null;
  if (col !== "users" && col !== "members" && col !== "monthlyContributions" && !(col === "sessions" && scope === "guest")) return rec;

  var copy = { d: {}, f: {}, x: rec.x, c: rec.c, s: rec.s };
  Object.keys(rec.d).forEach(function (p) { copy.d[p] = rec.d[p]; });
  Object.keys(rec.f).forEach(function (p) { copy.f[p] = rec.f[p]; });
  var drop = function (p) { delete copy.d[p]; delete copy.f[p]; };

  if (col === "users") SECRET_USER_FIELDS.forEach(drop);
  if (scope === "staff") return copy;

  if (col === "members" && scope === "guest") {
    Object.keys(copy.f).forEach(function (p) { if (!GUEST_MEMBER_FIELDS[p]) drop(p); });
    return copy;
  }
  if (col === "sessions") { // chỉ còn trường hợp khách
    Object.keys(copy.f).forEach(function (p) {
      var field = p.split("#")[0];
      if (field === "voteHistory" || GUEST_HIDDEN_SESSION_FIELDS[field]) { drop(p); return; }
      if (p.indexOf("votes#") === 0 && p !== "votes#" && copy.d[p] && typeof copy.d[p] === "object") {
        var v = {};
        GUEST_VOTE_FIELDS.forEach(function (k) { if (copy.d[p][k] !== undefined) v[k] = copy.d[p][k]; });
        copy.d[p] = v;
      }
    });
    return copy;
  }
  if (col === "users" && key !== viewer.username) { CONTACT_FIELDS.forEach(drop); drop("mailed"); }
  if (col === "members" && key !== viewer.memberId) CONTACT_FIELDS.forEach(drop);
  if (col === "monthlyContributions" && rec.d.memberId !== viewer.memberId) drop("billImage");
  return copy;
}

function deltaPayload(state, since, viewer) {
  var out = [];
  Object.keys(state.store.records).forEach(function (rk) {
    var rec = state.store.records[rk];
    if (rec.s > since) {
      var ck = SyncCore.splitRecKey(rk);
      var r = filterRecord(ck.col, ck.key, rec, viewer);
      if (r) out.push({ col: ck.col, key: ck.key, r: r });
    }
  });
  return {
    status: "ok", seq: state.seq, serverTime: Date.now(), full: since === 0, records: out,
    viewer: viewer ? viewer.username : null, scope: viewerScope(viewer)
  };
}

function legacySnapshotFor(state) {
  var records = {};
  Object.keys(state.store.records).forEach(function (rk) {
    var ck = SyncCore.splitRecKey(rk);
    var r = filterRecord(ck.col, ck.key, state.store.records[rk], null);
    if (r) records[rk] = r;
  });
  var snap = SyncCore.toLegacySnapshot(records);
  snap.revision = state.seq;
  snap.lastModified = Date.now();
  snap.sheetName = state.env;
  return snap;
}

function appendLog(env, seq, deviceId, ops, changedCount) {
  try {
    var sheet = logSheet(env);
    var ids = (ops || []).map(function (o) { return o.id || o.t; }).slice(0, 30).join(",");
    sheet.appendRow([Utilities.formatDate(new Date(), "GMT+7", "dd/MM/yyyy HH:mm:ss"), seq, String(deviceId || "?"), (ops || []).length, changedCount, ids]);
    if (sheet.getLastRow() > LOG_MAX_ROWS + 500) sheet.deleteRows(2, 500);
  } catch (e) {}
}

// ---------------- Các lệnh xác thực ----------------
function passwordPolicyError(pwd) {
  var p = String(pwd || "");
  if (p.trim().length < 6) return "Mật khẩu phải có tối thiểu 6 ký tự!";
  if (/\s/.test(p)) return "Mật khẩu không được chứa khoảng trắng!";
  if (p.length > 128) return "Mật khẩu quá dài!";
  return null;
}

function setPassword(state, user, plain) {
  serverOp(state, "users", user.username, "patch", {
    password: AuthCore.protect(AuthCore.canonical(plain), user.username),
    pwv: (Number(user.pwv) || 0) + 1
  });
}

function actionLogin(state, body) {
  var input = String(body.username || "").trim().toLowerCase();
  var cache = CacheService.getScriptCache();
  var failKey = "loginfail:" + state.env + ":" + input;
  var fails = Number(cache.get(failKey)) || 0;
  if (fails >= LOGIN_MAX_FAILS) {
    return { status: "denied", message: "Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút." };
  }
  var found = findLoginUser(state, input);
  var check = found ? AuthCore.verify(found.obj.password, body.password) : { ok: false };
  if (!check.ok) {
    cache.put(failKey, String(fails + 1), LOGIN_LOCK_SECONDS);
    return { status: "denied", message: "Tên đăng nhập hoặc mật khẩu không chính xác, vui lòng kiểm tra lại!" };
  }
  cache.put(failKey, "0", 1);
  var user = found.obj;
  if (check.upgrade) {
    // Nâng cấp dạng lưu cũ lên chuẩn mới, giữ nguyên pwv (không đăng xuất thiết bị khác)
    serverOp(state, "users", user.username, "patch", { password: AuthCore.protect(AuthCore.canonical(body.password), user.username) });
    persistState(state, "auth", null);
  }
  var mustChange = AuthCore.isWeakPassword(body.password, user);
  return {
    status: "ok", token: issueToken(user, mustChange), user: publicUser(user), mustChange: mustChange,
    message: mustChange ? "Mật khẩu hiện tại quá yếu. Vui lòng đặt mật khẩu mới để tiếp tục." : "Chào mừng " + user.name + " đã đăng nhập thành công!"
  };
}

function actionRegister(state, body) {
  // Chống tạo tài khoản hàng loạt (Apps Script không biết IP -> giới hạn chung theo giờ)
  var cache = CacheService.getScriptCache();
  var bucket = "regcount:" + state.env + ":" + Math.floor(Date.now() / 3600000);
  var count = Number(cache.get(bucket)) || 0;
  if (count >= REGISTER_MAX_PER_HOUR) return { status: "denied", message: "Hệ thống đang nhận quá nhiều lượt đăng ký, vui lòng thử lại sau ít phút." };
  cache.put(bucket, String(count + 1), 3700);
  var name = String(body.name || "").trim();
  var username = String(body.username || "").trim().toLowerCase();
  var phone = String(body.phone || "").replace(/\D/g, "");
  var wantsFixed = body.memberType !== "guest";
  var type = "guest"; // Thành viên cố định phải được Ban quản trị duyệt
  if (!isOptStr(body.note, 500)) return { status: "denied", message: "Ghi chú quá dài!" };
  if (name.length < 2 || name.length > 100) return { status: "denied", message: "Vui lòng nhập họ và tên hợp lệ (tối thiểu 2 ký tự)!" };
  if (!/^[a-z0-9_]{3,40}$/.test(username)) return { status: "denied", message: "Tên đăng nhập hoặc số điện thoại không hợp lệ!" };
  var policy = passwordPolicyError(body.password);
  if (policy) return { status: "denied", message: policy };
  var dup = liveUser(state, username) || (phone.length >= 9 ? findLoginUser(state, phone) : null);
  if (dup) return { status: "denied", message: 'Tài khoản với tên đăng nhập hoặc SĐT "' + username + '" đã tồn tại trên hệ thống!' };

  var now = Date.now();
  var userId = "user_" + now, memberId = "mem_" + now;
  var avatar = isSafeUrl(body.avatar, 300000) ? String(body.avatar || "") : "";
  var user = {
    id: userId, username: username, password: AuthCore.protect(AuthCore.canonical(body.password), username), pwv: 1,
    name: name, phone: phone, role: "member", memberId: memberId, type: type, avatar: avatar,
    themePreference: body.themePreference === "dark" ? "dark" : "light", createdAt: new Date(now).toISOString()
  };
  if (wantsFixed) {
    user.fixedRequest = "pending";
    user.fixedRequestAt = new Date(now).toISOString();
  }
  var member = {
    id: memberId, username: username, name: name, role: "member", phone: phone, type: type, avatar: avatar,
    joinDate: new Date(now).toISOString().slice(0, 10), note: String(body.note || "").slice(0, 500)
  };
  serverOp(state, "users", username, "put", SyncCore.encode("users", user));
  serverOp(state, "members", memberId, "put", SyncCore.encode("members", member));
  persistState(state, "register", null);
  var mustChange = AuthCore.isWeakPassword(body.password, user);
  return {
    status: "ok", token: issueToken(user, mustChange), user: publicUser(user), mustChange: mustChange,
    message: "Đăng ký thành công! Tên đăng nhập của bạn là: " + username +
      (wantsFixed ? ". Yêu cầu làm thành viên cố định đang chờ Ban quản trị duyệt." : "")
  };
}

function actionChangePassword(state, body) {
  var p = AuthCore.verifyToken(body.token, authSecret(), Date.now());
  var u = p ? liveUser(state, p.u) : null;
  if (!u || (Number(u.obj.pwv) || 0) !== (Number(p.pv) || 0)) return { status: "auth", message: "Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại!" };
  if (!AuthCore.verify(u.obj.password, body.oldPassword).ok) return { status: "denied", message: "Mật khẩu hiện tại không chính xác!" };
  var policy = passwordPolicyError(body.newPassword);
  if (policy) return { status: "denied", message: policy };
  if (AuthCore.isWeakPassword(body.newPassword, u.obj)) return { status: "denied", message: "Mật khẩu mới quá dễ đoán (trùng tên đăng nhập, số điện thoại hoặc mật khẩu phổ biến)!" };
  if (AuthCore.verify(u.obj.password, body.newPassword).ok) return { status: "denied", message: "Mật khẩu mới không được trùng với mật khẩu cũ!" };
  setPassword(state, u.obj, body.newPassword);
  persistState(state, "auth", null);
  var fresh = liveUser(state, u.obj.username).obj;
  return { status: "ok", token: issueToken(fresh, false), user: publicUser(fresh), message: "Đổi mật khẩu thành công! Các thiết bị khác sẽ phải đăng nhập lại." };
}

function actionAdminSetPassword(state, body) {
  var who = identityFromToken(state, body.token);
  if (!who || who.mustChange) return { status: "auth", message: "Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại!" };
  if (!who.staff) return { status: "denied", message: "Chỉ Ban quản trị mới có quyền đặt lại mật khẩu!" };
  var target = String(body.target || "");
  var found = null;
  Object.keys(state.store.records).forEach(function (rk) {
    var ck = SyncCore.splitRecKey(rk);
    if (found || ck.col !== "users" || !SyncCore.isLive(state.store.records[rk])) return;
    var u = SyncCore.decode("users", state.store.records[rk].d);
    if (u.username === target || u.id === target || u.memberId === target) found = u;
  });
  if (!found) return { status: "denied", message: "Không tìm thấy tài khoản tương ứng với thành viên này!" };
  if (found.role === "admin" && !who.admin) return { status: "denied", message: "Không đủ quyền đặt lại mật khẩu Quản trị viên!" };
  var policy = passwordPolicyError(body.newPassword);
  if (policy) return { status: "denied", message: policy };
  setPassword(state, found, body.newPassword);
  persistState(state, "auth", null);
  return { status: "ok", message: 'Đã cập nhật mật khẩu mới cho tài khoản "' + found.name + '" thành công!' };
}

// ======================================================================
// THÔNG BÁO EMAIL TỰ ĐỘNG (tùy chọn) - cho người KHÔNG mở ứng dụng
// Bật: trong trình soạn thảo Apps Script chọn hàm caiDatThongBaoTuDong -> "Chạy" -> cấp quyền gửi email.
// Sau đó cứ 10 phút hệ thống kiểm tra: buổi đến giờ mở vote -> email mọi thành viên có email;
// đặt sân / hủy sân -> email những người đã vote tham gia. Mỗi thông báo chỉ gửi 1 lần.
// ======================================================================
var MAIL_VOTE_OPEN_MAX_AGE = 24 * 60 * 60 * 1000;
var MAIL_NOTICE_MAX_AGE = 3 * 24 * 60 * 60 * 1000;
var APP_URL = ""; // (tùy chọn) Địa chỉ ứng dụng để chèn vào email, vd: "https://ten-clb.github.io/"

function caiDatThongBaoTuDong() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "guiThongBaoTuDong") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("guiThongBaoTuDong").timeBased().everyMinutes(10).create();
  Logger.log("Đã bật gửi email thông báo tự động (10 phút/lần).");
}

function tatThongBaoTuDong() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "guiThongBaoTuDong") ScriptApp.deleteTrigger(t);
  });
  Logger.log("Đã tắt gửi email thông báo tự động.");
}

// Cấu hình email do Ban quản trị chọn trong Cài đặt CLB (clubInfo.emailNotify)
function emailConfig(club) {
  var c = (club && club.emailNotify) || {};
  var on = function (k, def) { return c[k] === undefined ? def : !!c[k]; };
  return {
    enabled: !!c.enabled,
    voteOpen: on("voteOpen", true),
    voteOpenAudience: c.voteOpenAudience === "fixed" ? "fixed" : "all",
    booked: on("booked", true),
    cancelled: on("cancelled", true),
    reminder: on("reminder", false),
    reminderHours: Math.min(72, Math.max(1, Number(c.reminderHours) || 4)),
    fixedRequest: on("fixedRequest", true),
    fixedResult: on("fixedResult", true)
  };
}

function isEmail(v) {
  return typeof v === "string" && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(v);
}

// Người vote tham gia (giống VoteScheduler.goingMemberIds ở giao diện)
function sessionGoingIds(s) {
  return (s.votes || []).filter(function (v) {
    if (!v || !v.memberId) return false;
    if (s.voteMode === "multi_option") {
      if (v.notGoing) return false;
      var sel = Array.isArray(v.selectedOptions) ? v.selectedOptions : [];
      return s.selectedOptionId ? sel.indexOf(s.selectedOptionId) !== -1 : sel.length > 0;
    }
    return v.status === "going";
  }).map(function (v) { return v.memberId; });
}

// Tính các email cần gửi (không gửi, không ghi) - tách riêng để kiểm thử
function pendingMailJobs(state, now) {
  var club = clubInfo(state);
  var cfg = emailConfig(club);
  if (!cfg.enabled) return [];
  var users = [];
  Object.keys(state.store.records).forEach(function (rk) {
    var ck = SyncCore.splitRecKey(rk);
    if (ck.col !== "users" || !SyncCore.isLive(state.store.records[rk])) return;
    users.push({ key: ck.key, u: SyncCore.decode("users", state.store.records[rk].d) });
  });
  var withEmail = users.filter(function (x) { return isEmail(x.u.email); });
  var emailsOf = function (pred) { return withEmail.filter(function (x) { return pred(x.u); }).map(function (x) { return x.u.email; }); };
  var tag = "[" + (club.name || "CLB") + "] ";
  var link = APP_URL ? "\n" + APP_URL : "";
  var jobs = [];
  var add = function (col, key, mailed, mailKey, to, subject, body) {
    if (mailed[mailKey] || !to.length) return;
    jobs.push({ col: col, recordKey: key, mailKey: mailKey, to: to, subject: subject, body: body });
  };

  Object.keys(state.store.records).forEach(function (rk) {
    var ck = SyncCore.splitRecKey(rk);
    if (ck.col !== "sessions" || !SyncCore.isLive(state.store.records[rk])) return;
    var s = SyncCore.decode("sessions", state.store.records[rk].d);
    if (s.emailNotify === false) return; // Ban quản trị tắt email riêng cho buổi này
    var mailed = (s.mailed && typeof s.mailed === "object") ? s.mailed : {};
    var finished = s.status === "completed" || s.status === "cancelled";
    var when = (s.startTime || "") + " ngày " + (s.date || "");
    var court = s.courtName ? " tại " + s.courtName + (s.courtNumbers ? " (" + s.courtNumbers + ")" : "") : "";
    var voteOpenTo = emailsOf(function (u) { return cfg.voteOpenAudience === "all" || u.type === "fixed" || STAFF_ROLES[u.role]; });
    var voteOpenSubject = tag + "Đã mở bình chọn: " + s.title;
    var voteOpenBody = "Buổi \"" + s.title + "\" (" + when + court + ") đã mở bình chọn.\nVào ứng dụng để đăng ký tham gia." + link;
    var goingTo = function (ids) { return emailsOf(function (u) { return ids.indexOf(u.memberId) !== -1; }); };

    var openAt = parseVnDateTime(s.voteOpenAt);
    if (cfg.voteOpen && !finished && !isNaN(openAt) && now >= openAt && now - openAt < MAIL_VOTE_OPEN_MAX_AGE) {
      add("sessions", ck.key, mailed, "vote_open:" + s.voteOpenAt, voteOpenTo, voteOpenSubject, voteOpenBody);
    }
    (s.notices || []).forEach(function (n) {
      if (!n || !n.id || n.email === false || now - (Number(n.at) || 0) > MAIL_NOTICE_MAX_AGE) return;
      if (n.type === "vote_open" && cfg.voteOpen && !finished) {
        add("sessions", ck.key, mailed, "n:" + n.id, voteOpenTo, voteOpenSubject, voteOpenBody);
      } else if ((n.type === "booked" && cfg.booked) || (n.type === "cancelled" && cfg.cancelled)) {
        var booked = n.type === "booked";
        add("sessions", ck.key, mailed, "n:" + n.id, goingTo(Array.isArray(n.to) ? n.to : []),
          tag + (booked ? "Đã đặt sân: " : "Đã hủy buổi: ") + s.title,
          (booked ? "Sân đã được đặt cho buổi \"" + s.title + "\" (" + when + court + "). Hẹn gặp bạn ở sân!"
                  : "Buổi \"" + s.title + "\" (" + when + court + ") mà bạn đăng ký đã bị hủy.") + link);
      }
    });
    // Nhắc trước giờ đánh N giờ cho người đã vote tham gia
    var start = sessionStartMs(s);
    if (cfg.reminder && !finished && !isNaN(start) && now >= start - cfg.reminderHours * 3600 * 1000 && now < start) {
      add("sessions", ck.key, mailed, "reminder:" + s.date + "T" + s.startTime, goingTo(sessionGoingIds(s)),
        tag + "Nhắc lịch: " + s.title + " lúc " + when,
        "Còn khoảng " + cfg.reminderHours + " giờ nữa là tới buổi \"" + s.title + "\" (" + when + court + "). Chuẩn bị đồ và đến đúng giờ nhé!" + link);
    }
  });

  // Yêu cầu thành viên cố định -> báo Ban quản trị; kết quả duyệt -> báo người yêu cầu
  var staffEmails = emailsOf(function (u) { return !!STAFF_ROLES[u.role]; });
  users.forEach(function (x) {
    var u = x.u;
    var mailed = (u.mailed && typeof u.mailed === "object") ? u.mailed : {};
    if (cfg.fixedRequest && u.fixedRequest === "pending" && u.type !== "fixed") {
      add("users", x.key, mailed, "req:" + (u.fixedRequestAt || ""), staffEmails,
        tag + "Yêu cầu thành viên cố định: " + u.name,
        u.name + " (" + u.username + ") xin làm thành viên cố định. Vào mục Thành viên trong ứng dụng để duyệt." + link);
    }
    var decided = Number(u.fixedDecidedAt) || 0;
    if (cfg.fixedResult && (u.fixedRequest === "approved" || u.fixedRequest === "rejected") && now - decided < MAIL_NOTICE_MAX_AGE && isEmail(u.email)) {
      var ok = u.fixedRequest === "approved";
      add("users", x.key, mailed, "res:" + decided, [u.email],
        tag + (ok ? "Đã duyệt thành viên cố định" : "Yêu cầu thành viên cố định chưa được duyệt"),
        ok ? "Chúc mừng " + u.name + "! Bạn đã trở thành thành viên cố định của CLB." + link
           : "Ban quản trị chưa duyệt yêu cầu thành viên cố định của bạn. Liên hệ Ban quản trị để biết thêm chi tiết." + link);
    }
  });
  return jobs;
}

function mailTriggerInstalled() {
  return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === "guiThongBaoTuDong"; });
}

var MAIL_AUTH_HELP = "Chủ Google Sheet cần mở trình soạn thảo Apps Script, chạy hàm caiDatThongBaoTuDong một lần để cấp quyền gửi email.";

function actionEmailSetup(state, body) {
  var who = identityFromToken(state, body.token);
  if (!who || who.mustChange) return { status: "auth", message: "Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại!" };
  if (!who.staff) return { status: "denied", message: "Chỉ Ban quản trị mới được cấu hình email." };
  try {
    var installed = mailTriggerInstalled();
    if (body.enable && !installed) {
      ScriptApp.newTrigger("guiThongBaoTuDong").timeBased().everyMinutes(10).create();
      installed = true;
    }
    return { status: "ok", installed: installed, quota: MailApp.getRemainingDailyQuota() };
  } catch (e) {
    return { status: "denied", installed: false, message: MAIL_AUTH_HELP + " (" + e + ")" };
  }
}

function actionEmailTest(state, body) {
  var who = identityFromToken(state, body.token);
  if (!who || who.mustChange) return { status: "auth", message: "Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại!" };
  if (!who.staff) return { status: "denied", message: "Chỉ Ban quản trị mới được gửi email thử." };
  var me = liveUser(state, who.username).obj;
  if (!isEmail(me.email)) return { status: "denied", message: "Hồ sơ của bạn chưa có email hợp lệ để nhận thư thử." };
  try {
    MailApp.sendEmail(me.email, "[" + (clubInfo(state).name || "CLB") + "] Email thử", "Cấu hình gửi email thông báo của CLB đang hoạt động.");
    return { status: "ok", message: "Đã gửi email thử tới " + me.email + ".", quota: MailApp.getRemainingDailyQuota() };
  } catch (e) {
    return { status: "denied", message: MAIL_AUTH_HELP + " (" + e + ")" };
  }
}

function guiThongBaoTuDong() {
  var env = SHEET_PROD;
  withLock(function () {
    ensureMigrated(env);
    var state = loadState(env);
    var jobs = pendingMailJobs(state, Date.now());
    var marks = {};
    for (var i = 0; i < jobs.length; i++) {
      var job = jobs[i];
      if (MailApp.getRemainingDailyQuota() < job.to.length) break; // Hết hạn mức gửi trong ngày: để lần sau
      job.to.forEach(function (email) {
        try { MailApp.sendEmail(email, job.subject, job.body); } catch (e) { Logger.log("Lỗi gửi email " + email + ": " + e); }
      });
      var rk = SyncCore.recKey(job.col, job.recordKey);
      marks[rk] = marks[rk] || {};
      marks[rk][job.mailKey] = Date.now();
    }
    Object.keys(marks).forEach(function (rk) {
      var ck = SyncCore.splitRecKey(rk);
      var cur = SyncCore.decode(ck.col, state.store.records[rk].d).mailed || {};
      var next = {};
      Object.keys(cur).forEach(function (k) { if (Date.now() - cur[k] < 30 * 24 * 60 * 60 * 1000) next[k] = cur[k]; });
      Object.keys(marks[rk]).forEach(function (k) { next[k] = marks[rk][k]; });
      serverOp(state, ck.col, ck.key, "patch", { mailed: next });
    });
    persistState(state, "mailer", null);
  });
}

// Chạy THỦ CÔNG trong trình soạn thảo Apps Script (chỉ chủ sheet làm được) khi quên mật khẩu admin
// hoặc CSDL mới chưa có mật khẩu: điền MAT_KHAU_MOI, bấm "Chạy", xong XÓA mật khẩu khỏi mã.
function datLaiMatKhauAdmin() {
  var MAT_KHAU_MOI = "";
  var env = SHEET_PROD;
  if (MAT_KHAU_MOI.length < 8) throw new Error("Hãy điền MAT_KHAU_MOI (tối thiểu 8 ký tự) trước khi chạy.");
  withLock(function () {
    ensureMigrated(env);
    var state = loadState(env);
    var admin = liveUser(state, "admin");
    if (!admin) throw new Error("Không tìm thấy tài khoản admin.");
    setPassword(state, admin.obj, MAT_KHAU_MOI);
    persistState(state, "editor", null);
  });
  Logger.log("Đã đặt lại mật khẩu admin. Mọi phiên đăng nhập admin cũ đã bị hủy.");
}

// ======================================================================
// HTTP
// ======================================================================
// GET v2: ?v=2&sheet=..&since=SEQ&t=TOKEN -> các bản ghi thay đổi sau SEQ (đã lọc theo người xem)
// GET v1: ?sheet=..&rev=N                -> ảnh chụp định dạng cũ, chỉ dữ liệu công khai (chỉ đọc)
function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    var env = resolveSheetName(params.sheet);
    if (!isMigrated(env)) withLock(function () { ensureMigrated(env); });

    var seq = getSeq(env, false); // Đọc SEQ TRƯỚC khi đọc dữ liệu
    if (String(params.v) === "2") {
      var since = Number(params.since) || 0;
      if (since > seq) since = 0; // Máy trạm "đi trước" máy chủ (sheet bị thay thế) -> tải lại toàn bộ
      if (since && since === seq) return jsonOut({ status: "unchanged", seq: seq, serverTime: Date.now() });
      var state = { env: env, store: readStore(recordsSheet(env)), seq: seq };
      return jsonOut(deltaPayload(state, since, identityFromToken(state, params.t)));
    }

    if (params.rev && Number(params.rev) === seq && seq > 0) {
      return jsonOut({ status: "unchanged", revision: seq, sheetName: env });
    }
    var legacy = { env: env, store: readStore(recordsSheet(env)), seq: seq };
    if (!Object.keys(legacy.store.records).length) {
      return jsonOut({ status: "empty", sheetName: env, message: "Chưa có dữ liệu trong sheet này." });
    }
    return jsonOut(legacySnapshotFor(legacy));
  } catch (error) {
    return jsonOut({ status: "error", message: error.toString() });
  }
}

// POST v2 đồng bộ:  { v: 2, deviceId, since, viewer, auth: {username: token}, ops: [{..., u: username}] }
// POST v2 xác thực: { v: 2, action: "login" | "register" | "changePassword" | "adminSetPassword", ... }
// POST v1 (mã cũ):  bị từ chối - không có xác thực nên không được phép ghi
function doPost(e) {
  try {
    var rawData = e && e.postData && e.postData.contents;
    if (!rawData) return jsonOut({ status: "error", message: "Dữ liệu gửi lên trống!" });
    var body = JSON.parse(rawData);
    var params = (e && e.parameter) || {};
    var env = resolveSheetName(params.sheet || body.sheet || body.sheetName);

    if (body.v !== 2) {
      return jsonOut({ status: "error", code: "outdated", message: "Phiên bản ứng dụng đã cũ. Vui lòng tải lại trang (Ctrl+F5) để cập nhật trước khi lưu dữ liệu." });
    }

    return withLock(function () {
      ensureMigrated(env);
      var state = loadState(env);
      var actions = {
        login: actionLogin, register: actionRegister, changePassword: actionChangePassword, adminSetPassword: actionAdminSetPassword,
        emailSetup: actionEmailSetup, emailTest: actionEmailTest
      };
      if (body.action) {
        if (!actions[body.action]) return jsonOut({ status: "error", message: "Lệnh không hợp lệ" });
        var out = actions[body.action](state, body);
        out.serverTime = Date.now();
        return jsonOut(out);
      }

      var result = processOps(state, body.ops, body.auth, body.deviceId);
      persistState(state, body.deviceId, body.ops);
      var since = Number(body.since) || 0;
      if (since > state.seq) since = 0;
      var viewer = identityFromToken(state, (body.auth || {})[body.viewer]);
      var payload = deltaPayload(state, since, viewer);
      payload.acked = result.acked;
      payload.rejected = result.rejected;
      payload.deferred = result.deferred;
      return jsonOut(payload);
    });
  } catch (error) {
    return jsonOut({ status: "error", message: error.toString() });
  }
}
