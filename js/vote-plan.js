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
