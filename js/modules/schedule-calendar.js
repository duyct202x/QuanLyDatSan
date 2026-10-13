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
    const counts = { upcoming: upcomingN, past: sessions.length - upcomingN, all: sessions.length };
    const baseLabels = { upcoming: 'Sắp diễn ra', past: 'Đã kết thúc', all: 'Tất cả' };
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
