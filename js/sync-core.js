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

if (typeof module !== 'undefined' && module.exports) module.exports = SyncCore;
