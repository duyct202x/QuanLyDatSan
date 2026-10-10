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

  remove(scheduleId) {
    if (!confirm('Xóa lịch bình chọn tự động này? Các buổi đã tạo vẫn được giữ nguyên.')) return;
    if (this._update(scheduleId, (s, list) => list.filter((x) => x.id !== scheduleId))) App.showToast('🗑️ Đã xóa lịch', 'success');
  }
};

window.AutoScheduleModule = AutoScheduleModule;
