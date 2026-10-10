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
    if (!AppStorage.isAdmin() || !session || session.status === 'completed' || session.status === 'cancelled') return '';
    const st = this.getOpenState(session);
    const sub = !st.scheduled ? 'Đang mở ngay' : st.isOpen ? `Đã mở lúc ${st.label}` : `Mở lúc ${st.label}`;
    return `
            <button class="session-status-btn" onclick="VoteScheduler.openScheduleModal(${Safe.js(session.id)})">
              <i class="fas fa-stopwatch"></i>
              <span>Hẹn giờ mở vote</span>
              <small>${Safe.html(sub)}</small>
            </button>`;
  },

  openScheduleModal(sessionId) {
    if (!AppStorage.isAdmin()) {
      App.showToast('Chỉ Ban quản trị mới có quyền hẹn giờ mở bình chọn!', 'warning');
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
          <button type="submit" class="btn btn-primary"><i class="fas fa-stopwatch"></i> Lưu hẹn giờ</button>
        </div>
      </form>
    `;
    App.openModal('⏰ Hẹn giờ mở bình chọn', body);
  },

  saveSchedule(e, sessionId) {
    if (e && e.preventDefault) e.preventDefault();
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
