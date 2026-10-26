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
