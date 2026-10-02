// SyncCore - Hợp nhất dữ liệu theo từng bản ghi (Per-record LWW + Tombstones)
// LƯU Ý: Mã này được sao chép NGUYÊN VẸN vào resources/inputs/google_apps_script_prod.js
// (Apps Script không import được). Sửa ở đây thì phải sửa cả bên đó.
var SyncCore = (function () {
  var COLLECTIONS = ['members', 'users', 'sessions', 'transactions', 'monthlyContributions', 'inventory'];
  var TOMBSTONE_TTL = 90 * 24 * 60 * 60 * 1000; // Giữ dấu xóa 90 ngày

  function keyOf(col, rec) {
    if (!rec) return null;
    if (col === 'users') return rec.username || rec.id || null;
    if (col === 'monthlyContributions') return rec.id || (rec.memberId ? rec.month + '_' + rec.memberId : null);
    return rec.id || null;
  }

  function tsOf(rec) {
    return Number(rec && rec.updatedAt) || 0;
  }

  function voteTs(v) {
    if (!v) return 0;
    if (v.updatedAt) return Number(v.updatedAt) || 0;
    var parsed = v.votedAt ? Date.parse(String(v.votedAt).replace(' ', 'T')) : NaN;
    return isNaN(parsed) ? 0 : parsed;
  }

  // So sánh nội dung bản ghi, bỏ qua dấu thời gian
  function sameContent(a, b) {
    var ca = {}, cb = {}, k;
    for (k in a) if (k !== 'updatedAt') ca[k] = a[k];
    for (k in b) if (k !== 'updatedAt') cb[k] = b[k];
    return JSON.stringify(ca) === JSON.stringify(cb);
  }

  function indexBy(col, list) {
    var map = {};
    (Array.isArray(list) ? list : []).forEach(function (r) {
      var k = keyOf(col, r);
      if (k) map[k] = r;
    });
    return map;
  }

  // Gắn updatedAt cho bản ghi thay đổi và tạo tombstone cho bản ghi bị xóa (so với trạng thái trước khi lưu)
  function stampChanges(prev, next, now) {
    if (!next) return next;
    now = now || Date.now();
    next.tombstones = Object.assign({}, (prev && prev.tombstones) || {}, next.tombstones || {});
    if (!prev) return next;

    COLLECTIONS.forEach(function (col) {
      var prevMap = indexBy(col, prev[col]);
      var nextMap = indexBy(col, next[col]);

      Object.keys(nextMap).forEach(function (k) {
        var rec = nextMap[k];
        var old = prevMap[k];
        if (!old || !sameContent(old, rec)) rec.updatedAt = now;
        else if (old.updatedAt && !rec.updatedAt) rec.updatedAt = old.updatedAt;

        // Tạo lại bản ghi có cùng ID -> gỡ tombstone cũ
        if (!old && next.tombstones[col + ':' + k]) delete next.tombstones[col + ':' + k];

        if (col === 'sessions') stampVotes(k, old, rec, next.tombstones, now);
      });

      Object.keys(prevMap).forEach(function (k) {
        if (!nextMap[k]) next.tombstones[col + ':' + k] = now;
      });
    });

    if (JSON.stringify(prev.clubInfo || null) !== JSON.stringify(next.clubInfo || null)) {
      next.clubInfoUpdatedAt = now;
    } else if (prev.clubInfoUpdatedAt && !next.clubInfoUpdatedAt) {
      next.clubInfoUpdatedAt = prev.clubInfoUpdatedAt;
    }
    return next;
  }

  function stampVotes(sessionId, oldSession, session, tombstones, now) {
    var oldVotes = {}, newVotes = {};
    ((oldSession && oldSession.votes) || []).forEach(function (v) { if (v && v.memberId) oldVotes[v.memberId] = v; });
    (session.votes || []).forEach(function (v) { if (v && v.memberId) newVotes[v.memberId] = v; });

    Object.keys(newVotes).forEach(function (mid) {
      var v = newVotes[mid], o = oldVotes[mid];
      if (!o || !sameContent(o, v)) v.updatedAt = now;
      else if (o.updatedAt && !v.updatedAt) v.updatedAt = o.updatedAt;
      if (!o) delete tombstones['vote:' + sessionId + ':' + mid];
    });
    Object.keys(oldVotes).forEach(function (mid) {
      if (!newVotes[mid]) tombstones['vote:' + sessionId + ':' + mid] = now;
    });
  }

  function mergeTombstones(a, b, now) {
    var out = {};
    [a || {}, b || {}].forEach(function (t) {
      Object.keys(t).forEach(function (k) {
        var v = Number(t[k]) || 0;
        if (v > (out[k] || 0)) out[k] = v;
      });
    });
    Object.keys(out).forEach(function (k) {
      if (now - out[k] > TOMBSTONE_TTL) delete out[k];
    });
    return out;
  }

  function isDeleted(tombstones, tKey, recTs) {
    var t = tombstones[tKey];
    return t !== undefined && t >= recTs;
  }

  function mergeVotes(sessionId, a, b, tombstones) {
    var map = {};
    (a || []).concat(b || []).forEach(function (v) {
      if (!v || !v.memberId) return;
      var prev = map[v.memberId];
      if (!prev || voteTs(v) >= voteTs(prev)) map[v.memberId] = v;
    });
    return Object.keys(map)
      .filter(function (mid) { return !isDeleted(tombstones, 'vote:' + sessionId + ':' + mid, voteTs(map[mid])); })
      .map(function (mid) { return map[mid]; });
  }

  function mergeHistory(a, b) {
    var seen = {}, out = [];
    (a || []).concat(b || []).forEach(function (h) {
      if (!h) return;
      var k = h.id || (h.memberId + '_' + h.votedAt + '_' + (h.actionText || h.status));
      if (!seen[k]) { seen[k] = true; out.push(h); }
    });
    return out;
  }

  // Hợp nhất 2 bản CSDL. Khi hòa thời gian, ưu tiên `incoming`.
  function mergeData(base, incoming, now) {
    now = now || Date.now();
    if (!base) return incoming;
    if (!incoming) return base;

    var out = {};
    var k;
    for (k in base) out[k] = base[k];
    for (k in incoming) out[k] = incoming[k];

    var tombstones = mergeTombstones(base.tombstones, incoming.tombstones, now);
    out.tombstones = tombstones;

    // Sau lần Đặt lại/Phục hồi (resetEpoch), bỏ mọi bản ghi cũ hơn mốc đó từ máy chưa cập nhật
    var resetEpoch = Math.max(Number(base.resetEpoch) || 0, Number(incoming.resetEpoch) || 0);
    if (resetEpoch) out.resetEpoch = resetEpoch;

    // Danh sách xóa kiểu cũ (giữ tương thích)
    var delMembers = {}, delUsers = {};
    (base.deletedMemberIds || []).concat(incoming.deletedMemberIds || []).forEach(function (id) { delMembers[id] = true; });
    (base.deletedUserIds || []).concat(incoming.deletedUserIds || []).forEach(function (id) { delUsers[id] = true; });
    out.deletedMemberIds = Object.keys(delMembers);
    out.deletedUserIds = Object.keys(delUsers);

    COLLECTIONS.forEach(function (col) {
      var aMap = indexBy(col, base[col]);
      var bMap = indexBy(col, incoming[col]);
      var keys = {};
      Object.keys(aMap).forEach(function (x) { keys[x] = true; });
      Object.keys(bMap).forEach(function (x) { keys[x] = true; });

      var result = [];
      Object.keys(keys).forEach(function (key) {
        var a = aMap[key], b = bMap[key];
        var winner = !a ? b : !b ? a : (tsOf(a) > tsOf(b) ? a : b);
        if (isDeleted(tombstones, col + ':' + key, tsOf(winner))) return;
        if (resetEpoch && tsOf(winner) < resetEpoch) return;

        if (col === 'members' && (delMembers[winner.id] || (winner.username && delUsers[winner.username]))) return;
        if (col === 'users' && (delUsers[winner.id] || delUsers[winner.username] || (winner.memberId && delMembers[winner.memberId]))) return;

        if (col === 'sessions' && a && b) {
          var s = {};
          for (var f in winner) s[f] = winner[f];
          s.votes = mergeVotes(key, a.votes, b.votes, tombstones);
          s.voteHistory = mergeHistory(a.voteHistory, b.voteHistory);
          winner = s;
        } else if (col === 'sessions') {
          var only = {};
          for (var g in winner) only[g] = winner[g];
          only.votes = mergeVotes(key, winner.votes, [], tombstones);
          winner = only;
        }
        result.push(winner);
      });
      out[col] = result;
    });

    var aClubTs = Number(base.clubInfoUpdatedAt) || 0;
    var bClubTs = Number(incoming.clubInfoUpdatedAt) || 0;
    if (resetEpoch) {
      if (aClubTs < resetEpoch && bClubTs >= resetEpoch) aClubTs = -1;
      if (bClubTs < resetEpoch && aClubTs >= resetEpoch) bClubTs = -1;
    }
    out.clubInfo = aClubTs > bClubTs ? base.clubInfo : (incoming.clubInfo || base.clubInfo);
    out.clubInfoUpdatedAt = Math.max(aClubTs, bClubTs);

    out.lastModified = Math.max(Number(base.lastModified) || 0, Number(incoming.lastModified) || 0);
    return out;
  }

  return {
    COLLECTIONS: COLLECTIONS,
    stampChanges: stampChanges,
    mergeData: mergeData
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SyncCore;
