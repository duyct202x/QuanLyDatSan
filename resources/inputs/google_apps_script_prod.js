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

// ======================================================================
// SINH TỰ ĐỘNG từ js/sync-core.js (python tools/build_gas_backend.py). Không sửa tay.
// ======================================================================
// SyncCore v2 - Đồng bộ theo từng TRƯỜNG dữ liệu (field-level LWW) với đồng hồ lai HLC
// Dùng chung cho trình duyệt và Google Apps Script. KHÔNG sửa trực tiếp bản trong
// resources/inputs/google_apps_script_prod.js - chạy `python tools/build_gas_backend.py` để sinh lại.
//
// Mô hình bản ghi lưu trữ (store record):
//   { d: {path: value}, f: {path: hlc}, x: hlcXoa, c: hlcTao, s: seqMayChu }
//   - path = tên trường cấp 1 ("name"), phần tử mảng con có khóa ("votes#mem_1"),
//     hoặc thứ tự mảng con ("votes#").
//   - path có trong f nhưng không có trong d = trường đã bị gỡ (tại thời điểm f[path]).
//   - Bản ghi bị xóa khi x >= mọi f[path]; ghi mới hơn x sẽ "hồi sinh" bản ghi.
// Thao tác (op): { id, col, key, t: 'put'|'patch'|'del'|'reset', h, c, set, unset, fill }
//   - Chỉ chứa các trường người dùng THỰC SỰ sửa -> máy cũ không thể ghi đè trường nó không chạm vào.
//   - fill: giá trị nền (HLC thấp nhất) chỉ điền khi máy chủ chưa từng có trường đó.
var SyncCore = (function () {
  var COLLECTIONS = ['members', 'users', 'sessions', 'transactions', 'monthlyContributions', 'inventory'];
  var CLUB_COL = 'club';
  var CLUB_KEY = 'info';
  var ALL_COLS = COLLECTIONS.concat([CLUB_COL]);
  var DESC_ORDER = { sessions: true, transactions: true }; // Mới nhất đứng đầu (giống unshift của các module)
  // Mảng con được hợp nhất theo từng phần tử -> 2 người bình chọn cùng lúc không mất phiếu của nhau
  var KEYED_ARRAYS = {
    sessions: { votes: 'memberId', voteHistory: 'id', options: 'id', notices: 'id' },
    club: { benefitsAndRules: 'id' }
  };
  var IGNORED_FIELDS = { updatedAt: true };
  var FLOOR = '0000000000000-0000-'; // Nhỏ hơn mọi HLC thật
  var MAX_COUNTER = 9999;

  // ---------------- HLC (Hybrid Logical Clock) ----------------
  function pad(n, w) {
    var s = String(Math.max(0, Math.floor(n)));
    while (s.length < w) s = '0' + s;
    return s;
  }
  function hlcPack(ms, counter, node) {
    return pad(ms, 13) + '-' + pad(counter, 4) + '-' + (node || '');
  }
  function hlcParse(h) {
    if (!h) return { ms: 0, c: 0, node: '' };
    var p = String(h).split('-');
    return { ms: Number(p[0]) || 0, c: Number(p[1]) || 0, node: p.slice(2).join('-') };
  }
  function hlcMs(h) {
    return hlcParse(h).ms;
  }
  function hlcFromMs(ms, node) {
    return hlcPack(Number(ms) || 0, 0, node || 'legacy');
  }
  function maxHlc(a, b) {
    return (a || '') > (b || '') ? (a || '') : (b || '');
  }

  // Đồng hồ: đơn điệu tăng, hiệu chỉnh theo giờ máy chủ, luôn lớn hơn mọi HLC đã thấy
  // -> một thao tác sửa SAU KHI đã thấy giá trị X luôn thắng X, kể cả khi đồng hồ máy lệch.
  function createClock(node, nowFn) {
    var lastMs = 0, lastC = 0;
    var offset = 0;
    nowFn = nowFn || function () { return Date.now(); };
    return {
      node: node,
      setOffset: function (o) { offset = Number(o) || 0; },
      getOffset: function () { return offset; },
      wallNow: function () { return nowFn() + offset; },
      now: function () {
        var wall = nowFn() + offset;
        if (wall > lastMs) { lastMs = wall; lastC = 0; }
        else if (lastC < MAX_COUNTER) { lastC++; }
        else { lastMs++; lastC = 0; }
        return hlcPack(lastMs, lastC, node);
      },
      observe: function (h) {
        if (!h || h === FLOOR) return;
        var p = hlcParse(h);
        if (p.ms > lastMs || (p.ms === lastMs && p.c > lastC)) { lastMs = p.ms; lastC = p.c; }
      }
    };
  }

  // ---------------- Khóa & mã hóa bản ghi ----------------
  function keyOf(col, rec) {
    if (!rec) return null;
    if (col === CLUB_COL) return CLUB_KEY;
    if (col === 'users') return rec.username || rec.id || null;
    if (col === 'monthlyContributions') return rec.id || (rec.memberId ? rec.month + '_' + rec.memberId : null);
    return rec.id || null;
  }

  function elementKey(field, keyProp, el) {
    if (!el || typeof el !== 'object') return null;
    if (el[keyProp] !== undefined && el[keyProp] !== null && el[keyProp] !== '') return String(el[keyProp]);
    if (field === 'voteHistory') return 'k_' + el.memberId + '_' + el.votedAt + '_' + (el.actionText || el.status);
    return 'j_' + JSON.stringify(el);
  }

  // Đối tượng -> bảng phẳng {path: value}
  function encode(col, obj) {
    var out = {};
    if (!obj) return out;
    var keyed = KEYED_ARRAYS[col] || {};
    Object.keys(obj).forEach(function (k) {
      if (IGNORED_FIELDS[k] || k.indexOf('#') !== -1) return;
      var v = obj[k];
      if (v === undefined) return;
      if (keyed[k] && Array.isArray(v)) {
        var order = [];
        v.forEach(function (el) {
          var ek = elementKey(k, keyed[k], el);
          if (ek === null || out[k + '#' + ek] !== undefined) return;
          order.push(ek);
          out[k + '#' + ek] = el;
        });
        out[k + '#'] = order;
      } else {
        out[k] = v;
      }
    });
    return out;
  }

  // Bảng phẳng -> đối tượng (khôi phục mảng con theo thứ tự đã lưu)
  function decode(col, d) {
    var obj = {}, arrays = {}, orders = {};
    Object.keys(d || {}).forEach(function (p) {
      var i = p.indexOf('#');
      if (i === -1) { obj[p] = d[p]; return; }
      var field = p.slice(0, i), ek = p.slice(i + 1);
      if (!arrays[field]) arrays[field] = {};
      if (ek === '') orders[field] = d[p];
      else arrays[field][ek] = d[p];
    });
    Object.keys(arrays).forEach(function (field) {
      var els = arrays[field], seen = {}, list = [];
      (Array.isArray(orders[field]) ? orders[field] : []).forEach(function (ek) {
        if (els[ek] !== undefined && !seen[ek]) { seen[ek] = true; list.push(els[ek]); }
      });
      Object.keys(els).forEach(function (ek) {
        if (!seen[ek]) list.push(els[ek]);
      });
      obj[field] = list;
    });
    return obj;
  }

  function same(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  // ---------------- Bản ghi lưu trữ ----------------
  function newRecord() {
    return { d: {}, f: {}, x: '', c: '', s: 0 };
  }
  function maxFieldHlc(rec) {
    var m = '';
    Object.keys(rec.f || {}).forEach(function (p) { if (rec.f[p] > m) m = rec.f[p]; });
    return m;
  }
  function isLive(rec) {
    if (!rec) return false;
    var m = maxFieldHlc(rec);
    if (!m) return false;
    return !rec.x || m > rec.x;
  }
  function recordHlcMax(rec) {
    return maxHlc(maxFieldHlc(rec), rec.x || '');
  }
  function materialize(col, rec) {
    return isLive(rec) ? decode(col, rec.d) : null;
  }

  // Áp 1 thao tác lên bản ghi (tạo mới nếu chưa có). Trả về true nếu có thay đổi.
  function applyOp(rec, op) {
    var h = op.h, changed = false, p;
    if (op.t === 'del') {
      if (h > (rec.x || '')) { rec.x = h; changed = true; }
      return changed;
    }
    if (op.t === 'put') {
      for (p in rec.f) {
        if (!(op.set && p in op.set) && h > rec.f[p]) {
          if (p in rec.d) delete rec.d[p];
          rec.f[p] = h;
          changed = true;
        }
      }
    }
    var set = op.set || {};
    for (p in set) {
      if (h > (rec.f[p] || '')) {
        rec.d[p] = set[p];
        rec.f[p] = h;
        changed = true;
      }
    }
    (op.unset || []).forEach(function (q) {
      if (h > (rec.f[q] || '')) {
        if (q in rec.d) delete rec.d[q];
        rec.f[q] = h;
        changed = true;
      }
    });
    var fill = op.fill || {};
    for (p in fill) {
      if (!(p in rec.f)) {
        rec.d[p] = fill[p];
        rec.f[p] = FLOOR;
        changed = true;
      }
    }
    if (changed && !rec.c) rec.c = op.c || h;
    return changed;
  }

  // Xóa toàn bộ (Đặt lại/Phục hồi): mọi bản ghi có HLC < h bị đánh dấu xóa
  function applyReset(records, h) {
    var changed = [];
    Object.keys(records).forEach(function (rk) {
      var rec = records[rk];
      if (h > (rec.x || '')) { rec.x = h; changed.push(rk); }
    });
    return changed;
  }

  function recKey(col, key) {
    return col + '\u0001' + key;
  }
  function splitRecKey(rk) {
    var i = rk.indexOf('\u0001');
    return { col: rk.slice(0, i), key: rk.slice(i + 1) };
  }

  // Áp danh sách op lên kho {recKey: rec}. Trả về danh sách recKey bị thay đổi.
  // clampFn (máy chủ): chặn HLC "ở tương lai" của máy có đồng hồ chạy nhanh.
  function applyOps(records, ops, clampFn) {
    var changed = {};
    (ops || []).forEach(function (op) {
      if (!op || !op.t) return;
      if (clampFn) op.h = clampFn(op.h);
      if (op.t === 'reset') {
        applyReset(records, op.h).forEach(function (rk) { changed[rk] = true; });
        return;
      }
      if (ALL_COLS.indexOf(op.col) === -1 || op.key === undefined || op.key === null || String(op.key).length > 300) return;
      var rk = recKey(op.col, String(op.key));
      var rec = records[rk] || newRecord();
      if (applyOp(rec, op)) {
        records[rk] = rec;
        changed[rk] = true;
      }
    });
    return Object.keys(changed);
  }

  // ---------------- Sinh op từ thay đổi của người dùng ----------------
  // base: đối tượng lúc loadData() trả về; next: đối tượng người dùng lưu; inStore: bản ghi đã tồn tại thật trong kho.
  function diffRecord(col, key, base, next, inStore, h) {
    if (!next && !base) return null;
    if (!next) return { col: col, key: key, t: 'del', h: h };
    var pn = encode(col, next);
    if (!base) return { col: col, key: key, t: 'put', h: h, c: h, set: pn };
    var pb = encode(col, base);
    var set = {}, unset = [], fill = {}, n = 0, p;
    for (p in pn) {
      if (!(p in pb) || !same(pb[p], pn[p])) { set[p] = pn[p]; n++; }
      else if (!inStore) fill[p] = pn[p];
    }
    for (p in pb) {
      if (!(p in pn)) { unset.push(p); n++; }
    }
    if (!n) return null;
    var op = { col: col, key: key, t: 'patch', h: h, set: set };
    if (unset.length) op.unset = unset;
    // Bản ghi chỉ có trên giao diện (mặc định/tự sinh): điền phần còn lại ở mức nền, không đè dữ liệu thật
    if (!inStore) { op.fill = fill; op.c = h; }
    return op;
  }

  function indexBy(col, list) {
    var map = {};
    (Array.isArray(list) ? list : []).forEach(function (r) {
      var k = keyOf(col, r);
      if (k !== null && k !== undefined && !(String(k) in map)) map[String(k)] = r;
    });
    return map;
  }

  // So sánh toàn bộ CSDL dạng ứng dụng -> danh sách op. hasRecord(col, key) cho biết bản ghi có trong kho thật.
  function diffData(base, next, h, hasRecord) {
    var ops = [];
    COLLECTIONS.forEach(function (col) {
      if (!Array.isArray(next[col])) return; // Thiếu mảng = không phải ý định xóa hết
      var bm = indexBy(col, base && base[col]);
      var nm = indexBy(col, next[col]);
      var keys = {};
      Object.keys(bm).forEach(function (k) { keys[k] = true; });
      Object.keys(nm).forEach(function (k) { keys[k] = true; });
      Object.keys(keys).forEach(function (k) {
        var op = diffRecord(col, k, bm[k], nm[k], hasRecord(col, k), h);
        if (op) ops.push(op);
      });
    });
    if (next.clubInfo) {
      var op = diffRecord(CLUB_COL, CLUB_KEY, base && base.clubInfo, next.clubInfo, hasRecord(CLUB_COL, CLUB_KEY), h);
      if (op && op.t !== 'del') ops.push(op);
    }
    return ops;
  }

  // ---------------- Dựng dữ liệu dạng ứng dụng từ kho ----------------
  function buildCollections(records) {
    var buckets = {};
    ALL_COLS.forEach(function (c) { buckets[c] = []; });
    Object.keys(records).forEach(function (rk) {
      var ck = splitRecKey(rk);
      if (!buckets[ck.col]) return;
      var rec = records[rk];
      var obj = materialize(ck.col, rec);
      if (obj) buckets[ck.col].push({ c: rec.c || '', k: ck.key, o: obj });
    });
    var out = {};
    COLLECTIONS.forEach(function (col) {
      var list = buckets[col];
      list.sort(function (a, b) { return a.c < b.c ? -1 : a.c > b.c ? 1 : (a.k < b.k ? -1 : a.k > b.k ? 1 : 0); });
      if (DESC_ORDER[col]) list.reverse();
      out[col] = list.map(function (e) { return e.o; });
    });
    out.clubInfo = buckets[CLUB_COL].length ? buckets[CLUB_COL][0].o : null;
    return out;
  }

  // ---------------- Tương thích dữ liệu kiểu cũ (v1: ảnh chụp toàn bộ CSDL) ----------------
  // Chuyển ảnh chụp v1 thành op. Mỗi trường mang HLC = updatedAt của bản ghi v1,
  // nên chỉ thắng những trường trên máy chủ cũ hơn nó (không đè thay đổi mới hơn).
  // now: giờ máy chủ, dùng cho ảnh chụp "thay thế toàn bộ" (_replace) không có lastModified
  function legacySnapshotToOps(snap, node, now) {
    var ops = [];
    if (!snap || typeof snap !== 'object') return ops;
    node = node || 'legacy';
    var fallbackTs = Number(snap.lastModified) || 0;
    // Thay thế toàn bộ: xóa hết tại T-1, rồi tạo lại MỌI bản ghi trong ảnh chụp tại T (không phụ thuộc updatedAt cũ)
    var replaceTs = snap._replace ? (fallbackTs || Number(now) || Date.now()) : 0;
    if (replaceTs) {
      ops.push({ t: 'reset', h: hlcFromMs(replaceTs - 1, node) });
    }
    var recTs = function (ts) { return hlcFromMs(replaceTs ? Math.max(replaceTs, Number(ts) || 0) : (Number(ts) || 0), node); };
    COLLECTIONS.forEach(function (col) {
      var list = Array.isArray(snap[col]) ? snap[col] : [];
      var n = list.length;
      list.forEach(function (rec, i) {
        var key = keyOf(col, rec);
        if (key === null || key === undefined) return;
        var orderMs = DESC_ORDER[col] ? n - i : i + 1;
        ops.push({
          col: col, key: String(key), t: replaceTs ? 'put' : 'patch',
          h: recTs(rec.updatedAt),
          c: hlcFromMs(orderMs, 'order'),
          set: encode(col, rec)
        });
      });
    });
    if (snap.clubInfo) {
      ops.push({
        col: CLUB_COL, key: CLUB_KEY, t: replaceTs ? 'put' : 'patch',
        h: recTs(snap.clubInfoUpdatedAt),
        c: hlcFromMs(1, 'order'),
        set: encode(CLUB_COL, snap.clubInfo)
      });
    }
    var tomb = snap.tombstones || {};
    Object.keys(tomb).forEach(function (tk) {
      var ts = Number(tomb[tk]) || 0;
      if (!ts) return;
      var parts = tk.split(':');
      if (parts[0] === 'vote' && parts.length >= 3) {
        ops.push({ col: 'sessions', key: parts[1], t: 'patch', h: hlcFromMs(ts, node), set: {}, unset: ['votes#' + parts.slice(2).join(':')] });
      } else if (COLLECTIONS.indexOf(parts[0]) !== -1) {
        ops.push({ col: parts[0], key: parts.slice(1).join(':'), t: 'del', h: hlcFromMs(ts, node) });
      }
    });
    // Danh sách xóa kiểu cũ không có thời điểm chính xác -> HLC thấp nhất, chỉ xóa bản ghi chưa từng được sửa sau đó
    var delTs = hlcFromMs(1, node);
    (snap.deletedMemberIds || []).forEach(function (id) {
      ops.push({ col: 'members', key: String(id), t: 'del', h: delTs });
    });
    (snap.deletedUserIds || []).forEach(function (id) {
      ops.push({ col: 'users', key: String(id), t: 'del', h: delTs });
    });
    return ops;
  }

  // Kho -> ảnh chụp v1 (cho thiết bị còn chạy mã cũ trong giai đoạn chuyển tiếp)
  function toLegacySnapshot(records) {
    var data = buildCollections(records);
    var tombstones = {};
    COLLECTIONS.forEach(function (col) {
      data[col] = data[col].map(function (o) {
        var rec = records[recKey(col, String(keyOf(col, o)))];
        var copy = {};
        for (var k in o) copy[k] = o[k];
        copy.updatedAt = rec ? hlcMs(maxFieldHlc(rec)) : 0;
        return copy;
      });
    });
    Object.keys(records).forEach(function (rk) {
      var rec = records[rk];
      if (isLive(rec)) return;
      var ck = splitRecKey(rk);
      if (ck.col !== CLUB_COL && rec.x) tombstones[ck.col + ':' + ck.key] = hlcMs(rec.x);
    });
    var club = records[recKey(CLUB_COL, CLUB_KEY)];
    data.clubInfoUpdatedAt = club ? hlcMs(maxFieldHlc(club)) : 0;
    data.tombstones = tombstones;
    data.deletedMemberIds = [];
    data.deletedUserIds = [];
    return data;
  }

  // Máy chủ: chặn HLC vượt quá giờ máy chủ (máy có đồng hồ chạy nhanh không được thắng mãi mãi)
  function makeClamp(serverNow, skewMs) {
    var limit = serverNow + (skewMs || 5000);
    return function (h) {
      var p = hlcParse(h);
      return p.ms > limit ? hlcPack(serverNow, p.c, p.node) : h;
    };
  }

  return {
    COLLECTIONS: COLLECTIONS,
    CLUB_COL: CLUB_COL,
    CLUB_KEY: CLUB_KEY,
    FLOOR: FLOOR,
    hlcPack: hlcPack,
    hlcParse: hlcParse,
    hlcMs: hlcMs,
    hlcFromMs: hlcFromMs,
    createClock: createClock,
    keyOf: keyOf,
    encode: encode,
    decode: decode,
    newRecord: newRecord,
    isLive: isLive,
    recordHlcMax: recordHlcMax,
    materialize: materialize,
    applyOp: applyOp,
    applyOps: applyOps,
    recKey: recKey,
    splitRecKey: splitRecKey,
    diffData: diffData,
    buildCollections: buildCollections,
    legacySnapshotToOps: legacySnapshotToOps,
    toLegacySnapshot: toLegacySnapshot,
    makeClamp: makeClamp
  };
})();

// ======================================================================
// SINH TỰ ĐỘNG từ js/auth-core.js (python tools/build_gas_backend.py). Không sửa tay.
// ======================================================================
// AuthCore - Băm mật khẩu & ký phiên đăng nhập (token)
// Dùng chung cho trình duyệt và Google Apps Script. KHÔNG sửa bản trong google_apps_script_prod.js -
// chạy `python tools/build_gas_backend.py` để sinh lại.
//
// Định dạng mật khẩu lưu trên máy chủ: $kdf1$<số vòng>$<muối>$<hex>
//   = băm lặp có muối của "inner", với inner là dạng băm cũ ($sha256$...) hoặc chuỗi cũ bất kỳ
//   -> nâng cấp được toàn bộ mật khẩu cũ mà không cần biết mật khẩu gốc.
var AuthCore = (function () {
  var LEGACY_SALT = "SMASH_PRO_SECURE_SALT_2026";
  var KDF_ITER = 2000;
  var WEAK = ['admin', 'admin123', '123456', '1234567', '12345678', '123456789', '1234567890', 'password',
    'password123', '111111', '000000', '123123', 'abc123', 'qwerty', '666666', '888888'];

  // SHA-256 (giữ NGUYÊN thuật toán của bản cũ trong storage.js để mật khẩu đã lưu vẫn khớp)
  function sha256(ascii) {
    if (!ascii) return "";
    function rightRotate(value, amount) {
      return (value >>> amount) | (value << (32 - amount));
    }
    var maxWord = Math.pow(2, 32);
    var i, j;
    var result = '';
    var words = [];
    var asciiBitLength = ascii.length * 8;
    var hash = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ];
    var k = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    words[asciiBitLength >> 5] |= 0x80 << (24 - asciiBitLength % 32);
    words[(((asciiBitLength + 64) >> 9) << 4) + 15] = asciiBitLength;
    for (i = 0; i < ascii.length; i++) {
      words[i >> 2] |= ascii.charCodeAt(i) << (24 - (i % 4) * 8);
    }
    for (j = 0; j < words.length; j += 16) {
      var w = words.slice(j, j + 16);
      var oldHash = hash.slice(0);
      for (i = 0; i < 64; i++) {
        var w15 = w[i - 15], w2 = w[i - 2];
        var a = hash[0], e = hash[4];
        var temp1 = hash[7]
          + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25))
          + ((e & hash[5]) ^ ((~e) & hash[6]))
          + k[i]
          + (w[i] = (i < 16) ? (w[i] || 0) : (
              w[i - 16]
              + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3))
              + w[i - 7]
              + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))
            ) | 0
          );
        var temp2 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22))
          + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(temp1 + temp2) | 0, a, hash[1], hash[2], (hash[3] + temp1) | 0, hash[4], hash[5], hash[6]];
      }
      for (i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }
    for (i = 0; i < 8; i++) {
      for (j = 3; j >= 0; j--) {
        var b = (hash[i] >> (j * 8)) & 255;
        result += ((b < 16) ? '0' : '') + b.toString(16);
      }
    }
    return result;
  }

  function utf8(s) {
    return unescape(encodeURIComponent(String(s)));
  }
  function hexToBin(hex) {
    var out = '';
    for (var i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    return out;
  }
  function toHex(s) {
    var b = utf8(s), out = '';
    for (var i = 0; i < b.length; i++) out += (b.charCodeAt(i) < 16 ? '0' : '') + b.charCodeAt(i).toString(16);
    return out;
  }
  function fromHex(hex) {
    return decodeURIComponent(escape(hexToBin(hex)));
  }

  // HMAC-SHA256 chuẩn (RFC 2104) trên chuỗi byte
  function hmac(key, msg) {
    var k = utf8(key);
    if (k.length > 64) k = hexToBin(sha256(k));
    while (k.length < 64) k += String.fromCharCode(0);
    var ipad = '', opad = '';
    for (var i = 0; i < 64; i++) {
      ipad += String.fromCharCode(k.charCodeAt(i) ^ 0x36);
      opad += String.fromCharCode(k.charCodeAt(i) ^ 0x5c);
    }
    return sha256(opad + hexToBin(sha256(ipad + utf8(msg))));
  }

  // So sánh không lộ thời gian (tránh dò từng ký tự)
  function safeEqual(a, b) {
    a = String(a); b = String(b);
    if (a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  function canonical(pwd) {
    return '$sha256$' + sha256(String(pwd).trim());
  }

  // Các dạng mật khẩu cũ từng được lưu (để khớp & nâng cấp)
  function legacyCandidates(pwd) {
    var input = String(pwd).trim();
    var h1 = 5381, h2 = 0;
    var legacySalted = LEGACY_SALT + '::' + input + '::' + (input.length * 31);
    for (var i = 0; i < legacySalted.length; i++) {
      var c = legacySalted.charCodeAt(i);
      h1 = ((h1 << 5) + h1) ^ c;
      h2 = (c + (h2 << 6) + (h2 << 16) - h2) >>> 0;
    }
    var pad8 = function (s) { while (s.length < 8) s = '0' + s; return s; };
    return [
      canonical(input),
      '$sha256$' + sha256(LEGACY_SALT + '::' + input),
      '$sha256$' + pad8(Math.abs(h1).toString(16)) + pad8(Math.abs(h2).toString(16)),
      input
    ];
  }

  function isKdf(stored) {
    return /^\$kdf1\$\d+\$[0-9a-f]+\$[0-9a-f]{64}$/.test(String(stored || ''));
  }

  function kdf(inner, salt, iter) {
    var h = String(inner);
    for (var i = 0; i < iter; i++) h = sha256(salt + '$' + i + '$' + h);
    return '$kdf1$' + iter + '$' + salt + '$' + h;
  }

  function newSalt(seed) {
    return sha256(String(seed) + ':' + Math.random() + ':' + Date.now()).slice(0, 24);
  }

  // inner: dạng băm cũ hoặc chuẩn ($sha256$...). Trả về chuỗi lưu trữ an toàn.
  function wrap(inner, seed) {
    return kdf(inner, newSalt(seed || inner), KDF_ITER);
  }

  // Chuỗi mật khẩu đang lưu kiểu cũ (bất kỳ dạng nào) -> bọc nguyên văn, verify() vẫn khớp nhờ legacyCandidates
  function wrapLegacy(stored, seed) {
    return isKdf(stored) ? String(stored) : wrap(String(stored), seed);
  }

  // Giá trị client gửi lên (đã băm $sha256$ hoặc văn bản thô) -> chuỗi lưu trữ an toàn
  function protect(value, seed) {
    var v = String(value || '');
    if (!v) return '';
    if (isKdf(v)) return v;
    return wrap(/^\$sha256\$[0-9a-f]{64}$/.test(v) ? v : canonical(v), seed);
  }

  // Kiểm tra mật khẩu. upgrade = true khi nên lưu lại dạng chuẩn mới.
  function verify(stored, pwd) {
    stored = String(stored || '');
    if (!stored || !String(pwd || '').trim()) return { ok: false };
    var cands = legacyCandidates(pwd);
    if (isKdf(stored)) {
      var p = stored.split('$'); // ['', 'kdf1', iter, salt, hex]
      var iter = Number(p[2]), salt = p[3];
      for (var i = 0; i < cands.length; i++) {
        if (safeEqual(kdf(cands[i], salt, iter), stored)) return { ok: true, upgrade: i > 0 || iter !== KDF_ITER };
      }
      return { ok: false };
    }
    for (var j = 0; j < cands.length; j++) {
      if (safeEqual(cands[j], stored)) return { ok: true, upgrade: true };
    }
    return { ok: false };
  }

  function isWeakPassword(pwd, user) {
    var p = String(pwd || '').trim();
    var lower = p.toLowerCase();
    if (p.length < 6) return true;
    if (WEAK.indexOf(lower) !== -1) return true;
    if (user) {
      var digits = p.replace(/\D/g, '');
      if (user.username && lower === String(user.username).toLowerCase()) return true;
      if (user.phone && digits.length === p.length && digits === String(user.phone).replace(/\D/g, '')) return true;
    }
    return false;
  }

  // Token = hex(payload JSON) + "." + HMAC(secret, hex). Payload: { u, pv, exp, mc }
  function signToken(payload, secret) {
    var body = toHex(JSON.stringify(payload));
    return body + '.' + hmac(secret, body);
  }
  function readToken(token) {
    try {
      var body = String(token || '').split('.')[0];
      return body ? JSON.parse(fromHex(body)) : null;
    } catch (e) { return null; }
  }
  function verifyToken(token, secret, now) {
    var parts = String(token || '').split('.');
    if (parts.length !== 2 || !/^[0-9a-f]+$/.test(parts[0])) return null;
    if (!safeEqual(hmac(secret, parts[0]), parts[1])) return null;
    var payload = readToken(token);
    if (!payload || !payload.u || !(Number(payload.exp) > (now || Date.now()))) return null;
    return payload;
  }

  return {
    sha256: sha256,
    hmac: hmac,
    canonical: canonical,
    legacyCandidates: legacyCandidates,
    isKdf: isKdf,
    wrapLegacy: wrapLegacy,
    protect: protect,
    verify: verify,
    isWeakPassword: isWeakPassword,
    signToken: signToken,
    readToken: readToken,
    verifyToken: verifyToken,
    KDF_ITER: KDF_ITER
  };
})();
