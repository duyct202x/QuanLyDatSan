// ===== js/data.js =====
// Khung dữ liệu rỗng cho môi trường Vận hành thực tế (Production)
// QUY TẮC: tệp này KHÔNG chứa bất kỳ dữ liệu mẫu/giả định nào (người dùng, thành viên, tài khoản ngân hàng,
// số tiền, lịch sử...). Mọi dữ liệu hiển thị phải do người dùng nhập hoặc tải từ máy chủ.
// Chỉ giữ cấu trúc trường và các tham số vận hành có giá trị trung tính.
const PROD_DEFAULT_DATA = {
  version: "2.9_PROD",
  sheetName: "CSDL_VanHanh_Prod",
  lastModified: 0,

  clubInfo: {
    name: "",
    shortName: "",
    season: "",
    description: "",
    logo: "assets/badminton-logo.svg",
    defaultCourt: "",
    address: "",
    bannerSubtitle: "",
    mapUrl: "",
    monthlyFundFee: 0,
    monthlyFee: 0,
    guestFee: 0,
    voteLockHours: 48,
    bank: {
      bankId: "",
      accountNo: "",
      accountName: "",
      qrTemplate: "compact2"
    },
    benefitsAndRules: []
  },

  // KHÔNG đặt tài khoản/mật khẩu ở đây: tài khoản thật chỉ nằm trên máy chủ.
  users: [],
  currentUser: null,
  members: [],
  sessions: [],
  monthlyContributions: [],
  transactions: [],
  inventory: []
};
;

// ===== js/sync-core.js =====
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
    club: { benefitsAndRules: 'id', voteSchedules: 'id', roles: 'id' }
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

if (typeof module !== 'undefined' && module.exports) module.exports = SyncCore;
;

// ===== js/auth-core.js =====
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

if (typeof module !== 'undefined' && module.exports) module.exports = AuthCore;
;

// ===== js/vote-plan.js =====
// VotePlan - Lịch bình chọn tự động (dùng chung cho trình duyệt và Google Apps Script).
// KHÔNG sửa bản trong google_apps_script_prod.js - chạy `python tools/build_gas_backend.py` để sinh lại.
//
// Lịch lưu ở clubInfo.voteSchedules (mảng theo id, đồng bộ từng phần tử). Mỗi lịch:
//   { id, title, enabled, repeat: 'once'|'weekly'|'monthly',
//     date (once, 'YYYY-MM-DD') | weekday (weekly, 0=CN..6) | monthDay (monthly, 1..31; tháng thiếu ngày -> ngày cuối tháng),
//     startFrom?, until? ('YYYY-MM-DD'), startTime, endTime, courtName, courtNumbers, courtAddress, mapUrl,
//     courtPrice, maxPlayers, shuttleType, note, sessionType, emailNotify,
//     open: { mode: 'now'|'at'|'daysBefore'|'weekday'|'monthday', at, daysBefore, weekday, monthDay, time } }
// Máy chủ tự tạo buổi đánh của lần kế tiếp (mã buổi cố định "auto_<lịch>_<ngày>" -> không bao giờ tạo trùng,
// buổi đã bị xóa không bị tạo lại) và gắn giờ mở vote theo quy tắc `open`.
var VotePlan = (function () {
  var DAY = 86400000;
  var GEN_LEAD_MS = 3 * DAY;        // Tạo buổi trước giờ mở vote 3 ngày (thành viên thấy lịch "sắp mở")
  var GEN_LEAD_NOW_MS = 7 * DAY;    // Lịch "mở ngay khi tạo": tạo buổi trước giờ đánh 7 ngày
  var MAX_AHEAD_DAYS = 70;
  var WEEKDAYS = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
  var REPEATS = { once: 1, weekly: 1, monthly: 1 };
  var OPEN_MODES = { now: 1, at: 1, daysBefore: 1, weekday: 1, monthday: 1 };
  var SAFE_ID = /^[A-Za-z0-9_.:\-]{1,60}$/;
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  var AT_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(str) {
    var m = String(str || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
  }
  function fmt(y, m, d) { return y + '-' + pad(m) + '-' + pad(d); }
  function utcOf(dateStr) { var p = ymd(dateStr); return p ? Date.UTC(p.y, p.m - 1, p.d) : NaN; }
  function fromUtc(ms) { var d = new Date(ms); return fmt(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); }
  function addDays(dateStr, n) { return fromUtc(utcOf(dateStr) + n * DAY); }
  function weekdayOf(dateStr) { return new Date(utcOf(dateStr)).getUTCDay(); }
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
  function clampInt(v, lo, hi, def) {
    var n = Math.floor(Number(v));
    return isNaN(n) ? def : Math.min(hi, Math.max(lo, n));
  }

  // "YYYY-MM-DDTHH:mm" giờ Việt Nam -> ms
  function parseVn(str) {
    var m = String(str || '').trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
    return m ? new Date(m[1] + 'T' + m[2] + ':00+07:00').getTime() : NaN;
  }
  // ms -> "YYYY-MM-DD" theo giờ Việt Nam
  function vnDate(ms) { return new Date(ms + 7 * 3600000).toISOString().slice(0, 10); }
  function timeOr(v, def) { return TIME_RE.test(String(v || '')) ? String(v) : def; }

  function startMs(dateStr, startTime) {
    return parseVn(dateStr + 'T' + timeOr(String(startTime || '').slice(0, 5), '23:59'));
  }

  // Giờ mở vote của buổi đánh ngày dateStr theo quy tắc rule. '' = mở ngay.
  // Luôn trước giờ bắt đầu buổi đánh (nếu không tìm được thời điểm hợp lệ -> '' mở ngay).
  function openAtFor(dateStr, startTime, rule) {
    rule = rule || {};
    var day = ymd(dateStr);
    if (!day) return '';
    var mode = OPEN_MODES[rule.mode] ? rule.mode : 'daysBefore';
    if (mode === 'now') return '';
    var start = startMs(dateStr, startTime);
    var ok = function (at) { var t = parseVn(at); return !isNaN(t) && t < start; };
    if (mode === 'at') return AT_RE.test(String(rule.at || '')) && ok(rule.at) ? String(rule.at) : '';
    var time = timeOr(rule.time, '08:00');

    if (mode === 'weekday') {
      var target = clampInt(rule.weekday, 0, 6, 0);
      for (var back = 0; back <= 14; back++) {
        var cand = addDays(dateStr, -back);
        if (weekdayOf(cand) === target && ok(cand + 'T' + time)) return cand + 'T' + time;
      }
      return '';
    }
    if (mode === 'monthday') {
      var want = clampInt(rule.monthDay, 1, 31, 1), y = day.y, m = day.m;
      for (var i = 0; i < 3; i++) {
        var c = fmt(y, m, Math.min(want, daysInMonth(y, m)));
        if (c <= dateStr && ok(c + 'T' + time)) return c + 'T' + time;
        m -= 1;
        if (m === 0) { m = 12; y -= 1; }
      }
      return '';
    }
    var at = addDays(dateStr, -clampInt(rule.daysBefore, 0, 60, 0)) + 'T' + time;
    return ok(at) ? at : '';
  }

  // Các ngày diễn ra (>= fromDate) của lịch, tối đa `count` ngày, không quá MAX_AHEAD_DAYS
  function occurrences(s, fromDate, count) {
    var out = [];
    if (!s || !REPEATS[s.repeat]) return out;
    var from = s.startFrom && DATE_RE.test(s.startFrom) && s.startFrom > fromDate ? s.startFrom : fromDate;
    var until = s.until && DATE_RE.test(s.until) ? s.until : null;
    var limit = addDays(from, MAX_AHEAD_DAYS);
    if (s.repeat === 'once') {
      if (DATE_RE.test(String(s.date || '')) && s.date >= from && (!until || s.date <= until)) out.push(s.date);
      return out;
    }
    if (s.repeat === 'weekly') {
      var wd = clampInt(s.weekday, 0, 6, 0);
      var d = addDays(from, (wd - weekdayOf(from) + 7) % 7);
      while (out.length < count && d <= limit && (!until || d <= until)) { out.push(d); d = addDays(d, 7); }
      return out;
    }
    var want = clampInt(s.monthDay, 1, 31, 1), p = ymd(from), y = p.y, m = p.m;
    for (var i = 0; i < 4 && out.length < count; i++) {
      var c = fmt(y, m, Math.min(want, daysInMonth(y, m)));
      if (c >= from && c <= limit && (!until || c <= until)) out.push(c);
      m += 1;
      if (m === 13) { m = 1; y += 1; }
    }
    return out;
  }

  // Số sân trong chuỗi "Sân 1 & 2", "Sân 3-5", "Sân 1, 2, 3", "(2 sân)"; không đọc được -> 1
  function courtCount(text) {
    var t = String(text || '');
    var m = t.match(/(\d+)\s*sân/i);
    if (m) return Math.min(30, Math.max(1, +m[1]));
    t = t.replace(/\([^)]*\)/g, ' ');
    var seen = {}, n = 0, r;
    var range = /(\d+)\s*[-–~]\s*(\d+)/g;
    while ((r = range.exec(t))) {
      var a = +r[1], b = +r[2];
      if (b >= a && b - a < 30) for (var i = a; i <= b; i++) if (!seen[i]) { seen[i] = 1; n++; }
    }
    t = t.replace(range, ' ');
    var nums = t.match(/\d+/g) || [];
    nums.forEach(function (x) { if (!seen[+x]) { seen[+x] = 1; n++; } });
    return Math.min(30, Math.max(1, n));
  }

  // Số người đã đăng ký đi (cả khách mang theo); buổi nhiều phương án chỉ tính khi đã chốt phương án
  function headcount(s) {
    var multi = s.voteMode === 'multi_option';
    if (multi && !s.selectedOptionId) return 0;
    return (s.votes || []).reduce(function (sum, v) {
      if (!v || !v.memberId) return sum;
      var going = multi
        ? !v.notGoing && Array.isArray(v.selectedOptions) && v.selectedOptions.indexOf(s.selectedOptionId) !== -1
        : v.status === 'going';
      return going ? sum + 1 + Math.max(0, Math.min(20, Number(v.guests) || 0)) : sum;
    }, 0);
  }

  // Đủ người cho số sân đã đặt? perCourt = số người tối thiểu mỗi sân (>=)
  function courtFull(s, perCourt) {
    var per = Math.min(20, Math.max(2, Math.floor(Number(perCourt)) || 6));
    var courts = courtCount(s.courtNumbers);
    var n = headcount(s);
    return { full: n >= per * courts, count: n, courts: courts, per: per, need: per * courts };
  }

  // Người mở vote của buổi: người tạo buổi > người bấm "Mở vote ngay" > người tạo lịch tự động. '' nếu không rõ
  function ownerOf(s, schedules) {
    if (s.openedBy) return String(s.openedBy);
    var opener = '';
    (s.notices || []).forEach(function (n) { if (n && n.type === 'vote_open' && n.by && n.by !== 'auto') opener = n.by; });
    if (opener) return opener;
    var sc = (schedules || []).filter(function (x) { return x && x.id === s.scheduleId; })[0];
    return sc && sc.createdBy && sc.createdBy !== 'auto' ? String(sc.createdBy) : '';
  }

  function sessionIdFor(s, dateStr) { return 'auto_' + s.id + '_' + dateStr.replace(/-/g, ''); }

  // Buổi đánh của lịch s vào ngày dateStr
  function buildSession(s, dateStr, nowMs, by) {
    var openAt = openAtFor(dateStr, s.startTime, s.open);
    var str = function (v, def) { return typeof v === 'string' && v.trim() ? v.trim() : def; };
    var session = {
      id: sessionIdFor(s, dateStr),
      title: str(s.title, 'Giao lưu cầu lông'),
      sessionType: s.sessionType === 'guest' ? 'guest' : 'fixed',
      voteMode: 'standard',
      maxPlayers: clampInt(s.maxPlayers, 1, 200, 12),
      shuttleType: str(s.shuttleType, 'n/a'),
      note: str(s.note, ''),
      status: 'open',
      date: dateStr,
      startTime: timeOr(s.startTime, '18:00'),
      endTime: timeOr(s.endTime, '20:00'),
      courtName: str(s.courtName, ''),
      courtNumbers: str(s.courtNumbers, ''),
      courtAddress: str(s.courtAddress, ''),
      mapUrl: str(s.mapUrl, ''),
      courtPrice: clampInt(s.courtPrice, 0, 100000000, 0),
      votes: [],
      voteHistory: [],
      voteOpenAt: openAt,
      scheduleId: s.id,
      createdBy: by || 'auto'
    };
    if (s.createdBy && s.createdBy !== 'auto') session.openedBy = String(s.createdBy);
    if (s.emailNotify === false) session.emailNotify = false;
    // Mở ngay khi tạo -> kèm thông báo mở vote (giờ hẹn đã có voteOpenAt, thiết bị & email tự báo khi tới giờ)
    if (!openAt) session.notices = [{ id: 'nt_' + session.id, type: 'vote_open', at: nowMs, by: 'auto' }];
    return session;
  }

  // Thời điểm bắt đầu tạo buổi (trước giờ mở vote GEN_LEAD_MS)
  function generateAtMs(s, dateStr) {
    var openAt = openAtFor(dateStr, s.startTime, s.open);
    return openAt ? parseVn(openAt) - GEN_LEAD_MS : startMs(dateStr, s.startTime) - GEN_LEAD_NOW_MS;
  }

  // Các buổi cần tạo lúc nowMs. exists(id) -> true nếu mã buổi đã có (kể cả đã xóa).
  function dueSessions(schedules, exists, nowMs, by) {
    var today = vnDate(nowMs), out = [];
    (Array.isArray(schedules) ? schedules : []).forEach(function (s) {
      if (!s || !s.enabled || !SAFE_ID.test(String(s.id || ''))) return;
      occurrences(s, today, 6).forEach(function (d) {
        if (startMs(d, s.startTime) <= nowMs || generateAtMs(s, d) > nowMs) return;
        var id = sessionIdFor(s, d);
        if (exists(id)) return;
        out.push(buildSession(s, d, nowMs, by));
      });
    });
    return out;
  }

  // Lần diễn ra kế tiếp (chưa bắt đầu) để hiển thị
  function nextRun(s, nowMs) {
    var list = occurrences(s, vnDate(nowMs), 3).filter(function (d) { return startMs(d, s.startTime) > nowMs; });
    if (!list.length) return null;
    var openAt = openAtFor(list[0], s.startTime, s.open);
    return { date: list[0], openAt: openAt, createAt: Math.max(nowMs, generateAtMs(s, list[0])), sessionId: sessionIdFor(s, list[0]) };
  }

  function label(at) { var m = String(at || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/); return m ? m[4] + ' ngày ' + m[3] + '/' + m[2] : ''; }
  function dmy(d) { var p = ymd(d); return p ? pad(p.d) + '/' + pad(p.m) + '/' + p.y : ''; }

  function describeRepeat(s) {
    var t = timeOr(s.startTime, '18:00') + '–' + timeOr(s.endTime, '20:00');
    if (s.repeat === 'once') return 'Một lần: ' + dmy(s.date) + ' (' + t + ')';
    if (s.repeat === 'weekly') return WEEKDAYS[clampInt(s.weekday, 0, 6, 0)] + ' hằng tuần (' + t + ')';
    return 'Ngày ' + clampInt(s.monthDay, 1, 31, 1) + ' hằng tháng (' + t + ')';
  }
  function describeOpen(rule) {
    rule = rule || {};
    var time = timeOr(rule.time, '08:00');
    if (rule.mode === 'now') return 'Mở vote ngay khi lịch được tạo';
    if (rule.mode === 'at') return 'Mở vote lúc ' + (label(rule.at) || '(chưa chọn)');
    if (rule.mode === 'weekday') return 'Mở vote ' + WEEKDAYS[clampInt(rule.weekday, 0, 6, 0)] + ' lúc ' + time + ' (gần nhất trước buổi đánh)';
    if (rule.mode === 'monthday') return 'Mở vote ngày ' + clampInt(rule.monthDay, 1, 31, 1) + ' lúc ' + time + ' (gần nhất trước buổi đánh)';
    return 'Mở vote trước ' + clampInt(rule.daysBefore, 0, 60, 0) + ' ngày, lúc ' + time;
  }

  // Kiểm tra định dạng lịch (máy chủ dùng cho thành viên được ủy quyền)
  function isStr(v, max) { return v === undefined || v === null || (typeof v === 'string' && v.length <= max); }
  function isNum(v, lo, hi) { return v === undefined || v === null || v === '' || (typeof v === 'number' && v >= lo && v <= hi); }
  function validSchedule(s, id) {
    if (!s || typeof s !== 'object' || Array.isArray(s) || s.id !== id || !SAFE_ID.test(String(id))) return false;
    var allowed = ['id', 'title', 'enabled', 'repeat', 'date', 'weekday', 'monthDay', 'startFrom', 'until', 'startTime', 'endTime',
      'courtName', 'courtNumbers', 'courtAddress', 'mapUrl', 'courtPrice', 'maxPlayers', 'shuttleType', 'note', 'sessionType',
      'emailNotify', 'open', 'createdBy', 'createdAt', 'updatedBy', 'updatedAt', 'fromSessionId'];
    if (!Object.keys(s).every(function (k) { return allowed.indexOf(k) !== -1; })) return false;
    if (!REPEATS[s.repeat] || typeof s.enabled !== 'boolean') return false;
    if (s.repeat === 'once' && !DATE_RE.test(String(s.date || ''))) return false;
    if (s.repeat === 'weekly' && !isNum(s.weekday, 0, 6)) return false;
    if (s.repeat === 'monthly' && !isNum(s.monthDay, 1, 31)) return false;
    if (!TIME_RE.test(String(s.startTime || '')) || !TIME_RE.test(String(s.endTime || ''))) return false;
    if ((s.startFrom && !DATE_RE.test(s.startFrom)) || (s.until && !DATE_RE.test(s.until))) return false;
    if (!isStr(s.title, 100) || !isStr(s.courtName, 150) || !isStr(s.courtNumbers, 100) || !isStr(s.courtAddress, 300) ||
      !isStr(s.shuttleType, 100) || !isStr(s.note, 500) || !isStr(s.createdBy, 100) || !isStr(s.updatedBy, 100) || !isStr(s.fromSessionId, 100)) return false;
    if (s.mapUrl && !(typeof s.mapUrl === 'string' && s.mapUrl.length <= 500 && /^https:\/\/[^\s"'<>]+$/i.test(s.mapUrl))) return false;
    if (!isNum(s.courtPrice, 0, 100000000) || !isNum(s.maxPlayers, 1, 200) || !isNum(s.createdAt, 0, 1e14) || !isNum(s.updatedAt, 0, 1e14)) return false;
    if (s.sessionType !== undefined && s.sessionType !== 'fixed' && s.sessionType !== 'guest') return false;
    if (s.emailNotify !== undefined && typeof s.emailNotify !== 'boolean') return false;
    var o = s.open;
    if (!o || typeof o !== 'object' || !OPEN_MODES[o.mode]) return false;
    if (!Object.keys(o).every(function (k) { return ['mode', 'at', 'daysBefore', 'weekday', 'monthDay', 'time'].indexOf(k) !== -1; })) return false;
    if (o.mode === 'at' && !AT_RE.test(String(o.at || ''))) return false;
    if ((o.time && !TIME_RE.test(o.time)) || !isNum(o.daysBefore, 0, 60) || !isNum(o.weekday, 0, 6) || !isNum(o.monthDay, 1, 31)) return false;
    return true;
  }

  return {
    WEEKDAYS: WEEKDAYS,
    GEN_LEAD_MS: GEN_LEAD_MS,
    parseVn: parseVn,
    vnDate: vnDate,
    addDays: addDays,
    weekdayOf: weekdayOf,
    openAtFor: openAtFor,
    occurrences: occurrences,
    sessionIdFor: sessionIdFor,
    courtCount: courtCount,
    headcount: headcount,
    courtFull: courtFull,
    ownerOf: ownerOf,
    buildSession: buildSession,
    dueSessions: dueSessions,
    nextRun: nextRun,
    describeRepeat: describeRepeat,
    describeOpen: describeOpen,
    validSchedule: validSchedule,
    label: label
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = VotePlan;
;

// ===== js/local-db.js =====
// LocalDB - Kho bền vững trên thiết bị cho đồng bộ v2
// - IndexedDB (dung lượng lớn, không giới hạn ~5MB như localStorage): bản ghi đã xác nhận từ máy chủ + meta.
// - Hàng đợi thay đổi chưa gửi (outbox) ghi ĐỒNG BỘ vào localStorage ngay khi lưu (không mất khi đóng tab đột ngột),
//   đồng thời sao lưu vào IndexedDB phòng khi localStorage đầy.
// - Trình duyệt không hỗ trợ IndexedDB: lưu tạm bằng localStorage.
const LocalDB = {
  DB_NAME: 'SMASH_PRO_SYNC_V2',
  DB_VERSION: 1,
  _db: null,
  _fallback: false,

  _ns() {
    return (typeof window !== 'undefined' && window.__SMASH_DEVICE_NS__) || '';
  },

  async open() {
    if (this._db || this._fallback) return;
    if (typeof indexedDB === 'undefined') { this._fallback = true; return; }
    try {
      this._db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(this._ns() + this.DB_NAME, this.DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('records')) db.createObjectStore('records');
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('IndexedDB bị chặn'));
      });
    } catch (e) {
      console.warn('[LocalDB] Không mở được IndexedDB, dùng localStorage:', e);
      this._fallback = true;
    }
  },

  _range(env) {
    return IDBKeyRange.bound(env + '|', env + '|￿');
  },

  _tx(stores, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction(stores, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Giao dịch IndexedDB bị hủy'));
      result = fn(tx);
    });
  },

  // ---------------- Bản ghi đã xác nhận + meta ----------------
  async loadEnv(env) {
    await this.open();
    if (this._fallback) {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(this._ns() + 'SMASH_PRO_STORE_V2_' + env) || 'null'); } catch (e) {}
      return { records: (saved && saved.records) || {}, meta: (saved && saved.meta) || {} };
    }
    const records = {}, meta = {};
    await this._tx(['records', 'meta'], 'readonly', (tx) => {
      const prefix = env.length + 1;
      tx.objectStore('records').openCursor(this._range(env)).onsuccess = (ev) => {
        const cur = ev.target.result;
        if (!cur) return;
        records[cur.key.slice(prefix)] = cur.value;
        cur.continue();
      };
      tx.objectStore('meta').openCursor(this._range(env)).onsuccess = (ev) => {
        const cur = ev.target.result;
        if (!cur) return;
        meta[cur.key.slice(prefix)] = cur.value;
        cur.continue();
      };
    });
    return { records, meta };
  },

  // Ghi nguyên tử: bản ghi thay đổi + meta (lastSeq...) trong CÙNG một giao dịch
  async write(env, { records = {}, meta = {}, replaceAll = false, allRecords = null }) {
    await this.open();
    if (this._fallback) {
      try {
        let saved = JSON.parse(localStorage.getItem(this._ns() + 'SMASH_PRO_STORE_V2_' + env) || 'null') || { records: {}, meta: {} };
        if (replaceAll) saved.records = {};
        Object.assign(saved.records, allRecords || records);
        Object.assign(saved.meta, meta);
        localStorage.setItem(this._ns() + 'SMASH_PRO_STORE_V2_' + env, JSON.stringify(saved));
      } catch (e) {
        console.warn('[LocalDB] Không lưu được kho dự phòng:', e);
      }
      return;
    }
    await this._tx(['records', 'meta'], 'readwrite', (tx) => {
      const rs = tx.objectStore('records');
      if (replaceAll) rs.delete(this._range(env));
      const recs = allRecords || records;
      Object.keys(recs).forEach((rk) => rs.put(recs[rk], env + '|' + rk));
      const ms = tx.objectStore('meta');
      Object.keys(meta).forEach((k) => ms.put(meta[k], env + '|' + k));
    });
  },

  async clearEnv(env) {
    await this.open();
    this.saveOutbox(env, []);
    if (this._fallback) {
      localStorage.removeItem(this._ns() + 'SMASH_PRO_STORE_V2_' + env);
      return;
    }
    await this._tx(['records', 'meta'], 'readwrite', (tx) => {
      tx.objectStore('records').delete(this._range(env));
      tx.objectStore('meta').delete(this._range(env));
    });
  },

  // ---------------- Hàng đợi thay đổi chưa gửi (outbox) ----------------
  _outboxKey(env) {
    return this._ns() + 'SMASH_PRO_OUTBOX_V2_' + env;
  },

  // Đồng bộ (sync) để đảm bảo thao tác đã ghi nhận trước khi hàm saveData trả về
  saveOutbox(env, ops) {
    let lsOk = true;
    try {
      if (ops.length) localStorage.setItem(this._outboxKey(env), JSON.stringify(ops));
      else localStorage.removeItem(this._outboxKey(env));
    } catch (e) {
      lsOk = false;
      console.warn('[LocalDB] localStorage đầy, outbox chỉ lưu trong IndexedDB:', e);
      try { localStorage.removeItem(this._outboxKey(env)); } catch (e2) {}
    }
    if (this._db) {
      this._tx(['meta'], 'readwrite', (tx) => {
        tx.objectStore('meta').put(ops, env + '|outbox');
      }).catch((e) => console.error('[LocalDB] Lỗi lưu outbox vào IndexedDB:', e));
    } else if (!lsOk) {
      console.error('[LocalDB] Không thể lưu outbox bền vững - thay đổi chỉ còn trong bộ nhớ!');
    }
    return lsOk;
  },

  // Hợp nhất outbox từ localStorage và IndexedDB (theo id, giữ thứ tự n)
  loadOutbox(env, idbOutbox) {
    let ls = [];
    try { ls = JSON.parse(localStorage.getItem(this._outboxKey(env)) || '[]'); } catch (e) {}
    const map = new Map();
    [...(Array.isArray(idbOutbox) ? idbOutbox : []), ...(Array.isArray(ls) ? ls : [])].forEach((op) => {
      if (op && op.id) map.set(op.id, op);
    });
    return Array.from(map.values()).sort((a, b) => (a.n || 0) - (b.n || 0));
  }
};

window.LocalDB = LocalDB;
;

// ===== js/storage.js =====
// Storage & Authentication Manager for SMASH PRO
// Lưu trữ cục bộ (IndexedDB qua LocalDB), Xác thực tài khoản & Đồng bộ Cloud v2
//
// Kiến trúc đồng bộ v2 (local-first):
//  1. Mỗi lần lưu: so sánh dữ liệu với bản lúc loadData() -> sinh "op" chỉ chứa TRƯỜNG thực sự thay đổi.
//  2. Op được ghi ngay vào hàng đợi (outbox) trên thiết bị -> không mất dù mất mạng hay đóng tab.
//  3. Giao diện hiển thị = bản đã xác nhận từ máy chủ + các op đang chờ (cập nhật tức thì, kể cả offline).
//  4. Đồng bộ: gửi op + nhận về các bản ghi thay đổi sau SEQ đã biết (delta) trong cùng một request.
//  5. Máy chủ hợp nhất theo từng trường bằng đồng hồ HLC -> máy cũ không ghi đè dữ liệu mới của máy khác.

const STORAGE_KEY = "SMASH_PRO_BADMINTON_APP_V2"; // CSDL kiểu v1 - chỉ đọc để chuyển sang v2
const AUTH_SESSION_KEY = "SMASH_PRO_AUTH_SESSION_V2";
const ACTIVE_SHEET_KEY = "SMASH_PRO_ACTIVE_SHEET_V2";
const DEVICE_ID_KEY = "SMASH_PRO_DEVICE_ID";
const LEGACY_MIGRATED_KEY = "SMASH_PRO_V2_MIGRATED";
const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzLipFkk47H-Kspe6fNnemgeVUyidTMHRRK8nOB5rmxdpqw4NNVs-U56q6KFYjR6-I/exec";

const AppStorage = {
  googleScriptUrl: GOOGLE_SCRIPT_URL,
  cloudSyncStatus: 'idle', // 'idle' | 'syncing' | 'synced' | 'offline' | 'error'
  lastSyncedTime: null,
  activeSheet: 'CSDL_VanHanh_Prod', // 'CSDL_VanHanh_Prod' | 'CSDL_KiemThu_Test'

  POLL_INTERVAL: 10000,      // Kiểm tra thay đổi từ máy khác (chỉ khi tab đang hiển thị)
  REQUEST_TIMEOUT: 30000,
  MAX_BATCH_OPS: 100,
  MAX_BATCH_CHARS: 2000000,
  BEACON_LIMIT: 60000,
  MASS_DELETE_MIN: 10,       // Chặn lệnh xóa hàng loạt bất thường (lỗi lập trình) trong 1 lần lưu
  BACKUP_INTERVAL: 60 * 60 * 1000,
  BACKUP_KEEP: 10,           // Số bản sao luân phiên giữ trên thiết bị
  MIN_SERVER_API: 3,         // Máy chủ cũ hơn -> không áp dữ liệu (tránh xử lý nhầm khi deploy lệch phiên bản)

  isTestEnvironment() {
    try {
      if (window.__IS_TEST_ENV__ === true) return true;
      if (window.location && (window.location.search.includes('test=true') || window.location.search.includes('test=1') || window.location.search.includes('is_test=true'))) return true;
    } catch(e) {}
    return false;
  },

  getActiveSheet() {
    if (this.isTestEnvironment()) {
      return 'CSDL_KiemThu_Test';
    }
    return localStorage.getItem(ACTIVE_SHEET_KEY) || 'CSDL_VanHanh_Prod';
  },

  // Tháng hiện tại "YYYY-MM" theo giờ Việt Nam
  currentMonth() {
    return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 7);
  },

  // Không gửi lên Cloud (môi trường kiểm thử hoặc chưa cấu hình URL): op áp thẳng vào kho cục bộ
  isLocalOnly() {
    return this.isTestEnvironment() || !this.googleScriptUrl;
  },

  // ==========================================
  // TRẠNG THÁI ĐỒNG BỘ v2
  // ==========================================
  _env: null,
  _confirmed: {},     // recKey -> bản ghi đã được máy chủ xác nhận
  _working: {},       // = _confirmed + các op trong outbox (hiển thị lạc quan)
  _outbox: [],        // op chưa được máy chủ xác nhận (theo thứ tự)
  _meta: { lastSeq: 0, clockOffset: 0, lastBackupAt: 0 },
  _viewJson: null,
  _viewObj: null,
  _loadedBase: new WeakMap(), // data object -> chuỗi JSON lúc được loadData() trả về
  _clock: null,
  _opCounter: 0,
  _ready: null,
  _syncPromise: null,
  _syncTimer: null,
  _pollTimer: null,
  _syncAgain: false,
  _syncFull: false,
  _failCount: 0,
  _channel: null,
  _listenersInstalled: false,

  _ns() {
    return (typeof window !== 'undefined' && window.__SMASH_DEVICE_NS__) || '';
  },

  deviceId() {
    const key = this._ns() + DEVICE_ID_KEY;
    let id = localStorage.getItem(key);
    if (!id) {
      id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      localStorage.setItem(key, id);
    }
    return id;
  },

  // Khởi tạo hệ thống lưu trữ & đồng bộ (trả về Promise - App phải chờ trước khi hiển thị dữ liệu)
  init() {
    if (!this._ready) this._ready = this._init();
    return this._ready;
  },

  async _init() {
    this.activeSheet = this.getActiveSheet();
    this._clock = SyncCore.createClock(this.deviceId());
    try {
      await this._loadEnv(this.activeSheet);
      await this._migrateLegacyV1();
    } catch (e) {
      console.error('[Storage] Lỗi khởi tạo kho cục bộ:', e);
    }
    this._installListeners();
    this._pruneTokens();
    this._refreshBadge();
    this.requestSync(0);
  },

  async _loadEnv(env) {
    this._env = env;
    const { records, meta } = await LocalDB.loadEnv(env);
    this._confirmed = records;
    this._meta = {
      lastSeq: Number(meta.lastSeq) || 0,
      viewer: meta.viewer || '',
      scope: meta.scope || '',
      clockOffset: Number(meta.clockOffset) || 0,
      lastBackupAt: Number(meta.lastBackupAt) || 0
    };
    this._backups = this._cleanBackups(meta.backups);
    if (Array.isArray(meta.backups) && this._backups.length !== meta.backups.length) {
      LocalDB.write(this._env, { meta: { backups: this._backups } }).catch(() => {});
    }
    this._legacyBackups = { legacyBackup: meta.legacyBackup || null, backup: meta.backup || null };
    this._serverWarning = null;
    this._outbox = LocalDB.loadOutbox(env, meta.outbox);
    this._opCounter = this._outbox.reduce((m, op) => Math.max(m, op.n || 0), 0);
    this._clock.setOffset(this._meta.clockOffset);
    Object.keys(records).forEach((rk) => this._clock.observe(SyncCore.recordHlcMax(records[rk])));
    this._outbox.forEach((op) => this._clock.observe(op.h));
    this._rebuildWorking();
  },

  // Chuyển CSDL kiểu v1 (1 khối JSON trong localStorage) sang kho v2 - chạy 1 lần trên mỗi thiết bị
  async _migrateLegacyV1() {
    const flagKey = this._ns() + LEGACY_MIGRATED_KEY;
    if (localStorage.getItem(flagKey)) return;
    const raw = localStorage.getItem(STORAGE_KEY);
    let legacy = null;
    try { legacy = raw ? JSON.parse(raw) : null; } catch (e) {}
    const pending = localStorage.getItem(`SMASH_PRO_PENDING_PUSH_${this._env}`) === '1';

    // Giải phóng localStorage (v1 giữ tới 7 bản sao toàn bộ CSDL -> dễ đầy bộ nhớ và lưu thất bại âm thầm)
    [STORAGE_KEY, 'SMASH_PRO_AUTO_BACKUP_PRIMARY', 'SMASH_PRO_AUTO_BACKUP_HISTORY',
      'SMASH_PRO_PENDING_PUSH_CSDL_VanHanh_Prod', 'SMASH_PRO_PENDING_PUSH_CSDL_KiemThu_Test',
      'SMASH_PRO_CLOUD_REV_CSDL_VanHanh_Prod', 'SMASH_PRO_CLOUD_REV_CSDL_KiemThu_Test'
    ].forEach((k) => localStorage.removeItem(k));

    if (legacy && !legacy.isInitialSkeleton && typeof legacy === 'object') {
      delete legacy.currentUser;
      if (!Object.keys(this._confirmed).length && !this._meta.lastSeq) {
        // Dùng tạm dữ liệu cũ để làm việc offline; lần tải đầy đủ đầu tiên từ máy chủ sẽ thay thế
        const recs = {};
        SyncCore.applyOps(recs, SyncCore.legacySnapshotToOps(legacy, 'legacy'));
        this._confirmed = recs;
        await LocalDB.write(this._env, { allRecords: recs, replaceAll: true, meta: { legacyBackup: raw } });
      } else {
        await LocalDB.write(this._env, { meta: { legacyBackup: raw } });
      }
      // Thay đổi v1 chưa kịp gửi: gửi nguyên ảnh chụp, máy chủ hợp nhất theo từng trường (không đè dữ liệu mới hơn)
      if (pending && !this.isLocalOnly()) {
        this._enqueue([{ t: 'legacy', snap: legacy }], false);
      } else {
        this._rebuildWorking();
      }
    }
    localStorage.setItem(flagKey, '1');
  },

  _installListeners() {
    if (this._listenersInstalled || typeof window === 'undefined') return;
    this._listenersInstalled = true;
    window.addEventListener('online', () => this.requestSync(0));
    window.addEventListener('offline', () => this._refreshBadge('offline'));
    window.addEventListener('focus', () => this.requestSync(0));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.requestSync(0);
      else this._flushBeacon();
    });
    window.addEventListener('pagehide', () => this._flushBeacon());

    // Đồng bộ giữa nhiều tab trên cùng thiết bị
    if (typeof BroadcastChannel !== 'undefined') {
      this._channel = new BroadcastChannel(this._ns() + 'smash-pro-sync-v2');
      this._channel.onmessage = (ev) => {
        if (!ev.data || ev.data.env !== this._env || ev.data.from === this._tabId) return;
        this._loadEnv(this._env).then(() => this._emitChanged()).catch(() => {});
      };
    }
  },

  _tabId: Math.random().toString(36).slice(2),

  _broadcast() {
    try { if (this._channel) this._channel.postMessage({ env: this._env, from: this._tabId }); } catch (e) {}
  },

  // ==========================================
  // KHO & GIAO DIỆN DỮ LIỆU
  // ==========================================
  _cloneRec(r) {
    return { d: Object.assign({}, r.d), f: Object.assign({}, r.f), x: r.x || '', c: r.c || '', s: r.s || 0 };
  },

  // Áp op lên bản làm việc, sao chép bản ghi trước khi sửa để không đụng vào _confirmed
  _applyToWorking(w, ops, owned) {
    const own = (rk) => {
      if (owned.has(rk)) return;
      if (w[rk]) w[rk] = this._cloneRec(w[rk]);
      owned.add(rk);
    };
    ops.forEach((op) => {
      if (op.t === 'legacy') {
        this._applyToWorking(w, SyncCore.legacySnapshotToOps(op.snap, 'legacy'), owned);
      } else if (op.t === 'reset') {
        Object.keys(w).forEach(own);
        SyncCore.applyOps(w, [op]);
      } else {
        own(SyncCore.recKey(op.col, String(op.key)));
        SyncCore.applyOps(w, [op]);
      }
    });
  },

  _rebuildWorking() {
    const w = Object.assign({}, this._confirmed);
    this._ownedWorking = new Set();
    this._applyToWorking(w, this._outbox, this._ownedWorking);
    this._working = w;
    this._invalidateView();
  },

  _invalidateView() {
    this._viewJson = null;
    this._viewObj = null;
  },

  // Dữ liệu dạng ứng dụng (đã chuẩn hóa) - được đệm lại, chỉ dựng lại khi kho thay đổi
  _getViewJson() {
    if (this._viewJson) return this._viewJson;
    const defaults = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA));
    const neverSynced = !this._meta.lastSeq && !Object.keys(this._working).length;
    let data = defaults;
    if (!neverSynced) {
      const built = SyncCore.buildCollections(this._working);
      data = Object.assign({}, defaults, built);
      data.clubInfo = Object.assign({}, defaults.clubInfo, built.clubInfo || {});
    }
    data.currentUser = null;
    data.mode = 'production';
    data.sheetName = this._env || this.activeSheet;
    data.lastModified = this._meta.lastSeq;
    data.isInitialSkeleton = neverSynced;
    data.deletedMemberIds = [];
    data.deletedUserIds = [];
    this.sanitizeProductionData(data);
    this.reconcileUsersAndMembers(data);
    this._applyDuesPrivacy(data);
    data.currentUser = null;
    this._viewJson = JSON.stringify(data);
    return this._viewJson;
  },

  // Quỹ tháng: chỉ Admin/Thủ quỹ thấy của mọi người; thành viên khác chỉ thấy phiếu của mình,
  // dòng thu quỹ của người khác trong sổ thu chi bị ẩn tên (máy chủ cũng lọc như vậy).
  _applyDuesPrivacy(data) {
    const s = this._readSession();
    if (s && (s.role === 'admin' || s.role === 'treasurer')) return;
    const myMember = s && s.memberId;
    data.monthlyContributions = (data.monthlyContributions || []).filter((d) => myMember && d.memberId === myMember);
    data.transactions = (data.transactions || []).map((t) => {
      if (!t || !t.dueId || (myMember && String(t.dueId).endsWith('_' + myMember))) return t;
      const c = Object.assign({}, t, { title: 'Thu quỹ tháng' });
      delete c.dueId; delete c.note; delete c.createdBy;
      return c;
    });
  },

  _getViewObj() {
    if (!this._viewObj) this._viewObj = JSON.parse(this._getViewJson());
    return this._viewObj;
  },

  _emitChanged() {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent("app-state-changed", { detail: this.loadData() }));
  },

  // Tương thích mã cũ: cấu trúc CSDL nay được bảo đảm khi dựng dữ liệu hiển thị
  ensureDatabaseSchema() {},

  // 1. Kiểm tra và làm sạch đối tượng hỏng kỹ thuật & rác kiểm thử (Bảo vệ 100% bản ghi người dùng hợp lệ)
  sanitizeProductionData(data) {
    if (!data) return data;
    if (typeof data !== 'object') return data;
    const isTest = this.isTestEnvironment();
    const deletedMemberIds = new Set(Array.isArray(data.deletedMemberIds) ? data.deletedMemberIds : []);
    const deletedUserIds = new Set(Array.isArray(data.deletedUserIds) ? data.deletedUserIds : []);

    // Lọc users: Giữ lại toàn bộ tài khoản hợp lệ, khử trùng lặp và loại bỏ tài khoản kiểm thử rác hoặc đã bị xóa
    if (Array.isArray(data.users)) {
      const isTestUser = (u) => {
        if (!u || (!u.id && !u.username)) return true;
        const id = String(u.id || '');
        const un = String(u.username || '').toLowerCase();
        if (un === 'admin' || id === 'user_admin') return false; // Luôn giữ admin
        if (deletedUserIds.has(id) || deletedUserIds.has(un) || (u.memberId && deletedMemberIds.has(u.memberId))) return true;
        if (isTest) return false;
        // Danh sách ID/Username test hoặc giả định cần loại trừ tận gốc
        const mockUserIds = new Set([
          'user_maianh', 'user_hoanglong', 'user_minhduc', 'user_thaovy', 'user_giahuy', 
          'user_thanhson', 'user_tuyetnhi', 'user_tuankiet', 'user_baohung', 'user_dcatrus', 
          'user_baonam', 'user_vanhau', 'user_regular', 'u_regular', 'user_audit_1', 
          'user_quanghien', 'user_vihieu', 'user_tuannv', 'user_1790479550427'
        ]);
        const mockUsernames = new Set([
          'maianh', 'hoanglong', 'minhduc', 'thaovy', 'giahuy', 'thanhson', 'tuyetnhi', 
          'tuankiet', 'baohung', 'dcatrus', 'baonam', 'vanhau', 'quanghien', 'vihieu', 
          'tuannv', '0912345678', 'test_garbage', 'thanhvien1'
        ]);
        if (id.startsWith('user_test_') || mockUserIds.has(id)) return true;
        if (un.startsWith('test_user_') || un.startsWith('test_') || mockUsernames.has(un)) return true;
        return false;
      };

      const userMap = new Map();
      data.users.forEach(u => {
        if (!u || (!u.id && !u.username)) return;
        if (isTestUser(u)) return;
        const key = u.username || u.id;
        if (!userMap.has(key)) {
          userMap.set(key, { ...u });
        }
      });
      data.users = Array.from(userMap.values());
    } else {
      data.users = [];
    }

    // Lọc members: Giữ lại toàn bộ thành viên hợp lệ, khử trùng lặp và loại bỏ thành viên kiểm thử rác hoặc đã bị xóa
    if (Array.isArray(data.members)) {
      const isTestMember = (m) => {
        if (!m || (!m.id && !m.name && !m.phone)) return true;
        const id = String(m.id || '');
        const un = String(m.username || '').toLowerCase();
        if (id === 'mem_admin' || un === 'admin') return false; // Luôn giữ admin
        if (deletedMemberIds.has(id) || (m.username && deletedUserIds.has(m.username))) return true;
        if (isTest) return false;
        // Danh sách ID/Username test hoặc giả định cần loại trừ tận gốc
        const mockMemberIds = new Set([
          'mem_maianh', 'mem_hoanglong', 'mem_minhduc', 'mem_thaovy', 'mem_giahuy', 
          'mem_thanhson', 'mem_tuyetnhi', 'mem_tuankiet', 'mem_baohung', 'mem_1790412027160', 
          'mem_1790414367290', 'mem_vanhau', 'mem_regular', 'mem_audit_user', 'mem_quanghien', 
          'mem_vihieu', 'mem_tuannv', 'mem_1790479550427'
        ]);
        const mockUsernames = new Set([
          'maianh', 'hoanglong', 'minhduc', 'thaovy', 'giahuy', 'thanhson', 'tuyetnhi', 
          'tuankiet', 'baohung', 'dcatrus', 'baonam', 'vanhau', 'quanghien', 'vihieu', 
          'tuannv', '0912345678', 'thanhvien1'
        ]);
        if (id.startsWith('mem_test_') || mockMemberIds.has(id)) return true;
        if (un.startsWith('test_') || mockUsernames.has(un) || (m.name === 'Nguyễn Văn Thành Viên' && m.phone === '0933112233')) return true;
        return false;
      };

      const memberMap = new Map();
      data.members.forEach(m => {
        if (!m || (!m.id && !m.name && !m.phone)) return;
        if (isTestMember(m)) return;
        const key = m.id || m.username || (m.phone ? m.phone.replace(/\D/g, '') : null) || m.name;
        if (!memberMap.has(key)) {
          memberMap.set(key, { ...m });
        }
      });
      data.members = Array.from(memberMap.values());
    } else {
      data.members = [];
    }

    // Lọc sessions: Bảo toàn 100% ca đánh hợp lệ, loại bỏ ca đánh rác kiểm thử hoặc mẫu giả định
    if (Array.isArray(data.sessions)) {
      data.sessions = data.sessions.filter(s => {
        if (!s || !s.id) return false;
        if (isTest) return true;
        const id = String(s.id);
        if (id.startsWith('session_test_') || id.startsWith('ses_test_') || id === 'ses_1790413607618') return false;
        return true;
      });
    } else {
      data.sessions = [];
    }

    // Lọc monthlyContributions: Bảo toàn 100% bản ghi đóng quỹ hợp lệ (thuộc thành viên hiện có)
    // NGHIÊM NGẶT: Chống tự ý ghi nhận 'paid' khi không có chứng từ/giao dịch thực tế
    const validMemberIds = new Set(data.members.map(m => m.id));
    const txDueIds = new Set((data.transactions || []).filter(t => t && t.dueId).map(t => t.dueId));
    if (Array.isArray(data.monthlyContributions)) {
      data.monthlyContributions = data.monthlyContributions.filter(d => d && d.memberId && validMemberIds.has(d.memberId)).map(d => {
        // Nếu bản ghi ghi nhận paid nhưng không có biên lai VÀ không có giao dịch trong Sổ quỹ -> Đặt lại unpaid
        if (d.status === 'paid' && !d.billImage && !txDueIds.has(d.id)) {
          return {
            ...d,
            status: 'unpaid',
            paidAt: null,
            method: null,
            billImage: null,
            approvedBy: null,
            approvedAt: null,
            note: 'Chưa đóng'
          };
        }
        return d;
      });
    } else {
      data.monthlyContributions = [];
    }

    // Lọc transactions: Bảo toàn 100% giao dịch sổ quỹ hợp lệ do người dùng tạo, loại bỏ triệt để probe, rác kiểm thử & giao dịch mẫu giả định
    if (Array.isArray(data.transactions)) {
      const mockTxIds = new Set(['tx_prod_1', 'tx_prod_2', 'tx_prod_3', 'tx_prod_4', 'tx_prod_5', 'tx_prod_6', 'tx_1790446297818']);
      const isGarbageTx = (t) => {
        if (!t || !t.id) return true;
        if (isTest) return false;
        const strId = String(t.id);
        const title = (t.title || t.description || '').toLowerCase().trim();
        if (mockTxIds.has(strId)) return true;
        if (strId.startsWith('realtime_audit_probe_') || strId.startsWith('tx_test_') || strId === 'tx_1790423944296' || strId === 'tx_test_garbage') return true;
        if (title === 'cxasxa' || title === 's' || title === '' || t.category === 'audit_probe') return true;
        if (typeof t.amount !== 'number' || isNaN(t.amount) || t.amount <= 0) return true;
        if (t.type !== 'income' && t.type !== 'expense') return true;
        return false;
      };
      data.transactions = data.transactions.filter(t => !isGarbageTx(t));
    } else {
      data.transactions = [];
    }

    return data;
  },

  // 2. Cơ chế Đối soát & Đồng bộ 2 chiều tuyệt đối giữa Users (Tài khoản) và Members (Danh bạ)
  reconcileUsersAndMembers(data) {
    if (!data) return data;
    if (!Array.isArray(data.users)) data.users = [];
    if (!Array.isArray(data.members)) data.members = [];

    // Đồng bộ từng user với member (mật khẩu chỉ nằm trên máy chủ, không tự gán mật khẩu mặc định)
    data.users.forEach(user => {
      if (!user) return;
      // Tìm member tương ứng
      let member = data.members.find(m => 
        (user.memberId && m.id === user.memberId) || 
        (user.username && m.username === user.username) ||
        (user.phone && m.phone && user.phone.replace(/\D/g, '') === m.phone.replace(/\D/g, ''))
      );

      if (member) {
        // Đồng bộ dữ liệu nhất quán 100%
        user.memberId = member.id;
        member.username = user.username;
        member.name = user.name;
        member.phone = user.phone || member.phone || '';
        if (user.email) member.email = user.email;
        if (user.avatar) member.avatar = user.avatar;
        if (user.note !== undefined) member.note = user.note;
        member.role = user.role;
        member.type = user.type || member.type || 'fixed';
      }
    });

    // 3. Làm sạch triệt để các bản ghi đóng quỹ mồ côi và đảm bảo 1:1 với thành viên cố định
    if (!Array.isArray(data.monthlyContributions)) data.monthlyContributions = [];
    if (Array.isArray(data.members)) {
      const activeFixedMembers = data.members.filter(m => m.type === 'fixed');
      const activeFixedMemberIds = new Set(activeFixedMembers.map(m => m.id));
      // Loại bỏ mồ côi
      data.monthlyContributions = data.monthlyContributions.filter(d => d && d.memberId && activeFixedMemberIds.has(d.memberId));
      
      const currentMonth = this.currentMonth();
      const monthlyFee = Number(data.clubInfo?.monthlyFee || data.clubInfo?.monthlyFundFee) || 0;
      if (monthlyFee > 0) activeFixedMembers.forEach(m => {
        const hasDue = data.monthlyContributions.some(d => d.month === currentMonth && d.memberId === m.id);
        if (!hasDue) {
          data.monthlyContributions.push({
            id: `due_${currentMonth}_${m.id}`,
            month: currentMonth,
            memberId: m.id,
            amount: monthlyFee,
            status: "unpaid",
            paidAt: null,
            method: null,
            billImage: null,
            approvedBy: null,
            approvedAt: null,
            note: "Chưa đóng"
          });
        }
      });
    }

    // 4. Làm sạch triệt để các phiếu bình chọn mồ côi, khử trùng lặp 1 người 1 vote & Chuẩn hóa memberId
    if (Array.isArray(data.sessions) && Array.isArray(data.members)) {
      const activeMemberIds = new Set(data.members.map(m => m.id));
      const activeUserIds = new Set((data.users || []).map(u => u.id));
      const userToMemberMap = new Map();
      (data.users || []).forEach(u => {
        if (u.id && u.memberId) userToMemberMap.set(u.id, u.memberId);
        if (u.username && u.memberId) userToMemberMap.set(u.username, u.memberId);
      });

      data.sessions.forEach(s => {
        if (!Array.isArray(s.voteHistory)) s.voteHistory = [];

        if (Array.isArray(s.votes)) {
          // Chuẩn hóa mọi phiếu vote cũ có v.memberId là userId/username thành memberId chuẩn
          s.votes.forEach(v => {
            if (v && v.memberId && userToMemberMap.has(v.memberId)) {
              v.memberId = userToMemberMap.get(v.memberId);
            }
          });

          // Khử trùng lặp triệt để: Mỗi thành viên chỉ có DUY NHẤT 1 phiếu bình chọn hiện tại (1 member = 1 active vote)
          const voteMap = new Map();
          s.votes.forEach(v => {
            if (v && v.memberId && (activeMemberIds.has(v.memberId) || activeUserIds.has(v.memberId))) {
              if (voteMap.has(v.memberId)) {
                const prev = voteMap.get(v.memberId);
                // Giữ bản ghi mới hơn
                if ((v.votedAt || '') >= (prev.votedAt || '')) {
                  voteMap.set(v.memberId, v);
                }
              } else {
                voteMap.set(v.memberId, v);
              }
            }
          });
          s.votes = Array.from(voteMap.values());

          // Lịch sử bình chọn chỉ gồm thao tác thật của người dùng (không tự sinh)
        } else {
          s.votes = [];
        }
      });
    }

    // 5. Làm sạch triệt để các giao dịch rác thử nghiệm & Khử trùng lặp thu quỹ tháng
    if (Array.isArray(data.transactions)) {
      const isTest = this.isTestEnvironment();
      const isGarbageTx = (t) => {
        if (!t || !t.id) return true;
        if (isTest) return false;
        const strId = String(t.id);
        const title = (t.title || t.description || '').toLowerCase().trim();
        if (strId.startsWith('realtime_audit_probe_') || strId.startsWith('tx_test_') || strId === 'tx_1790423944296' || strId === 'tx_test_garbage') return true;
        if (title === 'cxasxa' || title === 's' || title === '' || t.category === 'audit_probe') return true;
        if (typeof t.amount !== 'number' || isNaN(t.amount) || t.amount <= 0) return true;
        if (t.type !== 'income' && t.type !== 'expense') return true;
        return false;
      };
      data.transactions = data.transactions.filter(t => !isGarbageTx(t));

      // Khử trùng lặp giao dịch thu quỹ theo dueId (1 dueId chỉ có duy nhất 1 bản ghi thu quỹ)
      const dueTxMap = new Map();
      const cleanTxs = [];
      data.transactions.forEach(t => {
        if (t.dueId) {
          if (!dueTxMap.has(t.dueId)) {
            dueTxMap.set(t.dueId, t);
            cleanTxs.push(t);
          }
        } else {
          cleanTxs.push(t);
        }
      });
      data.transactions = cleanTxs;
    }

    // 6. Nếu user đang đăng nhập (currentUser), đồng bộ chính xác với bản ghi user trong users
    if (data.currentUser) {
      const liveUser = data.users.find(u => u.id === data.currentUser.id || u.username === data.currentUser.username);
      if (liveUser) {
        data.currentUser = liveUser;
      }
    }

    return data;
  },

  // Tải toàn bộ CSDL (bản sao riêng - module được phép sửa rồi gọi saveData)
  loadData() {
    const json = this._getViewJson();
    const parsed = JSON.parse(json);
    parsed.currentUser = this.getCurrentUser();
    this._loadedBase.set(parsed, json); // Mốc so sánh để saveData chỉ gửi phần thay đổi
    return parsed;
  },

  // Sinh op từ thay đổi của người dùng và đưa vào hàng đợi. Trả về danh sách op.
  commitLocal(data, { sync = true } = {}) {
    if (!data || typeof data !== 'object') return [];
    const baseJson = this._loadedBase.get(data) || this._getViewJson();
    const base = JSON.parse(baseJson);
    const h = this._clock ? this._clock.now() : SyncCore.hlcPack(Date.now(), 0, 'boot');
    let ops = SyncCore.diffData(base, data, h, (col, key) => !!this._working[SyncCore.recKey(col, key)]);

    // Chốt chặn: một lần lưu xóa quá nửa bộ sưu tập (>= 10 bản ghi) gần như chắc chắn là lỗi -> bỏ lệnh xóa
    SyncCore.COLLECTIONS.forEach((col) => {
      const dels = ops.filter((o) => o.col === col && o.t === 'del');
      const total = Array.isArray(base[col]) ? base[col].length : 0;
      if (dels.length >= this.MASS_DELETE_MIN && dels.length * 2 > total) {
        console.error(`[Storage] Chặn xóa hàng loạt ${dels.length}/${total} bản ghi "${col}" trong một lần lưu.`);
        ops = ops.filter((o) => !(o.col === col && o.t === 'del'));
        if (window.App) App.showToast(`⚠️ Đã chặn thao tác xóa hàng loạt bất thường (${col}). Dữ liệu được giữ nguyên.`, "warning");
      }
    });

    // Lần lưu tiếp theo trên cùng đối tượng chỉ so với trạng thái vừa lưu
    this._loadedBase.set(data, JSON.stringify(data));
    if (!ops.length) return [];
    this._enqueue(ops, sync);
    return ops;
  },

  _enqueue(ops, sync = true) {
    ops.forEach((op) => {
      this._opCounter++;
      op.id = `${this.deviceId()}_${Date.now().toString(36)}_${this._opCounter}`;
      op.n = this._opCounter;
      op.u = this._currentUsername();
    });

    if (this.isLocalOnly()) {
      const changed = {};
      const expanded = [];
      ops.forEach((op) => {
        if (op.t === 'legacy') expanded.push(...SyncCore.legacySnapshotToOps(op.snap, 'legacy'));
        else expanded.push(op);
      });
      SyncCore.applyOps(this._confirmed, expanded).forEach((rk) => { changed[rk] = this._confirmed[rk]; });
      LocalDB.write(this._env, { records: changed }).catch((e) => console.error('[Storage] Lỗi lưu cục bộ:', e));
      this._rebuildWorking();
    } else {
      this._outbox.push(...ops);
      const durable = LocalDB.saveOutbox(this._env, this._outbox);
      if (!durable && !LocalDB._db && window.App) {
        App.showToast("⚠️ Bộ nhớ trình duyệt đã đầy, thay đổi chưa được lưu bền vững. Hãy kết nối mạng để đồng bộ ngay!", "error");
      }
      this._applyToWorking(this._working, ops, this._ownedWorking || (this._ownedWorking = new Set()));
      this._invalidateView();
    }

    this._emitChanged();
    this._broadcast();
    this._refreshBadge();
    if (sync) this.requestSync(300);
  },

  // Lưu toàn bộ CSDL: ghi nhận ngay trên thiết bị, tự đồng bộ nền khi có mạng
  saveData(data, syncToCloud = true) {
    try {
      this.commitLocal(data, { sync: syncToCloud });
    } catch (e) {
      console.error("Lỗi lưu CSDL:", e);
      if (window.App) App.showToast("❌ Không thể lưu thay đổi: " + e.message, "error");
    }
  },

  // Lưu CSDL và chờ máy chủ xác nhận (Two-Phase Cloud Sync Acknowledgment)
  async saveDataWithCloudAck(data, options = {}) {
    try {
      const ops = this.commitLocal(data, { sync: false });
      if (this.isLocalOnly()) {
        return { success: true, isTest: true, message: "Đã lưu an toàn (Chế độ Test/Offline)" };
      }
      const ids = new Set(ops.map((o) => o.id));
      await this.syncNow();
      const stillPending = this._outbox.some((o) => ids.has(o.id));
      if (!stillPending) {
        return {
          success: true,
          message: "Đã ghi nhận và lưu vĩnh viễn vào CSDL Cloud!",
          lastSyncedTime: this.lastSyncedTime
        };
      }
      return {
        success: false,
        error: "Không thể kết nối máy chủ database",
        message: "Dữ liệu đã được lưu an toàn trên máy bạn và sẽ tự đồng bộ khi có mạng."
      };
    } catch (e) {
      console.error("Lỗi saveDataWithCloudAck:", e);
      return { success: false, error: e.message, message: "Lỗi xử lý dữ liệu: " + e.message };
    }
  },

  // ==========================================
  // HỆ THỐNG XÁC THỰC & QUẢN LÝ NGƯỜI DÙNG (AUTH)
  // Mật khẩu chỉ được kiểm tra trên máy chủ. Máy chủ cấp token (ký HMAC); mọi thay đổi gửi lên phải kèm token
  // và được máy chủ kiểm quyền. Trình duyệt không còn giữ/so khớp mật khẩu của bất kỳ ai.
  // ==========================================

  // Thiết bị KHÔNG tick "Duy trì đăng nhập" (máy dùng chung): tự đăng xuất sau 30 phút không thao tác, và khi đóng trình duyệt
  INACTIVITY_TIMEOUT: 30 * 60 * 1000,
  // Tick "Duy trì đăng nhập": không bị đăng xuất vì không thao tác; phiên sống tới khi token hết hạn (máy chủ quyết định:
  // 30 ngày thành viên / 7 ngày Ban quản trị) và được gia hạn trượt mỗi khi dùng ứng dụng.
  SESSION_REMEMBER_TTL: 30 * 24 * 60 * 60 * 1000,
  SESSION_TEMP_TTL: 8 * 60 * 60 * 1000,
  REFRESH_CHECK_MS: 30 * 60 * 1000,

  _authKey() {
    return this._ns() + AUTH_SESSION_KEY;
  },

  _readSession() {
    try {
      const raw = sessionStorage.getItem(this._authKey()) || localStorage.getItem(this._authKey());
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  },

  _writeSession(session) {
    const key = this._authKey();
    if (session.remember) {
      localStorage.setItem(key, JSON.stringify(session));
      sessionStorage.removeItem(key);
    } else {
      sessionStorage.setItem(key, JSON.stringify(session));
      localStorage.removeItem(key);
    }
  },

  // ---- Token theo tài khoản (giữ lại tới khi các thay đổi chờ gửi của tài khoản đó đã đồng bộ xong) ----
  _tokensKey() {
    return this._ns() + 'SMASH_PRO_TOKENS_V2';
  },
  _getTokens() {
    try { return JSON.parse(localStorage.getItem(this._tokensKey()) || '{}') || {}; } catch (e) { return {}; }
  },
  _setTokens(map) {
    if (Object.keys(map).length) localStorage.setItem(this._tokensKey(), JSON.stringify(map));
    else localStorage.removeItem(this._tokensKey());
  },
  _tokenValid(token) {
    const p = AuthCore.readToken(token);
    return !!(p && Number(p.exp) > Date.now());
  },
  // Bỏ token của tài khoản không còn đăng nhập và không còn thay đổi chờ gửi
  _pruneTokens() {
    const session = this._readSession();
    const active = session && session.username;
    const pendingUsers = new Set(this._outbox.map((op) => op.u).filter(Boolean));
    const map = this._getTokens();
    Object.keys(map).forEach((u) => {
      if ((u !== active && !pendingUsers.has(u)) || !this._tokenValid(map[u])) delete map[u];
    });
    this._setTokens(map);
  },

  _currentUsername() {
    const s = this._readSession();
    return s && s.username ? s.username : null;
  },

  // Lấy thông tin tài khoản đang đăng nhập hiện tại (An toàn, kiểm tra TTL, Inactivity & token máy chủ)
  getCurrentUser() {
    try {
      const session = this._readSession();
      if (!session) return null; // Chế độ Khách vãng lai (Guest)
      const now = Date.now();

      // 1. Kiểm tra thời hạn sống tuyệt đối của phiên (Session TTL)
      if (session.expiresAt && now > session.expiresAt) {
        console.warn("[Auth] Phiên đăng nhập đã hết hạn TTL. Tự động đăng xuất.");
        this.logout(false);
        return null;
      }

      // 2. Kiểm tra thời gian không hoạt động (chỉ áp dụng cho phiên KHÔNG duy trì đăng nhập)
      if (!session.remember && session.lastActivity && (now - session.lastActivity > this.INACTIVITY_TIMEOUT)) {
        console.warn("[Auth] Quá 30 phút không có thao tác. Tự động đăng xuất.");
        this.logout(false);
        return null;
      }

      // 3. Phiên phải do máy chủ cấp (phiên cũ trước bản cập nhật bảo mật -> đăng nhập lại)
      if (!this.isLocalOnly() && !this._tokenValid(session.token)) {
        console.warn("[Auth] Phiên không có token hợp lệ từ máy chủ. Vui lòng đăng nhập lại.");
        this.logout(false);
        return null;
      }

      // 4. Truy vấn thông tin người dùng trong CSDL
      const view = this._getViewObj();
      const user = (view.users || []).find(u => u.id === session.id || u.username === session.username);
      if (user) {
        const copy = JSON.parse(JSON.stringify(user));
        delete copy.password;
        delete copy.pwv;
        return copy;
      }
      // Vừa đăng nhập/đăng ký, dữ liệu chưa tải về kịp: dùng thông tin máy chủ trả về lúc đăng nhập
      if (session.user) return JSON.parse(JSON.stringify(session.user));
    } catch (e) {
      console.error("Lỗi xác thực phiên đăng nhập:", e);
    }
    return null;
  },

  // Tài khoản đang dùng mật khẩu yếu -> bắt buộc đổi trước khi được ghi dữ liệu
  mustChangePassword() {
    const s = this._readSession();
    return !!(s && s.mustChange && this.getCurrentUser());
  },

  // Cập nhật timestamp hoạt động người dùng (Gia hạn thời gian Inactivity)
  touchActivity() {
    try {
      const session = this._readSession();
      if (!session) return;
      session.lastActivity = Date.now();
      this._writeSession(session);
    } catch (e) {
      // Ignored
    }
  },
  // Kiểm tra trạng thái đã đăng nhập hay chưa
  isLoggedIn() {
    return this.getCurrentUser() !== null;
  },

  // Kiểm tra quyền Admin/Thủ quỹ
  isAdmin() {
    const u = this.getCurrentUser();
    return !!(u && (u.role === 'admin' || u.role === 'treasurer'));
  },

  // Ảnh biên lai: máy chủ gửi dấu "@bill:<khóa>" thay cho ảnh (nặng); tải ảnh thật khi cần và nhớ trong phiên
  BILL_MARK: '@bill:',
  _billCache: new Map(),

  isBillMarker(v) {
    return typeof v === 'string' && v.startsWith(this.BILL_MARK);
  },

  async getBill(due) {
    const v = due && due.billImage;
    if (!v) return '';
    if (!this.isBillMarker(v)) return v;
    const cacheKey = `${due.id}|${v}`;
    if (this._billCache.has(cacheKey)) return this._billCache.get(cacheKey);
    const session = this._readSession();
    const res = await this._authRequest({ action: 'billImage', token: session && session.token, dueId: due.id });
    const img = res && res.status === 'ok' && typeof res.image === 'string' ? res.image : '';
    if (img) this._billCache.set(cacheKey, img);
    return img;
  },

  // Quyền được giao theo vai trò tùy chỉnh (clubInfo.roles + users[].roleId). Ban quản trị luôn có đủ quyền.
  // Giao diện chỉ để ẩn/hiện nút; máy chủ mới là nơi kiểm quyền thật.
  PERMS: ['schedule', 'members', 'finance'],
  PERM_LABELS: {
    schedule: 'Quản lý lịch & buổi đánh',
    members: 'Quản lý thành viên',
    finance: 'Quản lý quỹ & sổ thu chi'
  },

  perms() {
    const u = this.getCurrentUser();
    if (!u) return [];
    if (u.role === 'admin' || u.role === 'treasurer') return this.PERMS.slice();
    const role = this.getRole(u.roleId);
    return role ? (role.perms || []).filter((p) => this.PERMS.includes(p)) : [];
  },

  can(perm) {
    return this.perms().includes(perm);
  },

  getRoles() {
    const info = (this.loadData().clubInfo) || {};
    return Array.isArray(info.roles) ? info.roles.filter((r) => r && r.id && r.name) : [];
  },

  getRole(roleId) {
    return roleId ? this.getRoles().find((r) => r.id === roleId) || null : null;
  },

  // Quyền lên lịch bình chọn tự động / hẹn giờ mở vote: Ban quản trị hoặc thành viên được Admin chỉ định
  canScheduleVotes() {
    const u = this.getCurrentUser();
    return !!(u && (u.role === 'admin' || u.role === 'treasurer' || u.canScheduleVotes === true || this.can('schedule')));
  },

  // Kiểm tra quyền Super Admin
  isSuperAdmin() {
    const u = this.getCurrentUser();
    return !!(u && u.role === 'admin');
  },

  // Kiểm tra quyền Thành viên thường
  isMember() {
    const u = this.getCurrentUser();
    return !!(u && u.role === 'member');
  },

  // Kiểm tra quyền Khách vãng lai (Chưa đăng nhập HOẶC tài khoản phân loại vãng lai 'guest')
  isGuest() {
    const u = this.getCurrentUser();
    if (!u) return true;
    return u.type === 'guest' && u.role !== 'admin' && u.role !== 'treasurer';
  },

  // Kiểm tra quyền Thành viên chính thức / Cố định (Đã đăng nhập và là Cố định hoặc Ban quản trị)
  isFixedMember() {
    const u = this.getCurrentUser();
    if (!u) return false;
    return u.role === 'admin' || u.role === 'treasurer' || u.type === 'fixed' || this.can('finance');
  },

  // Quyền xem sổ quỹ & báo cáo tài chính CLB (Chỉ dành cho Thành viên cố định & Ban quản trị)
  canViewFinance() {
    return this.isFixedMember();
  },

  // Quyền quản lý thành viên khác (Thêm, Sửa, Xóa, Duyệt, Đặt lại mật khẩu - Chỉ Ban quản trị)
  canManageMembers() {
    return this.can('members');
  },

  // Kiểm tra quyền xem thông tin liên hệ nhạy cảm (SĐT, Email) của một thành viên
  // Chỉ Quản trị viên HOẶC chính thành viên đó (Owner) mới được xem
  canViewMemberContact(targetMemberId = null, targetPhone = '') {
    if (this.isAdmin() || this.can('members')) return true;
    const u = this.getCurrentUser();
    if (!u) return false;
    if (targetMemberId && (u.id === targetMemberId || u.memberId === targetMemberId)) return true;
    if (u.phone && targetPhone && u.phone.replace(/\D/g, '') === targetPhone.replace(/\D/g, '')) return true;
    return false;
  },

  // Che giấu số điện thoại để bảo vệ quyền riêng tư đối với thành viên khác
  maskPhone(phone, targetMemberId = null) {
    if (!phone) return '';
    if (this.canViewMemberContact(targetMemberId, phone)) {
      return phone;
    }
    const clean = phone.replace(/\D/g, '');
    if (clean.length < 7) return '••••••';
    const prefix = clean.slice(0, 4);
    const suffix = clean.slice(-3);
    return `${prefix}****${suffix}`;
  },

  // Che giấu email để bảo vệ quyền riêng tư đối với thành viên khác
  maskEmail(email, targetMemberId = null) {
    if (!email) return '';
    if (this.canViewMemberContact(targetMemberId)) {
      return email;
    }
    const parts = email.split('@');
    if (parts.length !== 2) return '••••••@••••';
    const name = parts[0];
    const domain = parts[1];
    if (name.length <= 2) return `${name[0]}*@${domain}`;
    return `${name.slice(0, 2)}***@${domain}`;
  },

  // ==========================================
  // MẬT KHẨU (băm/kiểm tra dùng AuthCore - dùng chung với máy chủ)
  // ==========================================
  sha256(ascii) {
    return AuthCore.sha256(ascii);
  },

  // Băm phía trình duyệt trước khi gửi trong dữ liệu (máy chủ sẽ băm lặp có muối thêm một lần nữa)
  hashPassword(password) {
    if (!password) return "";
    const str = String(password).trim();
    if (/^\$sha256\$[0-9a-f]{64}$/.test(str)) return str;
    return AuthCore.canonical(str);
  },

  // Chỉ dùng cho chế độ Test (không có máy chủ). KHÔNG có bất kỳ mật khẩu dự phòng nào.
  verifyPassword(inputPassword, storedPassword) {
    return AuthCore.verify(storedPassword, inputPassword).ok;
  },

  _passwordPolicyError(pwd, confirm) {
    if (pwd.length < 8) return "Mật khẩu bắt buộc phải có độ dài tối thiểu từ 8 ký tự trở lên!";
    if (/\s/.test(pwd)) return "Mật khẩu không được chứa khoảng trắng!";
    if (confirm !== undefined && pwd !== String(confirm).trim()) return "Mật khẩu xác nhận không khớp, vui lòng kiểm tra lại!";
    return null;
  },

  async _authRequest(body) {
    const url = `${this.googleScriptUrl}?sheet=${encodeURIComponent(this._env || this.getActiveSheet())}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(Object.assign({ v: 2, sheet: this._env || this.getActiveSheet() }, body))
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json && json.status === 'error') return { status: 'error', message: json.message || 'Máy chủ trả lỗi' };
      return json;
    } catch (e) {
      console.warn("[Auth] Không kết nối được máy chủ:", e);
      return { status: 'offline', message: "Không kết nối được máy chủ. Cần có mạng để đăng nhập / đổi mật khẩu." };
    }
  },

  // Lưu phiên đăng nhập do máy chủ cấp
  _startSession(user, token, remember, mustChange) {
    const now = Date.now();
    const tokenExp = Number((AuthCore.readToken(token) || {}).exp) || 0;
    const ttlEnd = now + (remember ? this.SESSION_REMEMBER_TTL : this.SESSION_TEMP_TTL);
    this._writeSession({
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      memberId: user.memberId,
      loginAt: new Date().toISOString(),
      lastActivity: now,
      remember: !!remember,
      expiresAt: tokenExp ? Math.min(ttlEnd, tokenExp) : ttlEnd,
      token: token || null,
      mustChange: !!mustChange,
      user: user
    });
    localStorage.removeItem('SMASH_PRO_LOGGED_OUT');
    if (token) {
      const map = this._getTokens();
      map[user.username] = token;
      this._setTokens(map);
      // Thay đổi được tạo khi chưa đăng nhập (vd: dữ liệu v1 chưa gửi) -> gửi dưới tài khoản này
      let touched = false;
      this._outbox.forEach((op) => { if (!op.u) { op.u = user.username; touched = true; } });
      if (touched) LocalDB.saveOutbox(this._env, this._outbox);
    }
    this._deferredTokens = {};
    this._invalidateView();
    this._emitChanged();
    this.requestSync(0);
  },

  // Gia hạn phiên (trượt) khi token còn dưới nửa đời. Gọi lúc mở ứng dụng, khi quay lại tab và mỗi 30 phút.
  // Trả về true nếu phiên còn hiệu lực. Máy chủ báo token không còn hợp lệ (đổi mật khẩu / đăng xuất thiết bị khác) -> đăng xuất.
  async refreshSession(force = false) {
    if (this.isLocalOnly()) return true;
    const session = this._readSession();
    if (!session || !session.token) return false;
    const p = AuthCore.readToken(session.token);
    if (!p || !(Number(p.exp) > Date.now())) return false;
    const life = this._tokenLifeFor(session.role);
    if (!force && Number(p.exp) - Date.now() > life / 2) return true; // Còn lâu mới hết hạn
    if (this._refreshing) return this._refreshing;
    this._refreshing = (async () => {
      const res = await this._authRequest({ action: 'refresh', token: session.token });
      if (res.status === 'auth') {
        this.logout(false);
        if (window.App && App.showToast) App.showToast('Phiên đăng nhập đã hết hiệu lực (có thể mật khẩu vừa được đổi). Vui lòng đăng nhập lại.', 'warning');
        return false;
      }
      if (res.status !== 'ok' || !res.token) return true; // Mất mạng/lỗi tạm thời: giữ phiên, thử lại sau
      this._adoptToken(res.token, res.user);
      return true;
    })().finally(() => { this._refreshing = null; });
    return this._refreshing;
  },

  _tokenLifeFor(role) {
    return (role === 'admin' || role === 'treasurer') ? 7 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
  },

  // Thay token mới vào phiên hiện tại (không đổi người dùng / lựa chọn "duy trì")
  _adoptToken(token, user) {
    const session = this._readSession();
    if (!session) return;
    const exp = Number((AuthCore.readToken(token) || {}).exp) || 0;
    session.token = token;
    if (exp) session.expiresAt = session.remember ? exp : Math.min(session.expiresAt || exp, exp);
    if (user) session.user = user;
    this._writeSession(session);
    const map = this._getTokens();
    map[session.username] = token;
    this._setTokens(map);
    this._deferredTokens = {};
    this.requestSync(0);
  },

  // "Đăng xuất các thiết bị khác" (thu hồi mọi token cũ; thiết bị này nhận token mới)
  async logoutOtherDevices() {
    const session = this._readSession();
    if (!session || !session.token) return { success: false, message: 'Bạn chưa đăng nhập.' };
    const res = await this._authRequest({ action: 'logoutOthers', token: session.token });
    if (res.status !== 'ok' || !res.token) return { success: false, message: res.message || 'Không thực hiện được.' };
    this._adoptToken(res.token, res.user);
    return { success: true, message: res.message };
  },

  sessionInfo() {
    const s = this._readSession();
    if (!s) return null;
    return { remember: !!s.remember, expiresAt: s.expiresAt || 0, loginAt: s.loginAt };
  },

  // Mật khẩu KHÔNG bao giờ được lưu bởi ứng dụng. Chỉ nhờ trình duyệt/Trình quản lý mật khẩu của thiết bị đề nghị lưu
  // (Credential Management API) để lần sau tự điền; người dùng toàn quyền đồng ý hoặc từ chối.
  async offerSavePassword(username, password, name) {
    try {
      if (typeof window === 'undefined' || !window.PasswordCredential || !navigator.credentials || !navigator.credentials.store) return false;
      await navigator.credentials.store(new window.PasswordCredential({ id: String(username), password: String(password), name: name || String(username) }));
      return true;
    } catch (e) {
      return false;
    }
  },

  // Đăng nhập hệ thống (xác thực trên máy chủ)
  async login(usernameOrPhone, password, remember = false) {
    const input = (usernameOrPhone || "").trim().toLowerCase();
    const pwd = (password || "").trim();
    if (!input || !pwd) {
      return { success: false, message: "Vui lòng nhập đầy đủ tên đăng nhập/SĐT và mật khẩu!" };
    }

    if (this.isLocalOnly()) {
      const digits = input.replace(/\D/g, '');
      const user = (this._getViewObj().users || []).find(u =>
        (u.username && u.username.toLowerCase() === input) || (digits.length >= 9 && u.phone && u.phone.replace(/\D/g, '') === digits));
      if (!user || !this.verifyPassword(pwd, user.password)) {
        return { success: false, message: "Tên đăng nhập hoặc mật khẩu không chính xác, vui lòng kiểm tra lại!" };
      }
      this._startSession(user, null, remember, false);
      return { success: true, user, message: `Chào mừng ${user.name} đã đăng nhập thành công!` };
    }

    const res = await this._authRequest({ action: 'login', username: input, password: pwd });
    if (res.status !== 'ok') return { success: false, message: res.message || "Đăng nhập thất bại!" };
    this._startSession(res.user, res.token, remember, res.mustChange);
    if (remember && !res.mustChange) this.offerSavePassword(input, pwd, res.user && res.user.name);
    return { success: true, user: this.getCurrentUser() || res.user, mustChange: !!res.mustChange, message: res.message };
  },

  // Đăng ký tài khoản người dùng mới (tạo trên máy chủ)
  async register({ name, phone, usernameInput, password, confirmPassword, memberType = "fixed", remember = true, note = "" }) {
    const data = this.loadData();

    // 1. Kiểm tra họ và tên
    const trimmedName = (name || "").trim();
    if (!trimmedName || trimmedName.length < 2) {
      return { success: false, message: "Vui lòng nhập họ và tên hợp lệ (tối thiểu 2 ký tự)!" };
    }

    // 2. Xác định Username từ SĐT hoặc Tên
    let finalUsername = "";
    const cleanPhone = (phone || "").replace(/\D/g, '');
    if (cleanPhone && cleanPhone.length >= 9) {
      finalUsername = cleanPhone;
    } else if (usernameInput && usernameInput.trim()) {
      finalUsername = usernameInput.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    } else {
      finalUsername = trimmedName.normalize("NFD").replace(/[̀-ͯ]/g, "")
        .toLowerCase().replace(/[^a-z0-9]/g, '') + Math.floor(100 + Math.random() * 900);
    }
    if (!finalUsername || finalUsername.length < 3) {
      return { success: false, message: "Tên đăng nhập hoặc số điện thoại không hợp lệ!" };
    }

    // 3. Kiểm tra trùng lặp (máy chủ kiểm tra lại)
    const exists = (data.users || []).some(u =>
      (u.username || '').toLowerCase() === finalUsername.toLowerCase() ||
      (cleanPhone && u.phone && u.phone.replace(/\D/g, '') === cleanPhone));
    if (exists) {
      return { success: false, message: `Tài khoản với tên đăng nhập hoặc SĐT "${finalUsername}" đã tồn tại trên hệ thống!` };
    }

    // 4. Kiểm tra quy tắc mật khẩu (Password Policy)
    const pwd = (password || "").trim();
    const policy = this._passwordPolicyError(pwd, confirmPassword);
    if (policy) return { success: false, message: policy };

    const avatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(trimmedName)}&background=10b981&color=fff`;
    const themePreference = (window.App && window.App.theme) || localStorage.getItem('smash_pro_theme') || 'light';

    if (this.isLocalOnly()) {
      const now = Date.now();
      const newUser = {
        id: "user_" + now, username: finalUsername, password: this.hashPassword(pwd), name: trimmedName,
        phone: cleanPhone || "", role: "member", memberId: "mem_" + now, type: memberType, avatar, themePreference,
        createdAt: new Date().toISOString()
      };
      data.users.push(newUser);
      data.members.push({
        id: newUser.memberId, username: finalUsername, name: trimmedName, role: "member", phone: cleanPhone || "",
        type: memberType, avatar, joinDate: new Date().toISOString().slice(0, 10), note
      });
      this.saveData(data, true);
      this._startSession(newUser, null, remember, false);
      return { success: true, user: newUser, message: `Đăng ký thành công! Tên đăng nhập của bạn là: ${finalUsername}` };
    }

    const res = await this._authRequest({
      action: 'register', name: trimmedName, phone: cleanPhone, username: finalUsername, password: pwd,
      memberType, avatar, themePreference, note
    });
    if (res.status !== 'ok') return { success: false, message: res.message || "Đăng ký thất bại!" };
    this._startSession(res.user, res.token, remember, res.mustChange);
    return { success: true, user: res.user, mustChange: !!res.mustChange, message: res.message };
  },

  // ---------------- Đăng nhập bằng Google (máy chủ xác minh ID token) ----------------
  async googleLogin(credential, remember = true) {
    if (this.isLocalOnly()) return { success: false, message: 'Chế độ chạy cục bộ không hỗ trợ đăng nhập Google.' };
    const res = await this._authRequest({ action: 'googleLogin', credential });
    if (res.status === 'not_linked') return { success: false, notLinked: true, email: res.email, name: res.name, emailInUse: !!res.emailInUse, message: res.message };
    if (res.status !== 'ok') return { success: false, message: res.message || 'Đăng nhập Google thất bại!' };
    this._startSession(res.user, res.token, remember, false);
    return { success: true, user: this.getCurrentUser() || res.user, message: res.message };
  },

  async googleRegister(credential, memberType = 'fixed', remember = true) {
    if (this.isLocalOnly()) return { success: false, message: 'Chế độ chạy cục bộ không hỗ trợ đăng ký bằng Google.' };
    const themePreference = (window.App && window.App.theme) || 'light';
    const res = await this._authRequest({ action: 'googleRegister', credential, memberType, themePreference });
    if (res.status !== 'ok') return { success: false, message: res.message || 'Không tạo được tài khoản Google!' };
    this._startSession(res.user, res.token, remember, false);
    return { success: true, user: this.getCurrentUser() || res.user, message: res.message };
  },

  async _googleSessionAction(action, extra) {
    const session = this._readSession();
    if (!session || !session.token) return { success: false, message: 'Vui lòng đăng nhập lại!' };
    const res = await this._authRequest(Object.assign({ action, token: session.token }, extra));
    if (res.status !== 'ok') return { success: false, message: res.message || 'Thao tác thất bại!' };
    this._startSession(res.user, session.token, session.remember, session.mustChange);
    return { success: true, message: res.message };
  },

  googleLink(credential) {
    return this._googleSessionAction('googleLink', { credential });
  },

  googleUnlink() {
    return this._googleSessionAction('googleUnlink', {});
  },

  // Đăng xuất khỏi hệ thống
  logout(explicit = true) {
    if (explicit) {
      localStorage.setItem('SMASH_PRO_LOGGED_OUT', 'true');
    }
    try { if (window.PushClient) PushClient.onBeforeLogout(this._readSession()); } catch (e) {}
    localStorage.removeItem(this._authKey());
    sessionStorage.removeItem(this._authKey());
    this._pruneTokens(); // Token chỉ còn giữ nếu tài khoản này còn thay đổi chờ gửi

    // currentUser không lưu trong CSDL (chỉ nằm trong phiên) -> chỉ cần làm mới giao diện
    try {
      this._invalidateView();
      this._emitChanged();
      this.requestSync(0); // Tải lại dữ liệu ở chế độ khách (ẩn thông tin riêng tư)
    } catch (e) {
      console.error("Lỗi xóa phiên trong CSDL:", e);
    }
  },

  // ==========================================
  // BẢO MẬT & QUẢN LÝ MẬT KHẨU TÀI KHOẢN (xử lý trên máy chủ)
  // ==========================================

  // Đổi mật khẩu của chính tài khoản đang đăng nhập
  async changePassword(userId, oldPassword, newPassword, confirmPassword) {
    const oldPwd = (oldPassword || "").trim();
    const newPwd = (newPassword || "").trim();
    const me = this.getCurrentUser();
    const firstPassword = !!(me && me.googleOnly === true);
    if (!oldPwd && !firstPassword) return { success: false, message: "Vui lòng nhập mật khẩu hiện tại!" };
    const policy = this._passwordPolicyError(newPwd, confirmPassword);
    if (policy) return { success: false, message: policy.replace("Mật khẩu", "Mật khẩu mới") };
    if (oldPwd === newPwd) return { success: false, message: "Mật khẩu mới không được trùng với mật khẩu cũ!" };

    const session = this._readSession();
    if (!session) return { success: false, message: "Vui lòng đăng nhập lại!" };

    if (this.isLocalOnly()) {
      const data = this.loadData();
      const user = (data.users || []).find(u => u.id === userId || u.username === userId);
      if (!user || !this.verifyPassword(oldPwd, user.password)) return { success: false, message: "Mật khẩu hiện tại không chính xác!" };
      user.password = this.hashPassword(newPwd);
      this.saveData(data, true);
      return { success: true, message: "Đổi mật khẩu thành công! Hãy ghi nhớ mật khẩu mới để đăng nhập." };
    }

    const res = await this._authRequest({ action: 'changePassword', token: session.token, oldPassword: oldPwd, newPassword: newPwd });
    if (res.status !== 'ok') return { success: false, message: res.message || "Không đổi được mật khẩu!" };
    this._startSession(res.user, res.token, session.remember, false);
    return { success: true, message: res.message };
  },

  // Lệnh email trên máy chủ (chỉ Ban quản trị): 'emailSetup' (bật/kiểm tra trình gửi) | 'emailTest' (gửi thử)
  async emailAction(action, extra = {}) {
    if (this.isLocalOnly()) return { status: 'denied', message: 'Chế độ Test không gửi email.' };
    const session = this._readSession();
    return this._authRequest(Object.assign({ action, token: session && session.token }, extra));
  },

  // Ban quản trị đặt lại mật khẩu cho thành viên
  async adminResetUserPassword(memberIdOrUserId, newPassword) {
    if (!this.isAdmin()) {
      return { success: false, message: "Chỉ Quản trị viên mới có quyền đặt lại mật khẩu cho thành viên!" };
    }
    const newPwd = (newPassword || "").trim();
    const policy = this._passwordPolicyError(newPwd);
    if (policy) return { success: false, message: policy };

    if (this.isLocalOnly()) {
      const data = this.loadData();
      const user = (data.users || []).find(u => u.memberId === memberIdOrUserId || u.id === memberIdOrUserId || u.username === memberIdOrUserId);
      if (!user) return { success: false, message: "Không tìm thấy tài khoản tương ứng với thành viên này!" };
      user.password = this.hashPassword(newPwd);
      this.saveData(data, true);
      return { success: true, message: `Đã cập nhật mật khẩu mới cho tài khoản "${user.name}" thành công!` };
    }

    const session = this._readSession();
    const res = await this._authRequest({ action: 'adminSetPassword', token: session && session.token, target: memberIdOrUserId, newPassword: newPwd });
    return { success: res.status === 'ok', message: res.message };
  },

  // Cập nhật thông tin hồ sơ cá nhân và Avatar của người dùng hiện tại
  async updateUserProfile({ userId, name, phone, email, avatar, note, bio, currentPassword, newPassword, confirmPassword }) {
    const data = this.loadData();
    const user = (data.users || []).find(u => u.id === userId || u.username === userId);
    if (!user) {
      return { success: false, message: "Không tìm thấy thông tin tài khoản người dùng!" };
    }

    const trimmedName = (name || "").trim();
    if (!trimmedName || trimmedName.length < 2) {
      return { success: false, message: "Họ và tên bắt buộc phải có tối thiểu 2 ký tự!" };
    }

    const cleanPhone = (phone || "").replace(/\D/g, '');
    if (phone && cleanPhone && (cleanPhone.length < 9 || cleanPhone.length > 11)) {
      return { success: false, message: "Số điện thoại không hợp lệ (cần từ 9 - 11 chữ số)!" };
    }
    if (cleanPhone) {
      const duplicateUser = (data.users || []).find(u => u.id !== user.id && u.phone && u.phone.replace(/\D/g, '') === cleanPhone);
      if (duplicateUser) {
        return { success: false, message: `Số điện thoại ${phone} đã được sử dụng bởi tài khoản "${duplicateUser.name}"!` };
      }
    }

    // Đổi mật khẩu (nếu có nhập) qua máy chủ TRƯỚC, thất bại thì không lưu gì
    const wantsPassword = !!((currentPassword || "").trim() || (newPassword || "").trim() || (confirmPassword || "").trim());
    if (wantsPassword) {
      if (!(currentPassword || "").trim() && !(user && user.googleOnly === true)) {
        return { success: false, message: "Vui lòng nhập Mật khẩu hiện tại để xác nhận thay đổi mật khẩu!" };
      }
      const pw = await this.changePassword(user.username, currentPassword, newPassword, confirmPassword);
      if (!pw.success) return pw;
    }

    // Cập nhật hồ sơ (đồng bộ dạng op, máy chủ chỉ cho sửa các trường hồ sơ của chính chủ)
    const fresh = this.loadData();
    const u = (fresh.users || []).find(x => x.id === user.id || x.username === user.username);
    if (u) {
      u.name = trimmedName;
      if (phone !== undefined) u.phone = phone.trim();
      if (email !== undefined) u.email = email.trim();
      if (avatar) u.avatar = avatar;
      if (note !== undefined || bio !== undefined) u.note = (note || bio || '').trim();
      const member = (fresh.members || []).find(m => m.id === u.memberId || (m.username && m.username === u.username));
      if (member) {
        member.name = u.name;
        member.phone = u.phone;
        if (email !== undefined) member.email = u.email;
        if (avatar) member.avatar = u.avatar;
        if (u.note !== undefined) member.note = u.note;
      }
      this.saveData(fresh, true);
    }

    return {
      success: true,
      user: this.getCurrentUser(),
      message: wantsPassword ? "Đã cập nhật hồ sơ và đổi mật khẩu mới thành công!" : "Đã cập nhật thông tin hồ sơ thành công!"
    };
  },
  // ==========================================
  // CHẾ ĐỘ DỮ LIỆU: PRODUCTION VS TEST DEMO
  // ==========================================

  // Mỗi môi trường có kho cục bộ + hàng đợi riêng; chuyển môi trường không ghi đè dữ liệu của môi trường kia
  switchDatabaseMode(mode) {
    const env = mode === 'test' ? 'CSDL_KiemThu_Test' : 'CSDL_VanHanh_Prod';
    clearTimeout(this._syncTimer);
    this._syncTimer = null;
    this.activeSheet = env;
    localStorage.setItem(ACTIVE_SHEET_KEY, env);
    this._loadEnv(env).then(() => {
      this._emitChanged();
      this._refreshBadge();
      this.requestSync(0);
    }).catch((e) => console.error('[Storage] Lỗi chuyển môi trường:', e));
    return this.loadData();
  },

  // ==========================================
  // ĐỒNG BỘ ĐÁM MÂY GOOGLE SHEETS (v2: op + delta)
  // ==========================================

  requestSync(delay = 300) {
    if (this.isLocalOnly()) return;
    clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(() => {
      this._syncTimer = null;
      this.syncNow();
    }, delay);
  },

  // Gửi op đang chờ + nhận thay đổi từ máy khác. Trả về true khi không còn op chờ.
  syncNow({ full = false } = {}) {
    if (this.isLocalOnly()) {
      this._refreshBadge();
      return Promise.resolve(true);
    }
    if (full) this._syncFull = true;
    if (this._syncPromise) {
      this._syncAgain = true;
      return this._syncPromise;
    }
    this._syncPromise = this._syncLoop().finally(() => { this._syncPromise = null; });
    return this._syncPromise;
  },

  async _syncLoop() {
    if (this._ready) await this._ready.catch(() => {});
    let ok = false;
    for (let i = 0; i < 20; i++) {
      this._syncAgain = false;
      const full = this._syncFull;
      this._syncFull = false;
      const sent = this._outbox.length;
      ok = await this._syncOnce(full);
      if (!ok) break;
      // Tiếp tục khi còn op (lô lớn) hoặc có yêu cầu mới trong lúc đang đồng bộ
      if (!this._syncAgain && (!this._outbox.length || this._outbox.length >= sent)) break;
    }
    this._schedulePoll(ok);
    return ok && !this._outbox.length;
  },

  _takeBatch() {
    const batch = [];
    const tokens = this._getTokens();
    const deferred = this._deferredTokens || {};
    let size = 0;
    for (const op of this._outbox) {
      const tk = op.u ? tokens[op.u] : null;
      if (!tk || deferred[op.u] === tk) continue;
      const len = JSON.stringify(op).length;
      if (batch.length && (batch.length >= this.MAX_BATCH_OPS || size + len > this.MAX_BATCH_CHARS)) break;
      batch.push(op);
      size += len;
    }
    return batch;
  },

  async _fetchJson(url, init) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), this.REQUEST_TIMEOUT) : null;
    const t0 = Date.now();
    try {
      const res = await fetch(url, Object.assign({}, init, ctrl ? { signal: ctrl.signal } : {}));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json || json.status === 'error') throw new Error((json && json.message) || 'Máy chủ trả lỗi');
      // Hiệu chỉnh lệch giờ thiết bị so với máy chủ (dùng cho đồng hồ HLC)
      if (json.serverTime) {
        const rtt = Date.now() - t0;
        if (rtt < 10000) this._meta.clockOffset = json.serverTime - (t0 + rtt / 2);
        this._clock.setOffset(this._meta.clockOffset);
      }
      return json;
    } finally {
      if (timer) clearTimeout(timer);
    }
  },

  async _syncOnce(full) {
    const env = this._env;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this._refreshBadge('offline');
      return false;
    }
    const viewer = this.isLoggedIn() ? this._currentUsername() : '';
    const viewerChanged = viewer !== (this._meta.viewer || '');
    const since = (full || viewerChanged) ? 0 : this._meta.lastSeq;
    const batch = this._takeBatch();
    const tokens = this._getTokens();
    const auth = {};
    batch.forEach((op) => { if (op.u && tokens[op.u]) auth[op.u] = tokens[op.u]; });
    if (viewer && tokens[viewer]) auth[viewer] = tokens[viewer];
    this._refreshBadge('syncing');
    try {
      let res;
      const base = `${this.googleScriptUrl}?sheet=${encodeURIComponent(env)}`;
      if (batch.length) {
        res = await this._fetchJson(base, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({ v: 2, sheet: env, deviceId: this.deviceId(), since, viewer, auth, ops: batch })
        });
      } else {
        const t = viewer && tokens[viewer] ? `&t=${encodeURIComponent(tokens[viewer])}` : '';
        res = await this._fetchJson(`${base}&v=2&since=${since}${t}`, { method: "GET" });
      }
      if (env !== this._env) return false; // Đã chuyển môi trường trong lúc chờ mạng
      if (res.status !== 'unchanged') this._meta.viewer = viewer;
      await this._applyServerResponse(res, batch, auth);
      this._failCount = 0;
      this.lastSyncedTime = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
      this._refreshBadge();
      return true;
    } catch (err) {
      console.warn("[Sync] Đồng bộ thất bại, dữ liệu vẫn an toàn trên thiết bị:", err);
      this._failCount++;
      this._refreshBadge('offline');
      return false;
    }
  },

  // Số bản ghi đang dùng trên thiết bị (để phát hiện phản hồi bất thường từ máy chủ)
  _localLiveCount() {
    return Object.keys(this._confirmed).filter((rk) => SyncCore.isLive(this._confirmed[rk])).length;
  },

  // Cảnh báo dữ liệu máy chủ bất thường: GIỮ NGUYÊN dữ liệu trên thiết bị, không áp gì
  _holdServerData(reason, message) {
    const first = !this._serverWarning || this._serverWarning.reason !== reason;
    this._serverWarning = { reason, message, at: Date.now() };
    if (first) this._maybeBackup('may-chu-bat-thuong'); // Chụp ngay dữ liệu đang giữ trên thiết bị
    console.error('[Sync] ' + message);
    if (first && window.App) App.showToast(`⚠️ ${message}`, 'error');
    this._emitChanged();
  },

  async _applyServerResponse(res, batch, auth = {}) {
    const env = this._env;
    const changed = {};
    let preFull = null;
    // Bảo vệ 1: máy chủ chưa cập nhật bản tương thích (deploy giao diện trước backend)
    if (!(Number(res.api) >= this.MIN_SERVER_API)) {
      this._holdServerData('api', 'Máy chủ dữ liệu chưa được cập nhật phiên bản mới. Dữ liệu trên thiết bị được giữ nguyên, chưa đồng bộ.');
      return;
    }
    // Bảo vệ 2: máy chủ trả về kho TRỐNG HOÀN TOÀN trong khi thiết bị đang có dữ liệu
    // (kho chưa khởi tạo / chuyển dữ liệu lỗi). "Đặt lại CSDL" hợp lệ vẫn có bản ghi (đã đánh dấu xóa) nên không bị chặn.
    if (res.status !== 'unchanged' && res.full && !(res.records || []).length && this._localLiveCount() > 0) {
      this._holdServerData('empty', 'Máy chủ đang trả về dữ liệu trống bất thường. Đã GIỮ NGUYÊN dữ liệu trên thiết bị để tránh mất dữ liệu. Ban quản trị vui lòng kiểm tra máy chủ (kiemTraDuLieu).');
      return;
    }
    if (this._serverWarning) {
      this._serverWarning = null;
      this._emitChanged();
    }
    if (res.status !== 'unchanged') {
      if (res.full) {
        // Sao lưu trạng thái hiện tại trước khi thay bằng bản tải đầy đủ
        if (this._localLiveCount() > 0 && this._backupScopeOk()) {
          preFull = { json: this._getViewJson(), live: Object.keys(this._confirmed).filter((rk) => SyncCore.isLive(this._confirmed[rk])) };
        }
        // Tải đầy đủ: thay toàn bộ bản xác nhận (op chưa gửi vẫn nằm trong outbox và được áp lại)
        this._confirmed = {};
      }
      (res.records || []).forEach((item) => {
        const rk = SyncCore.recKey(item.col, String(item.key));
        const cur = this._confirmed[rk];
        if (!cur || res.full || (Number(item.r.s) || 0) >= (cur.s || 0)) {
          this._confirmed[rk] = item.r;
          changed[rk] = item.r;
          this._clock.observe(SyncCore.recordHlcMax(item.r));
        }
      });
    }
    if (res.seq !== undefined) this._meta.lastSeq = Number(res.seq) || 0;
    // Phạm vi quyền xem đổi (vd: được nâng thành viên cố định) -> tải lại toàn bộ theo quyền mới
    if (res.scope) {
      if (!res.full && this._meta.scope && res.scope !== this._meta.scope) {
        this._syncFull = true;
        this._syncAgain = true;
      }
      this._meta.scope = res.scope;
    }
    if (preFull && this._backupScopeOk() && preFull.live.some((rk) => !SyncCore.isLive(this._confirmed[rk]))) {
      await this._maybeBackup('truoc-khi-tai-toan-bo', preFull.json);
    }

    if (batch.length && Array.isArray(res.acked)) {
      // Op bị từ chối (không đủ quyền) cũng được gỡ khỏi hàng đợi; giao diện quay về dữ liệu máy chủ
      const rejected = Array.isArray(res.rejected) ? res.rejected : [];
      const done = new Set(res.acked.concat(rejected.map((r) => r.id)));
      this._outbox = this._outbox.filter((op) => !done.has(op.id));
      LocalDB.saveOutbox(env, this._outbox);
      if (rejected.length) {
        console.warn('[Sync] Máy chủ từ chối thay đổi:', rejected);
        if (window.App) App.showToast(`⛔ ${rejected.length} thay đổi bị từ chối do tài khoản không đủ quyền.`, "error");
      }
      // Op chờ đăng nhập lại (token hết hạn / mật khẩu đã đổi / phải đổi mật khẩu yếu): ngừng gửi tới khi có token mới
      const deferredIds = new Set(Array.isArray(res.deferred) ? res.deferred : []);
      this._deferredTokens = this._deferredTokens || {};
      batch.forEach((op) => { if (deferredIds.has(op.id) && op.u) this._deferredTokens[op.u] = auth[op.u]; });
      this._pruneTokens();
    }

    const meta = { lastSeq: this._meta.lastSeq, clockOffset: this._meta.clockOffset, viewer: this._meta.viewer || '', scope: this._meta.scope || '' };
    await LocalDB.write(env, res.full
      ? { allRecords: this._confirmed, replaceAll: true, meta }
      : { records: changed, meta });

    const before = this._viewJson;
    this._rebuildWorking();
    if (before !== this._getViewJson()) {
      this._emitChanged();
      this._broadcast();
      this._applyThemeFromCloud();
    }
    this._maybeBackup();
  },

  _applyThemeFromCloud() {
    if (!window.App || typeof App.applyUserTheme !== 'function') return;
    const u = this.getCurrentUser();
    if (u && u.themePreference) App.applyUserTheme(u);
  },

  // Bản sao lưu cục bộ (trong IndexedDB, tối đa 1 lần/giờ) - thay cho 7 bản sao trong localStorage của v1
  _backupCounts(view) {
    const n = (k) => (Array.isArray(view[k]) ? view[k].length : 0);
    return { users: n('users'), members: n('members'), sessions: n('sessions'), transactions: n('transactions'), dues: n('monthlyContributions') };
  },

  // Chỉ sao lưu khi thiết bị đang giữ dữ liệu ĐẦY ĐỦ (Ban quản trị / chạy cục bộ).
  // Dữ liệu của khách/thành viên đã bị máy chủ lọc bớt -> sao lưu vô ích và gây nhầm khi khôi phục.
  _backupScopeOk() {
    return this.isLocalOnly() || this._meta.scope === 'staff';
  },

  // Dọn danh sách cũ: bỏ bản chụp từ quyền xem bị lọc (0 tài khoản) và bản trùng nội dung (giữ bản mới nhất)
  _cleanBackups(list) {
    const seen = new Set();
    return (Array.isArray(list) ? list : []).slice().reverse().filter((b) => {
      if (!b || !b.json || !b.counts) return false;
      if (b.scope ? (b.scope !== 'staff' && b.scope !== 'local') : b.counts.users === 0) return false;
      if (seen.has(b.json)) return false;
      seen.add(b.json);
      return true;
    }).reverse().slice(-this.BACKUP_KEEP);
  },

  // reason: lý do sao lưu ngay (bỏ qua giới hạn 1 giờ/lần); json: nội dung cần lưu (mặc định: dữ liệu hiện tại)
  async _maybeBackup(reason, json) {
    const now = Date.now();
    if (!reason && now - (this._meta.lastBackupAt || 0) < this.BACKUP_INTERVAL) return;
    if (!this._backupScopeOk()) return;
    json = json || this._getViewJson();
    const view = JSON.parse(json);
    if (view.isInitialSkeleton || this._localLiveCount() === 0) return; // Không sao lưu khung trống
    const list = Array.isArray(this._backups) ? this._backups.slice() : [];
    if (list.some((b) => b.json === json)) return; // Nội dung đã có bản sao -> không lưu trùng
    list.push({ id: `b${now}`, at: now, reason: reason || 'dinh-ky', scope: this.isLocalOnly() ? 'local' : 'staff', seq: this._meta.lastSeq, counts: this._backupCounts(view), json });
    this._backups = list.slice(-this.BACKUP_KEEP);
    this._meta.lastBackupAt = now;
    try {
      await LocalDB.write(this._env, { meta: { lastBackupAt: now, backups: this._backups } });
    } catch (e) {
      console.warn('[Storage] Không lưu được bản sao lưu:', e);
    }
  },

  // Danh sách bản sao trên thiết bị (mới nhất trước), gồm cả bản dữ liệu kiểu cũ lúc nâng cấp
  listLocalBackups() {
    const out = (this._backups || []).map((b) => ({ id: b.id, at: b.at, reason: b.reason, counts: b.counts }));
    const legacy = this._legacyBackups || {};
    const add = (id, raw, reason) => {
      try {
        const d = JSON.parse(raw);
        out.push({ id, at: Number(d.lastModified) || 0, reason, counts: this._backupCounts(d) });
      } catch (e) {}
    };
    if (legacy.legacyBackup) add('legacy', legacy.legacyBackup, 'du-lieu-ban-cu-luc-nang-cap');
    if (legacy.backup && legacy.backup.json) add('old-hourly', legacy.backup.json, 'ban-sao-cu');
    return out.filter((b) => (b.counts.members + b.counts.sessions + b.counts.users) > 0).sort((a, b) => b.at - a.at);
  },

  // Số lượng hiện tại (so sánh với bản sao: bản sao có NHIỀU hơn -> có thể chứa dữ liệu đã mất)
  currentBackupCounts() {
    return this._backupCounts(JSON.parse(this._getViewJson()));
  },

  async deleteLocalBackup(id) {
    if (!this.isAdmin()) return false;
    if (id === 'legacy' || id === 'old-hourly') {
      const key = id === 'legacy' ? 'legacyBackup' : 'backup';
      this._legacyBackups = Object.assign({}, this._legacyBackups, { [key]: null });
      await LocalDB.write(this._env, { meta: { [key]: null } });
      return true;
    }
    this._backups = (this._backups || []).filter((b) => b.id !== id);
    await LocalDB.write(this._env, { meta: { backups: this._backups } });
    return true;
  },

  _localBackupData(id) {
    const b = (this._backups || []).find((x) => x.id === id);
    if (b) return JSON.parse(b.json);
    const legacy = this._legacyBackups || {};
    if (id === 'legacy' && legacy.legacyBackup) return JSON.parse(legacy.legacyBackup);
    if (id === 'old-hourly' && legacy.backup) return JSON.parse(legacy.backup.json);
    return null;
  },

  downloadLocalBackup(id) {
    const d = this._localBackupData(id);
    if (!d) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }));
    a.download = `smash_pro_ban_sao_${id}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  },

  // Ban quản trị gửi một bản sao trên thiết bị lên máy chủ: máy chủ HỢP NHẤT theo từng trường
  // (chỉ lấy lại dữ liệu bị thiếu/cũ hơn, không xóa dữ liệu mới, không đổi mật khẩu/vai trò)
  async restoreLocalBackupToServer(id) {
    if (!this.isAdmin()) return { success: false, message: 'Chỉ Ban quản trị mới được khôi phục dữ liệu.' };
    const d = this._localBackupData(id);
    if (!d) return { success: false, message: 'Không tìm thấy bản sao.' };
    delete d.currentUser;
    const snap = Object.assign({}, d, { lastModified: Number(d.lastModified) || Date.now() });
    this._enqueue([{ t: 'legacy', snap }], false);
    const ok = await this.syncNow();
    return { success: ok, message: ok ? 'Đã gửi bản sao lên máy chủ và hợp nhất thành công.' : 'Bản sao đã được xếp hàng, sẽ gửi khi kết nối được máy chủ.' };
  },

  getServerWarning() {
    return this._serverWarning;
  },

  // Kiểm tra định kỳ khi tab đang hiển thị; mất mạng -> thử lại giãn dần (2s, 4s, ... tối đa 60s)
  _schedulePoll(ok) {
    clearTimeout(this._pollTimer);
    if (this.isLocalOnly()) return;
    const delay = ok ? this.POLL_INTERVAL : Math.min(60000, 2000 * Math.pow(2, Math.max(0, this._failCount - 1)));
    this._pollTimer = setTimeout(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible' || this._outbox.length) {
        this.syncNow();
      }
    }, delay);
  },

  // Đóng/ẩn tab khi còn op chờ: gửi nhanh bằng sendBeacon (op có id, gửi trùng không gây sai lệch)
  _flushBeacon() {
    if (this.isLocalOnly() || !this._outbox.length || typeof navigator === 'undefined' || !navigator.sendBeacon) return;
    const tokens = this._getTokens();
    const ops = this._outbox.filter((op) => op.u && tokens[op.u]).slice(0, 50);
    if (!ops.length) return;
    const auth = {};
    ops.forEach((op) => { auth[op.u] = tokens[op.u]; });
    const body = JSON.stringify({ v: 2, sheet: this._env, deviceId: this.deviceId(), since: this._meta.lastSeq, auth, ops });
    if (body.length > this.BEACON_LIMIT) return;
    try {
      navigator.sendBeacon(`${this.googleScriptUrl}?sheet=${encodeURIComponent(this._env)}`, new Blob([body], { type: 'text/plain;charset=utf-8' }));
    } catch (e) {}
  },

  pendingChangesCount() {
    return this._outbox.length;
  },

  // Tương thích nút "Lưu lên database": gửi ngay các thay đổi đang chờ
  async pushToCloud(data = null, showToast = true) {
    const ok = await this.syncNow();
    if (showToast && window.App) {
      if (ok) App.showToast(`☁️ Đã đồng bộ CSDL với database (${this._env}) thành công!`, "success");
      else App.showToast(`⚠️ Chưa kết nối được database. ${this._outbox.length} thay đổi đang chờ, sẽ tự gửi khi có mạng.`, "warning");
    }
    return ok;
  },

  // Xuất toàn bộ CSDL ra tệp JSON dự phòng
  exportDatabaseJSON() {
    const data = this.loadData();
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(data, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `smash_pro_backup_${new Date().toISOString().slice(0, 10)}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    if (window.App) App.showToast("📁 Đã xuất tệp sao lưu CSDL (.json) thành công!", "success");
  },

  exportBackup() {
    this.exportDatabaseJSON();
  },

  // Thay toàn bộ CSDL (Đặt lại / Phục hồi): op "reset" xóa mọi bản ghi cũ, sau đó tạo lại từ `data`
  _replaceAll(data) {
    this._maybeBackup('truoc-khi-thay-toan-bo');
    const resetOp = { t: 'reset', h: this._clock.now() };
    const putOps = SyncCore.diffData({}, data, this._clock.now(), () => false);
    this._enqueue([resetOp, ...putOps], false);
  },

  // Phục hồi CSDL từ tệp JSON
  importDatabaseJSON(jsonContent) {
    try {
      const parsed = typeof jsonContent === 'string' ? JSON.parse(jsonContent) : jsonContent;
      if (!parsed || !parsed.clubInfo) {
        throw new Error("Cấu trúc tệp sao lưu không hợp lệ!");
      }
      const restored = this.reconcileUsersAndMembers(this.sanitizeProductionData(parsed));
      this._replaceAll(restored);
      this.syncNow();
      if (window.App) {
        App.showToast("🎉 Đã phục hồi dữ liệu từ tệp sao lưu thành công!", "success");
        App.refreshDashboardStats();
        App.renderUserHeaderAndSidebar();
      }
      return true;
    } catch (err) {
      console.error("Lỗi nhập dữ liệu:", err);
      if (window.App) App.showToast("❌ Không thể phục hồi CSDL: " + err.message, "error");
      return false;
    }
  },

  handleBackupFileUpload(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      this.importDatabaseJSON(e.target.result);
    };
    reader.readAsText(file);
  },

  async resetData(showToast = true) {
    const clean = JSON.parse(JSON.stringify(PROD_DEFAULT_DATA));
    const view = this.loadData();
    const staff = (view.users || []).filter(u => u.role === 'admin' || u.role === 'treasurer');
    clean.users = staff.map(u => { const c = Object.assign({}, u); delete c.password; delete c.pwv; return c; });
    clean.members = (view.members || []).filter(m => staff.some(u => u.memberId === m.id || u.username === m.username));
    clean.clubInfo = Object.assign({}, clean.clubInfo, { name: (view.clubInfo || {}).name || '' });
    this._replaceAll(clean);

    if (window.App) {
      App.refreshDashboardStats();
      App.renderUserHeaderAndSidebar();
      if (App.currentTab) App.renderTabContent(App.currentTab);
      if (showToast) App.showToast("Đang đồng bộ đặt lại CSDL sạch lên database...", "info");
    }

    const pushed = await this.syncNow();
    if (pushed && window.App && showToast) {
      App.showToast("🎉 Đã làm sạch toàn bộ CSDL và đồng bộ lên database thành công!", "success");
    }
    return this.loadData();
  },

  // Tải dữ liệu mới nhất. showToast=true (bấm tay): tải lại toàn bộ để tự sửa mọi sai lệch cục bộ.
  async pullFromCloud(showToast = true) {
    if (this.isLocalOnly()) {
      this._refreshBadge();
      return this.loadData();
    }
    const ok = await this.syncNow({ full: !!showToast });
    if (showToast && window.App) {
      if (ok) App.showToast(`☁️ Đã đồng bộ CSDL với database (${this._env})!`, "success");
      else App.showToast("⚠️ Đang chạy ở chế độ Offline với dữ liệu trên thiết bị.", "warning");
    }
    return this.loadData();
  },

  _refreshBadge(status) {
    const envLabel = (this._env || this.activeSheet) === 'CSDL_VanHanh_Prod' ? 'Prod' : 'Test';
    if (this.isLocalOnly()) {
      this.cloudSyncStatus = 'synced';
      this.updateSyncBadgeUI('synced', `Test Mode (Local Data)`);
      return;
    }
    const pending = this._outbox.length;
    if (this._serverWarning && status !== 'syncing') {
      this.cloudSyncStatus = 'error';
      this.updateSyncBadgeUI('offline', `Đồng bộ database (${envLabel}): ⚠️ Máy chủ bất thường - đang giữ dữ liệu trên thiết bị`);
      return;
    }
    if (!status) status = this._syncPromise ? 'syncing' : (this._failCount ? 'offline' : 'synced');
    this.cloudSyncStatus = status;
    if (status === 'syncing') {
      this.updateSyncBadgeUI('syncing', `Đồng bộ database (${envLabel}): Đang đồng bộ${pending ? ` ${pending} thay đổi` : ''}...`);
    } else if (status === 'offline') {
      this.updateSyncBadgeUI('offline', `Đồng bộ database (${envLabel}): Offline${pending ? ` - ${pending} thay đổi chờ gửi` : ''}`);
    } else if (pending) {
      const tokens = this._getTokens();
      const deferred = this._deferredTokens || {};
      const waiting = this._outbox.filter((op) => !op.u || !tokens[op.u] || deferred[op.u] === tokens[op.u]).length;
      this.updateSyncBadgeUI('syncing', waiting === pending
        ? `Đồng bộ database (${envLabel}): ${pending} thay đổi chờ đăng nhập lại để gửi`
        : `Đồng bộ database (${envLabel}): ${pending} thay đổi chờ gửi`);
    } else {
      this.updateSyncBadgeUI('synced', `Đồng bộ database (${envLabel}): Đã đồng bộ${this.lastSyncedTime ? ` (${this.lastSyncedTime})` : ''}`);
    }
  },

  updateSyncBadgeUI(status, text) {
    const badgeEl = document.getElementById('cloud-sync-badge');
    const textEl = document.getElementById('cloud-sync-text');
    if (!badgeEl || !textEl) return;

    textEl.innerText = text;
    badgeEl.className = 'badge';

    if (status === 'synced') {
      badgeEl.classList.add('badge-paid');
      badgeEl.innerHTML = `<i class="fas fa-cloud-check text-primary"></i> <span id="cloud-sync-text">${text}</span>`;
    } else if (status === 'syncing') {
      badgeEl.classList.add('badge-info');
      badgeEl.innerHTML = `<i class="fas fa-sync fa-spin text-secondary"></i> <span id="cloud-sync-text">${text}</span>`;
    } else {
      badgeEl.classList.add('badge-warning');
      badgeEl.innerHTML = `<i class="fas fa-cloud text-warning"></i> <span id="cloud-sync-text">${text}</span>`;
    }
  }
};

window.AppStorage = AppStorage;
;

// ===== js/html-safe.js =====
// Safe - Mã hóa dữ liệu khi chèn vào HTML (chống XSS)
// Quy tắc: MỌI dữ liệu không phải hằng số trong mã (tên, ghi chú, SĐT, tiêu đề, id...) khi chèn vào
// innerHTML / chuỗi HTML phải đi qua một trong các hàm dưới đây:
//   Văn bản hoặc giá trị thuộc tính:  <b>${Safe.html(m.name)}</b>, value="${Safe.html(m.note)}"
//   Tham số chuỗi trong onclick=...:  onclick="Mod.fn(${Safe.js(s.id)})"   (KHÔNG thêm dấu nháy bao ngoài)
//   Đường dẫn src/href:               src="${Safe.url(m.avatar)}"
// Không dùng Safe cho đoạn HTML do chính mã tạo ra (vd: ${rowsHtml}) - chỉ mã hóa dữ liệu bên trong đoạn đó.
const Safe = {
  _map: { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' },

  html(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"'`]/g, (c) => Safe._map[c]);
  },

  // Chuỗi JS (có sẵn dấu nháy) an toàn bên trong thuộc tính sự kiện HTML
  js(value) {
    if (value === null || value === undefined) value = '';
    return Safe.html(JSON.stringify(String(value)).replace(/</g, '\\u003c').replace(/>/g, '\\u003e'));
  },

  // Chỉ cho phép http(s), ảnh data:image và đường dẫn tương đối; chặn javascript:, data:text/html...
  url(value, fallback = '') {
    const s = String(value === null || value === undefined ? '' : value).trim();
    if (!s) return Safe.html(fallback);
    if (/^https?:\/\//i.test(s) || /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(s)) return Safe.html(s);
    if (/^(mailto:|tel:)/i.test(s)) return Safe.html(s);
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s) && !s.startsWith('//')) return Safe.html(s); // đường dẫn tương đối
    return Safe.html(fallback);
  }
};

window.Safe = Safe;
;

// ===== js/csv-export.js =====
// Csv - Xuất CSV an toàn: bọc dấu nháy, và vô hiệu hóa ô bắt đầu bằng = + - @ (chống chèn công thức khi mở bằng Excel/Sheets)
const Csv = {
  cell(v) {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  },

  build(header, rows) {
    return '\uFEFF' + [header].concat(rows).map((r) => r.map((c) => this.cell(c)).join(',')).join('\r\n') + '\r\n';
  },

  download(filename, header, rows) {
    const blob = new Blob([this.build(header, rows)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
};

window.Csv = Csv;
;

// ===== js/modules/members.js =====
// Members Management Module for SMASH PRO Badminton Management System
// Hỗ trợ Danh sách thành viên, Tìm kiếm, Lọc theo loại hình/vai trò, Thêm/Sửa/Xóa và Đăng ký gia nhập

const MembersModule = {
  currentFilter: 'all', // 'all' | 'fixed' | 'guest' | 'admin'
  searchQuery: '',
  currentSubTab: 'list', // 'list' | 'register'

  init() {
    if (AppStorage.isGuest()) {
      this.switchSubTab('register');
    }
    this.renderMembersTab();
    this.renderBenefitsAndRules();
  },

  renderMembersTab() {
    const data = AppStorage.loadData();
    const members = data.members || [];
    const dues = data.monthlyContributions || [];
    const currentMonth = AppStorage.currentMonth();
    const isAdmin = AppStorage.can('members');

    // 1. Tính toán số liệu thống kê (KPIs)
    const fixedMembers = members.filter(m => m.type === 'fixed');
    const guestMembers = members.filter(m => m.type === 'guest');
    const adminMembers = members.filter(m => m.role === 'admin' || m.role === 'treasurer');

    // Cập nhật các thẻ KPI trên tab Thành viên
    const countTotal = document.getElementById('members-kpi-total');
    const countFixed = document.getElementById('members-kpi-fixed');
    const countGuest = document.getElementById('members-kpi-guest');
    const countAdmin = document.getElementById('members-kpi-admin');

    if (countTotal) countTotal.innerText = `${members.length} người`;
    if (countFixed) countFixed.innerText = `${fixedMembers.length} người`;
    if (countGuest) countGuest.innerText = `${guestMembers.length} người`;
    if (countAdmin) countAdmin.innerText = `${adminMembers.length} người`;

    // Cập nhật số lượng trên các nút lọc
    const filterAllCount = document.getElementById('filter-count-all');
    const filterFixedCount = document.getElementById('filter-count-fixed');
    const filterGuestCount = document.getElementById('filter-count-guest');
    const filterAdminCount = document.getElementById('filter-count-admin');

    if (filterAllCount) filterAllCount.innerText = members.length;
    if (filterFixedCount) filterFixedCount.innerText = fixedMembers.length;
    if (filterGuestCount) filterGuestCount.innerText = guestMembers.length;
    if (filterAdminCount) filterAdminCount.innerText = adminMembers.length;

    // 2. Lọc và Tìm kiếm danh sách thành viên
    let filtered = [...members];

    if (this.currentFilter === 'fixed') {
      filtered = filtered.filter(m => m.type === 'fixed');
    } else if (this.currentFilter === 'guest') {
      filtered = filtered.filter(m => m.type === 'guest');
    } else if (this.currentFilter === 'admin') {
      filtered = filtered.filter(m => m.role === 'admin' || m.role === 'treasurer');
    }

    if (this.searchQuery) {
      const q = this.searchQuery.toLowerCase();
      filtered = filtered.filter(m => 
        (m.name && m.name.toLowerCase().includes(q)) || 
        (isAdmin && m.phone && m.phone.includes(q)) ||
        (m.username && m.username.toLowerCase().includes(q))
      );
    }

    // 3. Kết xuất danh sách thành viên ra giao diện
    const container = document.getElementById('members-grid-container');
    if (!container) return;

    if (members.length === 0) {
      // Trạng thái CLB chưa có thành viên nào
      container.innerHTML = `
        <div class="card" style="grid-column: 1 / -1; text-align: center; padding: 3rem 1.5rem; background: var(--bg-card); border: 1px dashed var(--border-color);">
          <div style="width: 64px; height: 64px; border-radius: 50%; background: rgba(16, 185, 129, 0.12); color: var(--primary); display: inline-flex; align-items: center; justify-content: center; font-size: 1.8rem; margin-bottom: 1rem;">
            <i class="fas fa-users-slash"></i>
          </div>
          <h3 style="font-size: 1.2rem; font-weight: 700; color: var(--text-main); margin-bottom: 0.5rem;">Chưa có thành viên nào trong CLB</h3>
          <p style="font-size: 0.9rem; color: var(--text-secondary); max-width: 480px; margin: 0 auto 1.5rem; line-height: 1.6;">
            Hệ thống đang ở trạng thái CSDL sạch. Bạn có thể thêm thành viên mới hoặc gửi link cho các tay vợt tự đăng ký gia nhập CLB!
          </p>
          <div class="flex gap-3 justify-center flex-wrap">
            <button class="btn btn-primary admin-only" onclick="MembersModule.openAddMemberModal()">
              <i class="fas fa-user-plus"></i> Thêm thành viên đầu tiên
            </button>
            <button class="btn btn-secondary" onclick="MembersModule.switchSubTab('register')">
              <i class="fas fa-id-card"></i> Mở phiếu đăng ký gia nhập
            </button>
          </div>
        </div>
      `;
      return;
    }

    if (filtered.length === 0) {
      // Trạng thái tìm kiếm không có kết quả
      container.innerHTML = `
        <div class="card" style="grid-column: 1 / -1; text-align: center; padding: 2.5rem 1.5rem; background: var(--bg-card);">
          <div style="font-size: 2rem; color: var(--text-muted); margin-bottom: 0.75rem;">
            <i class="fas fa-search"></i>
          </div>
          <h4 style="font-size: 1.05rem; font-weight: 700; color: var(--text-main); margin-bottom: 0.35rem;">Không tìm thấy thành viên phù hợp</h4>
          <p style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 1rem;">
            Không có kết quả nào khớp với từ khóa "<strong>${Safe.html(this.searchQuery)}</strong>" trong nhóm đang lọc.
          </p>
          <button class="btn btn-secondary btn-sm" onclick="MembersModule.clearSearch()">
            <i class="fas fa-times"></i> Xóa bộ lọc tìm kiếm
          </button>
        </div>
      `;
      return;
    }

    // Kết xuất danh sách thẻ thành viên với bảo mật quyền riêng tư nghiêm ngặt
    container.innerHTML = filtered.map(m => {
      const isFixed = m.type === 'fixed';
      const isAdminRole = m.role === 'admin';
      const cardUser = (data.users || []).find(u => u.memberId === m.id || (m.username && u.username === m.username));
      const customRole = cardUser ? AppStorage.getRole(cardUser.roleId) : null;
      const isTreasurerRole = m.role === 'treasurer';
      const cleanPhone = (m.phone || '').replace(/\D/g, '');
      const memberDue = isFixed ? dues.find(d => d.memberId === m.id && d.month === currentMonth) : null;
      const isPaidDue = memberDue && memberDue.status === 'paid';
      const isPendingDue = memberDue && memberDue.status === 'pending';

      const canViewContact = AppStorage.canViewMemberContact(m.id, m.phone);
      const isSelf = canViewContact && !isAdmin;
      const maskedPhone = AppStorage.maskPhone(m.phone, m.id);

      return `
        <div class="card card-interactive member-roster-card" style="padding: 1.25rem; display: flex; flex-direction: column; justify-content: space-between; gap: 1rem; border-left: 4px solid ${isAdminRole ? 'var(--warning)' : isTreasurerRole ? 'var(--secondary)' : 'var(--primary)'};">
          <div>
            <!-- Header: Avatar, Name, Badges -->
            <div class="flex items-start justify-between gap-3" style="margin-bottom: 0.75rem;">
              <div class="flex items-center gap-3">
                <div style="position: relative; cursor: pointer;" onclick="MembersModule.handleAvatarClick(${Safe.js(m.id)})" title="${isAdmin ? 'Bấm để đổi Avatar & Sửa thông tin thành viên' : (isSelf ? 'Bấm để đổi Avatar & Sửa hồ sơ của tôi' : `Thành viên ${Safe.html(m.name)}`)}">
                  <img class="avatar avatar-md" src="${Safe.url(m.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(m.name)}&background=10b981&color=fff`)}" alt="${Safe.html(m.name)}" style="width: 48px; height: 48px; border-radius: 50%; object-fit: cover; border: 2px solid var(--border-color);">
                  <span style="position: absolute; bottom: 0; right: 0; width: 12px; height: 12px; border-radius: 50%; background: ${isFixed ? '#10b981' : '#f59e0b'}; border: 2px solid var(--bg-card);" title="${isFixed ? 'Thành viên cố định' : 'Khách vãng lai'}"></span>
                </div>
                <div>
                  <h4 style="font-size: 1rem; font-weight: 700; color: var(--text-main); margin: 0; line-height: 1.3;">${Safe.html(m.name)}</h4>
                  <div style="font-size: 0.76rem; color: var(--text-secondary); margin-top: 0.15rem;">
                    <i class="far fa-calendar-alt"></i> Gia nhập: ${Safe.html(m.joinDate || '2026-09-01')}
                  </div>
                </div>
              </div>

              <!-- Role & Type Badges -->
              <div class="flex flex-col items-end gap-1">
                <span class="badge ${isAdminRole ? 'badge-warning' : isTreasurerRole ? 'badge-info' : 'badge-neutral'}" style="font-size: 0.68rem; font-weight: 700; padding: 0.15rem 0.45rem;">
                  <i class="fas ${isAdminRole ? 'fa-crown' : isTreasurerRole ? 'fa-wallet' : 'fa-user'}"></i>
                  ${isAdminRole ? 'Admin CLB' : isTreasurerRole ? 'Thủ quỹ' : customRole ? Safe.html(customRole.name) : 'Thành viên'}
                </span>
                <span class="badge ${isFixed ? 'badge-paid' : 'badge-warning'}" style="font-size: 0.65rem; padding: 0.1rem 0.4rem;">
                  ${isFixed ? '🏸 Cố định' : '⚡ Vãng lai'}
                </span>
                ${!isFixed && window.MembershipModule && MembershipModule.isPendingMember(m, data) ? `<span class="badge badge-info" style="font-size: 0.62rem; padding: 0.1rem 0.4rem;">⏳ Chờ duyệt cố định</span>` : ''}
                ${isAdmin && !(data.users || []).some(u => u.memberId === m.id || (m.username && u.username === m.username)) ? `<span class="badge badge-neutral" style="font-size: 0.62rem; padding: 0.1rem 0.4rem;" title="Chỉ được ghi tên, chưa có tài khoản đăng nhập"><i class="fas fa-user-slash"></i> Chưa có tài khoản</span>` : ''}
              </div>
            </div>

            <!-- Details: Phone, Zalo, Dues Status (Bảo mật quyền riêng tư) -->
            <div style="background: var(--bg-input); padding: 0.65rem 0.85rem; border-radius: var(--radius-md); font-size: 0.82rem; display: flex; flex-direction: column; gap: 0.4rem; border: 1px solid var(--border-color);">
              <div class="flex items-center justify-between">
                <span class="text-secondary"><i class="fas fa-phone-alt text-primary"></i> SĐT / Zalo:</span>
                <div class="flex items-center gap-2">
                  ${canViewContact && !m.phone ? `<span class="text-muted" style="font-size: 0.78rem;">Chưa có SĐT</span>` : canViewContact ? `
                    <a href="tel:${Safe.html(m.phone)}" class="font-mono font-bold" style="color: var(--text-main); text-decoration: none;" title="Bấm để gọi">${Safe.html(m.phone)}</a>
                    ${cleanPhone ? `<a href="https://zalo.me/${cleanPhone}" target="_blank" rel="noopener" class="badge badge-info" style="font-size: 0.65rem; padding: 0.1rem 0.35rem;" title="Mở Zalo"><i class="fas fa-comment-dots"></i> Zalo</a>` : ''}
                  ` : `
                    <span class="font-mono text-muted font-bold" title="Thông tin được ẩn để bảo vệ quyền riêng tư">${Safe.html(maskedPhone)}</span>
                    <span class="badge badge-neutral" style="font-size: 0.62rem; padding: 0.1rem 0.3rem;" title="Bảo mật"><i class="fas fa-lock text-muted"></i> Riêng tư</span>
                  `}
                </div>
              </div>

              ${isFixed && (isAdmin || isSelf) ? `
                <div class="flex items-center justify-between" style="border-top: 1px dashed var(--border-color); padding-top: 0.35rem; margin-top: 0.1rem;">
                  <span class="text-secondary"><i class="fas fa-hashtag text-primary"></i> Mã chuyển khoản:</span>
                  <span class="font-mono font-bold" style="letter-spacing: 0.08em;">${Safe.html(window.TransferCode ? TransferCode.codeOf(m, members) : '')}</span>
                </div>
              ` : ''}

              ${isFixed ? `
                <div class="flex items-center justify-between" style="border-top: 1px dashed var(--border-color); padding-top: 0.35rem; margin-top: 0.1rem;">
                  <span class="text-secondary"><i class="fas fa-coins text-warning"></i> Quỹ tháng ${Number(currentMonth.slice(5))}:</span>
                  ${(isAdmin || isSelf) ? `
                    <span class="badge ${isPaidDue ? 'badge-paid' : isPendingDue ? 'badge-info' : 'badge-danger'}" style="font-size: 0.68rem;">
                      ${isPaidDue ? '<i class="fas fa-check-circle"></i> Đã đóng quỹ' : isPendingDue ? '<i class="fas fa-clock"></i> Chờ duyệt' : '<i class="fas fa-exclamation-circle"></i> Chưa đóng quỹ'}
                    </span>
                  ` : `
                    <span class="badge badge-neutral" style="font-size: 0.65rem;" title="Thông tin đóng quỹ chỉ hiển thị cho Ban Quản trị và chính chủ"><i class="fas fa-lock text-muted"></i> Riêng tư</span>
                  `}
                </div>
              ` : `
                <div class="flex items-center justify-between" style="border-top: 1px dashed var(--border-color); padding-top: 0.35rem; margin-top: 0.1rem;">
                  <span class="text-secondary"><i class="fas fa-bolt text-secondary"></i> Hình thức:</span>
                  <span class="text-muted" style="font-size: 0.75rem;">Thu phí theo từng buổi đánh</span>
                </div>
              `}

              ${m.note ? `
                <div style="font-size: 0.75rem; color: var(--text-muted); font-style: italic; border-top: 1px dashed var(--border-color); padding-top: 0.3rem;">
                  "${Safe.html(m.note)}"
                </div>
              ` : ''}
            </div>
          </div>

          <!-- Actions Footer: Phân quyền bảo mật (Admin có toàn quyền, Member chỉ sửa hồ sơ của mình) -->
          <div class="flex items-center justify-between" style="border-top: 1px solid var(--border-color); padding-top: 0.75rem; margin-top: 0.25rem;">
            <div class="flex gap-1">
              ${isAdmin ? `
                ${cleanPhone ? `
                  <a href="https://zalo.me/${cleanPhone}" target="_blank" rel="noopener" class="btn btn-secondary btn-sm" style="padding: 0.25rem 0.55rem; font-size: 0.75rem;" title="Nhắn tin Zalo">
                    <i class="fas fa-comment-dots text-primary"></i> <span>Zalo</span>
                  </a>
                ` : ''}
                ${m.phone ? `<a href="tel:${Safe.html(m.phone)}" class="btn btn-secondary btn-sm" style="padding: 0.25rem 0.55rem; font-size: 0.75rem;" title="Gọi điện thoại">
                  <i class="fas fa-phone-alt"></i>
                </a>` : ''}
              ` : `
                <span class="text-muted" style="font-size: 0.75rem; display: inline-flex; align-items: center; gap: 0.35rem;">
                  <i class="fas fa-user-shield text-primary"></i> <span>Bảo mật riêng tư</span>
                </span>
              `}
            </div>

            <div class="flex gap-1">
              ${isAdmin && !isFixed && m.role === 'member' ? `
                <button class="btn btn-primary btn-sm" onclick="MembersModule.setMemberType(${Safe.js(m.id)}, 'fixed')" title="Nâng khách vãng lai lên thành viên chính thức (cố định)" style="padding: 0.25rem 0.55rem; font-size: 0.75rem;">
                  <i class="fas fa-user-check"></i> <span>Lên chính thức</span>
                </button>
              ` : ''}
              ${isAdmin ? `
                <button class="btn btn-secondary btn-sm" onclick="MembersModule.openEditMemberModal(${Safe.js(m.id)})" title="Chỉnh sửa thông tin thành viên" style="padding: 0.25rem 0.55rem; font-size: 0.75rem;">
                  <i class="fas fa-edit"></i> <span>Sửa</span>
                </button>
                <button class="btn btn-outline-danger btn-sm" onclick="MembersModule.deleteMember(${Safe.js(m.id)})" title="Xóa thành viên khỏi CLB" style="padding: 0.25rem 0.55rem; font-size: 0.75rem;">
                  <i class="fas fa-trash"></i>
                </button>
              ` : (isSelf ? `
                <button class="btn btn-primary btn-sm" onclick="App.openUserProfileModal()" title="Chỉnh sửa thông tin cá nhân & đổi Avatar của tôi" style="padding: 0.25rem 0.6rem; font-size: 0.75rem;">
                  <i class="fas fa-user-edit"></i> <span>Hồ sơ của tôi</span>
                </button>
              ` : '')}
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Đồng bộ danh sách rút gọn trong form đăng ký
    this.renderPublicMemberRoster();
  },

  handleAvatarClick(memberId) {
    const data = AppStorage.loadData();
    const m = (data.members || []).find(mem => mem.id === memberId);
    if (!m) return;
    if (AppStorage.can('members')) {
      this.openEditMemberModal(memberId);
    } else if (AppStorage.canViewMemberContact(m.id, m.phone)) {
      App.openUserProfileModal();
    } else {
      App.showToast(`🏸 Thành viên "${m.name}" (${m.type === 'fixed' ? 'Hội viên Cố định' : 'Khách vãng lai'})`, "info");
    }
  },

  setFilter(filter, btnEl = null) {
    this.currentFilter = filter;
    document.querySelectorAll('#members-filter-bar .segmented-btn, #members-filter-bar .filter-tab').forEach(b => b.classList.remove('active'));
    if (btnEl) {
      btnEl.classList.add('active');
    } else {
      const match = document.querySelector(`#members-filter-bar [data-filter="${filter}"]`);
      if (match) match.classList.add('active');
    }
    this.renderMembersTab();
  },

  handleSearch(query) {
    this.searchQuery = (query || '').trim();
    this.renderMembersTab();
  },

  clearSearch() {
    this.searchQuery = '';
    const input = document.getElementById('members-search-input');
    if (input) input.value = '';
    this.currentFilter = 'all';
    this.setFilter('all');
  },

  switchSubTab(tab) {
    if (tab === 'list' && AppStorage.isGuest()) {
      App.showToast("⚠️ Danh sách thành viên nội bộ chỉ dành cho Hội viên chính thức. Vui lòng đăng ký gia nhập CLB hoặc đăng nhập!", "info");
      return;
    }

    this.currentSubTab = tab;
    const btnList = document.getElementById('subtab-btn-members-list');
    const btnReg = document.getElementById('subtab-btn-members-reg');
    const panelList = document.getElementById('subtab-panel-members-list');
    const panelReg = document.getElementById('subtab-panel-members-reg');

    if (tab === 'list') {
      btnList?.classList.add('active');
      btnReg?.classList.remove('active');
      if (panelList) panelList.style.display = 'block';
      if (panelReg) panelReg.style.display = 'none';
      this.renderMembersTab();
    } else {
      btnReg?.classList.add('active');
      btnList?.classList.remove('active');
      if (panelList) panelList.style.display = 'none';
      if (panelReg) panelReg.style.display = 'block';
      this.renderBenefitsAndRules();
      this.renderJoinCard();
      this.renderPublicMemberRoster();
      setTimeout(() => document.getElementById('quick-mem-name')?.focus(), 100);
    }
  },

  openAddMemberModal() {
    if (!AppStorage.can('members')) {
      App.showToast("Chức năng thêm thành viên trực tiếp chỉ dành cho Ban Quản trị CLB. Vui lòng đăng nhập!", "warning");
      App.showAuthModal('login');
      return;
    }

    const avatarHtml = App.renderAvatarPickerHtml('add-mem', '', 'Hội viên mới');

    const modalBody = `
      <form onsubmit="MembersModule.saveNewMember(event)">
        <!-- Bộ chọn Avatar -->
        ${avatarHtml}

        <div class="form-group">
          <label class="form-label font-bold">Họ và tên thành viên *</label>
          <input type="text" id="new-mem-name" class="form-control" placeholder="VD: Nguyễn Văn Anh" required>
        </div>

        <div style="grid-template-columns: 1fr 1fr; gap: 1rem; display: grid;">
          <div class="form-group">
            <label class="form-label font-bold">Số điện thoại (Zalo)</label>
            <input type="tel" id="new-mem-phone" class="form-control" placeholder="0912345678">
          </div>
          <div class="form-group">
            <label class="form-label">Email liên hệ (tùy chọn)</label>
            <input type="email" id="new-mem-email" class="form-control" placeholder="email@domain.com">
          </div>
        </div>

        <div style="grid-template-columns: 1fr 1fr; gap: 1rem; display: grid;">
          <div class="form-group">
            <label class="form-label font-bold">Hình thức tham gia</label>
            <select id="new-mem-type" class="form-select">
              <option value="fixed" selected>🏸 Cố định (Góp quỹ tháng)</option>
              <option value="guest">⚡ Vãng lai (Thu theo buổi)</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label font-bold">Vai trò trong CLB</label>
            <select id="new-mem-role" class="form-select">
              <option value="member" selected>Thành viên</option>
              <option value="treasurer">Thủ quỹ</option>
              <option value="admin">Quản trị viên</option>
            </select>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Ghi chú / Trình độ đánh cầu</label>
          <input type="text" id="new-mem-note" class="form-control" placeholder="VD: Trình độ khá, thuận tay trái...">
        </div>

        <div class="form-group" style="background: var(--bg-input); padding: 0.85rem; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
          <label class="flex items-center gap-2" style="font-size: 0.85rem; font-weight: 600; cursor: pointer;">
            <input type="checkbox" id="new-mem-account" onchange="(document.getElementById('new-mem-pwd-wrap') || { style: {} }).style.display = this.checked ? 'block' : 'none'" style="accent-color: var(--primary);">
            <span><i class="fas fa-key text-primary"></i> Tạo luôn tài khoản đăng nhập</span>
          </label>
          <div id="new-mem-pwd-wrap" style="display: none; margin-top: 0.5rem;">
            <input type="password" id="new-mem-password" class="form-control" autocomplete="new-password" placeholder="Mật khẩu ban đầu (tối thiểu 8 ký tự, không đoán được)">
            <span class="text-secondary" style="font-size: 0.75rem; display: block; margin-top: 0.25rem;">Gửi mật khẩu này cho thành viên; họ nên đổi ngay sau khi đăng nhập. Không đặt trùng SĐT hay 123456.</span>
          </div>
          <span class="text-secondary" style="font-size: 0.75rem; display: block; margin-top: 0.35rem;">Không tích: chỉ ghi tên (không có tài khoản).</span>
        </div>

        <div class="modal-footer" style="padding: 1rem 0 0 0;">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Hủy</button>
          <button type="submit" class="btn btn-primary"><i class="fas fa-user-plus"></i> Thêm thành viên</button>
        </div>
      </form>
    `;

    App.openModal("👤 Thêm thành viên mới vào CLB", modalBody);
  },

  saveNewMember(e) {
    if (e && e.preventDefault) e.preventDefault();
    const v = (id) => (document.getElementById(id)?.value || '').trim();
    const name = v('new-mem-name');
    const res = this.createMember({
      name, phone: v('new-mem-phone'), email: v('new-mem-email'), note: v('new-mem-note'),
      type: v('new-mem-type') || 'fixed', role: v('new-mem-role') || 'member',
      avatar: document.getElementById('add-mem-avatar-val')?.value || '',
      createAccount: !!document.getElementById('new-mem-account')?.checked, password: v('new-mem-password')
    });
    if (!res.success) {
      App.showToast(res.message, 'warning');
      return;
    }
    App.closeModal();
    App.showToast(`🎉 Đã thêm thành viên "${name}"${res.username ? ` (tên đăng nhập: ${res.username})` : ' (chưa có tài khoản)'}!`, 'success');
    this.afterMemberChange();
  },

  openEditMemberModal(memberId) {
    if (!AppStorage.can('members')) {
      App.showToast("Chức năng chỉnh sửa thành viên chỉ dành cho Ban Quản trị CLB!", "warning");
      return;
    }

    const data = AppStorage.loadData();
    const m = (data.members || []).find(mem => mem.id === memberId);
    if (!m) return;

    const user = (data.users || []).find(u => u.memberId === memberId || (u.phone && m.phone && u.phone.replace(/\D/g, '') === m.phone.replace(/\D/g, ''))) || {};
    const avatarHtml = App.renderAvatarPickerHtml('edit-mem', m.avatar, m.name);

    const modalBody = `
      <form onsubmit="MembersModule.saveEditMember(event, ${Safe.js(m.id)})">
        <!-- Bộ chọn và Đổi ảnh đại diện -->
        ${avatarHtml}

        <div class="form-group">
          <label class="form-label font-bold">Họ và tên *</label>
          <input type="text" id="edit-mem-name" class="form-control" value="${Safe.html(m.name)}" required>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
          <div class="form-group">
            <label class="form-label font-bold">Số điện thoại *</label>
            <input type="tel" id="edit-mem-phone" class="form-control" value="${Safe.html(m.phone)}" required>
          </div>
          <div class="form-group">
            <label class="form-label">Email liên hệ (tùy chọn)</label>
            <input type="email" id="edit-mem-email" class="form-control" value="${Safe.html(m.email || user.email || '')}" placeholder="email@domain.com">
          </div>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
          <div class="form-group">
            <label class="form-label font-bold">Loại thành viên</label>
            <select id="edit-mem-type" class="form-select">
              <option value="fixed" ${m.type === 'fixed' ? 'selected' : ''}>🏸 Cố định (Góp quỹ tháng)</option>
              <option value="guest" ${m.type === 'guest' ? 'selected' : ''}>⚡ Vãng lai (Thu theo buổi)</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label font-bold">Vai trò</label>
            <select id="edit-mem-role" class="form-select" ${AppStorage.isSuperAdmin() ? '' : 'disabled title="Chỉ Quản trị viên được đổi vai trò hệ thống"'}>
              <option value="member" ${m.role === 'member' ? 'selected' : ''}>Thành viên</option>
              <option value="treasurer" ${m.role === 'treasurer' ? 'selected' : ''}>Thủ quỹ</option>
              <option value="admin" ${m.role === 'admin' ? 'selected' : ''}>Quản trị viên</option>
            </select>
          </div>
        </div>

        ${AppStorage.isSuperAdmin() && user.username && AppStorage.getRoles().length ? `
        <div class="form-group">
          <label class="form-label font-bold"><i class="fas fa-user-shield text-primary"></i> Vai trò tùy chỉnh (quyền được giao)</label>
          <select id="edit-mem-role-id" class="form-select">
            <option value="">— Không có —</option>
            ${AppStorage.getRoles().map(r => `<option value="${Safe.html(r.id)}" ${user.roleId === r.id ? 'selected' : ''}>${Safe.html(r.name)} (${(r.perms || []).map(p => Safe.html(AppStorage.PERM_LABELS[p] || p)).join(', ') || 'chưa có quyền'})</option>`).join('')}
          </select>
          <span class="text-secondary" style="font-size: 0.78rem;">Quản lý vai trò tại Cài đặt → Vai trò & quyền. Chỉ áp dụng cho thành viên thường.</span>
        </div>` : ''}

        ${AppStorage.isSuperAdmin() && user.username ? `
        <label class="form-group" style="display: flex; align-items: flex-start; gap: 0.5rem; font-size: 0.85rem; cursor: pointer;">
          <input type="checkbox" id="edit-mem-can-schedule" ${user.canScheduleVotes === true ? 'checked' : ''} style="margin-top: 0.2rem;">
          <span><b><i class="fas fa-calendar-plus text-primary"></i> Được lên lịch bình chọn tự động</b><br>
          <span class="text-secondary" style="font-size: 0.78rem;">Tạo/sửa lịch bình chọn lặp lại, hẹn giờ mở vote. Không có quyền quản trị khác (Admin/Thủ quỹ luôn có quyền này).</span></span>
        </label>` : ''}

        <div class="form-group">
          <label class="form-label">Ghi chú / Trình độ</label>
          <input type="text" id="edit-mem-note" class="form-control" value="${Safe.html(m.note || user.note || '')}" placeholder="VD: Trình độ trung bình khá...">
        </div>

        <div class="form-group" style="background: var(--bg-input); padding: 0.85rem; border-radius: var(--radius-md); border: 1px solid var(--border-color); margin-top: 0.5rem;">
          <label class="form-label" style="font-weight: 600; margin-bottom: 0.25rem;">
            <i class="fas fa-key text-primary"></i> ${user.username ? 'Đặt lại mật khẩu thành viên:' : 'Cấp tài khoản đăng nhập (đặt mật khẩu):'}
          </label>
          <input type="password" id="edit-mem-password" class="form-control" placeholder="Nhập mật khẩu mới nếu muốn thay đổi (tối thiểu 8 ký tự)...">
          <span class="text-secondary" style="font-size: 0.75rem; margin-top: 0.25rem; display: block;">
            ${user.username ? 'Để trống nếu muốn giữ nguyên mật khẩu hiện tại của thành viên này.' : 'Thành viên này chưa có tài khoản. Nhập mật khẩu (cần có SĐT làm tên đăng nhập) để cấp tài khoản; để trống nếu không cần.'}
          </span>
        </div>

        <div class="modal-footer" style="padding: 1rem 0 0 0;">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Hủy</button>
          <button type="submit" class="btn btn-primary"><i class="fas fa-save"></i> Lưu thay đổi</button>
        </div>
      </form>
    `;

    App.openModal("✏️ Chỉnh sửa thông tin & Avatar thành viên", modalBody);
  },

  async saveEditMember(e, memberId) {
    if (e && e.preventDefault) e.preventDefault();
    const data = AppStorage.loadData();
    const m = (data.members || []).find(mem => mem.id === memberId);
    if (!m) return;

    m.name = (document.getElementById('edit-mem-name')?.value || '').trim();
    m.phone = (document.getElementById('edit-mem-phone')?.value || '').trim();
    m.email = (document.getElementById('edit-mem-email')?.value || '').trim();
    m.note = (document.getElementById('edit-mem-note')?.value || '').trim();
    m.type = document.getElementById('edit-mem-type')?.value || 'fixed';
    m.role = document.getElementById('edit-mem-role')?.value || 'member';
    const avatar = document.getElementById('edit-mem-avatar-val')?.value || m.avatar;
    if (avatar) m.avatar = avatar;

    const newPwd = (document.getElementById('edit-mem-password')?.value || '').trim();

    // Cập nhật User tương ứng (tìm theo memberId, username, phone hoặc role admin)
    const user = (data.users || []).find(u => 
      u.memberId === memberId || 
      (m.username && u.username === m.username) || 
      (u.phone && m.phone && u.phone.replace(/\D/g, '') === m.phone.replace(/\D/g, '')) ||
      (m.id === 'mem_admin' && u.username === 'admin')
    );

    if (!user && newPwd) {
      // Thành viên mới chỉ được ghi tên: cấp tài khoản đăng nhập khi Admin đặt mật khẩu
      const policy = AppStorage._passwordPolicyError(newPwd);
      const uname = ((m.phone || '').replace(/\D/g, '').length >= 9) ? (m.phone || '').replace(/\D/g, '') : (m.username || '');
      if (policy || !uname) {
        App.showToast(policy || 'Thành viên chưa có SĐT để làm tên đăng nhập. Hãy nhập SĐT trước.', 'error');
        return;
      }
      if (AuthCore.isWeakPassword(newPwd, { username: uname, phone: m.phone })) {
        App.showToast('Mật khẩu quá dễ đoán (trùng SĐT/tên đăng nhập hoặc mật khẩu phổ biến). Hãy đặt mật khẩu khác.', 'error');
        return;
      }
      if ((data.users || []).some(u => (u.username || '').toLowerCase() === uname.toLowerCase())) {
        App.showToast(`Tên đăng nhập "${uname}" đã tồn tại.`, 'error');
        return;
      }
      m.username = uname;
      if (!data.users) data.users = [];
      data.users.push({
        id: 'user_' + Date.now(), username: uname, password: AppStorage.hashPassword(newPwd), name: m.name, phone: m.phone,
        email: m.email, note: m.note, role: m.role, memberId: m.id, type: m.type, avatar: m.avatar || avatar, createdAt: new Date().toISOString()
      });
      App.showToast(`Đã cấp tài khoản đăng nhập "${uname}" cho ${m.name}.`, 'success');
    }

    if (user) {
      user.name = m.name;
      user.phone = m.phone;
      user.email = m.email;
      user.note = m.note;
      user.role = m.role;
      user.type = m.type;
      if (avatar) user.avatar = avatar;
      const roleSel = document.getElementById('edit-mem-role-id');
      if (roleSel && AppStorage.isSuperAdmin()) {
        if (roleSel.value && m.role === 'member') user.roleId = roleSel.value;
        else delete user.roleId;
      }
      const canSchedule = document.getElementById('edit-mem-can-schedule');
      if (canSchedule && AppStorage.isSuperAdmin()) {
        if (canSchedule.checked) user.canScheduleVotes = true;
        else delete user.canScheduleVotes;
      }
      if (newPwd) {
        if (newPwd.length < 8) {
          App.showToast("Mật khẩu mới phải có tối thiểu 8 ký tự trở lên!", "error");
          return;
        }
        if (/\s/.test(newPwd)) {
          App.showToast("Mật khẩu không được chứa khoảng trắng!", "error");
          return;
        }
        user.password = AppStorage.hashPassword(newPwd);
        user.updatedAt = new Date().toISOString();
      }
    }

    // Nếu đang chỉnh sửa chính tài khoản đang đăng nhập
    const currentUser = AppStorage.getCurrentUser();
    if (currentUser && (currentUser.id === user?.id || currentUser.memberId === memberId || (user && currentUser.username === user.username))) {
      data.currentUser = user || currentUser;
      try {
        const rawSession = sessionStorage.getItem("SMASH_PRO_AUTH_SESSION_V2") || localStorage.getItem("SMASH_PRO_AUTH_SESSION_V2");
        if (rawSession) {
          const sess = JSON.parse(rawSession);
          sess.name = m.name;
          if (sessionStorage.getItem("SMASH_PRO_AUTH_SESSION_V2")) sessionStorage.setItem("SMASH_PRO_AUTH_SESSION_V2", JSON.stringify(sess));
          if (localStorage.getItem("SMASH_PRO_AUTH_SESSION_V2")) localStorage.setItem("SMASH_PRO_AUTH_SESSION_V2", JSON.stringify(sess));
        }
      } catch (e) {}
    }

    AppStorage.reconcileUsersAndMembers(data);
    const saved = await AppStorage.saveDataWithCloudAck(data);
    App.closeModal();
    App.showToast(saved.success
      ? `🎉 Đã cập nhật thông tin và ảnh đại diện của "${m.name}" thành công!`
      : `Đã lưu thay đổi của "${m.name}" trên máy này. ${saved.message || ''}`, saved.success ? "success" : "warning");

    this.renderMembersTab();
    if (window.SettingsModule) SettingsModule.renderMembersAdmin();
    App.renderUserRoleSelector();
    App.renderUserHeaderAndSidebar();
    if (window.App && typeof App.refreshDashboardStats === 'function') App.refreshDashboardStats();
    if (window.FundModule && typeof FundModule.renderFundDashboard === 'function') FundModule.renderFundDashboard();
  },

  // Nâng khách vãng lai lên thành viên chính thức (type 'fixed') hoặc ngược lại bằng 1 thao tác, có báo kết quả lưu lên máy chủ.
  // Ghi cả hồ sơ thành viên lẫn tài khoản (nếu có) để hai bên không lệch nhau; yêu cầu "chờ duyệt" của họ (nếu có) được đóng lại.
  async setMemberType(memberId, type) {
    if (!AppStorage.can('members')) {
      App.showToast('Bạn không có quyền đổi loại thành viên.', 'warning');
      return { success: false };
    }
    const want = type === 'fixed' ? 'fixed' : 'guest';
    const data = AppStorage.loadData();
    const m = (data.members || []).find(x => x.id === memberId);
    if (!m) return { success: false, message: 'Không tìm thấy thành viên.' };
    if (m.role !== 'member') {
      App.showToast('Chỉ đổi loại cho thành viên thường (không áp dụng cho Admin/Thủ quỹ).', 'warning');
      return { success: false };
    }
    if (m.type === want) return { success: true, unchanged: true };
    const label = want === 'fixed' ? 'thành viên chính thức' : 'khách vãng lai';
    if (!(await App.confirm(`Chuyển "${m.name}" thành ${label}?` + (want === 'fixed' ? '\nHọ sẽ phải góp quỹ tháng và xem được sổ quỹ CLB.' : '\nHọ sẽ không còn góp quỹ tháng và không xem được sổ quỹ.'), { danger: false, okText: 'Chuyển' }))) {
      return { success: false, cancelled: true };
    }
    m.type = want;
    const user = (data.users || []).find(u => u.memberId === m.id || (m.username && u.username === m.username));
    if (user) {
      user.type = want;
      if (want === 'fixed' && user.fixedRequest === 'pending') {
        user.fixedRequest = 'approved';
        user.fixedDecidedAt = Date.now();
        const admin = AppStorage.getCurrentUser();
        user.fixedDecidedBy = admin ? admin.username : '';
      }
    }
    // Chuyển lên chính thức: tạo luôn phiếu quỹ tháng này (nếu người dùng có quyền ghi quỹ)
    if (want === 'fixed' && AppStorage.can('finance') && window.FundModule) {
      const month = FundModule.currentMonth;
      const id = `due_${month}_${m.id}`;
      if (!(data.monthlyContributions || []).some(d => d.id === id)) {
        const fee = FundModule.getClubFee ? FundModule.getClubFee(data) : 0;
        if (!data.monthlyContributions) data.monthlyContributions = [];
        data.monthlyContributions.push({ id, month, memberId: m.id, amount: fee, status: 'unpaid', method: null, paidAt: null, billImage: null, approvedBy: null, approvedAt: null, note: '' });
      }
    }
    const result = await AppStorage.saveDataWithCloudAck(data);
    App.showToast(result.success
      ? `✅ Đã chuyển "${m.name}" thành ${label}.`
      : `"${m.name}" đã được chuyển thành ${label} trên máy này nhưng CHƯA lưu lên máy chủ: ${result.message}`, result.success ? 'success' : 'warning');
    this.renderMembersTab();
    if (window.MembershipModule) MembershipModule.renderPanel();
    if (window.FundModule && typeof FundModule.renderFundDashboard === 'function') FundModule.renderFundDashboard();
    App.refreshDashboardStats();
    return result;
  },

  async deleteMember(memberId) {
    if (!AppStorage.can('members')) {
      App.showToast("Chức năng xóa thành viên chỉ dành cho Ban Quản trị CLB!", "warning");
      return;
    }

    const data = AppStorage.loadData();
    const member = (data.members || []).find(m => m.id === memberId);
    const memberName = member ? member.name : "thành viên";

    if (!(await App.confirm(`Bạn có chắc chắn muốn xóa "${memberName}" khỏi danh sách CLB?\n(Lưu ý: Tài khoản và dữ liệu đóng quỹ tương ứng sẽ được dọn sạch)`))) {
      return;
    }

    // Ghi nhận Tombstones để chống hồi sinh từ Cloud Sync
    if (!Array.isArray(data.deletedMemberIds)) data.deletedMemberIds = [];
    if (!Array.isArray(data.deletedUserIds)) data.deletedUserIds = [];

    data.deletedMemberIds.push(memberId);
    if (member && member.username && member.username !== 'admin') {
      data.deletedUserIds.push(member.username);
    }
    const matchingUsers = (data.users || []).filter(u => u.username !== 'admin' && (u.memberId === memberId || (member && u.username === member.username)));
    matchingUsers.forEach(u => {
      data.deletedUserIds.push(u.id);
      if (u.username) data.deletedUserIds.push(u.username);
    });

    data.members = (data.members || []).filter(m => m.id !== memberId);
    data.users = (data.users || []).filter(u => u.username === 'admin' || (u.memberId !== memberId && (!member || u.username !== member.username)));
    if (data.monthlyContributions) {
      data.monthlyContributions = data.monthlyContributions.filter(d => d.memberId !== memberId);
    }

    AppStorage.saveData(data, true);
    this.renderMembersTab();
    if (window.SettingsModule) SettingsModule.renderMembersAdmin();
    App.renderUserRoleSelector();
    App.renderUserHeaderAndSidebar();
    if (window.App && typeof App.refreshDashboardStats === 'function') App.refreshDashboardStats();
    if (window.FundModule && typeof FundModule.renderFundDashboard === 'function') FundModule.renderFundDashboard();
    App.showToast(`Đã xóa thành viên "${memberName}" khỏi danh sách CLB!`, "info");
  },

  // ---------------- Thẻ "Tham gia CLB" ở tab Điều khoản ----------------
  // Admin/Thủ quỹ: form thêm nhanh thành viên (có thể KHÔNG tạo tài khoản đăng nhập, dành cho khách/người chưa dùng app).
  // Người khác: hướng dẫn tạo tài khoản (đăng ký dùng chung một luồng ở hộp thoại Đăng nhập/Đăng ký).
  renderJoinCard() {
    const body = document.getElementById('join-card-body');
    if (!body) return;
    const isAdmin = AppStorage.can('members');
    const title = document.getElementById('join-card-title');
    const tabBtn = document.getElementById('subtab-btn-members-reg');
    if (tabBtn) tabBtn.innerHTML = isAdmin ? '<i class="fas fa-user-plus"></i> Thêm thành viên' : '<i class="fas fa-id-card"></i> Điều khoản & Đăng ký';
    if (title) title.innerHTML = isAdmin ? '<i class="fas fa-user-plus text-primary"></i> Thêm thành viên' : '<i class="fas fa-id-card text-primary"></i> Tham gia CLB';

    if (isAdmin) {
      body.innerHTML = `
        <form onsubmit="MembersModule.addMemberQuick(event)">
          <p class="text-secondary" style="font-size: 0.82rem; margin: 0 0 0.9rem;">
            Ghi tên khách hoặc thành viên <b>chưa có tài khoản</b> để tính quỹ, chia tiền, điểm danh. Mỗi người được cấp một <b>mã chuyển khoản riêng</b>.
          </p>
          <div class="form-group">
            <label class="form-label font-bold" for="quick-mem-name">Họ và tên *</label>
            <input type="text" id="quick-mem-name" class="form-control" placeholder="VD: Trần Hoàng Nam" maxlength="100" required>
          </div>
          <div class="form-group">
            <label class="form-label" for="quick-mem-phone">Số điện thoại / Zalo (tùy chọn)</label>
            <input type="tel" id="quick-mem-phone" class="form-control" placeholder="0988xxxxxx">
          </div>
          <div class="form-group">
            <label class="form-label font-bold" for="quick-mem-type">Hình thức tham gia</label>
            <select id="quick-mem-type" class="form-select">
              <option value="guest" selected>⚡ Khách vãng lai (thu theo buổi)</option>
              <option value="fixed">🏸 Thành viên cố định (góp quỹ tháng)</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="quick-mem-note">Ghi chú / Trình độ</label>
            <input type="text" id="quick-mem-note" class="form-control" maxlength="300" placeholder="VD: Tay trái, trình độ khá...">
          </div>
          <label class="flex items-center gap-2" style="font-size: 0.85rem; cursor: pointer; margin: 0.25rem 0 0.5rem;">
            <input type="checkbox" id="quick-mem-account" onchange="(document.getElementById('quick-mem-pwd-wrap') || { style: {} }).style.display = this.checked ? 'block' : 'none'" style="accent-color: var(--primary);">
            <span>Tạo luôn tài khoản đăng nhập cho người này</span>
          </label>
          <div id="quick-mem-pwd-wrap" class="form-group" style="display: none;">
            <label class="form-label" for="quick-mem-password">Mật khẩu ban đầu * (tối thiểu 8 ký tự, không đoán được)</label>
            <input type="password" id="quick-mem-password" class="form-control" autocomplete="new-password" placeholder="Gửi mật khẩu này cho thành viên, họ sẽ tự đổi sau">
          </div>
          <button type="submit" class="btn btn-primary w-full btn-lg" style="margin-top: 0.75rem;">
            <i class="fas fa-user-plus"></i> Thêm thành viên
          </button>
        </form>`;
      return;
    }

    const user = AppStorage.getCurrentUser();
    body.innerHTML = user ? `
      <p class="text-secondary" style="font-size: 0.9rem; line-height: 1.6; margin: 0;">
        Bạn đang đăng nhập với tài khoản <b>${Safe.html(user.name || user.username)}</b>.
        ${user.type === 'fixed' ? 'Bạn là thành viên cố định của CLB.' : 'Muốn trở thành thành viên cố định, hãy gửi yêu cầu trong <b>Hồ sơ cá nhân</b>; Ban quản trị sẽ duyệt.'}
      </p>` : `
      <p class="text-secondary" style="font-size: 0.9rem; line-height: 1.6; margin: 0 0 1rem;">
        Tạo tài khoản để bình chọn các buổi đánh, đóng quỹ và nhận thông báo. Bạn có thể đăng ký bằng số điện thoại hoặc tài khoản Google.
        Muốn làm thành viên cố định, chọn "cố định" khi đăng ký và chờ Ban quản trị duyệt.
      </p>
      <button type="button" class="btn btn-primary w-full btn-lg" onclick="App.showAuthModal('register')">
        <i class="fas fa-user-plus"></i> Tạo tài khoản
      </button>`;
  },

  // Tạo thành viên (dùng chung cho form nhanh và hộp thoại "Thêm thành viên").
  // createAccount=false -> chỉ ghi tên (không có tài khoản/mật khẩu); true -> bắt buộc mật khẩu hợp lệ do Admin đặt.
  createMember({ name, phone, email = '', note = '', type = 'guest', role = 'member', avatar = '', createAccount = false, password = '' }) {
    if (!AppStorage.can('members')) return { success: false, message: 'Chỉ Ban quản trị mới được thêm thành viên.' };
    name = String(name || '').trim();
    phone = String(phone || '').trim();
    const cleanPhone = phone.replace(/\D/g, '');
    if (name.length < 2) return { success: false, message: 'Vui lòng nhập họ và tên (tối thiểu 2 ký tự)!' };
    if (phone && cleanPhone.length < 9) return { success: false, message: 'Số điện thoại chưa hợp lệ (tối thiểu 9 chữ số).' };
    if (role === 'admin' && !AppStorage.isSuperAdmin()) return { success: false, message: 'Chỉ Quản trị viên mới được cấp vai trò Quản trị viên.' };

    const data = AppStorage.loadData();
    if (!data.members) data.members = [];
    if (!data.users) data.users = [];
    if (cleanPhone && (data.members.some((m) => m.phone && m.phone.replace(/\D/g, '') === cleanPhone) ||
      data.users.some((u) => u.phone && u.phone.replace(/\D/g, '') === cleanPhone))) {
      return { success: false, message: 'Số điện thoại này đã tồn tại trong danh sách thành viên!' };
    }

    const stamp = Date.now();
    const memId = 'mem_' + stamp;
    const username = cleanPhone.length >= 9 ? cleanPhone : name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) + Math.floor(100 + Math.random() * 900);
    const pwd = String(password || '').trim();
    if (createAccount) {
      const policy = AppStorage._passwordPolicyError(pwd);
      if (policy) return { success: false, message: policy };
      if (AuthCore.isWeakPassword(pwd, { username, phone })) return { success: false, message: 'Mật khẩu quá dễ đoán (trùng SĐT/tên đăng nhập hoặc mật khẩu phổ biến). Hãy đặt mật khẩu khác.' };
      if (data.users.some((u) => (u.username || '').toLowerCase() === username.toLowerCase())) return { success: false, message: `Tên đăng nhập "${username}" đã tồn tại.` };
    }
    const finalAvatar = avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=10b981&color=fff`;
    const member = { id: memId, name, phone, email, note, type, role, avatar: finalAvatar, joinDate: new Date().toISOString().slice(0, 10) };
    // Mã chuyển khoản riêng (máy chủ cũng tự cấp/kiểm tra trùng khi đồng bộ)
    if (window.TransferCode) member.transferCode = TransferCode.plan(data.members.concat([{ id: memId }]))[memId];
    if (createAccount) member.username = username;
    data.members.push(member);

    if (createAccount) {
      data.users.push({
        id: 'user_' + stamp, username, password: AppStorage.hashPassword(pwd), name, phone, email, note, role,
        memberId: memId, type, avatar: finalAvatar, createdAt: new Date().toISOString()
      });
    }

    // Thành viên cố định -> tạo phiếu thu quỹ tháng hiện tại
    const fee = Number((data.clubInfo || {}).monthlyFee || (data.clubInfo || {}).monthlyFundFee) || 0;
    if (type === 'fixed' && fee > 0) {
      const month = AppStorage.currentMonth();
      if (!data.monthlyContributions) data.monthlyContributions = [];
      if (!data.monthlyContributions.some((d) => d.memberId === memId && d.month === month)) {
        data.monthlyContributions.push({
          id: `due_${month}_${memId}`, month, memberId: memId, amount: fee, status: 'unpaid', paidAt: null, method: null,
          billImage: null, approvedBy: null, approvedAt: null, note: 'Thành viên mới'
        });
      }
    }
    AppStorage.saveData(data, true);
    return { success: true, member, username: createAccount ? username : '' };
  },

  addMemberQuick(e) {
    if (e && e.preventDefault) e.preventDefault();
    const v = (id) => (document.getElementById(id)?.value || '').trim();
    const createAccount = !!document.getElementById('quick-mem-account')?.checked;
    const res = this.createMember({
      name: v('quick-mem-name'), phone: v('quick-mem-phone'), note: v('quick-mem-note'),
      type: v('quick-mem-type') || 'guest', createAccount, password: v('quick-mem-password')
    });
    if (!res.success) {
      App.showToast(res.message, 'warning');
      return;
    }
    if (e && e.target && e.target.reset) e.target.reset();
    const wrap = document.getElementById('quick-mem-pwd-wrap');
    if (wrap) wrap.style.display = 'none';
    App.showToast(`✅ Đã thêm "${res.member.name}"${res.username ? ` (tên đăng nhập: ${res.username})` : ' (chưa có tài khoản)'}. Mã chuyển khoản: ${res.member.transferCode || 'đang cấp'}`, 'success');
    this.afterMemberChange();
    document.getElementById('quick-mem-name')?.focus();
  },

  afterMemberChange() {
    this.renderMembersTab();
    this.renderPublicMemberRoster();
    if (window.SettingsModule) SettingsModule.renderMembersAdmin();
    App.renderUserRoleSelector();
    App.renderUserHeaderAndSidebar();
    if (window.App && typeof App.refreshDashboardStats === 'function') App.refreshDashboardStats();
    if (window.FundModule && typeof FundModule.renderFundDashboard === 'function') FundModule.renderFundDashboard();
  },

  renderPublicMemberRoster() {
    const data = AppStorage.loadData();
    const members = data.members || [];
    const container = document.getElementById('public-member-roster');
    const badge = document.getElementById('reg-member-count-badge');

    if (badge) badge.innerText = `${members.length} thành viên`;
    if (!container) return;

    if (members.length === 0) {
      container.innerHTML = `<span class="text-muted" style="font-size: 0.85rem; font-style: italic;">Chưa có thành viên nào. Hãy là người đầu tiên đăng ký gia nhập CLB!</span>`;
      return;
    }

    container.innerHTML = members.map(m => `
      <div class="badge badge-neutral" style="padding: 0.35rem 0.6rem; display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.8rem;">
        <img class="avatar avatar-sm" src="${Safe.url(m.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(m.name)}&background=10b981&color=fff`)}" alt="${Safe.html(m.name)}" style="width: 20px; height: 20px; border-radius: 50%;">
        <span>${Safe.html(m.name)}</span>
        <span class="badge ${m.type === 'fixed' ? 'badge-paid' : 'badge-warning'}" style="font-size: 0.65rem; padding: 0.05rem 0.3rem;">
          ${m.type === 'fixed' ? 'Cố định' : 'Vãng lai'}
        </span>
      </div>
    `).join('');
  },

  copyMemberList() {
    if (!AppStorage.can('members')) {
      App.showToast("Chức năng sao chép danh sách liên hệ thành viên chỉ dành cho Ban Quản trị!", "warning");
      return;
    }
    const data = AppStorage.loadData();
    const members = data.members || [];
    if (members.length === 0) {
      App.showToast("CLB chưa có thành viên nào để sao chép!", "info");
      return;
    }

    let text = `🏸 DANH SÁCH THÀNH VIÊN CLB SMASH PRO (${members.length} thành viên)\n`;
    text += `-------------------------------------------\n`;
    members.forEach((m, idx) => {
      text += `${idx + 1}. ${m.name} - ${m.phone} (${m.type === 'fixed' ? 'Cố định' : 'Vãng lai'}${m.role === 'admin' ? ' - Admin' : m.role === 'treasurer' ? ' - Thủ quỹ' : ''})\n`;
    });

    navigator.clipboard.writeText(text).then(() => {
      App.showToast("📋 Đã sao chép danh sách thành viên vào bộ nhớ tạm!", "success");
    }).catch(() => {
      App.showToast("Không thể sao chép tự động, vui lòng thử lại!", "error");
    });
  },

  // ==========================================
  // QUẢN LÝ & CHỈNH SỬA QUYỀN LỢI & QUY ĐỊNH CLB
  // ==========================================

  escapeHtml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  },

  renderBenefitsAndRules() {
    const data = AppStorage.loadData();
    const container = document.getElementById('club-benefits-rules-list');
    if (!container) return;

    const defaultRules = [
      { id: "rule_1", title: "Quyền lợi thành viên cố định", content: "Tham gia mọi buổi đánh định kỳ và hưởng quyền lợi thành viên trọn gói." },
      { id: "rule_2", title: "Tự động đóng vote 2 ngày", content: "Đảm bảo chốt sân đúng số lượng, không bị thiếu hoặc quá tải sân." },
      { id: "rule_3", title: "Quỹ sân minh bạch", content: "Thu quỹ qua VietQR tự động, sao kê rõ ràng công khai." },
      { id: "rule_4", title: "Cầu sử dụng", content: "n/a" }
    ];

    const rules = (data.clubInfo && Array.isArray(data.clubInfo.benefitsAndRules) && data.clubInfo.benefitsAndRules.length > 0)
      ? data.clubInfo.benefitsAndRules
      : defaultRules;

    container.innerHTML = rules.map(r => `
      <div class="flex items-start gap-3">
        <i class="fas fa-check-circle text-primary" style="margin-top: 0.2rem; flex-shrink: 0;"></i>
        <div><strong>${this.escapeHtml(r.title || '')}:</strong> ${this.escapeHtml(r.content || '')}</div>
      </div>
    `).join('');
  },

  openEditBenefitsAndRulesModal() {
    if (!AppStorage.can('members')) {
      App.showToast("Chức năng chỉnh sửa Quyền lợi & Quy định CLB chỉ dành cho Ban Quản trị!", "warning");
      return;
    }

    const data = AppStorage.loadData();
    const defaultRules = [
      { id: "rule_1", title: "Quyền lợi thành viên cố định", content: "Tham gia mọi buổi đánh định kỳ và hưởng quyền lợi thành viên trọn gói." },
      { id: "rule_2", title: "Tự động đóng vote 2 ngày", content: "Đảm bảo chốt sân đúng số lượng, không bị thiếu hoặc quá tải sân." },
      { id: "rule_3", title: "Quỹ sân minh bạch", content: "Thu quỹ qua VietQR tự động, sao kê rõ ràng công khai." },
      { id: "rule_4", title: "Cầu sử dụng", content: "n/a" }
    ];

    const rules = (data.clubInfo && Array.isArray(data.clubInfo.benefitsAndRules) && data.clubInfo.benefitsAndRules.length > 0)
      ? data.clubInfo.benefitsAndRules
      : defaultRules;

    let rowsHtml = '';
    rules.forEach((r, idx) => {
      rowsHtml += this.generateRuleRowHtml(idx + 1, r.title, r.content);
    });

    const modalBody = `
      <form onsubmit="MembersModule.saveBenefitsAndRules(event)">
        <div style="margin-bottom: 1rem; color: var(--text-secondary); font-size: 0.85rem; line-height: 1.45; background: var(--bg-input); padding: 0.75rem; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
          <i class="fas fa-info-circle text-primary"></i> Nội dung này sẽ hiển thị trên <strong>Phiếu đăng ký gia nhập</strong> và <strong>Quyền lợi & Quy định CLB</strong> để các thành viên mới nắm rõ điều lệ hoạt động.
        </div>

        <div id="rules-editor-container" style="display: flex; flex-direction: column; gap: 0.85rem; max-height: 52vh; overflow-y: auto; padding-right: 0.25rem;">
          ${rowsHtml}
        </div>

        <div class="flex justify-between items-center flex-wrap gap-2" style="margin-top: 1rem; border-top: 1px dashed var(--border-color); padding-top: 0.75rem;">
          <button type="button" class="btn btn-secondary btn-sm" onclick="MembersModule.addRuleRowInModal()">
            <i class="fas fa-plus-circle text-primary"></i> <span>Thêm điều khoản mới</span>
          </button>
          <button type="button" class="btn btn-outline-danger btn-sm" onclick="MembersModule.resetDefaultRulesInModal()" title="Khôi phục 4 quy định mẫu chuẩn">
            <i class="fas fa-undo"></i> <span>Mặc định</span>
          </button>
        </div>

        <div class="modal-footer" style="padding: 1rem 0 0 0; margin-top: 0.5rem;">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Hủy</button>
          <button type="submit" class="btn btn-primary"><i class="fas fa-save"></i> Lưu quy định & quyền lợi</button>
        </div>
      </form>
    `;

    App.openModal("✏️ Chỉnh sửa Quyền lợi & Quy định CLB", modalBody, true);
  },

  generateRuleRowHtml(index, title = '', content = '') {
    return `
      <div class="rule-edit-item" style="background: var(--bg-input); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 0.85rem;">
        <div class="flex justify-between items-center" style="margin-bottom: 0.5rem;">
          <strong style="font-size: 0.85rem; color: var(--primary);">
            <i class="fas fa-check-circle"></i> Điều khoản #<span class="rule-index">${index}</span>
          </strong>
          <button type="button" class="btn btn-outline-danger btn-sm" onclick="MembersModule.deleteRuleRowInModal(this)" title="Xóa điều khoản này" style="padding: 0.15rem 0.45rem; font-size: 0.72rem;">
            <i class="fas fa-trash"></i> Xóa
          </button>
        </div>
        <div class="form-group" style="margin-bottom: 0.5rem;">
          <label class="form-label font-bold" style="font-size: 0.82rem; margin-bottom: 0.2rem;">Tiêu đề quy định *</label>
          <input type="text" class="form-control rule-input-title" value="${this.escapeHtml(title)}" placeholder="VD: Lịch đánh cố định, Quỹ sân..." required>
        </div>
        <div class="form-group" style="margin-bottom: 0;">
          <label class="form-label font-bold" style="font-size: 0.82rem; margin-bottom: 0.2rem;">Nội dung chi tiết *</label>
          <textarea class="form-control rule-input-content" rows="2" placeholder="VD: Thứ 7 (18h-20h) và Thứ 3 (19h30-21h30)..." required>${this.escapeHtml(content)}</textarea>
        </div>
      </div>
    `;
  },

  addRuleRowInModal() {
    const container = document.getElementById('rules-editor-container');
    if (!container) return;
    const currentCount = container.querySelectorAll('.rule-edit-item').length;
    const newDiv = document.createElement('div');
    newDiv.innerHTML = this.generateRuleRowHtml(currentCount + 1, '', '');
    container.appendChild(newDiv.firstElementChild);
    this.reindexRuleRowsInModal();
    container.scrollTop = container.scrollHeight;
  },

  deleteRuleRowInModal(btn) {
    const row = btn.closest('.rule-edit-item');
    const container = document.getElementById('rules-editor-container');
    if (row && container) {
      if (container.querySelectorAll('.rule-edit-item').length <= 1) {
        App.showToast("Cần giữ lại ít nhất 1 điều khoản quy định!", "warning");
        return;
      }
      row.remove();
      this.reindexRuleRowsInModal();
    }
  },

  reindexRuleRowsInModal() {
    const container = document.getElementById('rules-editor-container');
    if (!container) return;
    const items = container.querySelectorAll('.rule-edit-item');
    items.forEach((item, idx) => {
      const span = item.querySelector('.rule-index');
      if (span) span.innerText = idx + 1;
    });
  },

  resetDefaultRulesInModal() {
    const container = document.getElementById('rules-editor-container');
    if (!container) return;
    const defaultRules = [
      { title: "Quyền lợi thành viên cố định", content: "Tham gia mọi buổi đánh định kỳ và hưởng quyền lợi thành viên trọn gói." },
      { title: "Tự động đóng vote 2 ngày", content: "Đảm bảo chốt sân đúng số lượng, không bị thiếu hoặc quá tải sân." },
      { title: "Quỹ sân minh bạch", content: "Thu quỹ qua VietQR tự động, sao kê rõ ràng công khai." },
      { title: "Cầu sử dụng", content: "n/a" }
    ];

    container.innerHTML = defaultRules.map((r, idx) => this.generateRuleRowHtml(idx + 1, r.title, r.content)).join('');
    App.showToast("Đã khôi phục mẫu 4 quy định chuẩn!", "info");
  },

  saveBenefitsAndRules(e) {
    if (e && e.preventDefault) e.preventDefault();
    const container = document.getElementById('rules-editor-container');
    if (!container) return;

    const items = container.querySelectorAll('.rule-edit-item');
    const newRules = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const title = (item.querySelector('.rule-input-title')?.value || '').trim();
      const content = (item.querySelector('.rule-input-content')?.value || '').trim();
      if (!title || !content) {
        App.showToast(`Vui lòng điền đầy đủ tiêu đề và nội dung cho Điều khoản #${i + 1}!`, "warning");
        return;
      }
      newRules.push({
        id: `rule_${Date.now()}_${i + 1}`,
        title,
        content
      });
    }

    if (newRules.length === 0) {
      App.showToast("CLB cần có ít nhất 1 điều khoản quy định!", "warning");
      return;
    }

    const data = AppStorage.loadData();
    if (!data.clubInfo) data.clubInfo = {};
    data.clubInfo.benefitsAndRules = newRules;

    AppStorage.saveData(data, true);
    App.closeModal();
    this.renderBenefitsAndRules();
    App.showToast("🎉 Đã lưu cập nhật Quyền lợi & Quy định CLB thành công!", "success");
  }
};

window.MembersModule = MembersModule;
;

// ===== js/modules/schedule.js =====
// Court Booking & Schedule Module with Monthly Calendar, Hover Preview Popover & Multi-Option Polls

const ScheduleModule = {
  currentViewMode: 'calendar', // 'calendar' | 'cards'
  calendarScope: 'week', // trong chế độ 'calendar': 'week' (mặc định: tuần hiện tại) | 'month'
  weekStart: null, // Date (thứ Hai 00:00) của tuần đang xem
  currentFilter: 'upcoming',
  calYear: null, // null = năm/tháng hiện tại (đặt lúc init)
  calMonth: null, // 0-indexed
  popoverEl: null,
  pollOptionCount: 2, // For dynamic option builder

  init() {
    this.createPopoverElement();
    const now = new Date();
    if (!this.calYear || isNaN(this.calYear)) {
      this.calYear = now.getFullYear();
    }
    if (this.calMonth === undefined || this.calMonth === null || isNaN(this.calMonth)) {
      this.calMonth = now.getMonth();
    }

    const data = AppStorage.loadData();
    const sessions = data.sessions || [];
    this.updateScheduleOverviewStats(sessions);

    if (!this.weekStart) this.weekStart = this.mondayOf(now);
    this.syncViewModeButtons();
    if (this.currentViewMode === 'calendar') {
      this.renderMonthCalendar();
    } else {
      this.renderSessions('sessions-container', this.currentFilter || 'upcoming');
    }

    this.renderSessions('schedule-upcoming-list', this.currentFilter || 'upcoming');
  },

  // Buổi mà thành viên đã bình chọn "đi" (hoặc chọn phương án ở buổi khảo sát)
  isMine(session, memberId) {
    if (!session || !memberId) return false;
    return (session.votes || []).some(v => v && v.memberId === memberId && (session.voteMode === 'multi_option' ? !v.notGoing && (v.selectedOptions || []).length > 0 : v.status === 'going'));
  },

  // Safe Date-Time Parser to prevent Invalid Date exceptions
  parseSessionDateTime(dateStr, timeStr) {
    if (!dateStr) return new Date();
    let d = String(dateStr).trim();
    let t = String(timeStr || "18:00").trim();
    if (t.length === 5) t += ":00";
    if (d.includes('/')) {
      const parts = d.split('/');
      if (parts.length === 3) {
        d = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
      }
    }
    const isoString = `${d}T${t}`;
    const dateObj = new Date(isoString);
    if (isNaN(dateObj.getTime())) {
      return new Date();
    }
    return dateObj;
  },

  // Calculate if a session is automatically locked (2 days / 48 hours before match start)
  getVoteLockStatus(session, voteLockHours = 48) {
    if (!session) return { isLocked: false, statusText: 'Đang mở vote', timeRemainingMs: 0, countdownText: '', deadlineFormatted: '' };
    if (session.status === 'completed' || session.status === 'cancelled') {
      return { isLocked: true, statusText: session.status === 'completed' ? 'Đã diễn ra' : 'Đã hủy', timeRemainingMs: 0, countdownText: '', deadlineFormatted: '' };
    }

    if (session.status === 'locked') {
      return { isLocked: true, statusText: 'Đã khóa bình chọn (Admin)', timeRemainingMs: 0, countdownText: '🔒 Đã chốt danh sách', deadlineFormatted: 'Đã chốt danh sách' };
    }

    // Hẹn giờ mở bình chọn: chưa tới giờ -> chưa cho vote
    const openState = window.VoteScheduler ? VoteScheduler.getOpenState(session) : { isOpen: true };
    if (!openState.isOpen) {
      return { isLocked: true, notOpenYet: true, statusText: 'Chưa mở vote', timeRemainingMs: 0, countdownText: `⏰ Mở vote lúc ${openState.label}`, deadlineFormatted: `Mở vote lúc ${openState.label}` };
    }

    const sessionDateTime = this.parseSessionDateTime(session.date, session.startTime);
    const lockDeadline = new Date(sessionDateTime.getTime() - (voteLockHours * 60 * 60 * 1000));
    const now = new Date();

    const timeRemainingMs = lockDeadline.getTime() - now.getTime();
    const isLocked = timeRemainingMs <= 0;

    let deadlineFormatted = "";
    try {
      deadlineFormatted = `${lockDeadline.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })} ngày ${lockDeadline.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })}`;
    } catch (e) {
      deadlineFormatted = `${session.date || ''} (trước 2 ngày)`;
    }

    let countdownText = "";
    if (isLocked) {
      countdownText = "🔒 Đã đóng vote (trước 2 ngày)";
    } else {
      const days = Math.floor(timeRemainingMs / (1000 * 60 * 60 * 24));
      const hours = Math.floor((timeRemainingMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const mins = Math.floor((timeRemainingMs % (1000 * 60 * 60)) / (1000 * 60));
      
      if (days > 0) {
        countdownText = `⏳ Đóng vote sau: ${days} ngày ${hours} giờ`;
      } else if (hours > 0) {
        countdownText = `⏳ Đóng vote sau: ${hours} giờ ${mins} phút`;
      } else {
        countdownText = `⏳ Sắp khóa! Còn: ${Math.max(1, mins)} phút`;
      }
    }

    return {
      isLocked,
      statusText: isLocked ? 'Đã đóng vote' : 'Đang mở vote',
      timeRemainingMs,
      countdownText,
      deadlineFormatted
    };
  },

  // Calculate statistics for Multi-Option Poll
  calculatePollStats(session) {
    const options = session.options || [];
    const votes = session.votes || [];
    const members = AppStorage.loadData().members || [];

    const totalVoters = votes.filter(v => !v.notGoing).length;
    const notGoingVotes = votes.filter(v => v.notGoing || v.status === 'not_going');

    let maxVotes = 0;
    const optionStats = options.map(opt => {
      // Find all votes that selected this option
      const matchingVotes = votes.filter(v => v.selectedOptions && v.selectedOptions.includes(opt.id));
      const voteCount = matchingVotes.length;
      if (voteCount > maxVotes) maxVotes = voteCount;

      const voters = matchingVotes.map(v => {
        return members.find(m => m.id === v.memberId || (m.username && m.username === v.memberId)) || 
               (AppStorage.loadData().users || []).find(u => u.id === v.memberId || u.memberId === v.memberId) || 
               { name: 'Thành viên', avatar: '' };
      });

      return {
        option: opt,
        voteCount,
        voters,
        percent: totalVoters > 0 ? Math.round((voteCount / totalVoters) * 100) : 0
      };
    });

    // Mark leader(s)
    optionStats.forEach(st => {
      st.isLeader = maxVotes > 0 && st.voteCount === maxVotes;
    });

    return {
      totalVoters,
      notGoingCount: notGoingVotes.length,
      notGoingVoters: notGoingVotes.map(v => {
        return members.find(m => m.id === v.memberId || (m.username && m.username === v.memberId)) || 
               (AppStorage.loadData().users || []).find(u => u.id === v.memberId || u.memberId === v.memberId) || 
               { name: 'Thành viên', avatar: '' };
      }),
      optionStats,
      maxVotes
    };
  },

  openAddSessionForDate(dateStr) {
    this.openAddSessionModal();
    const dateInput = document.getElementById('session-date');
    if (dateInput) dateInput.value = dateStr;
    const optDate1 = document.getElementById('opt-date-1');
    if (optDate1) optDate1.value = dateStr;
    const optDate2 = document.getElementById('opt-date-2');
    if (optDate2) optDate2.value = dateStr;
  },

  // ==========================================
  // CARD / LIST VIEW RENDERER
  // ==========================================
  renderSessions(containerId, filter = 'upcoming') {
    this.currentFilter = filter;
    const container = document.getElementById(containerId);
    if (!container) return;

    const data = AppStorage.loadData();
    const sessions = data.sessions || [];
    const members = data.members || [];
    const voteLockHours = (data.clubInfo && data.clubInfo.voteLockHours) || 48;
    const currentUser = data.currentUser || AppStorage.getCurrentUser();
    const currentMember = (data.members || []).find(m => 
      (currentUser && currentUser.memberId && m.id === currentUser.memberId) ||
      (currentUser && m.id === currentUser.id) ||
      (currentUser && currentUser.username && m.username === currentUser.username)
    );
    const currentMemberId = currentMember ? currentMember.id : (currentUser ? (currentUser.memberId || currentUser.id) : '');
    const currentUserId = currentUser ? currentUser.id : '';
    const isAdmin = AppStorage.can('schedule');

    const now = new Date();
    const filtered = sessions.filter(s => {
      const sessionDate = this.parseSessionDateTime(s.date, s.endTime || '23:59');
      if (filter === 'upcoming') return sessionDate >= now;
      if (filter === 'past') return sessionDate < now;
      if (filter === 'mine') return sessionDate >= now && s.status !== 'cancelled' && this.isMine(s, currentMemberId);
      return true;
    }).sort((a, b) => this.parseSessionDateTime(a.date, a.startTime) - this.parseSessionDateTime(b.date, b.startTime));

    if (filtered.length === 0) {
      let emptyTitle = "Chưa có buổi đánh nào sắp tới";
      let emptyDesc = "Hãy bấm nút <strong>\"Đặt lịch mới\"</strong> ở góc trên để tạo lịch đánh hoặc mở bình chọn chọn sân cho CLB!";
      if (filter === 'past') {
        emptyTitle = "Chưa có buổi đánh nào đã kết thúc";
        emptyDesc = "Các buổi đánh sau khi kết thúc sẽ được lưu trữ và hiển thị đầy đủ tại đây.";
      } else if (filter === 'all') {
        emptyTitle = "Chưa có buổi đánh nào trên hệ thống";
        emptyDesc = "Bấm <strong>\"Đặt lịch mới\"</strong> để thêm ca đánh đầu tiên cho CLB.";
      }

      if (containerId === 'schedule-upcoming-list') {
        container.innerHTML = `
          <div style="grid-column: 1 / -1; padding: 1.5rem 1rem; text-align: center; background: var(--bg-card-solid); border: 1px dashed var(--border-color); border-radius: var(--radius-lg);">
            <div style="font-size: 1.6rem; margin-bottom: 0.35rem;">🏸</div>
            <div style="font-weight: 600; color: var(--text-main); font-size: 0.95rem;">${emptyTitle}</div>
            <p class="text-secondary" style="font-size: 0.84rem; margin-top: 0.25rem;">${emptyDesc}</p>
          </div>
        `;
        return;
      }
      container.innerHTML = `
        <div class="card text-center" style="padding: 3rem 1rem; grid-column: 1 / -1;">
          <div style="font-size: 3rem; margin-bottom: 1rem;">🏸</div>
          <h3>${emptyTitle}</h3>
          <p class="text-secondary" style="margin-top: 0.5rem;">${emptyDesc}</p>
          ${isAdmin ? `<button class="btn btn-primary" style="margin-top: 1rem;" onclick="ScheduleModule.openAddSessionModal()"><i class="fas fa-plus"></i> Thêm lịch đặt sân</button>` : ''}
        </div>
      `;
      return;
    }

    container.innerHTML = filtered.map(session => {
      const lockInfo = this.getVoteLockStatus(session, voteLockHours);
      const isMultiPoll = session.voteMode === 'multi_option';
      const isGuestType = session.sessionType === 'guest';

      const dateObj = this.parseSessionDateTime(session.date, session.startTime);
      const dayNames = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
      const dayName = dayNames[dateObj.getDay()];
      const dayNum = dateObj.getDate();
      const monthNum = dateObj.getMonth() + 1;

      // User's personal vote badge
      const userVote = (session.votes || []).find(v => 
        v.memberId === currentMemberId || 
        v.memberId === currentUserId || 
        (currentUser && currentUser.memberId && v.memberId === currentUser.memberId) ||
        (currentUser && currentUser.username && v.memberId === currentUser.username)
      );
      let userVoteBadge = `<span class="badge badge-neutral"><i class="fas fa-question-circle"></i> Chưa bình chọn</span>`;
      
      if (isMultiPoll) {
        const pollStats = this.calculatePollStats(session);
        if (userVote) {
          if (userVote.selectedOptions && userVote.selectedOptions.length > 0) {
            userVoteBadge = `<span class="badge badge-paid"><i class="fas fa-check-circle"></i> Đã vote ${userVote.selectedOptions.length} phương án</span>`;
          } else if (userVote.notGoing) {
            userVoteBadge = `<span class="badge badge-unpaid"><i class="fas fa-times-circle"></i> Báo bận</span>`;
          }
        }

        const pollOptionBarsHtml = pollStats.optionStats.map((st, idx) => `
          <div style="margin-bottom: 0.5rem;">
            <div style="display: flex; justify-content: space-between; font-size: 0.78rem; margin-bottom: 0.2rem;">
              <span class="font-semibold text-main">Phương án ${idx + 1}: ${Safe.html(st.option.courtName.split('(')[0])} (${Safe.html(st.option.startTime)}-${Safe.html(st.option.endTime)})</span>
              <span class="font-bold text-primary font-mono">${st.voteCount} phiếu (${st.percent}%)</span>
            </div>
            <div class="poll-bar-track">
              <div class="poll-bar-fill ${st.isLeader ? 'leader-bar' : ''}" style="width: ${st.percent}%;"></div>
            </div>
          </div>
        `).join('');

        return `
          <div class="session-card is-featured" onclick="ScheduleModule.openSessionDetailsModal(${Safe.js(session.id)})" style="cursor: pointer;">
            <div class="session-banner">
              <div class="session-banner-top">
                <div class="session-type-tags">
                  <span class="badge badge-poll-mode">🗳️ Khảo sát sân & giờ</span>
                  <span class="badge ${isGuestType ? 'badge-guest-type' : 'badge-fixed-type'}">
                    ${isGuestType ? '⚡ Vãng lai' : '🏸 Cố định'}
                  </span>
                </div>
                <div>
                  ${lockInfo.isLocked ? 
                    `<span class="badge badge-locked"><i class="fas fa-lock"></i> Đã đóng</span>` : 
                    `<span class="badge badge-open"><i class="fas fa-vote-yea"></i> Đang vote</span>`}
                </div>
              </div>

              <div class="session-date-box">
                <div class="session-date-badge" style="background: var(--secondary);">
                  <div class="day-name">${dayName}</div>
                  <div class="day-num">${dayNum}/${monthNum}</div>
                </div>
                <div class="session-title-wrap">
                  <h3>${Safe.html(session.title)}</h3>
                  <div class="session-time-text" style="color: var(--secondary);">
                    <i class="far fa-clock"></i> Khảo sát đa phương án (${session.options ? session.options.length : 2} lựa chọn)
                  </div>
                </div>
              </div>
            </div>

            <div class="session-body">
              <div style="background: var(--bg-card); padding: 0.85rem; border-radius: var(--radius-md); border: 1px solid var(--border-color); margin-bottom: 0.85rem;">
                ${pollOptionBarsHtml}
              </div>

              <div class="vote-deadline-notice ${lockInfo.isLocked ? 'is-locked' : 'is-open'}">
                <div>
                  <i class="fas ${lockInfo.isLocked ? 'fa-lock' : 'fa-hourglass-half'}"></i>
                  <span>${Safe.html(lockInfo.countdownText)}</span>
                </div>
                <span style="font-size: 0.75rem; opacity: 0.85;">Hạn: ${Safe.html(lockInfo.deadlineFormatted)}</span>
              </div>

              <div class="flex items-center justify-between" style="font-size: 0.85rem; padding-top: 0.25rem;">
                <span class="text-secondary">Trạng thái của bạn:</span>
                ${userVoteBadge}
              </div>
            </div>

            <div class="session-footer" onclick="event.stopPropagation();">
              <button class="btn btn-secondary btn-sm" onclick="ScheduleModule.shareSession(${Safe.js(session.id)})" title="Chia sẻ Zalo/Nhóm">
                <i class="fas fa-share-alt"></i> Chia sẻ
              </button>
              <button class="btn btn-secondary btn-sm" onclick="ScheduleModule.openSessionDetailsModal(${Safe.js(session.id)})">
                <i class="fas fa-info-circle"></i> Chi tiết
              </button>
              <button class="btn btn-primary btn-sm" onclick="VotingModule.openVoteModal(${Safe.js(session.id)})" ${lockInfo.isLocked && !isAdmin ? 'disabled' : ''}>
                <i class="fas fa-vote-yea"></i> ${lockInfo.isLocked ? (isAdmin ? 'Quản lý' : 'Đã khóa') : 'Bình chọn'}
              </button>
              ${isAdmin ? `
                <button class="btn btn-outline-danger btn-sm" onclick="ScheduleModule.confirmDeleteSession(${Safe.js(session.id)})" title="Xóa buổi này">
                  <i class="fas fa-trash-alt"></i> Xóa
                </button>
              ` : ''}
            </div>
          </div>
        `;
      }

      // STANDARD CARD
      const goingVotes = (session.votes || []).filter(v => v.status === 'going');
      const totalGoing = goingVotes.reduce((sum, v) => sum + 1 + (v.guests || 0), 0);
      const maybeVotes = (session.votes || []).filter(v => v.status === 'maybe');

      if (userVote) {
        if (userVote.status === 'going') {
          userVoteBadge = `<span class="badge badge-paid"><i class="fas fa-check-circle"></i> Đã đăng ký tham gia ${userVote.guests > 0 ? `(+${Safe.html(userVote.guests)} bạn)` : ''}</span>`;
        } else if (userVote.status === 'not_going') {
          userVoteBadge = `<span class="badge badge-unpaid"><i class="fas fa-times-circle"></i> Báo vắng buổi này</span>`;
        } else if (userVote.status === 'maybe') {
          userVoteBadge = `<span class="badge badge-pending"><i class="fas fa-clock"></i> Dự bị</span>`;
        }
      }

      const attendeeAvatars = goingVotes.map(v => {
        const mem = members.find(m => m.id === v.memberId || (m.username && m.username === v.memberId)) || 
                    (data.users || []).find(u => u.id === v.memberId || u.memberId === v.memberId) || 
                    { name: 'Thành viên', avatar: '' };
        return `<img class="avatar avatar-sm" src="${Safe.url(mem.avatar, `https://ui-avatars.com/api/?name=${encodeURIComponent(mem.name)}&background=10b981&color=fff`)}" alt="${Safe.html(mem.name)}" title="${Safe.html(mem.name)} ${v.guests > 0 ? `(+${Safe.html(v.guests)} khách)` : ''}" onerror="this.src=${Safe.js('https://ui-avatars.com/api/?name=' + encodeURIComponent(mem.name) + '&background=10b981&color=fff')}">`;
      }).slice(0, 7).join('');

      const remainingSlots = session.maxPlayers - totalGoing;
      let capacityBadge = '';
      if (remainingSlots > 0) {
        capacityBadge = `<span class="text-primary font-bold"><i class="fas fa-user-plus"></i> Còn ${remainingSlots} slot</span>`;
      } else if (remainingSlots === 0) {
        capacityBadge = `<span class="badge badge-info"><i class="fas fa-users"></i> Đủ người</span>`;
      } else {
        capacityBadge = `<span class="text-warning font-bold"><i class="fas fa-exclamation-triangle"></i> Đông (+${Math.abs(remainingSlots)})</span>`;
      }

      return `
        <div class="session-card ${lockInfo.isLocked ? 'is-locked' : 'is-featured'}" onclick="ScheduleModule.openSessionDetailsModal(${Safe.js(session.id)})" style="cursor: pointer;">
          <div class="session-banner">
            <div class="session-banner-top">
              <div class="session-type-tags">
                <span class="badge ${isGuestType ? 'badge-guest-type' : 'badge-fixed-type'}">
                  ${isGuestType ? '⚡ Vãng lai (theo ngày)' : '🏸 Cố định (trừ quỹ)'}
                </span>
              </div>
              <div>
                ${lockInfo.isLocked ? 
                  `<span class="badge badge-locked"><i class="fas fa-lock"></i> Đã đóng</span>` : 
                  `<span class="badge badge-open"><i class="fas fa-door-open"></i> Đang mở</span>`}
              </div>
            </div>

            <div class="session-date-box">
              <div class="session-date-badge">
                <div class="day-name">${dayName}</div>
                <div class="day-num">${dayNum}/${monthNum}</div>
              </div>
              <div class="session-title-wrap">
                <h3>${Safe.html(session.title)}</h3>
                <div class="session-time-text">
                  <i class="far fa-clock"></i> ${Safe.html(session.startTime)} - ${Safe.html(session.endTime)} (${Safe.html(session.courtNumbers)})
                </div>
              </div>
            </div>
          </div>

          <div class="session-body">
            <div class="court-meta-list">
              <div class="court-meta-item" style="display: flex; justify-content: space-between; align-items: center;">
                <div style="display: flex; align-items: center; gap: 0.35rem;">
                  <i class="fas fa-map-marker-alt text-primary"></i>
                  <div><span>Sân:</span> <strong>${Safe.html(session.courtName)}</strong></div>
                </div>
                ${isAdmin ? `
                  <button type="button" class="btn btn-ghost btn-icon btn-xs" onclick="event.stopPropagation(); ScheduleModule.openEditCourtLocationModal(${Safe.js(session.id)})" title="Admin: Chỉnh sửa thông tin sân & tiền sân" style="border: 1px solid var(--border-color); border-radius: var(--radius-sm); margin-left: 0.35rem; flex-shrink: 0;">
                    <i class="fas fa-pencil-alt text-warning"></i>
                  </button>
                ` : ''}
              </div>
              <div class="court-meta-item">
                <i class="fas fa-feather-alt"></i>
                <div><span>Loại cầu:</span> <strong>${Safe.html(session.shuttleType || 'n/a')}</strong></div>
              </div>
              <div class="court-meta-item">
                <i class="fas fa-money-bill-wave"></i>
                <div><span>Tiền sân:</span> <strong>${session.courtPrice ? Number(session.courtPrice).toLocaleString('vi-VN') : '360.000'} đ</strong></div>
              </div>
              <div class="court-meta-item">
                <i class="fas fa-users"></i>
                <div><span>Tối đa:</span> <strong>${Safe.html(session.maxPlayers)} người</strong></div>
              </div>
            </div>

            <div class="vote-deadline-notice ${lockInfo.isLocked ? 'is-locked' : 'is-open'}">
              <div>
                <i class="fas ${lockInfo.isLocked ? 'fa-lock' : 'fa-hourglass-half'}"></i>
                <span>${Safe.html(lockInfo.countdownText)}</span>
              </div>
              <span style="font-size: 0.75rem; opacity: 0.85;">Hạn: ${Safe.html(lockInfo.deadlineFormatted)}</span>
            </div>

            <div class="roster-summary">
              <div class="roster-header">
                <div>
                  <strong>${Safe.html(totalGoing)} người tham gia</strong> 
                  <span class="text-secondary" style="font-size: 0.75rem;">(Đi: ${goingVotes.length} | Dự bị: ${maybeVotes.length})</span>
                </div>
                <div>${capacityBadge}</div>
              </div>
              <div class="avatar-stack">
                ${attendeeAvatars}
                ${goingVotes.length > 7 ? `<span class="avatar-more">+${goingVotes.length - 7}</span>` : ''}
                ${goingVotes.length === 0 ? `<span class="text-muted" style="font-size: 0.8rem; font-style: italic;">Chưa có ai bình chọn tham gia</span>` : ''}
              </div>
            </div>

            <div class="flex items-center justify-between" style="font-size: 0.85rem; padding-top: 0.25rem;">
              <span class="text-secondary">Trạng thái của bạn:</span>
              ${userVoteBadge}
            </div>
          </div>

          <div class="session-footer" onclick="event.stopPropagation();">
            <button class="sf-btn sf-btn-secondary" onclick="ScheduleModule.shareSession(${Safe.js(session.id)})" title="Chia se Zalo">
              <i class="fas fa-share-alt"></i>
            </button>
            <button class="sf-btn sf-btn-secondary" onclick="ScheduleModule.openSessionDetailsModal(${Safe.js(session.id)})" title="Chi tiet & danh sach">
              <i class="fas fa-info-circle"></i>
            </button>
            <button class="sf-btn sf-btn-primary sf-btn-main" onclick="VotingModule.openVoteModal(${Safe.js(session.id)})" ${lockInfo.isLocked && !isAdmin ? 'disabled' : ''}>
              <i class="fas fa-vote-yea"></i>
              <span>${lockInfo.isLocked ? (isAdmin ? 'Quản lý' : 'Đã khóa') : 'Bình chọn'}</span>
            </button>
            ${isAdmin ? `
              <button class="sf-btn sf-btn-secondary" onclick="event.stopPropagation(); ScheduleModule.openChangeStatusModal(${Safe.js(session.id)})" title="${session.status === 'booked' ? 'Đã đặt sân' : session.status === 'completed' ? 'Đã diễn ra' : session.status === 'cancelled' ? 'Đã hủy' : 'Trạng thái'} — Nhấp để đổi">
                ${session.status === 'booked' ? '<i class="fas fa-calendar-check" style="color:#06b6d4"></i>' : session.status === 'completed' ? '<i class="fas fa-flag-checkered" style="color:#10b981"></i>' : session.status === 'cancelled' ? '<i class="fas fa-times-circle" style="color:#ef4444"></i>' : '<i class="fas fa-tasks" style="color:#f59e0b"></i>'}
              </button>
              <button class="sf-btn sf-btn-danger" onclick="ScheduleModule.confirmDeleteSession(${Safe.js(session.id)})" title="Xóa buổi này">
                <i class="fas fa-trash-alt"></i>
              </button>
            ` : ''}
          </div>
          </div>

          </div>
        </div>
      `;
    }).join('');
  },

};

window.ScheduleModule = ScheduleModule;
;

// ===== js/modules/schedule-calendar.js =====
// ScheduleModule - Lịch tuần / lịch tháng, bộ lọc, thống kê và bản xem nhanh khi rê chuột (tách từ schedule.js; mở rộng ScheduleModule nên `this` dùng như cũ)
Object.assign(ScheduleModule, {
  createPopoverElement() {
    if (document.getElementById('session-hover-popover')) {
      this.popoverEl = document.getElementById('session-hover-popover');
      return;
    }
    const pop = document.createElement('div');
    pop.id = 'session-hover-popover';
    pop.className = 'session-popover';
    document.body.appendChild(pop);
    this.popoverEl = pop;
  },

  // Update schedule high-level overview stats
  updateScheduleOverviewStats(sessions = []) {
    const monthCountEl = document.getElementById('sched-stat-month-count');
    const monthLabelEl = document.getElementById('sched-stat-month-label');
    const openVotesEl = document.getElementById('sched-stat-open-votes');
    const nextTitleEl = document.getElementById('sched-stat-next-title');
    const nextDescEl = document.getElementById('sched-stat-next-desc');

    const year = this.calYear || new Date().getFullYear();
    const month = (this.calMonth === null || this.calMonth === undefined || isNaN(this.calMonth)) ? new Date().getMonth() : this.calMonth;
    const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`;

    // Chế độ lịch tuần: thống kê theo tuần đang xem; ngược lại theo tháng đang xem
    let periodSessions;
    if (this.currentViewMode === 'calendar' && this.calendarScope === 'week' && this.weekStart) {
      const keys = new Set(Array.from({ length: 7 }, (_, i) => this.dateKeyOf(new Date(this.weekStart.getFullYear(), this.weekStart.getMonth(), this.weekStart.getDate() + i))));
      periodSessions = sessions.filter(s => keys.has(s.date));
      if (monthLabelEl) monthLabelEl.innerText = this.dateKeyOf(this.weekStart) === this.dateKeyOf(this.mondayOf(new Date())) ? 'Tuần này' : 'Tuần đang xem';
    } else {
      periodSessions = sessions.filter(s => s.date && s.date.startsWith(monthPrefix));
      if (monthLabelEl) monthLabelEl.innerText = `Tháng ${month + 1} / ${year}`;
    }
    if (monthCountEl) monthCountEl.innerText = `${periodSessions.length} trận`;

    // Số buổi ở các bộ lọc: Sắp diễn ra / Đã kết thúc / Tất cả
    const nowTs = new Date();
    const upcomingN = sessions.filter(s => this.parseSessionDateTime(s.date, s.endTime || '23:59') >= nowTs).length;
    const me = AppStorage.getCurrentUser();
    const mineN = me ? sessions.filter(s => s.status !== 'cancelled' && this.parseSessionDateTime(s.date, s.endTime || '23:59') >= nowTs && this.isMine(s, me.memberId)).length : 0;
    const counts = { upcoming: upcomingN, past: sessions.length - upcomingN, all: sessions.length, mine: mineN };
    const baseLabels = { upcoming: 'Sắp diễn ra', past: 'Đã kết thúc', all: 'Tất cả', mine: 'Của tôi' };
    document.querySelectorAll('#tab-schedule .filter-tab').forEach(btn => {
      const f = btn.getAttribute('data-filter');
      const label = btn.querySelector('span');
      if (label && baseLabels[f]) label.textContent = `${baseLabels[f]} (${counts[f]})`;
    });

    // Filter open polls
    const now = new Date();
    const openSessions = sessions.filter(s => {
      const lockInfo = this.getVoteLockStatus(s, 48);
      return !lockInfo.isLocked && s.status === 'open';
    });
    if (openVotesEl) openVotesEl.innerText = `${openSessions.length} buổi`;

    // Next upcoming session
    const upcoming = sessions.filter(s => this.parseSessionDateTime(s.date, s.endTime || s.startTime) >= now)
      .sort((a, b) => this.parseSessionDateTime(a.date, a.startTime) - this.parseSessionDateTime(b.date, b.startTime));

    if (upcoming.length > 0) {
      const next = upcoming[0];
      if (nextTitleEl) nextTitleEl.innerText = next.title;
      if (nextDescEl) nextDescEl.innerText = `${next.date} lúc ${next.startTime} • ${next.courtName || 'Sân CLB'}`;
    } else {
      if (nextTitleEl) nextTitleEl.innerText = "Chưa có lịch sắp tới";
      if (nextDescEl) nextDescEl.innerText = "Bấm 'Đặt lịch mới' để mở bình chọn";
    }
  },

  setFilter(filter = 'upcoming', btnEl = null) {
    this.currentFilter = filter;

    // 1. Cập nhật giao diện active cho các nút bộ lọc
    document.querySelectorAll('#tab-schedule .filter-tab').forEach(btn => {
      btn.classList.remove('active');
    });

    if (btnEl) {
      btnEl.classList.add('active');
    } else {
      const matched = document.querySelector(`#tab-schedule .filter-tab[data-filter="${filter}"]`);
      if (matched) matched.classList.add('active');
    }

    // 2. Cập nhật tiêu đề & mô tả cho danh sách phía dưới lịch
    const listTitle = document.getElementById('schedule-list-section-title');
    const listSubtitle = document.getElementById('schedule-list-section-subtitle');
    if (listTitle) {
      if (filter === 'past') {
        listTitle.innerHTML = '<i class="fas fa-history text-secondary"></i> Danh sách buổi đánh đã kết thúc';
        if (listSubtitle) listSubtitle.innerText = 'Lịch sử các trận đấu đã diễn ra và chốt số lượng người tham gia';
      } else if (filter === 'mine') {
        listTitle.innerHTML = '<i class="fas fa-user-check text-primary"></i> Các buổi bạn đã đăng ký đi';
        if (listSubtitle) listSubtitle.innerText = 'Buổi sắp tới mà bạn đã bình chọn tham gia';
      } else if (filter === 'all') {
        listTitle.innerHTML = '<i class="fas fa-list-check text-primary"></i> Tất cả buổi đánh & khảo sát';
        if (listSubtitle) listSubtitle.innerText = 'Toàn bộ danh sách lịch đặt sân đã lưu trên hệ thống';
      } else {
        listTitle.innerHTML = '<i class="fas fa-calendar-check text-primary"></i> Danh sách buổi đánh & bình chọn sắp tới';
        if (listSubtitle) listSubtitle.innerText = 'Tự động chốt và đóng vote trước 2 ngày';
      }
    }

    // 3. Kết xuất lại danh sách theo bộ lọc
    this.renderSessions('sessions-container', filter);
    this.renderSessions('schedule-upcoming-list', filter);
  },

  // Thứ Hai (00:00) của tuần chứa ngày d
  mondayOf(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    return x;
  },

  dateKeyOf(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },

  // Nút chế độ xem đang sáng: 'week' | 'calendar' (tháng) | 'cards'
  activeViewKey() {
    return this.currentViewMode === 'calendar' ? (this.calendarScope === 'month' ? 'calendar' : 'week') : 'cards';
  },

  syncViewModeButtons() {
    const key = this.activeViewKey();
    document.querySelectorAll('.view-mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-view') === key);
    });
  },

  switchViewMode(mode) {
    if (mode === 'week') {
      this.currentViewMode = 'calendar';
      this.calendarScope = 'week';
      this.weekStart = this.mondayOf(new Date());
    } else if (mode === 'calendar') {
      this.currentViewMode = 'calendar';
      this.calendarScope = 'month';
    } else {
      this.currentViewMode = mode;
    }
    mode = this.currentViewMode;
    this.syncViewModeButtons();

    const calView = document.getElementById('schedule-calendar-view');
    const calUpcoming = document.getElementById('schedule-calendar-upcoming');
    const cardView = document.getElementById('schedule-cards-view');

    if (mode === 'calendar') {
      if (calView) calView.style.display = 'block';
      if (calUpcoming) calUpcoming.style.display = 'block';
      if (cardView) cardView.style.display = 'none';
      this.renderMonthCalendar();
    } else {
      if (calView) calView.style.display = 'none';
      if (calUpcoming) calUpcoming.style.display = 'none';
      if (cardView) cardView.style.display = 'grid';
      this.renderSessions("sessions-container", this.currentFilter || 'upcoming');
    }
  },

  // Helper to render session event chips for a day cell
  renderDaySessionChips(daySessions, voteLockHours) {
    if (!daySessions || daySessions.length === 0) return '';

    return daySessions.map(session => {
      const lockInfo = this.getVoteLockStatus(session, voteLockHours);
      const isMultiPoll = session.voteMode === 'multi_option';
      const isGuestType = session.sessionType === 'guest';

      let totalGoing = 0;
      if (isMultiPoll) {
        const pollStats = this.calculatePollStats(session);
        totalGoing = pollStats.totalVoters;
      } else {
        const goingVotes = (session.votes || []).filter(v => v.status === 'going');
        totalGoing = goingVotes.reduce((sum, v) => sum + 1 + (v.guests || 0), 0);
      }

      let chipClass = 'chip-open';
      if (session.status === 'completed') chipClass = 'chip-completed';
      else if (session.status === 'cancelled') chipClass = 'chip-cancelled';
      else if (session.status === 'booked') chipClass = 'chip-booked';
      else if (lockInfo.isLocked) chipClass = 'chip-locked';
      else if (isMultiPoll) chipClass = 'chip-poll';

      const shortCourt = isMultiPoll ? 'Đa phương án' : (session.courtNumbers || session.courtName || 'Sân CLB').split('(')[0].trim();

      return `
        <div class="calendar-session-chip ${chipClass}" 
             data-session-id="${Safe.html(session.id)}"
             onclick="event.stopPropagation(); ScheduleModule.openSessionDetailsModal(${Safe.js(session.id)})"
             onmouseenter="ScheduleModule.showHoverPreview(event, ${Safe.js(session.id)})"
             onmouseleave="ScheduleModule.hideHoverPreview()"
             onmousemove="ScheduleModule.updatePopoverPos(event)"
             title="${Safe.html(session.title)} (${Safe.html(session.startTime)} - ${Safe.html(session.endTime)})">
          
          <!-- Desktop View: Compact 3-Row Micro-card -->
          <div class="chip-desktop-view">
            <div class="chip-time-row">
              <span class="chip-time"><i class="far fa-clock"></i> ${Safe.html(session.startTime)}</span>
              <div class="chip-badges-group">
                ${isMultiPoll ? `<span class="chip-tag chip-tag-poll" title="Khảo sát chọn sân & giờ">🗳️ Vote</span>` : ''}
                <span class="chip-tag ${isGuestType ? 'chip-tag-guest' : 'chip-tag-fixed'}" title="${isGuestType ? 'Giao lưu vãng lai' : 'Lịch cố định (trừ quỹ)'}">
                  ${isGuestType ? '⚡ VL' : '🏸 CĐ'}
                </span>
              </div>
            </div>
            <div class="chip-title-text" title="${Safe.html(session.title)}">
              ${Safe.html(session.title)}
            </div>
            <div class="chip-meta-row">
              <span class="chip-court-name" title="${Safe.html(shortCourt)}"><i class="fas fa-map-marker-alt"></i> ${Safe.html(shortCourt)}</span>
              <span class="chip-voters-pill"><i class="fas fa-users"></i> ${Safe.html(totalGoing)}/${Safe.html(session.maxPlayers)}</span>
            </div>
          </div>

          <!-- Mobile View: Ultra-compact Micro-pill (< 768px) -->
          <div class="chip-mobile-view">
            <span class="chip-m-time">${Safe.html(session.startTime)}</span>
            <span class="chip-m-voters">👥 ${Safe.html(totalGoing)}/${Safe.html(session.maxPlayers)}</span>
          </div>
        </div>
      `;
    }).join('');
  },

  // ==========================================
  // MONTHLY CALENDAR RENDERER
  // ==========================================
  // Lịch tuần: 7 ô (thứ Hai → Chủ nhật) dùng lại lưới của lịch tháng
  renderWeekCalendar() {
    try {
      this.createPopoverElement();
      const container = document.getElementById('calendar-grid-body');
      const titleEl = document.getElementById('calendar-month-display');
      if (!container) return;
      const data = AppStorage.loadData();
      const sessions = data.sessions || [];
      const voteLockHours = (data.clubInfo && data.clubInfo.voteLockHours) || 48;
      if (!this.weekStart) this.weekStart = this.mondayOf(new Date());
      const start = this.weekStart;
      const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
      const fmt = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
      const isThisWeek = this.dateKeyOf(start) === this.dateKeyOf(this.mondayOf(new Date()));
      if (titleEl) {
        titleEl.innerHTML = `<i class="far fa-calendar-alt text-primary"></i> ${isThisWeek ? 'Tuần này' : 'Tuần'} · ${fmt(start)} – ${fmt(end)}/${end.getFullYear()}`;
      }
      const todayKey = this.dateKeyOf(new Date());
      let html = '';
      for (let i = 0; i < 7; i++) {
        const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        const key = this.dateKeyOf(d);
        const chips = this.renderDaySessionChips(sessions.filter(s => s.date === key), voteLockHours);
        html += `
          <div class="calendar-day-cell week-cell ${key === todayKey ? 'is-today' : ''}">
            <div class="day-cell-top">
              <span class="day-number-badge">${d.getDate()} <small style="font-size:0.62rem; opacity:0.8;">T${d.getMonth() + 1}</small></span>
              <button class="day-add-btn" onclick="event.stopPropagation(); ScheduleModule.openAddSessionForDate(${Safe.js(key)})" title="Đặt lịch cho ngày này">
                <i class="fas fa-plus"></i>
              </button>
            </div>
            <div class="day-events-list">${chips}</div>
          </div>`;
      }
      container.innerHTML = html;
      container.classList.add('is-week');
      this.updateScheduleOverviewStats(sessions);
      if (document.getElementById('schedule-upcoming-list')) {
        this.renderSessions('schedule-upcoming-list', this.currentFilter || 'upcoming');
      }
    } catch (err) {
      console.error("Lỗi khi kết xuất lịch tuần:", err);
    }
  },

  // Điều hướng theo chế độ đang xem (tuần: ±7 ngày, tháng: ±1 tháng)
  calNav(dir) {
    if (this.calendarScope === 'week') {
      const s = this.weekStart || this.mondayOf(new Date());
      this.weekStart = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 7 * dir);
      this.renderMonthCalendar();
    } else if (dir < 0) this.prevMonth();
    else this.nextMonth();
  },

  renderMonthCalendar() {
    if (this.calendarScope === 'week') return this.renderWeekCalendar();
    try {
      this.createPopoverElement();
      const gridEl = document.getElementById('calendar-grid-body');
      if (gridEl) gridEl.classList.remove('is-week');
      const container = document.getElementById('calendar-grid-body');
      const titleEl = document.getElementById('calendar-month-display');
      if (!container) return;

      const data = AppStorage.loadData();
      const sessions = data.sessions || [];
      const voteLockHours = (data.clubInfo && data.clubInfo.voteLockHours) || 48;

      const now = new Date();
      if (!this.calYear || isNaN(this.calYear)) this.calYear = now.getFullYear();
      if (this.calMonth === undefined || this.calMonth === null || isNaN(this.calMonth)) this.calMonth = now.getMonth();

      const year = this.calYear;
      const month = this.calMonth; // 0-11

      if (titleEl) {
        titleEl.innerHTML = `<i class="far fa-calendar-alt text-primary"></i> Tháng ${month + 1} / ${year}`;
      }

      // Days in current month
      const totalDaysInMonth = new Date(year, month + 1, 0).getDate();
      // First day of current month: 0 (Sun) to 6 (Sat)
      let firstDayIndex = new Date(year, month, 1).getDay();
      // Adjust for Monday start (Mon=0, Tue=1, ..., Sun=6)
      let startDayOffset = (firstDayIndex === 0) ? 6 : firstDayIndex - 1;

      // Previous month total days
      const prevMonthDays = new Date(year, month, 0).getDate();
      const prevMonth = month === 0 ? 11 : month - 1;
      const prevYear = month === 0 ? year - 1 : year;

      const nextMonth = month === 11 ? 0 : month + 1;
      const nextYear = month === 11 ? year + 1 : year;

      const today = new Date();
      const isCurrentYearMonth = today.getFullYear() === year && today.getMonth() === month;
      const todayDate = today.getDate();

      let gridHtml = '';

      // Previous month padding cells
      for (let i = startDayOffset - 1; i >= 0; i--) {
        const pDay = prevMonthDays - i;
        const prevMonthStr = String(prevMonth + 1).padStart(2, '0');
        const pDayStr = String(pDay).padStart(2, '0');
        const dateKey = `${prevYear}-${prevMonthStr}-${pDayStr}`;
        const daySessions = sessions.filter(s => s.date === dateKey);
        const sessionChipsHtml = this.renderDaySessionChips(daySessions, voteLockHours);
        const hasEvents = daySessions.length > 0;

        gridHtml += `
          <div class="calendar-day-cell other-month ${hasEvents ? 'has-events' : ''}" 
               onclick="ScheduleModule.goToMonth(${prevYear}, ${prevMonth})" 
               style="cursor: pointer;" 
               title="Nhấp để chuyển sang Tháng ${prevMonth + 1} / ${prevYear}">
            <div class="day-cell-top">
              <span class="day-number-badge text-muted">${pDay} <small style="font-size:0.62rem; opacity:0.8;">T${prevMonth + 1}</small></span>
            </div>
            <div class="day-events-list">
              ${sessionChipsHtml}
            </div>
          </div>
        `;
      }

      // Current month cells
      for (let day = 1; day <= totalDaysInMonth; day++) {
        const monthStr = String(month + 1).padStart(2, '0');
        const dayStr = String(day).padStart(2, '0');
        const dateKey = `${year}-${monthStr}-${dayStr}`;

        const isToday = isCurrentYearMonth && day === todayDate;
        const daySessions = sessions.filter(s => s.date === dateKey);
        const sessionChipsHtml = this.renderDaySessionChips(daySessions, voteLockHours);

        gridHtml += `
          <div class="calendar-day-cell ${isToday ? 'is-today' : ''}">
            <div class="day-cell-top">
              <span class="day-number-badge">${day}</span>
              <button class="day-add-btn" onclick="event.stopPropagation(); ScheduleModule.openAddSessionForDate(${Safe.js(dateKey)})" title="Đặt lịch cho ngày này">
                <i class="fas fa-plus"></i>
              </button>
            </div>
            <div class="day-events-list">
              ${sessionChipsHtml}
            </div>
          </div>
        `;
      }

      // Next month padding cells to complete 7 columns
      const totalFilledCells = startDayOffset + totalDaysInMonth;
      const remainingCells = (7 - (totalFilledCells % 7)) % 7;
      for (let n = 1; n <= remainingCells; n++) {
        const nextMonthStr = String(nextMonth + 1).padStart(2, '0');
        const nDayStr = String(n).padStart(2, '0');
        const dateKey = `${nextYear}-${nextMonthStr}-${nDayStr}`;
        const daySessions = sessions.filter(s => s.date === dateKey);
        const sessionChipsHtml = this.renderDaySessionChips(daySessions, voteLockHours);
        const hasEvents = daySessions.length > 0;

        gridHtml += `
          <div class="calendar-day-cell other-month ${hasEvents ? 'has-events' : ''}" 
               onclick="ScheduleModule.goToMonth(${nextYear}, ${nextMonth})" 
               style="cursor: pointer;" 
               title="Nhấp để chuyển sang Tháng ${nextMonth + 1} / ${nextYear}">
            <div class="day-cell-top">
              <span class="day-number-badge text-muted">${n} <small style="font-size:0.62rem; opacity:0.8;">T${nextMonth + 1}</small></span>
            </div>
            <div class="day-events-list">
              ${sessionChipsHtml}
            </div>
          </div>
        `;
      }

      container.innerHTML = gridHtml;

      // Cập nhật thống kê tổng quan lịch trình
      this.updateScheduleOverviewStats(sessions);

      // Cập nhật danh sách dưới lịch tháng theo bộ lọc hiện tại (nếu container tồn tại)
      const upcomingContainer = document.getElementById('schedule-upcoming-list');
      if (upcomingContainer) {
        this.renderSessions('schedule-upcoming-list', this.currentFilter || 'upcoming');
      }
    } catch (err) {
      console.error("Lỗi khi kết xuất lịch tháng:", err);
    }
  },

  goToMonth(year, month) {
    this.calYear = year;
    this.calMonth = month;
    this.renderMonthCalendar();
  },

  prevMonth() {
    this.calMonth--;
    if (this.calMonth < 0) {
      this.calMonth = 11;
      this.calYear--;
    }
    this.renderMonthCalendar();
  },

  nextMonth() {
    this.calMonth++;
    if (this.calMonth > 11) {
      this.calMonth = 0;
      this.calYear++;
    }
    this.renderMonthCalendar();
  },

  goToToday() {
    const now = new Date();
    this.calYear = now.getFullYear();
    this.calMonth = now.getMonth();
    this.weekStart = this.mondayOf(now);
    this.renderMonthCalendar();
  },

  // ==========================================
  // HOVER PREVIEW POPOVER
  // ==========================================
  showHoverPreview(e, sessionId) {
    if (!this.popoverEl) this.createPopoverElement();

    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    if (!session) return;

    const members = data.members || [];
    const voteLockHours = data.clubInfo.voteLockHours || 48;
    const lockInfo = this.getVoteLockStatus(session, voteLockHours);
    const isMultiPoll = session.voteMode === 'multi_option';
    const isGuestType = session.sessionType === 'guest';

    let previewContent = '';

    if (isMultiPoll) {
      const pollStats = this.calculatePollStats(session);
      const topOption = pollStats.optionStats.find(s => s.isLeader) || pollStats.optionStats[0];

      previewContent = `
        <div class="popover-header">
          <div>
            <div class="popover-title">🗳️ ${Safe.html(session.title)}</div>
            <div style="display: flex; gap: 0.35rem; margin-top: 0.3rem;">
              <span class="badge badge-poll-mode" style="font-size: 0.65rem;">Khảo sát sân & giờ</span>
              <span class="badge ${isGuestType ? 'badge-guest-type' : 'badge-fixed-type'}" style="font-size: 0.65rem;">
                ${isGuestType ? 'Vãng lai (theo ngày)' : 'Cố định (trừ quỹ)'}
              </span>
            </div>
          </div>
          <span class="badge ${lockInfo.isLocked ? 'badge-danger' : 'badge-paid'}" style="font-size: 0.7rem;">
            ${lockInfo.isLocked ? '🔒 Đã chốt' : '🟢 Đang vote'}
          </span>
        </div>

        <div class="popover-meta-list">
          <div class="popover-meta-item">
            <i class="far fa-calendar-alt"></i>
            <span>Ngày dự kiến: <strong>${Safe.html(session.date)}</strong></span>
          </div>
          <div class="popover-meta-item">
            <i class="fas fa-crown text-warning"></i>
            <span>Dẫn đầu: <strong>${topOption ? `${Safe.html(topOption.option.courtName)} (${topOption.voteCount} phiếu)` : 'Chưa có phiếu'}</strong></span>
          </div>
          <div class="popover-meta-item">
            <i class="fas fa-hourglass-half"></i>
            <span>${Safe.html(lockInfo.countdownText)}</span>
          </div>
        </div>

        <div class="popover-roster-preview">
          <div class="flex items-center gap-2">
            <i class="fas fa-vote-yea text-primary"></i>
            <span class="font-bold text-primary">${pollStats.totalVoters} người đã bình chọn</span>
          </div>
          <span class="text-secondary" style="font-size:0.75rem;">${session.options.length} phương án</span>
        </div>
      `;
    } else {
      const goingVotes = (session.votes || []).filter(v => v.status === 'going');
      const totalGoing = goingVotes.reduce((sum, v) => sum + 1 + (v.guests || 0), 0);

      const attendeeAvatars = goingVotes.map(v => {
        const mem = members.find(m => m.id === v.memberId || (m.username && m.username === v.memberId)) || 
                    (data.users || []).find(u => u.id === v.memberId || u.memberId === v.memberId) || 
                    { name: 'Thành viên', avatar: '' };
        return `<img class="avatar avatar-sm" src="${Safe.url(mem.avatar, `https://ui-avatars.com/api/?name=${encodeURIComponent(mem.name)}&background=10b981&color=fff`)}" alt="${Safe.html(mem.name)}" style="width:24px;height:24px;" onerror="this.src=${Safe.js('https://ui-avatars.com/api/?name=' + encodeURIComponent(mem.name) + '&background=10b981&color=fff')}">`;
      }).slice(0, 5).join('');

      previewContent = `
        <div class="popover-header">
          <div>
            <div class="popover-title">🏸 ${Safe.html(session.title)}</div>
            <div style="display: flex; gap: 0.35rem; margin-top: 0.3rem;">
              <span class="badge ${isGuestType ? 'badge-guest-type' : 'badge-fixed-type'}" style="font-size: 0.65rem;">
                ${isGuestType ? 'Vãng lai (theo ngày)' : 'Cố định (trừ quỹ)'}
              </span>
            </div>
          </div>
          <span class="badge ${lockInfo.isLocked ? 'badge-danger' : 'badge-paid'}" style="font-size: 0.7rem;">
            ${lockInfo.isLocked ? '🔒 Đã chốt' : '🟢 Đang mở vote'}
          </span>
        </div>

        <div class="popover-meta-list">
          <div class="popover-meta-item">
            <i class="far fa-calendar-alt"></i>
            <span>${Safe.html(session.date)} • <strong>${Safe.html(session.startTime)} - ${Safe.html(session.endTime)}</strong></span>
          </div>
          <div class="popover-meta-item">
            <i class="fas fa-map-marker-alt"></i>
            <span>${Safe.html(session.courtName)} (<strong>${Safe.html(session.courtNumbers)}</strong>)</span>
          </div>
          <div class="popover-meta-item">
            <i class="fas fa-feather-alt"></i>
            <span>Loại cầu: <strong>${Safe.html(session.shuttleType)}</strong></span>
          </div>
          <div class="popover-meta-item">
            <i class="fas fa-hourglass-half"></i>
            <span>${Safe.html(lockInfo.countdownText)}</span>
          </div>
        </div>

        <div class="popover-roster-preview">
          <div class="flex items-center gap-2">
            <div class="avatar-stack">${attendeeAvatars}</div>
            <span class="font-bold text-primary">${Safe.html(totalGoing)} / ${Safe.html(session.maxPlayers)} người</span>
          </div>
          <span class="text-secondary" style="font-size:0.75rem;">${session.maxPlayers - totalGoing > 0 ? `Còn ${session.maxPlayers - totalGoing} chỗ` : 'Đủ chỗ'}</span>
        </div>
      `;
    }

    this.popoverEl.innerHTML = `
      ${previewContent}
      <div class="popover-footer-hint">
        <i class="fas fa-mouse-pointer"></i> Bấm chuột để xem chi tiết & bình chọn
      </div>
    `;

    this.popoverEl.classList.add('visible');
    this.updatePopoverPos(e);
  },

  updatePopoverPos(e) {
    if (!this.popoverEl || !this.popoverEl.classList.contains('visible')) return;
    const popW = 320;
    const popH = 270;
    let left = e.clientX + 16;
    let top = e.clientY + 16;

    if (left + popW > window.innerWidth) {
      left = e.clientX - popW - 16;
    }
    if (top + popH > window.innerHeight) {
      top = e.clientY - popH - 16;
    }

    this.popoverEl.style.left = `${Math.max(10, left)}px`;
    this.popoverEl.style.top = `${Math.max(10, top)}px`;
  },

  hideHoverPreview() {
    if (this.popoverEl) {
      this.popoverEl.classList.remove('visible');
    }
  },
});
;

// ===== js/modules/schedule-details.js =====
// ScheduleModule - Hộp thoại chi tiết buổi đánh, chốt phương án và chia sẻ (tách từ schedule.js; mở rộng ScheduleModule nên `this` dùng như cũ)
Object.assign(ScheduleModule, {
  // ==========================================
  // COMPREHENSIVE SESSION DETAILS MODAL (CLICK)
  // ==========================================
  openSessionDetailsModal(sessionId) {
    this.hideHoverPreview();
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    if (!session) return;

    const members = data.members || [];
    const dues = data.monthlyContributions || [];
    const currentMonth = AppStorage.currentMonth();
    const voteLockHours = (data.clubInfo && data.clubInfo.voteLockHours) || 48;
    const lockInfo = this.getVoteLockStatus(session, voteLockHours);
    const currentUser = data.currentUser || AppStorage.getCurrentUser();
    const isAdmin = AppStorage.can('schedule');
    const isMultiPoll = session.voteMode === 'multi_option';
    const isGuestType = session.sessionType === 'guest';

    const dateObj = new Date(session.date);
    const dayNames = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
    const dayName = dayNames[dateObj.getDay()];

    // MULTI-OPTION POLL DETAIL MODAL
    if (isMultiPoll) {
      const pollStats = this.calculatePollStats(session);

      const optionsHtml = pollStats.optionStats.map((st, idx) => {
        const opt = st.option;
        const voterAvatars = st.voters.map(m => `
          <img class="avatar avatar-sm" src="${Safe.url(m.avatar)}" alt="${Safe.html(m.name)}" title="${Safe.html(m.name)}" style="width:24px;height:24px;" onerror="this.src=${Safe.js('https://ui-avatars.com/api/?name=' + encodeURIComponent(m.name) + '&background=10b981&color=fff')}">
        `).join('');

        return `
          <div class="poll-option-card ${st.isLeader ? 'is-leader' : ''}">
            <div class="poll-option-header">
              <div class="poll-option-title">
                <span>Phương án ${idx + 1}: ${Safe.html(opt.courtName)}</span>
                ${st.isLeader ? `<span class="badge badge-warning" style="font-size:0.7rem;"><i class="fas fa-crown"></i> Dẫn đầu</span>` : ''}
              </div>
              <div class="font-bold text-primary font-mono" style="font-size: 1.1rem;">
                ${st.voteCount} phiếu <span class="text-secondary" style="font-size:0.8rem;">(${st.percent}%)</span>
              </div>
            </div>

            <div class="poll-option-meta">
              <div class="poll-option-meta-item">
                <i class="far fa-calendar-alt"></i>
                <span>${Safe.html(opt.date || session.date)}</span>
              </div>
              <div class="poll-option-meta-item">
                <i class="far fa-clock"></i>
                <span>${Safe.html(opt.startTime)} - ${Safe.html(opt.endTime)}</span>
              </div>
              <div class="poll-option-meta-item">
                <i class="fas fa-th-list"></i>
                <span>${Safe.html(opt.courtNumbers)}</span>
              </div>
              <div class="poll-option-meta-item">
                <i class="fas fa-money-bill-wave"></i>
                <span>${Number(opt.price) ? Number(opt.price).toLocaleString('vi-VN') + ' đ' : 'Chưa nhập giá'}</span>
              </div>
            </div>

            ${opt.note ? `<div class="text-muted" style="font-size: 0.8rem; margin-bottom: 0.5rem; font-style: italic;">"${Safe.html(opt.note)}"</div>` : ''}

            <div class="poll-bar-wrapper">
              <div class="poll-bar-track">
                <div class="poll-bar-fill ${st.isLeader ? 'leader-bar' : ''}" style="width: ${st.percent}%;"></div>
              </div>
            </div>

            <div class="poll-voters-row">
              <div class="flex items-center gap-2">
                <span class="text-secondary">Người đã chọn:</span>
                <div class="avatar-stack">${voterAvatars || '<span class="text-muted">Chưa có ai</span>'}</div>
              </div>

              ${isAdmin ? `
                <div class="flex gap-2">
                  <button type="button" class="btn btn-ghost btn-icon btn-sm" onclick="ScheduleModule.openEditCourtLocationModal(${Safe.js(session.id)}, ${Safe.js(opt.id)})" title="Admin: Sửa thông tin sân & tiền sân phương án này" style="border: 1px solid var(--border-color); border-radius: var(--radius-sm);">
                    <i class="fas fa-pencil-alt text-warning"></i>
                  </button>
                  <button type="button" class="btn btn-outline-primary btn-sm" onclick="ScheduleModule.finalizePollOption(${Safe.js(session.id)}, ${Safe.js(opt.id)})" title="Chốt phương án này làm lịch thi đấu chính thức">
                    <i class="fas fa-check-double"></i> Chốt phương án
                  </button>
                </div>
              ` : ''}
            </div>
          </div>
        `;
      }).join('');

      const modalBody = `
        <div style="background: linear-gradient(135deg, rgba(6, 182, 212, 0.15) 0%, rgba(16, 185, 129, 0.08) 100%); border-radius: var(--radius-lg); padding: 1.25rem; margin-bottom: 1.25rem; border: 1px solid var(--border-color-focus);">
          <div class="flex justify-between items-start flex-wrap gap-2">
            <div>
              <div style="display: flex; gap: 0.4rem; margin-bottom: 0.4rem;">
                <span class="badge badge-poll-mode"><i class="fas fa-poll"></i> Khảo sát chọn sân & giờ</span>
                <span class="badge ${isGuestType ? 'badge-guest-type' : 'badge-fixed-type'}">
                  ${isGuestType ? '⚡ Lịch vãng lai theo ngày' : '🏸 Lịch cố định (Trừ quỹ)'}
                </span>
                <span class="badge ${lockInfo.isLocked ? 'badge-danger' : 'badge-paid'}">
                  ${lockInfo.isLocked ? '🔒 Đã khóa vote' : '🟢 Đang mở vote'}
                </span>
              </div>
              <h2 style="font-size: 1.35rem; color: #fff;">${Safe.html(session.title)}</h2>
              <div class="text-secondary" style="font-size: 0.9rem; margin-top: 0.25rem;">
                Ngày dự kiến: <strong>${dayName}, ${Safe.html(session.date)}</strong> • Tối đa <strong>${Safe.html(session.maxPlayers)} người</strong>
              </div>
            </div>
            <div class="text-right">
              <div class="font-bold text-primary" style="font-size: 1.7rem; line-height: 1;">${pollStats.totalVoters}</div>
              <div class="text-muted" style="font-size: 0.75rem;">Người đã bình chọn</div>
            </div>
          </div>
        </div>

        <div class="vote-deadline-notice ${lockInfo.isLocked ? 'is-locked' : 'is-open'}" style="margin-bottom: 1.25rem;">
          <div>
            <i class="fas ${lockInfo.isLocked ? 'fa-lock' : 'fa-hourglass-half'}"></i>
            <span>${Safe.html(lockInfo.countdownText)}</span>
          </div>
          <span style="font-size: 0.8rem; font-weight: 600;">Hạn chót: ${Safe.html(lockInfo.deadlineFormatted)}</span>
        </div>

        ${session.note ? `
          <div style="background: rgba(245, 158, 11, 0.08); border-left: 3px solid var(--accent); padding: 0.75rem 1rem; border-radius: var(--radius-sm); margin-bottom: 1.25rem; font-size: 0.88rem;">
            <strong><i class="fas fa-sticky-note text-warning"></i> Lưu ý:</strong> ${Safe.html(session.note)}
          </div>
        ` : ''}

        <div style="margin-bottom: 0.75rem; font-weight: 700; display: flex; align-items: center; gap: 0.4rem;">
          <i class="fas fa-list-ol text-primary"></i> Các phương án đang khảo sát:
        </div>

        <div class="poll-options-container">
          ${optionsHtml}
        </div>

        ${pollStats.notGoingCount > 0 ? `
          <div style="background: rgba(239, 68, 68, 0.08); padding: 0.75rem 1rem; border-radius: var(--radius-md); border: 1px solid rgba(239, 68, 68, 0.2); margin-bottom: 1.25rem;">
            <div class="font-bold text-danger" style="font-size: 0.88rem; margin-bottom: 0.4rem;">
              <i class="fas fa-times-circle"></i> Báo bận / không tham gia được phương án nào (${pollStats.notGoingCount} người):
            </div>
            <div class="avatar-stack">
              ${pollStats.notGoingVoters.map(m => `<img class="avatar avatar-sm" src="${Safe.url(m.avatar)}" alt="${Safe.html(m.name)}" title="${Safe.html(m.name)}" style="width:24px;height:24px;">`).join('')}
            </div>
          </div>
        ` : ''}

        ${lockInfo.isLocked && !isAdmin ? `
          <div style="background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: var(--radius-md); padding: 0.75rem 1rem; margin-bottom: 1.25rem; display: flex; align-items: center; gap: 0.6rem; color: #fca5a5; font-size: 0.88rem;">
            <i class="fas fa-lock" style="font-size: 1.2rem; color: #ef4444;"></i>
            <div>
              <strong>Khóa đổi lịch (Trước 2 ngày):</strong> Buổi khảo sát này đã quá hạn bình chọn. Vui lòng liên hệ Admin nếu cần cập nhật.
            </div>
          </div>
        ` : ''}

        <!-- Vote History Timeline for Poll -->
        <div class="vote-history-card" style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 1rem; margin-bottom: 1.25rem;">
          <div style="font-weight: 700; font-size: 0.92rem; margin-bottom: 0.75rem; display: flex; align-items: center; justify-content: space-between;">
            <span class="text-main"><i class="fas fa-history text-primary"></i> 📜 Lịch sử bình chọn & thay đổi</span>
            <span class="badge badge-neutral" style="font-size: 0.72rem;">${(session.voteHistory || []).length} lượt ghi nhận</span>
          </div>
          ${VotingModule.renderVoteHistoryTimeline(session.voteHistory || [])}
        </div>

        ${!isAdmin && window.VoteScheduler ? VoteScheduler.renderDelegatePanel(session) : ''}
        ${isAdmin ? `
        <!-- Admin: Quản lý trạng thái (Poll Modal) -->
        <div class="session-status-panel" style="margin-bottom: 1rem;">
          <div class="session-status-panel-title">
            <i class="fas fa-tasks"></i> Trạng thái buổi khảo sát
            <span class="session-status-badge-inline status-${Safe.html(session.status || 'open')}">
              ${ session.status === 'booked' ? '📋 Đã đặt sân' : session.status === 'completed' ? '✅ Đã diễn ra' : session.status === 'cancelled' ? '❌ Đã hủy' : '🟢 Đang mở vote' }
            </span>
          </div>
          <div class="session-status-btn-row">
            <button class="session-status-btn ${session.status === 'booked' ? 'is-current' : ''}" onclick="ScheduleModule.changeSessionStatus(${Safe.js(session.id)}, 'booked')" ${session.status === 'booked' ? 'disabled' : ''}>
              <i class="fas fa-calendar-check"></i>
              <span>Đã đặt sân</span>
              <small>Admin xác nhận sân</small>
            </button>
            <button class="session-status-btn ${session.status === 'completed' ? 'is-current' : ''} btn-completed" onclick="ScheduleModule.changeSessionStatus(${Safe.js(session.id)}, 'completed')" ${session.status === 'completed' ? 'disabled' : ''}>
              <i class="fas fa-flag-checkered"></i>
              <span>Đã diễn ra</span>
              <small>Kết thúc buổi đánh</small>
            </button>
            <button class="session-status-btn ${session.status === 'cancelled' ? 'is-current' : ''} btn-cancelled" onclick="ScheduleModule.changeSessionStatus(${Safe.js(session.id)}, 'cancelled')" ${session.status === 'cancelled' ? 'disabled' : ''}>
              <i class="fas fa-times-circle"></i>
              <span>Hủy buổi</span>
              <small>Không tổ chức nữa</small>
            </button>
            ${window.VoteScheduler ? VoteScheduler.renderAdminButton(session) : ''}
            ${session.status !== 'open' ? `
            <button class="session-status-btn btn-reopen" onclick="ScheduleModule.changeSessionStatus(${Safe.js(session.id)}, 'open')">
              <i class="fas fa-undo"></i>
              <span>Mở lại</span>
              <small>Khôi phục vote</small>
            </button>
            ` : ''}
          </div>
        </div>
        ` : ''}

        <div style="display: flex; gap: 0.5rem; margin-top: 1.25rem; flex-wrap: wrap;">
          <button class="btn btn-primary flex-1" onclick="${lockInfo.isLocked && !isAdmin ? `App.showToast('🚫 Khảo sát đã chốt trước 2 ngày. Không thể thay đổi lịch!', 'warning')` : `App.closeModal(); VotingModule.openVoteModal(${Safe.js(session.id)})`}" ${lockInfo.isLocked && !isAdmin ? 'disabled style="opacity:0.65; cursor:not-allowed;"' : ''}>
            <i class="fas fa-vote-yea"></i> ${lockInfo.isLocked ? (isAdmin ? 'Quản lý bình chọn (Admin)' : '🔒 Đã chốt danh sách (Trước 2 ngày)') : 'Bình chọn phương án'}
          </button>
          <button class="btn btn-secondary" onclick="ScheduleModule.shareSession(${Safe.js(session.id)})">
            <i class="fas fa-share-alt"></i> Chia sẻ Zalo
          </button>
          <button class="btn btn-secondary" onclick="UtilitiesModule.addToCalendar(${Safe.js(session.id)})" title="Thêm vào lịch điện thoại">
            <i class="far fa-calendar-plus"></i> Thêm vào lịch
          </button>
          ${isAdmin ? `
            <button class="btn btn-outline-danger" onclick="ScheduleModule.confirmDeleteSession(${Safe.js(session.id)})" title="Xóa buổi khảo sát này">
              <i class="fas fa-trash-alt"></i> Xóa buổi này
            </button>
          ` : ''}
          <button class="btn btn-secondary" onclick="App.closeModal()">Đóng</button>
        </div>
      `;

      App.openModal("🗳️ Khảo sát chọn sân & khung giờ", modalBody, true);
      return;
    }

    // STANDARD SINGLE-SCHEDULE DETAIL MODAL
    // Strict deduplication by memberId (1 active vote per member)
    const uniqueVoteMap = new Map();
    (session.votes || []).forEach(v => {
      const memKey = String(v.memberId || '').trim();
      if (!memKey) return;
      if (!uniqueVoteMap.has(memKey)) {
        uniqueVoteMap.set(memKey, v);
      } else {
        const existing = uniqueVoteMap.get(memKey);
        const existingTime = existing.votedAt ? new Date(String(existing.votedAt).replace(' ', 'T')).getTime() : 0;
        const newTime = v.votedAt ? new Date(String(v.votedAt).replace(' ', 'T')).getTime() : 0;
        if (newTime >= existingTime) {
          uniqueVoteMap.set(memKey, v);
        }
      }
    });
    const uniqueVotes = Array.from(uniqueVoteMap.values());
    const going = uniqueVotes.filter(v => v.status === 'going');
    const maybe = uniqueVotes.filter(v => v.status === 'maybe');
    const notGoing = uniqueVotes.filter(v => v.status === 'not_going');
    const totalGoingCount = going.reduce((acc, v) => acc + 1 + (v.guests || 0), 0);
    const capPercent = Math.min(100, Math.round((totalGoingCount / session.maxPlayers) * 100));

    const renderRosterGroup = (list) => {
      if (list.length === 0) return `<div class="text-muted" style="font-size: 0.85rem; padding: 0.5rem 0;">Chưa có ai trong danh sách này.</div>`;

      return list.map(v => {
        const mem = members.find(m => m.id === v.memberId || (m.username && m.username === v.memberId)) || 
                    (data.users || []).find(u => u.id === v.memberId || u.memberId === v.memberId) || 
                    { name: 'Thành viên', phone: '', type: 'fixed', avatar: '' };
        const memberDue = dues.find(d => (d.memberId === mem.id || d.memberId === v.memberId) && d.month === currentMonth);
        let dueBadge = '';
        if (mem.type === 'guest') {
          dueBadge = `<span class="badge badge-warning">Vãng lai (${Safe.html(data.clubInfo.guestFee.toLocaleString('vi-VN'))}đ)</span>`;
        } else if (isAdmin || (currentUser && (mem.id === currentUser.id || mem.id === currentUser.memberId || (currentUser.username && mem.username === currentUser.username) || (currentUser.phone && mem.phone && currentUser.phone.replace(/\D/g, '') === mem.phone.replace(/\D/g, ''))))) {
          if (memberDue && memberDue.status === 'paid') {
            dueBadge = `<span class="badge badge-paid">Đã đóng quỹ T${currentMonth.slice(5)}</span>`;
          } else {
            dueBadge = `<span class="badge badge-unpaid">Chưa đóng quỹ</span>`;
          }
        } else {
          dueBadge = `<span class="badge badge-neutral" style="font-size: 0.68rem;" title="Hội viên cố định"><i class="fas fa-lock text-muted"></i> Cố định</span>`;
        }

        return `
          <div class="attendee-item">
            <div class="attendee-left">
              <img class="avatar" src="${Safe.url(mem.avatar, `https://ui-avatars.com/api/?name=${encodeURIComponent(mem.name)}&background=10b981&color=fff`)}" alt="${Safe.html(mem.name)}" onerror="this.src=${Safe.js('https://ui-avatars.com/api/?name=' + encodeURIComponent(mem.name) + '&background=10b981&color=fff')}">
              <div class="attendee-info">
                <h4>
                  ${Safe.html(mem.name)} 
                  ${v.guests > 0 ? `<span class="badge-guest">+${Safe.html(v.guests)} khách</span>` : ''}
                </h4>
                <div class="attendee-meta">
                  <span><i class="fas fa-phone-alt"></i> ${Safe.html(mem.phone ? AppStorage.maskPhone(mem.phone, mem.id) : 'Chưa có SĐT')}</span>
                  ${v.note ? `<span>• <i class="far fa-comment"></i> "${Safe.html(v.note)}"</span>` : ''}
                </div>
              </div>
            </div>
            <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 0.3rem;">
              ${dueBadge}
              <span class="vote-time">${Safe.html(v.votedAt)}</span>
            </div>
          </div>
        `;
      }).join('');
    };

    const modalBody = `
      <div style="background: linear-gradient(135deg, rgba(16, 185, 129, 0.15) 0%, rgba(6, 182, 212, 0.08) 100%); border-radius: var(--radius-lg); padding: 1.25rem; margin-bottom: 1.25rem; border: 1px solid var(--border-color-focus);">
        <div class="flex justify-between items-start flex-wrap gap-2">
          <div>
            <div style="display:flex; gap: 0.4rem; margin-bottom: 0.4rem;">
              <span class="badge ${isGuestType ? 'badge-guest-type' : 'badge-fixed-type'}">
                ${isGuestType ? '⚡ Lịch vãng lai theo ngày' : '🏸 Lịch cố định (Trừ quỹ)'}
              </span>
              <span class="badge ${lockInfo.isLocked ? 'badge-danger' : 'badge-paid'}">
                ${lockInfo.isLocked ? '🔒 Đã chốt danh sách (trước 2 ngày)' : '🟢 Đang mở bình chọn'}
              </span>
            </div>
            <h2 style="font-size: 1.4rem; color: #fff;">${Safe.html(session.title)}</h2>
            <div class="text-primary font-semibold" style="font-size: 0.95rem; margin-top: 0.25rem;">
              <i class="far fa-calendar-check"></i> ${dayName}, ngày ${Safe.html(session.date)} • <i class="far fa-clock"></i> ${Safe.html(session.startTime)} - ${Safe.html(session.endTime)}
              ${isAdmin && (session.voteMode !== 'multi_option' || session.selectedOptionId) ? `
                <button type="button" class="btn btn-ghost btn-icon btn-xs" onclick="ScheduleModule.openEditSessionTimeModal(${Safe.js(session.id)})" title="Admin: Chỉnh sửa ngày & giờ đánh" style="border: 1px solid var(--border-color); border-radius: var(--radius-sm); margin-left: 0.35rem;">
                  <i class="fas fa-pencil-alt text-warning"></i>
                </button>
              ` : ''}
            </div>
          </div>
          <div class="text-right">
            <div class="font-bold text-primary" style="font-size: 1.7rem; line-height: 1;">${Safe.html(totalGoingCount)} / ${Safe.html(session.maxPlayers)}</div>
            <div class="text-muted" style="font-size: 0.75rem;">Người tham gia</div>
          </div>
        </div>

        <div style="margin-top: 1rem;">
          <div class="flex justify-between items-center text-secondary" style="font-size: 0.8rem; margin-bottom: 0.35rem;">
            <span>Tỷ lệ lấp đầy sân (${Safe.html(totalGoingCount)}/${Safe.html(session.maxPlayers)} người)</span>
            <strong>${session.maxPlayers - totalGoingCount > 0 ? `Còn ${session.maxPlayers - totalGoingCount} chỗ trống` : 'Đã đủ số lượng'}</strong>
          </div>
          <div class="progress-bar-bg">
            <div class="progress-bar-fill" style="width: ${capPercent}%;"></div>
          </div>
        </div>
        ${UtilitiesModule.waitlistHtml(session, going, members)}
      </div>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; margin-bottom: 1.25rem;">
        <div class="card" style="padding: 0.85rem; background: var(--bg-input);">
          <div class="text-secondary" style="font-size: 0.75rem;"><i class="fas fa-map-marker-alt text-primary"></i> Địa điểm sân</div>
          <div class="font-bold" style="font-size: 0.92rem; margin-top: 0.2rem;">${Safe.html(session.courtName || session.court || 'Sân cầu lông')}</div>
          <div class="text-secondary" style="font-size: 0.78rem;">${Safe.html(session.courtNumbers || '')}</div>
        </div>

        <div class="card" style="padding: 0.85rem; background: var(--bg-input);">
          <div class="text-secondary" style="font-size: 0.75rem;"><i class="fas fa-money-bill-wave text-primary"></i> Tiền sân dự tính</div>
          <div class="font-bold text-primary" style="font-size: 0.95rem; margin-top: 0.2rem;">${(session.courtPrice ? Number(session.courtPrice).toLocaleString('vi-VN') : '0')} VNĐ</div>
          <div class="text-secondary" style="font-size: 0.78rem;">Chi phí sân</div>
        </div>

        <div class="card" style="padding: 0.85rem; background: var(--bg-input);">
          <div class="text-secondary" style="font-size: 0.75rem;"><i class="fas fa-feather-alt text-primary"></i> Loại cầu sử dụng</div>
          <div class="font-bold" style="font-size: 0.92rem; margin-top: 0.2rem;">${Safe.html(session.shuttleType || 'n/a')}</div>
          <div class="text-secondary" style="font-size: 0.78rem;">Loại cầu trận đấu</div>
        </div>
      </div>

      <!-- Court Location & Interactive Map Card -->
      <div class="court-location-card" style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 1rem; margin-bottom: 1.25rem;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 0.75rem; margin-bottom: 0.75rem; flex-wrap: wrap;">
          <div style="flex: 1; min-width: 220px;">
            <div class="text-secondary" style="font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">
              <i class="fas fa-map-marker-alt text-primary"></i> Vị trí & Địa điểm sân cầu
            </div>
            <div class="font-bold text-main" style="font-size: 1.05rem; margin-top: 0.2rem;">
              ${Safe.html(session.courtName || session.court || 'Sân cầu lông')} ${session.courtNumbers ? `<span class="badge badge-neutral" style="font-size: 0.72rem; margin-left: 0.35rem;">${Safe.html(session.courtNumbers)}</span>` : ''}
            </div>
            <div class="text-secondary" style="font-size: 0.85rem; margin-top: 0.2rem; display: flex; align-items: flex-start; gap: 0.4rem;">
              <i class="fas fa-location-arrow text-primary" style="margin-top: 0.2rem; font-size: 0.75rem;"></i>
              <span>${Safe.html(session.courtAddress || (data.clubInfo ? data.clubInfo.address : "") || session.courtName || session.court || 'Sân cầu lông')}</span>
            </div>
          </div>
          <div style="display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap;">
            ${isAdmin ? `
              <button type="button" class="btn btn-ghost btn-icon btn-sm" onclick="ScheduleModule.openEditCourtLocationModal(${Safe.js(session.id)})" title="Admin: Chỉnh sửa thông tin sân, tiền sân & loại cầu" style="border: 1px solid var(--border-color); border-radius: var(--radius-sm);">
                <i class="fas fa-pencil-alt text-warning"></i>
              </button>
            ` : ''}
            <button type="button" class="btn btn-outline-primary btn-sm" onclick="ScheduleModule.copyAddress(${Safe.js(session.courtAddress || (data.clubInfo ? data.clubInfo.address : "") || session.courtName || session.court || "Sân cầu lông")})" title="Sao chép địa chỉ">
              <i class="far fa-copy"></i> Sao chép
            </button>
            <a href="${Safe.url(session.mapUrl || (data.clubInfo && data.clubInfo.mapUrl) || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(session.courtAddress || session.courtName || session.court || "Sân cầu lông")}`)}" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-sm" title="Mở bản đồ Google Maps và dẫn đường">
              <i class="fas fa-directions"></i> Chỉ đường Maps
            </a>
          </div>
        </div>

        <!-- Interactive Map Preview -->
        <div class="court-map-embed-wrapper">
          <iframe 
            width="100%" 
            height="100%" 
            style="border:0;" 
            loading="lazy" 
            allowfullscreen 
            referrerpolicy="no-referrer-when-downgrade"
            src="https://maps.google.com/maps?q=${encodeURIComponent(session.courtAddress || session.courtName || session.court || "Sân cầu lông")}&t=&z=15&ie=UTF8&iwloc=&output=embed">
          </iframe>
          <a href="${Safe.url(session.mapUrl || (data.clubInfo && data.clubInfo.mapUrl) || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(session.courtAddress || session.courtName || session.court || "Sân cầu lông")}`)}" target="_blank" rel="noopener noreferrer" class="map-overlay-badge">
            <i class="fas fa-external-link-alt text-primary"></i> Mở Google Maps
          </a>
        </div>
      </div>

      <div class="vote-deadline-notice ${lockInfo.isLocked ? 'is-locked' : 'is-open'}" style="margin-bottom: 1.25rem;">
        <div>
          <i class="fas ${lockInfo.isLocked ? 'fa-lock' : 'fa-hourglass-half'}"></i>
          <span>${Safe.html(lockInfo.countdownText)}</span>
        </div>
        <span style="font-size: 0.8rem; font-weight: 600;">Hạn chót: ${Safe.html(lockInfo.deadlineFormatted)}</span>
      </div>

      ${lockInfo.isLocked && !isAdmin ? `
        <div style="background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: var(--radius-md); padding: 0.75rem 1rem; margin-bottom: 1.25rem; display: flex; align-items: center; gap: 0.6rem; color: #fca5a5; font-size: 0.88rem;">
          <i class="fas fa-lock" style="font-size: 1.2rem; color: #ef4444;"></i>
          <div>
            <strong>Khóa đổi lịch (Trước 2 ngày):</strong> Ca đánh này đã chốt danh sách và khóa bình chọn đối với thành viên. Vui lòng liên hệ Admin nếu có phát sinh đột xuất!
          </div>
        </div>
      ` : ''}

      ${session.note ? `
        <div style="background: rgba(245, 158, 11, 0.08); border-left: 3px solid var(--accent); padding: 0.75rem 1rem; border-radius: var(--radius-sm); margin-bottom: 1.25rem; font-size: 0.88rem;">
          <strong><i class="fas fa-sticky-note text-warning"></i> Lưu ý từ ban tổ chức:</strong> ${Safe.html(session.note)}
        </div>
      ` : ''}

      <div style="display: flex; gap: 0.5rem; margin-bottom: 1.25rem; flex-wrap: wrap;">
        <button class="btn btn-primary btn-sm flex-1" onclick="${lockInfo.isLocked && !isAdmin ? `App.showToast('🚫 Ca đánh đã chốt trước 2 ngày. Thành viên không thể đổi lịch!', 'warning')` : `App.closeModal(); VotingModule.openVoteModal(${Safe.js(session.id)})`}" ${lockInfo.isLocked && !isAdmin ? 'disabled style="opacity: 0.65; cursor: not-allowed;"' : ''}>
          <i class="fas fa-vote-yea"></i> ${lockInfo.isLocked ? (isAdmin ? 'Quản lý bình chọn (Admin)' : '🔒 Đã chốt danh sách (Trước 2 ngày)') : 'Bình chọn (đi / nghỉ)'}
        </button>
        <button class="btn btn-secondary btn-sm" onclick="ScheduleModule.shareSession(${Safe.js(session.id)})">
          <i class="fas fa-share-alt"></i> Chia sẻ Zalo
        </button>
        <button class="btn btn-secondary btn-sm" onclick="UtilitiesModule.addToCalendar(${Safe.js(session.id)})" title="Thêm vào lịch điện thoại">
          <i class="far fa-calendar-plus"></i> Thêm vào lịch
        </button>
        ${isAdmin ? `
          <button class="btn btn-secondary btn-sm" onclick="App.closeModal(); App.openTab('bill-splitter'); BillSplitterModule.loadSessionForBill(${Safe.js(session.id)});">
            <i class="fas fa-calculator"></i> Chia tiền sân (Admin)
          </button>
        ` : ''}
        ${isAdmin ? `
          <button class="btn btn-outline-danger btn-sm" onclick="ScheduleModule.confirmDeleteSession(${Safe.js(session.id)})" title="Xóa buổi đặt sân này">
            <i class="fas fa-trash-alt"></i> Xóa buổi này
          </button>
        ` : ''}
      </div>

      ${!isAdmin && window.VoteScheduler ? VoteScheduler.renderDelegatePanel(session) : ''}
      ${isAdmin ? `
      <!-- Admin: Quản lý trạng thái vòng đời buổi đặt sân -->
      <div class="session-status-panel">
        <div class="session-status-panel-title">
          <i class="fas fa-tasks"></i> Trạng thái buổi đặt sân
          <span class="session-status-badge-inline status-${Safe.html(session.status || 'open')}">
            ${ session.status === 'booked' ? '📋 Đã đặt sân' : session.status === 'completed' ? '✅ Đã diễn ra' : session.status === 'cancelled' ? '❌ Đã hủy' : '🟢 Đang mở vote' }
          </span>
        </div>
        <div class="session-status-btn-row">
          <button class="session-status-btn ${session.status === 'booked' ? 'is-current' : ''}" onclick="ScheduleModule.changeSessionStatus(${Safe.js(session.id)}, 'booked')" title="Đánh dấu Admin đã gọi và đặt sân thành công" ${session.status === 'booked' ? 'disabled' : ''}>
            <i class="fas fa-calendar-check"></i>
            <span>Đã đặt sân</span>
            <small>Admin xác nhận sân</small>
          </button>
          <button class="session-status-btn ${session.status === 'completed' ? 'is-current' : ''} btn-completed" onclick="ScheduleModule.changeSessionStatus(${Safe.js(session.id)}, 'completed')" title="Buổi đã diễn ra xong" ${session.status === 'completed' ? 'disabled' : ''}>
            <i class="fas fa-flag-checkered"></i>
            <span>Đã diễn ra</span>
            <small>Kết thúc buổi đánh</small>
          </button>
          <button class="session-status-btn ${session.status === 'cancelled' ? 'is-current' : ''} btn-cancelled" onclick="ScheduleModule.changeSessionStatus(${Safe.js(session.id)}, 'cancelled')" title="Hủy toàn bộ buổi đặt sân này" ${session.status === 'cancelled' ? 'disabled' : ''}>
            <i class="fas fa-times-circle"></i>
            <span>Hủy buổi</span>
            <small>Không tổ chức nữa</small>
          </button>
          ${window.VoteScheduler ? VoteScheduler.renderAdminButton(session) : ''}
          ${session.status !== 'open' ? `
          <button class="session-status-btn btn-reopen" onclick="ScheduleModule.changeSessionStatus(${Safe.js(session.id)}, 'open')" title="Mở lại trạng thái bình chọn ban đầu">
            <i class="fas fa-undo"></i>
            <span>Mở lại</span>
            <small>Khôi phục vote</small>
          </button>
          ` : ''}
        </div>
      </div>
      ` : ''}

      <div style="display: flex; flex-direction: column; gap: 1rem;">
        <div>
          <div class="font-bold text-primary" style="margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.4rem;">
            <i class="fas fa-check-circle"></i> Danh sách tham gia (${going.length} người + ${Safe.html(going.reduce((s, v) => s + (v.guests || 0), 0))} khách)
          </div>
          <div class="attendee-list" style="max-height: 240px;">
            ${renderRosterGroup(going)}
          </div>
        </div>

        ${maybe.length > 0 ? `
          <div>
            <div class="font-bold text-warning" style="margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.4rem;">
              <i class="fas fa-hourglass-half"></i> Danh sách dự bị (${maybe.length} người)
            </div>
            <div class="attendee-list" style="max-height: 160px;">
              ${renderRosterGroup(maybe)}
            </div>
          </div>
        ` : ''}

        <!-- Vote History Timeline for Standard Session -->
        <div class="vote-history-card" style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-lg); padding: 1rem; margin-top: 0.5rem;">
          <div style="font-weight: 700; font-size: 0.92rem; margin-bottom: 0.75rem; display: flex; align-items: center; justify-content: space-between;">
            <span class="text-main"><i class="fas fa-history text-primary"></i> 📜 Lịch sử bình chọn & thay đổi</span>
            <span class="badge badge-neutral" style="font-size: 0.72rem;">${(session.voteHistory || []).length} lượt ghi nhận</span>
          </div>
          ${VotingModule.renderVoteHistoryTimeline(session.voteHistory || [])}
        </div>
      </div>

      <div class="modal-footer" style="padding: 1.25rem 0 0 0; display: flex; justify-content: space-between; align-items: center;">
        <div>
          ${isAdmin ? `
            <button type="button" class="btn btn-outline-danger btn-sm" onclick="ScheduleModule.confirmDeleteSession(${Safe.js(session.id)})">
              <i class="fas fa-trash-alt"></i> Xóa buổi này
            </button>
          ` : ''}
        </div>
        <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Đóng</button>
      </div>
    `;

    App.openModal("🏸 Chi tiết buổi đặt sân & danh sách", modalBody, true);
  },

  // Admin finalizes a poll option
  async finalizePollOption(sessionId, optionId) {
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    if (!session || !session.options) return;

    const selectedOpt = session.options.find(o => o.id === optionId);
    if (!selectedOpt) return;

    if (!(await App.confirm(`Bạn có chắc chắn muốn chốt lịch theo "${selectedOpt.courtName} (${selectedOpt.startTime} - ${selectedOpt.endTime})"?`))) return;

    session.courtName = selectedOpt.courtName;
    session.courtNumbers = selectedOpt.courtNumbers;
    session.startTime = selectedOpt.startTime;
    session.endTime = selectedOpt.endTime;
    session.date = selectedOpt.date || session.date;
    session.courtPrice = selectedOpt.price || session.courtPrice;
    session.selectedOptionId = optionId;
    session.voteMode = 'standard'; // Converted to confirmed schedule

    // Convert multi votes to standard attendance
    const pollVotes = session.votes || [];
    const newVotes = [];
    pollVotes.forEach(pv => {
      if (pv.selectedOptions && pv.selectedOptions.includes(optionId)) {
        newVotes.push({
          memberId: pv.memberId,
          status: 'going',
          guests: pv.guests || 0,
          note: pv.note || '',
          votedAt: pv.votedAt
        });
      } else if (pv.notGoing) {
        newVotes.push({
          memberId: pv.memberId,
          status: 'not_going',
          guests: 0,
          note: pv.note || 'Báo bận',
          votedAt: pv.votedAt
        });
      }
    });
    session.votes = newVotes;
    if (window.VoteScheduler) VoteScheduler.addNotice(session, 'booked');

    AppStorage.saveData(data);
    App.closeModal();
    App.showToast(`🎉 Đã chốt thành công phương án "${selectedOpt.courtName}" làm lịch thi đấu chính thức!`, "success");
    
    if (this.currentViewMode === 'calendar') {
      this.renderMonthCalendar();
    } else {
      this.renderSessions("sessions-container", this.currentFilter);
    }
  },

  shareSession(sessionId) {
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    if (!session) return;

    let shareText = '';
    const isGuestType = session.sessionType === 'guest';

    if (session.voteMode === 'multi_option') {
      const pollStats = this.calculatePollStats(session);
      const optionsText = (session.options || []).map((o, idx) => `👉 Phương án ${idx + 1}: ${o.courtName} (${o.date} lúc ${o.startTime}-${o.endTime})`).join('\n');

      shareText = `🏸 [${data.clubInfo.shortName}] KHẢO SÁT CHỌN SÂN & KHUNG GIỜ
📌 Buổi: ${session.title} (${isGuestType ? 'Giao lưu vãng lai' : 'Lịch cố định'})
${optionsText}
🎯 Đã có ${pollStats.totalVoters} anh em tham gia bình chọn
⚠️ HẠN CHÓT: Hệ thống tự động khóa bình chọn trước ngày đánh 2 ngày để chốt sân!
👉 Mời mọi người vào ứng dụng vote phương án phù hợp nhé!`;
    } else {
      const going = (session.votes || []).filter(v => v.status === 'going');
      const totalGoing = going.reduce((sum, v) => sum + 1 + (v.guests || 0), 0);

      shareText = `🏸 [${data.clubInfo.shortName}] THÔNG BÁO LỊCH ĐÁNH CẦU LÔNG
📌 Loại hình: ${isGuestType ? 'Giao lưu vãng lai theo ngày' : 'Lịch cố định (trừ quỹ tháng)'}
📅 Ngày: ${session.date} (${session.startTime} - ${session.endTime})
📍 Địa điểm: ${session.courtName} (${session.courtNumbers})
🎯 Sức chứa: Đã có ${totalGoing}/${session.maxPlayers} người đăng ký
🏸 Loại cầu: ${session.shuttleType || 'n/a'}
⚠️ LƯU Ý: Bình chọn sẽ TỰ ĐỘNG KHÓA trước giờ đánh 2 ngày để chốt sân!
👉 Mọi người vui lòng vào ứng dụng để bình chọn đi/nghỉ nhé!`;
    }

    navigator.clipboard.writeText(shareText).then(() => {
      App.showToast("Đã sao chép nội dung thông báo lịch vào Clipboard! Bạn có thể dán vào Zalo / Messenger ngay.", "success");
    }).catch(() => {
      App.showText("Sao chép nội dung bên dưới để gửi nhóm:", shareText);
    });
  },
});
;

// ===== js/modules/schedule-courts.js =====
// ScheduleModule - Địa chỉ sân & bản đồ (tách từ schedule.js; mở rộng ScheduleModule nên `this` dùng như cũ)
Object.assign(ScheduleModule, {
  // Fill default club court address into a target input element
  fillDefaultClubCourtAddress(targetInputId = 'session-court-address') {
    const data = AppStorage.loadData();
    const defaultAddr = (data.clubInfo && data.clubInfo.address) || "50/1 Tân Sơn, Phường 15, Tân Bình, TP. Hồ Chí Minh";
    const input = document.getElementById(targetInputId);
    if (input) {
      input.value = defaultAddr;
      App.showToast("📍 Đã điền địa chỉ sân nhà của CLB!", "info");
    }
  },

  // Quick test Google Maps location search in a new tab
  testMapLocation(addrInputId, nameInputId) {
    const addrInput = document.getElementById(addrInputId);
    const nameInput = document.getElementById(nameInputId);
    const query = (addrInput && addrInput.value.trim()) || (nameInput && nameInput.value.trim()) || "Sân cầu lông";
    const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
    window.open(url, '_blank');
  },

  // Copy court address to clipboard with user toast feedback
  copyAddress(address) {
    if (!address) {
      App.showToast("Không có thông tin địa chỉ để sao chép!", "warning");
      return;
    }
    navigator.clipboard.writeText(address).then(() => {
      App.showToast("📍 Đã sao chép địa chỉ sân vào bộ nhớ tạm!", "success");
    }).catch(() => {
      App.showText("Sao chép địa chỉ sân:", address);
    });
  },

  // Open Court Map Modal Popup
  openCourtMapModal(courtName, courtAddress, mapUrl) {
    const data = AppStorage.loadData();
    const resolvedAddress = courtAddress || (data.clubInfo ? data.clubInfo.address : '') || courtName || 'Sân cầu lông';
    const directMapsUrl = mapUrl || (data.clubInfo && data.clubInfo.mapUrl) || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(resolvedAddress)}`;

    const modalBody = `
      <div style="margin-bottom: 1rem;">
        <div class="font-bold text-main" style="font-size: 1.1rem; margin-bottom: 0.25rem;">
          <i class="fas fa-map-marker-alt text-primary"></i> ${Safe.html(courtName)}
        </div>
        <div class="text-secondary" style="font-size: 0.88rem; display: flex; align-items: flex-start; gap: 0.4rem;">
          <i class="fas fa-location-arrow text-primary" style="margin-top: 0.2rem; font-size: 0.75rem;"></i>
          <span>${Safe.html(resolvedAddress)}</span>
        </div>
      </div>

      <div class="court-map-embed-wrapper" style="height: 320px; margin-bottom: 1.25rem;">
        <iframe 
          width="100%" 
          height="100%" 
          style="border:0;" 
          loading="lazy" 
          allowfullscreen 
          referrerpolicy="no-referrer-when-downgrade"
          src="https://maps.google.com/maps?q=${encodeURIComponent(resolvedAddress)}&t=&z=15&ie=UTF8&iwloc=&output=embed">
        </iframe>
      </div>

      <div class="modal-footer" style="padding: 0; display: flex; justify-content: space-between; align-items: center;">
        <button type="button" class="btn btn-outline-primary btn-sm" onclick="ScheduleModule.copyAddress(${Safe.js(resolvedAddress)})">
          <i class="far fa-copy"></i> Sao chép địa chỉ
        </button>
        <div style="display: flex; gap: 0.5rem;">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Đóng</button>
          <a href="${Safe.url(directMapsUrl)}" target="_blank" rel="noopener noreferrer" class="btn btn-primary">
            <i class="fas fa-directions"></i> Mở Google Maps
          </a>
        </div>
      </div>
    `;

    App.openModal("🗺️ Vị trí sân trên Google Maps", modalBody, true);
  },

  // ==========================================
  // ==========================================
  // EDIT COURT LOCATION, PRICE & SHUTTLE (ENHANCED)
  // ==========================================
  openEditCourtLocationModal(targetId = 'club', optionId = null) {
    if (!AppStorage.can('schedule')) {
      App.showToast("Chỉ Quản trị viên (Admin) mới có quyền chỉnh sửa thông tin sân!", "warning");
      App.showAuthModal('login');
      return;
    }

    const data = AppStorage.loadData();
    let courtName = '';
    let courtNumbers = '';
    let courtPrice = 0;
    let shuttleType = 'n/a';
    let courtAddress = '';
    let mapUrl = '';
    let contextTitle = '';

    if (targetId === 'club') {
      const info = data.clubInfo || {};
      courtName = info.defaultCourt || '';
      courtNumbers = info.courtNumbers || '';
      courtAddress = info.address || '';
      courtPrice = info.defaultCourtPrice || 0;
      shuttleType = 'n/a';
      mapUrl = info.mapUrl || '';
      contextTitle = '🏸 Thông tin Sân nhà mặc định của CLB';
    } else {
      const session = (data.sessions || []).find(s => s.id === targetId);
      if (!session) {
        App.showToast("Không tìm thấy ca đặt sân tương ứng!", "error");
        return;
      }
      if (optionId && session.options) {
        const opt = session.options.find(o => o.id === optionId);
        if (!opt) {
          App.showToast("Không tìm thấy phương án khảo sát tương ứng!", "error");
          return;
        }
        courtName = opt.courtName || '';
        courtNumbers = opt.courtNumbers || '';
        courtPrice = opt.price !== undefined ? opt.price : (session.courtPrice || 0);
        shuttleType = opt.shuttleType || session.shuttleType || 'n/a';
        courtAddress = opt.courtAddress || (data.clubInfo ? data.clubInfo.address : '');
        mapUrl = opt.mapUrl || '';
        contextTitle = `🏸 Thông tin sân: Phương án khảo sát (${session.title})`;
      } else {
        courtName = session.courtName || session.court || '';
        courtNumbers = session.courtNumbers || '';
        courtPrice = session.courtPrice || 0;
        shuttleType = session.shuttleType || 'n/a';
        courtAddress = session.courtAddress || (data.clubInfo ? data.clubInfo.address : '');
        mapUrl = session.mapUrl || '';
        contextTitle = `🏸 Thông tin sân: ${session.title}`;
      }
    }

    const resolvedSearchQuery = courtAddress || courtName || 'San Cau Long';

    const modalBody = `
      <form onsubmit="ScheduleModule.saveCourtLocation(event, ${Safe.js(targetId)}, ${Safe.js(optionId || '')})">
        <div style="background: rgba(16, 185, 129, 0.08); border-left: 3px solid var(--primary); padding: 0.75rem 1rem; border-radius: var(--radius-sm); margin-bottom: 1.25rem;">
          <div class="font-bold text-main" style="font-size: 0.95rem;">${Safe.html(contextTitle)}</div>
          <div class="text-secondary" style="font-size: 0.8rem; margin-top: 0.15rem;">
            Chỉnh sửa tên sân, số sân, tiền sân dự tính, loại cầu sử dụng (mặc định n/a), địa chỉ và bản đồ Google Maps. Thay đổi sẽ tự động đồng bộ lên Database.
          </div>
        </div>

        <div class="responsive-form-row">
          <div class="form-group" style="flex: 1.4;">
            <label class="form-label font-bold"><i class="fas fa-map-marker-alt text-primary"></i> Tên sân cầu lông *</label>
            <input type="text" id="edit-loc-court-name" class="form-control" value="${Safe.html(courtName)}" required placeholder="VD: Sân cầu lông CLB">
          </div>
          <div class="form-group" style="flex: 1;">
            <label class="form-label font-bold"><i class="fas fa-th-large text-primary"></i> Số sân / Ghi chú sân</label>
            <input type="text" id="edit-loc-court-numbers" class="form-control" value="${Safe.html(courtNumbers)}" placeholder="VD: Sân 1 (1 sân)">
          </div>
        </div>

        <div class="responsive-form-row">
          <div class="form-group" style="flex: 1.2;">
            <label class="form-label font-bold"><i class="fas fa-money-bill-wave text-primary"></i> Tiền sân dự tính (VNĐ)</label>
            <input type="number" id="edit-loc-court-price" class="form-control" value="${Safe.html(courtPrice)}" placeholder="180000" step="10000">
          </div>
          <div class="form-group" style="flex: 1.2;">
            <label class="form-label font-bold"><i class="fas fa-feather-alt text-primary"></i> Loại cầu sử dụng</label>
            <input type="text" id="edit-loc-shuttle-type" class="form-control" value="${Safe.html(shuttleType)}" placeholder="n/a">
          </div>
        </div>

        <div class="form-group">
          <div class="flex items-center justify-between" style="margin-bottom: 0.35rem;">
            <label class="form-label font-bold" style="margin-bottom: 0;"><i class="fas fa-location-arrow text-primary"></i> Địa chỉ chi tiết sân *</label>
            <div class="flex gap-2">
              ${targetId !== 'club' ? `
                <button type="button" class="btn btn-outline-primary btn-xs" onclick="ScheduleModule.fillClubAddressInModal()">
                  <i class="fas fa-home"></i> Lấy địa chỉ CLB
                </button>
              ` : ''}
              <button type="button" class="btn btn-outline-secondary btn-xs" onclick="ScheduleModule.updateLiveMapPreview()">
                <i class="fas fa-sync"></i> Cập nhật bản đồ
              </button>
            </div>
          </div>
          <textarea id="edit-loc-address" class="form-control" rows="2" required placeholder="VD: 50/1 Tân Sơn, Phường 15, Quận Tân Bình, TP. Hồ Chí Minh" oninput="ScheduleModule.updateLiveMapPreview()">${Safe.html(courtAddress)}</textarea>
          <span class="text-secondary" style="font-size: 0.75rem; margin-top: 0.25rem; display: block;">
            Khung bản đồ bên dưới sẽ tự động tìm kiếm vị trí vệ tinh theo địa chỉ này.
          </span>
        </div>

        <div class="form-group">
          <div class="flex items-center justify-between" style="margin-bottom: 0.35rem;">
            <label class="form-label font-bold" style="margin-bottom: 0;"><i class="fas fa-link text-primary"></i> Link Google Maps (Tùy chọn)</label>
            <div class="flex gap-2">
              <button type="button" class="btn btn-outline-primary btn-xs" onclick="ScheduleModule.generateMapUrlInModal()">
                <i class="fas fa-magic"></i> Tạo link tự động
              </button>
              <button type="button" class="btn btn-outline-secondary btn-xs" onclick="ScheduleModule.testMapUrlFromModal()">
                <i class="fas fa-external-link-alt"></i> Mở thử Maps
              </button>
            </div>
          </div>
          <input type="url" id="edit-loc-map-url" class="form-control" value="${Safe.html(mapUrl)}" placeholder="https://maps.google.com/?q=...">
          <span class="text-secondary" style="font-size: 0.75rem; margin-top: 0.25rem; display: block;">
            Để trống hệ thống sẽ tự động tạo link mở ứng dụng Google Maps dẫn đường theo địa chỉ sân ở trên.
          </span>
        </div>

        <!-- Live Interactive Map Preview -->
        <div style="margin-top: 1rem;">
          <div class="flex justify-between items-center" style="margin-bottom: 0.35rem;">
            <label class="form-label font-bold" style="margin-bottom: 0;"><i class="fas fa-map text-primary"></i> Khung xem trước bản đồ Google Maps</label>
            <span class="badge badge-neutral" style="font-size: 0.7rem;">Live Preview</span>
          </div>
          <div class="court-map-embed-wrapper" style="height: 180px; border-radius: var(--radius-md); overflow: hidden; border: 1px solid var(--border-color);">
            <iframe 
              id="edit-loc-map-iframe"
              width="100%" 
              height="100%" 
              style="border:0;" 
              loading="lazy" 
              allowfullscreen 
              referrerpolicy="no-referrer-when-downgrade"
              src="https://maps.google.com/maps?q=${encodeURIComponent(resolvedSearchQuery)}&t=&z=15&ie=UTF8&iwloc=&output=embed">
            </iframe>
          </div>
        </div>

        <div class="modal-footer" style="padding: 1.25rem 0 0 0; margin-top: 1.25rem; border-top: 1px solid var(--border-color); display: flex; justify-content: flex-end; gap: 0.5rem;">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Hủy bỏ</button>
          <button type="submit" class="btn btn-primary">
            <i class="fas fa-save"></i> Lưu thông tin sân
          </button>
        </div>
      </form>
    `;

    App.openModal("✏️ Chỉnh sửa thông tin sân & tiền sân dự tính", modalBody, true);
  },

  updateLiveMapPreview() {
    const addrInput = document.getElementById('edit-loc-address');
    const nameInput = document.getElementById('edit-loc-court-name');
    const iframe = document.getElementById('edit-loc-map-iframe');
    if (!iframe) return;

    const query = (addrInput && addrInput.value.trim()) || (nameInput && nameInput.value.trim()) || 'San Cau Long';
    iframe.src = `https://maps.google.com/maps?q=${encodeURIComponent(query)}&t=&z=15&ie=UTF8&iwloc=&output=embed`;
  },

  fillClubAddressInModal() {
    const data = AppStorage.loadData();
    const clubAddr = (data.clubInfo && data.clubInfo.address) || "";
    const clubCourt = (data.clubInfo && data.clubInfo.defaultCourt) || "";
    const addrInput = document.getElementById('edit-loc-address');
    const nameInput = document.getElementById('edit-loc-court-name');
    if (addrInput) addrInput.value = clubAddr;
    if (nameInput && !nameInput.value.trim()) nameInput.value = clubCourt;
    this.updateLiveMapPreview();
    App.showToast("📍 Đã lấy thông tin sân nhà của CLB!", "info");
  },

  generateMapUrlInModal() {
    const addrInput = document.getElementById('edit-loc-address');
    const nameInput = document.getElementById('edit-loc-court-name');
    const mapUrlInput = document.getElementById('edit-loc-map-url');
    const query = (addrInput && addrInput.value.trim()) || (nameInput && nameInput.value.trim()) || 'San Cau Long';
    const generatedUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
    if (mapUrlInput) {
      mapUrlInput.value = generatedUrl;
      App.showToast("🧭 Đã sinh link Google Maps chuẩn!", "success");
    }
  },

  testMapUrlFromModal() {
    const mapUrlInput = document.getElementById('edit-loc-map-url');
    const addrInput = document.getElementById('edit-loc-address');
    const nameInput = document.getElementById('edit-loc-court-name');
    const url = (mapUrlInput && mapUrlInput.value.trim()) || 
      `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((addrInput && addrInput.value.trim()) || (nameInput && nameInput.value.trim()) || 'San Cau Long')}`;
    window.open(url, '_blank');
  },

  saveCourtLocation(e, targetId, optionId) {
    if (e && e.preventDefault) e.preventDefault();
    if (!AppStorage.can('schedule')) {
      App.showToast("Chỉ Quản trị viên (Admin) mới có quyền chỉnh sửa thông tin sân!", "warning");
      return;
    }

    const data = AppStorage.loadData();
    const name = (document.getElementById('edit-loc-court-name')?.value || '').trim();
    const numbers = (document.getElementById('edit-loc-court-numbers')?.value || '').trim();
    const price = parseInt(document.getElementById('edit-loc-court-price')?.value) || 0;
    const shuttle = (document.getElementById('edit-loc-shuttle-type')?.value || '').trim() || 'n/a';
    const address = (document.getElementById('edit-loc-address')?.value || '').trim();
    const mapUrlInput = (document.getElementById('edit-loc-map-url')?.value || '').trim();
    const mapUrl = mapUrlInput || (address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}` : '');

    if (!name) {
      App.showToast("Vui lòng nhập tên sân cầu lông!", "warning");
      return;
    }

    if (targetId === 'club') {
      if (!data.clubInfo) data.clubInfo = {};
      data.clubInfo.defaultCourt = name;
      data.clubInfo.address = address;
      data.clubInfo.mapUrl = mapUrl;
      data.clubInfo.defaultCourtPrice = price;
      if (numbers) data.clubInfo.courtNumbers = numbers;

      AppStorage.saveData(data, true);
      App.closeModal();

      // Cập nhật form cài đặt nếu đang mở
      const setCourt = document.getElementById('set-court-default');
      const setAddr = document.getElementById('set-court-address');
      const setMap = document.getElementById('set-court-map-url');
      if (setCourt) setCourt.value = name;
      if (setAddr) setAddr.value = address;
      if (setMap) setMap.value = mapUrl;

      if (window.App && typeof App.refreshDashboardStats === 'function') App.refreshDashboardStats();
      App.showToast("🎉 Đã cập nhật và lưu thông tin Sân nhà CLB thành công!", "success");
    } else {
      const session = (data.sessions || []).find(s => s.id === targetId);
      if (!session) {
        App.showToast("Không tìm thấy ca đặt sân để lưu!", "error");
        return;
      }

      if (optionId && session.options) {
        const opt = session.options.find(o => o.id === optionId);
        if (opt) {
          opt.courtName = name;
          opt.courtNumbers = numbers;
          opt.price = price;
          opt.shuttleType = shuttle;
          opt.courtAddress = address;
          opt.mapUrl = mapUrl;
        }
      } else {
        session.courtName = name;
        session.court = name;
        session.courtNumbers = numbers;
        session.courtPrice = price;
        session.shuttleType = shuttle;
        session.courtAddress = address;
        session.mapUrl = mapUrl;
      }

      AppStorage.saveData(data, true);
      App.closeModal();

      // Làm mới lại giao diện
      if (this.currentViewMode === 'calendar') {
        this.renderMonthCalendar();
      } else {
        this.renderSessions('sessions-container', this.currentFilter || 'upcoming');
      }
      this.renderSessions('schedule-upcoming-list', this.currentFilter || 'upcoming');
      if (window.App && typeof App.refreshDashboardStats === 'function') App.refreshDashboardStats();

      // Mở lại modal chi tiết của ca đánh vừa sửa để người dùng thấy ngay kết quả
      this.openSessionDetailsModal(targetId);
      App.showToast("🎉 Đã cập nhật thông tin sân, tiền sân và loại cầu thành công!", "success");
    }
  },
});
;

// ===== js/modules/schedule-form.js =====
// ScheduleModule - Biểu mẫu đặt lịch, đổi giờ, đổi trạng thái, xóa buổi (tách từ schedule.js; mở rộng ScheduleModule nên `this` dùng như cũ)
Object.assign(ScheduleModule, {
  // ==========================================
  // ADD SESSION / CREATE POLL MODAL (SECURE ADMIN ACCESS)
  // ==========================================
  // Ô "Mở bình chọn" trong form tạo buổi: mặc định theo cài đặt CLB (tự mở trước N ngày)
  initVoteOpenField() {
    const info = (AppStorage.loadData().clubInfo) || {};
    const mode = document.getElementById('session-vote-open-mode');
    if (!mode || !window.VoteScheduler) return;
    if (info.autoVoteOpen && info.autoVoteOpen.enabled) mode.value = 'scheduled';
    this.onVoteOpenModeChange();
    ['session-date', 'session-start'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => this.onVoteOpenModeChange(true));
    });
    const hint = document.getElementById('session-vote-open-rule');
    if (hint) hint.textContent = 'Quy tắc của CLB: ' + VoteScheduler.describeRule(info);
  },

  onVoteOpenModeChange(dateChanged = false) {
    const mode = document.getElementById('session-vote-open-mode');
    const input = document.getElementById('session-vote-open-at');
    if (!mode || !input) return;
    const scheduled = mode.value === 'scheduled';
    input.style.display = scheduled ? 'block' : 'none';
    input.required = scheduled;
    if (scheduled && (!input.value || dateChanged)) {
      const info = (AppStorage.loadData().clubInfo) || {};
      const dateVal = document.getElementById('session-date')?.value || '';
      const cfg = Object.assign({ mode: 'daysBefore', daysBefore: 5, time: '08:00' }, info.autoVoteOpen || {}, { enabled: true });
      const startVal = document.getElementById('session-start')?.value || '';
      input.value = VoteScheduler.defaultOpenAt(dateVal, { autoVoteOpen: cfg }, startVal) || VoteScheduler.toLocalInput(Date.now() + 60 * 60 * 1000);
    }
  },

  openAddSessionModal() {
    if (!AppStorage.can('schedule')) {
      App.showToast("Chức năng Tạo lịch đặt sân chỉ dành cho Quản trị viên. Vui lòng đăng nhập!", "warning");
      App.showAuthModal('login');
      return;
    }

    const data = AppStorage.loadData();
    const info = data.clubInfo || {};
    this.pollOptionCount = 2;
    
    const nextDate = new Date();
    nextDate.setDate(nextDate.getDate() + 3);
    const defaultDateStr = nextDate.toISOString().slice(0, 10);

    const modalBody = `
      <form id="form-add-session" onsubmit="ScheduleModule.saveNewSession(event); return false;">
        <!-- 1. Session Type Selector (Cố định vs Vãng lai) -->
        <div class="form-group">
          <label class="form-label" style="font-weight: 700;"><i class="fas fa-tag text-primary"></i> 1. Loại hình buổi đặt sân:</label>
          <div class="segmented-control">
            <button type="button" class="segmented-btn active" id="btn-type-fixed" onclick="ScheduleModule.toggleSessionTypeForm('fixed')">
              <i class="fas fa-calendar-check"></i> 🏸 Cố định (Trừ quỹ tháng)
            </button>
            <button type="button" class="segmented-btn" id="btn-type-guest" onclick="ScheduleModule.toggleSessionTypeForm('guest')">
              <i class="fas fa-bolt"></i> ⚡ Vãng lai (Theo ngày tùy chọn)
            </button>
          </div>
          <input type="hidden" id="session-type-input" value="fixed">
        </div>

        <!-- 2. Vote Mode Selector (Chốt sân/giờ vs Khảo sát nhiều phương án) -->
        <div class="form-group">
          <label class="form-label" style="font-weight: 700;"><i class="fas fa-sliders-h text-primary"></i> 2. Hình thức bình chọn:</label>
          <div class="segmented-control">
            <button type="button" class="segmented-btn active" id="btn-mode-standard" onclick="ScheduleModule.toggleVoteModeForm('standard')">
              <i class="fas fa-map-marker-alt"></i> 📍 Đã chốt sân & giờ
            </button>
            <button type="button" class="segmented-btn" id="btn-mode-multi" onclick="ScheduleModule.toggleVoteModeForm('multi_option')">
              <i class="fas fa-poll"></i> 🗳️ Khảo sát chọn sân / giờ
            </button>
          </div>
          <input type="hidden" id="vote-mode-input" value="standard">
        </div>

        <div class="form-group">
          <label class="form-label">Tiêu đề buổi đánh / khảo sát *</label>
          <input type="text" id="session-title" class="form-control" required placeholder="VD: Giao lưu cầu lông thứ 7 sôi động" value="">
        </div>

        <!-- FORM CONTAINER A: STANDARD SINGLE-SCHEDULE FORM -->
        <div id="standard-schedule-fields">
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
            <div class="form-group">
              <label class="form-label">Ngày đánh *</label>
              <input type="date" id="session-date" class="form-control" value="${defaultDateStr}">
            </div>
            <div class="form-group">
              <label class="form-label">Khung giờ *</label>
              <div style="display: flex; gap: 0.5rem; align-items: center;">
                <input type="time" id="session-start" class="form-control" value="18:00">
                <span>-</span>
                <input type="time" id="session-end" class="form-control" value="20:00">
              </div>
            </div>
          </div>

          <div style="display: grid; grid-template-columns: 1.5fr 1fr; gap: 1rem;">
            <div class="form-group">
              <label class="form-label">Địa điểm sân *</label>
              <input type="text" id="session-court-name" class="form-control" placeholder="VD: Sân cầu lông CLB" value="${Safe.html(info.defaultCourt || '')}">
            </div>
            <div class="form-group">
              <label class="form-label">Số sân đặt</label>
              <input type="text" id="session-court-numbers" class="form-control" placeholder="VD: Sân 1 & 2 (2 sân)" value="">
            </div>
          </div>

          <!-- Court Address & Map Link -->
          <div class="form-group">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.35rem;">
              <label class="form-label" style="margin-bottom: 0;"><i class="fas fa-map-marker-alt text-primary"></i> Địa chỉ sân cụ thể (Gắn bản đồ):</label>
              <button type="button" class="btn btn-text btn-sm" style="color: var(--primary); padding: 0; font-size: 0.8rem;" onclick="ScheduleModule.fillDefaultClubCourtAddress('session-court-address')">
                <i class="fas fa-home"></i> Lấy địa chỉ CLB
              </button>
            </div>
            <div style="display: flex; gap: 0.5rem;">
              <input type="text" id="session-court-address" class="form-control" placeholder="VD: 50/1 Tân Sơn, Phường 15, Tân Bình, TP.HCM" value="${Safe.html(info.address || '')}">
              <button type="button" class="btn btn-secondary btn-sm" onclick="ScheduleModule.testMapLocation('session-court-address', 'session-court-name')" title="Kiểm tra mở Google Maps thử nghiệm">
                <i class="fas fa-map-marked-alt"></i> Thử Maps
              </button>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label"><i class="fas fa-link text-primary"></i> Link Google Maps tùy chỉnh (tùy chọn):</label>
            <input type="url" id="session-map-url" class="form-control" placeholder="https://maps.app.goo.gl/... hoặc để trống tự sinh" value="${Safe.html(info.mapUrl || '')}">
            <div class="text-secondary" style="font-size: 0.76rem; margin-top: 0.25rem;">
              <i class="fas fa-info-circle"></i> Nếu để trống, hệ thống sẽ tự động hiển thị bản đồ trực tiếp và dẫn đường theo địa chỉ sân trên Google Maps.
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">Tiền sân dự tính (VNĐ)</label>
            <input type="number" id="session-court-price" class="form-control" placeholder="300000" value="" step="10000">
          </div>
        </div>

        <!-- FORM CONTAINER B: MULTI-OPTION POLL BUILDER -->
        <div id="multi-option-poll-fields" style="display: none;">
          <div style="background: rgba(6, 182, 212, 0.08); border: 1px dashed var(--secondary); padding: 0.85rem; border-radius: var(--radius-md); margin-bottom: 1rem; font-size: 0.85rem;">
            <i class="fas fa-info-circle text-primary"></i> Bạn có thể tạo 2 hoặc nhiều phương án sân, địa chỉ và khung giờ khác nhau để anh em trong CLB cùng bình chọn phương án tối ưu nhất!
          </div>

          <div id="poll-options-builder-list">
            <!-- Option 1 -->
            <div class="option-builder-card" id="opt-builder-row-1">
              <div class="option-builder-header">
                <strong><i class="fas fa-check text-primary"></i> Phương án 1 (Option A)</strong>
              </div>
              <div style="display: grid; grid-template-columns: 1.5fr 1fr; gap: 0.75rem;">
                <div class="form-group" style="margin-bottom:0.5rem;">
                  <label class="form-label" style="font-size:0.8rem;">Địa điểm sân:</label>
                  <input type="text" class="form-control opt-court-input" value="${Safe.html(info.defaultCourt || '')}" placeholder="Tên sân 1">
                </div>
                <div class="form-group" style="margin-bottom:0.5rem;">
                  <label class="form-label" style="font-size:0.8rem;">Số sân:</label>
                  <input type="text" class="form-control opt-numbers-input" placeholder="VD: Sân 1 & 2" value="">
                </div>
              </div>
              <div class="form-group" style="margin-bottom:0.5rem;">
                <label class="form-label" style="font-size:0.8rem;"><i class="fas fa-map-marker-alt text-primary"></i> Địa chỉ sân & Link Maps (tùy chọn):</label>
                <div style="display: grid; grid-template-columns: 1.2fr 1fr; gap: 0.5rem;">
                  <input type="text" class="form-control opt-address-input" placeholder="Địa chỉ chi tiết (VD: 50/1 Tân Sơn, Tân Bình)" value="${Safe.html(info.address || '')}">
                  <input type="url" class="form-control opt-map-input" placeholder="Link Google Maps (nếu có)" value="${Safe.html(info.mapUrl || '')}">
                </div>
              </div>
              <div style="display: grid; grid-template-columns: 1fr 1.2fr 1fr; gap: 0.75rem;">
                <div class="form-group" style="margin-bottom:0.5rem;">
                  <label class="form-label" style="font-size:0.8rem;">Ngày:</label>
                  <input type="date" class="form-control opt-date-input" id="opt-date-1" value="${defaultDateStr}">
                </div>
                <div class="form-group" style="margin-bottom:0.5rem;">
                  <label class="form-label" style="font-size:0.8rem;">Khung giờ:</label>
                  <div style="display: flex; gap: 0.25rem; align-items: center;">
                    <input type="time" class="form-control opt-start-input" value="18:00">
                    <span>-</span>
                    <input type="time" class="form-control opt-end-input" value="20:00">
                  </div>
                </div>
                <div class="form-group" style="margin-bottom:0.5rem;">
                  <label class="form-label" style="font-size:0.8rem;">Tiền sân (đ):</label>
                  <input type="number" class="form-control opt-price-input" placeholder="300000" value="" step="10000">
                </div>
              </div>
            </div>

            <!-- Option 2 -->
            <div class="option-builder-card" id="opt-builder-row-2">
              <div class="option-builder-header">
                <strong><i class="fas fa-check text-primary"></i> Phương án 2 (Option B)</strong>
              </div>
              <div style="display: grid; grid-template-columns: 1.5fr 1fr; gap: 0.75rem;">
                <div class="form-group" style="margin-bottom:0.5rem;">
                  <label class="form-label" style="font-size:0.8rem;">Địa điểm sân:</label>
                  <input type="text" class="form-control opt-court-input" value="" placeholder="Tên sân 2">
                </div>
                <div class="form-group" style="margin-bottom:0.5rem;">
                  <label class="form-label" style="font-size:0.8rem;">Số sân:</label>
                  <input type="text" class="form-control opt-numbers-input" placeholder="VD: Sân 3 & 4" value="">
                </div>
              </div>
              <div class="form-group" style="margin-bottom:0.5rem;">
                <label class="form-label" style="font-size:0.8rem;"><i class="fas fa-map-marker-alt text-primary"></i> Địa chỉ sân & Link Maps (tùy chọn):</label>
                <div style="display: grid; grid-template-columns: 1.2fr 1fr; gap: 0.5rem;">
                  <input type="text" class="form-control opt-address-input" placeholder="Địa chỉ chi tiết (VD: 158 Hoàng Hoa Thám, Tân Bình)" value="">
                  <input type="url" class="form-control opt-map-input" placeholder="Link Google Maps (nếu có)" value="">
                </div>
              </div>
              <div style="display: grid; grid-template-columns: 1fr 1.2fr 1fr; gap: 0.75rem;">
                <div class="form-group" style="margin-bottom:0.5rem;">
                  <label class="form-label" style="font-size:0.8rem;">Ngày:</label>
                  <input type="date" class="form-control opt-date-input" id="opt-date-2" value="${defaultDateStr}">
                </div>
                <div class="form-group" style="margin-bottom:0.5rem;">
                  <label class="form-label" style="font-size:0.8rem;">Khung giờ:</label>
                  <div style="display: flex; gap: 0.25rem; align-items: center;">
                    <input type="time" class="form-control opt-start-input" value="18:00">
                    <span>-</span>
                    <input type="time" class="form-control opt-end-input" value="20:00">
                  </div>
                </div>
                <div class="form-group" style="margin-bottom:0.5rem;">
                  <label class="form-label" style="font-size:0.8rem;">Tiền sân (đ):</label>
                  <input type="number" class="form-control opt-price-input" placeholder="300000" value="" step="10000">
                </div>
              </div>
            </div>
          </div>

          <button type="button" class="btn btn-outline-primary btn-sm w-full" style="margin-bottom: 1rem;" onclick="ScheduleModule.addPollOptionField()">
            <i class="fas fa-plus"></i> Thêm phương án khảo sát khác
          </button>
        </div>

        <!-- Common Session Parameters -->
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
          <div class="form-group">
            <label class="form-label">Số người tối đa (Slots)</label>
            <input type="number" id="session-max-players" class="form-control" value="12" min="4" max="30">
          </div>
          <div class="form-group">
            <label class="form-label">Loại cầu sử dụng</label>
            <input type="text" id="session-shuttle" class="form-control" placeholder="VD: n/a hoặc Hải Yến Đỏ Pro" value="n/a">
          </div>
        </div>

        <div class="form-group" style="background: var(--bg-input); padding: 0.85rem 1rem; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
          <label class="form-label"><i class="fas fa-stopwatch text-primary"></i> Mở bình chọn</label>
          <select id="session-vote-open-mode" class="form-select" onchange="ScheduleModule.onVoteOpenModeChange()">
            <option value="now">Mở ngay khi lưu</option>
            <option value="scheduled">Hẹn giờ tự động mở</option>
          </select>
          <input type="datetime-local" id="session-vote-open-at" class="form-control" style="margin-top: 0.5rem; display: none;">
          ${window.VoteScheduler ? VoteScheduler.renderEmailCheckbox('session-email-notify', null, AppStorage.loadData().clubInfo) : ''}
          <span class="text-secondary" style="font-size: 0.75rem; margin-top: 0.35rem; display: block;">
            Đến giờ hẹn, bình chọn tự mở và thành viên nhận thông báo. <span id="session-vote-open-rule"></span>
          </span>
        </div>

        <div class="form-group">
          <label class="form-label">Ghi chú cho thành viên</label>
          <textarea id="session-note" class="form-control" placeholder="Khởi động trước 10 phút, tự mang nước hoặc uống nước CLB..."></textarea>
        </div>

        <div class="modal-footer" style="padding: 1rem 0 0 0;">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Hủy</button>
          <button type="submit" class="btn btn-primary"><i class="fas fa-check"></i> Lưu & mở bình chọn</button>
        </div>
      </form>
    `;

    App.openModal("🏸 Đặt lịch / Mở bình chọn mới", modalBody, true);
    this.initVoteOpenField();
  },

  toggleSessionTypeForm(type) {
    document.getElementById('session-type-input').value = type;
    document.getElementById('btn-type-fixed').className = `segmented-btn ${type === 'fixed' ? 'active' : ''}`;
    document.getElementById('btn-type-guest').className = `segmented-btn ${type === 'guest' ? 'active' : ''}`;
  },

  toggleVoteModeForm(mode) {
    document.getElementById('vote-mode-input').value = mode;
    document.getElementById('btn-mode-standard').className = `segmented-btn ${mode === 'standard' ? 'active' : ''}`;
    document.getElementById('btn-mode-multi').className = `segmented-btn ${mode === 'multi_option' ? 'active' : ''}`;

    const stdFields = document.getElementById('standard-schedule-fields');
    const multiFields = document.getElementById('multi-option-poll-fields');

    if (mode === 'standard') {
      if (stdFields) stdFields.style.display = 'block';
      if (multiFields) multiFields.style.display = 'none';
    } else {
      if (stdFields) stdFields.style.display = 'none';
      if (multiFields) multiFields.style.display = 'block';
    }
  },

  addPollOptionField() {
    this.pollOptionCount++;
    const count = this.pollOptionCount;
    const container = document.getElementById('poll-options-builder-list');
    if (!container) return;

    const row = document.createElement('div');
    row.className = 'option-builder-card';
    row.id = `opt-builder-row-${count}`;
    row.innerHTML = `
      <div class="option-builder-header">
        <strong><i class="fas fa-check text-primary"></i> Phương án ${count}</strong>
        <button type="button" style="background:none; border:none; color:var(--danger); cursor:pointer; font-size:0.85rem;" onclick="this.closest('.option-builder-card').remove()">
          <i class="fas fa-trash"></i> Xóa
        </button>
      </div>
      <div style="display: grid; grid-template-columns: 1.5fr 1fr; gap: 0.75rem;">
        <div class="form-group" style="margin-bottom:0.5rem;">
          <label class="form-label" style="font-size:0.8rem;">Địa điểm sân:</label>
          <input type="text" class="form-control opt-court-input" placeholder="Tên sân ${count}" value="">
        </div>
        <div class="form-group" style="margin-bottom:0.5rem;">
          <label class="form-label" style="font-size:0.8rem;">Số sân:</label>
          <input type="text" class="form-control opt-numbers-input" placeholder="VD: Sân 1 & 2" value="">
        </div>
      </div>
      <div class="form-group" style="margin-bottom:0.5rem;">
        <label class="form-label" style="font-size:0.8rem;"><i class="fas fa-map-marker-alt text-primary"></i> Địa chỉ sân & Link Maps (tùy chọn):</label>
        <div style="display: grid; grid-template-columns: 1.2fr 1fr; gap: 0.5rem;">
          <input type="text" class="form-control opt-address-input" placeholder="Địa chỉ chi tiết (VD: 238 Ba Tháng Hai, Q.10)" value="">
          <input type="url" class="form-control opt-map-input" placeholder="Link Google Maps (nếu có)" value="">
        </div>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1.2fr 1fr; gap: 0.75rem;">
        <div class="form-group" style="margin-bottom:0.5rem;">
          <label class="form-label" style="font-size:0.8rem;">Ngày:</label>
          <input type="date" class="form-control opt-date-input" value="${new Date().toISOString().slice(0,10)}">
        </div>
        <div class="form-group" style="margin-bottom:0.5rem;">
          <label class="form-label" style="font-size:0.8rem;">Khung giờ:</label>
          <div style="display: flex; gap: 0.25rem; align-items: center;">
            <input type="time" class="form-control opt-start-input" value="18:00">
            <span>-</span>
            <input type="time" class="form-control opt-end-input" value="20:00">
          </div>
        </div>
        <div class="form-group" style="margin-bottom:0.5rem;">
          <label class="form-label" style="font-size:0.8rem;">Tiền sân (đ):</label>
          <input type="number" class="form-control opt-price-input" placeholder="300000" value="" step="10000">
        </div>
      </div>
    `;
    container.appendChild(row);
  },

  // ==========================================
  // EDIT SESSION DATE & TIME (ADMIN)
  // ==========================================
  openEditSessionTimeModal(sessionId) {
    if (!AppStorage.can('schedule')) {
      App.showToast("Chỉ Quản trị viên (Admin) mới có quyền chỉnh sửa giờ đánh!", "warning");
      return;
    }

    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    if (!session) {
      App.showToast("Không tìm thấy ca đặt sân tương ứng!", "error");
      return;
    }

    // Chuẩn hóa ngày về YYYY-MM-DD cho input type="date"
    const d = this.parseSessionDateTime(session.date, session.startTime);
    const dateVal = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const modalBody = `
      <form onsubmit="ScheduleModule.saveSessionTime(event, ${Safe.js(session.id)})">
        <div style="background: rgba(16, 185, 129, 0.08); border-left: 3px solid var(--primary); padding: 0.75rem 1rem; border-radius: var(--radius-sm); margin-bottom: 1.25rem;">
          <div class="font-bold text-main" style="font-size: 0.95rem;">🕒 ${Safe.html(session.title)}</div>
          <div class="text-secondary" style="font-size: 0.8rem; margin-top: 0.15rem;">
            Hiện tại: ${Safe.html(session.date)} • ${Safe.html(session.startTime)} - ${Safe.html(session.endTime)}. Danh sách bình chọn được giữ nguyên; hạn khóa vote sẽ tính lại theo giờ mới.
          </div>
        </div>

        <div class="form-group">
          <label class="form-label font-bold"><i class="far fa-calendar-alt text-primary"></i> Ngày đánh *</label>
          <input type="date" id="edit-time-date" class="form-control" value="${dateVal}" required>
        </div>

        <div class="form-group">
          <label class="form-label font-bold"><i class="far fa-clock text-primary"></i> Khung giờ *</label>
          <div style="display: flex; gap: 0.5rem; align-items: center;">
            <input type="time" id="edit-time-start" class="form-control" value="${Safe.html(session.startTime || '18:00')}" required>
            <span>-</span>
            <input type="time" id="edit-time-end" class="form-control" value="${Safe.html(session.endTime || '20:00')}" required>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Lý do thay đổi (tùy chọn)</label>
          <input type="text" id="edit-time-reason" class="form-control" placeholder="VD: Sân báo đổi giờ">
        </div>

        <div style="display: flex; gap: 0.5rem; justify-content: flex-end;">
          <button type="button" class="btn btn-secondary" onclick="ScheduleModule.openSessionDetailsModal(${Safe.js(session.id)})">Hủy</button>
          <button type="submit" class="btn btn-primary"><i class="fas fa-save"></i> Lưu giờ mới</button>
        </div>
      </form>
    `;

    App.openModal("🕒 Chỉnh sửa ngày & giờ đánh", modalBody, true);
  },

  saveSessionTime(e, sessionId) {
    if (e && e.preventDefault) e.preventDefault();
    if (!AppStorage.can('schedule')) {
      App.showToast("Chỉ Quản trị viên (Admin) mới có quyền chỉnh sửa giờ đánh!", "warning");
      return;
    }

    const date = document.getElementById('edit-time-date')?.value;
    const startTime = document.getElementById('edit-time-start')?.value;
    const endTime = document.getElementById('edit-time-end')?.value;
    const reason = (document.getElementById('edit-time-reason')?.value || '').trim();

    if (!date || !startTime || !endTime) {
      App.showToast("Vui lòng nhập đủ ngày, giờ bắt đầu và giờ kết thúc!", "warning");
      return;
    }
    if (endTime <= startTime) {
      App.showToast("Giờ kết thúc phải sau giờ bắt đầu!", "warning");
      return;
    }

    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    if (!session) {
      App.showToast("Không tìm thấy ca đặt sân để lưu!", "error");
      return;
    }

    if (session.date === date && session.startTime === startTime && session.endTime === endTime) {
      App.showToast("Ngày giờ không thay đổi.", "info");
      this.openSessionDetailsModal(sessionId);
      return;
    }

    const currentUser = data.currentUser || AppStorage.getCurrentUser();
    if (!Array.isArray(session.timeChangeHistory)) session.timeChangeHistory = [];
    session.timeChangeHistory.push({
      from: { date: session.date, startTime: session.startTime, endTime: session.endTime },
      to: { date, startTime, endTime },
      reason,
      changedBy: (currentUser && currentUser.name) || 'Admin',
      changedAt: new Date().toISOString()
    });

    session.date = date;
    session.startTime = startTime;
    session.endTime = endTime;

    // Giữ phương án đã chốt (khảo sát) khớp với giờ mới
    if (session.selectedOptionId && Array.isArray(session.options)) {
      const opt = session.options.find(o => o.id === session.selectedOptionId);
      if (opt) {
        opt.date = date;
        opt.startTime = startTime;
        opt.endTime = endTime;
      }
    }

    AppStorage.saveData(data, true);

    const parts = date.split('-');
    this.calYear = parseInt(parts[0]);
    this.calMonth = parseInt(parts[1]) - 1;
    if (this.currentViewMode === 'calendar') {
      this.renderMonthCalendar();
    } else {
      this.renderSessions('sessions-container', this.currentFilter || 'upcoming');
    }
    this.renderSessions('schedule-upcoming-list', this.currentFilter || 'upcoming');
    this.renderSessions('dashboard-sessions-preview', 'upcoming');
    this.updateScheduleOverviewStats(data.sessions);
    if (window.App && typeof App.refreshDashboardStats === 'function') App.refreshDashboardStats();

    this.openSessionDetailsModal(sessionId);
    App.showToast(`🎉 Đã đổi giờ đánh sang ${date} (${startTime} - ${endTime})!`, "success");
  },

  saveNewSession(e) {
    if (e && e.preventDefault) e.preventDefault();
    try {
      const data = AppStorage.loadData();
      if (!data.sessions) data.sessions = [];

      const sessionType = document.getElementById('session-type-input')?.value || 'fixed';
      const voteMode = document.getElementById('vote-mode-input')?.value || 'standard';
      const title = (document.getElementById("session-title")?.value || "").trim() || "Giao lưu cầu lông";
      const maxPlayers = parseInt(document.getElementById("session-max-players")?.value) || 12;
      const shuttleType = (document.getElementById("session-shuttle")?.value || "").trim() || 'n/a';
      const note = (document.getElementById("session-note")?.value || "").trim();

      if (!AppStorage.can('schedule')) {
        App.showToast("Chỉ Ban Quản Trị / Admin mới có quyền tạo và lưu lịch đặt sân. Vui lòng đăng nhập!", "warning");
        App.showAuthModal('login');
        return;
      }

      const currentUser = data.currentUser || AppStorage.getCurrentUser();
      const currentUserId = (currentUser && (currentUser.id || currentUser.memberId)) || '';

      let newSession = {
        id: "ses_" + Date.now(),
        title,
        sessionType,
        voteMode,
        maxPlayers,
        shuttleType,
        note,
        status: "open",
        openedBy: (currentUser && currentUser.username) || ''
      };

      if (voteMode === 'multi_option') {
        const optionRows = document.querySelectorAll('.option-builder-card');
        const options = [];
        let defaultDate = new Date().toISOString().slice(0, 10);
        let defaultStart = "18:00";
        let defaultEnd = "20:00";
        let defaultCourtName = "Đang khảo sát phương án";
        let defaultCourtAddress = (data.clubInfo && data.clubInfo.address) || "";
        let defaultMapUrl = (data.clubInfo && data.clubInfo.mapUrl) || "";

        optionRows.forEach((row, idx) => {
          const courtName = row.querySelector('.opt-court-input')?.value.trim() || `Sân ${idx + 1}`;
          const courtNumbers = row.querySelector('.opt-numbers-input')?.value.trim() || 'Sân 1 & 2';
          const courtAddress = row.querySelector('.opt-address-input')?.value.trim() || defaultCourtAddress;
          const mapUrl = row.querySelector('.opt-map-input')?.value.trim() || defaultMapUrl;
          const date = row.querySelector('.opt-date-input')?.value || defaultDate;
          const startTime = row.querySelector('.opt-start-input')?.value || '18:00';
          const endTime = row.querySelector('.opt-end-input')?.value || '20:00';
          const price = parseInt(row.querySelector('.opt-price-input')?.value) || 0;

          if (idx === 0) {
            defaultDate = date;
            defaultStart = startTime;
            defaultEnd = endTime;
            defaultCourtName = courtName;
            defaultCourtAddress = courtAddress;
            defaultMapUrl = mapUrl;
          }

          options.push({
            id: `opt_${Date.now()}_${idx + 1}`,
            courtName,
            courtNumbers,
            courtAddress,
            mapUrl,
            date,
            startTime,
            endTime,
            price
          });
        });

        newSession.date = defaultDate;
        newSession.startTime = defaultStart;
        newSession.endTime = defaultEnd;
        newSession.courtName = "Đang khảo sát phương án";
        newSession.courtNumbers = "Đa sân";
        newSession.courtAddress = defaultCourtAddress;
        newSession.mapUrl = defaultMapUrl;
        newSession.courtPrice = options[0] ? options[0].price : 0;
        newSession.options = options;
        newSession.selectedOptionId = null;
        newSession.votes = [];
        const currentMember = (data.members || []).find(m => 
          (currentUser && currentUser.memberId && m.id === currentUser.memberId) ||
          (currentUser && m.id === currentUser.id) ||
          (currentUser && currentUser.username && m.username === currentUser.username)
        );
        const creatorMemberId = currentMember ? currentMember.id : (currentUser ? (currentUser.memberId || currentUser.id) : '');
        if (creatorMemberId) {
          newSession.votes.push({
            memberId: creatorMemberId,
            selectedOptions: options[0] ? [options[0].id] : [],
            notGoing: false,
            guests: 0,
            votedAt: new Date().toISOString().slice(0, 16).replace('T', ' ')
          });
        }
      } else {
        const dateVal = document.getElementById("session-date")?.value;
        const startVal = document.getElementById("session-start")?.value || "18:00";
        const endVal = document.getElementById("session-end")?.value || "20:00";
        const courtNameVal = (document.getElementById("session-court-name")?.value || "").trim() || (data.clubInfo ? data.clubInfo.defaultCourt : "");
        const courtNumbersVal = (document.getElementById("session-court-numbers")?.value || "").trim() || "";
        const courtAddressVal = (document.getElementById("session-court-address")?.value || "").trim() || (data.clubInfo ? data.clubInfo.address : "");
        const mapUrlVal = (document.getElementById("session-map-url")?.value || "").trim() || (data.clubInfo ? data.clubInfo.mapUrl : "");
        const courtPriceVal = parseInt(document.getElementById("session-court-price")?.value) || 0;

        newSession.date = dateVal || new Date().toISOString().slice(0, 10);
        newSession.startTime = startVal;
        newSession.endTime = endVal;
        newSession.courtName = courtNameVal;
        newSession.courtNumbers = courtNumbersVal;
        newSession.courtAddress = courtAddressVal;
        newSession.mapUrl = mapUrlVal;
        newSession.courtPrice = courtPriceVal;
        newSession.votes = [];
        const currentMember = (data.members || []).find(m => 
          (currentUser && currentUser.memberId && m.id === currentUser.memberId) ||
          (currentUser && m.id === currentUser.id) ||
          (currentUser && currentUser.username && m.username === currentUser.username)
        );
        const creatorMemberId = currentMember ? currentMember.id : (currentUser ? (currentUser.memberId || currentUser.id) : '');
        if (creatorMemberId) {
          newSession.votes.push({
            memberId: creatorMemberId,
            status: "going",
            guests: 0,
            votedAt: new Date().toISOString().slice(0, 16).replace('T', ' ')
          });
        }
      }

      if (newSession.date) {
        const parts = newSession.date.split('-');
        if (parts.length === 3) {
          this.calYear = parseInt(parts[0]);
          this.calMonth = parseInt(parts[1]) - 1;
        }
      }

      const emailChoice = window.VoteScheduler ? VoteScheduler.readEmailCheckbox('session-email-notify') : null;
      if (emailChoice === false) newSession.emailNotify = false;
      const openMode = document.getElementById('session-vote-open-mode')?.value || 'now';
      const openAt = document.getElementById('session-vote-open-at')?.value || '';
      if (openMode === 'scheduled' && window.VoteScheduler) {
        const openMs = VoteScheduler.parseLocal(openAt);
        const startMs = VoteScheduler.parseLocal(`${newSession.date}T${newSession.startTime || '18:00'}`);
        if (isNaN(openMs) || (!isNaN(startMs) && openMs >= startMs)) {
          App.showToast("Giờ mở bình chọn phải hợp lệ và trước giờ bắt đầu buổi đánh!", "warning");
          return;
        }
        newSession.voteOpenAt = openAt;
      } else if (window.VoteScheduler) {
        newSession.voteOpenAt = '';
        VoteScheduler.addNotice(newSession, 'vote_open');
      }

      data.sessions.unshift(newSession);
      AppStorage.saveData(data);
      App.closeModal();
      App.showToast(newSession.voteOpenAt
        ? `⏰ Đã tạo lịch, bình chọn tự mở lúc ${VoteScheduler.formatLabel(newSession.voteOpenAt)}`
        : `🎉 Đã tạo ${voteMode === 'multi_option' ? 'khảo sát chọn sân & giờ' : 'lịch đặt sân'} và thông báo mở bình chọn!`, "success");
      
      this.renderMonthCalendar();
      this.renderSessions("sessions-container", "upcoming");
      this.renderSessions("schedule-upcoming-list", "upcoming");
      this.renderSessions("dashboard-sessions-preview", "upcoming");
      App.refreshDashboardStats();
    } catch (err) {
      console.error("Lỗi khi lưu lịch đặt sân:", err);
      App.showToast("Không thể lưu lịch đặt sân: " + err.message, "error");
    }
  },

  // ==========================================
  // DELETE SESSION / POLL (ADMIN WITH SMART AUTH)
  // ==========================================
  confirmDeleteSession(sessionId) {
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    if (!session) {
      App.showToast("Không tìm thấy thông tin buổi đặt sân!", "error");
      return;
    }

    const isMultiPoll = session.voteMode === 'multi_option';
    const isGuestType = session.sessionType === 'guest';
    let voterSummary = '';

    if (isMultiPoll) {
      const pollStats = this.calculatePollStats(session);
      voterSummary = `${pollStats.totalVoters} người đã bình chọn phương án`;
    } else {
      const going = (session.votes || []).filter(v => v.status === 'going');
      const totalGoing = going.reduce((sum, v) => sum + 1 + (v.guests || 0), 0);
      voterSummary = `${totalGoing} người tham gia (${going.length} thành viên + ${going.reduce((s, v) => s + (v.guests || 0), 0)} khách)`;
    }

    // Kiểm tra quyền Quản trị viên (Admin)
    if (!AppStorage.can('schedule')) {
      App.showToast("Chỉ Quản trị viên mới có quyền xóa buổi đặt sân!", "warning");
      return;
    }

    // Hiển thị modal xác nhận xóa trực tiếp cho Quản trị viên
    const modalBody = `
      <div style="text-align: center; margin-bottom: 1.25rem;">
        <div style="width: 58px; height: 58px; border-radius: 50%; background: rgba(239, 68, 68, 0.12); color: var(--danger); display: inline-flex; align-items: center; justify-content: center; font-size: 1.7rem; margin-bottom: 0.75rem;">
          <i class="fas fa-trash-alt"></i>
        </div>
        <h3 style="color: var(--text-main); font-size: 1.2rem; margin-bottom: 0.35rem;">Xác nhận xóa buổi đặt sân / bình chọn?</h3>
        <p class="text-secondary" style="font-size: 0.88rem;">Hành động này sẽ <strong>xóa vĩnh viễn</strong> buổi đánh và không thể hoàn tác.</p>
      </div>

      <div class="card" style="background: var(--bg-input); border: 1px solid rgba(239, 68, 68, 0.3); padding: 1rem; border-radius: var(--radius-md); margin-bottom: 1.25rem;">
        <div style="display: flex; gap: 0.4rem; margin-bottom: 0.5rem; flex-wrap: wrap;">
          <span class="badge ${isMultiPoll ? 'badge-poll-mode' : 'badge-neutral'}">${isMultiPoll ? '🗳️ Khảo sát đa phương án' : '🏸 Lịch thi đấu cố định'}</span>
          <span class="badge ${isGuestType ? 'badge-guest-type' : 'badge-fixed-type'}">${isGuestType ? '⚡ Vãng lai' : '🏸 Cố định'}</span>
        </div>
        <div class="font-bold text-main" style="font-size: 1.05rem; margin-bottom: 0.4rem;">${Safe.html(session.title)}</div>
        <div class="text-secondary" style="font-size: 0.85rem; line-height: 1.6;">
          <div><i class="far fa-calendar-alt text-primary" style="width: 16px;"></i> <strong>Ngày:</strong> ${Safe.html(session.date)} (${Safe.html(session.startTime)} - ${Safe.html(session.endTime)})</div>
          <div><i class="fas fa-map-marker-alt text-primary" style="width: 16px;"></i> <strong>Địa điểm:</strong> ${Safe.html(session.courtName)} (${Safe.html(session.courtNumbers)})</div>
          <div><i class="fas fa-users text-primary" style="width: 16px;"></i> <strong>Dữ liệu ảnh hưởng:</strong> ${Safe.html(voterSummary)}</div>
        </div>
      </div>

      <div style="background: rgba(239, 68, 68, 0.08); border-left: 3px solid var(--danger); padding: 0.75rem 1rem; border-radius: var(--radius-sm); margin-bottom: 1.25rem; font-size: 0.84rem; color: var(--text-main);">
        <i class="fas fa-exclamation-triangle text-danger"></i> <strong>Lưu ý:</strong> Toàn bộ lượt bình chọn của các thành viên sẽ bị xóa và đồng bộ cập nhật trên Lịch tháng, Dashboard ngay lập tức.
      </div>

      <div class="modal-footer" style="padding: 0; display: flex; gap: 0.5rem; justify-content: flex-end;">
        <button type="button" class="btn btn-secondary" onclick="App.closeModal()">
          <i class="fas fa-times"></i> Hủy bỏ
        </button>
        <button type="button" class="btn btn-danger" onclick="ScheduleModule.deleteSession(${Safe.js(session.id)})">
          <i class="fas fa-trash-alt"></i> Xác nhận xóa vĩnh viễn
        </button>
      </div>
    `;

    App.openModal("⚠️ Xác nhận xóa buổi đặt sân", modalBody, true);
  },

  deleteSession(sessionId) {
    if (!AppStorage.can('schedule')) {
      App.showToast("Chỉ Ban Quản Trị / Admin mới có quyền xóa buổi bình chọn/đặt sân!", "warning");
      return;
    }

    try {
      const data = AppStorage.loadData();
      const sessionIndex = (data.sessions || []).findIndex(s => s.id === sessionId);

      if (sessionIndex === -1) {
        App.showToast("Không tìm thấy buổi đặt sân cần xóa trên hệ thống!", "error");
        App.closeModal();
        return;
      }

      const deletedTitle = data.sessions[sessionIndex].title || 'Buổi đặt sân';
      data.sessions.splice(sessionIndex, 1);
      AppStorage.saveData(data);
      App.closeModal();
      this.hideHoverPreview();

      App.showToast(`🗑️ Đã xóa vĩnh viễn buổi "${deletedTitle}" thành công!`, "success");

      // Cập nhật lại toàn bộ giao diện
      if (this.currentViewMode === 'calendar') {
        this.renderMonthCalendar();
      } else {
        this.renderSessions("sessions-container", this.currentFilter || "upcoming");
      }
      this.renderSessions("schedule-upcoming-list", this.currentFilter || "upcoming");
      this.renderSessions("dashboard-sessions-preview", "upcoming");
      this.updateScheduleOverviewStats(data.sessions);
      
      if (window.App && typeof App.refreshDashboardStats === 'function') {
        App.refreshDashboardStats();
      }
    } catch (err) {
      console.error("Lỗi khi xóa buổi đặt sân:", err);
      App.showToast("Đã xảy ra lỗi khi xóa buổi đặt sân: " + err.message, "error");
    }
  },

  // ==========================================
  // QUẢN LÝ TRẠNG THÁI VÒNG ĐỜI SESSION (ADMIN)
  // Vòng đời: open → booked → completed / cancelled
  // ==========================================
  openChangeStatusModal(sessionId) {
    if (!AppStorage.can('schedule')) {
      App.showToast('Chỉ Admin mới có quyền thay đổi trạng thái buổi đặt sân!', 'warning');
      return;
    }
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    if (!session) return;

    const currentStatus = session.status || 'open';
    const statusMap = {
      open:      { label: '🟢 Đang mở vote',   cls: 'badge-paid' },
      booked:    { label: '📋 Đã đặt sân',      cls: 'badge-info' },
      completed: { label: '✅ Đã diễn ra',      cls: 'badge-neutral' },
      cancelled: { label: '❌ Đã hủy',          cls: 'badge-danger' },
    };
    const cur = statusMap[currentStatus] || statusMap.open;

    const modalBody = `
      <div style="text-align:center; margin-bottom:1.25rem;">
        <div style="font-size:2.5rem; margin-bottom:0.5rem;">📋</div>
        <h3 style="font-size:1.1rem; color:var(--text-main); margin-bottom:0.3rem;">${Safe.html(session.title)}</h3>
        <div style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:0.75rem;">${Safe.html(session.date)} • ${Safe.html(session.startTime)}–${Safe.html(session.endTime)} • ${Safe.html(session.courtName || 'Sân CLB')}</div>
        <div>Trạng thái hiện tại: <span class="badge ${cur.cls}">${cur.label}</span></div>
      </div>

      <div class="session-status-btn-row" style="grid-template-columns: 1fr 1fr; margin-bottom:1rem;">
        <button class="session-status-btn ${currentStatus === 'open' ? 'is-current' : ''}" onclick="ScheduleModule.changeSessionStatus(${Safe.js(sessionId)}, 'open')" ${currentStatus === 'open' ? 'disabled' : ''}>
          <i class="fas fa-door-open"></i>
          <span>Đang mở vote</span>
          <small>Trạng thái ban đầu</small>
        </button>
        <button class="session-status-btn ${currentStatus === 'booked' ? 'is-current' : ''}" onclick="ScheduleModule.changeSessionStatus(${Safe.js(sessionId)}, 'booked')" ${currentStatus === 'booked' ? 'disabled' : ''}>
          <i class="fas fa-calendar-check"></i>
          <span>Đã đặt sân</span>
          <small>Admin xác nhận với sân</small>
        </button>
        <button class="session-status-btn ${currentStatus === 'completed' ? 'is-current' : ''} btn-completed" onclick="ScheduleModule.changeSessionStatus(${Safe.js(sessionId)}, 'completed')" ${currentStatus === 'completed' ? 'disabled' : ''}>
          <i class="fas fa-flag-checkered"></i>
          <span>Đã diễn ra</span>
          <small>Buổi đánh kết thúc</small>
        </button>
        <button class="session-status-btn ${currentStatus === 'cancelled' ? 'is-current' : ''} btn-cancelled" onclick="ScheduleModule.changeSessionStatus(${Safe.js(sessionId)}, 'cancelled')" ${currentStatus === 'cancelled' ? 'disabled' : ''}>
          <i class="fas fa-times-circle"></i>
          <span>Hủy buổi</span>
          <small>Không tổ chức nữa</small>
        </button>
        ${window.VoteScheduler ? VoteScheduler.renderAdminButton(session) : ''}
      </div>

      <div style="background:rgba(99,102,241,0.07); border-radius:var(--radius-sm); padding:0.6rem 0.9rem; font-size:0.78rem; color:var(--text-secondary);">
        <i class="fas fa-info-circle text-primary"></i>
        Trạng thái sẽ hiển thị trên lịch tháng, danh sách và thông báo cho các thành viên.
      </div>

      <div style="display:flex; justify-content:flex-end; margin-top:1rem;">
        <button class="btn btn-secondary" onclick="App.closeModal()">Đóng</button>
      </div>
    `;

    App.openModal('📋 Quản lý trạng thái buổi đặt sân', modalBody, false);
  },

  changeSessionStatus(sessionId, newStatus) {
    if (!AppStorage.can('schedule')) {
      App.showToast('Chỉ Admin mới có quyền thay đổi trạng thái!', 'warning');
      return;
    }

    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    if (!session) {
      App.showToast('Không tìm thấy buổi đặt sân!', 'error');
      return;
    }

    const oldStatus = session.status || 'open';
    if (oldStatus === newStatus) return;

    const statusLabels = {
      open:      '🟢 Đang mở vote',
      booked:    '📋 Đã đặt sân thành công',
      completed: '✅ Đã diễn ra',
      cancelled: '❌ Đã hủy buổi',
    };
    const toastTypes = {
      open:      'info',
      booked:    'success',
      completed: 'success',
      cancelled: 'warning',
    };

    session.status = newStatus;
    if ((newStatus === 'booked' || newStatus === 'cancelled') && window.VoteScheduler) {
      VoteScheduler.addNotice(session, newStatus);
    }

    // Ghi log vào voteHistory
    if (!session.voteHistory) session.voteHistory = [];
    const adminUser = AppStorage.getCurrentUser();
    const adminName = adminUser ? (adminUser.name || adminUser.username || 'Admin') : 'Admin';
    session.voteHistory.unshift({
      action: 'status_change',
      memberId: adminUser ? (adminUser.id || adminUser.memberId) : 'admin',
      memberName: adminName,
      from: oldStatus,
      to: newStatus,
      timestamp: new Date().toISOString().slice(0, 16).replace('T', ' '),
      note: `Admin chuyển trạng thái: ${statusLabels[oldStatus] || oldStatus} → ${statusLabels[newStatus] || newStatus}`
    });

    AppStorage.saveData(data);
    App.closeModal();
    App.showToast(
      `${statusLabels[newStatus] || newStatus} — Buổi "${session.title}" đã được cập nhật!`,
      toastTypes[newStatus] || 'info'
    );

    // Refresh giao diện
    if (this.currentViewMode === 'calendar') {
      this.renderMonthCalendar();
    } else {
      this.renderSessions('sessions-container', this.currentFilter || 'upcoming');
    }
    this.renderSessions('schedule-upcoming-list', this.currentFilter || 'upcoming');
    this.renderSessions('dashboard-sessions-preview', 'upcoming');
    if (window.App && typeof App.refreshDashboardStats === 'function') {
      App.refreshDashboardStats();
    }
  },
});
;

// ===== js/modules/voting.js =====
// Voting & Attendance Module with Multi-Option Poll & Standard Attendance Support

const VotingModule = {
  selectedVoteStatus: 'going',
  selectedPollOptions: [], // Array of option IDs for multi-option polls
  pollNotGoing: false,
  guestCount: 0,

  resolveMemberId(currentUser, data) {
    if (!currentUser) return null;
    const member = (data.members || []).find(m => 
      (currentUser.memberId && m.id === currentUser.memberId) ||
      m.id === currentUser.id ||
      (currentUser.username && m.username === currentUser.username) ||
      (currentUser.phone && m.phone && currentUser.phone.replace(/\D/g, '') === m.phone.replace(/\D/g, ''))
    );
    return member ? member.id : (currentUser.memberId || currentUser.id);
  },

  isUserVote(v, currentUser, targetMemberId) {
    if (!v || !currentUser) return false;
    return v.memberId === targetMemberId || 
           v.memberId === currentUser.id || 
           (currentUser.memberId && v.memberId === currentUser.memberId) ||
           (currentUser.username && v.memberId === currentUser.username);
  },

  getNowFormatted() {
    const now = new Date();
    const YYYY = now.getFullYear();
    const MM = String(now.getMonth() + 1).padStart(2, '0');
    const DD = String(now.getDate()).padStart(2, '0');
    const HH = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    return `${YYYY}-${MM}-${DD} ${HH}:${mm}`;
  },

  renderVoteHistoryTimeline(historyList = []) {
    if (!Array.isArray(historyList) || historyList.length === 0) {
      return `
        <div style="text-align: center; padding: 0.85rem 0.5rem; color: var(--text-muted); font-size: 0.82rem; font-style: italic; background: var(--bg-input); border-radius: var(--radius-md); border: 1px dashed var(--border-color);">
          <i class="far fa-clock"></i> Chưa có lịch sử thay đổi bình chọn nào cho ca này.
        </div>
      `;
    }

    const sorted = [...historyList].reverse();
    return `
      <div class="vote-history-timeline" style="display: flex; flex-direction: column; gap: 0.5rem; max-height: 180px; overflow-y: auto; padding-right: 4px;">
        ${sorted.map(item => {
          let badgeClass = 'badge-paid';
          let icon = 'fa-check-circle';
          if (item.status === 'not_going') {
            badgeClass = 'badge-unpaid';
            icon = 'fa-times-circle';
          } else if (item.status === 'maybe') {
            badgeClass = 'badge-pending';
            icon = 'fa-clock';
          } else if (item.status === 'poll') {
            badgeClass = 'badge-poll-mode';
            icon = 'fa-poll';
          }

          const avatarUrl = item.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(item.memberName || 'Thành viên')}&background=10b981&color=fff`;

          return `
            <div style="display: flex; align-items: center; justify-content: space-between; background: var(--bg-input); padding: 0.5rem 0.75rem; border-radius: var(--radius-md); border: 1px solid var(--border-color); font-size: 0.82rem; gap: 0.5rem;">
              <div style="display: flex; align-items: center; gap: 0.55rem; min-width: 0; flex: 1;">
                <img class="avatar avatar-xs" src="${Safe.url(avatarUrl)}" alt="${Safe.html(item.memberName)}" style="width: 26px; height: 26px; border-radius: 50%; object-fit: cover; flex-shrink: 0;" onerror="this.src=${Safe.js('https://ui-avatars.com/api/?name=' + encodeURIComponent(item.memberName || 'Thành viên') + '&background=10b981&color=fff')}">
                <div style="min-width: 0; overflow: hidden; text-overflow: ellipsis;">
                  <div style="font-weight: 600; color: var(--text-main); line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                    ${Safe.html(item.memberName)}
                  </div>
                  <div style="font-size: 0.74rem; margin-top: 0.1rem; color: var(--text-secondary); display: flex; align-items: center; gap: 0.35rem; flex-wrap: wrap;">
                    <span class="badge ${badgeClass}" style="font-size: 0.65rem; padding: 0.1rem 0.35rem;">
                      <i class="fas ${icon}"></i> ${Safe.html(item.actionText || 'Cập nhật')}
                    </span>
                    ${item.note ? `<span style="font-style: italic; color: var(--text-muted);">"${Safe.html(item.note)}"</span>` : ''}
                  </div>
                </div>
              </div>
              <div style="text-align: right; font-size: 0.72rem; color: var(--text-muted); white-space: nowrap; flex-shrink: 0;">
                <i class="far fa-clock"></i> ${Safe.html(item.votedAt)}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  },

  openVoteModal(sessionId) {
    if (!AppStorage.isLoggedIn()) {
      App.showToast("Vui lòng đăng nhập để bình chọn ca đánh!", "info");
      App.showAuthModal('login');
      return;
    }
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    if (!session) return;

    const voteLockHours = (data.clubInfo && data.clubInfo.voteLockHours) || 48;
    const lockInfo = ScheduleModule.getVoteLockStatus(session, voteLockHours);
    const isAdmin = AppStorage.can('schedule');

    if (lockInfo.isLocked && !isAdmin) {
      App.showToast("Buổi đánh này đã bị khóa bình chọn (quá hạn trước 2 ngày). Thành viên không thể đổi lịch. Vui lòng liên hệ Ban Quản Trị!", "warning");
      ScheduleModule.openSessionDetailsModal(sessionId);
      return;
    }

    if (session.voteMode === 'multi_option') {
      this.openMultiOptionVoteModal(sessionId);
    } else {
      this.openStandardVoteModal(sessionId);
    }
  },

  // ==========================================
  // MULTI-OPTION POLL VOTING MODAL
  // ==========================================
  openMultiOptionVoteModal(sessionId) {
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    if (!session) return;

    const voteLockHours = (data.clubInfo && data.clubInfo.voteLockHours) || 48;
    const lockInfo = ScheduleModule.getVoteLockStatus(session, voteLockHours);
    const currentUser = data.currentUser || AppStorage.getCurrentUser();
    if (!currentUser) {
      App.showToast("Vui lòng đăng nhập để thực hiện bình chọn!", "info");
      App.showAuthModal('login');
      return;
    }
    const isAdmin = AppStorage.can('schedule');
    const isGuestType = session.sessionType === 'guest';

    if (lockInfo.isLocked && !isAdmin) {
      App.showToast("Buổi khảo sát này đã bị khóa bình chọn (quá hạn trước 2 ngày). Thành viên không thể đổi lịch!", "warning");
      ScheduleModule.openSessionDetailsModal(sessionId);
      return;
    }

    // Find current user's existing vote
    const targetMemberId = this.resolveMemberId(currentUser, data);
    const existingVote = (session.votes || []).find(v => this.isUserVote(v, currentUser, targetMemberId));
    if (existingVote) {
      this.selectedPollOptions = existingVote.selectedOptions ? [...existingVote.selectedOptions] : [];
      this.pollNotGoing = existingVote.notGoing === true;
      this.guestCount = existingVote.guests || 0;
    } else {
      this.selectedPollOptions = session.options && session.options[0] ? [session.options[0].id] : [];
      this.pollNotGoing = false;
      this.guestCount = 0;
    }

    const optionsHtml = (session.options || []).map((opt, idx) => {
      const isChecked = this.selectedPollOptions.includes(opt.id) && !this.pollNotGoing;
      const courtAddr = opt.courtAddress || (data.clubInfo ? data.clubInfo.address : "") || opt.courtName;

      return `
        <div class="poll-option-card ${isChecked ? 'is-selected' : ''}" id="poll-vote-card-${Safe.html(opt.id)}" onclick="VotingModule.togglePollOption(${Safe.js(opt.id)})">
          <div class="poll-option-header">
            <div class="flex items-center gap-3">
              <input type="checkbox" id="chk-opt-${Safe.html(opt.id)}" ${isChecked ? 'checked' : ''} style="width: 18px; height: 18px; accent-color: var(--primary); pointer-events: none;">
              <span class="font-bold" style="font-size: 0.96rem;">Phương án ${idx + 1}: ${Safe.html(opt.courtName)}</span>
            </div>
            <span class="text-primary font-bold font-mono" style="font-size: 0.9rem;">${Number(opt.price) ? Number(opt.price).toLocaleString('vi-VN') + ' đ' : 'Chưa nhập giá'}</span>
          </div>
          <div class="poll-option-meta" style="margin-bottom: 0.35rem; padding-left: 1.8rem;">
            <span><i class="far fa-calendar-alt text-primary"></i> ${Safe.html(opt.date || session.date)}</span>
            <span>•</span>
            <span><i class="far fa-clock text-primary"></i> ${Safe.html(opt.startTime)} - ${Safe.html(opt.endTime)}</span>
            <span>•</span>
            <span>${Safe.html(opt.courtNumbers)}</span>
          </div>
          <div style="padding-left: 1.8rem; display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.2rem;">
            <span class="text-secondary" style="font-size: 0.78rem; display: flex; align-items: center; gap: 0.25rem;">
              <i class="fas fa-map-marker-alt text-primary"></i> ${Safe.html(courtAddr)}
            </span>
            <div style="display: flex; gap: 0.3rem;">
              ${isAdmin ? `
                <button type="button" class="btn btn-ghost btn-icon btn-xs" style="border: 1px solid var(--border-color); border-radius: var(--radius-sm);" onclick="event.stopPropagation(); ScheduleModule.openEditCourtLocationModal(${Safe.js(session.id)}, ${Safe.js(opt.id)})" title="Admin: Sửa thông tin sân & tiền sân phương án này">
                  <i class="fas fa-pencil-alt text-warning"></i>
                </button>
              ` : ''}
              <button type="button" class="btn btn-outline-primary btn-xs" style="padding: 0.15rem 0.45rem; font-size: 0.74rem;" onclick="event.stopPropagation(); ScheduleModule.openCourtMapModal(${Safe.js(opt.courtName)}, ${Safe.js(courtAddr)}, ${Safe.js(opt.mapUrl || '')})">
                <i class="fas fa-map-marked-alt"></i> Bản đồ
              </button>
            </div>
          </div>
          ${opt.note ? `<div class="text-muted" style="font-size: 0.78rem; padding-left: 1.8rem;">"${Safe.html(opt.note)}"</div>` : ''}
        </div>
      `;
    }).join('');

    const modalBody = `
      <div style="margin-bottom: 1rem;">
        <div style="display:flex; gap:0.4rem; margin-bottom:0.3rem;">
          <span class="badge badge-poll-mode" style="font-size:0.7rem;"><i class="fas fa-poll"></i> Khảo sát chọn sân & giờ</span>
          <span class="badge ${isGuestType ? 'badge-guest-type' : 'badge-fixed-type'}" style="font-size:0.7rem;">
            ${isGuestType ? '⚡ Vãng lai theo ngày' : '🏸 Cố định (Trừ quỹ)'}
          </span>
        </div>
        <div style="font-size: 1.15rem; font-weight: 700; color: var(--text-main);">${Safe.html(session.title)}</div>
      </div>

      <div class="vote-deadline-notice ${lockInfo.isLocked ? 'is-locked' : 'is-open'}" style="margin-bottom: 1.25rem;">
        <div>
          <i class="fas ${lockInfo.isLocked ? 'fa-lock' : 'fa-hourglass-half'}"></i>
          <span>${Safe.html(lockInfo.countdownText)}</span>
        </div>
        <span style="font-size: 0.8rem; font-weight: 600;">Hạn: ${Safe.html(lockInfo.deadlineFormatted)}</span>
      </div>

      <div class="form-label">Chọn phương án bạn có thể tham gia (có thể chọn nhiều):</div>
      <div class="poll-options-container" style="margin-top: 0.5rem; margin-bottom: 1rem;">
        ${optionsHtml}
      </div>

      <!-- Option Not Going / Busy -->
      <div class="poll-option-card ${this.pollNotGoing ? 'is-selected' : ''}" id="poll-vote-card-notgoing" onclick="VotingModule.togglePollNotGoing()" style="margin-bottom: 1.25rem; border-color: ${this.pollNotGoing ? 'var(--danger)' : 'var(--border-color)'}; background: ${this.pollNotGoing ? 'rgba(239, 68, 68, 0.1)' : 'var(--bg-input)'};">
        <div class="flex items-center gap-3">
          <input type="checkbox" id="chk-opt-notgoing" ${this.pollNotGoing ? 'checked' : ''} style="width: 18px; height: 18px; accent-color: var(--danger); pointer-events: none;">
          <div>
            <div class="font-bold text-danger" style="font-size: 0.95rem;">❌ Không tham gia được phương án nào</div>
            <div class="text-secondary" style="font-size: 0.78rem;">Bận / Báo vắng buổi giao lưu này</div>
          </div>
        </div>
      </div>

      <!-- Guest Counter (Only relevant if participating) -->
      <div id="guest-selector-container" class="guest-selector" style="${this.pollNotGoing ? 'opacity: 0.4; pointer-events: none;' : ''}">
        <div>
          <div style="font-weight: 600; font-size: 0.95rem;">Dẫn thêm bạn (Khách vãng lai)</div>
          <div class="text-secondary" style="font-size: 0.8rem;">Phí vãng lai: ${Safe.html(data.clubInfo.guestFee.toLocaleString('vi-VN'))} đ / người</div>
        </div>
        <div class="counter-control">
          <button type="button" class="counter-btn" onclick="VotingModule.adjustGuests(-1)">-</button>
          <span id="guest-count-display" class="counter-val">${Safe.html(this.guestCount)}</span>
          <button type="button" class="counter-btn" onclick="VotingModule.adjustGuests(1)">+</button>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Ghi chú thêm (nếu có):</label>
        <input type="text" id="vote-note" class="form-control" placeholder="VD: Khung giờ 19h30 thì mình đến kịp, 18h sợ kẹt xe..." value="${Safe.html(existingVote && existingVote.note ? existingVote.note : '')}">
      </div>

      <!-- Vote History Timeline in Poll Modal -->
      <div style="border-top: 1px dashed var(--border-color); padding-top: 1rem; margin-top: 1rem;">
        <div style="font-weight: 700; font-size: 0.9rem; margin-bottom: 0.6rem; display: flex; align-items: center; justify-content: space-between;">
          <span class="text-main"><i class="fas fa-history text-primary"></i> 📜 Lịch sử bình chọn & thay đổi</span>
          <span class="badge badge-neutral" style="font-size: 0.72rem;">${(session.voteHistory || []).length} lượt ghi nhận</span>
        </div>
        ${this.renderVoteHistoryTimeline(session.voteHistory || [])}
      </div>

      <div class="modal-footer" style="padding: 1.25rem 0 0 0; display: flex; justify-content: space-between; align-items: center;">
        <div>
          ${isAdmin ? `
            <button type="button" class="btn btn-outline-danger btn-sm" onclick="ScheduleModule.confirmDeleteSession(${Safe.js(sessionId)})" title="Xóa buổi khảo sát này">
              <i class="fas fa-trash-alt"></i> Xóa buổi
            </button>
          ` : ''}
        </div>
        <div style="display: flex; gap: 0.5rem;">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Đóng</button>
          <button type="button" class="btn btn-primary" onclick="VotingModule.submitMultiOptionVote(${Safe.js(sessionId)})">
            <i class="fas fa-save"></i> Xác nhận bình chọn
          </button>
        </div>
      </div>
    `;

    App.openModal("🗳️ Bình chọn phương án sân & giờ", modalBody, true);
  },

  togglePollOption(optId) {
    this.pollNotGoing = false;
    const notGoingChk = document.getElementById('chk-opt-notgoing');
    const notGoingCard = document.getElementById('poll-vote-card-notgoing');
    if (notGoingChk) notGoingChk.checked = false;
    if (notGoingCard) {
      notGoingCard.classList.remove('is-selected');
      notGoingCard.style.borderColor = 'var(--border-color)';
      notGoingCard.style.background = 'var(--bg-input)';
    }

    const idx = this.selectedPollOptions.indexOf(optId);
    if (idx >= 0) {
      this.selectedPollOptions.splice(idx, 1);
    } else {
      this.selectedPollOptions.push(optId);
    }

    // Update UI
    const card = document.getElementById(`poll-vote-card-${optId}`);
    const chk = document.getElementById(`chk-opt-${optId}`);
    const isChecked = this.selectedPollOptions.includes(optId);
    if (card) {
      if (isChecked) card.classList.add('is-selected');
      else card.classList.remove('is-selected');
    }
    if (chk) chk.checked = isChecked;

    const guestEl = document.getElementById('guest-selector-container');
    if (guestEl) {
      guestEl.style.opacity = this.selectedPollOptions.length > 0 ? '1' : '0.4';
      guestEl.style.pointerEvents = this.selectedPollOptions.length > 0 ? 'auto' : 'none';
    }
  },

  togglePollNotGoing() {
    this.pollNotGoing = !this.pollNotGoing;
    if (this.pollNotGoing) {
      this.selectedPollOptions = [];
      // Uncheck all option cards
      document.querySelectorAll('.poll-options-container .poll-option-card').forEach(c => c.classList.remove('is-selected'));
      document.querySelectorAll('.poll-options-container input[type="checkbox"]').forEach(c => c.checked = false);
    }

    const notGoingChk = document.getElementById('chk-opt-notgoing');
    const notGoingCard = document.getElementById('poll-vote-card-notgoing');
    if (notGoingChk) notGoingChk.checked = this.pollNotGoing;
    if (notGoingCard) {
      if (this.pollNotGoing) {
        notGoingCard.classList.add('is-selected');
        notGoingCard.style.borderColor = 'var(--danger)';
        notGoingCard.style.background = 'rgba(239, 68, 68, 0.1)';
      } else {
        notGoingCard.classList.remove('is-selected');
        notGoingCard.style.borderColor = 'var(--border-color)';
        notGoingCard.style.background = 'var(--bg-input)';
      }
    }

    const guestEl = document.getElementById('guest-selector-container');
    if (guestEl) {
      guestEl.style.opacity = this.pollNotGoing ? '0.4' : '1';
      guestEl.style.pointerEvents = this.pollNotGoing ? 'none' : 'auto';
    }
  },

  submitMultiOptionVote(sessionId) {
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    if (!session) return;

    const voteLockHours = (data.clubInfo && data.clubInfo.voteLockHours) || 48;
    const lockInfo = ScheduleModule.getVoteLockStatus(session, voteLockHours);
    const isAdmin = AppStorage.can('schedule');

    if (lockInfo.isLocked && !isAdmin) {
      App.showToast(lockInfo.notOpenYet ? `⏰ Chưa tới giờ mở bình chọn (${lockInfo.deadlineFormatted}).` : "Buổi khảo sát này đã bị khóa bình chọn (quá hạn trước 2 ngày). Thành viên không thể đổi lịch!", "error");
      return;
    }

    if (!this.pollNotGoing && this.selectedPollOptions.length === 0) {
      App.showToast("Vui lòng chọn ít nhất một phương án hoặc chọn Báo bận!", "warning");
      return;
    }

    if (!session.votes) session.votes = [];
    const currentUser = data.currentUser || AppStorage.getCurrentUser();
    if (!currentUser) {
      App.showToast("Vui lòng đăng nhập để lưu kết quả!", "error");
      App.showAuthModal('login');
      return;
    }
    const note = document.getElementById('vote-note')?.value.trim() || '';

    const targetMemberId = this.resolveMemberId(currentUser, data);
    const member = (data.members || []).find(m => m.id === targetMemberId);
    const memberName = member ? member.name : (currentUser.name || 'Thành viên');
    const nowStr = this.getNowFormatted();

    // Ghi lịch sử bình chọn (Vote History)
    if (!Array.isArray(session.voteHistory)) session.voteHistory = [];
    let actionText = this.pollNotGoing ? 'Báo bận / Không chọn phương án nào' : `Bình chọn cho ${this.selectedPollOptions.length} phương án sân & giờ`;
    session.voteHistory.push({
      id: `vh_${Date.now()}_${Math.floor(Math.random()*1000)}`,
      memberId: targetMemberId,
      memberName: memberName,
      avatar: member ? member.avatar : (currentUser.avatar || ''),
      status: this.pollNotGoing ? 'not_going' : 'poll',
      actionText: actionText,
      selectedOptions: [...this.selectedPollOptions],
      guests: this.pollNotGoing ? 0 : this.guestCount,
      note: note,
      votedAt: nowStr
    });

    const voteRecord = {
      memberId: targetMemberId,
      selectedOptions: this.pollNotGoing ? [] : this.selectedPollOptions,
      notGoing: this.pollNotGoing,
      guests: this.pollNotGoing ? 0 : this.guestCount,
      note: note,
      votedAt: nowStr
    };

    // Khử trùng lặp: Loại bỏ toàn bộ phiếu cũ của người này, chỉ giữ duy nhất 1 phiếu active
    session.votes = (session.votes || []).filter(v => !this.isUserVote(v, currentUser, targetMemberId));
    session.votes.push(voteRecord);

    AppStorage.saveData(data);
    App.closeModal();

    let msg = "Đã lưu kết quả bình chọn phương án của bạn!";
    if (!this.pollNotGoing) {
      msg = `🎉 Bạn đã bình chọn cho ${this.selectedPollOptions.length} phương án sân & giờ!`;
      if (window.confetti) {
        window.confetti({ particleCount: 50, spread: 60, origin: { y: 0.8 } });
      }
    }
    App.showToast(msg, "success");

    if (ScheduleModule.currentViewMode === 'calendar') {
      ScheduleModule.renderMonthCalendar();
    } else {
      ScheduleModule.renderSessions("sessions-container", ScheduleModule.currentFilter);
    }
    App.refreshDashboardStats();
  },

  // ==========================================
  // STANDARD ATTENDANCE VOTING MODAL
  // ==========================================
  openStandardVoteModal(sessionId) {
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    if (!session) return;

    const voteLockHours = (data.clubInfo && data.clubInfo.voteLockHours) || 48;
    const lockInfo = ScheduleModule.getVoteLockStatus(session, voteLockHours);
    const currentUser = data.currentUser || AppStorage.getCurrentUser();
    if (!currentUser) {
      App.showToast("Vui lòng đăng nhập để thực hiện bình chọn!", "info");
      App.showAuthModal('login');
      return;
    }
    const isAdmin = AppStorage.can('schedule');
    const isGuestType = session.sessionType === 'guest';

    if (lockInfo.isLocked && !isAdmin) {
      App.showToast("Buổi đánh này đã bị khóa bình chọn (quá hạn trước 2 ngày). Thành viên không thể đổi lịch!", "warning");
      this.viewAttendees(sessionId);
      return;
    }

    const targetMemberId = this.resolveMemberId(currentUser, data);
    const existingVote = (session.votes || []).find(v => this.isUserVote(v, currentUser, targetMemberId));
    this.selectedVoteStatus = existingVote ? existingVote.status : 'going';
    this.guestCount = existingVote ? (existingVote.guests || 0) : 0;

    const modalBody = `
      <div style="margin-bottom: 1rem;">
        <div style="display:flex; gap:0.4rem; margin-bottom:0.3rem;">
          <span class="badge ${isGuestType ? 'badge-guest-type' : 'badge-fixed-type'}" style="font-size:0.7rem;">
            ${isGuestType ? '⚡ Lịch vãng lai theo ngày' : '🏸 Lịch cố định (Trừ quỹ)'}
          </span>
        </div>
        <div style="font-size: 1.1rem; font-weight: 700; color: var(--text-main);">${Safe.html(session.title)}</div>
        <div class="text-primary font-semibold" style="font-size: 0.9rem; margin-top: 0.2rem;">
          <i class="far fa-calendar-alt"></i> ${Safe.html(session.date)} | <i class="far fa-clock"></i> ${Safe.html(session.startTime)} - ${Safe.html(session.endTime)} (${Safe.html(session.courtNumbers)})
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; background: var(--bg-input); padding: 0.5rem 0.75rem; border-radius: var(--radius-sm); border: 1px solid var(--border-color); margin-top: 0.5rem; gap: 0.5rem; flex-wrap: wrap;">
          <span class="text-secondary" style="font-size: 0.82rem; display: flex; align-items: center; gap: 0.35rem; flex: 1; min-width: 180px;">
            <i class="fas fa-map-marker-alt text-primary"></i> ${Safe.html(session.courtAddress || (data.clubInfo ? data.clubInfo.address : "") || session.courtName)}
          </span>
          <div style="display: flex; gap: 0.35rem;">
            ${isAdmin ? `
              <button type="button" class="btn btn-ghost btn-icon btn-xs" style="border: 1px solid var(--border-color); border-radius: var(--radius-sm);" onclick="ScheduleModule.openEditCourtLocationModal(${Safe.js(session.id)})" title="Admin: Sửa thông tin sân & tiền sân">
                <i class="fas fa-pencil-alt text-warning"></i>
              </button>
            ` : ''}
            <button type="button" class="btn btn-outline-primary btn-xs" onclick="ScheduleModule.openCourtMapModal(${Safe.js(session.courtName)}, ${Safe.js(session.courtAddress || (data.clubInfo ? data.clubInfo.address : "") || session.courtName)}, ${Safe.js(session.mapUrl || '')})">
              <i class="fas fa-map-marked-alt"></i> Bản đồ
            </button>
          </div>
        </div>
      </div>

      ${lockInfo.isLocked ? `
        <div class="vote-deadline-notice is-locked" style="margin-bottom: 1.25rem;">
          <i class="fas fa-exclamation-triangle"></i>
          <span>Buổi này đã qua hạn chốt trước 2 ngày. Bạn đang thao tác với quyền <strong>Quản trị viên (Admin)</strong>.</span>
        </div>
      ` : `
        <div class="vote-deadline-notice is-open" style="margin-bottom: 1.25rem;">
          <i class="fas fa-info-circle"></i>
          <span>${Safe.html(lockInfo.countdownText)} (Hạn: ${Safe.html(lockInfo.deadlineFormatted)})</span>
        </div>
      `}

      <div class="form-label">Chọn trạng thái tham gia của bạn:</div>
      <div class="vote-options-grid">
        <div class="vote-option-btn opt-going ${this.selectedVoteStatus === 'going' ? 'selected' : ''}" onclick="VotingModule.selectOption('going')">
          <i class="fas fa-badminton text-primary">🏸</i>
          <span class="vote-label">Tham gia</span>
          <span class="vote-sub">Chắc chắn đi</span>
        </div>

        <div class="vote-option-btn opt-not-going ${this.selectedVoteStatus === 'not_going' ? 'selected' : ''}" onclick="VotingModule.selectOption('not_going')">
          <i class="fas fa-times-circle text-danger">❌</i>
          <span class="vote-label">Không đi</span>
          <span class="vote-sub">Bận / Báo vắng</span>
        </div>

        <div class="vote-option-btn opt-maybe ${this.selectedVoteStatus === 'maybe' ? 'selected' : ''}" onclick="VotingModule.selectOption('maybe')">
          <i class="fas fa-hourglass-half text-warning">⏳</i>
          <span class="vote-label">Dự bị</span>
          <span class="vote-sub">Chưa chắc chắn</span>
        </div>
      </div>

      <!-- Guest Counter (Only relevant if going) -->
      <div id="guest-selector-container" class="guest-selector" style="${this.selectedVoteStatus === 'going' ? '' : 'opacity: 0.4; pointer-events: none;'}">
        <div>
          <div style="font-weight: 600; font-size: 0.95rem;">Dẫn thêm bạn (Khách vãng lai)</div>
          <div class="text-secondary" style="font-size: 0.8rem;">Phí vãng lai: ${Safe.html(data.clubInfo.guestFee.toLocaleString('vi-VN'))} đ / người</div>
        </div>
        <div class="counter-control">
          <button type="button" class="counter-btn" onclick="VotingModule.adjustGuests(-1)">-</button>
          <span id="guest-count-display" class="counter-val">${Safe.html(this.guestCount)}</span>
          <button type="button" class="counter-btn" onclick="VotingModule.adjustGuests(1)">+</button>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Ghi chú thêm (nếu có):</label>
        <input type="text" id="vote-note" class="form-control" placeholder="VD: Đến muộn 15p, xin đánh đôi nam..." value="${Safe.html(existingVote && existingVote.note ? existingVote.note : '')}">
      </div>

      <!-- Vote History Timeline in Standard Vote Modal -->
      <div style="border-top: 1px dashed var(--border-color); padding-top: 1rem; margin-top: 1rem;">
        <div style="font-weight: 700; font-size: 0.9rem; margin-bottom: 0.6rem; display: flex; align-items: center; justify-content: space-between;">
          <span class="text-main"><i class="fas fa-history text-primary"></i> 📜 Lịch sử bình chọn & thay đổi</span>
          <span class="badge badge-neutral" style="font-size: 0.72rem;">${(session.voteHistory || []).length} lượt ghi nhận</span>
        </div>
        ${this.renderVoteHistoryTimeline(session.voteHistory || [])}
      </div>

      ${isAdmin ? `
        <div style="border-top: 1px dashed var(--border-color); padding-top: 1rem; margin-top: 1rem;">
          <div class="text-secondary" style="font-size: 0.8rem; font-weight: 700; margin-bottom: 0.5rem;">
            <i class="fas fa-shield-alt"></i> Thao tác quản trị (Admin)
          </div>
          <div style="display: flex; gap: 0.5rem;">
            <button type="button" class="btn btn-secondary btn-sm" onclick="VotingModule.toggleAdminLock(${Safe.js(sessionId)})">
              <i class="fas ${session.status === 'locked' ? 'fa-unlock' : 'fa-lock'}"></i> ${session.status === 'locked' ? 'Mở khóa bình chọn' : 'Khóa bình chọn ngay'}
            </button>
            <button type="button" class="btn btn-secondary btn-sm" onclick="VotingModule.openManualAddModal(${Safe.js(sessionId)})">
              <i class="fas fa-user-plus"></i> Thêm người khác
            </button>
          </div>
        </div>
      ` : ''}

      <div class="modal-footer" style="padding: 1.25rem 0 0 0; display: flex; justify-content: space-between; align-items: center;">
        <div>
          ${isAdmin ? `
            <button type="button" class="btn btn-outline-danger btn-sm" onclick="ScheduleModule.confirmDeleteSession(${Safe.js(sessionId)})" title="Xóa buổi đặt sân này">
              <i class="fas fa-trash-alt"></i> Xóa buổi
            </button>
          ` : ''}
        </div>
        <div style="display: flex; gap: 0.5rem;">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Đóng</button>
          <button type="button" class="btn btn-primary" onclick="VotingModule.submitVote(${Safe.js(sessionId)})">
            <i class="fas fa-save"></i> Xác nhận bình chọn
          </button>
        </div>
      </div>
    `;

    App.openModal("🗳️ Bình chọn tham gia buổi đánh", modalBody);
  },

  selectOption(status) {
    this.selectedVoteStatus = status;
    document.querySelectorAll('.vote-option-btn').forEach(btn => btn.classList.remove('selected'));
    
    if (status === 'going') {
      document.querySelector('.opt-going')?.classList.add('selected');
      const guestEl = document.getElementById('guest-selector-container');
      if (guestEl) {
        guestEl.style.opacity = '1';
        guestEl.style.pointerEvents = 'auto';
      }
    } else if (status === 'not_going') {
      document.querySelector('.opt-not-going')?.classList.add('selected');
      const guestEl = document.getElementById('guest-selector-container');
      if (guestEl) {
        guestEl.style.opacity = '0.4';
        guestEl.style.pointerEvents = 'none';
      }
      this.guestCount = 0;
      const countEl = document.getElementById('guest-count-display');
      if (countEl) countEl.innerText = '0';
    } else if (status === 'maybe') {
      document.querySelector('.opt-maybe')?.classList.add('selected');
      const guestEl = document.getElementById('guest-selector-container');
      if (guestEl) {
        guestEl.style.opacity = '0.4';
        guestEl.style.pointerEvents = 'none';
      }
    }
  },

  adjustGuests(delta) {
    this.guestCount = Math.max(0, Math.min(5, this.guestCount + delta));
    const countEl = document.getElementById('guest-count-display');
    if (countEl) countEl.innerText = this.guestCount;
  },

  submitVote(sessionId) {
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    if (!session) return;

    const voteLockHours = (data.clubInfo && data.clubInfo.voteLockHours) || 48;
    const lockInfo = ScheduleModule.getVoteLockStatus(session, voteLockHours);
    const isAdmin = AppStorage.can('schedule');

    if (lockInfo.isLocked && !isAdmin) {
      App.showToast(lockInfo.notOpenYet ? `⏰ Chưa tới giờ mở bình chọn (${lockInfo.deadlineFormatted}).` : "Buổi đánh này đã bị khóa bình chọn (quá hạn trước 2 ngày). Thành viên không thể đổi lịch!", "error");
      return;
    }

    if (!session.votes) session.votes = [];

    const currentUser = data.currentUser || AppStorage.getCurrentUser();
    if (!currentUser) {
      App.showToast("Vui lòng đăng nhập để lưu kết quả!", "error");
      App.showAuthModal('login');
      return;
    }
    const note = document.getElementById('vote-note')?.value.trim() || '';

    const targetMemberId = this.resolveMemberId(currentUser, data);
    const member = (data.members || []).find(m => m.id === targetMemberId);
    const memberName = member ? member.name : (currentUser.name || 'Thành viên');
    const nowStr = this.getNowFormatted();

    // Ghi lịch sử bình chọn (Vote History)
    if (!Array.isArray(session.voteHistory)) session.voteHistory = [];
    let actionText = '';
    if (this.selectedVoteStatus === 'going') {
      actionText = `Đăng ký tham gia${this.guestCount > 0 ? ` (+${this.guestCount} khách)` : ''}`;
    } else if (this.selectedVoteStatus === 'not_going') {
      actionText = 'Báo vắng / Không tham gia';
    } else if (this.selectedVoteStatus === 'maybe') {
      actionText = 'Đổi sang Dự bị';
    }

    session.voteHistory.push({
      id: `vh_${Date.now()}_${Math.floor(Math.random()*1000)}`,
      memberId: targetMemberId,
      memberName: memberName,
      avatar: member ? member.avatar : (currentUser.avatar || ''),
      status: this.selectedVoteStatus,
      actionText: actionText,
      guests: this.selectedVoteStatus === 'going' ? this.guestCount : 0,
      note: note,
      votedAt: nowStr
    });

    const voteRecord = {
      memberId: targetMemberId,
      status: this.selectedVoteStatus,
      guests: this.selectedVoteStatus === 'going' ? this.guestCount : 0,
      note: note,
      votedAt: nowStr
    };

    // Khử trùng lặp: Loại bỏ toàn bộ phiếu cũ của người này, chỉ giữ duy nhất 1 phiếu active
    session.votes = (session.votes || []).filter(v => !this.isUserVote(v, currentUser, targetMemberId));
    session.votes.push(voteRecord);

    AppStorage.saveData(data);
    App.closeModal();

    let msg = "Đã cập nhật trạng thái bình chọn của bạn thành công!";
    if (this.selectedVoteStatus === 'going') {
      msg = `🎉 Bạn đã đăng ký tham gia buổi đánh${this.guestCount > 0 ? ` (+${this.guestCount} bạn)` : ''}! Hẹn gặp trên sân!`;
      if (window.confetti) {
        window.confetti({ particleCount: 50, spread: 60, origin: { y: 0.8 } });
      }
    }
    App.showToast(msg, "success");
    
    if (ScheduleModule.currentViewMode === 'calendar') {
      ScheduleModule.renderMonthCalendar();
    } else {
      ScheduleModule.renderSessions("sessions-container", ScheduleModule.currentFilter);
    }
    App.refreshDashboardStats();
  },

  viewAttendees(sessionId) {
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    if (!session) return;

    ScheduleModule.openSessionDetailsModal(sessionId);
  },

  toggleAdminLock(sessionId) {
    if (!AppStorage.can('schedule')) {
      App.showToast("Chỉ Quản trị viên mới có quyền khóa/mở bình chọn!", "warning");
      return;
    }
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    if (!session) return;

    session.status = (session.status === 'locked') ? 'open' : 'locked';
    AppStorage.saveData(data);
    App.closeModal();
    App.showToast(`Đã ${session.status === 'locked' ? 'khóa' : 'mở'} bình chọn cho buổi đánh thành công!`, "info");
    
    if (ScheduleModule.currentViewMode === 'calendar') {
      ScheduleModule.renderMonthCalendar();
    } else {
      ScheduleModule.renderSessions("sessions-container", ScheduleModule.currentFilter);
    }
  },

  openManualAddModal(sessionId) {
    if (!AppStorage.can('schedule')) {
      App.showToast("Chỉ Quản trị viên mới có quyền thêm người khác!", "warning");
      return;
    }
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    if (!session) return;

    const members = data.members || [];
    const votedIds = new Set((session.votes || []).map(v => v.memberId));
    const unvotedMembers = members.filter(m => !votedIds.has(m.id));

    const modalBody = `
      <div class="form-group">
        <label class="form-label">Chọn thành viên cần thêm:</label>
        <select id="manual-member-id" class="form-select">
          ${unvotedMembers.map(m => `<option value="${Safe.html(m.id)}">${Safe.html(m.name)} (${Safe.html(AppStorage.maskPhone(m.phone, m.id))})</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Trạng thái:</label>
        <select id="manual-status" class="form-select">
          <option value="going">Tham gia (Đi)</option>
          <option value="maybe">Dự bị</option>
          <option value="not_going">Bận / Không đi</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Khách dẫn kèm:</label>
        <input type="number" id="manual-guests" class="form-control" value="0" min="0" max="5">
      </div>
      <div class="modal-footer" style="padding: 1rem 0 0 0;">
        <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Hủy</button>
        <button type="button" class="btn btn-primary" onclick="VotingModule.saveManualAdd(${Safe.js(sessionId)})">Thêm vào danh sách</button>
      </div>
    `;

    App.openModal("👤 Admin thêm thành viên vào lịch", modalBody);
  },

  saveManualAdd(sessionId) {
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    if (!session) return;

    const memberId = document.getElementById("manual-member-id").value;
    const status = document.getElementById("manual-status").value;
    const guests = parseInt(document.getElementById("manual-guests").value) || 0;
    const member = (data.members || []).find(m => m.id === memberId);
    const nowStr = this.getNowFormatted();

    if (!session.votes) session.votes = [];
    if (!Array.isArray(session.voteHistory)) session.voteHistory = [];

    let actionText = `Admin thêm: ${status === 'going' ? `Tham gia (+${guests} khách)` : (status === 'maybe' ? 'Dự bị' : 'Báo vắng')}`;
    session.voteHistory.push({
      id: `vh_${Date.now()}_${Math.floor(Math.random()*1000)}`,
      memberId: memberId,
      memberName: member ? member.name : 'Thành viên',
      avatar: member ? member.avatar : '',
      status: status,
      actionText: actionText,
      guests: guests,
      note: "Admin thêm thủ công",
      votedAt: nowStr
    });

    const voteRecord = {
      memberId,
      status,
      guests,
      note: "Admin thêm thủ công",
      votedAt: nowStr
    };

    // Khử trùng lặp: Loại bỏ vote cũ của memberId này nếu có
    session.votes = (session.votes || []).filter(v => v.memberId !== memberId);
    session.votes.push(voteRecord);

    AppStorage.saveData(data);
    App.closeModal();
    App.showToast("Đã thêm thành viên vào danh sách thành công!", "success");
    
    if (ScheduleModule.currentViewMode === 'calendar') {
      ScheduleModule.renderMonthCalendar();
    } else {
      ScheduleModule.renderSessions("sessions-container", ScheduleModule.currentFilter);
    }
  }
};

window.VotingModule = VotingModule;
;

// ===== js/modules/vote-scheduler.js =====
// VoteScheduler - Hẹn giờ tự động mở bình chọn & thông báo cho thành viên
// - session.voteOpenAt ("YYYY-MM-DDTHH:mm", giờ Việt Nam): trước thời điểm này thành viên chưa bình chọn được
//   (máy chủ cũng kiểm tra). Để trống = mở ngay.
// - session.notices (đồng bộ): thông báo do Ban quản trị tạo khi mở vote / đặt sân / hủy sân,
//   kèm danh sách memberId nhận (người đã vote tham gia tại thời điểm đó).
// - Mỗi thiết bị đang mở ứng dụng tự kiểm tra và hiện thông báo (toast + thông báo hệ thống nếu đã cho phép).
//   Người không mở ứng dụng nhận qua email nếu Ban quản trị bật trình kích hoạt email trên Apps Script.
const VoteScheduler = {
  CHECK_INTERVAL: 60 * 1000,
  NOTICE_MAX_AGE: 3 * 24 * 60 * 60 * 1000,  // Không báo lại thông báo quá cũ (thiết bị mới cài)
  VOTE_OPEN_MAX_AGE: 24 * 60 * 60 * 1000,
  MAX_NOTICES_PER_SESSION: 20,
  _timer: null,
  _debounce: null,

  init() {
    window.addEventListener('app-state-changed', () => {
      clearTimeout(this._debounce);
      this._debounce = setTimeout(() => this.checkNotices(), 500);
    });
    if (!this._timer) this._timer = setInterval(() => this.checkNotices(), this.CHECK_INTERVAL);
    setTimeout(() => this.checkNotices(), 1500);
  },

  // ---------------- Thời gian (luôn theo giờ Việt Nam, không phụ thuộc múi giờ thiết bị) ----------------
  parseLocal(str) {
    if (!str) return NaN;
    const m = String(str).trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
    return m ? new Date(`${m[1]}T${m[2]}:00+07:00`).getTime() : NaN;
  },

  toLocalInput(ms) {
    const d = new Date(ms + 7 * 60 * 60 * 1000); // dịch sang GMT+7 rồi đọc theo UTC
    return d.toISOString().slice(0, 16);
  },

  formatLabel(str) {
    const ms = this.parseLocal(str);
    if (isNaN(ms)) return '';
    const v = this.toLocalInput(ms);
    return `${v.slice(11, 16)} ngày ${v.slice(8, 10)}/${v.slice(5, 7)}`;
  },

  WEEKDAY_LABELS: ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'],

  // Ngày "YYYY-MM-DD" <-> {y, m, d} (tính theo lịch, không phụ thuộc múi giờ thiết bị)
  _ymd(dateStr) {
    const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
  },
  _fmtYmd(y, m, d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${y}-${p(m)}-${p(d)}`;
  },
  _daysInMonth(y, m) {
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  },

  // Thời điểm mở vote mặc định theo cài đặt CLB (clubInfo.autoVoteOpen):
  //  - mode 'daysBefore': trước ngày đánh N ngày, lúc HH:mm
  //  - mode 'weekday'   : vào THỨ cố định trong tuần (gần nhất trước giờ đánh), lúc HH:mm
  //  - mode 'monthday'  : vào NGÀY cố định trong tháng (gần nhất trước giờ đánh; tháng thiếu ngày -> ngày cuối tháng), lúc HH:mm
  // startTime: giờ bắt đầu buổi đánh, để bảo đảm giờ mở luôn trước giờ đánh.
  defaultOpenAt(dateStr, club, startTime) {
    const cfg = (club && club.autoVoteOpen) || {};
    const day = this._ymd(dateStr);
    if (!cfg.enabled || !day) return '';
    if (window.VotePlan) return VotePlan.openAtFor(dateStr, startTime, Object.assign({ mode: 'daysBefore' }, cfg));
    const time = /^\d{2}:\d{2}$/.test(cfg.time || '') ? cfg.time : '08:00';
    const startMs = this.parseLocal(`${dateStr}T${/^\d{2}:\d{2}/.test(startTime || '') ? startTime.slice(0, 5) : '23:59'}`);
    const before = (ymdStr) => this.parseLocal(`${ymdStr}T${time}`) < startMs;
    const mode = cfg.mode || 'daysBefore';

    if (mode === 'weekday') {
      const target = Math.min(6, Math.max(0, Number(cfg.weekday) || 0));
      const base = Date.UTC(day.y, day.m - 1, day.d);
      for (let back = 0; back <= 14; back++) {
        const dt = new Date(base - back * 86400000);
        if (dt.getUTCDay() !== target) continue;
        const cand = this._fmtYmd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
        if (before(cand)) return `${cand}T${time}`;
      }
      return '';
    }

    if (mode === 'monthday') {
      const want = Math.min(31, Math.max(1, Number(cfg.monthDay) || 1));
      let y = day.y, m = day.m;
      for (let i = 0; i < 3; i++) {
        const d = Math.min(want, this._daysInMonth(y, m));
        const cand = this._fmtYmd(y, m, d);
        if (cand <= dateStr && before(cand)) return `${cand}T${time}`;
        m -= 1;
        if (m === 0) { m = 12; y -= 1; }
      }
      return '';
    }

    const days = Math.max(0, Number(cfg.daysBefore) || 0);
    const base = new Date(Date.UTC(day.y, day.m - 1, day.d) - days * 86400000);
    return `${this._fmtYmd(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate())}T${time}`;
  },

  // Mô tả quy tắc tự động mở bình chọn (hiển thị cho Ban quản trị)
  describeRule(club) {
    const cfg = (club && club.autoVoteOpen) || {};
    if (!cfg.enabled) return 'Chưa bật tự động mở bình chọn';
    const time = cfg.time || '08:00';
    if (cfg.mode === 'weekday') return `${this.WEEKDAY_LABELS[Number(cfg.weekday) || 0]} hằng tuần lúc ${time} (gần nhất trước buổi đánh)`;
    if (cfg.mode === 'monthday') return `Ngày ${Number(cfg.monthDay) || 1} hằng tháng lúc ${time} (gần nhất trước buổi đánh)`;
    return `Trước buổi đánh ${Number(cfg.daysBefore) || 0} ngày, lúc ${time}`;
  },

  emailEnabled(club) {
    return !!(club && club.emailNotify && club.emailNotify.enabled);
  },

  // Ô chọn gửi email cho riêng buổi đánh (chỉ hiện khi CLB bật email)
  renderEmailCheckbox(id, session, club) {
    if (!this.emailEnabled(club)) return '';
    const checked = !session || session.emailNotify !== false;
    return `
        <label style="display: flex; align-items: center; gap: 0.4rem; font-size: 0.85rem; margin: 0.5rem 0;">
          <input type="checkbox" id="${id}" ${checked ? 'checked' : ''}> Gửi email thông báo cho buổi này (mở vote, đặt/hủy sân, nhắc lịch)
        </label>`;
  },

  readEmailCheckbox(id) {
    const el = document.getElementById(id);
    return el ? el.checked : null; // null = không hiển thị (giữ nguyên)
  },

  // Trạng thái mở vote theo hẹn giờ
  getOpenState(session, now = Date.now()) {
    const openMs = this.parseLocal(session && session.voteOpenAt);
    if (isNaN(openMs)) return { scheduled: false, isOpen: true, openMs: NaN, label: '' };
    return { scheduled: true, isOpen: now >= openMs, openMs, label: this.formatLabel(session.voteOpenAt) };
  },

  // ---------------- Tạo thông báo (Ban quản trị) ----------------
  // type: 'vote_open' (gửi mọi thành viên) | 'booked' | 'cancelled' (gửi người đã vote tham gia)
  goingMemberIds(session) {
    return (session.votes || []).filter((v) => {
      if (!v || !v.memberId) return false;
      if (session.voteMode === 'multi_option') {
        if (v.notGoing) return false;
        const sel = Array.isArray(v.selectedOptions) ? v.selectedOptions : [];
        return session.selectedOptionId ? sel.includes(session.selectedOptionId) : sel.length > 0;
      }
      return v.status === 'going';
    }).map((v) => v.memberId);
  },

  addNotice(session, type) {
    if (!session) return null;
    const user = AppStorage.getCurrentUser();
    const notice = {
      id: `nt_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      type,
      at: Date.now(),
      by: user ? user.username : ''
    };
    if (type !== 'vote_open') notice.to = this.goingMemberIds(session);
    session.notices = (Array.isArray(session.notices) ? session.notices : []).concat(notice).slice(-this.MAX_NOTICES_PER_SESSION);
    return notice;
  },

  // ---------------- Giao diện Ban quản trị ----------------
  renderAdminButton(session) {
    if (!AppStorage.canScheduleVotes() || !session || session.status === 'completed' || session.status === 'cancelled') return '';
    const st = this.getOpenState(session);
    const sub = !st.scheduled ? 'Đang mở ngay' : st.isOpen ? `Đã mở lúc ${st.label}` : `Mở lúc ${st.label}`;
    return `
            <button class="session-status-btn" onclick="VoteScheduler.openScheduleModal(${Safe.js(session.id)})">
              <i class="fas fa-stopwatch"></i>
              <span>Hẹn giờ mở vote</span>
              <small>${Safe.html(sub)}</small>
            </button>`;
  },

  // Thành viên được Admin chỉ định (không phải Ban quản trị): khung riêng chỉ có nút hẹn giờ / lặp lại
  renderDelegatePanel(session) {
    if (AppStorage.isAdmin() || !AppStorage.canScheduleVotes() || !session || session.status === 'completed' || session.status === 'cancelled') return '';
    return `
        <div class="session-status-panel" style="margin-bottom: 1rem;">
          <div class="session-status-panel-title"><i class="fas fa-stopwatch"></i> Lịch bình chọn (bạn được Admin giao quyền)</div>
          <div class="session-status-btn-row">
            ${this.renderAdminButton(session)}
            <button class="session-status-btn" onclick="App.closeModal(); AutoScheduleModule.openFromSession(${Safe.js(session.id)})">
              <i class="fas fa-redo"></i><span>Lặp lại buổi này</span><small>Tuần sau / hằng tuần</small>
            </button>
          </div>
        </div>`;
  },

  openScheduleModal(sessionId) {
    if (!AppStorage.canScheduleVotes()) {
      App.showToast('Bạn chưa được Admin giao quyền hẹn giờ mở bình chọn!', 'warning');
      return;
    }
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find((s) => s.id === sessionId);
    if (!session) return;
    const st = this.getOpenState(session);
    const value = st.scheduled ? session.voteOpenAt : (this.defaultOpenAt(session.date, data.clubInfo, session.startTime) || this.toLocalInput(Date.now() + 60 * 60 * 1000));
    const body = `
      <form onsubmit="VoteScheduler.saveSchedule(event, ${Safe.js(session.id)})">
        <p class="text-secondary" style="font-size: 0.85rem; margin-bottom: 1rem;">
          Buổi <b>${Safe.html(session.title)}</b> (${Safe.html(session.date)} ${Safe.html(session.startTime || '')}).
          Đến giờ hẹn, bình chọn tự mở và thành viên nhận thông báo.
        </p>
        <div class="form-group">
          <label class="form-label font-bold">Thời điểm mở bình chọn (giờ Việt Nam)</label>
          <input type="datetime-local" id="vote-open-at-input" class="form-control" required value="${Safe.html(value)}">
        </div>
        <div class="text-secondary" style="font-size: 0.8rem; margin-bottom: 0.75rem;">
          Trạng thái hiện tại: ${Safe.html(!st.scheduled ? 'Mở ngay (không hẹn giờ)' : st.isOpen ? `Đã mở lúc ${st.label}` : `Hẹn mở lúc ${st.label}`)}
        </div>
        ${this.renderEmailCheckbox('vote-open-email-input', session, data.clubInfo)}
        <div class="modal-footer" style="padding: 1rem 0 0 0; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.5rem;">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Đóng</button>
          <button type="button" class="btn btn-outline-primary" onclick="VoteScheduler.openNow(${Safe.js(session.id)})"><i class="fas fa-bolt"></i> Mở vote ngay</button>
          ${window.AutoScheduleModule ? `<button type="button" class="btn btn-outline-primary" onclick="App.closeModal(); AutoScheduleModule.openFromSession(${Safe.js(session.id)})"><i class="fas fa-redo"></i> Lặp lại tuần sau</button>` : ''}
          <button type="submit" class="btn btn-primary"><i class="fas fa-stopwatch"></i> Lưu hẹn giờ</button>
        </div>
      </form>
    `;
    App.openModal('⏰ Hẹn giờ mở bình chọn', body);
  },

  saveSchedule(e, sessionId) {
    if (e && e.preventDefault) e.preventDefault();
    if (!AppStorage.canScheduleVotes()) return;
    const value = document.getElementById('vote-open-at-input')?.value || '';
    const openMs = this.parseLocal(value);
    if (isNaN(openMs)) {
      App.showToast('Thời điểm mở bình chọn không hợp lệ!', 'warning');
      return;
    }
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find((s) => s.id === sessionId);
    if (!session) return;
    const start = this.parseLocal(`${session.date}T${session.startTime || '18:00'}`);
    if (!isNaN(start) && openMs >= start) {
      App.showToast('Giờ mở bình chọn phải trước giờ bắt đầu buổi đánh!', 'warning');
      return;
    }
    session.voteOpenAt = value;
    const email = this.readEmailCheckbox('vote-open-email-input');
    if (email !== null) session.emailNotify = email;
    AppStorage.saveData(data);
    App.closeModal();
    App.showToast(openMs <= Date.now() ? '🗳️ Đã mở bình chọn!' : `⏰ Đã hẹn mở bình chọn lúc ${this.formatLabel(value)}`, 'success');
  },

  openNow(sessionId) {
    if (!AppStorage.canScheduleVotes()) return;
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find((s) => s.id === sessionId);
    if (!session) return;
    session.voteOpenAt = '';
    const email = this.readEmailCheckbox('vote-open-email-input');
    if (email !== null) session.emailNotify = email;
    this.addNotice(session, 'vote_open');
    AppStorage.saveData(data);
    App.closeModal();
    App.showToast('🗳️ Đã mở bình chọn và thông báo cho thành viên!', 'success');
  },

  // ---------------- Nhận thông báo trên thiết bị ----------------
  _seenKey(username) {
    return `${(AppStorage._ns && AppStorage._ns()) || ''}SMASH_PRO_SEEN_NOTICES_${username}`;
  },

  _sessionText(session) {
    const when = `${session.startTime || ''} ${session.date || ''}`.trim();
    const court = session.courtName ? ` • ${session.courtName}${session.courtNumbers ? ` (${session.courtNumbers})` : ''}` : '';
    return `${when}${court}`;
  },

  // Trả về danh sách thông báo mới dành cho người đang đăng nhập (và đánh dấu đã xem)
  collectNew(data, user, now = Date.now()) {
    if (!user || !user.username) return [];
    const key = this._seenKey(user.username);
    let seen = {};
    try { seen = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (e) {}
    const out = [];
    const mark = (k) => { seen[k] = now; };

    (data.sessions || []).forEach((s) => {
      if (!s || !s.id) return;
      const finished = s.status === 'completed' || s.status === 'cancelled';
      const st = this.getOpenState(s, now);
      if (st.scheduled && st.isOpen) {
        const k = `vo:${s.id}:${s.voteOpenAt}`;
        if (!seen[k]) {
          mark(k);
          if (!finished && now - st.openMs < this.VOTE_OPEN_MAX_AGE) {
            out.push({ type: 'vote_open', session: s, tag: `vote-open-${s.id}` });
          }
        }
      }
      // Đủ người cho số sân -> báo người mở vote (trên thiết bị đang mở)
      const mail = (data.clubInfo && data.clubInfo.emailNotify) || {};
      if (!finished && mail.courtFull !== false && (s.voteMode !== 'multi_option' || s.selectedOptionId) && s.emailNotify !== false) {
        const owner = VotePlan.ownerOf(s, data.clubInfo && data.clubInfo.voteSchedules);
        const k = `full:${s.id}`;
        if (owner && owner === user.username && !seen[k]) {
          const cf = VotePlan.courtFull(s, mail.courtFullPerCourt);
          if (cf.full) {
            mark(k);
            out.push({ type: 'court_full', session: s, info: cf, tag: `court-full-${s.id}` });
          }
        }
      }
      (Array.isArray(s.notices) ? s.notices : []).forEach((n) => {
        if (!n || !n.id) return;
        const k = `n:${n.id}`;
        if (seen[k]) return;
        mark(k);
        if (n.by && n.by === user.username) return; // Người tạo không cần tự nhận
        if (now - (Number(n.at) || 0) > this.NOTICE_MAX_AGE) return;
        if (n.type === 'vote_open') {
          if (!finished) out.push({ type: 'vote_open', session: s, tag: `vote-open-${s.id}` });
        } else if ((n.type === 'booked' || n.type === 'cancelled') && Array.isArray(n.to) && n.to.includes(user.memberId)) {
          out.push({ type: n.type, session: s, tag: `${n.type}-${s.id}` });
        }
      });
    });

    // Gọn bộ nhớ: bỏ dấu đã xem quá 30 ngày
    Object.keys(seen).forEach((k) => { if (now - seen[k] > 30 * 24 * 60 * 60 * 1000) delete seen[k]; });
    try { localStorage.setItem(key, JSON.stringify(seen)); } catch (e) {}
    return out;
  },

  messageFor(item) {
    const s = item.session;
    const info = this._sessionText(s);
    if (item.type === 'vote_open') {
      return { title: `🗳️ Đã mở bình chọn: ${s.title}`, body: `${info}\nVào ứng dụng bình chọn tham gia ngay!`, toast: 'info' };
    }
    if (item.type === 'court_full') {
      const cf = item.info;
      return { title: `✅ Đã đủ người: ${s.title}`, body: `${info}\nCó ${cf.count} người cho ${cf.courts} sân (đủ ${cf.per} người/sân). Bạn có thể chốt đặt sân.`, toast: 'success' };
    }
    if (item.type === 'booked') {
      return { title: `📋 Đã đặt sân: ${s.title}`, body: `${info}\nBạn đã đăng ký tham gia, hẹn gặp ở sân!`, toast: 'success' };
    }
    return { title: `❌ Đã hủy buổi: ${s.title}`, body: `${info}\nBuổi đánh bạn đăng ký đã bị hủy.`, toast: 'warning' };
  },

  checkNotices() {
    try {
      const user = AppStorage.getCurrentUser();
      if (!user) return;
      const items = this.collectNew(AppStorage.loadData(), user);
      items.slice(0, 5).forEach((item) => {
        const msg = this.messageFor(item);
        if (window.App && App.showToast) App.showToast(`${msg.title} — ${msg.body.replace(/\n/g, ' • ')}`, msg.toast);
        if (window.NotificationModule && NotificationModule._showNotification) {
          NotificationModule._showNotification({ title: msg.title, body: msg.body, tag: item.tag });
        }
      });
    } catch (e) {
      console.warn('[VoteScheduler] Lỗi kiểm tra thông báo:', e);
    }
  }
};

window.VoteScheduler = VoteScheduler;
;

// ===== js/modules/membership.js =====
// MembershipModule - Kiểm soát thành viên cố định (cần Ban quản trị duyệt)
// user.fixedRequest: 'pending' (chờ duyệt) | 'approved' | 'rejected' | 'cancelled'
// user.fixedRequestAt: thời điểm gửi yêu cầu; user.fixedDecidedAt / fixedDecidedBy: lúc & người duyệt.
// Máy chủ chỉ cho thành viên tự gửi/hủy yêu cầu; đổi loại thành "cố định" chỉ Ban quản trị làm được.
const MembershipModule = {
  _debounce: null,

  init() {
    window.addEventListener('app-state-changed', () => {
      clearTimeout(this._debounce);
      this._debounce = setTimeout(() => {
        this.renderPanel();
        this.checkNotifications();
      }, 400);
    });
    setTimeout(() => { this.renderPanel(); this.checkNotifications(); }, 1500);
  },

  _toast(msg, type) {
    if (window.App && App.showToast) App.showToast(msg, type);
  },

  pendingUsers(data) {
    return (data.users || []).filter((u) => u && u.fixedRequest === 'pending' && u.type !== 'fixed');
  },

  // Thành viên (theo memberId) đang chờ duyệt cố định
  isPendingMember(member, data) {
    if (!member) return false;
    return (data.users || []).some((u) => u.fixedRequest === 'pending' && u.type !== 'fixed' &&
      (u.memberId === member.id || (member.username && u.username === member.username)));
  },

  // ---------------- Bảng điều khiển ở tab Thành viên ----------------
  renderPanel() {
    const box = document.getElementById('fixed-requests-panel');
    if (!box) return;
    const user = AppStorage.getCurrentUser();
    if (!user) {
      box.innerHTML = '';
      return;
    }
    const data = AppStorage.loadData();
    let html = '';

    if (AppStorage.isAdmin()) {
      const pending = this.pendingUsers(data);
      if (pending.length) {
        html += `
          <div class="card" style="padding: 1rem 1.25rem; margin-bottom: 1rem; border-left: 4px solid var(--warning, #f59e0b);">
            <div class="font-bold" style="margin-bottom: 0.6rem;"><i class="fas fa-user-clock text-warning"></i> Yêu cầu thành viên cố định chờ duyệt (${pending.length})</div>
            ${pending.map((u) => `
              <div class="flex items-center justify-between" style="gap: 0.75rem; padding: 0.5rem 0; border-top: 1px solid var(--border-color); flex-wrap: wrap;">
                <div>
                  <div class="font-bold">${Safe.html(u.name)}</div>
                  <div class="text-secondary" style="font-size: 0.78rem;">${Safe.html(u.username)}${u.phone ? ' • ' + Safe.html(u.phone) : ''}${u.fixedRequestAt ? ' • gửi lúc ' + Safe.html(String(u.fixedRequestAt).slice(0, 16).replace('T', ' ')) : ''}</div>
                </div>
                <div class="flex" style="gap: 0.4rem;">
                  <button class="btn btn-primary btn-sm" onclick="MembershipModule.decide(${Safe.js(u.username)}, true)"><i class="fas fa-check"></i> Duyệt</button>
                  <button class="btn btn-secondary btn-sm" onclick="MembershipModule.decide(${Safe.js(u.username)}, false)"><i class="fas fa-times"></i> Từ chối</button>
                </div>
              </div>`).join('')}
          </div>`;
      }
    } else if (user.type !== 'fixed') {
      const st = user.fixedRequest;
      html += `
        <div class="card" style="padding: 1rem 1.25rem; margin-bottom: 1rem;">
          <div class="flex items-center justify-between" style="gap: 0.75rem; flex-wrap: wrap;">
            <div>
              <div class="font-bold"><i class="fas fa-id-card text-primary"></i> ${st === 'pending' ? 'Yêu cầu thành viên cố định đang chờ duyệt' : 'Bạn đang là khách vãng lai'}</div>
              <div class="text-secondary" style="font-size: 0.8rem;">${st === 'pending'
                ? 'Ban quản trị sẽ xem xét và thông báo cho bạn.'
                : st === 'rejected' ? 'Yêu cầu trước chưa được duyệt. Bạn có thể gửi lại.' : 'Thành viên cố định góp quỹ tháng và xem được sổ quỹ CLB. Cần Ban quản trị duyệt.'}</div>
            </div>
            ${st === 'pending'
              ? `<button class="btn btn-secondary btn-sm" onclick="MembershipModule.setRequest(false)"><i class="fas fa-undo"></i> Hủy yêu cầu</button>`
              : `<button class="btn btn-primary btn-sm" onclick="MembershipModule.setRequest(true)"><i class="fas fa-paper-plane"></i> Đăng ký thành viên cố định</button>`}
          </div>
        </div>`;
    }
    box.innerHTML = html;
  },

  // Thành viên gửi / hủy yêu cầu
  setRequest(want) {
    const data = AppStorage.loadData();
    const cur = AppStorage.getCurrentUser();
    const user = cur && (data.users || []).find((u) => u.username === cur.username);
    if (!user) {
      this._toast('Vui lòng đăng nhập!', 'warning');
      return;
    }
    if (want) {
      if (user.type === 'fixed') return;
      user.fixedRequest = 'pending';
      user.fixedRequestAt = new Date().toISOString();
    } else {
      user.fixedRequest = 'cancelled';
    }
    AppStorage.saveData(data);
    this._toast(want ? '📨 Đã gửi yêu cầu làm thành viên cố định, vui lòng chờ Ban quản trị duyệt.' : 'Đã hủy yêu cầu thành viên cố định.', 'success');
    this.renderPanel();
  },

  // Ban quản trị duyệt / từ chối
  async decide(username, approve) {
    if (!AppStorage.isAdmin()) {
      this._toast('Chỉ Ban quản trị mới được duyệt thành viên cố định!', 'warning');
      return;
    }
    const data = AppStorage.loadData();
    const user = (data.users || []).find((u) => u.username === username);
    if (!user) return;
    const admin = AppStorage.getCurrentUser();
    user.fixedRequest = approve ? 'approved' : 'rejected';
    user.fixedDecidedAt = Date.now();
    user.fixedDecidedBy = admin ? admin.username : '';
    if (approve) {
      user.type = 'fixed';
      const member = (data.members || []).find((m) => m.id === user.memberId || (m.username && m.username === user.username));
      if (member) member.type = 'fixed';
    }
    const result = await AppStorage.saveDataWithCloudAck(data);
    this._toast(approve ? `✅ Đã duyệt ${user.name} làm thành viên cố định.` : `Đã từ chối yêu cầu của ${user.name}.`, result.success ? 'success' : 'warning');
    this.renderPanel();
    if (window.MembersModule && typeof MembersModule.renderMembersTab === 'function') MembersModule.renderMembersTab();
  },

  // ---------------- Thông báo trên thiết bị ----------------
  _seenKey(username) {
    return `${(AppStorage._ns && AppStorage._ns()) || ''}SMASH_PRO_SEEN_MEMBERSHIP_${username}`;
  },

  collectNew(data, user, now = Date.now()) {
    if (!user || !user.username) return [];
    const key = this._seenKey(user.username);
    let seen = {};
    try { seen = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (e) {}
    const out = [];
    const isStaff = user.role === 'admin' || user.role === 'treasurer';
    if (isStaff) {
      this.pendingUsers(data).forEach((u) => {
        const k = `req:${u.username}:${u.fixedRequestAt || ''}`;
        if (seen[k]) return;
        seen[k] = now;
        out.push({ type: 'request', title: `🪪 Yêu cầu thành viên cố định: ${u.name}`, body: 'Vào mục Thành viên để duyệt.', toast: 'info' });
      });
    }
    const me = (data.users || []).find((u) => u.username === user.username);
    if (me && (me.fixedRequest === 'approved' || me.fixedRequest === 'rejected') && me.fixedDecidedAt) {
      const k = `res:${me.fixedDecidedAt}`;
      if (!seen[k]) {
        seen[k] = now;
        const ok = me.fixedRequest === 'approved';
        out.push({
          type: ok ? 'approved' : 'rejected',
          title: ok ? '🎉 Bạn đã là thành viên cố định!' : 'Yêu cầu thành viên cố định chưa được duyệt',
          body: ok ? 'Ban quản trị đã duyệt yêu cầu của bạn.' : 'Liên hệ Ban quản trị để biết thêm chi tiết.',
          toast: ok ? 'success' : 'warning'
        });
      }
    }
    try { localStorage.setItem(key, JSON.stringify(seen)); } catch (e) {}
    return out;
  },

  checkNotifications() {
    try {
      const user = AppStorage.getCurrentUser();
      if (!user) return;
      this.collectNew(AppStorage.loadData(), user).slice(0, 5).forEach((n) => {
        if (window.App && App.showToast) App.showToast(`${n.title} — ${n.body}`, n.toast);
        if (window.NotificationModule && NotificationModule._showNotification) {
          NotificationModule._showNotification({ title: n.title, body: n.body, tag: `membership-${n.type}` });
        }
      });
    } catch (e) {
      console.warn('[Membership] Lỗi kiểm tra thông báo:', e);
    }
  }
};

window.MembershipModule = MembershipModule;
;

// ===== js/modules/auto-schedule.js =====
// AutoScheduleModule - Lịch bình chọn tự động (Ban quản trị & thành viên được Admin chỉ định)
// - Lịch lưu ở clubInfo.voteSchedules; cách tính ngày/giờ mở vote dùng chung VotePlan với máy chủ.
// - Máy chủ tự tạo buổi đánh của lần kế tiếp (trước giờ mở vote 3 ngày) với mã cố định -> không tạo trùng.
//   Ở chế độ chạy cục bộ (không có máy chủ), thiết bị của người có quyền tự tạo.
const AutoScheduleModule = {
  _debounce: null,
  _timer: null,

  init() {
    window.addEventListener('app-state-changed', () => {
      clearTimeout(this._debounce);
      this._debounce = setTimeout(() => this.refresh(), 400);
    });
    if (!this._timer) this._timer = setInterval(() => this.refresh(), 5 * 60 * 1000);
    setTimeout(() => this.refresh(), 1500);
  },

  refresh() {
    try {
      this.generateLocalIfNeeded();
      this.renderPanel();
    } catch (e) {
      console.warn('[AutoSchedule] Lỗi:', e);
    }
  },

  schedules(data) {
    const list = data && data.clubInfo && data.clubInfo.voteSchedules;
    return Array.isArray(list) ? list.filter((s) => s && s.id) : [];
  },

  // Chế độ cục bộ: không có máy chủ để tạo buổi -> thiết bị của người có quyền tạo
  generateLocalIfNeeded(now = Date.now()) {
    if (!AppStorage.isLocalOnly() || !AppStorage.canScheduleVotes()) return 0;
    const data = AppStorage.loadData();
    const ids = new Set((data.sessions || []).map((s) => s.id));
    const due = VotePlan.dueSessions(this.schedules(data), (id) => ids.has(id), now, 'auto');
    if (!due.length) return 0;
    data.sessions = due.concat(data.sessions || []);
    AppStorage.saveData(data);
    return due.length;
  },

  // ---------------- Bảng lịch ở tab Lịch trình ----------------
  renderPanel() {
    const box = document.getElementById('auto-schedule-panel');
    if (!box) return;
    if (!AppStorage.canScheduleVotes()) {
      box.innerHTML = '';
      return;
    }
    const data = AppStorage.loadData();
    const list = this.schedules(data);
    const sessionIds = new Set((data.sessions || []).map((s) => s.id));
    const now = Date.now();
    const rows = list.map((s) => {
      const next = VotePlan.nextRun(s, now);
      let nextText = 'Không còn lần diễn ra nào sắp tới';
      if (next) {
        const created = sessionIds.has(next.sessionId);
        const open = next.openAt ? `mở vote ${VotePlan.label(next.openAt)}` : 'mở vote ngay khi tạo';
        nextText = `Lần tới: ${next.date.split('-').reverse().join('/')} • ${open} • ${created ? 'đã tạo buổi' : 'tạo buổi lúc ' + VoteScheduler.formatLabel(VoteScheduler.toLocalInput(next.createAt))}`;
      }
      return `
        <div class="flex items-center justify-between" style="gap: 0.75rem; padding: 0.6rem 0; border-top: 1px solid var(--border-color); flex-wrap: wrap;">
          <div style="min-width: 0; flex: 1;">
            <div class="font-bold">${s.enabled ? '🟢' : '⏸️'} ${Safe.html(s.title || 'Giao lưu cầu lông')}</div>
            <div class="text-secondary" style="font-size: 0.8rem;">${Safe.html(VotePlan.describeRepeat(s))}${s.courtName ? ' • ' + Safe.html(s.courtName) : ''}</div>
            <div class="text-secondary" style="font-size: 0.8rem;">${Safe.html(VotePlan.describeOpen(s.open))}</div>
            <div style="font-size: 0.78rem;" class="${s.enabled ? 'text-primary' : 'text-secondary'}">${Safe.html(s.enabled ? nextText : 'Đang tạm dừng')}</div>
          </div>
          <div class="flex" style="gap: 0.4rem;">
            <button class="btn btn-secondary btn-sm" onclick="AutoScheduleModule.toggle(${Safe.js(s.id)})" title="${s.enabled ? 'Tạm dừng' : 'Bật lại'}"><i class="fas ${s.enabled ? 'fa-pause' : 'fa-play'}"></i></button>
            <button class="btn btn-secondary btn-sm" onclick="AutoScheduleModule.openEditor(${Safe.js(s.id)})" title="Sửa"><i class="fas fa-pen"></i></button>
            <button class="btn btn-outline-danger btn-sm" onclick="AutoScheduleModule.remove(${Safe.js(s.id)})" title="Xóa lịch"><i class="fas fa-trash-alt"></i></button>
          </div>
        </div>`;
    }).join('');
    box.innerHTML = `
      <div class="card" style="padding: 1rem 1.25rem; margin-bottom: 1rem;">
        <div class="flex items-center justify-between" style="gap: 0.75rem; flex-wrap: wrap;">
          <div class="font-bold"><i class="fas fa-redo text-primary"></i> Lịch bình chọn tự động (${list.length})</div>
          <button class="btn btn-primary btn-sm" onclick="AutoScheduleModule.openEditor()"><i class="fas fa-plus"></i> Thêm lịch</button>
        </div>
        ${rows || '<div class="text-secondary" style="font-size: 0.82rem; margin-top: 0.5rem;">Chưa có lịch. Tạo lịch theo ngày cụ thể, theo thứ trong tuần hoặc theo ngày trong tháng; hệ thống tự tạo buổi và mở bình chọn đúng giờ.</div>'}
        ${this.renderTimeline(data, list, now)}
      </div>`;
  },

  // Dòng thời gian hợp nhất: các buổi sắp tới + giờ mở vote + NGUỒN của giờ đó (lịch lặp / quy tắc mặc định / hẹn tay / mở ngay)
  renderTimeline(data, list, now) {
    const upcoming = (data.sessions || []).filter((s) => s && s.date && s.status !== 'cancelled' && s.status !== 'completed' &&
      ScheduleModule.parseSessionDateTime(s.date, s.endTime || '23:59').getTime() >= now)
      .sort((a, b) => ScheduleModule.parseSessionDateTime(a.date, a.startTime) - ScheduleModule.parseSessionDateTime(b.date, b.startTime)).slice(0, 8);
    if (!upcoming.length) return '';
    const byId = new Map(list.map((s) => [s.id, s]));
    const items = upcoming.map((s) => {
      const st = VoteScheduler.getOpenState(s, now);
      let source = 'Hẹn tay';
      if (s.scheduleId && byId.has(s.scheduleId)) source = `Lịch lặp: ${byId.get(s.scheduleId).title || 'Giao lưu cầu lông'}`;
      else if (s.scheduleId) source = 'Lịch lặp (đã xóa)';
      else if (!st.scheduled) source = 'Mở ngay khi tạo';
      const state = !st.scheduled ? '🟢 Đang mở' : st.isOpen ? `🟢 Đã mở lúc ${st.label}` : `⏳ Mở lúc ${st.label}`;
      return `
        <div class="flex items-center justify-between" style="gap: 0.5rem; padding: 0.4rem 0; border-top: 1px dashed var(--border-color); flex-wrap: wrap; font-size: 0.82rem;">
          <span><b>${Safe.html(s.title)}</b> <span class="text-secondary">• ${Safe.html(s.date.split('-').reverse().join('/'))} ${Safe.html(s.startTime || '')}</span></span>
          <span class="text-secondary">${state} • <i>${Safe.html(source)}</i></span>
        </div>`;
    }).join('');
    return `
      <div style="margin-top: 0.9rem;">
        <div class="font-bold" style="font-size: 0.85rem;"><i class="fas fa-stream text-primary"></i> Dòng thời gian mở vote sắp tới</div>
        <div class="text-secondary" style="font-size: 0.76rem; margin: 0.15rem 0 0.3rem;">Một nơi xem mọi buổi sắp tới và giờ mở vote, bất kể được tạo theo lịch lặp hay tạo tay. Muốn đổi một buổi riêng: mở buổi đó → "Hẹn giờ mở vote".</div>
        ${items}
      </div>`;
  },

  // ---------------- Biểu mẫu ----------------
  _defaults(data) {
    const club = (data && data.clubInfo) || {};
    const auto = club.autoVoteOpen || {};
    const open = auto.enabled
      ? { mode: auto.mode || 'daysBefore', daysBefore: Number(auto.daysBefore) || 0, weekday: Number(auto.weekday) || 0, monthDay: Number(auto.monthDay) || 1, time: auto.time || '08:00' }
      : { mode: 'daysBefore', daysBefore: 3, weekday: 1, monthDay: 1, time: '08:00' };
    return {
      id: '', title: 'Giao lưu cầu lông', enabled: true, repeat: 'weekly', date: VotePlan.addDays(VotePlan.vnDate(Date.now()), 7),
      weekday: 4, monthDay: 1, startTime: '18:00', endTime: '20:00', courtName: club.defaultCourt || '', courtNumbers: '',
      courtAddress: club.address || '', courtPrice: '', maxPlayers: 12, startFrom: '', until: '', open
    };
  },

  // Từ một buổi có sẵn: lặp lại vào cùng thứ, cùng giờ, cùng sân của tuần kế tiếp (mặc định hằng tuần)
  openFromSession(sessionId) {
    if (!AppStorage.canScheduleVotes()) return;
    const data = AppStorage.loadData();
    const s = (data.sessions || []).find((x) => x.id === sessionId);
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s.date || '')) return;
    const base = this._defaults(data);
    let open = base.open;
    const m = String(s.voteOpenAt || '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
    if (m) {
      const days = Math.round((Date.parse(s.date + 'T00:00:00Z') - Date.parse(m[1] + 'T00:00:00Z')) / 86400000);
      open = { mode: 'daysBefore', daysBefore: Math.max(0, days), weekday: base.open.weekday, monthDay: base.open.monthDay, time: m[2] };
    }
    const next = VotePlan.addDays(s.date, 7);
    this.openEditor(null, Object.assign(base, {
      title: s.title || base.title, repeat: 'weekly', weekday: VotePlan.weekdayOf(s.date), date: next,
      startTime: (s.startTime || '18:00').slice(0, 5), endTime: (s.endTime || '20:00').slice(0, 5),
      courtName: s.voteMode === 'multi_option' ? base.courtName : (s.courtName || ''), courtNumbers: s.voteMode === 'multi_option' ? '' : (s.courtNumbers || ''),
      courtAddress: s.courtAddress || base.courtAddress, mapUrl: s.mapUrl || '', courtPrice: s.courtPrice || '', maxPlayers: s.maxPlayers || 12,
      shuttleType: s.shuttleType && s.shuttleType !== 'n/a' ? s.shuttleType : '', note: s.note || '', sessionType: s.sessionType === 'guest' ? 'guest' : 'fixed',
      emailNotify: s.emailNotify !== false, startFrom: VotePlan.addDays(s.date, 1), fromSessionId: s.id, open
    }));
  },

  openEditor(scheduleId = null, preset = null) {
    if (!AppStorage.canScheduleVotes()) {
      App.showToast('Bạn chưa được Admin giao quyền lên lịch bình chọn!', 'warning');
      return;
    }
    const data = AppStorage.loadData();
    const existing = scheduleId ? this.schedules(data).find((s) => s.id === scheduleId) : null;
    const v = Object.assign(this._defaults(data), preset || {}, existing ? JSON.parse(JSON.stringify(existing)) : {});
    v.open = Object.assign(this._defaults(data).open, v.open || {});
    const opt = (val, label, cur) => `<option value="${Safe.html(String(val))}" ${String(cur) === String(val) ? 'selected' : ''}>${Safe.html(label)}</option>`;
    const weekdays = (cur) => VotePlan.WEEKDAYS.map((l, i) => opt(i, l, cur)).join('');
    const monthDays = (cur) => Array.from({ length: 31 }, (_, i) => opt(i + 1, `Ngày ${i + 1}${i + 1 > 28 ? ' (tháng thiếu ngày → ngày cuối tháng)' : ''}`, cur)).join('');
    const row = 'display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.75rem;';
    const body = `
      <form onsubmit="AutoScheduleModule.save(event, ${Safe.js(existing ? existing.id : '')})" oninput="AutoScheduleModule.updatePreview()" onchange="AutoScheduleModule.updatePreview()">
        <input type="hidden" id="as-from-session" value="${Safe.html(v.fromSessionId || '')}">
        <div class="form-group">
          <label class="form-label font-bold">Tên buổi</label>
          <input type="text" id="as-title" class="form-control" maxlength="100" value="${Safe.html(v.title || '')}" required>
        </div>
        <div class="form-group">
          <label class="form-label font-bold">Lặp lại</label>
          <select id="as-repeat" class="form-select">
            ${opt('once', 'Một lần – ngày cụ thể', v.repeat)}
            ${opt('weekly', 'Hằng tuần – theo thứ', v.repeat)}
            ${opt('monthly', 'Hằng tháng – theo ngày', v.repeat)}
          </select>
          ${v.fromSessionId ? '<span class="text-secondary" style="font-size: 0.75rem;">Chọn “Một lần” để chỉ lặp lại vào tuần kế tiếp, “Hằng tuần” để lặp lại mãi.</span>' : ''}
        </div>
        <div style="${row}">
          <div class="form-group" data-as="once"><label class="form-label">Ngày đánh</label><input type="date" id="as-date" class="form-control" value="${Safe.html(v.date || '')}"></div>
          <div class="form-group" data-as="weekly"><label class="form-label">Thứ</label><select id="as-weekday" class="form-select">${weekdays(v.weekday)}</select></div>
          <div class="form-group" data-as="monthly"><label class="form-label">Ngày trong tháng</label><select id="as-monthday" class="form-select">${monthDays(v.monthDay)}</select></div>
          <div class="form-group"><label class="form-label">Bắt đầu</label><input type="time" id="as-start" class="form-control" value="${Safe.html(v.startTime)}" required></div>
          <div class="form-group"><label class="form-label">Kết thúc</label><input type="time" id="as-end" class="form-control" value="${Safe.html(v.endTime)}" required></div>
        </div>
        <div style="${row}" data-as="repeating">
          <div class="form-group"><label class="form-label">Áp dụng từ ngày (tùy chọn)</label><input type="date" id="as-from" class="form-control" value="${Safe.html(v.startFrom || '')}"></div>
          <div class="form-group"><label class="form-label">Đến ngày (tùy chọn)</label><input type="date" id="as-until" class="form-control" value="${Safe.html(v.until || '')}"></div>
        </div>
        <div style="${row}">
          <div class="form-group"><label class="form-label">Tên sân</label><input type="text" id="as-court" class="form-control" maxlength="150" value="${Safe.html(v.courtName || '')}"></div>
          <div class="form-group"><label class="form-label">Số sân</label><input type="text" id="as-court-numbers" class="form-control" maxlength="100" value="${Safe.html(v.courtNumbers || '')}"></div>
          <div class="form-group"><label class="form-label">Tiền sân (đ)</label><input type="number" id="as-price" class="form-control" min="0" step="1000" value="${Safe.html(String(v.courtPrice || ''))}"></div>
          <div class="form-group"><label class="form-label">Số người tối đa</label><input type="number" id="as-max" class="form-control" min="1" max="200" value="${Safe.html(String(v.maxPlayers || 12))}"></div>
        </div>
        <div class="form-group"><label class="form-label">Địa chỉ sân</label><input type="text" id="as-address" class="form-control" maxlength="300" value="${Safe.html(v.courtAddress || '')}"></div>
        <div style="background: var(--bg-input); padding: 0.85rem; border-radius: var(--radius-md); border: 1px solid var(--border-color); margin-bottom: 0.75rem;">
          <label class="form-label font-bold"><i class="fas fa-stopwatch text-primary"></i> Mở bình chọn</label>
          <div style="${row}">
            <div class="form-group">
              <select id="as-open-mode" class="form-select">
                ${opt('daysBefore', 'Trước buổi đánh N ngày', v.open.mode)}
                ${opt('weekday', 'Vào thứ cố định trong tuần', v.open.mode)}
                ${opt('monthday', 'Vào ngày cố định trong tháng', v.open.mode)}
                ${opt('at', 'Ngày giờ cụ thể (lịch một lần)', v.open.mode)}
                ${opt('now', 'Mở ngay khi buổi được tạo', v.open.mode)}
              </select>
            </div>
            <div class="form-group" data-open="daysBefore"><input type="number" id="as-open-days" class="form-control" min="0" max="60" value="${Safe.html(String(v.open.daysBefore || 0))}" title="Số ngày trước buổi đánh"></div>
            <div class="form-group" data-open="weekday"><select id="as-open-weekday" class="form-select">${weekdays(v.open.weekday)}</select></div>
            <div class="form-group" data-open="monthday"><select id="as-open-monthday" class="form-select">${monthDays(v.open.monthDay)}</select></div>
            <div class="form-group" data-open="at"><input type="datetime-local" id="as-open-at" class="form-control" value="${Safe.html(v.open.at || '')}"></div>
            <div class="form-group" data-open="time"><input type="time" id="as-open-time" class="form-control" value="${Safe.html(v.open.time || '08:00')}" title="Giờ mở"></div>
          </div>
        </div>
        ${VoteScheduler.renderEmailCheckbox('as-email', { emailNotify: v.emailNotify }, data.clubInfo)}
        <div id="as-preview" class="text-primary" style="font-size: 0.85rem; margin: 0.5rem 0;"></div>
        <div class="modal-footer" style="padding: 1rem 0 0 0; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.5rem;">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Đóng</button>
          <button type="submit" class="btn btn-primary"><i class="fas fa-save"></i> Lưu lịch</button>
        </div>
      </form>`;
    App.openModal(existing ? '🔁 Sửa lịch bình chọn tự động' : '🔁 Lịch bình chọn tự động', body);
    this._existing = existing || null;
    this.updatePreview();
  },

  _val(id) { return (document.getElementById(id)?.value || '').trim(); },

  // Đọc biểu mẫu -> đối tượng lịch (chưa kiểm tra)
  readForm(id) {
    const v = (k) => this._val(k);
    const repeat = v('as-repeat') || 'weekly';
    const mode = v('as-open-mode') || 'daysBefore';
    const open = { mode, time: v('as-open-time') || '08:00' };
    if (mode === 'daysBefore') open.daysBefore = Math.max(0, parseInt(v('as-open-days'), 10) || 0);
    if (mode === 'weekday') open.weekday = parseInt(v('as-open-weekday'), 10) || 0;
    if (mode === 'monthday') open.monthDay = parseInt(v('as-open-monthday'), 10) || 1;
    if (mode === 'at') { open.at = v('as-open-at').slice(0, 16); delete open.time; }
    if (mode === 'now') delete open.time;
    const user = AppStorage.getCurrentUser();
    const prev = this._existing || {};
    const s = {
      id, title: v('as-title') || 'Giao lưu cầu lông', enabled: prev.enabled !== false, repeat,
      startTime: v('as-start'), endTime: v('as-end'), open,
      courtName: v('as-court'), courtNumbers: v('as-court-numbers'), courtAddress: v('as-address'),
      courtPrice: parseInt(v('as-price'), 10) || 0, maxPlayers: parseInt(v('as-max'), 10) || 12,
      createdBy: prev.createdBy || (user ? user.username : ''), createdAt: prev.createdAt || Date.now(),
      updatedBy: user ? user.username : '', updatedAt: Date.now()
    };
    if (repeat === 'once') s.date = v('as-date');
    if (repeat === 'weekly') s.weekday = parseInt(v('as-weekday'), 10) || 0;
    if (repeat === 'monthly') s.monthDay = parseInt(v('as-monthday'), 10) || 1;
    if (repeat !== 'once') {
      if (v('as-from')) s.startFrom = v('as-from');
      if (v('as-until')) s.until = v('as-until');
    }
    ['mapUrl', 'shuttleType', 'note', 'sessionType'].forEach((k) => { if (prev[k]) s[k] = prev[k]; });
    const from = v('as-from-session');
    if (from) {
      s.fromSessionId = from;
      const src = (AppStorage.loadData().sessions || []).find((x) => x.id === from);
      if (src) {
        if (src.mapUrl && /^https:\/\//i.test(src.mapUrl)) s.mapUrl = src.mapUrl;
        if (src.shuttleType && src.shuttleType !== 'n/a') s.shuttleType = String(src.shuttleType).slice(0, 100);
        if (src.note) s.note = String(src.note).slice(0, 500);
        if (src.sessionType === 'guest') s.sessionType = 'guest';
      }
    }
    const email = VoteScheduler.readEmailCheckbox('as-email');
    if (email === false) s.emailNotify = false;
    else if (email === true) s.emailNotify = true;
    return s;
  },

  // Lỗi của lịch (chuỗi rỗng = hợp lệ)
  validate(s, now = Date.now()) {
    if (s.open.mode === 'at' && s.repeat !== 'once') return 'Mở vote theo ngày giờ cụ thể chỉ dùng cho lịch một lần.';
    if (s.repeat === 'once' && !s.date) return 'Hãy chọn ngày đánh.';
    if (s.open.mode === 'at' && !s.open.at) return 'Hãy chọn ngày giờ mở bình chọn.';
    if (!VotePlan.validSchedule(s, s.id)) return 'Thông tin lịch chưa hợp lệ (kiểm tra ngày, giờ, địa chỉ bản đồ phải là https://).';
    if (s.endTime <= s.startTime) return 'Giờ kết thúc phải sau giờ bắt đầu.';
    if (s.repeat === 'once') {
      const start = VotePlan.parseVn(`${s.date}T${s.startTime}`);
      if (start <= now) return 'Ngày giờ đánh phải ở tương lai.';
      if (s.open.mode === 'at' && !(VotePlan.parseVn(s.open.at) < start)) return 'Giờ mở bình chọn phải trước giờ bắt đầu buổi đánh.';
    }
    if (s.until && s.startFrom && s.until < s.startFrom) return '“Đến ngày” phải sau “Áp dụng từ ngày”.';
    if (!VotePlan.nextRun(s, now)) return 'Lịch không còn lần diễn ra nào trong thời gian tới.';
    return '';
  },

  updatePreview() {
    const repeat = this._val('as-repeat');
    const mode = this._val('as-open-mode');
    document.querySelectorAll('[data-as]').forEach((el) => {
      const k = el.getAttribute('data-as');
      el.style.display = (k === repeat || (k === 'repeating' && repeat !== 'once')) ? '' : 'none';
    });
    document.querySelectorAll('[data-open]').forEach((el) => {
      const k = el.getAttribute('data-open');
      el.style.display = (k === mode || (k === 'time' && mode !== 'at' && mode !== 'now')) ? '' : 'none';
    });
    const box = document.getElementById('as-preview');
    if (!box) return;
    const s = this.readForm(this._existing ? this._existing.id : 'vs_preview');
    const err = this.validate(s);
    if (err) {
      box.className = 'text-danger';
      box.textContent = '⚠️ ' + err;
      return;
    }
    const next = VotePlan.nextRun(s, Date.now());
    box.className = 'text-primary';
    box.textContent = `${VotePlan.describeRepeat(s)}. Lần tới: ${next.date.split('-').reverse().join('/')}, ` +
      (next.openAt ? `mở bình chọn lúc ${VotePlan.label(next.openAt)}.` : 'mở bình chọn ngay khi buổi được tạo.');
  },

  save(e, scheduleId) {
    if (e && e.preventDefault) e.preventDefault();
    if (!AppStorage.canScheduleVotes()) return;
    const id = scheduleId || `vs_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const s = this.readForm(id);
    const err = this.validate(s);
    if (err) {
      App.showToast(err, 'warning');
      return;
    }
    const data = AppStorage.loadData();
    data.clubInfo = data.clubInfo || {};
    const list = this.schedules(data).filter((x) => x.id !== id);
    const idx = this.schedules(data).findIndex((x) => x.id === id);
    if (idx === -1) list.push(s); else list.splice(idx, 0, s);
    data.clubInfo.voteSchedules = list;
    AppStorage.saveData(data);
    App.closeModal();
    const next = VotePlan.nextRun(s, Date.now());
    App.showToast(`🔁 Đã lưu lịch. Lần tới ${next.date.split('-').reverse().join('/')}` +
      (next.openAt ? `, mở bình chọn lúc ${VotePlan.label(next.openAt)}` : ''), 'success');
    this.refresh();
  },

  _update(scheduleId, fn) {
    if (!AppStorage.canScheduleVotes()) return false;
    const data = AppStorage.loadData();
    const list = this.schedules(data);
    const s = list.find((x) => x.id === scheduleId);
    if (!s) return false;
    const keep = fn(s, list);
    data.clubInfo.voteSchedules = keep || list;
    AppStorage.saveData(data);
    this.refresh();
    return true;
  },

  toggle(scheduleId) {
    const user = AppStorage.getCurrentUser();
    this._update(scheduleId, (s) => {
      s.enabled = !s.enabled;
      s.updatedBy = user ? user.username : '';
      s.updatedAt = Date.now();
      App.showToast(s.enabled ? '▶️ Đã bật lại lịch' : '⏸️ Đã tạm dừng lịch', 'info');
    });
  },

  async remove(scheduleId) {
    if (!(await App.confirm('Xóa lịch bình chọn tự động này? Các buổi đã tạo vẫn được giữ nguyên.'))) return;
    if (this._update(scheduleId, (s, list) => list.filter((x) => x.id !== scheduleId))) App.showToast('🗑️ Đã xóa lịch', 'success');
  }
};

window.AutoScheduleModule = AutoScheduleModule;
;

// ===== js/modules/roles.js =====
// RolesModule - Vai trò tùy chỉnh & phân quyền (chỉ Admin)
// - Vai trò lưu ở clubInfo.roles: [{ id, name, perms: ['schedule'|'members'|'finance'] }]
// - Gán cho người dùng bằng users[].roleId (hộp thoại sửa thành viên). Máy chủ kiểm quyền thật; giao diện chỉ ẩn/hiện nút.
// - Admin/Thủ quỹ hệ thống luôn có đủ quyền; vai trò tùy chỉnh không bao giờ cấp quyền Cài đặt, sao lưu hay đặt lại mật khẩu.
const RolesModule = {
  MAX_ROLES: 20,
  NAME_MAX: 40,
  DESCRIPTIONS: {
    schedule: 'Tạo/sửa/xóa buổi đánh, đổi trạng thái, lịch bình chọn tự động',
    members: 'Thêm/sửa/xóa thành viên thường (không cấp tài khoản, không đổi vai trò)',
    finance: 'Thu quỹ, duyệt đóng quỹ, sổ thu chi, chia tiền sân'
  },

  roles() {
    const list = (AppStorage.loadData().clubInfo || {}).roles;
    return Array.isArray(list) ? list.filter((r) => r && r.id && r.name) : [];
  },

  holders(roleId, data) {
    return (data.users || []).filter((u) => u.roleId === roleId);
  },

  renderPanel() {
    const box = document.getElementById('roles-panel');
    if (!box) return;
    if (!AppStorage.isSuperAdmin()) { box.innerHTML = ''; return; }
    const data = AppStorage.loadData();
    const rows = this.roles().map((r) => {
      const n = this.holders(r.id, data).length;
      const perms = (r.perms || []).map((p) => `<span class="badge badge-info" style="font-size: 0.68rem;">${Safe.html(AppStorage.PERM_LABELS[p] || p)}</span>`).join(' ') || '<span class="text-secondary" style="font-size: 0.78rem;">Chưa có quyền nào</span>';
      return `
        <div class="flex items-center justify-between" style="gap: 0.75rem; padding: 0.6rem 0; border-top: 1px solid var(--border-color); flex-wrap: wrap;">
          <div style="min-width: 0; flex: 1;">
            <div class="font-bold">🎖️ ${Safe.html(r.name)} <span class="text-secondary" style="font-size: 0.78rem; font-weight: 400;">• ${n} người</span></div>
            <div style="display: flex; gap: 0.3rem; flex-wrap: wrap; margin-top: 0.25rem;">${perms}</div>
          </div>
          <div class="flex" style="gap: 0.4rem;">
            <button class="btn btn-secondary btn-sm" onclick="RolesModule.openEditor(${Safe.js(r.id)})" title="Sửa"><i class="fas fa-pen"></i></button>
            <button class="btn btn-outline-danger btn-sm" onclick="RolesModule.remove(${Safe.js(r.id)})" title="Xóa vai trò"><i class="fas fa-trash-alt"></i></button>
          </div>
        </div>`;
    }).join('');
    box.innerHTML = `
      <div class="card" style="padding: 1rem 1.25rem; margin-bottom: 1rem;">
        <div class="flex items-center justify-between" style="gap: 0.75rem; flex-wrap: wrap;">
          <div class="font-bold"><i class="fas fa-user-shield text-primary"></i> Vai trò & quyền (${this.roles().length})</div>
          <button class="btn btn-primary btn-sm" onclick="RolesModule.openEditor()"><i class="fas fa-plus"></i> Thêm vai trò</button>
        </div>
        <div class="text-secondary" style="font-size: 0.8rem; margin-top: 0.35rem;">Tự đặt tên vai trò (VD: "Thư ký", "Kế toán") và chọn quyền được giao, rồi gán cho thành viên trong hộp thoại sửa thành viên. Các quyền Cài đặt, sao lưu, đặt lại mật khẩu luôn chỉ thuộc Admin.</div>
        ${rows || '<div class="text-secondary" style="font-size: 0.82rem; margin-top: 0.5rem;">Chưa có vai trò tùy chỉnh.</div>'}
        <div style="border-top: 1px solid var(--border-color); margin-top: 0.75rem; padding-top: 0.75rem;">
          <button class="btn btn-secondary btn-sm" onclick="RolesModule.openAudit()"><i class="fas fa-clipboard-list"></i> Nhật ký thao tác</button>
          <span class="text-secondary" style="font-size: 0.78rem; margin-left: 0.4rem;">Ai đã sửa gì (chỉ Ban quản trị và người được giao quyền; không lưu nội dung).</span>
        </div>
      </div>`;
  },

  async openAudit() {
    if (!AppStorage.isSuperAdmin() || AppStorage.isLocalOnly()) { App.showToast('Nhật ký chỉ có khi kết nối máy chủ.', 'info'); return; }
    App.openModal('📋 Nhật ký thao tác', '<div class="text-secondary">Đang tải…</div>', true);
    const session = AppStorage._readSession();
    const res = await AppStorage._authRequest({ action: 'auditList', token: session && session.token });
    const body = document.getElementById('global-modal-body');
    if (!body) return;
    if (res.status !== 'ok') { body.innerHTML = `<div class="text-secondary">⚠️ ${Safe.html(res.message || 'Không tải được nhật ký.')}</div>`; return; }
    const names = { sessions: 'Buổi đánh', members: 'Thành viên', users: 'Tài khoản', transactions: 'Sổ quỹ', monthlyContributions: 'Quỹ tháng', club: 'Cài đặt CLB' };
    const ops = { put: 'Thêm/ghi đè', patch: 'Sửa', del: 'Xóa', reset: 'Đặt lại' };
    body.innerHTML = (res.entries || []).length ? `
      <div style="overflow-x: auto;"><table class="table" style="width: 100%; font-size: 0.8rem;">
        <thead><tr><th>Thời gian</th><th>Người làm</th><th>Thao tác</th><th>Đối tượng</th><th>Trường</th></tr></thead>
        <tbody>${res.entries.map((e) => `<tr><td>${Safe.html(e.at)}</td><td>${Safe.html(e.user)}<br><span class="text-secondary">${Safe.html(e.role)}</span></td><td>${Safe.html(ops[e.op] || e.op)}</td><td>${Safe.html(names[e.col] || e.col)}<br><span class="text-secondary">${Safe.html(e.key)}</span></td><td>${Safe.html(e.fields)}</td></tr>`).join('')}</tbody>
      </table></div>` : '<div class="text-secondary">Chưa có thao tác nào được ghi.</div>';
  },

  openEditor(roleId = null) {
    if (!AppStorage.isSuperAdmin()) return;
    const role = roleId ? this.roles().find((r) => r.id === roleId) : null;
    if (roleId && !role) return;
    const has = (p) => !!(role && (role.perms || []).includes(p));
    const body = `
      <form onsubmit="RolesModule.save(event, ${Safe.js(roleId || '')})">
        <div class="form-group">
          <label class="form-label font-bold" for="role-name">Tên vai trò *</label>
          <input type="text" id="role-name" class="form-control" maxlength="${this.NAME_MAX}" value="${Safe.html(role ? role.name : '')}" placeholder="VD: Thư ký, Kế toán, Phụ trách lịch" required>
        </div>
        <div class="form-group">
          <label class="form-label font-bold">Quyền được giao</label>
          ${AppStorage.PERMS.map((p) => `
            <label style="display: flex; align-items: flex-start; gap: 0.5rem; font-size: 0.85rem; cursor: pointer; margin-bottom: 0.5rem;">
              <input type="checkbox" class="role-perm" value="${p}" ${has(p) ? 'checked' : ''} style="margin-top: 0.2rem;">
              <span><b>${Safe.html(AppStorage.PERM_LABELS[p])}</b><br><span class="text-secondary" style="font-size: 0.78rem;">${Safe.html(this.DESCRIPTIONS[p])}</span></span>
            </label>`).join('')}
        </div>
        <div class="flex gap-2" style="justify-content: flex-end;">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Hủy</button>
          <button type="submit" class="btn btn-primary"><i class="fas fa-save"></i> Lưu vai trò</button>
        </div>
      </form>`;
    App.openModal(role ? '🎖️ Sửa vai trò' : '🎖️ Thêm vai trò', body);
  },

  save(e, roleId) {
    if (e && e.preventDefault) e.preventDefault();
    if (!AppStorage.isSuperAdmin()) return;
    const name = (document.getElementById('role-name')?.value || '').trim().slice(0, this.NAME_MAX);
    if (!name) { App.showToast('Vui lòng nhập tên vai trò.', 'warning'); return; }
    const perms = Array.from(document.querySelectorAll('.role-perm:checked')).map((el) => el.value).filter((p) => AppStorage.PERMS.includes(p));
    const data = AppStorage.loadData();
    data.clubInfo = data.clubInfo || {};
    const list = this.roles();
    const lower = name.toLowerCase();
    if (list.some((r) => r.id !== roleId && r.name.trim().toLowerCase() === lower)) { App.showToast('Đã có vai trò trùng tên.', 'warning'); return; }
    if (!roleId && list.length >= this.MAX_ROLES) { App.showToast(`Tối đa ${this.MAX_ROLES} vai trò.`, 'warning'); return; }
    const id = roleId || `role_${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    const next = { id, name, perms };
    const idx = list.findIndex((r) => r.id === id);
    if (idx === -1) list.push(next); else list[idx] = next;
    data.clubInfo.roles = list;
    AppStorage.saveData(data);
    App.closeModal();
    App.showToast(`🎖️ Đã lưu vai trò "${name}".`, 'success');
    this.renderPanel();
    if (window.App && App.renderUserHeaderAndSidebar) App.renderUserHeaderAndSidebar();
  },

  async remove(roleId) {
    if (!AppStorage.isSuperAdmin()) return;
    const data = AppStorage.loadData();
    const role = this.roles().find((r) => r.id === roleId);
    if (!role) return;
    const holders = this.holders(roleId, data);
    if (!(await App.confirm(`Xóa vai trò "${role.name}"?` + (holders.length ? `\n${holders.length} người đang giữ vai trò này sẽ mất các quyền được giao.` : '')))) return;
    holders.forEach((u) => { delete u.roleId; });
    data.clubInfo.roles = this.roles().filter((r) => r.id !== roleId);
    AppStorage.saveData(data);
    App.showToast('🗑️ Đã xóa vai trò.', 'success');
    this.renderPanel();
  }
};

window.RolesModule = RolesModule;
;

// ===== js/modules/utilities.js =====
// UtilitiesModule - Tiện ích cho người dùng
//  1) Thêm buổi đánh vào lịch điện thoại (.ics) hoặc Google Calendar
//  2) Danh sách dự bị khi vượt sức chứa (suy ra từ thứ tự bình chọn, không lưu thêm dữ liệu)
//  3) Chuyên cần 90 ngày: ai đi nhiều nhất (dựa trên bình chọn "đi" ở buổi đã kết thúc; chưa phải điểm danh thực tế)
//  4) Nút "Cài ứng dụng" (PWA) cho Android/Chrome và hướng dẫn cho iPhone
const UtilitiesModule = {
  _installEvent: null,
  _debounce: null,

  init() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this._installEvent = e;
      this.renderInstall();
    });
    window.addEventListener('appinstalled', () => { this._installEvent = null; this.renderInstall(); });
    window.addEventListener('app-state-changed', () => {
      clearTimeout(this._debounce);
      this._debounce = setTimeout(() => this.renderAttendanceCard(), 500);
    });
    setTimeout(() => { this.renderInstall(); this.renderAttendanceCard(); }, 1200);
  },

  // ---------------- 1) Thêm vào lịch ----------------
  _vnParts(dateStr, timeStr) {
    const d = String(dateStr || '').replace(/-/g, '');
    const t = String(timeStr || '18:00').replace(':', '').slice(0, 4).padEnd(4, '0');
    return /^\d{8}$/.test(d) ? `${d}T${t}00` : '';
  },

  _icsEscape(s) {
    return String(s || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
  },

  // Gấp dòng theo RFC 5545 (tối đa 75 byte/dòng; xấp xỉ theo ký tự là đủ cho trình xem lịch phổ biến)
  _fold(line) {
    const out = [];
    let rest = line;
    while (rest.length > 74) { out.push(rest.slice(0, 74)); rest = ' ' + rest.slice(74); }
    out.push(rest);
    return out.join('\r\n');
  },

  buildIcs(session, club) {
    const start = this._vnParts(session.date, session.startTime);
    if (!start) return '';
    const end = this._vnParts(session.date, session.endTime || session.startTime) || start;
    const where = [session.courtName, session.courtNumbers && `(${session.courtNumbers})`, session.courtAddress].filter(Boolean).join(' ');
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SMASH PRO//Lich dat san//VI', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${String(session.id).replace(/[^A-Za-z0-9_.-]/g, '')}@smash-pro`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}`,
      `DTSTART;TZID=Asia/Ho_Chi_Minh:${start}`,
      `DTEND;TZID=Asia/Ho_Chi_Minh:${end}`,
      `SUMMARY:${this._icsEscape(`${(club && club.name) || 'CLB'}: ${session.title || 'Buổi đánh cầu lông'}`)}`,
      where ? `LOCATION:${this._icsEscape(where)}` : '',
      session.note ? `DESCRIPTION:${this._icsEscape(session.note)}` : '',
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Sắp tới giờ đánh cầu', 'TRIGGER:-PT2H', 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR'
    ].filter(Boolean);
    return lines.map((l) => this._fold(l)).join('\r\n') + '\r\n';
  },

  googleCalendarUrl(session, club) {
    const s = this._vnParts(session.date, session.startTime), e = this._vnParts(session.date, session.endTime || session.startTime) || s;
    if (!s) return '';
    const q = new URLSearchParams({
      action: 'TEMPLATE', text: `${(club && club.name) || 'CLB'}: ${session.title || 'Buổi đánh cầu lông'}`, dates: `${s}/${e}`, ctz: 'Asia/Ho_Chi_Minh',
      location: [session.courtName, session.courtAddress].filter(Boolean).join(', '), details: session.note || ''
    });
    return `https://calendar.google.com/calendar/render?${q.toString()}`;
  },

  addToCalendar(sessionId) {
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find((s) => s.id === sessionId);
    if (!session) return;
    const ics = this.buildIcs(session, data.clubInfo);
    if (!ics) { App.showToast('Buổi này chưa có ngày/giờ hợp lệ để thêm vào lịch.', 'warning'); return; }
    const gUrl = this.googleCalendarUrl(session, data.clubInfo);
    App.openModal('📅 Thêm vào lịch', `
      <p class="text-secondary" style="font-size: 0.85rem; margin-bottom: 1rem;">${Safe.html(session.title)} • ${Safe.html(session.date)} ${Safe.html(session.startTime || '')}</p>
      <div style="display: grid; gap: 0.6rem;">
        <button type="button" class="btn btn-primary" onclick="UtilitiesModule.downloadIcs(${Safe.js(session.id)})"><i class="fas fa-download"></i> Tải tệp lịch (.ics) — iPhone, Outlook, Android</button>
        ${gUrl ? `<a class="btn btn-secondary" href="${Safe.url(gUrl)}" target="_blank" rel="noopener"><i class="fab fa-google"></i> Mở Google Calendar</a>` : ''}
        <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Đóng</button>
      </div>`);
  },

  downloadIcs(sessionId) {
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find((s) => s.id === sessionId);
    if (!session) return;
    const blob = new Blob([this.buildIcs(session, data.clubInfo)], { type: 'text/calendar;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `buoi-danh-${String(session.date || '').replace(/[^0-9-]/g, '')}.ics`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    App.closeModal();
    App.showToast('Đã tải tệp lịch. Mở tệp để thêm vào lịch của bạn.', 'success');
  },

  // ---------------- 2) Danh sách dự bị ----------------
  // Người đăng ký sớm hơn được ưu tiên; một lượt đăng ký gồm cả khách mang theo nên phải vừa nguyên cả nhóm.
  splitByCapacity(goingVotes, max) {
    const cap = Math.max(1, Number(max) || 1);
    const sorted = (goingVotes || []).slice().sort((a, b) => String(a.votedAt || '').localeCompare(String(b.votedAt || '')));
    let used = 0;
    const confirmed = [], waitlist = [];
    sorted.forEach((v) => {
      const size = 1 + Math.max(0, Number(v.guests) || 0);
      if (waitlist.length === 0 && used + size <= cap) { confirmed.push(v); used += size; } else { waitlist.push(v); }
    });
    return { confirmed, waitlist, used };
  },

  waitlistHtml(session, goingVotes, members) {
    if (!session || session.voteMode === 'multi_option') return '';
    const { waitlist } = this.splitByCapacity(goingVotes, session.maxPlayers);
    if (!waitlist.length) return '';
    const nameOf = (v) => {
      const m = (members || []).find((x) => x.id === v.memberId);
      return m ? m.name : 'Thành viên';
    };
    return `
      <div style="margin-top: 0.85rem; padding: 0.7rem 0.85rem; border-radius: var(--radius-md); background: var(--bg-input); border: 1px dashed var(--warning, #f59e0b); font-size: 0.82rem;">
        <b>⏳ Danh sách dự bị (${waitlist.length})</b> — đăng ký sau khi đã đủ ${Safe.html(session.maxPlayers)} chỗ. Nếu có người hủy, người đứng đầu danh sách dự bị được vào sân:
        <ol style="margin: 0.4rem 0 0 1.1rem; padding: 0;">${waitlist.map((v) => `<li>${Safe.html(nameOf(v))}${v.guests ? ` (+${Safe.html(v.guests)} khách)` : ''}</li>`).join('')}</ol>
      </div>`;
  },

  // ---------------- 3) Chuyên cần ----------------
  attendance(data, days = 90, now = Date.now()) {
    const since = now - days * 86400000;
    const done = (data.sessions || []).filter((s) => {
      if (!s || s.status === 'cancelled' || s.voteMode === 'multi_option') return false;
      const end = ScheduleModule.parseSessionDateTime(s.date, s.endTime || '23:59').getTime();
      return end < now && end >= since;
    });
    const counts = new Map();
    done.forEach((s) => {
      const seen = new Set();
      (s.votes || []).forEach((v) => {
        if (v && v.status === 'going' && v.memberId && !seen.has(v.memberId)) { seen.add(v.memberId); counts.set(v.memberId, (counts.get(v.memberId) || 0) + 1); }
      });
    });
    const byId = new Map((data.members || []).map((m) => [m.id, m]));
    const rows = Array.from(counts.entries()).map(([id, n]) => ({ memberId: id, name: (byId.get(id) || {}).name || 'Thành viên', count: n, rate: done.length ? Math.round((n / done.length) * 100) : 0 }))
      .filter((r) => byId.has(r.memberId))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'vi'));
    return { total: done.length, rows, days };
  },

  renderAttendanceCard() {
    const box = document.getElementById('dashboard-attendance');
    if (!box) return;
    const user = AppStorage.getCurrentUser();
    if (!user || AppStorage.isGuest()) { box.innerHTML = ''; return; }
    const data = AppStorage.loadData();
    const att = this.attendance(data);
    if (!att.total) { box.innerHTML = ''; return; }
    const mine = att.rows.find((r) => r.memberId === user.memberId);
    const medal = ['🥇', '🥈', '🥉'];
    box.innerHTML = `
      <div class="card" style="margin-bottom: 2rem;">
        <div class="card-header">
          <h2 class="card-title"><i class="fas fa-medal text-warning"></i> Chuyên cần ${att.days} ngày qua</h2>
          <span class="text-secondary" style="font-size: 0.8rem;">${att.total} buổi đã diễn ra</span>
        </div>
        <div style="padding: 0 1.25rem 1.1rem;">
          <div class="text-secondary" style="font-size: 0.8rem; margin-bottom: 0.6rem;">${mine ? `Bạn đã đăng ký đi <b>${mine.count}/${att.total}</b> buổi (${mine.rate}%).` : 'Bạn chưa đăng ký đi buổi nào trong giai đoạn này.'} <i>Tính theo bình chọn "đi"; chưa phải điểm danh tại sân.</i></div>
          ${att.rows.slice(0, 5).map((r, i) => `
            <div class="flex items-center justify-between" style="gap: 0.5rem; padding: 0.3rem 0; border-top: 1px dashed var(--border-color); font-size: 0.88rem;">
              <span>${medal[i] || `${i + 1}.`} ${Safe.html(r.name)}</span>
              <span class="text-secondary"><b>${r.count}</b> buổi • ${r.rate}%</span>
            </div>`).join('')}
        </div>
      </div>`;
  },

  // ---------------- 4) Cài ứng dụng ----------------
  _isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  },

  _isIos() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent || '') && !window.MSStream;
  },

  renderInstall() {
    const box = document.getElementById('install-app-wrapper');
    if (!box) return;
    if (this._isStandalone() || !(this._installEvent || this._isIos())) { box.innerHTML = ''; return; }
    box.innerHTML = `<button type="button" class="btn btn-secondary btn-sm w-full" style="justify-content: center;" onclick="UtilitiesModule.install()"><i class="fas fa-mobile-alt"></i> Cài ứng dụng lên máy</button>`;
  },

  async install() {
    if (this._installEvent) {
      const ev = this._installEvent;
      this._installEvent = null;
      try {
        await ev.prompt();
        await ev.userChoice;
      } catch (e) { /* người dùng đóng hộp thoại hoặc trình duyệt không cho hiện */ }
      this.renderInstall();
      return;
    }
    App.openModal('📲 Cài ứng dụng trên iPhone / iPad', `
      <ol style="padding-left: 1.2rem; line-height: 1.7; font-size: 0.92rem;">
        <li>Mở trang này bằng <b>Safari</b>.</li>
        <li>Bấm nút <b>Chia sẻ</b> (hình vuông có mũi tên lên).</li>
        <li>Chọn <b>Thêm vào Màn hình chính</b>.</li>
        <li>Mở ứng dụng từ biểu tượng mới. Thông báo đẩy trên iPhone chỉ hoạt động khi đã cài như vậy (iOS 16.4 trở lên).</li>
      </ol>
      <div style="text-align: right;"><button type="button" class="btn btn-secondary" onclick="App.closeModal()">Đóng</button></div>`);
  }
};

window.UtilitiesModule = UtilitiesModule;
;

// ===== js/modules/google-auth.js =====
// GoogleAuth - Đăng nhập / đăng ký / liên kết tài khoản bằng Google (Google Identity Services)
// - Trình duyệt chỉ lấy ID token từ Google rồi gửi lên máy chủ; máy chủ xác minh với Google và cấp phiên như đăng nhập thường.
// - Tài khoản cũ chỉ liên kết CHỦ ĐỘNG trong Hồ sơ cá nhân khi đang đăng nhập (không tự gộp theo email).
// - Chế độ chạy cục bộ (không có máy chủ) không hỗ trợ đăng nhập Google.
const GoogleAuth = {
  CLIENT_ID: '835885994516-bvdlen23vircg4tmvfj18msrssf0r43u.apps.googleusercontent.com',
  SCRIPT_URL: 'https://accounts.google.com/gsi/client',
  _mode: 'login',
  _ready: false,
  _loading: null,
  _pendingCredential: null,

  available() {
    return !!this.CLIENT_ID && !AppStorage.isLocalOnly();
  },

  _load() {
    if (window.google && google.accounts && google.accounts.id) return Promise.resolve();
    if (this._loading) return this._loading;
    this._loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = this.SCRIPT_URL;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { this._loading = null; reject(new Error('Không tải được Google Sign-In')); };
      document.head.appendChild(s);
    });
    return this._loading;
  },

  async _init() {
    await this._load();
    if (this._ready) return;
    google.accounts.id.initialize({
      client_id: this.CLIENT_ID,
      callback: (resp) => this._onCredential(resp),
      auto_select: false,
      cancel_on_tap_outside: true,
      ux_mode: 'popup'
    });
    this._ready = true;
  },

  // Vẽ nút Google vào các phần tử; mode: 'login' (đăng nhập/đăng ký) | 'link' (liên kết trong Hồ sơ)
  async renderButtons(ids, mode, text = 'continue_with') {
    const els = ids.map((id) => document.getElementById(id)).filter(Boolean);
    const wraps = els.map((el) => el.closest('[data-google-wrap]') || el);
    if (!this.available()) {
      wraps.forEach((w) => { w.style.display = 'none'; });
      return false;
    }
    try {
      await this._init();
    } catch (e) {
      els.forEach((el) => { el.innerHTML = '<span class="text-secondary" style="font-size: 0.8rem;">Không tải được nút Google (kiểm tra mạng).</span>'; });
      return false;
    }
    this._mode = mode;
    const dark = document.documentElement.getAttribute('data-theme') === 'dark' || document.body.classList.contains('dark-theme');
    els.forEach((el) => {
      el.innerHTML = '';
      google.accounts.id.renderButton(el, {
        type: 'standard', theme: dark ? 'filled_black' : 'outline', size: 'large', shape: 'pill',
        text, logo_alignment: 'center', locale: 'vi', width: 300
      });
    });
    wraps.forEach((w) => { w.style.display = ''; });
    return true;
  },

  renderAuthButtons() {
    return this.renderButtons(['google-login-btn', 'google-register-btn'], 'login', 'continue_with');
  },

  async _onCredential(resp) {
    const credential = resp && resp.credential;
    if (!credential) return;
    if (this._mode === 'link') return this._link(credential);
    const remember = document.getElementById('auth-login-remember')?.checked ?? true;
    const res = await AppStorage.googleLogin(credential, remember);
    if (res.success) return App.onLoginSuccess(res);
    if (res.notLinked) return this._offerRegister(credential, res, remember);
    App.showToast(res.message, 'error');
  },

  // Google chưa liên kết: tạo tài khoản mới, hoặc hướng dẫn liên kết với tài khoản cũ
  _offerRegister(credential, res, remember) {
    this._pendingCredential = { credential, remember };
    App.closeAuthModal();
    const body = res.emailInUse ? `
      <p style="font-size: 0.9rem;">${Safe.html(res.message)}</p>
      <ol class="text-secondary" style="font-size: 0.85rem; padding-left: 1.2rem; margin: 0.75rem 0;">
        <li>Đăng nhập bằng tên đăng nhập/SĐT và mật khẩu.</li>
        <li>Mở <b>Hồ sơ cá nhân</b> → <b>Liên kết Google</b>.</li>
      </ol>
      <div class="modal-footer" style="padding: 1rem 0 0 0; display: flex; justify-content: flex-end; gap: 0.5rem;">
        <button type="button" class="btn btn-primary" onclick="App.closeModal(); App.showAuthModal('login')"><i class="fas fa-sign-in-alt"></i> Đăng nhập bằng mật khẩu</button>
      </div>` : `
      <p style="font-size: 0.9rem; margin-bottom: 0.75rem;">Tài khoản Google <b>${Safe.html(res.email)}</b> chưa có trong CLB.</p>
      <div style="display: grid; gap: 0.75rem;">
        <div style="border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 0.85rem;">
          <div class="font-bold" style="margin-bottom: 0.4rem;"><i class="fas fa-user-plus text-primary"></i> Tạo tài khoản mới bằng Google</div>
          <select id="google-reg-type" class="form-select" style="margin-bottom: 0.5rem;">
            <option value="fixed">🏸 Xin làm thành viên cố định (Ban quản trị duyệt)</option>
            <option value="guest">⚡ Vãng lai</option>
          </select>
          <button type="button" class="btn btn-primary w-full" style="justify-content: center;" onclick="GoogleAuth.confirmRegister()"><i class="fab fa-google"></i> Tạo tài khoản</button>
        </div>
        <div class="text-secondary" style="font-size: 0.82rem;">
          <b>Đã có tài khoản CLB?</b> Đừng tạo mới — hãy <a href="#" onclick="App.closeModal(); App.showAuthModal('login'); return false;">đăng nhập bằng mật khẩu</a>
          rồi vào <b>Hồ sơ cá nhân → Liên kết Google</b>.
        </div>
      </div>`;
    App.openModal('🔐 Đăng nhập bằng Google', body);
  },

  async confirmRegister() {
    const p = this._pendingCredential;
    if (!p) return;
    const type = document.getElementById('google-reg-type')?.value || 'fixed';
    const res = await AppStorage.googleRegister(p.credential, type, p.remember);
    this._pendingCredential = null;
    if (!res.success) {
      App.showToast(res.message, 'error');
      return;
    }
    App.closeModal();
    App.onLoginSuccess(res);
  },

  async _link(credential) {
    const res = await AppStorage.googleLink(credential);
    App.showToast(res.message, res.success ? 'success' : 'error');
    if (res.success && App.openUserProfileModal) App.openUserProfileModal();
  },

  async unlink() {
    if (!(await App.confirm('Hủy liên kết Google? Sau đó bạn chỉ đăng nhập được bằng mật khẩu.'))) return;
    const res = await AppStorage.googleUnlink();
    App.showToast(res.message, res.success ? 'success' : 'error');
    if (res.success && App.openUserProfileModal) App.openUserProfileModal();
  },

  // Khung trong Hồ sơ cá nhân
  renderProfileSection(user) {
    if (!this.available() || !user) return '';
    const linked = user.googleLinked === true;
    return `
        <div style="background: var(--bg-input); padding: 1rem; border-radius: var(--radius-md); border: 1px solid var(--border-color); margin-top: 1rem;">
          <div style="font-weight: 700; font-size: 0.88rem; margin-bottom: 0.4rem; display: flex; align-items: center; gap: 0.4rem;">
            <i class="fab fa-google text-primary"></i> Đăng nhập bằng Google
          </div>
          ${linked ? `
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; flex-wrap: wrap; font-size: 0.85rem;">
            <span>✅ Đã liên kết: <b>${Safe.html(user.googleEmail || '')}</b></span>
            <button type="button" class="btn btn-secondary btn-sm" onclick="GoogleAuth.unlink()" ${user.googleOnly ? 'disabled title="Hãy đặt mật khẩu trước khi hủy liên kết"' : ''}>Hủy liên kết</button>
          </div>
          ${user.googleOnly ? '<div class="text-secondary" style="font-size: 0.76rem; margin-top: 0.35rem;">Tài khoản tạo bằng Google, chưa có mật khẩu. Có thể đặt mật khẩu ở dưới để đăng nhập cả hai cách.</div>' : ''}` : `
          <div class="text-secondary" style="font-size: 0.76rem; margin-bottom: 0.6rem;">Liên kết tài khoản Google của bạn để lần sau đăng nhập bằng một chạm (không cần nhớ mật khẩu).</div>
          <div id="google-link-btn" style="min-height: 44px;"></div>`}
        </div>`;
  }
};

window.GoogleAuth = GoogleAuth;
;

// ===== js/transfer-code.js =====
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
;

// ===== js/payment-match.js =====
// PaymentMatch - Đối chiếu chữ đọc được từ ảnh biên lai chuyển khoản với khoản phải đóng (logic thuần, không phụ thuộc OCR).
//
// Đầu vào: text (chuỗi OCR) và expected = { amount, code, bank: { accountNo, accountName }, monthStart (Date), now (Date) }.
// Kết quả state:
//   'match'      - số tiền ĐÚNG + mã chuyển khoản ĐÚNG + thấy tài khoản/tên nhận + ngày hợp lý
//   'review'     - có dấu hiệu đúng nhưng thiếu/lệch một vài yếu tố -> Ban quản trị xem ảnh rồi quyết định
//   'mismatch'   - đọc được số tiền nhưng không khớp và không thấy mã chuyển khoản
//   'unreadable' - không đọc được số tiền lẫn mã (ảnh mờ/cắt/không phải biên lai)
// LƯU Ý: đây chỉ là kiểm tra TÍNH NHẤT QUÁN của ảnh. Ảnh có thể bị chỉnh sửa; kết quả "match" KHÔNG chứng minh tiền đã
// vào tài khoản. Muốn chắc chắn tuyệt đối phải đối chiếu sao kê ngân hàng.
const PaymentMatch = {
  STATES: {
    match: { label: 'Khớp', icon: 'fa-check-double', cls: 'badge-paid' },
    review: { label: 'Cần kiểm tra', icon: 'fa-search', cls: 'badge-pending' },
    mismatch: { label: 'Không khớp', icon: 'fa-times-circle', cls: 'badge-unpaid' },
    unreadable: { label: 'Không đọc được', icon: 'fa-eye-slash', cls: 'badge-neutral' }
  },

  norm(text) {
    return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toUpperCase();
  },

  editDistance(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  },

  // Nội dung chuyển khoản chuẩn: "<TÊN NGẮN CLB> <MÃ> T<tháng>" - ngắn, không dấu, bank nào cũng giữ nguyên
  memoFor(info, code, month) {
    const raw = this.norm((info && (info.shortName || info.name)) || 'SMASH').replace(/[^A-Z0-9 ]/g, ' ').trim();
    const prefix = (raw.split(/\s+/)[0] || 'SMASH').slice(0, 8);
    const mm = String(month || '').slice(5, 7);
    return [prefix, code, mm ? 'T' + Number(mm) : ''].filter(Boolean).join(' ');
  },

  // Các số tiền xuất hiện trong ảnh (số nguyên VNĐ), kể cả dạng 100.000 / 100,000 / 100 000 / 100000
  amountCandidates(t) {
    const out = [];
    const re = /(\d{1,3}(?:[.,  ]\d{3})+|\d{4,})(?!\d)/g;
    let m;
    while ((m = re.exec(t))) {
      const value = parseInt(m[1].replace(/[^0-9]/g, ''), 10);
      if (value >= 1000 && value <= 1000000000 && out.indexOf(value) === -1) out.push(value);
    }
    return out;
  },

  findCode(t, code) {
    if (!code) return 'none';
    const squashed = t.replace(/[^A-Z0-9]/g, '');
    if (squashed.indexOf(code) !== -1) return 'exact';
    const tokens = t.split(/[^A-Z0-9]+/).filter(Boolean);
    for (const tok of tokens) {
      if (Math.abs(tok.length - code.length) <= 1 && tok.length >= code.length - 1 && this.editDistance(tok, code) <= 1) return 'fuzzy';
    }
    return 'none';
  },

  findReceiver(t, bank) {
    if (!bank) return { status: 'none' };
    const acc = String(bank.accountNo || '').replace(/\D/g, '');
    const digits = t.replace(/[^0-9]/g, '');
    if (acc.length >= 6 && digits.indexOf(acc) !== -1) return { status: 'exact' };
    if (acc.length >= 6) {
      const last4 = acc.slice(-4);
      if (new RegExp('[*X•]{2,}\\s*' + last4).test(t)) return { status: 'masked' };
    }
    const words = this.norm(bank.accountName || '').split(/[^A-Z0-9]+/).filter((w) => w.length >= 2);
    if (words.length >= 2) {
      const hit = words.filter((w) => t.indexOf(w) !== -1).length;
      if (hit / words.length >= 0.7) return { status: 'name' };
    }
    return { status: 'none' };
  },

  findDates(t) {
    const out = [];
    const push = (y, mo, d) => {
      y = Number(y); mo = Number(mo); d = Number(d);
      if (y >= 2020 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) out.push(new Date(Date.UTC(y, mo - 1, d)));
    };
    let m;
    const dmy = /(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(20\d{2})/g;
    while ((m = dmy.exec(t))) push(m[3], m[2], m[1]);
    const ymd = /(20\d{2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{1,2})/g;
    while ((m = ymd.exec(t))) push(m[1], m[2], m[3]);
    const vi = /(\d{1,2})\s*THANG\s*(\d{1,2})\s*(?:NAM)?\s*(20\d{2})/g;
    while ((m = vi.exec(t))) push(m[3], m[2], m[1]);
    return out;
  },

  findTxRef(t) {
    const m = /(?:MA\s*(?:GIAO\s*DICH|GD|THAM\s*CHIEU)|SO\s*THAM\s*CHIEU|TRANSACTION\s*(?:ID|NO)|REF(?:ERENCE)?(?:\s*NO)?)\s*[:#.\-]?\s*([A-Z0-9]{6,24})/.exec(t);
    if (m) return m[1];
    const ft = /\b(FT\d{8,16}[A-Z0-9]*)\b/.exec(t);
    return ft ? ft[1] : '';
  },

  analyze(text, expected) {
    const t = this.norm(text);
    const exp = expected || {};
    const reasons = [];
    const amounts = this.amountCandidates(t);
    const amountOk = amounts.indexOf(Number(exp.amount)) !== -1;
    const codeState = this.findCode(t, exp.code);
    const receiver = this.findReceiver(t, exp.bank);

    // Ngày: có ngày trong khoảng hợp lý (từ đầu tháng đóng trừ 15 ngày đến ngày mai)
    let dateState = 'none';
    const dates = this.findDates(t);
    if (dates.length) {
      const now = exp.now instanceof Date ? exp.now : new Date();
      const hi = now.getTime() + 36 * 3600e3;
      const lo = (exp.monthStart instanceof Date ? exp.monthStart.getTime() : now.getTime() - 45 * 86400e3) - 15 * 86400e3;
      const inWin = dates.some((d) => d.getTime() >= lo && d.getTime() <= hi);
      dateState = inWin ? 'ok' : (dates.every((d) => d.getTime() > hi) ? 'future' : 'old');
    }
    const txRef = this.findTxRef(t);

    if (amountOk) reasons.push({ ok: true, text: `Số tiền ${Number(exp.amount).toLocaleString('vi-VN')} đ` });
    else if (amounts.length) reasons.push({ ok: false, text: `Số tiền trong ảnh khác ${Number(exp.amount).toLocaleString('vi-VN')} đ (thấy: ${amounts.slice(0, 4).map((a) => a.toLocaleString('vi-VN')).join(', ')})` });
    else reasons.push({ ok: false, text: 'Không đọc được số tiền' });

    if (codeState === 'exact') reasons.push({ ok: true, text: `Có mã chuyển khoản ${exp.code}` });
    else if (codeState === 'fuzzy') reasons.push({ ok: false, text: `Mã chuyển khoản giống ${exp.code} nhưng chưa chắc chắn` });
    else reasons.push({ ok: false, text: `Không thấy mã chuyển khoản ${exp.code}` });

    if (receiver.status === 'exact') reasons.push({ ok: true, text: 'Đúng số tài khoản nhận' });
    else if (receiver.status === 'masked') reasons.push({ ok: true, text: 'Khớp 4 số cuối tài khoản nhận' });
    else if (receiver.status === 'name') reasons.push({ ok: true, text: 'Đúng tên chủ tài khoản nhận' });
    else reasons.push({ ok: false, text: 'Không thấy số/tên tài khoản nhận' });

    if (dateState === 'ok') reasons.push({ ok: true, text: 'Ngày chuyển hợp lý' });
    else if (dateState === 'old') reasons.push({ ok: false, text: 'Ngày trong ảnh quá cũ so với kỳ đóng quỹ' });
    else if (dateState === 'future') reasons.push({ ok: false, text: 'Ngày trong ảnh ở tương lai' });

    let state;
    if (amountOk && codeState === 'exact' && receiver.status !== 'none' && dateState !== 'old' && dateState !== 'future') state = 'match';
    else if (!amounts.length && codeState === 'none') state = 'unreadable';
    else if (amounts.length && !amountOk && codeState === 'none') state = 'mismatch';
    else state = 'review';

    return {
      state, amounts, amountOk, code: codeState, receiver: receiver.status, date: dateState, txRef, reasons
    };
  }
};

window.PaymentMatch = PaymentMatch;
;

// ===== js/modules/payment-verify.js =====
// PaymentVerify - Đọc ảnh biên lai chuyển khoản (OCR) và đối chiếu với khoản phải đóng.
// - OCR chạy NGAY TRÊN TRÌNH DUYỆT bằng Tesseract.js (ảnh không gửi cho dịch vụ nào khác). Thư viện (vài MB) chỉ tải khi cần, lần sau dùng bộ nhớ đệm.
// - Kết quả đối chiếu CHỈ TIN CẬY khi chạy trên máy Ban quản trị (thành viên có thể sửa mã giao diện của chính mình), nên:
//     + Admin/Thủ quỹ: tự động đối chiếu các phiếu "Chờ duyệt" có ảnh và lưu kết quả vào due.verify (thành viên không xem được).
//     + Thành viên: chỉ có nút "Kiểm tra ảnh" để tự xem ảnh đã đủ rõ chưa (không ảnh hưởng việc duyệt).
// - "Khớp" chỉ nghĩa là ảnh nhất quán (đúng tiền + đúng mã + đúng tài khoản nhận); KHÔNG chứng minh tiền đã vào tài khoản.
const PaymentVerify = {
  TESSERACT_URL: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
  // Dữ liệu tiếng Anh bản nhẹ (~3 MB; bản mặc định của thư viện nặng ~11 MB). Tổng tải lần đầu ~4,5 MB, sau đó dùng bộ nhớ đệm.
  LANG_PATH: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int',
  MIN_CONFIDENCE: 35,
  _lib: null,
  _worker: null,
  _busy: false,
  _attempted: new Set(),
  status: '', // Dòng trạng thái hiển thị trên thanh đối chiếu

  // ---------------- OCR ----------------
  loadLib() {
    if (window.Tesseract) return Promise.resolve();
    if (this._lib) return this._lib;
    this._lib = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = this.TESSERACT_URL;
      s.integrity = 'sha384-GJqSu7vueQ9qN0E9yLPb3Wtpd7OrgK8KmYzC8T1IysG1bcvxvIO4qtYR/D3A991F'; // ghim đúng nội dung phiên bản 5.1.1
      s.crossOrigin = 'anonymous';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { this._lib = null; reject(new Error('Không tải được thư viện đọc ảnh (kiểm tra kết nối mạng)')); };
      document.head.appendChild(s);
    });
    return this._lib;
  },

  async getWorker() {
    if (this._worker) return this._worker;
    await this.loadLib();
    this._worker = await Tesseract.createWorker('eng', 1, {
      langPath: this.LANG_PATH,
      logger: (m) => {
        if (m && m.status && typeof m.progress === 'number') this._setStatus(`Đang đọc ảnh… ${m.status} ${Math.round(m.progress * 100)}%`);
      }
    });
    return this._worker;
  },

  // Chữ trắng trên nền tối (giao diện tối của app ngân hàng) -> đảo màu; ảnh nhỏ -> phóng to; chuyển xám
  preprocess(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(2, Math.max(1, 1400 / img.width));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);
        const im = ctx.getImageData(0, 0, w, h), d = im.data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) {
          const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
          d[i] = d[i + 1] = d[i + 2] = g;
          sum += g;
        }
        if (sum / (d.length / 4) < 110) for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = 255 - d[i]; }
        ctx.putImageData(im, 0, 0);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('Không mở được ảnh'));
      img.src = dataUrl;
    });
  },

  // psm: '3' = tự phân tích bố cục (mặc định); '11' = chữ rời rạc (bắt được dòng chữ lớn như số tiền mà chế độ mặc định hay bỏ sót)
  async _recognize(prepared, psm) {
    const worker = await this.getWorker();
    await worker.setParameters({ tessedit_pageseg_mode: psm });
    const { data } = await worker.recognize(prepared);
    return { text: data.text || '', confidence: Number(data.confidence) || 0 };
  },

  async ocr(dataUrl) {
    return this._recognize(await this.preprocess(dataUrl), '3');
  },

  // ---------------- Đối chiếu ----------------
  expectedFor(due, data) {
    data = data || AppStorage.loadData();
    const members = data.members || [];
    const member = members.find((m) => m.id === due.memberId) || { id: due.memberId };
    const [y, m] = String(due.month || AppStorage.currentMonth()).split('-').map(Number);
    return {
      amount: Number(due.amount) || FundModule.getClubFee(data),
      code: TransferCode.codeOf(member, members),
      bank: (data.clubInfo && data.clubInfo.bank) || null,
      monthStart: new Date(Date.UTC(y, (m || 1) - 1, 1)),
      now: new Date()
    };
  },

  // Đọc 2 lượt: lượt 1 theo bố cục tự động; nếu chưa "khớp" thì đọc thêm lượt chữ rời rạc rồi gộp chữ của cả hai
  async check(dataUrl, expected) {
    const prepared = await this.preprocess(dataUrl);
    const first = await this._recognize(prepared, '3');
    let text = first.text, confidence = first.confidence;
    let res = PaymentMatch.analyze(text, expected);
    if (res.state !== 'match') {
      const second = await this._recognize(prepared, '11');
      text = `${first.text}
${second.text}`;
      confidence = Math.max(first.confidence, second.confidence);
      res = PaymentMatch.analyze(text, expected);
    }
    res.confidence = Math.round(confidence);
    // OCR quá kém: đừng kết luận "không khớp" (có thể do ảnh mờ) -> yêu cầu xem ảnh
    if (res.state === 'mismatch' && confidence < this.MIN_CONFIDENCE) res.state = 'unreadable';
    return res;
  },

  // Khóa nhận diện ảnh (đổi ảnh -> phải đối chiếu lại): độ dài + băm các ký tự lấy mẫu
  imgKey(dataUrl) {
    if (AppStorage.isBillMarker(dataUrl)) return String(dataUrl).slice(AppStorage.BILL_MARK.length); // máy chủ đã tính sẵn cùng khóa
    const s = String(dataUrl || '');
    let h = 2166136261;
    for (let i = 0; i < s.length; i += 97) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return `${s.length}:${h.toString(36)}`;
  },

  _setStatus(text) {
    this.status = text;
    const el = document.getElementById('fund-verify-status');
    if (el) el.textContent = text;
  },

  isStale(due) {
    return !due.verify || due.verify.img !== this.imgKey(due.billImage);
  },

  // Phiếu cần đối chiếu: đang chờ duyệt, có ảnh, chưa có kết quả cho đúng ảnh này, chưa thử trong phiên
  targets(data) {
    return (data.monthlyContributions || []).filter((d) => d.status === 'pending' && d.billImage && this.isStale(d) && !this._attempted.has(`${d.id}|${this.imgKey(d.billImage)}`));
  },

  async verifyDue(dueId, { force = false } = {}) {
    if (!AppStorage.can('finance')) return null;
    let data = AppStorage.loadData();
    let due = (data.monthlyContributions || []).find((d) => d.id === dueId);
    if (!due || !due.billImage) return null;
    const key = `${due.id}|${this.imgKey(due.billImage)}`;
    if (!force && !this.isStale(due)) return due.verify;
    this._attempted.add(key);
    const expected = this.expectedFor(due, data);
    if (!expected.bank || !expected.bank.accountNo) {
      this._setStatus('CLB chưa cấu hình tài khoản ngân hàng nên chưa đối chiếu được.');
      return null;
    }
    let res;
    try {
      const image = await AppStorage.getBill(due);
      if (!image) throw new Error('không tải được ảnh biên lai từ máy chủ');
      res = await this.check(image, expected);
    } catch (e) {
      console.warn('[PaymentVerify] Lỗi đọc ảnh:', e);
      this._setStatus(`Không đọc được ảnh: ${e.message}`);
      return null;
    }
    // Lưu kết quả (nạp lại dữ liệu mới nhất vì có thể đã đổi trong lúc OCR)
    data = AppStorage.loadData();
    due = (data.monthlyContributions || []).find((d) => d.id === dueId);
    if (!due || due.billImage == null || this.imgKey(due.billImage) !== key.split('|')[1]) return res;
    const user = AppStorage.getCurrentUser();
    due.verify = {
      state: res.state, img: key.split('|')[1], at: new Date().toISOString().slice(0, 16).replace('T', ' '),
      by: user ? user.username : '', conf: res.confidence, txRef: res.txRef || '',
      reasons: res.reasons.slice(0, 6).map((r) => ({ ok: !!r.ok, text: String(r.text).slice(0, 160) }))
    };
    AppStorage.saveData(data);
    return due.verify;
  },

  // Chạy nền cho các phiếu chờ duyệt có ảnh (chỉ Admin/Thủ quỹ). Từng phiếu một để không treo máy.
  async autoRun() {
    if (this._busy || !AppStorage.can('finance')) return;
    const list = this.targets(AppStorage.loadData());
    if (!list.length) return;
    this._busy = true;
    try {
      for (let i = 0; i < list.length; i++) {
        this._setStatus(`Đang đối chiếu biên lai ${i + 1}/${list.length}…`);
        await this.verifyDue(list[i].id);
      }
      this._setStatus('');
    } finally {
      this._busy = false;
      if (window.FundModule) FundModule.renderFundDashboard();
    }
  },

  // ---------------- Hiển thị ----------------
  badge(due, dues) {
    if (!due || !due.billImage || due.status === 'unpaid') return '';
    if (this.isStale(due)) return `<span class="badge badge-neutral" style="font-size: 0.68rem;"><i class="fas fa-hourglass-half"></i> Chưa đối chiếu</span>`;
    const v = due.verify;
    const st = PaymentMatch.STATES[v.state] || PaymentMatch.STATES.review;
    const dup = this.duplicateOf(due, dues);
    return `<button type="button" class="badge ${st.cls}" style="font-size: 0.68rem; border: 0; cursor: pointer;" onclick="PaymentVerify.openDetail(${Safe.js(due.id)})" title="Xem chi tiết đối chiếu">
        <i class="fas ${st.icon}"></i> ${Safe.html(st.label)}</button>${dup ? ` <span class="badge badge-unpaid" style="font-size: 0.68rem;" title="Mã giao dịch trùng với phiếu khác"><i class="fas fa-clone"></i> Trùng mã GD</span>` : ''}`;
  },

  // Cùng 1 mã giao dịch xuất hiện ở phiếu khác (dùng lại ảnh/biên lai cho người khác hoặc tháng khác)
  duplicateOf(due, dues) {
    const ref = due && due.verify && due.verify.txRef;
    if (!ref) return null;
    return (dues || []).find((d) => d.id !== due.id && d.verify && d.verify.txRef === ref) || null;
  },

  openDetail(dueId) {
    const data = AppStorage.loadData();
    const due = (data.monthlyContributions || []).find((d) => d.id === dueId);
    if (!due || !due.verify) return;
    const member = (data.members || []).find((m) => m.id === due.memberId) || { name: 'Thành viên' };
    const v = due.verify, st = PaymentMatch.STATES[v.state] || PaymentMatch.STATES.review;
    const dup = this.duplicateOf(due, data.monthlyContributions);
    const dupMember = dup ? (data.members || []).find((m) => m.id === dup.memberId) : null;
    const body = `
      <div style="display: flex; flex-direction: column; gap: 0.75rem;">
        <div class="flex items-center gap-2" style="flex-wrap: wrap;">
          <strong>${Safe.html(member.name)}</strong>
          <span class="badge ${st.cls}"><i class="fas ${st.icon}"></i> ${Safe.html(st.label)}</span>
          <span class="text-secondary" style="font-size: 0.78rem;">độ tin cậy đọc chữ ${Safe.html(v.conf)}% • ${Safe.html(v.at || '')}</span>
        </div>
        <ul style="list-style: none; padding: 0; margin: 0; display: grid; gap: 0.35rem; font-size: 0.88rem;">
          ${(v.reasons || []).map((r) => `<li>${r.ok ? '✅' : '⚠️'} ${Safe.html(r.text)}</li>`).join('')}
          ${v.txRef ? `<li>🔖 Mã giao dịch: <span class="font-mono">${Safe.html(v.txRef)}</span></li>` : ''}
          ${dup ? `<li>🚨 Mã giao dịch này cũng xuất hiện ở phiếu của <strong>${Safe.html(dupMember ? dupMember.name : 'thành viên khác')}</strong> (tháng ${Safe.html(dup.month)}). Có thể dùng lại một biên lai.</li>` : ''}
        </ul>
        <img id="pv-detail-img" alt="Biên lai" style="max-width: 100%; max-height: 55vh; object-fit: contain; border-radius: 8px; border: 1px solid var(--border-color); min-height: 40px;">
        <p class="text-secondary" style="font-size: 0.78rem; margin: 0;">
          Đối chiếu tự động chỉ kiểm tra ảnh có <b>nhất quán</b> với khoản phải đóng. Ảnh có thể bị chỉnh sửa, nên nếu nghi ngờ hãy kiểm tra sao kê ngân hàng trước khi duyệt.
        </p>
        <div class="flex justify-end gap-2" style="flex-wrap: wrap;">
          <button type="button" class="btn btn-secondary" onclick="PaymentVerify.recheck(${Safe.js(due.id)})"><i class="fas fa-redo"></i> Đối chiếu lại</button>
          ${due.status === 'pending' ? `
          <button type="button" class="btn btn-danger" onclick="App.closeModal(); FundModule.approveDue(${Safe.js(due.id)}, false)"><i class="fas fa-times"></i> Từ chối</button>
          <button type="button" class="btn btn-primary" onclick="App.closeModal(); FundModule.approveDue(${Safe.js(due.id)}, true)"><i class="fas fa-check"></i> Duyệt</button>` : ''}
        </div>
      </div>`;
    App.openModal('🧾 Đối chiếu biên lai', body, true);
    AppStorage.getBill(due).then((img) => {
      const el = document.getElementById('pv-detail-img');
      if (el && img) el.src = Safe.url(img);
    });
  },

  async recheck(dueId) {
    App.closeModal();
    App.showToast('⏳ Đang đối chiếu lại biên lai…', 'info');
    await this.verifyDue(dueId, { force: true });
    if (window.FundModule) FundModule.renderFundDashboard();
    this.openDetail(dueId);
  },

  // Thanh công cụ trên bảng quỹ (Admin): trạng thái chạy nền + duyệt hàng loạt các phiếu đã khớp
  renderBar() {
    const box = document.getElementById('fund-verify-bar');
    if (!box) return;
    if (!AppStorage.can('finance')) { box.innerHTML = ''; return; }
    const data = AppStorage.loadData();
    const month = AppStorage.currentMonth();
    const dues = (data.monthlyContributions || []).filter((d) => d.month === month);
    const pendingWithImg = dues.filter((d) => d.status === 'pending' && d.billImage);
    const matched = pendingWithImg.filter((d) => !this.isStale(d) && d.verify.state === 'match' && !this.duplicateOf(d, data.monthlyContributions));
    const review = pendingWithImg.filter((d) => !this.isStale(d) && d.verify.state !== 'match').length;
    if (!pendingWithImg.length && !this.status) { box.innerHTML = ''; return; }
    box.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem 1rem; flex-wrap: wrap; padding: 0.7rem 1rem; margin: 0 0 0.75rem; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: var(--bg-input);">
        <div style="font-size: 0.85rem; min-width: 0;">
          <i class="fas fa-receipt text-primary"></i>
          <b>${pendingWithImg.length}</b> biên lai chờ duyệt:
          <span class="text-primary">${matched.length} khớp</span>${review ? `, <span style="color: var(--warning, #f59e0b);">${review} cần kiểm tra</span>` : ''}
          <div id="fund-verify-status" class="text-secondary" style="font-size: 0.75rem;">${Safe.html(this.status)}</div>
        </div>
        <div class="flex" style="gap: 0.4rem; flex-wrap: wrap;">
          <button type="button" class="btn btn-secondary btn-sm" onclick="PaymentVerify.runAgain()" ${this._busy ? 'disabled' : ''}><i class="fas fa-sync-alt"></i> Đối chiếu lại</button>
          <button type="button" class="btn btn-primary btn-sm" onclick="PaymentVerify.approveMatched()" ${matched.length ? '' : 'disabled'}><i class="fas fa-check-double"></i> Duyệt ${matched.length} phiếu đã khớp</button>
        </div>
      </div>`;
  },

  async runAgain() {
    this._attempted.clear();
    const data = AppStorage.loadData();
    (data.monthlyContributions || []).forEach((d) => { if (d.status === 'pending' && d.billImage) delete d.verify; });
    AppStorage.saveData(data);
    await this.autoRun();
  },

  async approveMatched() {
    if (!AppStorage.can('finance')) return;
    const data = AppStorage.loadData();
    const month = AppStorage.currentMonth();
    const list = (data.monthlyContributions || []).filter((d) => d.month === month && d.status === 'pending' && d.billImage && !this.isStale(d) &&
      d.verify.state === 'match' && !this.duplicateOf(d, data.monthlyContributions));
    if (!list.length) return;
    const names = list.map((d) => ((data.members || []).find((m) => m.id === d.memberId) || {}).name || 'Thành viên');
    if (!(await App.confirm(`Duyệt ${list.length} phiếu đã khớp?\n\n${names.join(', ')}\n\nĐối chiếu tự động chỉ kiểm tra ảnh nhất quán, không thay thế việc xem sao kê khi nghi ngờ.`))) return;
    const user = AppStorage.getCurrentUser();
    const approver = (user && user.name) || 'Ban quản trị CLB';
    const nowStr = new Date().toISOString().slice(0, 16).replace('T', ' ');
    if (!data.transactions) data.transactions = [];
    list.forEach((due, i) => {
      const member = (data.members || []).find((m) => m.id === due.memberId) || { name: 'Thành viên' };
      due.status = 'paid';
      due.approvedBy = `${approver} (đối chiếu tự động)`;
      due.approvedAt = nowStr;
      const idx = data.transactions.findIndex((t) => t.dueId === due.id);
      const tx = {
        id: idx >= 0 ? data.transactions[idx].id : `tx_${Date.now()}_${i}`, dueId: due.id, date: new Date().toISOString().slice(0, 10),
        type: 'income', category: 'Quỹ tháng', title: `Thu quỹ T${month.slice(5)} từ ${member.name}`, amount: Number(due.amount) || FundModule.getClubFee(data),
        createdBy: approver, note: `Admin duyệt chuyển khoản (${member.name})`
      };
      if (idx >= 0) data.transactions[idx] = tx; else data.transactions.unshift(tx);
    });
    App.showToast(`⏳ Đang lưu ${list.length} phiếu đã duyệt lên Cloud…`, 'info');
    const result = await AppStorage.saveDataWithCloudAck(data);
    App.showToast(result.success ? `✅ Đã duyệt ${list.length} phiếu.` : '⚠️ Đã duyệt trên máy, đang chờ đồng bộ lại Cloud.', result.success ? 'success' : 'warning');
    FundModule.renderFundDashboard();
    App.refreshDashboardStats();
  },

  // ---------------- Thành viên: tự kiểm tra ảnh trước khi gửi ----------------
  async previewCheck(memberId) {
    const img = document.getElementById('bill-preview-img');
    const box = document.getElementById('bill-check-result');
    if (!box) return;
    if (!img || !img.src || !img.src.startsWith('data:')) { box.innerHTML = '<span class="text-secondary">Hãy chọn ảnh biên lai trước.</span>'; return; }
    box.innerHTML = '<span class="text-secondary"><i class="fas fa-spinner fa-spin"></i> Đang đọc ảnh (lần đầu cần tải thư viện đọc chữ, vài MB)…</span>';
    try {
      const data = AppStorage.loadData();
      const member = (data.members || []).find((m) => m.id === memberId) || {};
      const due = (data.monthlyContributions || []).find((d) => d.memberId === memberId && d.month === AppStorage.currentMonth()) || {};
      const expected = this.expectedFor(Object.assign({ memberId, month: AppStorage.currentMonth() }, due), data);
      const res = await this.check(img.src, expected);
      const st = PaymentMatch.STATES[res.state];
      const hint = res.state === 'match' ? 'Ảnh đủ rõ và khớp thông tin. Bạn có thể gửi.' :
        res.state === 'unreadable' ? 'Ảnh khó đọc. Hãy chụp lại toàn màn hình biên lai (rõ số tiền, nội dung, tài khoản nhận).' :
        'Ảnh chưa khớp hoàn toàn. Bạn vẫn có thể gửi, Ban quản trị sẽ kiểm tra thủ công.';
      box.innerHTML = `<div><span class="badge ${st.cls}"><i class="fas ${st.icon}"></i> ${Safe.html(st.label)}</span> <span class="text-secondary" style="font-size: 0.8rem;">${Safe.html(hint)}</span></div>
        <ul style="list-style: none; padding: 0; margin: 0.4rem 0 0; font-size: 0.82rem; display: grid; gap: 0.2rem;">${res.reasons.map((r) => `<li>${r.ok ? '✅' : '⚠️'} ${Safe.html(r.text)}</li>`).join('')}</ul>`;
    } catch (e) {
      box.innerHTML = `<span class="text-secondary">⚠️ ${Safe.html(e.message)}</span>`;
    }
  }
};

window.PaymentVerify = PaymentVerify;
;

// ===== js/modules/fund.js =====
// Monthly Fund & Contribution Management Module

const FundModule = {
  currentFilter: 'all',
  get currentMonth() {
    return AppStorage.currentMonth();
  },

  getClubFee(data) {
    if (!data) data = AppStorage.loadData();
    const info = data.clubInfo || {};
    return Number(info.monthlyFee || info.monthlyFundFee) || 0;
  },

  renderFundDashboard() {
    const data = AppStorage.loadData();
    let members = (data.members || []).filter(m => m.type === 'fixed');
    // Thành viên thường (không phải Admin/Thủ quỹ) chỉ xem tình trạng quỹ của chính mình
    if (!AppStorage.can('finance')) {
      const me = AppStorage.getCurrentUser();
      members = members.filter(m => me && (m.id === me.memberId || (me.username && m.username === me.username)));
    }
    const dues = data.monthlyContributions || [];
    const defaultMonthlyFee = this.getClubFee(data);
    const currentUser = AppStorage.getCurrentUser();
    const isAdmin = AppStorage.can('finance');

    const fixedMemberIds = new Set(members.map(m => m.id));

    // Current month dues data (chỉ lấy của các thành viên cố định thực sự tồn tại)
    const monthDues = dues.filter(d => d.month === this.currentMonth && fixedMemberIds.has(d.memberId));
    
    // Phiếu quỹ dự kiến cho thành viên cố định chưa có phiếu tháng này (chỉ khi CLB đã cài mức quỹ)
    if (defaultMonthlyFee > 0) members.forEach(m => {
      let existingDue = monthDues.find(d => d.memberId === m.id);
      if (!existingDue) {
        existingDue = {
          id: `due_${this.currentMonth}_${m.id}`,
          month: this.currentMonth,
          memberId: m.id,
          amount: defaultMonthlyFee,
          status: 'unpaid',
          paidAt: null,
          method: null,
          billImage: null,
          approvedBy: null,
          approvedAt: null,
          note: 'Chưa đóng'
        };
        monthDues.push(existingDue);
      }
    });

    // Counts & Totals
    const paidList = monthDues.filter(d => d.status === 'paid');
    const pendingList = monthDues.filter(d => d.status === 'pending');
    const unpaidList = monthDues.filter(d => d.status === 'unpaid');

    const totalExpected = monthDues.reduce((sum, d) => sum + (Number(d.amount) || defaultMonthlyFee), 0);
    const totalCollected = paidList.reduce((sum, d) => sum + (Number(d.amount) || defaultMonthlyFee), 0);
    const progressPercent = members.length > 0 ? Math.min(100, Math.round((paidList.length / members.length) * 100)) : 0;

    // Update Summary Header Card
    const summaryCard = document.getElementById('fund-summary-container');
    if (summaryCard) {
      summaryCard.innerHTML = `
        <div class="fund-summary-card">
          <div class="fund-highlight-box">
            <div class="fund-highlight-label">
              <i class="fas fa-coins text-warning"></i> Quỹ tiền sân cố định tháng ${this.currentMonth.slice(5)}/${this.currentMonth.slice(0, 4)}
            </div>
            <div class="fund-highlight-balance">${Safe.html(totalCollected.toLocaleString('vi-VN'))} đ</div>
            <div class="text-secondary" style="font-size: 0.9rem;">
              Chỉ tiêu thu tháng: <strong>${Safe.html(totalExpected.toLocaleString('vi-VN'))} đ</strong> (${members.length} thành viên cố định • Mức chuẩn: ${Safe.html(defaultMonthlyFee.toLocaleString('vi-VN'))}đ/người)
            </div>
            <div style="margin-top: 0.75rem;">
              <div class="flex justify-between items-center" style="font-size: 0.85rem; margin-bottom: 0.35rem;">
                <span>Tiến độ thu quỹ (${paidList.length}/${members.length} người)</span>
                <strong>${progressPercent}%</strong>
              </div>
              <div class="progress-bar-bg">
                <div class="progress-bar-fill" style="width: ${progressPercent}%;"></div>
              </div>
            </div>
          </div>

          <div style="display: flex; flex-direction: column; gap: 0.85rem; background: rgba(0,0,0,0.2); padding: 1.25rem; border-radius: var(--radius-lg);">
            <div class="flex justify-between items-center">
              <span class="text-secondary"><i class="fas fa-check-circle text-primary"></i> Đã đóng:</span>
              <span class="badge badge-paid">${paidList.length} thành viên</span>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-secondary"><i class="fas fa-hourglass-half text-warning"></i> Chờ duyệt:</span>
              <span class="badge badge-pending">${pendingList.length} thành viên</span>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-secondary"><i class="fas fa-times-circle text-danger"></i> Chưa đóng:</span>
              <span class="badge badge-unpaid">${unpaidList.length} thành viên</span>
            </div>

            <div style="display: flex; gap: 0.5rem; margin-top: 0.5rem; flex-wrap: wrap;">
              <button class="btn btn-primary btn-sm flex-1" onclick="FundModule.openPaymentModal(${Safe.js(currentUser ? currentUser.id : '')})">
                <i class="fas fa-qrcode"></i> Đóng quỹ VietQR
              </button>
              ${isAdmin ? `
                <button class="btn btn-outline-primary btn-sm" onclick="FundModule.openSetFeeModal()" title="Cài đặt mức tiền quỹ chung">
                  <i class="fas fa-sliders"></i> Mức quỹ
                </button>
                <button class="btn btn-secondary btn-sm" onclick="FundModule.sendReminderMessage()" title="Nhắc nhở qua Zalo">
                  <i class="fas fa-bell"></i> Nhắc nhở
                </button>
              ` : ''}
            </div>
          </div>
        </div>
      `;
    }

    // Current month dues data (chỉ lấy của các thành viên cố định thực sự tồn tại)
    this.renderDuesTable(monthDues, members);
    this.renderMyTransferCard(data);
    if (window.PaymentVerify) {
      PaymentVerify.renderBar();
      if (isAdmin) setTimeout(() => PaymentVerify.autoRun(), 300); // Đối chiếu nền các biên lai chờ duyệt
    }
  },

  // Thẻ "Mã chuyển khoản của bạn" cho thành viên cố định đang đăng nhập
  renderMyTransferCard(data) {
    const box = document.getElementById('fund-transfer-code-card');
    if (!box) return;
    const me = AppStorage.getCurrentUser();
    const member = me && (data.members || []).find((m) => m.id === me.memberId);
    if (!member || member.type !== 'fixed') { box.innerHTML = ''; return; }
    const info = data.clubInfo || {};
    const code = TransferCode.codeOf(member, data.members);
    const memo = PaymentMatch.memoFor(info, code, this.currentMonth);
    box.innerHTML = `
      <div class="card" style="margin-bottom: 1rem; padding: 0.9rem 1.1rem; display: flex; align-items: center; justify-content: space-between; gap: 0.75rem 1.5rem; flex-wrap: wrap;">
        <div>
          <div class="text-secondary" style="font-size: 0.78rem;">Mã chuyển khoản của bạn</div>
          <div class="font-mono text-warning font-bold" style="font-size: 1.5rem; letter-spacing: 0.1em;">${Safe.html(code)}</div>
        </div>
        <div style="font-size: 0.82rem; min-width: 0;">
          <div class="text-secondary">Nội dung chuyển khoản tháng này</div>
          <div class="font-mono" style="overflow-wrap: anywhere;">${Safe.html(memo)}
            <button class="copy-btn" onclick="navigator.clipboard.writeText(${Safe.js(memo)}); App.showToast('Đã sao chép nội dung chuyển khoản!', 'success');" title="Sao chép"><i class="far fa-copy"></i></button>
          </div>
        </div>
      </div>`;
  },

  renderDuesTable(monthDues, members) {
    const container = document.getElementById('dues-table-body');
    if (!container) return;

    const data = AppStorage.loadData();
    const currentUser = AppStorage.getCurrentUser();
    const isAdmin = AppStorage.can('finance');
    const defaultMonthlyFee = this.getClubFee(data);

    let filtered = monthDues;
    if (this.currentFilter !== 'all') {
      filtered = monthDues.filter(d => d.status === this.currentFilter);
    }

    if (filtered.length === 0) {
      container.innerHTML = `
        <tr>
          <td colspan="7" class="text-center text-muted" style="padding: 2.5rem 1rem;">
            <i class="fas fa-receipt" style="font-size: 2rem; margin-bottom: 0.5rem; display: block;"></i>
            Không có dữ liệu thành viên ở danh mục này.
          </td>
        </tr>
      `;
      return;
    }

    container.innerHTML = filtered.map((due, idx) => {
      const member = members.find(m => m.id === due.memberId) || { name: 'Thành viên', phone: '', avatar: '' };
      const dueAmount = Number(due.amount) || defaultMonthlyFee;

      const isSelf = currentUser && (
        member.id === currentUser.id || 
        member.id === currentUser.memberId || 
        (currentUser.username && member.username === currentUser.username) ||
        (currentUser.phone && member.phone && currentUser.phone.replace(/\D/g, '') === member.phone.replace(/\D/g, ''))
      );
      const canViewDetails = isAdmin || isSelf;

      let statusBadge = '';
      if (canViewDetails) {
        if (due.status === 'paid') {
          statusBadge = `<span class="badge badge-paid"><i class="fas fa-check"></i> Đã đóng</span>`;
        } else if (due.status === 'pending') {
          statusBadge = `<span class="badge badge-pending"><i class="fas fa-clock"></i> Chờ duyệt</span>`;
        } else {
          statusBadge = `<span class="badge badge-unpaid"><i class="fas fa-exclamation"></i> Chưa đóng</span>`;
        }
      } else {
        statusBadge = `<span class="badge badge-neutral" style="font-size: 0.72rem;" title="Thông tin đóng quỹ chỉ hiển thị cho Ban Quản trị và chính chủ"><i class="fas fa-lock text-muted"></i> Riêng tư</span>`;
      }

      return `
        <tr>
          <td class="font-mono text-muted text-center" style="width: 40px;">${idx + 1}</td>
          <td>
            <div class="flex items-center gap-3">
              <img class="avatar" src="${Safe.url(member.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(member.name)}&background=10b981&color=fff`)}" alt="${Safe.html(member.name)}" onerror="this.src=${Safe.js(`https://ui-avatars.com/api/?name=${encodeURIComponent(member.name)}&background=10b981&color=fff`)}">
              <div>
                <div class="font-bold flex items-center gap-2">
                  ${Safe.html(member.name)}
                  ${isSelf ? `<span class="badge badge-neutral" style="font-size: 0.65rem;">Bạn</span>` : ''}
                </div>
                <div class="text-secondary" style="font-size: 0.78rem;">
                  <i class="fas fa-phone-alt"></i> ${Safe.html(member.phone ? AppStorage.maskPhone(member.phone, member.id) : 'Chưa có SĐT')}
                  ${canViewDetails ? ` • <span class="font-mono" title="Mã chuyển khoản của thành viên">${Safe.html(TransferCode.codeOf(member, data.members))}</span>` : ''}
                </div>
              </div>
            </div>
          </td>
          <td>
            <div style="display: flex; align-items: center; gap: 0.4rem;">
              <strong class="font-mono text-primary">${Safe.html(dueAmount.toLocaleString('vi-VN'))} đ</strong>
              ${isAdmin ? `
                <button class="btn btn-ghost btn-xs text-muted hover:text-primary" onclick="FundModule.openEditMemberDueModal(${Safe.js(due.id || ('due_' + FundModule.currentMonth + '_' + member.id))}, ${Safe.js(member.id)})" title="Admin: Chỉnh sửa số tiền cần đóng của thành viên này" style="padding: 2px 6px; font-size: 0.75rem; border-radius: 4px; background: rgba(255,255,255,0.05);">
                  <i class="fas fa-pen-to-square"></i>
                </button>
              ` : ''}
            </div>
            ${due.note && due.note !== 'Chưa đóng' ? `<div class="text-muted" style="font-size: 0.72rem; margin-top: 0.15rem;">${Safe.html(due.note)}</div>` : ''}
          </td>
          <td>
            ${statusBadge}
            ${isAdmin && window.PaymentVerify ? `<div style="margin-top: 0.25rem;">${PaymentVerify.badge(due, data.monthlyContributions)}</div>` : ''}
            ${(canViewDetails && due.approvedBy) ? `<div class="text-muted" style="font-size: 0.72rem; margin-top: 0.2rem;">(Duyệt: ${Safe.html(due.approvedBy)})</div>` : ''}
          </td>
          <td>
            ${canViewDetails ? (due.paidAt ? `
              <div style="font-size: 0.85rem;">${Safe.html(due.paidAt)}</div>
              <div class="text-secondary" style="font-size: 0.75rem;">${Safe.html(due.method || 'VietQR')}</div>
            ` : `<span class="text-muted">-</span>`) : `<span class="text-muted font-mono">-</span>`}
          </td>
          <td>
            ${canViewDetails ? (due.billImage ? `
              <button class="btn btn-secondary btn-sm" onclick="FundModule.previewBill(${Safe.js(due.id || '')}, ${Safe.js(member.name)})">
                <i class="fas fa-image"></i> Xem biên lai
              </button>
            ` : `<span class="text-muted" style="font-size: 0.8rem;">Không có</span>`) : `<span class="text-muted font-mono">-</span>`}
          </td>
          <td class="text-right">
            <div class="flex justify-end gap-2">
              ${due.status === 'pending' && isAdmin ? `
                <button class="btn btn-primary btn-sm" onclick="FundModule.approveDue(${Safe.js(due.id || due.memberId)}, true)">
                  <i class="fas fa-check"></i> Duyệt
                </button>
                <button class="btn btn-danger btn-sm" onclick="FundModule.approveDue(${Safe.js(due.id || due.memberId)}, false)">
                  <i class="fas fa-times"></i>
                </button>
              ` : ''}

              ${due.status === 'unpaid' && (isAdmin || isSelf) ? `
                <button class="btn btn-primary btn-sm" onclick="FundModule.openPaymentModal(${Safe.js(member.id)})">
                  <i class="fas fa-credit-card"></i> ${isSelf ? 'Đóng quỹ' : 'Nộp quỹ'}
                </button>
                ${isAdmin ? `
                  <button class="btn btn-secondary btn-sm" onclick="FundModule.markPaidCash(${Safe.js(member.id)})" title="Đánh dấu đã nộp tiền mặt">
                    <i class="fas fa-money-bill"></i> Tiền mặt
                  </button>
                ` : ''}
              ` : ''}

              ${due.status === 'paid' && isAdmin ? `
                <button class="btn btn-secondary btn-sm" onclick="FundModule.resetDueStatus(${Safe.js(member.id)})" title="Thu hồi / Đổi trạng thái">
                  <i class="fas fa-undo"></i>
                </button>
              ` : ''}
            </div>
          </td>
        </tr>
      `;
    }).join('');
  },

  // Modal cho Admin cài đặt mức quỹ tháng chung của CLB
  openSetFeeModal() {
    if (!AppStorage.can('finance')) {
      App.showToast("Chỉ Quản trị viên mới có quyền cài đặt số tiền quỹ tháng!", "warning");
      App.showAuthModal('login');
      return;
    }

    const data = AppStorage.loadData();
    const currentFee = this.getClubFee(data);

    const modalBody = `
      <form onsubmit="FundModule.saveClubFee(event)" style="display: flex; flex-direction: column; gap: 1rem;">
        <div class="form-group">
          <label class="form-label" style="font-weight: 600;">Mức thu quỹ tháng tiêu chuẩn của CLB (VNĐ):</label>
          <div style="position: relative;">
            <input type="number" id="set-fund-fee-input" class="form-control" min="0" step="1000" value="${Safe.html(currentFee)}" required style="font-size: 1.15rem; font-weight: bold; padding-right: 3rem;">
            <span style="position: absolute; right: 1rem; top: 50%; transform: translateY(-50%); color: var(--text-secondary); font-weight: 600;">VNĐ</span>
          </div>
          <small class="text-secondary" style="margin-top: 0.35rem; display: block;">
            Mức này dùng làm mặc định cho tất cả thành viên cố định trong CLB.
          </small>
        </div>

        <div style="background: rgba(255, 255, 255, 0.03); padding: 0.85rem 1rem; border-radius: 8px; border: 1px solid var(--border-color);">
          <label style="display: flex; align-items: flex-start; gap: 0.6rem; cursor: pointer; margin-bottom: 0;">
            <input type="checkbox" id="set-fund-fee-apply-unpaid" checked style="margin-top: 0.2rem;">
            <span style="font-size: 0.9rem; line-height: 1.4;">
              Áp dụng mức tiền mới này cho tất cả thành viên <strong>chưa đóng</strong> của tháng ${this.currentMonth.slice(5)}/${this.currentMonth.slice(0, 4)}
            </span>
          </label>
        </div>

        <div class="flex justify-end gap-2" style="margin-top: 1rem;">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Hủy</button>
          <button type="submit" class="btn btn-primary">
            <i class="fas fa-save"></i> Lưu cài đặt mức quỹ
          </button>
        </div>
      </form>
    `;

    App.openModal("⚙️ Cài đặt mức tiền quỹ tháng CLB", modalBody);
  },

  async saveClubFee(e) {
    e.preventDefault();
    if (!AppStorage.can('finance')) {
      App.showToast("Chỉ Quản trị viên mới có quyền cài đặt số tiền quỹ tháng!", "warning");
      return;
    }

    const input = document.getElementById('set-fund-fee-input');
    const applyUnpaidCheckbox = document.getElementById('set-fund-fee-apply-unpaid');
    if (!input) return;

    const newFee = Math.max(0, parseInt(input.value, 10) || 0);
    const applyUnpaid = applyUnpaidCheckbox ? applyUnpaidCheckbox.checked : true;

    const data = AppStorage.loadData();
    if (!data.clubInfo) data.clubInfo = {};
    data.clubInfo.monthlyFee = newFee;
    data.clubInfo.monthlyFundFee = newFee;

    if (applyUnpaid && Array.isArray(data.monthlyContributions)) {
      data.monthlyContributions.forEach(d => {
        if (d.month === this.currentMonth && d.status === 'unpaid') {
          d.amount = newFee;
        }
      });
    }

    App.showToast(`⏳ Đang lưu mức quỹ ${newFee.toLocaleString('vi-VN')}đ lên Cloud...`, "info");
    const result = await AppStorage.saveDataWithCloudAck(data);
    App.closeModal();

    if (result.success) {
      App.showToast(`✅ Đã cập nhật mức thu quỹ tháng thành ${newFee.toLocaleString('vi-VN')} VNĐ!`, "success");
    } else {
      App.showToast(`⚠️ Đã lưu trên máy, đang chờ kết nối lại Cloud.`, "warning");
    }

    this.renderFundDashboard();
    App.refreshDashboardStats();
  },

  // Modal cho Admin chỉnh sửa riêng mức đóng của 1 thành viên
  openEditMemberDueModal(dueId, memberId) {
    if (!AppStorage.can('finance')) {
      App.showToast("Chỉ Quản trị viên mới có quyền sửa số tiền nộp của thành viên!", "warning");
      App.showAuthModal('login');
      return;
    }

    const data = AppStorage.loadData();
    const defaultMonthlyFee = this.getClubFee(data);
    const member = (data.members || []).find(m => m.id === memberId) || { name: 'Thành viên' };
    const dues = data.monthlyContributions || [];
    const due = dues.find(d => (d.id === dueId || d.memberId === memberId) && d.month === this.currentMonth) || {
      id: dueId,
      amount: defaultMonthlyFee,
      note: ''
    };

    const currentAmount = Number(due.amount) || defaultMonthlyFee;

    const modalBody = `
      <form onsubmit="FundModule.saveMemberDueAmount(event, ${Safe.js(due.id)}, ${Safe.js(memberId)})" style="display: flex; flex-direction: column; gap: 1rem;">
        <div class="form-group">
          <label class="form-label">Thành viên:</label>
          <input type="text" class="form-control" value="${Safe.html(member.name)} (${Safe.html(member.phone ? AppStorage.maskPhone(member.phone, member.id) : 'Cố định')})" disabled style="opacity: 0.85; font-weight: 600;">
        </div>

        <div class="form-group">
          <label class="form-label" style="font-weight: 600;">Số tiền cần đóng tháng ${this.currentMonth.slice(5)}/${this.currentMonth.slice(0, 4)} (VNĐ):</label>
          <div style="position: relative;">
            <input type="number" id="edit-member-due-amount" class="form-control" min="0" step="1000" value="${Safe.html(currentAmount)}" required style="font-size: 1.15rem; font-weight: bold; padding-right: 3rem;">
            <span style="position: absolute; right: 1rem; top: 50%; transform: translateY(-50%); color: var(--text-secondary); font-weight: 600;">VNĐ</span>
          </div>
          <small class="text-secondary" style="margin-top: 0.35rem; display: block;">
            Mã VietQR của thành viên này sẽ tự động cập nhật đúng số tiền này.
          </small>
        </div>

        <div class="form-group">
          <label class="form-label">Ghi chú điều chỉnh (Tùy chọn - lý do giảm/tăng/miễn phí):</label>
          <input type="text" id="edit-member-due-note" class="form-control" value="${Safe.html(due.note && due.note !== 'Chưa đóng' ? due.note : '')}" placeholder="Ví dụ: Giảm 50% do nghỉ nửa tháng / Hỗ trợ quỹ / Miễn phí">
        </div>

        <div class="flex justify-end gap-2" style="margin-top: 1rem;">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Hủy</button>
          <button type="submit" class="btn btn-primary">
            <i class="fas fa-save"></i> Cập nhật mức đóng
          </button>
        </div>
      </form>
    `;

    App.openModal(`✏️ Chỉnh sửa mức đóng quỹ - ${Safe.html(member.name)}`, modalBody);
  },

  async saveMemberDueAmount(e, dueId, memberId) {
    e.preventDefault();
    if (!AppStorage.can('finance')) {
      App.showToast("Chỉ Quản trị viên mới có quyền sửa số tiền nộp của thành viên!", "warning");
      return;
    }

    const amountInput = document.getElementById('edit-member-due-amount');
    const noteInput = document.getElementById('edit-member-due-note');
    if (!amountInput) return;

    const newAmount = Math.max(0, parseInt(amountInput.value, 10) || 0);
    const newNote = noteInput ? noteInput.value.trim() : '';

    const data = AppStorage.loadData();
    if (!data.monthlyContributions) data.monthlyContributions = [];

    const member = (data.members || []).find(m => m.id === memberId) || { name: 'Thành viên' };
    let due = data.monthlyContributions.find(d => (d.id === dueId || d.memberId === memberId) && d.month === this.currentMonth);

    if (!due) {
      due = {
        id: dueId || `due_${this.currentMonth}_${memberId}`,
        month: this.currentMonth,
        memberId: memberId,
        amount: newAmount,
        status: 'unpaid',
        paidAt: null,
        method: null,
        billImage: null,
        approvedBy: null,
        approvedAt: null,
        note: newNote || 'Chưa đóng'
      };
      data.monthlyContributions.push(due);
    } else {
      due.amount = newAmount;
      if (newNote) {
        due.note = newNote;
      }
    }

    // Nếu khoản này đã được duyệt đóng (paid), cập nhật luôn số tiền tương ứng trong Sổ quỹ transactions
    if (due.status === 'paid' && Array.isArray(data.transactions)) {
      const tx = data.transactions.find(t => t.dueId === due.id);
      if (tx) {
        tx.amount = newAmount;
      }
    }

    App.showToast(`⏳ Đang lưu mức đóng ${newAmount.toLocaleString('vi-VN')}đ cho ${member.name} lên Cloud...`, "info");
    const result = await AppStorage.saveDataWithCloudAck(data);
    App.closeModal();

    if (result.success) {
      App.showToast(`✅ Đã cập nhật mức đóng quỹ của ${member.name} thành ${newAmount.toLocaleString('vi-VN')} VNĐ!`, "success");
    } else {
      App.showToast(`⚠️ Đã lưu trên máy, đang chờ kết nối lại Cloud.`, "warning");
    }

    this.renderFundDashboard();
    App.refreshDashboardStats();
  },

  setFilter(filter) {
    if (!AppStorage.can('finance') && filter !== 'all') {
      App.showToast("Bộ lọc theo trạng thái đóng quỹ chi tiết chỉ dành cho Quản trị viên!", "info");
      return;
    }
    this.currentFilter = filter;
    document.querySelectorAll('.fund-filter-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`[data-fund-filter="${filter}"]`)?.classList.add('active');
    this.renderFundDashboard();
  },

  openPaymentModal(memberId) {
    const data = AppStorage.loadData();
    const defaultMonthlyFee = this.getClubFee(data);
    const member = (data.members || []).find(m => m.id === memberId) || data.currentUser || { name: 'Thành viên', id: memberId };
    const info = data.clubInfo || {};
    const bank = info.bank && info.bank.bankId && info.bank.accountNo ? info.bank : null;
    if (!bank) {
      App.showToast('CLB chưa cấu hình tài khoản ngân hàng nhận quỹ. Vui lòng liên hệ Ban quản trị.', 'warning');
      return;
    }
    
    // Tìm due của thành viên để lấy chính xác số tiền được Admin cài đặt
    const dues = data.monthlyContributions || [];
    const due = dues.find(d => d.memberId === member.id && d.month === this.currentMonth);
    const amount = Number(due && due.amount) || defaultMonthlyFee;
    const month = this.currentMonth;
    
    // Nội dung chuyển khoản chuẩn: "<TÊN NGẮN> <MÃ RIÊNG> T<tháng>" - mã riêng giúp biết chính xác ai đã chuyển
    const transferCode = TransferCode.codeOf(member, data.members);
    const memo = PaymentMatch.memoFor(info, transferCode, month);

    // VietQR quick URL
    const qrUrl = `https://api.vietqr.io/image/${encodeURIComponent(bank.bankId)}-${encodeURIComponent(bank.accountNo)}-compact2.jpg?amount=${amount}&addInfo=${encodeURIComponent(memo)}&accountName=${encodeURIComponent(bank.accountName)}`;

    const modalBody = `
      <div class="vietqr-card">
        <div class="vietqr-header">
          <div class="vietqr-bank-logo">${Safe.html(bank.bankName)}</div>
          <span class="badge badge-paid">VietQR chuẩn Napas 247</span>
        </div>

        <div class="vietqr-img-wrapper">
          <img src="${Safe.url(qrUrl)}" alt="VietQR thanh toán" onerror="this.src=${Safe.js(`https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(`STK:${bank.accountNo}|BANK:${bank.bankId}|AMOUNT:${amount}|NOTE:${memo}`)}`)}">
        </div>

        <div class="vietqr-details-list">
          <div class="vietqr-detail-row">
            <span class="vietqr-detail-label">Thành viên nộp:</span>
            <span class="vietqr-detail-value font-bold">${Safe.html(member.name)}</span>
          </div>

          <div class="vietqr-detail-row">
            <span class="vietqr-detail-label">Mã chuyển khoản của bạn:</span>
            <span class="vietqr-detail-value font-mono text-warning font-bold" style="font-size: 1.1rem; letter-spacing: 0.08em;">${Safe.html(transferCode)}</span>
          </div>

          <div class="vietqr-detail-row">
            <span class="vietqr-detail-label">Chủ tài khoản:</span>
            <span class="vietqr-detail-value font-mono">${Safe.html(bank.accountName)}</span>
          </div>

          <div class="vietqr-detail-row">
            <span class="vietqr-detail-label">Số tài khoản:</span>
            <span class="vietqr-detail-value font-mono">
              ${Safe.html(bank.accountNo)}
              <button class="copy-btn" onclick="navigator.clipboard.writeText(${Safe.js(bank.accountNo)}); App.showToast('Đã sao chép số tài khoản!', 'success');" title="Sao chép STK">
                <i class="far fa-copy"></i>
              </button>
            </span>
          </div>

          <div class="vietqr-detail-row">
            <span class="vietqr-detail-label">Số tiền cần đóng:</span>
            <span class="vietqr-detail-value font-mono text-primary font-bold" style="font-size: 1.1rem;">
              ${Safe.html(amount.toLocaleString('vi-VN'))} VNĐ
              <button class="copy-btn" onclick="navigator.clipboard.writeText(${Safe.js(amount)}); App.showToast('Đã sao chép số tiền!', 'success');" title="Sao chép số tiền">
                <i class="far fa-copy"></i>
              </button>
            </span>
          </div>

          <div class="vietqr-detail-row">
            <span class="vietqr-detail-label">Nội dung chuyển khoản:</span>
            <span class="vietqr-detail-value font-mono text-warning">
              ${Safe.html(memo)}
              <button class="copy-btn" onclick="navigator.clipboard.writeText(${Safe.js(memo)}); App.showToast('Đã sao chép cú pháp chuyển khoản!', 'success');" title="Sao chép nội dung">
                <i class="far fa-copy"></i>
              </button>
            </span>
          </div>
        </div>
        <p class="text-secondary" style="font-size: 0.78rem; margin: 0.6rem 0 0;">
          ⚠️ Quét mã VietQR sẽ tự điền sẵn nội dung. Nếu nhập tay, <b>giữ nguyên mã ${Safe.html(transferCode)}</b> trong nội dung để Ban quản trị nhận ra khoản của bạn.
        </p>
      </div>

      <!-- Proof of payment form -->
      <div style="margin-top: 1.5rem; background: var(--bg-card); padding: 1.25rem; border-radius: var(--radius-lg); border: 1px solid var(--border-color);">
        <h4 style="margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.5rem;">
          <i class="fas fa-check-circle text-primary"></i> Xác nhận sau khi chuyển khoản
        </h4>
        <p class="text-secondary" style="font-size: 0.85rem; margin-bottom: 1rem;">
          ${info.autoApprove ? 
            '⚡ <strong>Chế độ tự động duyệt:</strong> Trạng thái của bạn sẽ được kích hoạt "ĐÃ ĐÓNG" ngay khi bấm xác nhận.' : 
            '🛡️ <strong>Chế độ duyệt ban quản trị:</strong> Sau khi bạn xác nhận, thủ quỹ sẽ kiểm tra sao kê và duyệt trong ít phút.'}
        </p>

        <div class="form-group">
          <label class="form-label">Tải ảnh chụp màn hình biên lai (tùy chọn):</label>
          <input type="file" id="bill-file-input" class="form-control" accept="image/*" onchange="FundModule.handleBillUpload(event)">
          <small class="text-secondary" style="display: block; margin-top: 0.3rem;">Chụp toàn màn hình biên lai, thấy rõ số tiền, nội dung chuyển khoản, tài khoản nhận và thời gian.</small>
          <div id="bill-preview-container" style="display: none; margin-top: 0.5rem; text-align: center;">
            <img id="bill-preview-img" style="max-height: 140px; border-radius: 8px; border: 1px solid var(--border-color);" src="" alt="Bill preview">
            <div style="margin-top: 0.5rem;">
              <button type="button" class="btn btn-secondary btn-sm" onclick="PaymentVerify.previewCheck(${Safe.js(member.id)})" title="Đọc thử ảnh để biết đã đủ rõ chưa (không bắt buộc)"><i class="fas fa-search"></i> Kiểm tra ảnh</button>
            </div>
            <div id="bill-check-result" style="margin-top: 0.5rem; font-size: 0.85rem; text-align: left;"></div>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Ghi chú xác nhận:</label>
          <input type="text" id="bill-note" class="form-control" value="Đã chuyển khoản thành công lúc ${new Date().toLocaleTimeString('vi-VN', {hour: '2-digit', minute:'2-digit'})}">
        </div>

        <button type="button" class="btn btn-primary w-full btn-lg" onclick="FundModule.submitPayment(${Safe.js(member.id)})">
          <i class="fas fa-paper-plane"></i> Tôi đã chuyển khoản thành công
        </button>
      </div>
    `;

    App.openModal("💳 Thanh toán quỹ tháng bằng VietQR", modalBody, true);
  },

  handleBillUpload(e) {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        // Nén ảnh biên lai (rộng tối đa 1100px, cao tối đa 2600px, JPEG 0.72) trước khi lưu vào CSDL đồng bộ.
        // Giới hạn theo chiều rộng (không theo cạnh dài) để ảnh chụp màn hình điện thoại vẫn đủ nét cho việc đọc chữ.
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, 1100 / img.width, 2600 / img.height);
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          const previewImg = document.getElementById('bill-preview-img');
          const container = document.getElementById('bill-preview-container');
          if (previewImg && container) {
            previewImg.src = canvas.toDataURL('image/jpeg', 0.72);
            container.style.display = 'block';
            const checkBox = document.getElementById('bill-check-result');
            if (checkBox) checkBox.innerHTML = '';
          }
        };
        img.src = event.target.result;
      };
      reader.readAsDataURL(file);
    }
  },

  async submitPayment(memberId) {
    const data = AppStorage.loadData();
    const defaultMonthlyFee = this.getClubFee(data);
    const info = data.clubInfo || {};
    const member = (data.members || []).find(m => m.id === memberId) || data.currentUser || { name: 'Thành viên', id: memberId };
    const note = document.getElementById('bill-note')?.value.trim() || 'Đã chuyển khoản';
    const previewImg = document.getElementById('bill-preview-img');
    const billImage = (previewImg && previewImg.src && previewImg.src.startsWith('data:')) ? 
      previewImg.src : null;

    if (!data.monthlyContributions) data.monthlyContributions = [];

    const isAuto = info.autoApprove === true;
    const newStatus = isAuto ? 'paid' : 'pending';
    const nowStr = new Date().toISOString().slice(0, 16).replace('T', ' ');

    let dueIndex = data.monthlyContributions.findIndex(d => d.memberId === memberId && d.month === this.currentMonth);
    const dueId = dueIndex >= 0 ? data.monthlyContributions[dueIndex].id : `due_${this.currentMonth}_${memberId}`;
    const dueAmount = (dueIndex >= 0 && Number(data.monthlyContributions[dueIndex].amount)) ? Number(data.monthlyContributions[dueIndex].amount) : defaultMonthlyFee;

    const record = {
      id: dueId,
      month: this.currentMonth,
      memberId: memberId,
      amount: dueAmount,
      status: newStatus,
      paidAt: nowStr,
      method: 'Chuyển khoản VietQR',
      billImage: billImage,
      approvedBy: isAuto ? 'Tự động duyệt' : null,
      approvedAt: isAuto ? nowStr : null,
      note: note
    };

    if (dueIndex >= 0) {
      data.monthlyContributions[dueIndex] = record;
    } else {
      data.monthlyContributions.push(record);
    }

    // Nếu bật tự động duyệt -> Tạo hoặc cập nhật giao dịch thu quỹ với dueId định danh
    if (isAuto) {
      if (!data.transactions) data.transactions = [];
      const existingTxIdx = data.transactions.findIndex(t => t.dueId === dueId);
      const txRecord = {
        id: existingTxIdx >= 0 ? data.transactions[existingTxIdx].id : `tx_${Date.now()}`,
        dueId: dueId,
        date: new Date().toISOString().slice(0, 10),
        type: 'income',
        category: 'Quỹ tháng',
        title: `Thu quỹ T${this.currentMonth.slice(5)} từ ${member.name}`,
        amount: dueAmount,
        createdBy: 'Hệ thống tự động duyệt',
        note: `Đóng quỹ VietQR tự động (${member.name})`
      };
      if (existingTxIdx >= 0) {
        data.transactions[existingTxIdx] = txRecord;
      } else {
        data.transactions.unshift(txRecord);
      }
    }

    App.showToast(`⏳ Đang ghi nhận đóng quỹ của ${member.name} và đồng bộ lên Cloud...`, "info");
    const result = await AppStorage.saveDataWithCloudAck(data);
    App.closeModal();

    if (isAuto) {
      App.showToast(`🎉 Đã thanh toán và tự động duyệt thành công cho ${member.name}! CSDL Cloud đã cập nhật.`, "success");
      if (window.confetti) {
        window.confetti({ particleCount: 70, spread: 70, origin: { y: 0.6 } });
      }
    } else {
      App.showToast(`✅ Đã gửi thông tin chuyển khoản của ${member.name}! Đang chờ Ban quản trị duyệt.`, "info");
    }

    this.renderFundDashboard();
    App.refreshDashboardStats();
  },

  async approveDue(dueIdOrMemberId, isApproved) {
    if (!AppStorage.can('finance')) {
      App.showToast("Chỉ Ban quản trị/Thủ quỹ mới có quyền duyệt đóng quỹ!", "warning");
      App.showAuthModal('login');
      return;
    }

    const data = AppStorage.loadData();
    const dues = data.monthlyContributions || [];
    const defaultMonthlyFee = this.getClubFee(data);
    const currentUser = data.currentUser || AppStorage.getCurrentUser();
    const approverName = (currentUser && currentUser.name) || 'Ban quản trị CLB';

    const due = dues.find(d => (d.id === dueIdOrMemberId || d.memberId === dueIdOrMemberId) && d.month === this.currentMonth);
    if (!due) return;

    const member = (data.members || []).find(m => m.id === due.memberId) || { name: 'Thành viên' };
    const dueAmount = Number(due.amount) || defaultMonthlyFee;

    if (isApproved) {
      due.status = 'paid';
      due.approvedBy = approverName;
      due.approvedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');

      // Thêm hoặc cập nhật giao dịch thu quỹ (liên kết 1-1 với dueId để chống tạo đúp)
      if (!data.transactions) data.transactions = [];
      const existingTxIdx = data.transactions.findIndex(t => t.dueId === due.id);
      const txRecord = {
        id: existingTxIdx >= 0 ? data.transactions[existingTxIdx].id : `tx_${Date.now()}`,
        dueId: due.id,
        date: new Date().toISOString().slice(0, 10),
        type: 'income',
        category: 'Quỹ tháng',
        title: `Thu quỹ T${this.currentMonth.slice(5)} từ ${member.name}`,
        amount: dueAmount,
        createdBy: approverName,
        note: `Admin duyệt chuyển khoản (${member.name})`
      };
      if (existingTxIdx >= 0) {
        data.transactions[existingTxIdx] = txRecord;
      } else {
        data.transactions.unshift(txRecord);
      }

      App.showToast(`⏳ Đang lưu xác nhận duyệt quỹ cho ${member.name} lên Cloud...`, "info");
      const result = await AppStorage.saveDataWithCloudAck(data);
      if (result.success) {
        App.showToast(`✅ Đã duyệt quỹ thành công cho ${member.name}! Sổ quỹ đã ghi nhận và lưu Cloud vĩnh viễn.`, "success");
      } else {
        App.showToast(`⚠️ Đã duyệt trên máy, đang chờ đồng bộ lại Cloud.`, "warning");
      }
    } else {
      due.status = 'unpaid';
      due.note = 'Ban quản trị từ chối xác nhận';
      // Xóa giao dịch thu quỹ nếu có
      if (Array.isArray(data.transactions)) {
        data.transactions = data.transactions.filter(t => t.dueId !== due.id);
      }
      App.showToast(`⏳ Đang lưu từ chối giao dịch lên Cloud...`, "info");
      await AppStorage.saveDataWithCloudAck(data);
      App.showToast(`Đã từ chối xác nhận quỹ của ${member.name}.`, "warning");
    }

    this.renderFundDashboard();
    App.refreshDashboardStats();
  },

  async markPaidCash(memberId) {
    if (!AppStorage.can('finance')) {
      App.showToast("Chỉ Ban quản trị/Thủ quỹ mới có quyền ghi nhận thu tiền mặt!", "warning");
      App.showAuthModal('login');
      return;
    }

    const data = AppStorage.loadData();
    const defaultMonthlyFee = this.getClubFee(data);
    const currentUser = data.currentUser || AppStorage.getCurrentUser();
    const approverName = (currentUser && currentUser.name) || 'Ban quản trị CLB';
    const member = (data.members || []).find(m => m.id === memberId);
    if (!member) return;

    if (!data.monthlyContributions) data.monthlyContributions = [];

    const nowStr = new Date().toISOString().slice(0, 16).replace('T', ' ');
    let dueIndex = data.monthlyContributions.findIndex(d => d.memberId === memberId && d.month === this.currentMonth);
    const dueId = dueIndex >= 0 ? data.monthlyContributions[dueIndex].id : `due_${this.currentMonth}_${memberId}`;
    const dueAmount = (dueIndex >= 0 && Number(data.monthlyContributions[dueIndex].amount)) ? Number(data.monthlyContributions[dueIndex].amount) : defaultMonthlyFee;

    const record = {
      id: dueId,
      month: this.currentMonth,
      memberId: memberId,
      amount: dueAmount,
      status: 'paid',
      paidAt: nowStr,
      method: 'Tiền mặt',
      billImage: null,
      approvedBy: approverName,
      approvedAt: nowStr,
      note: 'Đã nộp tiền mặt trực tiếp'
    };

    if (dueIndex >= 0) {
      data.monthlyContributions[dueIndex] = record;
    } else {
      data.monthlyContributions.push(record);
    }

    // Thêm hoặc cập nhật giao dịch thu tiền mặt với dueId
    if (!data.transactions) data.transactions = [];
    const existingTxIdx = data.transactions.findIndex(t => t.dueId === dueId);
    const txRecord = {
      id: existingTxIdx >= 0 ? data.transactions[existingTxIdx].id : `tx_${Date.now()}`,
      dueId: dueId,
      date: new Date().toISOString().slice(0, 10),
      type: 'income',
      category: 'Quỹ tháng',
      title: `Thu tiền mặt quỹ T${this.currentMonth.slice(5)} từ ${member.name}`,
      amount: dueAmount,
      createdBy: approverName,
      note: `Tiền mặt thu trên sân (${member.name})`
    };

    if (existingTxIdx >= 0) {
      data.transactions[existingTxIdx] = txRecord;
    } else {
      data.transactions.unshift(txRecord);
    }

    App.showToast(`⏳ Đang lưu giao dịch tiền mặt của ${member.name} lên Cloud...`, "info");
    const result = await AppStorage.saveDataWithCloudAck(data);

    if (result.success) {
      App.showToast(`✅ Đã ghi nhận nộp tiền mặt cho ${member.name} (${dueAmount.toLocaleString('vi-VN')}đ) và đồng bộ Cloud thành công!`, "success");
    } else {
      App.showToast(`⚠️ Đã ghi nhận trên máy, đang chờ kết nối lại Cloud.`, "warning");
    }

    this.renderFundDashboard();
    App.refreshDashboardStats();
  },

  async resetDueStatus(memberId) {
    if (!(await App.confirm("Bạn có chắc chắn muốn chuyển trạng thái thành viên này về Chưa đóng?\nGiao dịch thu quỹ tương ứng trong Sổ quỹ sẽ tự động được thu hồi/xóa."))) return;
    const data = AppStorage.loadData();
    let due = (data.monthlyContributions || []).find(d => d.memberId === memberId && d.month === this.currentMonth);
    if (due) {
      due.status = 'unpaid';
      due.paidAt = null;
      due.approvedBy = null;
      due.approvedAt = null;
      due.note = 'Chưa đóng';

      // Thu hồi / Xóa giao dịch thu quỹ tương ứng trong Sổ quỹ (transactions)
      if (Array.isArray(data.transactions)) {
        data.transactions = data.transactions.filter(t => t.dueId !== due.id);
      }

      App.showToast(`⏳ Đang cập nhật trạng thái và khấu trừ số dư trên Cloud...`, "info");
      const result = await AppStorage.saveDataWithCloudAck(data);
      if (result.success) {
        App.showToast("✅ Đã chuyển về trạng thái Chưa đóng và cập nhật số dư Sổ quỹ trên Cloud!", "success");
      } else {
        App.showToast("⚠️ Đã cập nhật trên máy, đang chờ đồng bộ lại Cloud.", "warning");
      }

      this.renderFundDashboard();
      App.refreshDashboardStats();
    }
  },

  async previewBill(dueId, memberName) {
    const due = ((AppStorage.loadData().monthlyContributions) || []).find(d => d.id === dueId);
    const modalBody = `
      <div class="text-center">
        <h4 style="margin-bottom: 1rem;">Biên lai chuyển khoản của <strong>${Safe.html(memberName)}</strong></h4>
        <img id="bill-preview-modal-img" alt="Biên lai thanh toán" style="max-width: 100%; max-height: 480px; min-height: 40px; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.3);">
        <div style="margin-top: 1.25rem;">
          <button class="btn btn-secondary" onclick="App.closeModal()">Đóng</button>
        </div>
      </div>
    `;
    App.openModal("🧾 Ảnh biên lai chuyển khoản", modalBody);
    const img = await AppStorage.getBill(due);
    const el = document.getElementById('bill-preview-modal-img');
    if (!el) return;
    if (img) el.src = Safe.url(img);
    else el.replaceWith(Object.assign(document.createElement('div'), { className: 'text-secondary', textContent: 'Không tải được ảnh biên lai.' }));
  },

  // Báo cáo quỹ: mỗi dòng là phiếu quỹ của một thành viên trong một tháng (lọc theo cột "Tháng" trong Excel/Sheets)
  exportDuesCSV() {
    if (!AppStorage.can('finance')) { App.showToast('Bạn không có quyền xuất báo cáo quỹ.', 'warning'); return; }
    const data = AppStorage.loadData();
    const names = new Map((data.members || []).map(m => [m.id, m.name]));
    const statusText = { paid: 'Đã đóng', pending: 'Chờ duyệt', unpaid: 'Chưa đóng' };
    const dues = (data.monthlyContributions || []).slice().sort((a, b) => String(b.month).localeCompare(String(a.month)) || String(names.get(a.memberId) || '').localeCompare(String(names.get(b.memberId) || '')));
    Csv.download(`smash_pro_quy_thang_${new Date().toISOString().slice(0, 10)}.csv`,
      ['Tháng', 'Thành viên', 'Số tiền (VNĐ)', 'Trạng thái', 'Ngày đóng', 'Hình thức', 'Người duyệt'],
      dues.map(d => [d.month, names.get(d.memberId) || d.memberId, d.amount || 0, statusText[d.status] || d.status, d.paidAt || '', d.method || '', d.approvedBy || '']));
    App.showToast(`Đã xuất báo cáo quỹ (${dues.length} dòng).`, 'success');
  },

  sendReminderMessage() {
    const data = AppStorage.loadData();
    const members = (data.members || []).filter(m => m.type === 'fixed');
    const dues = data.monthlyContributions || [];
    const info = data.clubInfo || {};
    const bank = info.bank && info.bank.accountNo ? info.bank : { bankName: '(chưa cấu hình)', accountNo: '(chưa cấu hình)', accountName: '(chưa cấu hình)' };
    const defaultMonthlyFee = this.getClubFee(data);

    const unpaidMembers = members.filter(m => {
      const due = dues.find(d => d.memberId === m.id && d.month === this.currentMonth);
      return !due || due.status === 'unpaid';
    });

    if (unpaidMembers.length === 0) {
      App.showToast("Tất cả thành viên đã đóng quỹ đầy đủ trong tháng này!", "success");
      return;
    }

    const unpaidNames = unpaidMembers.map((m, idx) => {
      const due = dues.find(d => d.memberId === m.id && d.month === this.currentMonth);
      const amount = Number(due && due.amount) || defaultMonthlyFee;
      return `${idx + 1}. @${m.name} (${AppStorage.maskPhone(m.phone, m.id)}) - ${amount.toLocaleString('vi-VN')}đ`;
    }).join('\n');

    const reminderMsg = `📢 [${info.shortName || 'SMASH'}] NHẮC NHỞ ĐÓNG QUỸ TIỀN SÂN THÁNG ${this.currentMonth.slice(5)}/${this.currentMonth.slice(0, 4)}

Chào cả nhà, hiện tại còn ${unpaidMembers.length} thành viên chưa đóng quỹ tháng:
${unpaidNames}

💰 Mức đóng tiêu chuẩn: ${defaultMonthlyFee.toLocaleString('vi-VN')} VNĐ / người
🏦 Ngân hàng: ${bank.bankName}
💳 Số tài khoản: ${bank.accountNo}
👤 Chủ tài khoản: ${bank.accountName}
📝 Cú pháp CK: CLB ${(info.shortName || 'SMASH').toUpperCase()} T${this.currentMonth.slice(5)} [Tên bạn]

👉 Mọi người tranh thủ chuyển khoản sớm để thủ quỹ chốt tiền sân nhé! Cảm ơn cả nhà ❤️`;

    navigator.clipboard.writeText(reminderMsg).then(() => {
      App.showToast("Đã sao chép nội dung nhắc nhở quỹ vào Clipboard! Bạn có thể dán vào nhóm Zalo/Telegram ngay.", "success");
    }).catch(() => {
      App.showText("Sao chép nội dung nhắc nhở:", reminderMsg);
    });
  }
};

window.FundModule = FundModule;
;

// ===== js/modules/cashbook.js =====
// Cashbook & Financial Transactions Module with Charts, Edit & Delete capabilities
// Hỗ trợ Quản lý Thu - Chi, Chỉnh sửa/Xóa giao dịch (Admin), Biểu đồ tỷ lệ & Xuất CSV

const CashbookModule = {
  chartInstance: null,

  renderCashbook() {
    const data = AppStorage.loadData();
    const txs = data.transactions || [];
    const isAdmin = AppStorage.can('finance');
    
    // Sắp xếp giao dịch mới nhất lên đầu
    const sortedTxs = [...txs].sort((a, b) => new Date(b.date) - new Date(a.date));

    // Tính toán tổng thu, tổng chi và số dư
    let totalIncome = 0;
    let totalExpense = 0;

    sortedTxs.forEach(t => {
      if (t.type === 'income') totalIncome += Number(t.amount);
      if (t.type === 'expense') totalExpense += Number(t.amount);
    });

    const currentBalance = totalIncome - totalExpense;

    // Cập nhật các thẻ thống kê tổng quan
    const balEl = document.getElementById('cashbook-balance');
    const incEl = document.getElementById('cashbook-income');
    const expEl = document.getElementById('cashbook-expense');

    if (balEl) balEl.innerText = `${currentBalance.toLocaleString('vi-VN')} đ`;
    if (incEl) incEl.innerText = `+${totalIncome.toLocaleString('vi-VN')} đ`;
    if (expEl) expEl.innerText = `-${totalExpense.toLocaleString('vi-VN')} đ`;

    // Render danh sách giao dịch
    const listContainer = document.getElementById('transaction-list-container');
    if (listContainer) {
      if (sortedTxs.length === 0) {
        listContainer.innerHTML = `
          <div class="text-center text-muted" style="padding: 2.5rem 1rem;">
            <i class="fas fa-receipt" style="font-size: 2rem; margin-bottom: 0.5rem; display: block; opacity: 0.5;"></i>
            Chưa có giao dịch thu chi nào trong sổ quỹ.
          </div>
        `;
      } else {
        listContainer.innerHTML = sortedTxs.map(t => {
          const isIncome = t.type === 'income';
          return `
            <div class="transaction-item ${isIncome ? 'income' : 'expense'}" style="display: flex; justify-content: space-between; align-items: center; padding: 0.85rem 1rem; border-bottom: 1px solid var(--border-color);">
              <div class="flex items-center gap-3">
                <div class="transaction-type-icon" style="width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: ${isIncome ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)'}; color: ${isIncome ? 'var(--primary)' : 'var(--danger)'};">
                  <i class="fas ${isIncome ? 'fa-arrow-down' : 'fa-arrow-up'}"></i>
                </div>
                <div>
                  <div class="font-bold" style="font-size: 0.95rem; color: var(--text-main);">${Safe.html(t.title)}</div>
                  <div class="text-secondary" style="font-size: 0.78rem; margin-top: 0.15rem;">
                    <span><i class="far fa-calendar-alt"></i> ${Safe.html(t.date)}</span> • 
                    <span class="badge badge-neutral" style="font-size: 0.7rem; padding: 0.1rem 0.35rem;">${Safe.html(t.category)}</span> • 
                    <span>Ghi nhận bởi: <strong>${Safe.html(t.createdBy || 'Admin')}</strong></span>
                    ${t.updatedAt ? ` • <span class="text-muted" style="font-style: italic;">(Đã sửa)</span>` : ''}
                  </div>
                </div>
              </div>
              <div class="text-right flex flex-col items-end gap-1">
                <div class="transaction-amount ${isIncome ? 'income' : 'expense'}" style="font-weight: 700; font-size: 1rem; color: ${isIncome ? 'var(--primary)' : 'var(--danger)'};">
                  ${isIncome ? '+' : '-'}${Number(t.amount).toLocaleString('vi-VN')} đ
                </div>
                ${t.note ? `<div class="text-muted" style="font-size: 0.75rem; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">"${Safe.html(t.note)}"</div>` : ''}
                ${isAdmin ? `
                  <div class="flex items-center gap-1" style="margin-top: 0.25rem;">
                    <button class="btn btn-secondary btn-xs" onclick="event.stopPropagation(); CashbookModule.openEditTransactionModal(${Safe.js(t.id)})" title="Chỉnh sửa giao dịch này" style="padding: 0.15rem 0.5rem; font-size: 0.72rem; border-radius: 4px;">
                      <i class="fas fa-edit text-primary"></i> Sửa
                    </button>
                    <button class="btn btn-outline-danger btn-xs" onclick="event.stopPropagation(); CashbookModule.deleteTransaction(${Safe.js(t.id)})" title="Xóa giao dịch này" style="padding: 0.15rem 0.5rem; font-size: 0.72rem; border-radius: 4px;">
                      <i class="fas fa-trash-alt"></i> Xóa
                    </button>
                  </div>
                ` : ''}
              </div>
            </div>
          `;
        }).join('');
      }
    }

    // Render or update Chart.js
    this.renderChart(totalIncome, totalExpense, currentBalance);
  },

  renderChart(income, expense, balance) {
    const canvas = document.getElementById('financial-chart');
    if (!canvas || !window.Chart) return;

    if (this.chartInstance) {
      this.chartInstance.destroy();
    }

    const isZero = income === 0 && expense === 0 && balance === 0;

    const ctx = canvas.getContext('2d');
    this.chartInstance = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: isZero ? ['Chưa có phát sinh thu chi'] : ['Tổng thu quỹ & vãng lai', 'Tổng chi sân & cầu', 'Số dư thực tế'],
        datasets: [{
          data: isZero ? [1] : [income, expense, Math.max(0, balance)],
          backgroundColor: isZero ? ['rgba(148, 163, 184, 0.15)'] : [
            'rgba(16, 185, 129, 0.85)',
            'rgba(239, 68, 68, 0.85)',
            'rgba(6, 182, 212, 0.85)'
          ],
          borderColor: isZero ? ['rgba(148, 163, 184, 0.3)'] : [
            '#10b981',
            '#ef4444',
            '#06b6d4'
          ],
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: '#94a3b8',
              font: { family: 'Plus Jakarta Sans', size: 12 }
            }
          },
          tooltip: {
            enabled: !isZero
          }
        },
        cutout: '65%'
      }
    });
  },

  openAddTransactionModal() {
    if (!AppStorage.can('finance')) {
      App.showToast("Chỉ Ban quản trị/Thủ quỹ mới có quyền ghi chép thu chi vào sổ quỹ!", "warning");
      App.showAuthModal('login');
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const modalBody = `
      <form id="form-add-tx" onsubmit="CashbookModule.saveTransaction(event)">
        <div class="form-group">
          <label class="form-label font-bold">Loại thu chi *</label>
          <div style="display: flex; gap: 1rem;">
            <label style="display: flex; align-items: center; gap: 0.4rem; cursor: pointer;">
              <input type="radio" name="tx-type" value="income" checked> 
              <span class="text-primary font-bold"><i class="fas fa-plus-circle"></i> Khoản thu (vào quỹ)</span>
            </label>
            <label style="display: flex; align-items: center; gap: 0.4rem; cursor: pointer;">
              <input type="radio" name="tx-type" value="expense"> 
              <span class="text-danger font-bold"><i class="fas fa-minus-circle"></i> Khoản chi (chi tiền)</span>
            </label>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label font-bold">Tiêu đề giao dịch *</label>
          <input type="text" id="tx-title" class="form-control" placeholder="VD: Mua 4 ống cầu Hải Yến, Tiền thuê sân..." required>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
          <div class="form-group">
            <label class="form-label font-bold">Số tiền (VNĐ) *</label>
            <input type="number" id="tx-amount" class="form-control" placeholder="300000" step="5000" required>
          </div>
          <div class="form-group">
            <label class="form-label font-bold">Danh mục</label>
            <select id="tx-category" class="form-select">
              <option value="Quỹ tháng">Quỹ tháng</option>
              <option value="Tiền thuê sân">Tiền thuê sân</option>
              <option value="Mua cầu lông">Mua cầu lông</option>
              <option value="Khách vãng lai">Khách vãng lai</option>
              <option value="Nước uống & Tiện ích">Nước uống & Tiện ích</option>
              <option value="Khác">Khác</option>
            </select>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label font-bold">Ngày giao dịch *</label>
          <input type="date" id="tx-date" class="form-control" value="${today}" required>
        </div>

        <div class="form-group">
          <label class="form-label">Ghi chú thêm</label>
          <input type="text" id="tx-note" class="form-control" placeholder="Ghi chú chi tiết hoặc tên người liên quan">
        </div>

        <div class="modal-footer" style="padding: 1rem 0 0 0;">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Hủy</button>
          <button type="submit" class="btn btn-primary"><i class="fas fa-check"></i> Lưu giao dịch</button>
        </div>
      </form>
    `;

    App.openModal("📝 Ghi chép thu chi sổ quỹ", modalBody);
  },

  async saveTransaction(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (!AppStorage.can('finance')) {
      App.showToast("Chỉ Ban quản trị/Thủ quỹ mới có quyền ghi chép thu chi vào sổ quỹ!", "warning");
      App.showAuthModal('login');
      return;
    }

    const data = AppStorage.loadData();
    const typeEl = document.querySelector('input[name="tx-type"]:checked');
    const type = typeEl ? typeEl.value : 'income';
    const title = (document.getElementById('tx-title')?.value || '').trim();
    const amount = Number(document.getElementById('tx-amount')?.value || 0);
    const category = document.getElementById('tx-category')?.value || 'Khác';
    const date = document.getElementById('tx-date')?.value || new Date().toISOString().slice(0, 10);
    const note = (document.getElementById('tx-note')?.value || '').trim();
    const currentUser = data.currentUser || AppStorage.getCurrentUser();
    const creatorName = (currentUser && currentUser.name) || 'Ban quản trị CLB';

    // 1. Kiểm tra tính hợp lệ dữ liệu nghiêm ngặt
    if (!title || title.length < 2) {
      App.showToast("Vui lòng nhập tiêu đề giao dịch rõ ràng (ít nhất 2 ký tự)!", "warning");
      return;
    }
    if (isNaN(amount) || amount <= 0) {
      App.showToast("Số tiền giao dịch phải là số dương lớn hơn 0đ!", "warning");
      return;
    }

    const btnSubmit = document.querySelector('#form-add-tx button[type="submit"]');
    if (btnSubmit) {
      btnSubmit.disabled = true;
      btnSubmit.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Đang lưu lên Cloud...';
    }

    if (!data.transactions) data.transactions = [];

    const newTx = {
      id: `tx_${Date.now()}`,
      date,
      type,
      category,
      title,
      amount,
      createdBy: creatorName,
      createdAt: new Date().toISOString(),
      note
    };

    data.transactions.unshift(newTx);
    
    // 2. Chờ xác nhận lưu an toàn vào CSDL Cloud (Two-Phase Cloud Sync Acknowledgment)
    App.showToast(`⏳ Đang ghi nhận giao dịch "${title}" và đồng bộ lên Cloud...`, "info");
    const result = await AppStorage.saveDataWithCloudAck(data);
    App.closeModal();

    // 3. Tính toán số dư mới
    let totInc = 0, totExp = 0;
    (data.transactions || []).forEach(t => {
      if (t.type === 'income') totInc += Number(t.amount);
      if (t.type === 'expense') totExp += Number(t.amount);
    });
    const newBal = totInc - totExp;

    if (result.success) {
      App.showToast(`✅ Giao dịch "${title}" (${type === 'income' ? '+' : '-'}${amount.toLocaleString('vi-VN')} đ) đã được lưu vĩnh viễn vào CSDL Cloud! Số dư mới: ${newBal.toLocaleString('vi-VN')} đ.`, "success");
    } else {
      App.showToast(`⚠️ Giao dịch đã lưu trên thiết bị nhưng máy chủ Cloud phản hồi chậm. Hệ thống sẽ tự động đồng bộ lại khi có kết nối!`, "warning");
    }

    this.renderCashbook();
    App.refreshDashboardStats();
  },

  // ==========================================
  // CHỈNH SỬA GIAO DỊCH THU CHI (ADMIN)
  // ==========================================
  openEditTransactionModal(txId) {
    if (!AppStorage.can('finance')) {
      App.showToast("Chỉ Ban quản trị/Thủ quỹ mới có quyền chỉnh sửa giao dịch thu chi!", "warning");
      return;
    }

    const data = AppStorage.loadData();
    const t = (data.transactions || []).find(tx => tx.id === txId);
    if (!t) {
      App.showToast("Không tìm thấy thông tin giao dịch cần chỉnh sửa!", "error");
      return;
    }

    const isIncome = t.type === 'income';
    const modalBody = `
      <form id="form-edit-tx" onsubmit="CashbookModule.saveEditTransaction(event, ${Safe.js(t.id)})">
        <div class="form-group">
          <label class="form-label font-bold">Loại thu chi *</label>
          <div style="display: flex; gap: 1rem;">
            <label style="display: flex; align-items: center; gap: 0.4rem; cursor: pointer;">
              <input type="radio" name="edit-tx-type" value="income" ${isIncome ? 'checked' : ''}> 
              <span class="text-primary font-bold"><i class="fas fa-plus-circle"></i> Khoản thu (vào quỹ)</span>
            </label>
            <label style="display: flex; align-items: center; gap: 0.4rem; cursor: pointer;">
              <input type="radio" name="edit-tx-type" value="expense" ${!isIncome ? 'checked' : ''}> 
              <span class="text-danger font-bold"><i class="fas fa-minus-circle"></i> Khoản chi (chi tiền)</span>
            </label>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label font-bold">Tiêu đề giao dịch *</label>
          <input type="text" id="edit-tx-title" class="form-control" value="${Safe.html(t.title)}" placeholder="VD: Mua 4 ống cầu Hải Yến, Tiền thuê sân..." required>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
          <div class="form-group">
            <label class="form-label font-bold">Số tiền (VNĐ) *</label>
            <input type="number" id="edit-tx-amount" class="form-control" value="${Safe.html(t.amount)}" placeholder="300000" step="5000" required>
          </div>
          <div class="form-group">
            <label class="form-label font-bold">Danh mục</label>
            <select id="edit-tx-category" class="form-select">
              <option value="Quỹ tháng" ${t.category === 'Quỹ tháng' ? 'selected' : ''}>Quỹ tháng</option>
              <option value="Tiền thuê sân" ${t.category === 'Tiền thuê sân' ? 'selected' : ''}>Tiền thuê sân</option>
              <option value="Mua cầu lông" ${t.category === 'Mua cầu lông' ? 'selected' : ''}>Mua cầu lông</option>
              <option value="Khách vãng lai" ${t.category === 'Khách vãng lai' ? 'selected' : ''}>Khách vãng lai</option>
              <option value="Nước uống & Tiện ích" ${t.category === 'Nước uống & Tiện ích' ? 'selected' : ''}>Nước uống & Tiện ích</option>
              <option value="Khác" ${t.category === 'Khác' ? 'selected' : ''}>Khác</option>
            </select>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label font-bold">Ngày giao dịch *</label>
          <input type="date" id="edit-tx-date" class="form-control" value="${Safe.html(t.date)}" required>
        </div>

        <div class="form-group">
          <label class="form-label">Ghi chú thêm</label>
          <input type="text" id="edit-tx-note" class="form-control" value="${Safe.html(t.note || '')}" placeholder="Ghi chú chi tiết hoặc tên người liên quan">
        </div>

        <div class="modal-footer" style="padding: 1rem 0 0 0; display: flex; justify-content: space-between; align-items: center;">
          <button type="button" class="btn btn-outline-danger btn-sm" onclick="CashbookModule.deleteTransaction(${Safe.js(t.id)})">
            <i class="fas fa-trash-alt"></i> Xóa giao dịch này
          </button>
          <div class="flex gap-2">
            <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Hủy</button>
            <button type="submit" class="btn btn-primary"><i class="fas fa-save"></i> Cập nhật thay đổi</button>
          </div>
        </div>
      </form>
    `;

    App.openModal("✏️ Chỉnh sửa giao dịch thu chi", modalBody);
  },

  async saveEditTransaction(e, txId) {
    if (e && e.preventDefault) e.preventDefault();
    if (!AppStorage.can('finance')) {
      App.showToast("Chỉ Ban quản trị/Thủ quỹ mới có quyền chỉnh sửa giao dịch thu chi!", "warning");
      return;
    }

    const data = AppStorage.loadData();
    const t = (data.transactions || []).find(tx => tx.id === txId);
    if (!t) {
      App.showToast("Không tìm thấy giao dịch để cập nhật!", "error");
      return;
    }

    const typeEl = document.querySelector('input[name="edit-tx-type"]:checked');
    const type = typeEl ? typeEl.value : 'income';
    const title = (document.getElementById('edit-tx-title')?.value || '').trim();
    const amount = Number(document.getElementById('edit-tx-amount')?.value || 0);
    const category = document.getElementById('edit-tx-category')?.value || 'Khác';
    const date = document.getElementById('edit-tx-date')?.value || t.date;
    const note = (document.getElementById('edit-tx-note')?.value || '').trim();
    const currentUser = data.currentUser || AppStorage.getCurrentUser();
    const updaterName = (currentUser && currentUser.name) || 'Admin';

    if (!title || title.length < 2) {
      App.showToast("Vui lòng nhập đầy đủ tiêu đề hợp lệ!", "warning");
      return;
    }
    if (isNaN(amount) || amount <= 0) {
      App.showToast("Số tiền phải là số dương lớn hơn 0đ!", "warning");
      return;
    }

    const btnSubmit = document.querySelector('#form-edit-tx button[type="submit"]');
    if (btnSubmit) {
      btnSubmit.disabled = true;
      btnSubmit.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Đang cập nhật Cloud...';
    }

    t.type = type;
    t.title = title;
    t.amount = amount;
    t.category = category;
    t.date = date;
    t.note = note;
    t.updatedAt = new Date().toISOString();
    t.updatedBy = updaterName;

    App.showToast(`⏳ Đang cập nhật giao dịch "${title}" lên CSDL Cloud...`, "info");
    const result = await AppStorage.saveDataWithCloudAck(data);
    App.closeModal();

    let totInc = 0, totExp = 0;
    (data.transactions || []).forEach(tx => {
      if (tx.type === 'income') totInc += Number(tx.amount);
      if (tx.type === 'expense') totExp += Number(tx.amount);
    });
    const newBal = totInc - totExp;

    if (result.success) {
      App.showToast(`✅ Đã cập nhật giao dịch "${title}" lên CSDL Cloud thành công! Số dư mới: ${newBal.toLocaleString('vi-VN')} đ.`, "success");
    } else {
      App.showToast(`⚠️ Đã lưu thay đổi trên máy, đang chờ kết nối lại Cloud.`, "warning");
    }

    this.renderCashbook();
    App.refreshDashboardStats();
  },

  // ==========================================
  // XÓA GIAO DỊCH THU CHI (ADMIN)
  // ==========================================
  async deleteTransaction(txId) {
    if (!AppStorage.can('finance')) {
      App.showToast("Chỉ Ban quản trị/Thủ quỹ mới có quyền xóa giao dịch thu chi!", "warning");
      return;
    }

    const data = AppStorage.loadData();
    const t = (data.transactions || []).find(tx => tx.id === txId);
    if (!t) {
      App.showToast("Không tìm thấy giao dịch cần xóa!", "error");
      return;
    }

    const amountFormatted = Number(t.amount).toLocaleString('vi-VN');
    if (!(await App.confirm(`Bạn có chắc chắn muốn xóa giao dịch "${t.title}" (${t.type === 'income' ? '+' : '-'}${amountFormatted} đ) khỏi sổ quỹ không?\nThao tác này sẽ đồng bộ trực tiếp lên Cloud.`))) {
      return;
    }

    data.transactions = (data.transactions || []).filter(tx => tx.id !== txId);
    App.showToast(`⏳ Đang xóa giao dịch khỏi CSDL Cloud...`, "info");
    const result = await AppStorage.saveDataWithCloudAck(data);
    App.closeModal();

    let totInc = 0, totExp = 0;
    (data.transactions || []).forEach(tx => {
      if (tx.type === 'income') totInc += Number(tx.amount);
      if (tx.type === 'expense') totExp += Number(tx.amount);
    });
    const newBal = totInc - totExp;

    if (result.success) {
      App.showToast(`🗑️ Đã xóa giao dịch "${t.title}" khỏi CSDL Cloud thành công! Số dư mới: ${newBal.toLocaleString('vi-VN')} đ.`, "info");
    } else {
      App.showToast(`⚠️ Đã xóa giao dịch trên máy, đang chờ kết nối lại Cloud.`, "warning");
    }

    this.renderCashbook();
    App.refreshDashboardStats();
  },

  exportCSV() {
    const data = AppStorage.loadData();
    const txs = data.transactions || [];
    Csv.download(`smash_pro_so_quy_${new Date().toISOString().slice(0, 10)}.csv`,
      ['Ngày', 'Loại', 'Danh mục', 'Tiêu đề', 'Số tiền (VNĐ)', 'Người ghi', 'Ghi chú'],
      txs.map(t => [t.date, t.type === 'income' ? 'Thu' : 'Chi', t.category, t.title, t.amount, t.createdBy || '', t.note || '']));
    App.showToast("Đã xuất file báo cáo thu chi CSV thành công!", "success");
  }
};

window.CashbookModule = CashbookModule;
;

// ===== js/modules/bill-splitter.js =====
// Bill Splitter Module for Post-Match Expenses & VietQR Links
// Tính tiền theo danh sách người tham gia (cố định / vãng lai / khách đi kèm),
// lưu cấu hình chia tiền vào buổi đánh (session.billSplit) và ghi vào sổ thu chi.

const BillSplitterModule = {
  currentSessionId: null,
  lastCalc: null,

  init() {
    this.populateSessionSelect();
    if (this.currentSessionId) {
      const select = document.getElementById('splitter-session-select');
      if (select) select.value = this.currentSessionId;
    }
    this.calculateBill();
  },

  esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },

  fmt(n) {
    return Number(n || 0).toLocaleString('vi-VN');
  },

  populateSessionSelect() {
    const select = document.getElementById('splitter-session-select');
    if (!select) return;

    const data = AppStorage.loadData();
    const sessions = [...(data.sessions || [])].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

    select.innerHTML = `
      <option value="">-- Chọn buổi đánh để tính tiền --</option>
      ${sessions.map(s => {
        const typeBadge = s.sessionType === 'guest' ? '[⚡ Vãng lai]' : '[🏸 Cố định]';
        const pollBadge = s.voteMode === 'multi_option' ? '[🗳️ Khảo sát]' : '';
        const savedBadge = s.billSplit && s.billSplit.savedAt ? '[✅ Đã chia]' : '';
        return `<option value="${Safe.html(s.id)}">${typeBadge} ${pollBadge} ${savedBadge} ${Safe.html(s.title)} (${Safe.html(s.date)} - ${Safe.html(s.courtNumbers || 'Nhiều sân')})</option>`;
      }).join('')}
    `;
  },

  setInput(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value;
  },

  num(id, fallback = 0) {
    const el = document.getElementById(id);
    if (!el || el.value === '') return fallback;
    const n = Number(el.value);
    return isNaN(n) || n < 0 ? fallback : n;
  },

  loadSessionForBill(sessionId) {
    this.currentSessionId = sessionId || null;
    const select = document.getElementById('splitter-session-select');
    if (select) select.value = sessionId || '';

    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    const saved = session && session.billSplit;

    if (saved) {
      this.setInput('bill-split-mode', saved.mode || 'guests_only');
      this.setInput('bill-court-fee', saved.courtFee ?? 0);
      this.setInput('bill-shuttle-tubes', saved.shuttleTubes ?? 0);
      this.setInput('bill-shuttle-price', saved.shuttlePrice ?? this.inventoryTubePrice(data));
      this.setInput('bill-drink-fee', saved.drinkFee ?? 0);
      this.setInput('bill-other-fee', saved.otherFee ?? 0);
      this.setInput('bill-guest-fee', saved.guestFee ?? (Number(data.clubInfo?.guestFee) || 0));
      this.setInput('bill-player-count', saved.extraGuests ?? 0);
    } else {
      this.setInput('bill-split-mode', session && session.sessionType === 'guest' ? 'all' : 'guests_only');
      // Buổi chưa có số liệu: chỉ lấy dữ liệu đã nhập (giá sân của buổi, giá ống trong Kho cầu), còn lại để trống
      this.setInput('bill-court-fee', session && Number(session.courtPrice) ? Number(session.courtPrice) : '');
      this.setInput('bill-shuttle-tubes', '');
      this.setInput('bill-shuttle-price', this.inventoryTubePrice(data));
      this.setInput('bill-drink-fee', '');
      this.setInput('bill-other-fee', '');
      this.setInput('bill-guest-fee', Number(data.clubInfo?.guestFee) || '');
      this.setInput('bill-player-count', 0);
    }

    this.calculateBill();
  },

  // Danh sách người tham gia từ phiếu bình chọn của buổi đánh
  getParticipants(session, data) {
    if (!session) return [];
    const members = data.members || [];
    const users = data.users || [];
    let votes = session.votes || [];

    if (session.voteMode === 'multi_option') {
      votes = votes.filter(v => !v.notGoing && (session.selectedOptionId
        ? (v.selectedOptions || []).includes(session.selectedOptionId)
        : (v.selectedOptions || []).length > 0));
    } else {
      votes = votes.filter(v => v.status === 'going');
    }

    const list = [];
    votes.forEach(v => {
      const member = members.find(m => m.id === v.memberId || (m.username && m.username === v.memberId)) ||
                     users.find(u => u.id === v.memberId || u.memberId === v.memberId);
      const name = (member && member.name) || 'Thành viên';
      const isFixed = !!member && (member.type || 'fixed') === 'fixed';
      list.push({ key: `m:${v.memberId}`, name, kind: isFixed ? 'fixed' : 'guest' });
      const guests = Number(v.guests) || 0;
      for (let i = 1; i <= guests; i++) {
        list.push({ key: `g:${v.memberId}:${i}`, name: `Khách ${i} của ${name}`, kind: 'guest' });
      }
    });
    return list;
  },

  computeBill() {
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === this.currentSessionId) || null;
    const saved = (session && session.billSplit) || {};

    const courtFee = this.num('bill-court-fee');
    const shuttleTubes = this.num('bill-shuttle-tubes');
    const shuttlePrice = this.num('bill-shuttle-price', 0);
    const drinkFee = this.num('bill-drink-fee');
    const otherFee = this.num('bill-other-fee');
    const guestFee = this.num('bill-guest-fee', Number(data.clubInfo?.guestFee) || 0);
    const extraGuests = Math.floor(this.num('bill-player-count'));
    const mode = document.getElementById('bill-split-mode')?.value || 'guests_only'; // all | guests_only

    const excluded = new Set(saved.excluded || []);
    const payments = saved.payments || {};

    const people = this.getParticipants(session, data);
    for (let i = 1; i <= extraGuests; i++) {
      people.push({ key: `x:${i}`, name: `Khách thêm ${i}`, kind: 'guest' });
    }
    people.forEach(p => { p.attending = !excluded.has(p.key); });

    const attending = people.filter(p => p.attending);
    const totalShuttle = shuttleTubes * shuttlePrice;
    const totalCost = courtFee + totalShuttle + drinkFee + otherFee;
    const fixedCount = attending.filter(p => p.kind === 'fixed').length;
    const guestCount = attending.length - fixedCount;
    const perPersonAll = attending.length > 0 ? Math.ceil(totalCost / attending.length / 1000) * 1000 : 0;

    people.forEach(p => {
      if (!p.attending) p.amount = 0;
      else if (mode === 'all') p.amount = perPersonAll;
      else p.amount = p.kind === 'fixed' ? 0 : guestFee;
      p.paid = p.amount > 0 && !!(payments[p.key] && payments[p.key].paid);
    });

    const totalDue = people.reduce((acc, p) => acc + p.amount, 0);
    const totalPaid = people.filter(p => p.paid).reduce((acc, p) => acc + p.amount, 0);
    // Dương: quỹ CLB phải bù; âm: quỹ dư thêm
    const fundCovers = totalCost - totalDue;

    return {
      data, session, mode,
      courtFee, shuttleTubes, shuttlePrice, totalShuttle, drinkFee, otherFee, guestFee, extraGuests,
      totalCost, people, attendingCount: attending.length, fixedCount, guestCount, perPersonAll,
      totalDue, totalPaid, fundCovers
    };
  },

  calculateBill() {
    const resultBox = document.getElementById('bill-calculation-result');
    if (!resultBox) return;

    const c = this.computeBill();
    this.lastCalc = c;
    const { data, session } = c;
    const bank = (data.clubInfo && data.clubInfo.bank) || {};
    const bankName = bank.bankName || bank.bankId || '';
    const kindLabel = { fixed: '🏸 Cố định', guest: '⚡ Vãng lai / Khách' };
    const recorded = !!(session && session.billSplit && session.billSplit.savedAt);

    const rows = c.people.map(p => `
      <tr style="${p.attending ? '' : 'opacity: 0.45;'}">
        <td style="padding: 0.4rem;">
          <input type="checkbox" ${p.attending ? 'checked' : ''} ${session ? '' : 'disabled'}
            onchange="BillSplitterModule.toggleAttendance(${Safe.js(p.key)}, this.checked)" title="Có tham gia">
        </td>
        <td style="padding: 0.4rem;">${Safe.html(p.name)}</td>
        <td style="padding: 0.4rem; font-size: 0.8rem;">${kindLabel[p.kind]}</td>
        <td style="padding: 0.4rem; text-align: right;" class="font-mono">${p.amount > 0 ? this.fmt(p.amount) + ' đ' : (p.attending && c.mode !== 'all' && p.kind === 'fixed' ? 'Trừ quỹ' : '-')}</td>
        <td style="padding: 0.4rem; text-align: center;">
          ${p.amount > 0 ? `
            <button type="button" class="btn btn-xs ${p.paid ? 'btn-primary' : 'btn-secondary'}" ${session ? '' : 'disabled'}
              onclick="BillSplitterModule.togglePaid(${Safe.js(p.key)})">
              ${p.paid ? '<i class="fas fa-check"></i> Đã trả' : 'Chưa trả'}
            </button>` : ''}
        </td>
      </tr>
    `).join('');

    const payLines = c.people.filter(p => p.amount > 0)
      .map(p => `- ${p.name}: ${this.fmt(p.amount)}đ${p.paid ? ' ✅' : ''}`).join('\n');

    const shareText = `🏸 [${data.clubInfo?.shortName || 'CLB'}] TỔNG KẾT TIỀN SÂN ${session ? `(${session.title} - ${session.date})` : 'HÔM NAY'}:
- Hình thức: ${c.mode === 'all' ? 'Chia đều cho tất cả người tham gia' : 'Cố định trừ quỹ - Thu vãng lai'}
- Tiền sân: ${this.fmt(c.courtFee)}đ
- Tiền cầu (${c.shuttleTubes} ống): ${this.fmt(c.totalShuttle)}đ
- Nước uống / Khác: ${this.fmt(c.drinkFee + c.otherFee)}đ
👉 Tổng cộng: ${this.fmt(c.totalCost)}đ (${c.attendingCount} người: ${c.fixedCount} cố định, ${c.guestCount} vãng lai/khách)

💰 CẦN ĐÓNG:
${payLines || '- Không ai cần đóng thêm (trừ quỹ toàn bộ)'}
${c.mode !== 'all' ? `- Thành viên cố định: Đã trừ vào quỹ tháng.\n` : ''}
🏦 STK: ${bank.accountNo || ''} (${bankName})
👤 Chủ TK: ${bank.accountName || ''}
📝 Cú pháp: TIEN SAN [Tên bạn]`;

    resultBox.innerHTML = `
      <div class="split-result-box">
        <div class="flex justify-between items-center" style="border-bottom: 1px solid var(--border-color); padding-bottom: 0.75rem; margin-bottom: 1rem; flex-wrap: wrap; gap: 0.5rem;">
          <div>
            <div class="text-secondary" style="font-size: 0.85rem;">Tổng chi phí buổi đánh</div>
            <div class="split-amount-highlight">${this.fmt(c.totalCost)} đ</div>
          </div>
          <div class="text-right">
            <div class="text-secondary" style="font-size: 0.85rem;">Người tham gia:</div>
            <div class="font-bold font-mono" style="font-size: 1.3rem;">${c.attendingCount} người</div>
            <div class="text-muted" style="font-size: 0.75rem;">${c.fixedCount} cố định • ${c.guestCount} vãng lai/khách</div>
          </div>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 0.75rem; margin-bottom: 1rem;">
          <div class="card" style="padding: 0.85rem; background: var(--bg-card);">
            <div class="text-secondary" style="font-size: 0.8rem;">Mỗi người ${c.mode === 'all' ? '(chia đều)' : 'vãng lai'}</div>
            <div class="font-bold text-warning" style="font-size: 1.1rem;">${this.fmt(c.mode === 'all' ? c.perPersonAll : c.guestFee)} đ</div>
          </div>
          <div class="card" style="padding: 0.85rem; background: var(--bg-card);">
            <div class="text-secondary" style="font-size: 0.8rem;">Tổng phải thu</div>
            <div class="font-bold text-primary" style="font-size: 1.1rem;">${this.fmt(c.totalDue)} đ</div>
            <div class="text-muted" style="font-size: 0.75rem;">Đã thu: ${this.fmt(c.totalPaid)} đ</div>
          </div>
          <div class="card" style="padding: 0.85rem; background: var(--bg-card);">
            <div class="text-secondary" style="font-size: 0.8rem;">${c.fundCovers >= 0 ? 'Quỹ CLB bù' : 'Quỹ CLB dư thêm'}</div>
            <div class="font-bold ${c.fundCovers >= 0 ? 'text-danger' : 'text-primary'}" style="font-size: 1.1rem;">${this.fmt(Math.abs(c.fundCovers))} đ</div>
          </div>
        </div>

        <div style="background: var(--bg-card); padding: 0.75rem; border-radius: var(--radius-md); border: 1px solid var(--border-color); margin-bottom: 1rem; overflow-x: auto;">
          <strong style="font-size: 0.9rem;"><i class="fas fa-users text-primary"></i> Danh sách từng người</strong>
          ${c.people.length === 0 ? `
            <div class="text-muted" style="font-size: 0.85rem; margin-top: 0.5rem;">
              ${session ? 'Buổi này chưa có ai đăng ký tham gia. Nhập số "Khách thêm ngoài danh sách vote" để tính.' : 'Chọn buổi đánh để lấy danh sách người tham gia.'}
            </div>
          ` : `
            <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem; margin-top: 0.5rem;">
              <thead>
                <tr class="text-secondary" style="text-align: left; border-bottom: 1px solid var(--border-color);">
                  <th style="padding: 0.4rem;">Đi</th><th style="padding: 0.4rem;">Tên</th><th style="padding: 0.4rem;">Loại</th>
                  <th style="padding: 0.4rem; text-align: right;">Số tiền</th><th style="padding: 0.4rem; text-align: center;">Trạng thái</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          `}
          ${!session ? '' : `
            <div class="text-muted" style="font-size: 0.75rem; margin-top: 0.5rem;">
              Bấm "Chưa trả" → "Đã trả" sẽ tự ghi một khoản thu vào sổ quỹ; bấm lại để hủy khoản thu đó.
            </div>
          `}
        </div>

        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1rem;">
          <button type="button" class="btn btn-primary btn-sm" onclick="BillSplitterModule.saveBill()" ${session ? '' : 'disabled title="Chọn buổi đánh trước"'}>
            <i class="fas fa-save"></i> ${recorded ? 'Cập nhật & ghi sổ quỹ' : 'Lưu & ghi sổ quỹ'}
          </button>
          ${recorded ? `<span class="badge badge-paid" style="align-self: center;"><i class="fas fa-check"></i> Đã ghi sổ lúc ${new Date(session.billSplit.savedAt).toLocaleString('vi-VN')}</span>` : ''}
        </div>

        <div style="background: var(--bg-card); padding: 1rem; border-radius: var(--radius-md); border: 1px solid var(--border-color); font-size: 0.85rem;">
          <div class="flex justify-between items-center" style="margin-bottom: 0.5rem;">
            <strong><i class="fas fa-file-invoice-dollar text-primary"></i> Nội dung tổng kết gửi nhóm Zalo:</strong>
            <button class="btn btn-secondary btn-sm" onclick="BillSplitterModule.copyBillText()">
              <i class="far fa-copy"></i> Sao chép
            </button>
          </div>
          <pre id="bill-share-text" style="white-space: pre-wrap; font-family: inherit; color: var(--text-secondary); line-height: 1.4;">${Safe.html(shareText)}</pre>
        </div>
      </div>
    `;
  },

  // Lấy (và tạo nếu chưa có) cấu hình chia tiền của buổi đánh
  // Giá 1 ống cầu lấy từ Kho cầu do người dùng nhập (không dùng giá mẫu); chưa có thì để trống
  inventoryTubePrice(data) {
    const item = ((data && data.inventory) || []).find((i) => Number(i.pricePerTube) > 0);
    return item ? Number(item.pricePerTube) : '';
  },

  ensureBillSplit(session) {
    if (!session.billSplit) session.billSplit = { excluded: [], payments: {} };
    if (!Array.isArray(session.billSplit.excluded)) session.billSplit.excluded = [];
    if (!session.billSplit.payments) session.billSplit.payments = {};
    return session.billSplit;
  },

  incomeTxId(sessionId, key) {
    return `tx_bill_inc_${sessionId}_${key.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  },

  toggleAttendance(key, attending) {
    if (!AppStorage.can('finance') || !this.currentSessionId) return;
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === this.currentSessionId);
    if (!session) return;

    const bill = this.ensureBillSplit(session);
    bill.excluded = bill.excluded.filter(k => k !== key);
    if (!attending) {
      bill.excluded.push(key);
      // Người không đi thì hủy khoản thu đã ghi (nếu có)
      if (bill.payments[key] && bill.payments[key].paid) {
        delete bill.payments[key];
        const txId = this.incomeTxId(session.id, key);
        data.transactions = (data.transactions || []).filter(t => t.id !== txId);
      }
    }
    AppStorage.saveData(data);
    this.calculateBill();
  },

  async togglePaid(key) {
    if (!AppStorage.can('finance')) {
      App.showToast("Chỉ Ban quản trị/Thủ quỹ mới có quyền xác nhận thu tiền!", "warning");
      return;
    }
    const c = this.computeBill();
    const person = c.people.find(p => p.key === key);
    if (!c.session || !person || person.amount <= 0) return;

    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === c.session.id);
    if (!session) return;
    const bill = this.ensureBillSplit(session);
    const txId = this.incomeTxId(session.id, key);
    if (!data.transactions) data.transactions = [];

    if (person.paid) {
      delete bill.payments[key];
      data.transactions = data.transactions.filter(t => t.id !== txId);
    } else {
      const currentUser = data.currentUser || AppStorage.getCurrentUser();
      bill.payments[key] = { paid: true, amount: person.amount, paidAt: new Date().toISOString() };
      data.transactions = data.transactions.filter(t => t.id !== txId);
      data.transactions.unshift({
        id: txId,
        date: new Date().toISOString().slice(0, 10),
        type: 'income',
        category: 'Khách vãng lai',
        title: `Thu tiền sân - ${person.name} (${session.title} ${session.date})`,
        amount: person.amount,
        createdBy: (currentUser && currentUser.name) || 'Ban quản trị CLB',
        createdAt: new Date().toISOString(),
        note: 'Tạo tự động từ Chia tiền sân',
        billSessionId: session.id
      });
    }

    const result = await AppStorage.saveDataWithCloudAck(data);
    if (!result.success) {
      App.showToast("⚠️ Đã lưu trên thiết bị, sẽ tự đồng bộ lên Cloud khi có kết nối.", "warning");
    }
    this.calculateBill();
  },

  // Lưu cấu hình chia tiền vào buổi đánh + ghi khoản chi vào sổ quỹ
  async saveBill() {
    if (!AppStorage.can('finance')) {
      App.showToast("Chỉ Ban quản trị/Thủ quỹ mới có quyền ghi sổ quỹ!", "warning");
      return;
    }
    const c = this.computeBill();
    if (!c.session) {
      App.showToast("Vui lòng chọn buổi đánh trước khi lưu!", "warning");
      return;
    }

    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === c.session.id);
    if (!session) return;
    const bill = this.ensureBillSplit(session);
    const currentUser = data.currentUser || AppStorage.getCurrentUser();
    const creator = (currentUser && currentUser.name) || 'Ban quản trị CLB';
    const now = new Date().toISOString();

    Object.assign(bill, {
      mode: c.mode,
      courtFee: c.courtFee,
      shuttleTubes: c.shuttleTubes,
      shuttlePrice: c.shuttlePrice,
      drinkFee: c.drinkFee,
      otherFee: c.otherFee,
      guestFee: c.guestFee,
      extraGuests: c.extraGuests,
      totalCost: c.totalCost,
      totalDue: c.totalDue,
      savedAt: Date.now(),
      savedBy: creator
    });

    if (!data.transactions) data.transactions = [];
    const expTxId = `tx_bill_exp_${session.id}`;
    data.transactions = data.transactions.filter(t => t.id !== expTxId);
    if (c.totalCost > 0) {
      data.transactions.unshift({
        id: expTxId,
        date: session.date || now.slice(0, 10),
        type: 'expense',
        category: 'Tiền thuê sân',
        title: `Chi phí buổi ${session.title} (${session.date})`,
        amount: c.totalCost,
        createdBy: creator,
        createdAt: now,
        note: `Sân ${this.fmt(c.courtFee)}đ • Cầu ${c.shuttleTubes} ống ${this.fmt(c.totalShuttle)}đ • Nước ${this.fmt(c.drinkFee)}đ • Khác ${this.fmt(c.otherFee)}đ`,
        billSessionId: session.id
      });
    }

    // Đồng bộ số tiền các khoản đã thu theo mức phí hiện tại; bỏ khoản thu của người không còn phải trả
    c.people.forEach(p => {
      const txId = this.incomeTxId(session.id, p.key);
      if (!bill.payments[p.key] || !bill.payments[p.key].paid) return;
      if (p.amount <= 0) {
        delete bill.payments[p.key];
        data.transactions = data.transactions.filter(t => t.id !== txId);
        return;
      }
      bill.payments[p.key].amount = p.amount;
      const tx = data.transactions.find(t => t.id === txId);
      if (tx) tx.amount = p.amount;
    });

    const result = await AppStorage.saveDataWithCloudAck(data);
    if (result.success) {
      App.showToast(`✅ Đã lưu chia tiền và ghi khoản chi ${this.fmt(c.totalCost)}đ vào sổ quỹ!`, "success");
    } else {
      App.showToast("⚠️ Đã lưu trên thiết bị, sẽ tự đồng bộ lên Cloud khi có kết nối.", "warning");
    }
    this.populateSessionSelect();
    const select = document.getElementById('splitter-session-select');
    if (select) select.value = session.id;
    this.calculateBill();
    if (window.App && typeof App.refreshDashboardStats === 'function') App.refreshDashboardStats();
  },

  copyBillText() {
    const textEl = document.getElementById('bill-share-text');
    if (!textEl) return;
    navigator.clipboard.writeText(textEl.innerText).then(() => {
      App.showToast("Đã sao chép nội dung chia tiền sân vào Clipboard!", "success");
    });
  }
};

window.BillSplitterModule = BillSplitterModule;
;

// ===== js/modules/settings.js =====
// Settings & Club Administration Module

const SettingsModule = {
  renderSettings() {
    if (!AppStorage.isAdmin()) {
      App.showToast("Trang Cài đặt & Quản trị chỉ dành riêng cho Ban quản trị CLB!", "warning");
      App.showAuthModal('login');
      return;
    }

    try {
      const data = AppStorage.loadData();
      const info = data.clubInfo || {};
      const bank = info.bank || {};

      // Fill general inputs
      this.setValue('set-club-name', info.name || '');
      this.setValue('set-club-short', info.shortName || '');
      this.setValue('set-club-season', info.season || 'Mùa giải 2026');
      this.setValue('set-club-slogan', info.slogan || '');
      this.setValue('set-court-default', info.defaultCourt || '');
      this.setValue('set-court-address', info.address || '');
      this.setValue('set-club-banner-subtitle', info.bannerSubtitle || '');
      this.setValue('set-court-map-url', info.mapUrl || '');
      this.setValue('set-monthly-fee', info.monthlyFee || info.monthlyFundFee || '');
      this.setValue('set-guest-fee', info.guestFee || '');
      this.setValue('set-lock-hours', info.voteLockHours || 48);
      const autoOpen = info.autoVoteOpen || {};
      const autoOpenToggle = document.getElementById('set-auto-vote-open');
      if (autoOpenToggle) autoOpenToggle.checked = !!autoOpen.enabled;
      this.setValue('set-auto-vote-days', autoOpen.daysBefore || 5);
      this.setValue('set-auto-vote-time', autoOpen.time || '08:00');
      this.fillMonthDayOptions();
      this.setValue('set-auto-vote-mode', autoOpen.mode || 'daysBefore');
      this.setValue('set-auto-vote-weekday', autoOpen.weekday !== undefined ? autoOpen.weekday : 1);
      this.setValue('set-auto-vote-monthday', autoOpen.monthDay || 1);
      this.onAutoVoteModeChange();
      const mail = info.emailNotify || {};
      const setCheck = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
      setCheck('set-email-enabled', mail.enabled);
      setCheck('set-email-vote-open', mail.voteOpen !== false);
      setCheck('set-email-booked', mail.booked !== false);
      setCheck('set-email-court-full', mail.courtFull !== false);
      setCheck('set-email-due', !!mail.dueReminder);
      this.setValue('set-email-due-day', mail.dueReminderDay || 10);
      this.setValue('set-email-court-per', mail.courtFullPerCourt || 6);
      setCheck('set-email-cancelled', mail.cancelled !== false);
      setCheck('set-email-fixed-request', mail.fixedRequest !== false);
      setCheck('set-email-fixed-result', mail.fixedResult !== false);
      setCheck('set-email-reminder', !!mail.reminder);
      this.setValue('set-email-reminder-hours', mail.reminderHours || 4);
      this.setValue('set-email-vote-audience', mail.voteOpenAudience || 'all');
      this.refreshEmailStatus(false);
      const pushCfg = info.pushConfig || {};
      setCheck('set-push-enabled', (info.pushNotify || {}).enabled);
      this.setValue('set-push-apikey', pushCfg.apiKey || '');
      this.setValue('set-push-projectid', pushCfg.projectId || '');
      this.setValue('set-push-senderid', pushCfg.messagingSenderId || '');
      this.setValue('set-push-appid', pushCfg.appId || '');
      this.setValue('set-push-vapid', pushCfg.vapidKey || '');
      this.refreshPushStatus();
      this.renderDeviceBackups();
      if (window.RolesModule) RolesModule.renderPanel();

      const autoApproveToggle = document.getElementById('set-auto-approve');
      if (autoApproveToggle) {
        autoApproveToggle.checked = info.autoApprove === true;
      }

      // Fill Bank info
      this.setValue('set-bank-id', bank.bankId || 'MB');
      this.setValue('set-bank-account-no', bank.accountNo || '');
      this.setValue('set-bank-account-name', bank.accountName || '');

      // Render Members Admin List
      this.renderMembersAdmin();
    } catch (err) {
      console.error("Lỗi khi render trang Cài đặt:", err);
    }
  },

  // Tách giá trị từ đoạn firebaseConfig dán vào (apiKey, projectId, messagingSenderId, appId) để điền các ô
  parseFirebaseConfig(text) {
    const pick = (k) => { const m = new RegExp(k + '\\s*[:=]\\s*["\']([^"\']+)["\']').exec(text || ''); return m ? m[1].trim() : ''; };
    const map = { 'set-push-apikey': 'apiKey', 'set-push-projectid': 'projectId', 'set-push-senderid': 'messagingSenderId', 'set-push-appid': 'appId' };
    Object.keys(map).forEach((id) => { const v = pick(map[id]); if (v) this.setValue(id, v); });
  },

  // Trạng thái thông báo đẩy: đã cấu hình khóa trên máy chủ chưa, bao nhiêu người/thiết bị đã đăng ký
  async refreshPushStatus() {
    const line = document.getElementById('push-status-line');
    if (!line || !AppStorage.isAdmin() || AppStorage.isLocalOnly()) return;
    line.textContent = 'Đang kiểm tra…';
    const session = AppStorage._readSession();
    const res = await AppStorage._authRequest({ action: 'pushStatus', token: session && session.token });
    if (res.status !== 'ok') { line.textContent = `⚠️ ${res.message || 'Không kiểm tra được.'}`; return; }
    const keyOk = res.configured
      ? '✅ Máy chủ đã có khóa Firebase.'
      : '⚠️ Máy chủ CHƯA có khóa Firebase (Script Properties → FCM_SERVICE_ACCOUNT) nên chưa gửi được.';
    line.textContent = `${keyOk} Đã đăng ký: ${res.subscribers || 0} người / ${res.devices || 0} thiết bị.${res.enabled ? '' : ' (CLB đang tắt thông báo đẩy)'}`;
  },

  // Trạng thái trình gửi email trên Apps Script; enable=true thì bật nếu chưa bật
  async refreshEmailStatus(enable) {
    const line = document.getElementById('email-status-line');
    const enabled = !!document.getElementById('set-email-enabled')?.checked;
    if (!line) return;
    if (!enabled && !enable) {
      line.textContent = 'Đang tắt gửi email.';
      return;
    }
    line.textContent = 'Đang kiểm tra trình gửi email...';
    const res = await AppStorage.emailAction('emailSetup', { enable: !!enable });
    if (res.status === 'ok') {
      line.textContent = res.installed
        ? `✅ Trình gửi thông báo đang hoạt động (kiểm tra 5 phút/lần). Hạn mức email còn lại hôm nay: ${res.quota}.`
        : '⚠️ Trình gửi email chưa bật. Bấm "Lưu cài đặt" để bật.';
    } else {
      line.textContent = `⚠️ ${res.message || 'Không kiểm tra được trình gửi email.'}`;
    }
  },

  BACKUP_REASONS: {
    'dinh-ky': 'Tự động hằng giờ',
    'truoc-khi-tai-toan-bo': 'Trước khi tải lại làm mất dữ liệu',
    'truoc-khi-thay-toan-bo': 'Trước khi đặt lại / nhập dữ liệu',
    'may-chu-bat-thuong': 'Khi máy chủ trả dữ liệu bất thường',
    'du-lieu-ban-cu-luc-nang-cap': 'Dữ liệu bản cũ lúc nâng cấp',
    'ban-sao-cu': 'Bản sao kiểu cũ (v1)'
  },
  BACKUP_SHOWN: 3,

  // Bản sao lưu trên thiết bị: xem, tải về, gửi lên máy chủ (hợp nhất, không xóa dữ liệu mới), xóa
  renderDeviceBackups() {
    const box = document.getElementById('device-backups-panel');
    if (!box) return;
    if (!AppStorage.isAdmin()) { box.innerHTML = ''; return; }
    const warn = AppStorage.getServerWarning();
    const list = AppStorage.listLocalBackups();
    const now = AppStorage.currentBackupCounts();
    const fmt = (ms) => ms ? new Date(ms).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' }) : 'Không rõ thời gian';
    const LABELS = [['users', 'tài khoản'], ['members', 'thành viên'], ['sessions', 'buổi'], ['transactions', 'giao dịch'], ['dues', 'phiếu quỹ']];
    const row = (b) => {
      const more = LABELS.filter(([k]) => (b.counts[k] || 0) > (now[k] || 0)).map(([k, l]) => `+${b.counts[k] - (now[k] || 0)} ${l}`);
      const counts = LABELS.filter(([k]) => b.counts[k]).map(([k, l]) => `${b.counts[k]} ${l}`).join(' • ') || 'Không có dữ liệu';
      return `
          <div class="backup-row" style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem 1rem; padding: 0.6rem 0; border-top: 1px solid var(--border-color); flex-wrap: wrap;">
            <div style="font-size: 0.82rem; min-width: 0; flex: 1 1 260px;">
              <div><b>${Safe.html(fmt(b.at))}</b> <span class="text-secondary">• ${Safe.html(this.BACKUP_REASONS[b.reason] || b.reason)}</span></div>
              <div class="text-secondary" style="overflow-wrap: anywhere;">${Safe.html(counts)}</div>
              ${more.length ? `<div style="color: var(--warning, #f59e0b); font-size: 0.78rem;"><i class="fas fa-exclamation-triangle"></i> Nhiều hơn dữ liệu hiện tại: ${Safe.html(more.join(', '))}</div>` : ''}
            </div>
            <div style="display: flex; gap: 0.4rem; flex-shrink: 0;">
              <button type="button" class="btn btn-secondary btn-sm" title="Tải tệp JSON về máy" onclick="AppStorage.downloadLocalBackup(${Safe.js(b.id)})"><i class="fas fa-download"></i> Tải về</button>
              <button type="button" class="btn btn-outline-primary btn-sm" title="Gửi lên máy chủ để hợp nhất (không xóa dữ liệu mới)" onclick="SettingsModule.restoreDeviceBackup(${Safe.js(b.id)})"><i class="fas fa-cloud-upload-alt"></i> Khôi phục</button>
              <button type="button" class="btn btn-secondary btn-sm" title="Xóa bản sao này khỏi thiết bị" onclick="SettingsModule.deleteDeviceBackup(${Safe.js(b.id)})"><i class="fas fa-trash-alt"></i></button>
            </div>
          </div>`;
    };
    const shown = list.slice(0, this.BACKUP_SHOWN), rest = list.slice(this.BACKUP_SHOWN);
    box.innerHTML = `
      <div class="card" style="padding: 1rem 1.25rem; margin-bottom: 1rem;">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.35rem;">
          <div class="font-bold"><i class="fas fa-shield-alt text-primary"></i> Bản sao lưu trên thiết bị này</div>
          <span class="badge badge-neutral" style="font-size: 0.72rem;">${list.length} bản</span>
        </div>
        ${warn ? `<div class="badge badge-warning" style="display: block; white-space: normal; margin-bottom: 0.6rem; padding: 0.5rem;">⚠️ ${Safe.html(warn.message)}</div>` : ''}
        <div class="text-secondary" style="font-size: 0.78rem; margin-bottom: 0.25rem;">
          Tự lưu khi dữ liệu thay đổi (tối đa 1 lần/giờ, giữ ${AppStorage.BACKUP_KEEP} bản khác nhau) và trước thao tác có thể làm mất dữ liệu.
          Chỉ thiết bị của Ban quản trị mới sao lưu. Máy chủ có bản sao riêng (mỗi ngày & mỗi lần cập nhật).
        </div>
        ${list.length ? shown.map(row).join('') + (rest.length ? `
        <details style="border-top: 1px solid var(--border-color); padding-top: 0.5rem;">
          <summary class="text-secondary" style="cursor: pointer; font-size: 0.82rem;">Xem ${rest.length} bản cũ hơn</summary>
          ${rest.map(row).join('')}
        </details>` : '') : '<div class="text-secondary" style="font-size: 0.82rem; padding-top: 0.5rem; border-top: 1px solid var(--border-color);">Chưa có bản sao nào trên thiết bị này.</div>'}
      </div>`;
  },

  async deleteDeviceBackup(id) {
    if (!(await App.confirm('Xóa bản sao này khỏi thiết bị? Không ảnh hưởng dữ liệu trên máy chủ.'))) return;
    if (await AppStorage.deleteLocalBackup(id)) App.showToast('🗑️ Đã xóa bản sao', 'success');
    this.renderDeviceBackups();
  },

  async restoreDeviceBackup(id) {
    if (!(await App.confirm('Gửi bản sao này lên máy chủ?\n\nMáy chủ sẽ HỢP NHẤT: chỉ lấy lại dữ liệu bị thiếu hoặc cũ hơn, không xóa dữ liệu mới, không đổi mật khẩu/vai trò.'))) return;
    const res = await AppStorage.restoreLocalBackupToServer(id);
    App.showToast(res.message, res.success ? 'success' : 'warning');
    this.renderDeviceBackups();
  },

  async sendTestEmail() {
    const res = await AppStorage.emailAction('emailTest', {});
    App.showToast(res.message || (res.status === 'ok' ? 'Đã gửi email thử.' : 'Không gửi được email thử.'), res.status === 'ok' ? 'success' : 'warning');
  },

  fillMonthDayOptions() {
    const sel = document.getElementById('set-auto-vote-monthday');
    if (!sel || sel.options.length) return;
    for (let d = 1; d <= 31; d++) {
      const opt = document.createElement('option');
      opt.value = String(d);
      opt.textContent = d >= 29 ? `Ngày ${d} (tháng thiếu ngày -> ngày cuối tháng)` : `Ngày ${d}`;
      sel.appendChild(opt);
    }
  },

  // Hiện ô phù hợp với kiểu lịch mở bình chọn đã chọn
  onAutoVoteModeChange() {
    const mode = document.getElementById('set-auto-vote-mode')?.value || 'daysBefore';
    const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
    show('set-auto-vote-days-box', mode === 'daysBefore');
    show('set-auto-vote-weekday-box', mode === 'weekday');
    show('set-auto-vote-monthday-box', mode === 'monthday');
    const desc = document.getElementById('set-auto-vote-desc');
    if (desc && window.VoteScheduler) {
      const cfg = {
        enabled: true, mode,
        daysBefore: parseInt(document.getElementById('set-auto-vote-days')?.value) || 5,
        weekday: parseInt(document.getElementById('set-auto-vote-weekday')?.value) || 0,
        monthDay: parseInt(document.getElementById('set-auto-vote-monthday')?.value) || 1,
        time: document.getElementById('set-auto-vote-time')?.value || '08:00'
      };
      desc.textContent = 'Quy tắc: ' + VoteScheduler.describeRule({ autoVoteOpen: cfg }) + '. Áp dụng làm giờ mở mặc định khi tạo buổi đánh mới.';
    }
  },

  setValue(id, val) {
    const el = document.getElementById(id);
    if (el && val !== undefined) el.value = val;
  },

  saveClubSettings(e) {
    e.preventDefault();
    if (!AppStorage.isAdmin()) {
      App.showToast("Chỉ Ban quản trị mới có quyền lưu cấu hình CLB!", "warning");
      App.showAuthModal('login');
      return;
    }
    const data = AppStorage.loadData();

    data.clubInfo.name = document.getElementById('set-club-name').value.trim();
    data.clubInfo.shortName = document.getElementById('set-club-short').value.trim();
    data.clubInfo.season = document.getElementById('set-club-season')?.value.trim() || 'Mùa giải 2026';
    data.clubInfo.slogan = document.getElementById('set-club-slogan').value.trim();
    data.clubInfo.defaultCourt = document.getElementById('set-court-default').value.trim();
    data.clubInfo.address = document.getElementById('set-court-address').value.trim();
    data.clubInfo.bannerSubtitle = document.getElementById('set-club-banner-subtitle')?.value.trim() || '';
    const mapUrlInput = document.getElementById('set-court-map-url')?.value.trim();
    data.clubInfo.mapUrl = mapUrlInput || (data.clubInfo.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(data.clubInfo.address)}` : '');
    data.clubInfo.monthlyFee = parseInt(document.getElementById('set-monthly-fee').value) || 0;
    data.clubInfo.monthlyFundFee = data.clubInfo.monthlyFee;
    data.clubInfo.guestFee = parseInt(document.getElementById('set-guest-fee').value) || 0;
    data.clubInfo.voteLockHours = parseInt(document.getElementById('set-lock-hours').value) || 48;
    if (document.getElementById('set-auto-vote-open')) {
      data.clubInfo.autoVoteOpen = {
        enabled: document.getElementById('set-auto-vote-open').checked,
        mode: ['daysBefore', 'weekday', 'monthday'].includes(document.getElementById('set-auto-vote-mode')?.value) ? document.getElementById('set-auto-vote-mode').value : 'daysBefore',
        daysBefore: parseInt(document.getElementById('set-auto-vote-days')?.value) || 5,
        weekday: Math.min(6, Math.max(0, parseInt(document.getElementById('set-auto-vote-weekday')?.value) || 0)),
        monthDay: Math.min(31, Math.max(1, parseInt(document.getElementById('set-auto-vote-monthday')?.value) || 1)),
        time: document.getElementById('set-auto-vote-time')?.value || '08:00'
      };
    }
    data.clubInfo.autoApprove = document.getElementById('set-auto-approve').checked;
    if (document.getElementById('set-email-enabled')) {
      const checked = (id) => !!document.getElementById(id)?.checked;
      data.clubInfo.emailNotify = {
        enabled: checked('set-email-enabled'),
        voteOpen: checked('set-email-vote-open'),
        booked: checked('set-email-booked'),
        courtFull: checked('set-email-court-full'),
        dueReminder: checked('set-email-due'),
        dueReminderDay: parseInt(document.getElementById('set-email-due-day')?.value) || 10,
        courtFullPerCourt: parseInt(document.getElementById('set-email-court-per')?.value) || 6,
        cancelled: checked('set-email-cancelled'),
        fixedRequest: checked('set-email-fixed-request'),
        fixedResult: checked('set-email-fixed-result'),
        reminder: checked('set-email-reminder'),
        reminderHours: parseInt(document.getElementById('set-email-reminder-hours')?.value) || 4,
        voteOpenAudience: document.getElementById('set-email-vote-audience')?.value === 'fixed' ? 'fixed' : 'all'
      };
    }

    if (document.getElementById('set-push-enabled')) {
      const pv = (id) => (document.getElementById(id)?.value || '').trim();
      const safe = (s) => (/^[A-Za-z0-9_:.\-]*$/.test(s) ? s : '');
      const cfg = { apiKey: safe(pv('set-push-apikey')), projectId: safe(pv('set-push-projectid')), messagingSenderId: safe(pv('set-push-senderid')), appId: safe(pv('set-push-appid')), vapidKey: safe(pv('set-push-vapid')) };
      const complete = Object.values(cfg).every(Boolean);
      const want = !!document.getElementById('set-push-enabled').checked;
      if (want && !complete) App.showToast('Thông báo đẩy cần đủ 5 thông tin cấu hình Firebase (chỉ gồm chữ, số, - _ : .). Đã lưu nhưng chưa bật.', 'warning');
      data.clubInfo.pushConfig = cfg;
      data.clubInfo.pushNotify = { enabled: want && complete };
    }

    data.clubInfo.bank.bankId = document.getElementById('set-bank-id').value;
    data.clubInfo.bank.accountNo = document.getElementById('set-bank-account-no').value.trim();
    data.clubInfo.bank.accountName = document.getElementById('set-bank-account-name').value.trim().toUpperCase();

    // Also update bank name display text
    const bankSelect = document.getElementById('set-bank-id');
    const selectedOption = bankSelect.options[bankSelect.selectedIndex];
    data.clubInfo.bank.bankName = selectedOption ? selectedOption.text : 'Ngân hàng';

    AppStorage.saveData(data);
    if (data.clubInfo.emailNotify && data.clubInfo.emailNotify.enabled) this.refreshEmailStatus(true);
    App.showToast("Đã lưu các cài đặt CLB & quy tắc đóng vote thành công!", "success");
    App.refreshDashboardStats();
  },

  renderMembersAdmin() {
    const data = AppStorage.loadData();
    const members = data.members || [];
    const container = document.getElementById('members-admin-list');
    if (!container) return;

    if (members.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 2.25rem 1rem; color: var(--text-muted); background: var(--bg-input); border-radius: var(--radius-md); border: 1px dashed var(--border-color);">
          <div style="width: 52px; height: 52px; border-radius: 50%; background: rgba(16, 185, 129, 0.1); color: var(--primary); display: inline-flex; align-items: center; justify-content: center; font-size: 1.5rem; margin-bottom: 0.75rem;">
            <i class="fas fa-user-plus"></i>
          </div>
          <div style="font-weight: 700; color: var(--text-main); font-size: 1rem; margin-bottom: 0.35rem;">Chưa có thành viên nào trong danh sách</div>
          <p style="font-size: 0.85rem; margin-bottom: 1rem; max-width: 380px; margin-left: auto; margin-right: auto;">
            CLB đang sẵn sàng nhận đăng ký. Bạn có thể bấm <strong>"+ Thêm mới"</strong> hoặc quản lý toàn diện trong tab <strong>"Thành viên CLB"</strong>.
          </p>
          <div class="flex gap-2 justify-center flex-wrap">
            <button class="btn btn-primary btn-sm" onclick="MembersModule.openAddMemberModal()">
              <i class="fas fa-user-plus"></i> Thêm thành viên
            </button>
            <button class="btn btn-secondary btn-sm" onclick="App.openTab('members')">
              <i class="fas fa-users"></i> Xem trang Quản lý thành viên
            </button>
          </div>
        </div>
      `;
      return;
    }

    container.innerHTML = members.map((m) => `
      <div class="card" style="padding: 0.75rem 1rem; margin-bottom: 0.5rem; display: flex; align-items: center; justify-content: space-between; background: var(--bg-input);">
        <div class="flex items-center gap-3">
          <img class="avatar avatar-sm" src="${Safe.url(m.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(m.name)}&background=10b981&color=fff`)}" alt="${Safe.html(m.name)}" style="width: 32px; height: 32px; border-radius: 50%;">
          <div>
            <div class="font-bold flex items-center gap-2" style="font-size: 0.9rem;">
              ${Safe.html(m.name)}
              <span class="badge ${m.role === 'admin' ? 'badge-warning' : m.role === 'treasurer' ? 'badge-info' : 'badge-neutral'}" style="font-size: 0.65rem;">
                ${m.role === 'admin' ? 'Admin' : m.role === 'treasurer' ? 'Thủ quỹ' : 'Thành viên'}
              </span>
              <span class="badge ${m.type === 'fixed' ? 'badge-paid' : 'badge-warning'}" style="font-size: 0.65rem;">
                ${m.type === 'fixed' ? 'Cố định' : 'Vãng lai'}
              </span>
            </div>
            <div class="text-secondary" style="font-size: 0.76rem;">
              <i class="fas fa-phone-alt"></i> ${Safe.html(m.phone)}
            </div>
          </div>
        </div>

        <div class="flex gap-2">
          <button class="btn btn-secondary btn-sm" onclick="MembersModule.openEditMemberModal(${Safe.js(m.id)})" title="Sửa thông tin">
            <i class="fas fa-edit"></i>
          </button>
          <button class="btn btn-outline-danger btn-sm" onclick="MembersModule.deleteMember(${Safe.js(m.id)})" title="Xóa thành viên">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>
    `).join('');
  },

  openAddMemberModal() {
    if (window.MembersModule) MembersModule.openAddMemberModal();
  },

  saveNewMember(e) {
    if (window.MembersModule) MembersModule.saveNewMember(e);
  },

  openEditMemberModal(memberId) {
    if (window.MembersModule) MembersModule.openEditMemberModal(memberId);
  },

  saveEditMember(e, memberId) {
    if (window.MembersModule) MembersModule.saveEditMember(e, memberId);
  },

  deleteMember(memberId) {
    if (window.MembersModule) MembersModule.deleteMember(memberId);
  },


  renderPublicMemberRoster() {
    if (window.MembersModule) MembersModule.renderPublicMemberRoster();
  },

  // Toggle giữa CSDL Vận hành thực tế và CSDL Dữ liệu thử nghiệm (Chỉ Admin)
  async switchDatabaseEnvironment(mode) {
    const isTest = mode === 'test';
    const confirmMsg = isTest 
      ? "Chuyển sang chế độ CSDL KIỂM THỬ (TEST DEMO) với dữ liệu mẫu 10 thành viên và các buổi đánh thử nghiệm?" 
      : "Chuyển sang chế độ CSDL VẬN HÀNH THỰC TẾ (PRODUCTION)?";

    if (!(await App.confirm(confirmMsg))) return;

    const updated = AppStorage.switchDatabaseMode(mode);
    App.showToast(`Đã chuyển sang môi trường: ${isTest ? 'CSDL Kiểm thử (Test Demo)' : 'CSDL Vận hành thực tế (Production)'}`, "success");
    App.renderUserHeaderAndSidebar();
    App.refreshDashboardStats();
    App.openTab('dashboard');
  },

  // Modal chỉnh sửa nhanh thông tin Banner trang chủ (Dành cho Admin)
  openEditHeroBannerModal() {
    if (!AppStorage.isAdmin()) {
      App.showToast("Chỉ Quản trị viên mới có quyền chỉnh sửa thông tin Banner!", "warning");
      App.showAuthModal('login');
      return;
    }

    const data = AppStorage.loadData();
    const info = data.clubInfo || {};
    const lockHours = info.voteLockHours || 48;
    const lockDays = Math.round(lockHours / 24);
    const lockText = lockDays > 0 ? `Tự động đóng vote trước giờ đánh ${lockDays} ngày` : `Tự động đóng vote trước giờ đánh ${lockHours} giờ`;
    const defaultSub = `${info.defaultCourt ? info.defaultCourt + ' • ' : ''}${lockText}`;

    const html = `
      <form onsubmit="SettingsModule.saveHeroBannerFromModal(event)">
        <div style="margin-bottom: 1rem; color: var(--text-muted); font-size: 0.88rem;">
          Tùy chỉnh tiêu đề, mùa giải và dòng thông tin hiển thị trên <strong>Banner trang chủ (Dashboard)</strong>:
        </div>

        <div class="form-group">
          <label class="form-label font-bold"><i class="fas fa-heading text-primary"></i> Tên Câu Lạc Bộ (Tiêu đề Banner) *</label>
          <input type="text" id="modal-banner-name" class="form-control" value="${Safe.html(info.name || 'SMASH PRO Badminton Club')}" required placeholder="VD: SMASH PRO BADMINTON CLUB">
        </div>

        <div class="responsive-form-row">
          <div class="form-group">
            <label class="form-label font-bold"><i class="fas fa-fire text-warning"></i> Mùa giải / Huy hiệu</label>
            <input type="text" id="modal-banner-season" class="form-control" value="${Safe.html(info.season || 'Mùa giải 2026')}" placeholder="VD: Mùa giải 2026">
          </div>
          <div class="form-group">
            <div class="flex items-center justify-between" style="margin-bottom: 0.35rem;">
              <label class="form-label font-bold" style="margin-bottom: 0;"><i class="fas fa-home text-primary"></i> Sân nhà mặc định</label>
              <button type="button" class="btn btn-ghost btn-icon btn-xs" onclick="ScheduleModule.openEditCourtLocationModal('club')" title="Admin: Sửa vị trí & bản đồ sân nhà" style="border: 1px solid var(--border-color); border-radius: var(--radius-sm);">
                <i class="fas fa-pencil-alt text-warning"></i>
              </button>
            </div>
            <input type="text" id="modal-banner-court" class="form-control" value="${Safe.html(info.defaultCourt || '')}" placeholder="VD: Sân cầu lông CLB (Sân 1 & 2)">
          </div>
        </div>

        <div class="form-group">
          <label class="form-label font-bold"><i class="fas fa-location-arrow text-primary"></i> Địa chỉ sân nhà CLB</label>
          <input type="text" id="modal-banner-address" class="form-control" value="${Safe.html(info.address || '')}" placeholder="VD: Số 123 Đường ABC, Quận XYZ, TP. Hồ Chí Minh">
        </div>

        <div class="form-group">
          <div class="flex items-center justify-between" style="margin-bottom: 0.35rem;">
            <label class="form-label font-bold" style="margin-bottom: 0;"><i class="fas fa-map-marker-alt text-primary"></i> Dòng thông tin phụ / Ghi chú Banner</label>
            <button type="button" class="btn btn-outline-primary btn-sm" onclick="document.getElementById('modal-banner-sub').value=${Safe.js(defaultSub)}" style="padding: 0.15rem 0.45rem; font-size: 0.72rem;">
              <i class="fas fa-magic"></i> Tạo tự động
            </button>
          </div>
          <textarea id="modal-banner-sub" class="form-control" rows="2" placeholder="${Safe.html(defaultSub)}">${Safe.html(info.bannerSubtitle || '')}</textarea>
          <span class="text-secondary" style="font-size: 0.75rem; margin-top: 0.25rem; display: block;">
            Dòng này hiển thị trực tiếp với biểu tượng 📍 trên banner. Để trống sẽ tự động hiển thị: <em>[Sân nhà] • Tự động đóng vote trước giờ đánh [X] ngày</em>.
          </span>
        </div>

        <div class="flex gap-2 justify-end" style="margin-top: 1.5rem; border-top: 1px solid var(--border-color); padding-top: 1rem;">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Hủy bỏ</button>
          <button type="submit" class="btn btn-primary">
            <i class="fas fa-save"></i> Lưu thông tin banner
          </button>
        </div>
      </form>
    `;

    App.openModal('<i class="fas fa-edit text-primary"></i> Chỉnh sửa thông tin Banner Trang chủ', html);
  },

  saveHeroBannerFromModal(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (!AppStorage.isAdmin()) {
      App.showToast("Chỉ Quản trị viên mới có quyền chỉnh sửa thông tin Banner!", "warning");
      return;
    }

    const data = AppStorage.loadData();
    if (!data.clubInfo) data.clubInfo = {};

    const name = document.getElementById('modal-banner-name')?.value.trim();
    const season = document.getElementById('modal-banner-season')?.value.trim() || 'Mùa giải 2026';
    const court = document.getElementById('modal-banner-court')?.value.trim();
    const address = document.getElementById('modal-banner-address')?.value.trim();
    const bannerSub = document.getElementById('modal-banner-sub')?.value.trim();

    if (name) data.clubInfo.name = name;
    data.clubInfo.season = season;
    if (court) data.clubInfo.defaultCourt = court;
    if (address) {
      data.clubInfo.address = address;
      if (!data.clubInfo.mapUrl) {
        data.clubInfo.mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
      }
    }
    data.clubInfo.bannerSubtitle = bannerSub;

    AppStorage.saveData(data, true);
    App.closeModal();
    App.refreshDashboardStats();
    App.showToast("🎉 Đã cập nhật và lưu thông tin Banner trang chủ thành công!", "success");
  },

  async confirmResetDatabase() {
    if (!AppStorage.isAdmin()) {
      App.showToast("Chỉ Ban quản trị mới có quyền Reset CSDL!", "warning");
      App.showAuthModal('login');
      return;
    }
    if (!(await App.confirm("⚠️ BẠN CÓ CHẮC CHẮN MUỐN ĐẶT LẠI CSDL SẠCH MẶC ĐỊNH?\n\nToàn bộ danh sách thành viên, ca đánh, quỹ tháng và sổ thu chi sẽ được đưa về 0 và đồng bộ làm sạch ngay trên database."))) {
      return;
    }
    await AppStorage.resetData(true);
    App.refreshDashboardStats();
    App.renderUserHeaderAndSidebar();
    App.openTab('dashboard');
  },

  // ==========================================
  // BẢO MẬT & ĐỔI MẬT KHẨU QUẢN TRỊ VIÊN
  // ==========================================
  async handleChangeAdminPassword(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (!AppStorage.isAdmin()) {
      App.showToast("Yêu cầu quyền Quản trị viên để đổi mật khẩu!", "warning");
      return;
    }

    const currentUser = AppStorage.getCurrentUser();
    if (!currentUser) {
      App.showToast("Vui lòng đăng nhập tài khoản Quản trị viên!", "warning");
      return;
    }

    const oldPwd = document.getElementById('set-admin-old-pwd')?.value || '';
    const newPwd = document.getElementById('set-admin-new-pwd')?.value || '';
    const confirmPwd = document.getElementById('set-admin-confirm-pwd')?.value || '';

    const result = await AppStorage.changePassword(currentUser.id, oldPwd, newPwd, confirmPwd);
    if (result.success) {
      const form = document.getElementById('form-change-admin-password');
      if (form) form.reset();
      App.showToast(`🎉 ${result.message}`, "success");
    } else {
      App.showToast(`⚠️ ${result.message}`, "error");
    }
  },

  openChangeAdminPasswordModal() {
    if (!AppStorage.isAdmin()) {
      App.showToast("Chỉ Quản trị viên mới có quyền đổi mật khẩu!", "warning");
      return;
    }

    const modalBody = `
      <form id="modal-form-change-admin-pwd" onsubmit="SettingsModule.handleModalChangeAdminPassword(event)">
        <div style="text-align: center; margin-bottom: 1.25rem;">
          <div style="width: 52px; height: 52px; border-radius: 50%; background: rgba(16, 185, 129, 0.12); color: var(--primary); display: inline-flex; align-items: center; justify-content: center; font-size: 1.5rem; margin-bottom: 0.5rem;">
            <i class="fas fa-key"></i>
          </div>
          <h3 style="font-size: 1.15rem; color: var(--text-main); margin-bottom: 0.25rem;">Đổi mật khẩu Quản trị viên</h3>
          <p class="text-secondary" style="font-size: 0.82rem;">Thiết lập mật khẩu bảo mật mới cho tài khoản Admin</p>
        </div>

        <div class="form-group">
          <label class="form-label font-bold">Mật khẩu hiện tại *</label>
          <input type="password" id="modal-admin-old-pwd" class="form-control" required placeholder="Nhập mật khẩu hiện tại...">
        </div>

        <div class="form-group">
          <label class="form-label font-bold">Mật khẩu mới *</label>
          <input type="password" id="modal-admin-new-pwd" class="form-control" required placeholder="Tối thiểu 8 ký tự, không dấu cách...">
        </div>

        <div class="form-group">
          <label class="form-label font-bold">Nhập lại mật khẩu mới *</label>
          <input type="password" id="modal-admin-confirm-pwd" class="form-control" required placeholder="Xác nhận lại mật khẩu mới...">
        </div>

        <div class="modal-footer" style="padding: 1rem 0 0 0; display: flex; justify-content: flex-end; gap: 0.5rem;">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Hủy</button>
          <button type="submit" class="btn btn-primary"><i class="fas fa-check-circle"></i> Cập nhật mật khẩu</button>
        </div>
      </form>
    `;

    App.openModal("🔐 Đổi mật khẩu Quản trị viên", modalBody);
    setTimeout(() => document.getElementById('modal-admin-old-pwd')?.focus(), 200);
  },

  async handleModalChangeAdminPassword(e) {
    if (e && e.preventDefault) e.preventDefault();
    const currentUser = AppStorage.getCurrentUser();
    if (!currentUser) return;

    const oldPwd = document.getElementById('modal-admin-old-pwd')?.value || '';
    const newPwd = document.getElementById('modal-admin-new-pwd')?.value || '';
    const confirmPwd = document.getElementById('modal-admin-confirm-pwd')?.value || '';

    const result = await AppStorage.changePassword(currentUser.id, oldPwd, newPwd, confirmPwd);
    if (result.success) {
      App.closeModal();
      App.showToast(`🎉 ${result.message}`, "success");
    } else {
      App.showToast(`⚠️ ${result.message}`, "error");
    }
  }
};

window.SettingsModule = SettingsModule;
;

// ===== js/modules/push-client.js =====
// PushClient - Đăng ký thiết bị nhận thông báo đẩy (Web Push qua Firebase Cloud Messaging).
// Luồng: thành viên bật -> trình duyệt cấp quyền + mã thiết bị (FCM token) -> máy chủ lưu mã vào hồ sơ (bí mật, không trả lại).
// Khi có sự kiện (mở vote, đặt/hủy sân, nhắc giờ...) máy chủ gửi tới mã đó; Service Worker (sw.js) hiện thông báo kể cả khi đã đóng ứng dụng.
// Cấu hình web Firebase do Ban quản trị điền ở Cài đặt CLB (clubInfo.pushConfig); khóa gửi nằm trên máy chủ (không bao giờ ở đây).
const PushClient = {
  FIREBASE_VERSION: '10.12.2',
  LS_KEY: 'SMASH_PRO_PUSH_V1', // { token, user } của thiết bị này
  _loading: null,
  _messaging: null,
  _debounce: null,
  busy: false,

  // ---------------- Trạng thái ----------------
  config() {
    const c = (AppStorage.loadData().clubInfo || {}).pushConfig;
    return c && c.apiKey && c.projectId && c.messagingSenderId && c.appId && c.vapidKey ? c : null;
  },

  clubEnabled() {
    const p = (AppStorage.loadData().clubInfo || {}).pushNotify;
    return !!(p && p.enabled);
  },

  isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  },

  isStandalone() {
    return !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  },

  permission() {
    return 'Notification' in window ? Notification.permission : 'unsupported';
  },

  // Thiết bị/trình duyệt này có dùng được thông báo đẩy không (kèm lý do nếu không)
  support() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      return { ok: false, reason: this.isIOS() && !this.isStandalone()
        ? 'Trên iPhone/iPad, hãy thêm ứng dụng vào Màn hình chính (nút Chia sẻ → Thêm vào MH chính) rồi mở từ biểu tượng đó.'
        : 'Trình duyệt này không hỗ trợ thông báo đẩy.' };
    }
    if (this.isIOS() && !this.isStandalone()) {
      return { ok: false, reason: 'Trên iPhone/iPad, hãy thêm ứng dụng vào Màn hình chính (nút Chia sẻ → Thêm vào MH chính) rồi mở từ biểu tượng đó.' };
    }
    return { ok: true, reason: '' };
  },

  stored() {
    try { return JSON.parse(localStorage.getItem(this.LS_KEY) || 'null'); } catch (e) { return null; }
  },

  setStored(v) {
    try { if (v) localStorage.setItem(this.LS_KEY, JSON.stringify(v)); else localStorage.removeItem(this.LS_KEY); } catch (e) {}
  },

  // Thiết bị này đang nhận đẩy cho tài khoản hiện tại?
  isOn() {
    const u = AppStorage.getCurrentUser();
    const s = this.stored();
    return !!(u && s && s.token && s.user === u.username && this.permission() === 'granted');
  },

  // ---------------- Firebase ----------------
  FIREBASE_SRI: {
    '10.12.2': {
      'firebase-app-compat.js': 'sha384-AQ3POAMqIhwS81FrUH95ekxqBZHeP5tG2JfEL3+7GuTtfRLWnrRh32UxwzM+//A9',
      'firebase-messaging-compat.js': 'sha384-XtSlZdmg0Ad5zf0AX4W9TGdm+dGjaNK4KG3lNFjfgbnxkCEuT9ugWXkLExgQTJ+6'
    }
  },

  _script(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      const sri = (this.FIREBASE_SRI[this.FIREBASE_VERSION] || {})[src.split('/').pop()];
      if (sri) { el.integrity = sri; el.crossOrigin = 'anonymous'; }
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error('Không tải được thư viện thông báo (kiểm tra kết nối mạng)'));
      document.head.appendChild(el);
    });
  },

  async loadFirebase() {
    if (window.firebase && window.firebase.messaging) return;
    if (!this._loading) {
      const base = `https://www.gstatic.com/firebasejs/${this.FIREBASE_VERSION}`;
      this._loading = this._script(`${base}/firebase-app-compat.js`)
        .then(() => this._script(`${base}/firebase-messaging-compat.js`))
        .catch((e) => { this._loading = null; throw e; });
    }
    await this._loading;
  },

  async _getToken() {
    const cfg = this.config();
    if (!cfg) throw new Error('Ban quản trị chưa cấu hình thông báo đẩy.');
    await this.loadFirebase();
    if (!(await navigator.serviceWorker.getRegistration())) await navigator.serviceWorker.register('sw.js');
    const reg = await navigator.serviceWorker.ready;
    if (!this._messaging) {
      if (!firebase.apps.length) {
        firebase.initializeApp({ apiKey: cfg.apiKey, authDomain: cfg.authDomain || `${cfg.projectId}.firebaseapp.com`, projectId: cfg.projectId, messagingSenderId: cfg.messagingSenderId, appId: cfg.appId });
      }
      this._messaging = firebase.messaging();
    }
    const token = await this._messaging.getToken({ vapidKey: cfg.vapidKey, serviceWorkerRegistration: reg });
    if (!token) throw new Error('Không lấy được mã thiết bị.');
    return token;
  },

  // ---------------- Bật / tắt ----------------
  async enable() {
    if (this.busy) return { success: false, message: 'Đang xử lý…' };
    const user = AppStorage.getCurrentUser();
    if (!user) return { success: false, message: 'Hãy đăng nhập trước khi bật thông báo đẩy.' };
    if (AppStorage.isLocalOnly()) return { success: false, message: 'Chế độ chạy cục bộ không hỗ trợ thông báo đẩy.' };
    const sup = this.support();
    if (!sup.ok) return { success: false, message: sup.reason };
    if (!this.config()) return { success: false, message: 'Ban quản trị chưa cấu hình thông báo đẩy cho CLB.' };
    this.busy = true;
    try {
      let perm = this.permission();
      if (perm === 'default') perm = await Notification.requestPermission();
      if (perm !== 'granted') return { success: false, message: perm === 'denied' ? 'Bạn đã chặn thông báo. Vào cài đặt trình duyệt/trang web để cấp lại quyền.' : 'Chưa được cấp quyền thông báo.' };
      const deviceToken = await this._getToken();
      const session = AppStorage._readSession();
      const res = await AppStorage._authRequest({ action: 'pushRegister', token: session && session.token, deviceToken, ua: this._uaLabel() });
      if (res.status !== 'ok') return { success: false, message: res.message || 'Máy chủ không đăng ký được thiết bị.' };
      this.setStored({ token: deviceToken, user: user.username });
      try { localStorage.setItem('SMASH_PRO_NOTIF_ENABLED', '1'); } catch (e) {}
      return { success: true, message: res.configured ? 'Đã bật thông báo đẩy trên thiết bị này.' : 'Đã đăng ký thiết bị, nhưng máy chủ chưa có khóa gửi Firebase nên chưa nhận được thông báo.' };
    } catch (e) {
      console.warn('[PushClient] Lỗi bật thông báo đẩy:', e);
      return { success: false, message: e.message || 'Không bật được thông báo đẩy.' };
    } finally {
      this.busy = false;
    }
  },

  async disable() {
    const s = this.stored();
    const session = AppStorage._readSession();
    this.setStored(null);
    if (s && s.token && session && session.token) {
      try { await AppStorage._authRequest({ action: 'pushUnregister', token: session.token, deviceToken: s.token }); } catch (e) {}
    }
    try { if (this._messaging) await this._messaging.deleteToken(); } catch (e) {}
    return { success: true, message: 'Đã tắt thông báo đẩy trên thiết bị này.' };
  },

  // Gọi trước khi đăng xuất: thiết bị này không nhận thông báo của tài khoản vừa thoát nữa
  onBeforeLogout(session) {
    const s = this.stored();
    if (!s || !s.token) return;
    this.setStored(null);
    if (session && session.token && !AppStorage.isLocalOnly()) {
      AppStorage._authRequest({ action: 'pushUnregister', token: session.token, deviceToken: s.token }).catch(() => {});
    }
  },

  // Mã thiết bị có thể đổi: nếu người dùng đã bật trước đó thì cập nhật âm thầm (không hỏi lại quyền)
  async refresh() {
    const u = AppStorage.getCurrentUser();
    const s = this.stored();
    if (!u || !s || s.user !== u.username || this.permission() !== 'granted' || !this.config() || AppStorage.isLocalOnly() || this.busy) return;
    try {
      const token = await this._getToken();
      if (token !== s.token) {
        const session = AppStorage._readSession();
        const res = await AppStorage._authRequest({ action: 'pushRegister', token: session && session.token, deviceToken: token, ua: this._uaLabel() });
        if (res.status === 'ok') {
          this.setStored({ token, user: u.username });
          // Gỡ mã cũ của chính thiết bị này để không nhận thông báo trùng
          await AppStorage._authRequest({ action: 'pushUnregister', token: session && session.token, deviceToken: s.token });
        }
      }
    } catch (e) {
      console.info('[PushClient] Chưa làm mới được mã thiết bị:', e.message);
    }
  },

  _uaLabel() {
    const ua = navigator.userAgent;
    const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
    const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
    return `${br} ${os}`.trim();
  },

  init() {
    // Thông báo từ Service Worker khi có tin đẩy: đồng bộ ngay để dữ liệu mới hiện lên liền
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'PUSH_RECEIVED' && AppStorage.requestSync) AppStorage.requestSync(0);
      });
    }
    window.addEventListener('app-state-changed', () => {
      clearTimeout(this._debounce);
      this._debounce = setTimeout(() => this.refresh(), 3000);
    });
    setTimeout(() => this.refresh(), 4000);
  },

  // ---------------- Giao diện ----------------
  // Khung trong Hồ sơ cá nhân
  renderProfileSection(user) {
    if (!user || AppStorage.isLocalOnly()) return '';
    const sup = this.support();
    let state, action = '';
    if (!this.clubEnabled() || !this.config()) {
      state = '<span class="text-secondary">Ban quản trị chưa bật thông báo đẩy cho CLB.</span>';
    } else if (!sup.ok) {
      state = `<span class="text-secondary">${Safe.html(sup.reason)}</span>`;
    } else if (this.permission() === 'denied') {
      state = '<span class="text-secondary">⚠️ Bạn đã chặn thông báo. Hãy cấp lại quyền trong cài đặt trình duyệt.</span>';
    } else if (this.isOn()) {
      state = '✅ Thiết bị này <b>đang nhận</b> thông báo đẩy (mở vote, đặt/hủy sân, nhắc giờ…).';
      action = `<button type="button" class="btn btn-secondary btn-sm" onclick="PushClient.toggleFromUI(false)">Tắt trên thiết bị này</button>
                <button type="button" class="btn btn-secondary btn-sm" onclick="PushClient.sendTest()"><i class="fas fa-paper-plane"></i> Gửi thử</button>`;
    } else {
      state = 'Nhận thông báo ngay trên điện thoại/máy tính, kể cả khi đã đóng ứng dụng.';
      action = `<button type="button" class="btn btn-primary btn-sm" onclick="PushClient.toggleFromUI(true)"><i class="fas fa-bell"></i> Bật thông báo đẩy</button>`;
    }
    return `
        <div style="background: var(--bg-input); padding: 1rem; border-radius: var(--radius-md); border: 1px solid var(--border-color); margin-top: 1rem;">
          <div style="font-weight: 700; font-size: 0.88rem; margin-bottom: 0.4rem; display: flex; align-items: center; gap: 0.4rem;">
            <i class="fas fa-bell text-primary"></i> Thông báo đẩy
          </div>
          <div id="push-profile-state" style="font-size: 0.82rem; margin-bottom: ${action ? '0.6rem' : '0'};">${state}</div>
          ${action ? `<div class="flex" style="gap: 0.4rem; flex-wrap: wrap;">${action}</div>` : ''}
        </div>`;
  },

  async toggleFromUI(on) {
    const el = document.getElementById('push-profile-state');
    if (el) el.textContent = 'Đang xử lý…';
    const res = on ? await this.enable() : await this.disable();
    App.showToast(res.message, res.success ? 'success' : 'warning');
    if (window.NotificationModule) NotificationModule.renderNotifToggleBtn();
    if (App.openUserProfileModal && document.getElementById('push-profile-state')) App.openUserProfileModal();
  },

  async sendTest() {
    const session = AppStorage._readSession();
    const res = await AppStorage._authRequest({ action: 'pushTest', token: session && session.token });
    App.showToast(res.status === 'ok' ? `📨 Đã gửi thử tới ${res.sent} thiết bị. Thông báo sẽ hiện trong vài giây.` : (res.message || 'Không gửi thử được.'), res.status === 'ok' ? 'success' : 'warning');
  }
};

window.PushClient = PushClient;
;

// ===== js/modules/notification.js =====
// SMASH PRO - Notification Module
// Quản lý thông báo Web Push cho thành viên:
// 1. Thông báo chốt đặt sân khi Admin tạo lịch / chốt phương án poll
// 2. Nhắc trước 4 tiếng khi buổi đánh sắp diễn ra

const NotificationModule = {
  // Key lưu danh sách alarm đã nhắc (tránh nhắc lại)
  ALARM_KEY: 'SMASH_PRO_NOTIF_ALARMS_V1',
  SW_SCOPE: '/',
  swRegistration: null,
  reminderInterval: null,

  // ==========================================
  // KHỞI TẠO: Đăng ký Service Worker + Chạy bộ kiểm tra nhắc lịch
  // ==========================================
  async init() {
    if (!('Notification' in window)) {
      console.info('[NotifModule] Trình duyệt không hỗ trợ Web Notification.');
      return;
    }

    // Đăng ký Service Worker
    if ('serviceWorker' in navigator) {
      try {
        this.swRegistration = await navigator.serviceWorker.register('sw.js', { scope: this.SW_SCOPE });
        console.info('[NotifModule] Service Worker đã đăng ký thành công:', this.swRegistration.scope);
      } catch (err) {
        console.warn('[NotifModule] Không thể đăng ký Service Worker:', err.message);
      }
    }

    // Render trạng thái nút thông báo trên UI
    this.renderNotifToggleBtn();

    // Bắt đầu vòng lặp kiểm tra nhắc lịch mỗi 5 phút
    this.startReminderChecker();
  },

  // ==========================================
  // RENDER NÚT BẬT/TẮT THÔNG BÁO TRÊN SIDEBAR & HEADER
  // ==========================================
  renderNotifToggleBtn() {
    const containers = [
      document.getElementById('notif-toggle-sidebar'),
      document.getElementById('notif-toggle-header')
    ];

    const permission = Notification.permission;
    const icon = permission === 'granted' ? 'fa-bell' : (permission === 'denied' ? 'fa-bell-slash' : 'fa-bell');
    const iconColor = permission === 'granted' ? '#10b981' : (permission === 'denied' ? '#ef4444' : '#f59e0b');
    const label = permission === 'granted' ? 'Thông báo: BẬT' : (permission === 'denied' ? 'Thông báo: ĐÃ CHẶN' : 'Bật thông báo');
    const titleAttr = permission === 'denied'
      ? 'Bạn đã chặn thông báo. Vào Cài đặt trình duyệt để cấp lại quyền.'
      : permission === 'granted'
        ? 'Thông báo đang bật. Nhấp để tắt tạm thời.'
        : 'Bật thông báo lịch đặt sân & nhắc 4 tiếng trước buổi đánh';

    containers.forEach(container => {
      if (!container) return;
      container.innerHTML = `
        <button
          id="${container.id}-btn"
          class="notif-toggle-btn ${permission === 'granted' ? 'is-active' : ''} ${permission === 'denied' ? 'is-denied' : ''}"
          onclick="NotificationModule.handleToggleClick()"
          title="${titleAttr}"
          aria-label="${label}"
        >
          <i class="fas ${icon}" style="color: ${iconColor}; font-size: 1rem;"></i>
          <span class="notif-toggle-label">${label}</span>
          ${permission === 'granted' ? '<span class="notif-active-dot"></span>' : ''}
        </button>
      `;
    });
  },

  // ==========================================
  // XỬ LÝ KHI NGƯỜI DÙNG NHẤP NÚT THÔNG BÁO
  // ==========================================
  async handleToggleClick() {
    const permission = Notification.permission;

    if (permission === 'denied') {
      App.showToast('🔕 Thông báo đang bị chặn. Vào Cài đặt trình duyệt → Quyền riêng tư → Thông báo để cấp lại.', 'warning');
      return;
    }

    if (permission === 'granted') {
      // Tắt tạm: xóa flag kích hoạt trong localStorage
      const isEnabled = localStorage.getItem('SMASH_PRO_NOTIF_ENABLED') !== '0';
      if (isEnabled) {
        localStorage.setItem('SMASH_PRO_NOTIF_ENABLED', '0');
        if (window.PushClient) PushClient.disable();
        App.showToast('🔕 Đã tắt thông báo. Bạn sẽ không nhận nhắc lịch đặt sân.', 'info');
      } else {
        localStorage.setItem('SMASH_PRO_NOTIF_ENABLED', '1');
        App.showToast('🔔 Đã bật lại thông báo lịch đặt sân!', 'success');
        if (window.PushClient && PushClient.config() && AppStorage.getCurrentUser()) PushClient.enable();
      }
      this.renderNotifToggleBtn();
      return;
    }

    // Chưa có quyền → xin quyền
    await this.requestPermission();
  },

  // ==========================================
  // XIN QUYỀN THÔNG BÁO (hiển thị dialog hướng dẫn trước)
  // ==========================================
  async requestPermission() {
    // Hiển thị modal giải thích trước khi xin quyền browser
    const modalBody = `
      <div style="text-align: center; margin-bottom: 1.5rem;">
        <div style="width: 72px; height: 72px; border-radius: 50%; background: linear-gradient(135deg, rgba(16,185,129,0.2) 0%, rgba(6,182,212,0.15) 100%); display: inline-flex; align-items: center; justify-content: center; font-size: 2rem; margin-bottom: 1rem;">
          🔔
        </div>
        <h3 style="font-size: 1.2rem; color: var(--text-main); margin-bottom: 0.5rem;">Bật thông báo lịch đặt sân</h3>
        <p class="text-secondary" style="font-size: 0.88rem; line-height: 1.6;">
          SMASH PRO sẽ gửi thông báo đến thiết bị của bạn trong 2 trường hợp:
        </p>
      </div>

      <div style="display: flex; flex-direction: column; gap: 0.75rem; margin-bottom: 1.5rem;">
        <div style="display: flex; align-items: flex-start; gap: 0.85rem; background: rgba(16,185,129,0.08); border-radius: var(--radius-md); padding: 0.85rem 1rem; border: 1px solid rgba(16,185,129,0.2);">
          <span style="font-size: 1.5rem; flex-shrink: 0;">📅</span>
          <div>
            <div style="font-weight: 700; color: var(--text-main); font-size: 0.92rem;">Khi Admin chốt lịch đặt sân</div>
            <div class="text-secondary" style="font-size: 0.8rem; margin-top: 0.2rem;">Nhận ngay khi Admin lưu lịch mới hoặc chốt phương án khảo sát — chứa đầy đủ thông tin sân, giờ đánh.</div>
          </div>
        </div>

        <div style="display: flex; align-items: flex-start; gap: 0.85rem; background: rgba(245,158,11,0.08); border-radius: var(--radius-md); padding: 0.85rem 1rem; border: 1px solid rgba(245,158,11,0.2);">
          <span style="font-size: 1.5rem; flex-shrink: 0;">⏰</span>
          <div>
            <div style="font-weight: 700; color: var(--text-main); font-size: 0.92rem;">Nhắc trước buổi đánh 4 tiếng</div>
            <div class="text-secondary" style="font-size: 0.8rem; margin-top: 0.2rem;">Nhắc nhở tự động trước 4 tiếng (chỉ dành cho thành viên đã bình chọn "Tham gia") — kể cả khi đóng tab.</div>
          </div>
        </div>
      </div>

      <div style="background: rgba(99,102,241,0.07); border-radius: var(--radius-sm); padding: 0.65rem 0.9rem; font-size: 0.78rem; color: var(--text-secondary); margin-bottom: 1.25rem;">
        <i class="fas fa-shield-alt text-primary"></i>
        Thông báo hoạt động ngay trên trình duyệt — không cần cài app, không thu thập dữ liệu cá nhân.
      </div>

      <div style="display: flex; gap: 0.5rem; justify-content: flex-end; flex-wrap: wrap;">
        <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Để sau</button>
        <button type="button" class="btn btn-primary" id="confirm-notif-btn" onclick="NotificationModule._doRequestPermission()">
          <i class="fas fa-bell"></i> Cho phép thông báo
        </button>
      </div>
    `;

    App.openModal('🔔 Bật thông báo lịch đặt sân', modalBody, false);
  },

  // Thực sự xin quyền browser
  async _doRequestPermission() {
    App.closeModal();
    try {
      const result = await Notification.requestPermission();
      if (result === 'granted') {
        localStorage.setItem('SMASH_PRO_NOTIF_ENABLED', '1');
        App.showToast('🔔 Đã bật thông báo! Bạn sẽ nhận nhắc lịch trước 4 tiếng và khi Admin chốt sân.', 'success');
        // Đã có quyền: đăng ký thiết bị để nhận thông báo đẩy cả khi đóng ứng dụng (nếu CLB đã cấu hình và đã đăng nhập)
        if (window.PushClient && PushClient.config() && AppStorage.getCurrentUser()) {
          PushClient.enable().then((r) => { if (!r.success) App.showToast(r.message, 'warning'); });
        }
        // Gửi thông báo demo để xác nhận
        setTimeout(() => {
          this._showNotification({
            title: '🏸 SMASH PRO - Thông báo đã bật!',
            body: 'Bạn sẽ nhận nhắc lịch đặt sân trước 4 tiếng và khi Admin chốt buổi đánh mới.',
            tag: 'smash-pro-welcome',
          });
        }, 800);
      } else if (result === 'denied') {
        App.showToast('🔕 Đã từ chối thông báo. Bạn có thể bật lại trong Cài đặt trình duyệt.', 'warning');
      }
    } catch (err) {
      console.warn('[NotifModule] Lỗi khi xin quyền thông báo:', err);
    }
    this.renderNotifToggleBtn();
  },

  // ==========================================
  // KIỂM TRA TRẠNG THÁI: Thông báo có được phép không?
  // ==========================================
  isEnabled() {
    if (!('Notification' in window)) return false;
    if (Notification.permission !== 'granted') return false;
    return localStorage.getItem('SMASH_PRO_NOTIF_ENABLED') !== '0';
  },

  // ==========================================
  // GỬI THÔNG BÁO (qua Service Worker hoặc Notification API trực tiếp)
  // ==========================================
  async _showNotification({ title, body, tag, icon }) {
    if (!this.isEnabled()) return;

    const notifIcon = icon || (window.location.origin + '/assets/favicon.png');

    // Ưu tiên dùng Service Worker để hiển thị cả khi tab bị ẩn
    if (this.swRegistration) {
      try {
        const sw = await navigator.serviceWorker.ready;
        if (sw && sw.active) {
          sw.active.postMessage({
            type: 'SHOW_NOTIFICATION',
            payload: { title, body, icon: notifIcon, tag: tag || 'smash-pro-notify' }
          });
          return;
        }
      } catch (err) {
        console.warn('[NotifModule] SW postMessage lỗi, dùng Notification API trực tiếp:', err.message);
      }
    }

    // Fallback: Notification API trực tiếp (chỉ hoạt động khi tab đang active)
    try {
      new Notification(title, {
        body,
        icon: notifIcon,
        tag: tag || 'smash-pro-notify',
        requireInteraction: false
      });
    } catch (err) {
      console.warn('[NotifModule] Notification API lỗi:', err);
    }
  },

  // ==========================================
  // [TRIGGER 1] THÔNG BÁO KHI ADMIN CHỐT / TẠO LỊCH MỚI
  // Gọi từ ScheduleModule.saveNewSession() và ScheduleModule.finalizePollOption()
  // ==========================================
  notifySessionBooked(session, isFinalized = false) {
    if (!session) return;
    if (!this.isEnabled()) return;

    const currentUser = AppStorage.getCurrentUser();
    // Nếu user đang đăng nhập là admin, chỉ notify nếu họ cũng đã vote tham gia
    // (Admin vẫn được notify nếu cũng trong danh sách going)

    const going = (session.votes || []).filter(v => v.status === 'going');
    const currentMember = currentUser
      ? AppStorage.loadData().members?.find(m =>
          m.id === currentUser.memberId ||
          m.id === currentUser.id ||
          (currentUser.username && m.username === currentUser.username)
        )
      : null;
    const currentMemberId = currentMember?.id || currentUser?.memberId || currentUser?.id;

    // Chỉ gửi cho thành viên đang đăng nhập nếu họ trong danh sách going
    const isGoing = currentMemberId && going.some(v => v.memberId === currentMemberId);

    // Nếu chưa ai vote (mới tạo) → notify cho tất cả người đang đăng nhập
    const shouldNotify = isGoing || going.length === 0;
    if (!shouldNotify) return;

    const isMultiPoll = session.voteMode === 'multi_option';
    const dateTime = `${session.date} lúc ${session.startTime}`;
    const courtInfo = isMultiPoll ? 'Khảo sát đa phương án' : `${session.courtName || 'Sân CLB'} (${session.courtNumbers || ''})`;

    const titleText = isFinalized
      ? `✅ Đã chốt lịch: ${session.title}`
      : `📅 Lịch đặt sân mới: ${session.title}`;

    const bodyText = isFinalized
      ? `Buổi đánh đã được xác nhận!\n📍 ${courtInfo}\n🕐 ${dateTime}`
      : `Admin vừa tạo lịch đặt sân mới.\n📍 ${courtInfo}\n🕐 ${dateTime}\n\nHãy vào app bình chọn tham gia ngay!`;

    this._showNotification({
      title: titleText,
      body: bodyText,
      tag: `session-booked-${session.id}`,
    });
  },

  // ==========================================
  // [TRIGGER 2] NHẮC TRƯỚC BUỔI ĐÁNH 4 TIẾNG
  // Chạy liên tục mỗi 5 phút trong vòng lặp
  // ==========================================
  startReminderChecker() {
    if (this.reminderInterval) clearInterval(this.reminderInterval);

    // Kiểm tra ngay khi init
    this._checkUpcomingReminders();

    // Lặp lại mỗi 5 phút
    this.reminderInterval = setInterval(() => {
      this._checkUpcomingReminders();
    }, 5 * 60 * 1000);
  },

  _checkUpcomingReminders() {
    if (!this.isEnabled()) return;

    const data = AppStorage.loadData();
    const sessions = data.sessions || [];
    const now = new Date();

    // Lấy danh sách alarm đã gửi
    let sentAlarms = {};
    try {
      sentAlarms = JSON.parse(localStorage.getItem(this.ALARM_KEY) || '{}');
    } catch (e) { sentAlarms = {}; }

    const currentUser = AppStorage.getCurrentUser();
    if (!currentUser) return;

    const currentMember = (data.members || []).find(m =>
      m.id === currentUser.memberId ||
      m.id === currentUser.id ||
      (currentUser.username && m.username === currentUser.username)
    );
    const currentMemberId = currentMember?.id || currentUser?.memberId || currentUser?.id;
    if (!currentMemberId) return;

    // Dọn dẹp alarm cũ hơn 2 ngày
    const twoDaysAgo = now.getTime() - (2 * 24 * 60 * 60 * 1000);
    Object.keys(sentAlarms).forEach(key => {
      if (sentAlarms[key] < twoDaysAgo) delete sentAlarms[key];
    });

    sessions.forEach(session => {
      if (session.status === 'cancelled') return;
      if (session.voteMode === 'multi_option' && !session.selectedOptionId) return;

      // Chỉ nhắc cho các session sắp tới (chưa bắt đầu)
      const sessionStart = ScheduleModule.parseSessionDateTime(session.date, session.startTime);
      const msToStart = sessionStart.getTime() - now.getTime();

      // Khoảng thời gian hợp lệ: còn 4 tiếng (±15 phút)
      const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
      const WINDOW_MS = 15 * 60 * 1000; // 15 phút tolerance

      const isInReminderWindow = msToStart >= (FOUR_HOURS_MS - WINDOW_MS) && msToStart <= (FOUR_HOURS_MS + WINDOW_MS);
      if (!isInReminderWindow) return;

      // Kiểm tra thành viên đã bình chọn "tham gia" chưa
      const going = (session.votes || []).filter(v => v.status === 'going');
      const isGoing = going.some(v => v.memberId === currentMemberId);
      if (!isGoing) return;

      // Kiểm tra đã nhắc buổi này chưa
      const alarmKey = `reminder_4h_${session.id}`;
      if (sentAlarms[alarmKey]) return;

      // Ghi nhận đã nhắc
      sentAlarms[alarmKey] = now.getTime();
      localStorage.setItem(this.ALARM_KEY, JSON.stringify(sentAlarms));

      // Gửi thông báo nhắc
      const courtInfo = session.courtName || 'Sân CLB';
      const courtNumbers = session.courtNumbers ? ` (${session.courtNumbers})` : '';
      const hoursLeft = Math.round(msToStart / (60 * 60 * 1000));

      this._showNotification({
        title: `⏰ Còn ${hoursLeft} tiếng nữa là đến giờ đánh!`,
        body: `🏸 ${session.title}\n📍 ${courtInfo}${courtNumbers}\n🕐 ${session.startTime} – ${session.endTime}, ${session.date}\n\nChuẩn bị đồ và đến đúng giờ nhé! 💪`,
        tag: alarmKey,
      });

      // Hiển thị toast in-app bổ sung
      if (typeof App !== 'undefined' && App.showToast) {
        App.showToast(
          `⏰ Nhắc nhở: Còn ${hoursLeft} tiếng nữa là đến buổi đánh "${session.title}" lúc ${session.startTime}!`,
          'info'
        );
      }
    });

    // Lưu lại sau khi dọn dẹp
    localStorage.setItem(this.ALARM_KEY, JSON.stringify(sentAlarms));
  },

  // ==========================================
  // TIỆN ÍCH: Xem lại danh sách alarm đã nhắc (Debug)
  // ==========================================
  getSentAlarms() {
    try {
      return JSON.parse(localStorage.getItem(this.ALARM_KEY) || '{}');
    } catch (e) { return {}; }
  },

  clearSentAlarms() {
    localStorage.removeItem(this.ALARM_KEY);
    console.info('[NotifModule] Đã xóa toàn bộ lịch sử alarm.');
  }
};

window.NotificationModule = NotificationModule;
;

// ===== js/app.js =====
// Main Application Controller & UI Dispatcher for SMASH PRO
// Tích hợp hệ thống xác thực người dùng, phân quyền Admin/Member và đồng bộ Google Drive

const App = {
  currentTab: 'dashboard',
  theme: 'light',
  currentRegisterMethod: 'phone', // 'phone' | 'name'
  wasLoggedIn: false,
  lastActivityTouch: 0,

  async init() {
    // Khởi tạo kho dữ liệu cục bộ (IndexedDB) TRƯỚC khi hiển thị; đồng bộ Cloud tự chạy nền sau đó
    await AppStorage.init();

    this.initTheme();
    this.initEventListeners();
    this.initActivityTracker();

    // Khởi động hệ thống thông báo (Service Worker + kiểm tra nhắc lịch 4 tiếng)
    if (window.NotificationModule) {
      NotificationModule.init();
    }

    // Thông báo mở bình chọn / đặt sân / hủy sân (kiểm tra trên từng thiết bị)
    if (window.VoteScheduler) {
      VoteScheduler.init();
    }

    // Duyệt thành viên cố định (bảng yêu cầu + thông báo)
    if (window.MembershipModule) {
      MembershipModule.init();
      if (window.UtilitiesModule) UtilitiesModule.init();
    }

    // Lịch bình chọn tự động (Ban quản trị & thành viên được Admin chỉ định)
    if (window.AutoScheduleModule) {
      AutoScheduleModule.init();
    }

    // Thông báo đẩy tới thiết bị (đăng ký thiết bị, nhận tin từ Service Worker)
    if (window.PushClient) {
      PushClient.init();
    }

    // Khởi tạo trước ScheduleModule để dữ liệu lịch luôn hiển thị ngay từ lần đầu
    if (window.ScheduleModule) {
      ScheduleModule.init();
    }

    // Đọc URL hash nếu có (ví dụ: #schedule, #members, #dashboard)
    let initialTab = 'dashboard';
    const hash = window.location.hash.replace('#', '');
    if (hash && ['dashboard', 'schedule', 'members', 'fund', 'cashbook', 'bill-splitter', 'register-member', 'settings'].includes(hash)) {
      initialTab = hash === 'register-member' ? 'members' : hash;
    }

    // Nếu vào thẳng tab Settings mà không phải Admin -> chuyển về Dashboard
    if (initialTab === 'settings' && !AppStorage.isAdmin()) {
      initialTab = 'dashboard';
    }

    // Khởi tạo giao diện người dùng (Khách vãng lai hoặc User đã đăng nhập)
    this.renderUserHeaderAndSidebar();
    this.refreshDashboardStats();
    this.openTab(initialTab);
    if (AppStorage.mustChangePassword()) this.openForceChangePasswordModal();

    // Cập nhật đồng hồ đếm ngược mỗi 60 giây
    setInterval(() => {
      if (this.currentTab === 'schedule' || this.currentTab === 'dashboard') {
        if (window.ScheduleModule) {
          ScheduleModule.renderSessions("sessions-container", "upcoming");
          ScheduleModule.renderSessions("dashboard-sessions-preview", "upcoming");
        }
      }
    }, 60000);
  },

  initActivityTracker() {
    this.wasLoggedIn = AppStorage.isLoggedIn();

    const onUserActivity = () => {
      const now = Date.now();
      if (now - this.lastActivityTouch > 10000) { // Throttle 10 giây
        this.lastActivityTouch = now;
        AppStorage.touchActivity();
      }
    };

    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'].forEach(evt => {
      window.addEventListener(evt, onUserActivity, { passive: true });
    });

    // Gia hạn phiên trượt: lúc mở ứng dụng, khi quay lại tab, và định kỳ
    const renew = () => { if (AppStorage.isLoggedIn()) AppStorage.refreshSession(); };
    const upd = () => { if (!this._updateSnooze || Date.now() > this._updateSnooze) this.checkForUpdate(); };
    setTimeout(upd, 20000);
    setInterval(upd, 10 * 60 * 1000);
    setTimeout(renew, 3000);
    setInterval(renew, AppStorage.REFRESH_CHECK_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') renew(); });

    // Inactivity Watchdog: Tự động kiểm tra trạng thái hết hạn mỗi 10 giây
    setInterval(() => {
      const currentlyLoggedIn = AppStorage.isLoggedIn();
      if (this.wasLoggedIn && !currentlyLoggedIn) {
        this.wasLoggedIn = false;
        this.handleSessionExpired();
      } else if (currentlyLoggedIn) {
        this.wasLoggedIn = true;
      }
    }, 10000);
  },

  handleSessionExpired() {
    this.renderUserHeaderAndSidebar();
    this.showToast("⚠️ Phiên đăng nhập đã kết thúc (hết hạn hoặc không thao tác 30 phút khi không bật \"Duy trì đăng nhập\"). Bạn đang ở chế độ Khách vãng lai.", "warning");
    if (this.currentTab === 'settings') {
      this.openTab('dashboard');
    }
  },

  initTheme() {
    const currentUser = AppStorage.getCurrentUser();
    let initialTheme = 'light';
    if (currentUser) {
      initialTheme = currentUser.themePreference || localStorage.getItem(`smash_pro_theme_${currentUser.id}`) || localStorage.getItem('smash_pro_theme') || 'light';
    } else {
      initialTheme = localStorage.getItem('smash_pro_theme_guest') || localStorage.getItem('smash_pro_theme') || 'light';
    }
    this.setTheme(initialTheme, false);
  },

  setTheme(theme, persistToUser = true) {
    this.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('smash_pro_theme', theme);

    const currentUser = AppStorage.getCurrentUser();
    if (!currentUser) {
      localStorage.setItem('smash_pro_theme_guest', theme);
    } else {
      localStorage.setItem(`smash_pro_theme_${currentUser.id}`, theme);
    }

    const themeIcon = document.getElementById('theme-toggle-icon');
    const themeBtn = themeIcon ? themeIcon.closest('button') : null;
    if (themeIcon) {
      themeIcon.className = theme === 'light' ? 'fas fa-moon' : 'fas fa-sun';
    }
    if (themeBtn) {
      themeBtn.title = theme === 'light' ? 'Chuyển sang giao diện Tối (Dark Mode)' : 'Chuyển sang giao diện Sáng (Light Mode)';
    }

    // Cá nhân hóa lưu vào tài khoản & đồng bộ Cloud
    if (persistToUser && currentUser) {
      const data = AppStorage.loadData();
      let updated = false;
      if (data.users) {
        const u = data.users.find(x => x.id === currentUser.id);
        if (u) {
          u.themePreference = theme;
          updated = true;
        }
      }
      if (data.currentUser && data.currentUser.id === currentUser.id) {
        data.currentUser.themePreference = theme;
        updated = true;
      }
      if (updated) {
        AppStorage.saveData(data, true);
      }
    }
  },

  toggleTheme() {
    const nextTheme = this.theme === 'light' ? 'dark' : 'light';
    this.setTheme(nextTheme, true);
    this.showToast(
      nextTheme === 'dark' 
        ? '🌙 Đã chuyển sang giao diện Tối & lưu tùy chọn cá nhân' 
        : '☀️ Đã chuyển sang giao diện Sáng & lưu tùy chọn cá nhân',
      'info'
    );
  },

  applyUserTheme(user) {
    if (!user) {
      const guestTheme = localStorage.getItem('smash_pro_theme_guest') || localStorage.getItem('smash_pro_theme') || 'light';
      this.setTheme(guestTheme, false);
      return;
    }
    const userTheme = user.themePreference || localStorage.getItem(`smash_pro_theme_${user.id}`) || 'light';
    this.setTheme(userTheme, false);
  },

  initEventListeners() {
    // Navigation Tabs
    document.querySelectorAll('[data-tab]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const tabId = el.getAttribute('data-tab');
        this.openTab(tabId);
        document.getElementById('sidebar')?.classList.remove('open');
        document.getElementById('sidebar-backdrop')?.classList.remove('active');
      });
    });

    // Mobile Sidebar
    document.getElementById('mobile-menu-toggle')?.addEventListener('click', () => {
      const sidebar = document.getElementById('sidebar');
      const backdrop = document.getElementById('sidebar-backdrop');
      if (sidebar) {
        sidebar.classList.toggle('open');
        if (backdrop) backdrop.classList.toggle('active', sidebar.classList.contains('open'));
      }
    });

    // Modal Background Close
    document.getElementById('global-modal-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'global-modal-overlay') {
        this.closeModal();
      }
    });

    // Lắng nghe thay đổi trạng thái CSDL và cập nhật toàn diện giao diện tức thời
    // Dữ liệu từ máy khác tự cập nhật lên màn hình (không cần tải lại trang). Nếu người dùng đang gõ dở vào ô nhập
    // thì hoãn vẽ lại tới khi họ rời ô đó, để không làm mất nội dung đang nhập.
    window.addEventListener('app-state-changed', () => this.scheduleLiveRender());
    document.addEventListener('focusout', () => { if (this._renderDeferred) setTimeout(() => this.flushDeferredRender(), 250); });
    setInterval(() => this.flushDeferredRender(), 3000);
  },

  // Đang nhập liệu trong khu vực nội dung (không tính hộp thoại: nội dung hộp thoại không bị vẽ lại)
  // Phát hiện bản ứng dụng mới được đăng lên máy chủ (so mã gói ?v= trong index.html) và mời cập nhật, không tự tải lại
  async checkForUpdate() {
    try {
      if (location.protocol === 'file:' || this._updateShown) return;
      const cur = (document.querySelector('script[src*="bundle.js"]') || {}).src || '';
      const mc = cur.match(/bundle\.js\?v=([A-Za-z0-9]+)/);
      if (!mc) return;
      const res = await fetch(`${location.pathname}?_=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const m = (await res.text()).match(/js\/bundle\.js\?v=([A-Za-z0-9]+)/);
      if (m && m[1] !== mc[1]) this.showUpdateBanner();
    } catch (e) { /* mất mạng: bỏ qua */ }
  },

  showUpdateBanner() {
    if (this._updateShown) return;
    this._updateShown = true;
    const bar = document.createElement('div');
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'position: fixed; left: 50%; bottom: 1rem; transform: translateX(-50%); z-index: 9999; background: var(--bg-card-solid); border: 1px solid var(--primary); border-radius: 999px; padding: 0.5rem 0.6rem 0.5rem 1rem; box-shadow: var(--shadow-lg); display: flex; gap: 0.6rem; align-items: center; font-size: 0.85rem;';
    bar.innerHTML = '<span>🔄 Có phiên bản ứng dụng mới.</span><button type="button" class="btn btn-primary btn-sm">Cập nhật</button><button type="button" class="btn btn-ghost btn-sm" aria-label="Để sau">&times;</button>';
    const [update, later] = bar.querySelectorAll('button');
    update.onclick = () => location.reload();
    later.onclick = () => { bar.remove(); this._updateShown = false; this._updateSnooze = Date.now() + 30 * 60 * 1000; };
    document.body.appendChild(bar);
  },

  isEditingContent() {
    const el = document.activeElement;
    if (!el || el === document.body) return false;
    const tag = el.tagName;
    if (!(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable)) return false;
    if (tag === 'INPUT' && ['checkbox', 'radio', 'button', 'submit', 'range'].includes(el.type)) return false;
    return !!el.closest('.tab-pane, main');
  },

  scheduleLiveRender() {
    clearTimeout(this._liveTimer);
    this._liveTimer = setTimeout(() => {
      if (this.isEditingContent()) { this._renderDeferred = true; return; }
      this.runLiveRender();
    }, 150);
  },

  flushDeferredRender() {
    if (!this._renderDeferred || this.isEditingContent()) return;
    this.runLiveRender();
  },

  runLiveRender() {
    this._renderDeferred = false;
    this.refreshDashboardStats();
    this.renderUserHeaderAndSidebar();
    if (window.MembersModule && typeof MembersModule.renderBenefitsAndRules === 'function') {
      MembersModule.renderBenefitsAndRules();
    }
    if (this.currentTab) {
      this.renderTabContent(this.currentTab);
    }
  },

  // ==========================================
  // HỆ THỐNG XÁC THỰC GIAO DIỆN (AUTH MODAL)
  // ==========================================

  showAuthModal(tab = 'login') {
    const overlay = document.getElementById('auth-modal-overlay');
    if (overlay) {
      overlay.classList.add('active');
      this.switchAuthTab(tab);
      if (window.GoogleAuth) GoogleAuth.renderAuthButtons();
    }
  },

  closeAuthModal() {
    const overlay = document.getElementById('auth-modal-overlay');
    if (overlay) {
      overlay.classList.remove('active');
    }
  },

  switchAuthTab(tab) {
    const tabLoginBtn = document.getElementById('auth-tab-login');
    const tabRegBtn = document.getElementById('auth-tab-register');
    const formLogin = document.getElementById('auth-login-form');
    const formReg = document.getElementById('auth-register-form');

    if (tab === 'login') {
      tabLoginBtn?.classList.add('active');
      tabRegBtn?.classList.remove('active');
      if (formLogin) formLogin.style.display = 'block';
      if (formReg) formReg.style.display = 'none';
      setTimeout(() => document.getElementById('auth-login-username')?.focus(), 150);
    } else {
      tabRegBtn?.classList.add('active');
      tabLoginBtn?.classList.remove('active');
      if (formLogin) formLogin.style.display = 'none';
      if (formReg) formReg.style.display = 'block';
      setTimeout(() => document.getElementById('auth-reg-name')?.focus(), 150);
    }
  },

  setRegisterMethod(method) {
    this.currentRegisterMethod = method;
  },

  handleNameInputForUsername(name) {
  },

  validatePasswordStrength(pwd) {
    this.validatePasswordPolicy();
  },

  validatePasswordPolicy() {
    const pwd = document.getElementById('auth-reg-password')?.value || '';
    const confirm = document.getElementById('auth-reg-confirm-password')?.value || '';
    
    const lenCheck = document.getElementById('pwd-len-check');
    const spaceCheck = document.getElementById('pwd-space-check');
    const matchText = document.getElementById('auth-pwd-match-text');

    if (lenCheck) {
      if (!pwd) {
        lenCheck.className = 'pwd-indicator';
        lenCheck.innerHTML = '<i class="fas fa-circle-notch"></i> Tối thiểu từ 8 ký tự trở lên';
      } else if (pwd.length >= 8) {
        lenCheck.className = 'pwd-indicator valid';
        lenCheck.innerHTML = '<i class="fas fa-check-circle"></i> Tối thiểu từ 8 ký tự (Đạt)';
      } else {
        lenCheck.className = 'pwd-indicator invalid';
        lenCheck.innerHTML = `<i class="fas fa-times-circle"></i> Tối thiểu từ 8 ký tự (Hiện có ${pwd.length}/8)`;
      }
    }

    if (spaceCheck) {
      if (!pwd) {
        spaceCheck.className = 'pwd-indicator';
        spaceCheck.innerHTML = '<i class="fas fa-circle-notch"></i> Không chứa khoảng trắng (dấu cách)';
      } else if (!/\s/.test(pwd)) {
        spaceCheck.className = 'pwd-indicator valid';
        spaceCheck.innerHTML = '<i class="fas fa-check-circle"></i> Không chứa khoảng trắng (Đạt)';
      } else {
        spaceCheck.className = 'pwd-indicator invalid';
        spaceCheck.innerHTML = '<i class="fas fa-times-circle"></i> Không được chứa khoảng trắng!';
      }
    }

    if (matchText) {
      if (!confirm) {
        matchText.innerHTML = '';
      } else if (pwd && pwd === confirm) {
        matchText.innerHTML = '<span style="color: var(--success); font-weight: 600;"><i class="fas fa-check-circle"></i> Mật khẩu xác nhận khớp hoàn toàn</span>';
      } else {
        matchText.innerHTML = '<span style="color: var(--danger); font-weight: 600;"><i class="fas fa-times-circle"></i> Mật khẩu xác nhận chưa khớp!</span>';
      }
    }
  },

  validatePasswordMatch() {
    this.validatePasswordPolicy();
  },

  togglePasswordVisibility(inputId, btn) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    btn.innerHTML = isPassword ? '<i class="fas fa-eye-slash"></i>' : '<i class="fas fa-eye"></i>';
  },

  async handleLogin(event) {
    event.preventDefault();
    const usernameInput = document.getElementById('auth-login-username')?.value;
    const passwordInput = document.getElementById('auth-login-password')?.value;
    const remember = document.getElementById('auth-login-remember')?.checked ?? false;
    const submitBtn = event.submitter || event.target?.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    let result;
    try {
      result = await AppStorage.login(usernameInput, passwordInput, remember);
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
    if (result.success) {
      this.wasLoggedIn = true;
      this.applyUserTheme(result.user);
      this.closeAuthModal();
      this.renderUserHeaderAndSidebar();
      this.refreshDashboardStats();
      this.openTab('dashboard');
      this.showToast(result.message, result.mustChange ? "warning" : "success");
      if (result.mustChange) this.openForceChangePasswordModal(passwordInput);
    } else {
      this.showToast(result.message, "error");
    }
  },

  // Tài khoản dùng mật khẩu yếu (admin, 123456, trùng SĐT...): bắt buộc đổi, máy chủ chưa nhận thay đổi dữ liệu tới khi đổi xong
  openForceChangePasswordModal(currentPassword = '') {
    this._forceOldPassword = currentPassword;
    const modalBody = `
      <form onsubmit="App.submitForceChangePassword(event)">
        <p class="text-secondary" style="font-size: 0.85rem; margin-bottom: 1rem;">
          Mật khẩu hiện tại quá dễ đoán. Để bảo vệ dữ liệu CLB, vui lòng đặt mật khẩu mới (tối thiểu 8 ký tự, không trùng tên đăng nhập/SĐT, không dùng mật khẩu phổ biến).
        </p>
        ${currentPassword ? '' : `
        <div class="form-group">
          <label class="form-label font-bold">Mật khẩu hiện tại *</label>
          <input type="password" id="force-old-pwd" class="form-control" required>
        </div>`}
        <div class="form-group">
          <label class="form-label font-bold">Mật khẩu mới *</label>
          <input type="password" id="force-new-pwd" class="form-control" required autocomplete="new-password">
        </div>
        <div class="form-group">
          <label class="form-label font-bold">Nhập lại mật khẩu mới *</label>
          <input type="password" id="force-confirm-pwd" class="form-control" required autocomplete="new-password">
        </div>
        <div class="modal-footer" style="padding: 1rem 0 0 0; display: flex; justify-content: flex-end; gap: 0.5rem;">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal(); App.logout();">Đăng xuất</button>
          <button type="submit" class="btn btn-primary"><i class="fas fa-key"></i> Đổi mật khẩu</button>
        </div>
      </form>
    `;
    this.openModal("🔐 Bắt buộc đổi mật khẩu", modalBody);
  },

  async submitForceChangePassword(e) {
    if (e && e.preventDefault) e.preventDefault();
    const user = AppStorage.getCurrentUser();
    if (!user) return;
    const oldPwd = this._forceOldPassword || document.getElementById('force-old-pwd')?.value || '';
    const newPwd = document.getElementById('force-new-pwd')?.value || '';
    const confirmPwd = document.getElementById('force-confirm-pwd')?.value || '';
    const result = await AppStorage.changePassword(user.username, oldPwd, newPwd, confirmPwd);
    if (result.success) {
      this._forceOldPassword = '';
      this.closeModal();
      this.showToast(`🎉 ${result.message}`, "success");
    } else {
      this.showToast(`⚠️ ${result.message}`, "error");
    }
  },

  async handleRegister(event) {
    event.preventDefault();
    const name = document.getElementById('auth-reg-name')?.value;
    const account = (document.getElementById('auth-reg-account')?.value || "").trim();
    const password = document.getElementById('auth-reg-password')?.value;
    const confirmPassword = document.getElementById('auth-reg-confirm-password')?.value;
    const memberType = document.getElementById('auth-reg-member-type')?.value || 'fixed';
    const remember = document.getElementById('auth-reg-remember')?.checked ?? false;

    const result = await AppStorage.register({
      name,
      phone: account,
      usernameInput: account,
      password,
      confirmPassword,
      memberType,
      remember
    });

    if (result.success) {
      this.wasLoggedIn = true;
      if (result.user) {
        this.applyUserTheme(result.user);
      }
      this.closeAuthModal();
      this.renderUserHeaderAndSidebar();
      this.refreshDashboardStats();
      this.openTab('dashboard');
      this.showToast(`🎉 ${result.message}`, "success");
      if (result.mustChange) this.openForceChangePasswordModal(password);
    } else {
      this.showToast(result.message, "error");
    }
  },

  logout() {
    AppStorage.logout(true);
    this.wasLoggedIn = false;
    const loginUser = document.getElementById('auth-login-username');
    const loginPwd = document.getElementById('auth-login-password');
    if (loginUser) loginUser.value = '';
    if (loginPwd) loginPwd.value = '';
    this.renderUserHeaderAndSidebar();
    if (this.currentTab === 'settings') {
      this.openTab('dashboard');
    }
    this.applyUserTheme(null);
    this.showToast("Đã đăng xuất tài khoản thành công! Bạn đang ở chế độ Khách vãng lai.", "info");
  },

  // ==========================================
  // ĐIỀU HƯỚNG TABS & PHÂN QUYỀN
  // ==========================================

  openTab(tabId) {
    const isAdmin = AppStorage.isAdmin();
    const isGuest = AppStorage.isGuest();

    // 1. Chặn các tab Quản trị nếu không phải Admin
    if ((tabId === 'settings' || tabId === 'bill-splitter') && !isAdmin) {
      this.showToast("⚠️ Chức năng này chỉ dành cho Ban quản trị CLB. Vui lòng đăng nhập Admin!", "warning");
      this.showAuthModal('login');
      return;
    }

    // 2. Chặn các tab Tài chính & Quỹ đối với Khách / Thành viên vãng lai
    if ((tabId === 'fund' || tabId === 'cashbook') && isGuest) {
      this.showToast("⚠️ Sổ thu chi và Quỹ CLB chỉ dành cho Thành viên chính thức hoặc Ban Quản trị. Khách vãng lai vui lòng xem Lịch đặt sân & Điều khoản CLB!", "info");
      this.openTab('schedule');
      return;
    }

    this.currentTab = tabId;

    // Cập nhật trạng thái Active trên thanh điều hướng
    document.querySelectorAll('.nav-link, .mobile-bottom-item').forEach(el => {
      if (el.getAttribute('data-tab') === tabId) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    });

    // Hiển thị Tab Pane tương ứng
    document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
    const targetPane = document.getElementById(`tab-${tabId}`);
    if (targetPane) {
      targetPane.classList.add('active');
    }

    // Điều phối Module hiển thị
    this.renderTabContent(tabId);

    window.scrollTo({ top: 0, behavior: 'smooth' });
  },

  renderTabContent(tabId) {
    switch (tabId) {
      case 'dashboard':
        this.renderDashboard();
        break;
      case 'schedule':
        if (window.ScheduleModule) {
          ScheduleModule.init();
        }
        if (window.AutoScheduleModule) AutoScheduleModule.renderPanel();
        break;
      case 'members':
        if (window.MembersModule) {
          MembersModule.init();
        }
        break;
      case 'fund':
        if (window.FundModule) FundModule.renderFundDashboard();
        break;
      case 'cashbook':
        if (window.CashbookModule) CashbookModule.renderCashbook();
        break;
      case 'bill-splitter':
        if (window.BillSplitterModule) BillSplitterModule.init();
        break;
      case 'register-member':
        if (window.MembersModule) {
          MembersModule.switchSubTab('register');
        } else if (window.SettingsModule) {
          SettingsModule.renderPublicMemberRoster();
        }
        break;
      case 'settings':
        if (window.SettingsModule) SettingsModule.renderSettings();
        break;
    }
  },

  renderDashboard() {
    this.refreshDashboardStats();
    if (window.ScheduleModule) {
      ScheduleModule.renderSessions("dashboard-sessions-preview", "upcoming");
    }
  },

  refreshDashboardStats() {
    const data = AppStorage.loadData();
    const sessions = data.sessions || [];
    const members = data.members || [];
    const fixedMembers = members.filter(m => m.type === 'fixed');
    const dues = data.monthlyContributions || [];
    const currentMonth = AppStorage.currentMonth();
    const txs = data.transactions || [];

    // Số dư quỹ
    let totalIncome = 0;
    let totalExpense = 0;
    txs.forEach(t => {
      if (t.type === 'income') totalIncome += Number(t.amount);
      if (t.type === 'expense') totalExpense += Number(t.amount);
    });
    const fundBalance = totalIncome - totalExpense;

    // Thống kê quỹ tháng (Chỉ tính các thành viên cố định thực sự tồn tại trong danh sách)
    const fixedMemberIds = new Set(fixedMembers.map(m => m.id));
    const validMonthDues = dues.filter(d => d.month === currentMonth && fixedMemberIds.has(d.memberId));
    const monthDuesPaid = validMonthDues.filter(d => d.status === 'paid');
    const pendingDues = validMonthDues.filter(d => d.status === 'pending');

    // Buổi đánh tiếp theo (tương thích cả startTime/endTime và chuỗi time '20:00 - 22:00')
    const now = new Date();
    const upcomingSessions = sessions.filter(s => {
      if (!s || !s.date) return false;
      const endStr = s.endTime || (s.time && s.time.includes('-') ? s.time.split('-')[1].trim() : '23:59');
      const sessionEndDate = new Date(`${s.date}T${endStr.length === 5 ? endStr : '23:59'}`);
      return isNaN(sessionEndDate.getTime()) ? new Date(s.date) >= now : sessionEndDate >= now;
    }).sort((a, b) => {
      const aStart = a.startTime || (a.time ? a.time.split('-')[0].trim() : '00:00');
      const bStart = b.startTime || (b.time ? b.time.split('-')[0].trim() : '00:00');
      return new Date(`${a.date}T${aStart.length === 5 ? aStart : '00:00'}`) - new Date(`${b.date}T${bStart.length === 5 ? bStart : '00:00'}`);
    });
    
    const nextSession = upcomingSessions[0];

    // Cập nhật DOM
    const dashBal = document.getElementById('dash-fund-balance');
    const dashFundStatus = document.getElementById('dash-fund-status');
    if (dashBal) {
      dashBal.innerText = `${fundBalance.toLocaleString('vi-VN')} đ`;
      if (fundBalance < 0) {
        dashBal.style.color = '#ef4444';
      } else {
        dashBal.style.color = '';
      }
    }
    if (dashFundStatus) {
      if (fundBalance > 0) {
        dashFundStatus.className = 'stat-sub text-primary';
        dashFundStatus.innerHTML = '<i class="fas fa-check-circle"></i> Số dư khả dụng';
      } else if (fundBalance === 0) {
        dashFundStatus.className = 'stat-sub text-secondary';
        dashFundStatus.innerHTML = '<i class="fas fa-info-circle"></i> Quỹ cân bằng (0 đ)';
      } else {
        dashFundStatus.className = 'stat-sub text-danger';
        dashFundStatus.innerHTML = `<i class="fas fa-exclamation-triangle"></i> Quỹ đang âm (Cần bù ${Math.abs(fundBalance).toLocaleString('vi-VN')} đ)`;
      }
    }

    const dashDues = document.getElementById('dash-paid-members');
    const dashPending = document.getElementById('dash-pending-dues');
    if (AppStorage.isAdmin()) {
      if (dashDues) {
        const totalFixedCount = fixedMembers.length > 0 ? fixedMembers.length : members.length;
        dashDues.innerText = `${monthDuesPaid.length}/${totalFixedCount} thành viên`;
      }
      if (dashPending) dashPending.innerText = `${pendingDues.length} chờ duyệt`;
    } else {
      // Thành viên thường: chỉ thấy tình trạng của chính mình
      const me = AppStorage.getCurrentUser();
      const mine = me ? dues.find(d => d.memberId === me.memberId && d.month === currentMonth) : null;
      if (dashDues) dashDues.innerText = !me ? 'Đăng nhập để xem' : mine && mine.status === 'paid' ? 'Bạn đã đóng' : mine && mine.status === 'pending' ? 'Bạn: chờ duyệt' : (me.type === 'fixed' ? 'Bạn chưa đóng' : 'Không áp dụng');
      if (dashPending) dashPending.innerText = 'Chỉ hiển thị quỹ của bạn';
    }

    const dashNext = document.getElementById('dash-next-session-title');
    const dashNextTime = document.getElementById('dash-next-session-time');
    if (nextSession) {
      if (dashNext) dashNext.innerText = nextSession.title;
      if (dashNextTime) {
        const startStr = nextSession.startTime || (nextSession.time ? nextSession.time.split('-')[0].trim() : '20:00');
        dashNextTime.innerText = `${nextSession.date} lúc ${startStr}`;
      }
    } else {
      if (dashNext) dashNext.innerText = "Chưa có lịch";
      if (dashNextTime) dashNextTime.innerText = "Liên hệ admin tạo lịch mới";
    }

    const dashTotalMembers = document.getElementById('dash-total-members');
    if (dashTotalMembers) dashTotalMembers.innerText = `${members.length} người`;

    // Tên CLB & Banner
    const clubInfo = data.clubInfo || {};
    const clubNameEl = document.getElementById('sidebar-club-name');
    if (clubNameEl && clubInfo.name) clubNameEl.innerText = clubInfo.name;
    const clubSloganEl = document.getElementById('sidebar-club-slogan');
    if (clubSloganEl && clubInfo.slogan) clubSloganEl.innerText = clubInfo.slogan;

    // Cập nhật Hero Banner trên Dashboard
    const heroSeasonEl = document.getElementById('dash-hero-season');
    if (heroSeasonEl) {
      heroSeasonEl.innerHTML = `<i class="fas fa-fire"></i> ${Safe.html(clubInfo.season || 'Mùa giải 2026')}`;
    }

    const heroTitleEl = document.getElementById('dash-hero-title');
    if (heroTitleEl) {
      heroTitleEl.innerText = (clubInfo.name || 'SMASH PRO BADMINTON CLUB').toUpperCase();
    }

    const heroSubtitleEl = document.getElementById('dash-hero-subtitle');
    if (heroSubtitleEl) {
      if (clubInfo.bannerSubtitle && clubInfo.bannerSubtitle.trim()) {
        heroSubtitleEl.innerHTML = `<i class="fas fa-map-marker-alt text-primary"></i> ${Safe.html(clubInfo.bannerSubtitle)}`;
      } else {
        const courtName = clubInfo.defaultCourt ? clubInfo.defaultCourt.trim() : '';
        const lockHours = clubInfo.voteLockHours || 48;
        const lockDays = Math.round(lockHours / 24);
        const lockText = lockDays > 0 ? `Tự động đóng vote trước giờ đánh ${lockDays} ngày` : `Tự động đóng vote trước giờ đánh ${lockHours} giờ`;
        const prefix = courtName ? `${courtName} • ` : '';
        heroSubtitleEl.innerHTML = `<i class="fas fa-map-marker-alt text-primary"></i> ${Safe.html(prefix)}${Safe.html(lockText)}`;
      }
    }
  },

  renderUserHeaderAndSidebar() {
    const currentUser = AppStorage.getCurrentUser();
    const isAdmin = AppStorage.isAdmin();
    const isFixed = AppStorage.isFixedMember();
    const isGuest = AppStorage.isGuest();
    // Chưa đăng nhập: CSS ẩn ảnh "KH" ở thanh đầu trang và (trên màn hình rộng) nút đăng nhập ở đó, vì thanh bên đã có
    document.body.classList.toggle('is-guest', !currentUser);

    const userAvatarEl = document.getElementById('header-user-avatar');
    const userNameEl = document.getElementById('header-user-name');
    const userRoleBadgeEl = document.getElementById('header-user-role');
    const headerBtnWrapper = document.getElementById('header-auth-btn-wrapper');
    const sidebarBtnWrapper = document.getElementById('sidebar-auth-btn-wrapper');
    const sidebarUserCard = document.getElementById('sidebar-user-card');
    const sidebarAvatar = document.getElementById('sidebar-user-avatar');
    const sidebarName = document.getElementById('sidebar-user-name');
    const sidebarRole = document.getElementById('sidebar-user-role');
    const navMembersLabel = document.getElementById('nav-members-label');
    const mobileMembersLabel = document.getElementById('mobile-members-label');

    // Phân quyền hiển thị Menu theo vai trò
    document.body.classList.toggle('is-admin', isAdmin);
    document.body.classList.toggle('is-member', isFixed);
    document.body.classList.toggle('is-guest', isGuest);

    // Phần tử "admin-only" có data-perm: người giữ vai trò tùy chỉnh có quyền tương ứng cũng được thấy
    const heldPerms = isAdmin ? [] : AppStorage.perms();
    document.querySelectorAll('.admin-only').forEach(el => {
      const need = el.getAttribute('data-perm');
      const granted = !isAdmin && need && (need === 'any' ? heldPerms.length > 0 : heldPerms.includes(need));
      if (granted) {
        el.style.setProperty('display', el.classList.contains('nav-link') ? 'flex' : (el.tagName === 'DIV' ? 'block' : 'inline-flex'), 'important');
      } else {
        el.style.removeProperty('display');
        el.style.display = isAdmin ? '' : 'none';
      }
    });
    document.querySelectorAll('.member-fixed-only').forEach(el => {
      el.style.display = isFixed ? '' : 'none';
    });
    document.querySelectorAll('.guest-only').forEach(el => {
      el.style.display = isGuest ? '' : 'none';
    });

    if (navMembersLabel) {
      navMembersLabel.innerText = isAdmin ? 'Quản lý thành viên' : (isGuest ? 'Nội quy & Quyền lợi' : 'Danh bạ thành viên');
    }
    if (mobileMembersLabel) {
      mobileMembersLabel.innerText = isAdmin ? 'QL Thành viên' : (isGuest ? 'Nội quy CLB' : 'Danh bạ');
    }

    const tabMembersTitle = document.querySelector('#tab-members .tab-main-title');
    const tabMembersSubtitle = document.querySelector('#tab-members .tab-main-subtitle');
    if (tabMembersTitle) {
      tabMembersTitle.innerHTML = isAdmin ? '<i class="fas fa-users-cog text-primary"></i> Quản lý thành viên CLB' : (isGuest ? '<i class="fas fa-id-card text-primary"></i> Nội quy & Đăng ký gia nhập CLB' : '<i class="fas fa-address-book text-primary"></i> Danh bạ thành viên CLB');
    }
    if (tabMembersSubtitle) {
      tabMembersSubtitle.innerHTML = isAdmin ? '<i class="fas fa-id-badge text-primary"></i> Thêm mới, chỉnh sửa, xóa, phân quyền và quản lý tài khoản thành viên.' : (isGuest ? '<i class="fas fa-info-circle text-primary"></i> Tìm hiểu quyền lợi, nội quy sinh hoạt và gửi đơn đăng ký tham gia.' : '<i class="fas fa-user-shield text-primary"></i> Danh sách thành viên chính thức & khách giao lưu tại CLB Smash Pro.');
    }

    if (!currentUser) {
      // 1. Chế độ Khách vãng lai (Guest Mode - Chưa đăng nhập)
      if (sidebarUserCard) sidebarUserCard.style.display = 'none';

      if (userAvatarEl) userAvatarEl.src = 'https://ui-avatars.com/api/?name=Khach&background=64748b&color=fff';
      if (userNameEl) userNameEl.innerText = 'Khách vãng lai';
      if (userRoleBadgeEl) {
        userRoleBadgeEl.innerText = 'Chưa đăng nhập';
        userRoleBadgeEl.className = 'badge badge-neutral';
      }

      if (headerBtnWrapper) {
        // Thanh đầu trang (chỉ hiện khi thanh bên là ngăn kéo): đúng MỘT nút chính; đăng ký nằm trong hộp thoại
        headerBtnWrapper.innerHTML = `
          <button class="btn btn-primary btn-sm auth-pill" onclick="App.showAuthModal('login'); event.stopPropagation();" title="Đăng nhập hoặc tạo tài khoản">
            <i class="fas fa-sign-in-alt"></i><span>Đăng nhập</span>
          </button>
        `;
      }

      if (sidebarBtnWrapper) {
        // Thanh bên: thẻ khách gọn, một nút chính + liên kết tạo tài khoản
        sidebarBtnWrapper.innerHTML = `
          <div class="guest-card">
            <div class="guest-card-text">
              <b>Chưa đăng nhập</b>
              <span>Đăng nhập để bình chọn, đóng quỹ và nhận thông báo.</span>
            </div>
            <button class="btn btn-primary btn-sm guest-card-btn" onclick="App.showAuthModal('login')"><i class="fas fa-sign-in-alt"></i> Đăng nhập</button>
            <button type="button" class="guest-card-link" onclick="App.showAuthModal('register')">Chưa có tài khoản? <b>Đăng ký</b></button>
          </div>
        `;
      }

      const headerEditDot = document.getElementById('header-user-edit-dot');
      if (headerEditDot) headerEditDot.style.display = 'none';
      return;
    }

    // 2. Chế độ Người dùng đã đăng nhập (Admin / Thủ quỹ / Thành viên cố định / Vãng lai)
    if (userAvatarEl) userAvatarEl.src = currentUser.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(currentUser.name)}&background=10b981&color=fff`;
    if (userNameEl) userNameEl.innerText = currentUser.name;

    if (userRoleBadgeEl) {
      userRoleBadgeEl.innerText = currentUser.role === 'admin' ? '👑 Admin / Chủ CLB' : currentUser.role === 'treasurer' ? '💼 Thủ quỹ CLB' : (currentUser.type === 'fixed' ? '🏸 Thành viên cố định' : '⚡ Khách vãng lai');
      userRoleBadgeEl.className = `badge ${currentUser.role === 'admin' ? 'badge-warning' : currentUser.role === 'treasurer' ? 'badge-info' : (currentUser.type === 'fixed' ? 'badge-paid' : 'badge-neutral')}`;
    }

    if (sidebarUserCard) {
      sidebarUserCard.style.display = 'block';
      if (sidebarAvatar) sidebarAvatar.src = currentUser.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(currentUser.name)}&background=10b981&color=fff`;
      if (sidebarName) sidebarName.innerText = currentUser.name;
      if (sidebarRole) {
        const customRole = AppStorage.getRole(currentUser.roleId);
        sidebarRole.innerText = currentUser.role === 'admin' ? '👑 Quản trị viên' : currentUser.role === 'treasurer' ? '💼 Thủ quỹ CLB' : customRole ? `🎖️ ${customRole.name}` : (currentUser.type === 'fixed' ? '🏸 Thành viên CLB' : '⚡ Khách vãng lai');
        sidebarRole.className = `badge ${currentUser.role === 'admin' ? 'badge-warning' : currentUser.role === 'treasurer' ? 'badge-info' : (currentUser.type === 'fixed' ? 'badge-paid' : 'badge-warning')}`;
      }
    }

    if (headerBtnWrapper) {
      headerBtnWrapper.innerHTML = '';
    }

    const headerEditDot = document.getElementById('header-user-edit-dot');
    if (headerEditDot) headerEditDot.style.display = 'flex';

    if (sidebarBtnWrapper) {
      sidebarBtnWrapper.innerHTML = `
        <button class="btn btn-secondary btn-sm w-full" style="justify-content: center;" onclick="App.logout()">
          <i class="fas fa-sign-out-alt"></i> Đăng xuất
        </button>
      `;
    }
  },

  renderUserRoleSelector() {
    this.renderUserHeaderAndSidebar();
  },

  // ==========================================
  // HỆ THỐNG AVATAR & CẬP NHẬT HỒ SƠ CÁ NHÂN
  // ==========================================

  // Bộ sưu tập Avatar thể thao cầu lông mẫu
  BADMINTON_AVATAR_PRESETS: [
    { url: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80", label: "Nữ hiện đại" },
    { url: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop&q=80", label: "Nam thể thao 1" },
    { url: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&auto=format&fit=crop&q=80", label: "Nam thể thao 2" },
    { url: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150&auto=format&fit=crop&q=80", label: "Nữ thể thao 1" },
    { url: "https://images.unsplash.com/photo-1522075469751-3a6694fb2f61?w=150&auto=format&fit=crop&q=80", label: "Nam trẻ trung" },
    { url: "https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=150&auto=format&fit=crop&q=80", label: "Nữ năng động" },
    { url: "https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=150&auto=format&fit=crop&q=80", label: "Nam phong cách" },
    { url: "https://images.unsplash.com/photo-1517841905240-472988babdf9?w=150&auto=format&fit=crop&q=80", label: "Nữ nụ cười" },
    { url: "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=150&auto=format&fit=crop&q=80", label: "Nam cá tính" },
    { url: "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=150&auto=format&fit=crop&q=80", label: "Nữ thanh lịch" },
    { url: "https://images.unsplash.com/photo-1501196354995-cbb51c65aaea?w=150&auto=format&fit=crop&q=80", label: "Nam năng động" },
    { url: "https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=150&auto=format&fit=crop&q=80", label: "Nữ thể thao 2" }
  ],

  // Kết xuất HTML bộ chọn ảnh đại diện trực quan (Avatar Picker)
  renderAvatarPickerHtml(prefix, initialAvatarUrl, initialName) {
    const defaultAvatar = initialAvatarUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(initialName || 'Member')}&background=10b981&color=fff`;
    return `
      <div class="avatar-picker-box" style="margin-bottom: 1.25rem;">
        <input type="hidden" id="${prefix}-avatar-val" value="${Safe.html(defaultAvatar)}">
        
        <!-- Preview lớn trung tâm -->
        <div class="flex items-center gap-4" style="margin-bottom: 1rem; padding-bottom: 0.85rem; border-bottom: 1px solid var(--border-color);">
          <div style="position: relative; flex-shrink: 0;">
            <img id="${prefix}-avatar-preview" class="avatar avatar-xl" src="${Safe.url(defaultAvatar)}" alt="Avatar Preview" style="border: 3px solid var(--primary); box-shadow: 0 4px 14px rgba(16, 185, 129, 0.25); object-fit: cover;">
            <span style="position: absolute; bottom: 0; right: 0; width: 22px; height: 22px; border-radius: 50%; background: var(--primary); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 10px; border: 2px solid var(--bg-card);"><i class="fas fa-camera"></i></span>
          </div>
          <div style="flex: 1; min-width: 0;">
            <div style="font-weight: 700; color: var(--text-main); font-size: 0.95rem;">Ảnh đại diện thành viên</div>
            <div style="font-size: 0.78rem; color: var(--text-secondary); margin-top: 0.15rem;">
              Chọn ảnh mẫu bên dưới, tải ảnh từ máy (tự động nén siêu nét) hoặc tạo theo tên.
            </div>
          </div>
        </div>

        <!-- Các tab tùy chọn -->
        <div class="segmented-control" style="margin-bottom: 0.85rem; display: flex; gap: 0.35rem; flex-wrap: wrap;">
          <button type="button" class="segmented-btn active" id="${prefix}-tab-btn-presets" onclick="App.switchAvatarSubTab('presets', '${prefix}')" style="font-size: 0.76rem; padding: 0.3rem 0.6rem;">
            <i class="fas fa-th"></i> Bộ sưu tập mẫu
          </button>
          <button type="button" class="segmented-btn" id="${prefix}-tab-btn-upload" onclick="App.switchAvatarSubTab('upload', '${prefix}')" style="font-size: 0.76rem; padding: 0.3rem 0.6rem;">
            <i class="fas fa-upload"></i> Tải ảnh từ máy
          </button>
          <button type="button" class="segmented-btn" id="${prefix}-tab-btn-initials" onclick="App.switchAvatarSubTab('initials', '${prefix}')" style="font-size: 0.76rem; padding: 0.3rem 0.6rem;">
            <i class="fas fa-font"></i> Tạo theo tên
          </button>
          <button type="button" class="segmented-btn" id="${prefix}-tab-btn-url" onclick="App.switchAvatarSubTab('url', '${prefix}')" style="font-size: 0.76rem; padding: 0.3rem 0.6rem;">
            <i class="fas fa-link"></i> Link URL
          </button>
        </div>

        <!-- 1. Bộ sưu tập mẫu -->
        <div id="${prefix}-subtab-presets" style="display: block;">
          <div class="avatar-preset-grid">
            ${this.BADMINTON_AVATAR_PRESETS.map((p) => `
              <img src="${p.url}" alt="${p.label}" title="${p.label}" class="avatar-preset-item ${p.url === defaultAvatar ? 'active' : ''}" onclick="App.selectPresetAvatar('${p.url}', '${prefix}', this)">
            `).join('')}
          </div>
        </div>

        <!-- 2. Tải ảnh lên từ máy tính/điện thoại -->
        <div id="${prefix}-subtab-upload" style="display: none; background: var(--bg-card); padding: 1rem; border-radius: var(--radius-md); border: 1px dashed var(--border-color); text-align: center;">
          <i class="fas fa-cloud-upload-alt text-primary" style="font-size: 2rem; margin-bottom: 0.5rem; display: block;"></i>
          <label class="btn btn-outline-primary btn-sm" style="cursor: pointer; display: inline-flex; align-items: center; gap: 0.4rem;">
            <i class="fas fa-folder-open"></i> <span>Chọn ảnh từ thiết bị...</span>
            <input type="file" accept="image/*" style="display: none;" onchange="App.handleAvatarFileChange(event, '${prefix}')">
          </label>
          <div style="font-size: 0.74rem; color: var(--text-muted); margin-top: 0.5rem;">Hỗ trợ JPG, PNG, WEBP. Hệ thống tự động tối ưu hoá ảnh sắc nét, nhẹ và nhanh.</div>
        </div>

        <!-- 3. Tự tạo avatar theo tên và bảng màu -->
        <div id="${prefix}-subtab-initials" style="display: none; background: var(--bg-card); padding: 0.85rem; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
          <div style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 0.5rem; font-weight: 600;">Chọn màu sắc cho Avatar chữ cái:</div>
          <div class="flex items-center gap-2 flex-wrap">
            <button type="button" class="btn btn-sm" onclick="App.generateInitialsAvatar('${prefix}', '10b981')" style="background: #10b981; color: #fff; border-radius: var(--radius-full); font-size: 0.72rem; padding: 0.25rem 0.6rem;">Xanh ngọc</button>
            <button type="button" class="btn btn-sm" onclick="App.generateInitialsAvatar('${prefix}', '3b82f6')" style="background: #3b82f6; color: #fff; border-radius: var(--radius-full); font-size: 0.72rem; padding: 0.25rem 0.6rem;">Xanh dương</button>
            <button type="button" class="btn btn-sm" onclick="App.generateInitialsAvatar('${prefix}', 'f59e0b')" style="background: #f59e0b; color: #fff; border-radius: var(--radius-full); font-size: 0.72rem; padding: 0.25rem 0.6rem;">Cam vàng</button>
            <button type="button" class="btn btn-sm" onclick="App.generateInitialsAvatar('${prefix}', '8b5cf6')" style="background: #8b5cf6; color: #fff; border-radius: var(--radius-full); font-size: 0.72rem; padding: 0.25rem 0.6rem;">Tím thể thao</button>
            <button type="button" class="btn btn-sm" onclick="App.generateInitialsAvatar('${prefix}', 'ef4444')" style="background: #ef4444; color: #fff; border-radius: var(--radius-full); font-size: 0.72rem; padding: 0.25rem 0.6rem;">Đỏ nhiệt huyết</button>
            <button type="button" class="btn btn-sm" onclick="App.generateInitialsAvatar('${prefix}', '0f172a')" style="background: #0f172a; color: #fff; border-radius: var(--radius-full); font-size: 0.72rem; padding: 0.25rem 0.6rem;">Đen huyền bí</button>
          </div>
        </div>

        <!-- 4. Nhập đường dẫn link ảnh -->
        <div id="${prefix}-subtab-url" style="display: none;">
          <div class="flex gap-2">
            <input type="url" id="${prefix}-avatar-url-input" class="form-control" placeholder="Dán đường dẫn link ảnh (https://...)" style="font-size: 0.82rem;">
            <button type="button" class="btn btn-secondary btn-sm" onclick="App.applyCustomAvatarUrl('${prefix}')" style="flex-shrink: 0;">Áp dụng</button>
          </div>
        </div>
      </div>
    `;
  },

  switchAvatarSubTab(subTab, prefix) {
    ['presets', 'upload', 'initials', 'url'].forEach(tab => {
      const btn = document.getElementById(`${prefix}-tab-btn-${tab}`);
      const panel = document.getElementById(`${prefix}-subtab-${tab}`);
      if (btn) {
        if (tab === subTab) btn.classList.add('active');
        else btn.classList.remove('active');
      }
      if (panel) {
        panel.style.display = (tab === subTab) ? 'block' : 'none';
      }
    });
  },

  selectPresetAvatar(url, prefix, clickedEl = null) {
    const preview = document.getElementById(`${prefix}-avatar-preview`);
    const valInput = document.getElementById(`${prefix}-avatar-val`);
    if (preview) preview.src = url;
    if (valInput) valInput.value = url;
    document.querySelectorAll(`#${prefix}-subtab-presets .avatar-preset-item`).forEach(el => el.classList.remove('active'));
    if (clickedEl) clickedEl.classList.add('active');
  },

  handleAvatarFileChange(e, prefix) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      this.showToast("Vui lòng chọn tệp hình ảnh hợp lệ (PNG, JPG, WEBP)!", "warning");
      return;
    }
    const reader = new FileReader();
    reader.onload = (evt) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_SIZE = 160;
        let w = img.width;
        let h = img.height;
        if (w > h) {
          if (w > MAX_SIZE) {
            h = Math.round(h * (MAX_SIZE / w));
            w = MAX_SIZE;
          }
        } else {
          if (h > MAX_SIZE) {
            w = Math.round(w * (MAX_SIZE / h));
            h = MAX_SIZE;
          }
        }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);

        const preview = document.getElementById(`${prefix}-avatar-preview`);
        const valInput = document.getElementById(`${prefix}-avatar-val`);
        if (preview) preview.src = dataUrl;
        if (valInput) valInput.value = dataUrl;
        this.showToast("Đã tải và xử lý ảnh đại diện thành công!", "success");
      };
      img.src = evt.target.result;
    };
    reader.readAsDataURL(file);
  },

  generateInitialsAvatar(prefix, colorHex) {
    let nameVal = '';
    const nameInput = document.getElementById(`${prefix}-name`) || document.getElementById('profile-name') || document.getElementById('edit-mem-name') || document.getElementById('add-mem-name');
    if (nameInput) nameVal = nameInput.value.trim();
    if (!nameVal) {
      const u = AppStorage.getCurrentUser();
      if (u) nameVal = u.name;
    }
    if (!nameVal) nameVal = 'Member';

    const avatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(nameVal)}&background=${colorHex}&color=fff&size=160&bold=true`;
    const preview = document.getElementById(`${prefix}-avatar-preview`);
    const valInput = document.getElementById(`${prefix}-avatar-val`);
    if (preview) preview.src = avatarUrl;
    if (valInput) valInput.value = avatarUrl;
  },

  applyCustomAvatarUrl(prefix) {
    const input = document.getElementById(`${prefix}-avatar-url-input`);
    const url = (input?.value || '').trim();
    if (!url) {
      this.showToast("Vui lòng dán đường dẫn link ảnh hợp lệ!", "warning");
      return;
    }
    const preview = document.getElementById(`${prefix}-avatar-preview`);
    const valInput = document.getElementById(`${prefix}-avatar-val`);
    if (preview) preview.src = url;
    if (valInput) valInput.value = url;
    this.showToast("Đã áp dụng link ảnh mới!", "success");
  },

  handleHeaderUserClick() {
    if (!AppStorage.isLoggedIn()) {
      this.showAuthModal('login');
    } else {
      this.openUserProfileModal();
    }
  },

  openUserProfileModal() {
    const user = AppStorage.getCurrentUser();
    if (!user) {
      this.showAuthModal('login');
      return;
    }

    const data = AppStorage.loadData();
    const member = (data.members || []).find(m => m.id === user.memberId || (m.username && m.username === user.username) || (m.phone && user.phone && m.phone.replace(/\D/g, '') === user.phone.replace(/\D/g, ''))) || {};

    const avatarHtml = this.renderAvatarPickerHtml('profile', user.avatar, user.name);
    const roleBadgeText = user.role === 'admin' ? '👑 Quản trị viên CLB' : user.role === 'treasurer' ? '💼 Thủ quỹ CLB' : '🏸 Thành viên CLB';

    const modalBody = `
      <form onsubmit="App.saveUserProfile(event)">
        <!-- Header Info Banner -->
        <div style="background: var(--bg-input); padding: 0.85rem 1rem; border-radius: var(--radius-md); border: 1px solid var(--border-color); margin-bottom: 1.25rem; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem;">
          <div>
            <div style="font-size: 0.78rem; color: var(--text-secondary);">Tài khoản đăng nhập:</div>
            <div class="font-mono font-bold" style="font-size: 0.95rem; color: var(--text-main);">${Safe.html(user.username)}</div>
          </div>
          <div class="flex items-center gap-1">
            <span class="badge ${user.role === 'admin' ? 'badge-warning' : user.role === 'treasurer' ? 'badge-info' : 'badge-paid'}" style="font-size: 0.72rem; padding: 0.2rem 0.55rem;">
              ${roleBadgeText}
            </span>
          </div>
        </div>

        <!-- 1. Bộ chọn và Đổi ảnh đại diện -->
        ${avatarHtml}

        <!-- 2. Thông tin cá nhân -->
        <div class="form-group">
          <label class="form-label font-bold">Họ và tên *</label>
          <input type="text" id="profile-name" class="form-control" value="${Safe.html(user.name || '')}" placeholder="Nhập họ và tên đầy đủ..." required>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
          <div class="form-group">
            <label class="form-label font-bold">Số điện thoại / Zalo *</label>
            <input type="tel" id="profile-phone" class="form-control" value="${Safe.html(user.phone || '')}" placeholder="Ví dụ: 0912345678" required>
          </div>
          <div class="form-group">
            <label class="form-label">Email liên hệ (tùy chọn)</label>
            <input type="email" id="profile-email" class="form-control" value="${Safe.html(user.email || member.email || '')}" placeholder="email@domain.com">
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Giới thiệu / Trình độ / Ghi chú</label>
          <input type="text" id="profile-note" class="form-control" value="${Safe.html(user.note || member.note || '')}" placeholder="Ví dụ: Trình độ trung bình khá, thuận tay phải, chuyên đánh đôi...">
        </div>

        ${window.GoogleAuth ? GoogleAuth.renderProfileSection(user) : ''}
        ${window.PushClient ? PushClient.renderProfileSection(user) : ''}
        ${this.renderSessionSection()}

        <!-- 3. Khu vực Đổi mật khẩu -->
        <div style="background: var(--bg-input); padding: 1rem; border-radius: var(--radius-md); border: 1px solid var(--border-color); margin-top: 1rem;">
          <div style="font-weight: 700; color: var(--text-main); font-size: 0.88rem; margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.4rem;">
            <i class="fas fa-shield-alt text-primary"></i> Đổi mật khẩu tài khoản
          </div>
          <div style="font-size: 0.76rem; color: var(--text-secondary); margin-bottom: 0.75rem;">
            Chỉ điền vào các ô dưới đây nếu bạn muốn thay đổi mật khẩu đăng nhập.
          </div>

          <div class="form-group" style="margin-bottom: 0.65rem;">
            <label class="form-label" style="font-size: 0.8rem;">Mật khẩu hiện tại</label>
            <input type="password" id="profile-current-pwd" class="form-control" placeholder="Nhập mật khẩu hiện tại nếu muốn đổi mật khẩu...">
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem;">
            <div class="form-group" style="margin-bottom: 0;">
              <label class="form-label" style="font-size: 0.8rem;">Mật khẩu mới (≥ 8 ký tự)</label>
              <input type="password" id="profile-new-pwd" class="form-control" placeholder="Mật khẩu mới...">
            </div>
            <div class="form-group" style="margin-bottom: 0;">
              <label class="form-label" style="font-size: 0.8rem;">Xác nhận mật khẩu mới</label>
              <input type="password" id="profile-confirm-pwd" class="form-control" placeholder="Nhập lại mật khẩu mới...">
            </div>
          </div>
        </div>

        <div class="modal-footer" style="padding: 1.25rem 0 0 0; display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; flex-wrap: wrap;">
          <button type="button" class="btn btn-outline-danger" onclick="App.closeModal(); App.logout();" title="Đăng xuất khỏi tài khoản này">
            <i class="fas fa-sign-out-alt"></i> Đăng xuất
          </button>
          <div class="flex items-center gap-2">
            <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Hủy</button>
            <button type="submit" class="btn btn-primary"><i class="fas fa-save"></i> Lưu thông tin & Avatar</button>
          </div>
        </div>
      </form>
    `;

    this.openModal("👤 Hồ sơ cá nhân & Đổi ảnh đại diện", modalBody);
    if (window.GoogleAuth && !user.googleLinked) GoogleAuth.renderButtons(['google-link-btn'], 'link', 'signin_with');
    if (user.googleOnly) {
      // Tài khoản tạo bằng Google: đặt mật khẩu lần đầu, không có mật khẩu cũ
      const cur = document.getElementById('profile-current-pwd');
      if (cur) cur.closest('.form-group').style.display = 'none';
    }
  },

  // Sau khi đăng nhập thành công (mật khẩu hoặc Google)
  onLoginSuccess(result) {
    this.wasLoggedIn = true;
    this.applyUserTheme(result.user);
    this.closeAuthModal();
    this.renderUserHeaderAndSidebar();
    this.refreshDashboardStats();
    this.openTab('dashboard');
    this.showToast(result.message, result.mustChange ? "warning" : "success");
  },

  async saveUserProfile(e) {
    if (e && e.preventDefault) e.preventDefault();
    const user = AppStorage.getCurrentUser();
    if (!user) return;

    const name = (document.getElementById('profile-name')?.value || '').trim();
    const phone = (document.getElementById('profile-phone')?.value || '').trim();
    const email = (document.getElementById('profile-email')?.value || '').trim();
    const note = (document.getElementById('profile-note')?.value || '').trim();
    const avatar = document.getElementById('profile-avatar-val')?.value || user.avatar;

    const currentPassword = document.getElementById('profile-current-pwd')?.value || '';
    const newPassword = document.getElementById('profile-new-pwd')?.value || '';
    const confirmPassword = document.getElementById('profile-confirm-pwd')?.value || '';

    const res = await AppStorage.updateUserProfile({
      userId: user.id,
      name,
      phone,
      email,
      avatar,
      note,
      currentPassword,
      newPassword,
      confirmPassword
    });

    if (!res.success) {
      this.showToast(res.message, "error");
      return;
    }

    this.closeModal();
    this.showToast(`🎉 ${res.message}`, "success");
    this.renderUserHeaderAndSidebar();
    this.refreshDashboardStats();
    if (window.MembersModule) MembersModule.renderMembersTab();
    if (window.ScheduleModule) {
      if (ScheduleModule.currentViewMode === 'calendar') ScheduleModule.renderMonthCalendar();
      else ScheduleModule.renderSessions("sessions-container", ScheduleModule.currentFilter || 'upcoming');
    }
  },

  // Khung "Phiên đăng nhập" trong Hồ sơ: cho biết phiên được duy trì tới khi nào và cho phép thu hồi các thiết bị khác
  renderSessionSection() {
    const info = AppStorage.sessionInfo();
    if (!info || AppStorage.isLocalOnly()) return '';
    const until = info.expiresAt ? new Date(info.expiresAt).toLocaleDateString('vi-VN') : '';
    return `
        <div style="background: var(--bg-input); padding: 1rem; border-radius: var(--radius-md); border: 1px solid var(--border-color); margin-top: 1rem;">
          <div style="font-weight: 700; font-size: 0.88rem; margin-bottom: 0.35rem;"><i class="fas fa-laptop text-primary"></i> Phiên đăng nhập</div>
          <div class="text-secondary" style="font-size: 0.78rem; margin-bottom: 0.6rem;">
            ${info.remember ? `Thiết bị này được duy trì đăng nhập${until ? ` (gia hạn tự động khi bạn dùng ứng dụng, hiện đến ${Safe.html(until)})` : ''}.` : 'Thiết bị này tự đăng xuất khi đóng trình duyệt hoặc sau 30 phút không thao tác.'}
            Mất máy hoặc nghi ngờ lộ tài khoản? Thu hồi các thiết bị khác ngay.
          </div>
          <button type="button" class="btn btn-secondary btn-sm" onclick="App.logoutOtherDevices()"><i class="fas fa-sign-out-alt"></i> Đăng xuất các thiết bị khác</button>
        </div>`;
  },

  async logoutOtherDevices() {
    if (!(await this.confirm('Đăng xuất tài khoản này khỏi mọi thiết bị khác? Thiết bị hiện tại vẫn giữ đăng nhập.', { title: 'Đăng xuất thiết bị khác', okText: 'Đăng xuất' }))) return;
    const res = await AppStorage.logoutOtherDevices();
    this.showToast(res.message, res.success ? 'success' : 'error');
  },

  // Modal dùng chung
  openModal(title, contentHtml, isLarge = false) {
    const overlay = document.getElementById('global-modal-overlay');
    const titleEl = document.getElementById('global-modal-title');
    const bodyEl = document.getElementById('global-modal-body');
    const dialogEl = document.getElementById('global-modal-dialog');

    if (titleEl) titleEl.innerHTML = title;
    if (bodyEl) bodyEl.innerHTML = contentHtml;
    if (dialogEl) {
      if (isLarge) dialogEl.classList.add('modal-lg');
      else dialogEl.classList.remove('modal-lg');
    }
    if (overlay) {
      this._modalReturnFocus = document.activeElement;
      if (!this._escBound) {
        this._escBound = true;
        document.addEventListener('keydown', (e) => {
          const ov = document.getElementById('global-modal-overlay');
          if (e.key === 'Escape' && ov && ov.classList.contains('active') && !document.querySelector('.app-dialog')) App.closeModal();
        });
      }
      overlay.classList.add('active');
      // Trợ năng: đưa tiêu điểm vào hộp thoại để bàn phím/trình đọc màn hình dùng được
      const first = overlay.querySelector('input:not([type=hidden]), select, textarea, button.btn-primary, button.btn');
      if (first && typeof first.focus === 'function') setTimeout(() => first.focus({ preventScroll: true }), 30);
    }
  },

  closeModal() {
    const overlay = document.getElementById('global-modal-overlay');
    if (overlay) overlay.classList.remove('active');
    const back = this._modalReturnFocus;
    this._modalReturnFocus = null;
    if (back && document.contains(back) && typeof back.focus === 'function') back.focus({ preventScroll: true });
  },

  // Hộp thoại xác nhận của ứng dụng (thay confirm() của trình duyệt). Trả về Promise<boolean>.
  confirm(message, opts = {}) {
    return new Promise((resolve) => {
      const danger = opts.danger !== undefined ? !!opts.danger : /xóa|đặt lại|reset|hủy liên kết/i.test(String(message));
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay active app-dialog';
      overlay.style.zIndex = '10000';
      overlay.setAttribute('role', 'alertdialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', opts.title || 'Xác nhận');
      overlay.innerHTML = `
        <div class="modal-dialog" style="max-width: 440px;">
          <div class="modal-header"><h3 class="modal-title">${Safe.html(opts.title || (danger ? 'Xác nhận thao tác' : 'Xác nhận'))}</h3></div>
          <div class="modal-body">
            <div style="white-space: pre-line; line-height: 1.55; margin-bottom: 1.1rem;">${Safe.html(String(message))}</div>
            <div class="flex gap-2" style="justify-content: flex-end;">
              <button type="button" class="btn btn-secondary" data-act="no">${Safe.html(opts.cancelText || 'Hủy')}</button>
              <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="yes">${Safe.html(opts.okText || 'Đồng ý')}</button>
            </div>
          </div>
        </div>`;
      const previous = document.activeElement;
      const done = (val) => {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        if (previous && document.contains(previous) && previous.focus) previous.focus({ preventScroll: true });
        resolve(val);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); done(false); }
        else if (e.key === 'Tab') {
          const btns = overlay.querySelectorAll('button');
          const first = btns[0], last = btns[btns.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      };
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) return done(false);
        const act = e.target.closest && e.target.closest('[data-act]');
        if (act) done(act.getAttribute('data-act') === 'yes');
      });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(overlay);
      const okBtn = overlay.querySelector('[data-act=yes]');
      (danger ? overlay.querySelector('[data-act=no]') : okBtn).focus();
    });
  },

  // Hiển thị văn bản để sao chép (thay prompt() của trình duyệt)
  showText(title, text) {
    const id = 'show-text-area';
    this.openModal(Safe.html(String(title || 'Sao chép')), `
      <textarea id="${id}" class="form-control" rows="8" readonly style="width: 100%; font-size: 0.85rem;">${Safe.html(String(text || ''))}</textarea>
      <div class="flex gap-2" style="justify-content: flex-end; margin-top: 0.75rem;">
        <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Đóng</button>
        <button type="button" class="btn btn-primary" onclick="App.copyShownText()"><i class="fas fa-copy"></i> Sao chép</button>
      </div>`);
    setTimeout(() => { const el = document.getElementById(id); if (el) el.select(); }, 40);
  },

  async copyShownText() {
    const el = document.getElementById('show-text-area');
    if (!el) return;
    try {
      await navigator.clipboard.writeText(el.value);
    } catch (e) {
      el.select();
      try { document.execCommand('copy'); } catch (e2) { /* người dùng tự sao chép */ }
    }
    this.showToast('Đã sao chép.', 'success');
  },

  // Toast Notifications
  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let iconClass = 'fa-info-circle text-primary';
    if (type === 'success') iconClass = 'fa-check-circle text-primary';
    if (type === 'error') iconClass = 'fa-times-circle text-danger';
    if (type === 'warning') iconClass = 'fa-exclamation-triangle text-warning';

    toast.innerHTML = `
      <i class="fas ${iconClass}" style="font-size: 1.25rem; margin-top: 0.1rem; flex-shrink: 0;"></i>
      <div style="flex: 1; font-size: 0.92rem; font-weight: 500; color: var(--text-main); line-height: 1.45;">${Safe.html(message)}</div>
      <button style="background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 1.15rem; padding: 0 0.25rem; line-height: 1;" onclick="this.parentElement.remove()" title="Đóng">&times;</button>
    `;

    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      setTimeout(() => toast.remove(), 300);
    }, 4500);
  }
};

// Khởi chạy ứng dụng
// Trợ năng: bổ sung nhãn cho nút chỉ có biểu tượng và cho thành phần bấm được nhưng không phải <button>
const A11y = {
  _timer: null,
  enhance(root = document.body) {
    root.querySelectorAll('button:not([aria-label]), a[onclick]:not([aria-label]), a[href]:not([aria-label])').forEach((el) => {
      if ((el.textContent || '').trim()) return;
      const label = el.getAttribute('title') || el.getAttribute('data-tooltip');
      if (label) el.setAttribute('aria-label', label);
    });
    root.querySelectorAll('[onclick]:not(button):not(a):not(input):not(select):not(textarea):not([role])').forEach((el) => {
      el.setAttribute('role', 'button');
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    });
    root.querySelectorAll('input:not([aria-label]):not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea:not([aria-label])').forEach((el) => {
      if (el.id && document.querySelector(`label[for="${el.id}"]`)) return;
      if (el.closest('label')) return;
      const label = el.getAttribute('placeholder') || el.getAttribute('title');
      if (label) el.setAttribute('aria-label', label);
    });
  },
  init() {
    document.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.getAttribute && e.target.getAttribute('role') === 'button' && !['BUTTON', 'A', 'INPUT'].includes(e.target.tagName)) {
        e.preventDefault();
        e.target.click();
      }
    });
    const run = () => { clearTimeout(this._timer); this._timer = setTimeout(() => this.enhance(), 150); };
    new MutationObserver(run).observe(document.body, { childList: true, subtree: true });
    this.enhance();
  }
};
window.A11y = A11y;

document.addEventListener('DOMContentLoaded', () => {
  A11y.init();
  App.init();
});

window.App = App;
;
