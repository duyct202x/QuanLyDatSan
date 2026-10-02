// Court Booking & Schedule Module with Monthly Calendar, Hover Preview Popover & Multi-Option Polls

const ScheduleModule = {
  currentViewMode: 'calendar', // 'calendar' | 'cards'
  currentFilter: 'upcoming',
  calYear: 2026,
  calMonth: 8, // 0-indexed: 8 = September (Tháng 9)
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

    if (this.currentViewMode === 'calendar') {
      this.renderMonthCalendar();
    } else {
      this.renderSessions('sessions-container', this.currentFilter || 'upcoming');
    }

    this.renderSessions('schedule-upcoming-list', this.currentFilter || 'upcoming');
  },

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

  // Update schedule high-level overview stats
  updateScheduleOverviewStats(sessions = []) {
    const monthCountEl = document.getElementById('sched-stat-month-count');
    const monthLabelEl = document.getElementById('sched-stat-month-label');
    const openVotesEl = document.getElementById('sched-stat-open-votes');
    const nextTitleEl = document.getElementById('sched-stat-next-title');
    const nextDescEl = document.getElementById('sched-stat-next-desc');

    const year = this.calYear || new Date().getFullYear();
    const month = this.calMonth !== undefined ? this.calMonth : new Date().getMonth();
    const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`;

    if (monthLabelEl) monthLabelEl.innerText = `Tháng ${month + 1} / ${year}`;

    // Filter sessions in current viewing month
    const thisMonthSessions = sessions.filter(s => s.date && s.date.startsWith(monthPrefix));
    if (monthCountEl) monthCountEl.innerText = `${thisMonthSessions.length} trận`;

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

  switchViewMode(mode) {
    this.currentViewMode = mode;
    document.querySelectorAll('.view-mode-btn').forEach(btn => {
      if (btn.getAttribute('data-view') === mode) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

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
             data-session-id="${session.id}"
             onclick="event.stopPropagation(); ScheduleModule.openSessionDetailsModal('${session.id}')"
             onmouseenter="ScheduleModule.showHoverPreview(event, '${session.id}')"
             onmouseleave="ScheduleModule.hideHoverPreview()"
             onmousemove="ScheduleModule.updatePopoverPos(event)"
             title="${session.title} (${session.startTime} - ${session.endTime})">
          
          <!-- Desktop View: Compact 3-Row Micro-card -->
          <div class="chip-desktop-view">
            <div class="chip-time-row">
              <span class="chip-time"><i class="far fa-clock"></i> ${session.startTime}</span>
              <div class="chip-badges-group">
                ${isMultiPoll ? `<span class="chip-tag chip-tag-poll" title="Khảo sát chọn sân & giờ">🗳️ Vote</span>` : ''}
                <span class="chip-tag ${isGuestType ? 'chip-tag-guest' : 'chip-tag-fixed'}" title="${isGuestType ? 'Giao lưu vãng lai' : 'Lịch cố định (trừ quỹ)'}">
                  ${isGuestType ? '⚡ VL' : '🏸 CĐ'}
                </span>
              </div>
            </div>
            <div class="chip-title-text" title="${session.title}">
              ${session.title}
            </div>
            <div class="chip-meta-row">
              <span class="chip-court-name" title="${shortCourt}"><i class="fas fa-map-marker-alt"></i> ${shortCourt}</span>
              <span class="chip-voters-pill"><i class="fas fa-users"></i> ${totalGoing}/${session.maxPlayers}</span>
            </div>
          </div>

          <!-- Mobile View: Ultra-compact Micro-pill (< 768px) -->
          <div class="chip-mobile-view">
            <span class="chip-m-time">${session.startTime}</span>
            <span class="chip-m-voters">👥 ${totalGoing}/${session.maxPlayers}</span>
          </div>
        </div>
      `;
    }).join('');
  },

  // ==========================================
  // MONTHLY CALENDAR RENDERER
  // ==========================================
  renderMonthCalendar() {
    try {
      this.createPopoverElement();
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
              <button class="day-add-btn" onclick="event.stopPropagation(); ScheduleModule.openAddSessionForDate('${dateKey}')" title="Đặt lịch cho ngày này">
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
            <div class="popover-title">🗳️ ${session.title}</div>
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
            <span>Ngày dự kiến: <strong>${session.date}</strong></span>
          </div>
          <div class="popover-meta-item">
            <i class="fas fa-crown text-warning"></i>
            <span>Dẫn đầu: <strong>${topOption ? `${topOption.option.courtName} (${topOption.voteCount} phiếu)` : 'Chưa có phiếu'}</strong></span>
          </div>
          <div class="popover-meta-item">
            <i class="fas fa-hourglass-half"></i>
            <span>${lockInfo.countdownText}</span>
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
        return `<img class="avatar avatar-sm" src="${mem.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(mem.name)}&background=10b981&color=fff`}" alt="${mem.name}" style="width:24px;height:24px;" onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(mem.name)}&background=10b981&color=fff'">`;
      }).slice(0, 5).join('');

      previewContent = `
        <div class="popover-header">
          <div>
            <div class="popover-title">🏸 ${session.title}</div>
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
            <span>${session.date} • <strong>${session.startTime} - ${session.endTime}</strong></span>
          </div>
          <div class="popover-meta-item">
            <i class="fas fa-map-marker-alt"></i>
            <span>${session.courtName} (<strong>${session.courtNumbers}</strong>)</span>
          </div>
          <div class="popover-meta-item">
            <i class="fas fa-feather-alt"></i>
            <span>Loại cầu: <strong>${session.shuttleType}</strong></span>
          </div>
          <div class="popover-meta-item">
            <i class="fas fa-hourglass-half"></i>
            <span>${lockInfo.countdownText}</span>
          </div>
        </div>

        <div class="popover-roster-preview">
          <div class="flex items-center gap-2">
            <div class="avatar-stack">${attendeeAvatars}</div>
            <span class="font-bold text-primary">${totalGoing} / ${session.maxPlayers} người</span>
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
    const currentMonth = "2026-09";
    const voteLockHours = (data.clubInfo && data.clubInfo.voteLockHours) || 48;
    const lockInfo = this.getVoteLockStatus(session, voteLockHours);
    const currentUser = data.currentUser || AppStorage.getCurrentUser();
    const isAdmin = AppStorage.isAdmin();
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
          <img class="avatar avatar-sm" src="${m.avatar}" alt="${m.name}" title="${m.name}" style="width:24px;height:24px;" onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(m.name)}&background=10b981&color=fff'">
        `).join('');

        return `
          <div class="poll-option-card ${st.isLeader ? 'is-leader' : ''}">
            <div class="poll-option-header">
              <div class="poll-option-title">
                <span>Phương án ${idx + 1}: ${opt.courtName}</span>
                ${st.isLeader ? `<span class="badge badge-warning" style="font-size:0.7rem;"><i class="fas fa-crown"></i> Dẫn đầu</span>` : ''}
              </div>
              <div class="font-bold text-primary font-mono" style="font-size: 1.1rem;">
                ${st.voteCount} phiếu <span class="text-secondary" style="font-size:0.8rem;">(${st.percent}%)</span>
              </div>
            </div>

            <div class="poll-option-meta">
              <div class="poll-option-meta-item">
                <i class="far fa-calendar-alt"></i>
                <span>${opt.date || session.date}</span>
              </div>
              <div class="poll-option-meta-item">
                <i class="far fa-clock"></i>
                <span>${opt.startTime} - ${opt.endTime}</span>
              </div>
              <div class="poll-option-meta-item">
                <i class="fas fa-th-list"></i>
                <span>${opt.courtNumbers}</span>
              </div>
              <div class="poll-option-meta-item">
                <i class="fas fa-money-bill-wave"></i>
                <span>${Number(opt.price || 360000).toLocaleString('vi-VN')} đ</span>
              </div>
            </div>

            ${opt.note ? `<div class="text-muted" style="font-size: 0.8rem; margin-bottom: 0.5rem; font-style: italic;">"${opt.note}"</div>` : ''}

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
                  <button type="button" class="btn btn-ghost btn-icon btn-sm" onclick="ScheduleModule.openEditCourtLocationModal('${session.id}', '${opt.id}')" title="Admin: Sửa thông tin sân & tiền sân phương án này" style="border: 1px solid var(--border-color); border-radius: var(--radius-sm);">
                    <i class="fas fa-pencil-alt text-warning"></i>
                  </button>
                  <button type="button" class="btn btn-outline-primary btn-sm" onclick="ScheduleModule.finalizePollOption('${session.id}', '${opt.id}')" title="Chốt phương án này làm lịch thi đấu chính thức">
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
              <h2 style="font-size: 1.35rem; color: #fff;">${session.title}</h2>
              <div class="text-secondary" style="font-size: 0.9rem; margin-top: 0.25rem;">
                Ngày dự kiến: <strong>${dayName}, ${session.date}</strong> • Tối đa <strong>${session.maxPlayers} người</strong>
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
            <span>${lockInfo.countdownText}</span>
          </div>
          <span style="font-size: 0.8rem; font-weight: 600;">Hạn chót: ${lockInfo.deadlineFormatted}</span>
        </div>

        ${session.note ? `
          <div style="background: rgba(245, 158, 11, 0.08); border-left: 3px solid var(--accent); padding: 0.75rem 1rem; border-radius: var(--radius-sm); margin-bottom: 1.25rem; font-size: 0.88rem;">
            <strong><i class="fas fa-sticky-note text-warning"></i> Lưu ý:</strong> ${session.note}
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
              ${pollStats.notGoingVoters.map(m => `<img class="avatar avatar-sm" src="${m.avatar}" alt="${m.name}" title="${m.name}" style="width:24px;height:24px;">`).join('')}
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

        ${isAdmin ? `
        <!-- Admin: Quản lý trạng thái (Poll Modal) -->
        <div class="session-status-panel" style="margin-bottom: 1rem;">
          <div class="session-status-panel-title">
            <i class="fas fa-tasks"></i> Trạng thái buổi khảo sát
            <span class="session-status-badge-inline status-${session.status || 'open'}">
              ${ session.status === 'booked' ? '📋 Đã đặt sân' : session.status === 'completed' ? '✅ Đã diễn ra' : session.status === 'cancelled' ? '❌ Đã hủy' : '🟢 Đang mở vote' }
            </span>
          </div>
          <div class="session-status-btn-row">
            <button class="session-status-btn ${session.status === 'booked' ? 'is-current' : ''}" onclick="ScheduleModule.changeSessionStatus('${session.id}', 'booked')" ${session.status === 'booked' ? 'disabled' : ''}>
              <i class="fas fa-calendar-check"></i>
              <span>Đã đặt sân</span>
              <small>Admin xác nhận sân</small>
            </button>
            <button class="session-status-btn ${session.status === 'completed' ? 'is-current' : ''} btn-completed" onclick="ScheduleModule.changeSessionStatus('${session.id}', 'completed')" ${session.status === 'completed' ? 'disabled' : ''}>
              <i class="fas fa-flag-checkered"></i>
              <span>Đã diễn ra</span>
              <small>Kết thúc buổi đánh</small>
            </button>
            <button class="session-status-btn ${session.status === 'cancelled' ? 'is-current' : ''} btn-cancelled" onclick="ScheduleModule.changeSessionStatus('${session.id}', 'cancelled')" ${session.status === 'cancelled' ? 'disabled' : ''}>
              <i class="fas fa-times-circle"></i>
              <span>Hủy buổi</span>
              <small>Không tổ chức nữa</small>
            </button>
            ${session.status !== 'open' ? `
            <button class="session-status-btn btn-reopen" onclick="ScheduleModule.changeSessionStatus('${session.id}', 'open')">
              <i class="fas fa-undo"></i>
              <span>Mở lại</span>
              <small>Khôi phục vote</small>
            </button>
            ` : ''}
          </div>
        </div>
        ` : ''}

        <div style="display: flex; gap: 0.5rem; margin-top: 1.25rem; flex-wrap: wrap;">
          <button class="btn btn-primary flex-1" onclick="${lockInfo.isLocked && !isAdmin ? `App.showToast('🚫 Khảo sát đã chốt trước 2 ngày. Không thể thay đổi lịch!', 'warning')` : `App.closeModal(); VotingModule.openVoteModal('${session.id}')`}" ${lockInfo.isLocked && !isAdmin ? 'disabled style="opacity:0.65; cursor:not-allowed;"' : ''}>
            <i class="fas fa-vote-yea"></i> ${lockInfo.isLocked ? (isAdmin ? 'Quản lý bình chọn (Admin)' : '🔒 Đã chốt danh sách (Trước 2 ngày)') : 'Bình chọn phương án'}
          </button>
          <button class="btn btn-secondary" onclick="ScheduleModule.shareSession('${session.id}')">
            <i class="fas fa-share-alt"></i> Chia sẻ Zalo
          </button>
          ${isAdmin ? `
            <button class="btn btn-outline-danger" onclick="ScheduleModule.confirmDeleteSession('${session.id}')" title="Xóa buổi khảo sát này">
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
          dueBadge = `<span class="badge badge-warning">Vãng lai (${data.clubInfo.guestFee.toLocaleString('vi-VN')}đ)</span>`;
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
              <img class="avatar" src="${mem.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(mem.name)}&background=10b981&color=fff`}" alt="${mem.name}" onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(mem.name)}&background=10b981&color=fff'">
              <div class="attendee-info">
                <h4>
                  ${mem.name} 
                  ${v.guests > 0 ? `<span class="badge-guest">+${v.guests} khách</span>` : ''}
                </h4>
                <div class="attendee-meta">
                  <span><i class="fas fa-phone-alt"></i> ${mem.phone ? AppStorage.maskPhone(mem.phone, mem.id) : 'Chưa có SĐT'}</span>
                  ${v.note ? `<span>• <i class="far fa-comment"></i> "${v.note}"</span>` : ''}
                </div>
              </div>
            </div>
            <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 0.3rem;">
              ${dueBadge}
              <span class="vote-time">${v.votedAt}</span>
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
            <h2 style="font-size: 1.4rem; color: #fff;">${session.title}</h2>
            <div class="text-primary font-semibold" style="font-size: 0.95rem; margin-top: 0.25rem;">
              <i class="far fa-calendar-check"></i> ${dayName}, ngày ${session.date} • <i class="far fa-clock"></i> ${session.startTime} - ${session.endTime}
              ${isAdmin && (session.voteMode !== 'multi_option' || session.selectedOptionId) ? `
                <button type="button" class="btn btn-ghost btn-icon btn-xs" onclick="ScheduleModule.openEditSessionTimeModal('${session.id}')" title="Admin: Chỉnh sửa ngày & giờ đánh" style="border: 1px solid var(--border-color); border-radius: var(--radius-sm); margin-left: 0.35rem;">
                  <i class="fas fa-pencil-alt text-warning"></i>
                </button>
              ` : ''}
            </div>
          </div>
          <div class="text-right">
            <div class="font-bold text-primary" style="font-size: 1.7rem; line-height: 1;">${totalGoingCount} / ${session.maxPlayers}</div>
            <div class="text-muted" style="font-size: 0.75rem;">Người tham gia</div>
          </div>
        </div>

        <div style="margin-top: 1rem;">
          <div class="flex justify-between items-center text-secondary" style="font-size: 0.8rem; margin-bottom: 0.35rem;">
            <span>Tỷ lệ lấp đầy sân (${totalGoingCount}/${session.maxPlayers} người)</span>
            <strong>${session.maxPlayers - totalGoingCount > 0 ? `Còn ${session.maxPlayers - totalGoingCount} chỗ trống` : 'Đã đủ số lượng'}</strong>
          </div>
          <div class="progress-bar-bg">
            <div class="progress-bar-fill" style="width: ${capPercent}%;"></div>
          </div>
        </div>
      </div>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; margin-bottom: 1.25rem;">
        <div class="card" style="padding: 0.85rem; background: var(--bg-input);">
          <div class="text-secondary" style="font-size: 0.75rem;"><i class="fas fa-map-marker-alt text-primary"></i> Địa điểm sân</div>
          <div class="font-bold" style="font-size: 0.92rem; margin-top: 0.2rem;">${session.courtName || session.court || 'Sân cầu lông'}</div>
          <div class="text-secondary" style="font-size: 0.78rem;">${session.courtNumbers || ''}</div>
        </div>

        <div class="card" style="padding: 0.85rem; background: var(--bg-input);">
          <div class="text-secondary" style="font-size: 0.75rem;"><i class="fas fa-money-bill-wave text-primary"></i> Tiền sân dự tính</div>
          <div class="font-bold text-primary" style="font-size: 0.95rem; margin-top: 0.2rem;">${(session.courtPrice ? Number(session.courtPrice).toLocaleString('vi-VN') : '0')} VNĐ</div>
          <div class="text-secondary" style="font-size: 0.78rem;">Chi phí sân</div>
        </div>

        <div class="card" style="padding: 0.85rem; background: var(--bg-input);">
          <div class="text-secondary" style="font-size: 0.75rem;"><i class="fas fa-feather-alt text-primary"></i> Loại cầu sử dụng</div>
          <div class="font-bold" style="font-size: 0.92rem; margin-top: 0.2rem;">${session.shuttleType || 'n/a'}</div>
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
              ${session.courtName || session.court || 'Sân cầu lông'} ${session.courtNumbers ? `<span class="badge badge-neutral" style="font-size: 0.72rem; margin-left: 0.35rem;">${session.courtNumbers}</span>` : ''}
            </div>
            <div class="text-secondary" style="font-size: 0.85rem; margin-top: 0.2rem; display: flex; align-items: flex-start; gap: 0.4rem;">
              <i class="fas fa-location-arrow text-primary" style="margin-top: 0.2rem; font-size: 0.75rem;"></i>
              <span>${session.courtAddress || (data.clubInfo ? data.clubInfo.address : "") || session.courtName || session.court || 'Sân cầu lông'}</span>
            </div>
          </div>
          <div style="display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap;">
            ${isAdmin ? `
              <button type="button" class="btn btn-ghost btn-icon btn-sm" onclick="ScheduleModule.openEditCourtLocationModal('${session.id}')" title="Admin: Chỉnh sửa thông tin sân, tiền sân & loại cầu" style="border: 1px solid var(--border-color); border-radius: var(--radius-sm);">
                <i class="fas fa-pencil-alt text-warning"></i>
              </button>
            ` : ''}
            <button type="button" class="btn btn-outline-primary btn-sm" onclick="ScheduleModule.copyAddress('${(session.courtAddress || (data.clubInfo ? data.clubInfo.address : "") || session.courtName || session.court || "Sân cầu lông").replace(/'/g, "\\'")}')" title="Sao chép địa chỉ">
              <i class="far fa-copy"></i> Sao chép
            </button>
            <a href="${session.mapUrl || (data.clubInfo && data.clubInfo.mapUrl) || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(session.courtAddress || session.courtName || session.court || "Sân cầu lông")}`}" target="_blank" class="btn btn-primary btn-sm" title="Mở bản đồ Google Maps và dẫn đường">
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
          <a href="${session.mapUrl || (data.clubInfo && data.clubInfo.mapUrl) || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(session.courtAddress || session.courtName || session.court || "Sân cầu lông")}`}" target="_blank" class="map-overlay-badge">
            <i class="fas fa-external-link-alt text-primary"></i> Mở Google Maps
          </a>
        </div>
      </div>

      <div class="vote-deadline-notice ${lockInfo.isLocked ? 'is-locked' : 'is-open'}" style="margin-bottom: 1.25rem;">
        <div>
          <i class="fas ${lockInfo.isLocked ? 'fa-lock' : 'fa-hourglass-half'}"></i>
          <span>${lockInfo.countdownText}</span>
        </div>
        <span style="font-size: 0.8rem; font-weight: 600;">Hạn chót: ${lockInfo.deadlineFormatted}</span>
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
          <strong><i class="fas fa-sticky-note text-warning"></i> Lưu ý từ ban tổ chức:</strong> ${session.note}
        </div>
      ` : ''}

      <div style="display: flex; gap: 0.5rem; margin-bottom: 1.25rem; flex-wrap: wrap;">
        <button class="btn btn-primary btn-sm flex-1" onclick="${lockInfo.isLocked && !isAdmin ? `App.showToast('🚫 Ca đánh đã chốt trước 2 ngày. Thành viên không thể đổi lịch!', 'warning')` : `App.closeModal(); VotingModule.openVoteModal('${session.id}')`}" ${lockInfo.isLocked && !isAdmin ? 'disabled style="opacity: 0.65; cursor: not-allowed;"' : ''}>
          <i class="fas fa-vote-yea"></i> ${lockInfo.isLocked ? (isAdmin ? 'Quản lý bình chọn (Admin)' : '🔒 Đã chốt danh sách (Trước 2 ngày)') : 'Bình chọn (đi / nghỉ)'}
        </button>
        <button class="btn btn-secondary btn-sm" onclick="ScheduleModule.shareSession('${session.id}')">
          <i class="fas fa-share-alt"></i> Chia sẻ Zalo
        </button>
        ${isAdmin ? `
          <button class="btn btn-secondary btn-sm" onclick="App.closeModal(); App.openTab('bill-splitter'); BillSplitterModule.loadSessionForBill('${session.id}');">
            <i class="fas fa-calculator"></i> Chia tiền sân (Admin)
          </button>
        ` : ''}
        ${isAdmin ? `
          <button class="btn btn-outline-danger btn-sm" onclick="ScheduleModule.confirmDeleteSession('${session.id}')" title="Xóa buổi đặt sân này">
            <i class="fas fa-trash-alt"></i> Xóa buổi này
          </button>
        ` : ''}
      </div>

      ${isAdmin ? `
      <!-- Admin: Quản lý trạng thái vòng đời buổi đặt sân -->
      <div class="session-status-panel">
        <div class="session-status-panel-title">
          <i class="fas fa-tasks"></i> Trạng thái buổi đặt sân
          <span class="session-status-badge-inline status-${session.status || 'open'}">
            ${ session.status === 'booked' ? '📋 Đã đặt sân' : session.status === 'completed' ? '✅ Đã diễn ra' : session.status === 'cancelled' ? '❌ Đã hủy' : '🟢 Đang mở vote' }
          </span>
        </div>
        <div class="session-status-btn-row">
          <button class="session-status-btn ${session.status === 'booked' ? 'is-current' : ''}" onclick="ScheduleModule.changeSessionStatus('${session.id}', 'booked')" title="Đánh dấu Admin đã gọi và đặt sân thành công" ${session.status === 'booked' ? 'disabled' : ''}>
            <i class="fas fa-calendar-check"></i>
            <span>Đã đặt sân</span>
            <small>Admin xác nhận sân</small>
          </button>
          <button class="session-status-btn ${session.status === 'completed' ? 'is-current' : ''} btn-completed" onclick="ScheduleModule.changeSessionStatus('${session.id}', 'completed')" title="Buổi đã diễn ra xong" ${session.status === 'completed' ? 'disabled' : ''}>
            <i class="fas fa-flag-checkered"></i>
            <span>Đã diễn ra</span>
            <small>Kết thúc buổi đánh</small>
          </button>
          <button class="session-status-btn ${session.status === 'cancelled' ? 'is-current' : ''} btn-cancelled" onclick="ScheduleModule.changeSessionStatus('${session.id}', 'cancelled')" title="Hủy toàn bộ buổi đặt sân này" ${session.status === 'cancelled' ? 'disabled' : ''}>
            <i class="fas fa-times-circle"></i>
            <span>Hủy buổi</span>
            <small>Không tổ chức nữa</small>
          </button>
          ${session.status !== 'open' ? `
          <button class="session-status-btn btn-reopen" onclick="ScheduleModule.changeSessionStatus('${session.id}', 'open')" title="Mở lại trạng thái bình chọn ban đầu">
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
            <i class="fas fa-check-circle"></i> Danh sách tham gia (${going.length} người + ${going.reduce((s, v) => s + (v.guests || 0), 0)} khách)
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
            <button type="button" class="btn btn-outline-danger btn-sm" onclick="ScheduleModule.confirmDeleteSession('${session.id}')">
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
  finalizePollOption(sessionId, optionId) {
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    if (!session || !session.options) return;

    const selectedOpt = session.options.find(o => o.id === optionId);
    if (!selectedOpt) return;

    if (!confirm(`Bạn có chắc chắn muốn chốt lịch theo "${selectedOpt.courtName} (${selectedOpt.startTime} - ${selectedOpt.endTime})"?`)) return;

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

    AppStorage.saveData(data);
    App.closeModal();
    App.showToast(`🎉 Đã chốt thành công phương án "${selectedOpt.courtName}" làm lịch thi đấu chính thức!`, "success");

    // Gửi thông báo cho thành viên đã đăng ký tham gia
    if (window.NotificationModule) {
      setTimeout(() => NotificationModule.notifySessionBooked(session, true), 600);
    }
    
    if (this.currentViewMode === 'calendar') {
      this.renderMonthCalendar();
    } else {
      this.renderSessions("sessions-container", this.currentFilter);
    }
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
    const isAdmin = AppStorage.isAdmin();

    const now = new Date();
    const filtered = sessions.filter(s => {
      const sessionDate = this.parseSessionDateTime(s.date, s.endTime || '23:59');
      if (filter === 'upcoming') return sessionDate >= now;
      if (filter === 'past') return sessionDate < now;
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
              <span class="font-semibold text-main">Phương án ${idx + 1}: ${st.option.courtName.split('(')[0]} (${st.option.startTime}-${st.option.endTime})</span>
              <span class="font-bold text-primary font-mono">${st.voteCount} phiếu (${st.percent}%)</span>
            </div>
            <div class="poll-bar-track">
              <div class="poll-bar-fill ${st.isLeader ? 'leader-bar' : ''}" style="width: ${st.percent}%;"></div>
            </div>
          </div>
        `).join('');

        return `
          <div class="session-card is-featured" onclick="ScheduleModule.openSessionDetailsModal('${session.id}')" style="cursor: pointer;">
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
                  <h3>${session.title}</h3>
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
                  <span>${lockInfo.countdownText}</span>
                </div>
                <span style="font-size: 0.75rem; opacity: 0.85;">Hạn: ${lockInfo.deadlineFormatted}</span>
              </div>

              <div class="flex items-center justify-between" style="font-size: 0.85rem; padding-top: 0.25rem;">
                <span class="text-secondary">Trạng thái của bạn:</span>
                ${userVoteBadge}
              </div>
            </div>

            <div class="session-footer" onclick="event.stopPropagation();">
              <button class="btn btn-secondary btn-sm" onclick="ScheduleModule.shareSession('${session.id}')" title="Chia sẻ Zalo/Nhóm">
                <i class="fas fa-share-alt"></i> Chia sẻ
              </button>
              <button class="btn btn-secondary btn-sm" onclick="ScheduleModule.openSessionDetailsModal('${session.id}')">
                <i class="fas fa-info-circle"></i> Chi tiết
              </button>
              <button class="btn btn-primary btn-sm" onclick="VotingModule.openVoteModal('${session.id}')" ${lockInfo.isLocked && !isAdmin ? 'disabled' : ''}>
                <i class="fas fa-vote-yea"></i> ${lockInfo.isLocked ? (isAdmin ? 'Quản lý' : 'Đã khóa') : 'Bình chọn'}
              </button>
              ${isAdmin ? `
                <button class="btn btn-outline-danger btn-sm" onclick="ScheduleModule.confirmDeleteSession('${session.id}')" title="Xóa buổi này">
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
          userVoteBadge = `<span class="badge badge-paid"><i class="fas fa-check-circle"></i> Đã đăng ký tham gia ${userVote.guests > 0 ? `(+${userVote.guests} bạn)` : ''}</span>`;
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
        return `<img class="avatar avatar-sm" src="${mem.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(mem.name)}&background=10b981&color=fff`}" alt="${mem.name}" title="${mem.name} ${v.guests > 0 ? `(+${v.guests} khách)` : ''}" onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(mem.name)}&background=10b981&color=fff'">`;
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
        <div class="session-card ${lockInfo.isLocked ? 'is-locked' : 'is-featured'}" onclick="ScheduleModule.openSessionDetailsModal('${session.id}')" style="cursor: pointer;">
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
                <h3>${session.title}</h3>
                <div class="session-time-text">
                  <i class="far fa-clock"></i> ${session.startTime} - ${session.endTime} (${session.courtNumbers})
                </div>
              </div>
            </div>
          </div>

          <div class="session-body">
            <div class="court-meta-list">
              <div class="court-meta-item" style="display: flex; justify-content: space-between; align-items: center;">
                <div style="display: flex; align-items: center; gap: 0.35rem;">
                  <i class="fas fa-map-marker-alt text-primary"></i>
                  <div><span>Sân:</span> <strong>${session.courtName}</strong></div>
                </div>
                ${isAdmin ? `
                  <button type="button" class="btn btn-ghost btn-icon btn-xs" onclick="event.stopPropagation(); ScheduleModule.openEditCourtLocationModal('${session.id}')" title="Admin: Chỉnh sửa thông tin sân & tiền sân" style="border: 1px solid var(--border-color); border-radius: var(--radius-sm); margin-left: 0.35rem; flex-shrink: 0;">
                    <i class="fas fa-pencil-alt text-warning"></i>
                  </button>
                ` : ''}
              </div>
              <div class="court-meta-item">
                <i class="fas fa-feather-alt"></i>
                <div><span>Loại cầu:</span> <strong>${session.shuttleType || 'n/a'}</strong></div>
              </div>
              <div class="court-meta-item">
                <i class="fas fa-money-bill-wave"></i>
                <div><span>Tiền sân:</span> <strong>${session.courtPrice ? Number(session.courtPrice).toLocaleString('vi-VN') : '360.000'} đ</strong></div>
              </div>
              <div class="court-meta-item">
                <i class="fas fa-users"></i>
                <div><span>Tối đa:</span> <strong>${session.maxPlayers} người</strong></div>
              </div>
            </div>

            <div class="vote-deadline-notice ${lockInfo.isLocked ? 'is-locked' : 'is-open'}">
              <div>
                <i class="fas ${lockInfo.isLocked ? 'fa-lock' : 'fa-hourglass-half'}"></i>
                <span>${lockInfo.countdownText}</span>
              </div>
              <span style="font-size: 0.75rem; opacity: 0.85;">Hạn: ${lockInfo.deadlineFormatted}</span>
            </div>

            <div class="roster-summary">
              <div class="roster-header">
                <div>
                  <strong>${totalGoing} người tham gia</strong> 
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
            <button class="btn btn-secondary btn-sm" onclick="ScheduleModule.shareSession('${session.id}')" title="Chia sẻ Zalo/Nhóm">
              <i class="fas fa-share-alt"></i> Chia sẻ
            </button>
            <button class="btn btn-secondary btn-sm" onclick="ScheduleModule.openSessionDetailsModal('${session.id}')">
              <i class="fas fa-info-circle"></i> Chi tiết
            </button>
            <button class="btn btn-primary btn-sm" onclick="VotingModule.openVoteModal('${session.id}')" ${lockInfo.isLocked && !isAdmin ? 'disabled' : ''}>
              <i class="fas fa-vote-yea"></i> ${lockInfo.isLocked ? (isAdmin ? 'Quản lý' : 'Đã khóa') : 'Bình chọn'}
            </button>
            ${isAdmin ? `
              <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); ScheduleModule.openChangeStatusModal('${session.id}')" title="Quản lý trạng thái buổi đặt sân" style="min-width: 0;">
                ${session.status === 'booked' ? '<i class="fas fa-calendar-check" style="color:#06b6d4"></i> Đặt sân ✓' : session.status === 'completed' ? '<i class="fas fa-flag-checkered" style="color:#10b981"></i> Đã xong' : session.status === 'cancelled' ? '<i class="fas fa-times-circle" style="color:#ef4444"></i> Đã hủy' : '<i class="fas fa-tasks" style="color:#f59e0b"></i> Trạng thái'}
              </button>
              <button class="btn btn-outline-danger btn-sm" onclick="ScheduleModule.confirmDeleteSession('${session.id}')" title="Xóa buổi này">
                <i class="fas fa-trash-alt"></i> Xóa
              </button>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');
  },

  // ==========================================
  // ADD SESSION / CREATE POLL MODAL (SECURE ADMIN ACCESS)
  // ==========================================
  openAddSessionModal() {
    if (!AppStorage.isAdmin()) {
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
              <input type="text" id="session-court-name" class="form-control" placeholder="VD: Sân cầu lông CLB" value="${info.defaultCourt || ''}">
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
              <input type="text" id="session-court-address" class="form-control" placeholder="VD: 50/1 Tân Sơn, Phường 15, Tân Bình, TP.HCM" value="${info.address || ''}">
              <button type="button" class="btn btn-secondary btn-sm" onclick="ScheduleModule.testMapLocation('session-court-address', 'session-court-name')" title="Kiểm tra mở Google Maps thử nghiệm">
                <i class="fas fa-map-marked-alt"></i> Thử Maps
              </button>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label"><i class="fas fa-link text-primary"></i> Link Google Maps tùy chỉnh (tùy chọn):</label>
            <input type="url" id="session-map-url" class="form-control" placeholder="https://maps.app.goo.gl/... hoặc để trống tự sinh" value="${info.mapUrl || ''}">
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
                  <input type="text" class="form-control opt-court-input" value="${info.defaultCourt || ''}" placeholder="Tên sân 1">
                </div>
                <div class="form-group" style="margin-bottom:0.5rem;">
                  <label class="form-label" style="font-size:0.8rem;">Số sân:</label>
                  <input type="text" class="form-control opt-numbers-input" placeholder="VD: Sân 1 & 2" value="">
                </div>
              </div>
              <div class="form-group" style="margin-bottom:0.5rem;">
                <label class="form-label" style="font-size:0.8rem;"><i class="fas fa-map-marker-alt text-primary"></i> Địa chỉ sân & Link Maps (tùy chọn):</label>
                <div style="display: grid; grid-template-columns: 1.2fr 1fr; gap: 0.5rem;">
                  <input type="text" class="form-control opt-address-input" placeholder="Địa chỉ chi tiết (VD: 50/1 Tân Sơn, Tân Bình)" value="${info.address || ''}">
                  <input type="url" class="form-control opt-map-input" placeholder="Link Google Maps (nếu có)" value="${info.mapUrl || ''}">
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
      prompt("Sao chép địa chỉ sân:", address);
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
          <i class="fas fa-map-marker-alt text-primary"></i> ${courtName}
        </div>
        <div class="text-secondary" style="font-size: 0.88rem; display: flex; align-items: flex-start; gap: 0.4rem;">
          <i class="fas fa-location-arrow text-primary" style="margin-top: 0.2rem; font-size: 0.75rem;"></i>
          <span>${resolvedAddress}</span>
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
        <button type="button" class="btn btn-outline-primary btn-sm" onclick="ScheduleModule.copyAddress('${resolvedAddress.replace(/'/g, "\\'")}')">
          <i class="far fa-copy"></i> Sao chép địa chỉ
        </button>
        <div style="display: flex; gap: 0.5rem;">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Đóng</button>
          <a href="${directMapsUrl}" target="_blank" class="btn btn-primary">
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
    if (!AppStorage.isAdmin()) {
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
      <form onsubmit="ScheduleModule.saveCourtLocation(event, '${targetId}', '${optionId || ''}')">
        <div style="background: rgba(16, 185, 129, 0.08); border-left: 3px solid var(--primary); padding: 0.75rem 1rem; border-radius: var(--radius-sm); margin-bottom: 1.25rem;">
          <div class="font-bold text-main" style="font-size: 0.95rem;">${contextTitle}</div>
          <div class="text-secondary" style="font-size: 0.8rem; margin-top: 0.15rem;">
            Chỉnh sửa tên sân, số sân, tiền sân dự tính, loại cầu sử dụng (mặc định n/a), địa chỉ và bản đồ Google Maps. Thay đổi sẽ tự động đồng bộ lên Database.
          </div>
        </div>

        <div class="responsive-form-row">
          <div class="form-group" style="flex: 1.4;">
            <label class="form-label font-bold"><i class="fas fa-map-marker-alt text-primary"></i> Tên sân cầu lông *</label>
            <input type="text" id="edit-loc-court-name" class="form-control" value="${courtName}" required placeholder="VD: Sân cầu lông CLB">
          </div>
          <div class="form-group" style="flex: 1;">
            <label class="form-label font-bold"><i class="fas fa-th-large text-primary"></i> Số sân / Ghi chú sân</label>
            <input type="text" id="edit-loc-court-numbers" class="form-control" value="${courtNumbers}" placeholder="VD: Sân 1 (1 sân)">
          </div>
        </div>

        <div class="responsive-form-row">
          <div class="form-group" style="flex: 1.2;">
            <label class="form-label font-bold"><i class="fas fa-money-bill-wave text-primary"></i> Tiền sân dự tính (VNĐ)</label>
            <input type="number" id="edit-loc-court-price" class="form-control" value="${courtPrice}" placeholder="180000" step="10000">
          </div>
          <div class="form-group" style="flex: 1.2;">
            <label class="form-label font-bold"><i class="fas fa-feather-alt text-primary"></i> Loại cầu sử dụng</label>
            <input type="text" id="edit-loc-shuttle-type" class="form-control" value="${shuttleType}" placeholder="n/a">
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
          <textarea id="edit-loc-address" class="form-control" rows="2" required placeholder="VD: 50/1 Tân Sơn, Phường 15, Quận Tân Bình, TP. Hồ Chí Minh" oninput="ScheduleModule.updateLiveMapPreview()">${courtAddress}</textarea>
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
          <input type="url" id="edit-loc-map-url" class="form-control" value="${mapUrl}" placeholder="https://maps.google.com/?q=...">
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
    if (!AppStorage.isAdmin()) {
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

  // ==========================================
  // EDIT SESSION DATE & TIME (ADMIN)
  // ==========================================
  openEditSessionTimeModal(sessionId) {
    if (!AppStorage.isAdmin()) {
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
      <form onsubmit="ScheduleModule.saveSessionTime(event, '${session.id}')">
        <div style="background: rgba(16, 185, 129, 0.08); border-left: 3px solid var(--primary); padding: 0.75rem 1rem; border-radius: var(--radius-sm); margin-bottom: 1.25rem;">
          <div class="font-bold text-main" style="font-size: 0.95rem;">🕒 ${session.title}</div>
          <div class="text-secondary" style="font-size: 0.8rem; margin-top: 0.15rem;">
            Hiện tại: ${session.date} • ${session.startTime} - ${session.endTime}. Danh sách bình chọn được giữ nguyên; hạn khóa vote sẽ tính lại theo giờ mới.
          </div>
        </div>

        <div class="form-group">
          <label class="form-label font-bold"><i class="far fa-calendar-alt text-primary"></i> Ngày đánh *</label>
          <input type="date" id="edit-time-date" class="form-control" value="${dateVal}" required>
        </div>

        <div class="form-group">
          <label class="form-label font-bold"><i class="far fa-clock text-primary"></i> Khung giờ *</label>
          <div style="display: flex; gap: 0.5rem; align-items: center;">
            <input type="time" id="edit-time-start" class="form-control" value="${session.startTime || '18:00'}" required>
            <span>-</span>
            <input type="time" id="edit-time-end" class="form-control" value="${session.endTime || '20:00'}" required>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Lý do thay đổi (tùy chọn)</label>
          <input type="text" id="edit-time-reason" class="form-control" placeholder="VD: Sân báo đổi giờ">
        </div>

        <div style="display: flex; gap: 0.5rem; justify-content: flex-end;">
          <button type="button" class="btn btn-secondary" onclick="ScheduleModule.openSessionDetailsModal('${session.id}')">Hủy</button>
          <button type="submit" class="btn btn-primary"><i class="fas fa-save"></i> Lưu giờ mới</button>
        </div>
      </form>
    `;

    App.openModal("🕒 Chỉnh sửa ngày & giờ đánh", modalBody, true);
  },

  saveSessionTime(e, sessionId) {
    if (e && e.preventDefault) e.preventDefault();
    if (!AppStorage.isAdmin()) {
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

      if (!AppStorage.isAdmin()) {
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
        status: "open"
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
          const price = parseInt(row.querySelector('.opt-price-input')?.value) || 360000;

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

      data.sessions.unshift(newSession);
      AppStorage.saveData(data);
      App.closeModal();
      App.showToast(`🎉 Đã tạo ${voteMode === 'multi_option' ? 'khảo sát chọn sân & giờ' : 'lịch đặt sân'} thành công!`, "success");

      // Gửi thông báo chốt sân cho thành viên đang đăng nhập
      if (window.NotificationModule) {
        setTimeout(() => NotificationModule.notifySessionBooked(newSession, false), 600);
      }
      
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
      prompt("Sao chép nội dung bên dưới để gửi nhóm:", shareText);
    });
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
    if (!AppStorage.isAdmin()) {
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
        <div class="font-bold text-main" style="font-size: 1.05rem; margin-bottom: 0.4rem;">${session.title}</div>
        <div class="text-secondary" style="font-size: 0.85rem; line-height: 1.6;">
          <div><i class="far fa-calendar-alt text-primary" style="width: 16px;"></i> <strong>Ngày:</strong> ${session.date} (${session.startTime} - ${session.endTime})</div>
          <div><i class="fas fa-map-marker-alt text-primary" style="width: 16px;"></i> <strong>Địa điểm:</strong> ${session.courtName} (${session.courtNumbers})</div>
          <div><i class="fas fa-users text-primary" style="width: 16px;"></i> <strong>Dữ liệu ảnh hưởng:</strong> ${voterSummary}</div>
        </div>
      </div>

      <div style="background: rgba(239, 68, 68, 0.08); border-left: 3px solid var(--danger); padding: 0.75rem 1rem; border-radius: var(--radius-sm); margin-bottom: 1.25rem; font-size: 0.84rem; color: var(--text-main);">
        <i class="fas fa-exclamation-triangle text-danger"></i> <strong>Lưu ý:</strong> Toàn bộ lượt bình chọn của các thành viên sẽ bị xóa và đồng bộ cập nhật trên Lịch tháng, Dashboard ngay lập tức.
      </div>

      <div class="modal-footer" style="padding: 0; display: flex; gap: 0.5rem; justify-content: flex-end;">
        <button type="button" class="btn btn-secondary" onclick="App.closeModal()">
          <i class="fas fa-times"></i> Hủy bỏ
        </button>
        <button type="button" class="btn btn-danger" onclick="ScheduleModule.deleteSession('${session.id}')">
          <i class="fas fa-trash-alt"></i> Xác nhận xóa vĩnh viễn
        </button>
      </div>
    `;

    App.openModal("⚠️ Xác nhận xóa buổi đặt sân", modalBody, true);
  },

  deleteSession(sessionId) {
    if (!AppStorage.isAdmin()) {
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
    if (!AppStorage.isAdmin()) {
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
        <h3 style="font-size:1.1rem; color:var(--text-main); margin-bottom:0.3rem;">${session.title}</h3>
        <div style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:0.75rem;">${session.date} • ${session.startTime}–${session.endTime} • ${session.courtName || 'Sân CLB'}</div>
        <div>Trạng thái hiện tại: <span class="badge ${cur.cls}">${cur.label}</span></div>
      </div>

      <div class="session-status-btn-row" style="grid-template-columns: 1fr 1fr; margin-bottom:1rem;">
        <button class="session-status-btn ${currentStatus === 'open' ? 'is-current' : ''}" onclick="ScheduleModule.changeSessionStatus('${sessionId}', 'open')" ${currentStatus === 'open' ? 'disabled' : ''}>
          <i class="fas fa-door-open"></i>
          <span>Đang mở vote</span>
          <small>Trạng thái ban đầu</small>
        </button>
        <button class="session-status-btn ${currentStatus === 'booked' ? 'is-current' : ''}" onclick="ScheduleModule.changeSessionStatus('${sessionId}', 'booked')" ${currentStatus === 'booked' ? 'disabled' : ''}>
          <i class="fas fa-calendar-check"></i>
          <span>Đã đặt sân</span>
          <small>Admin xác nhận với sân</small>
        </button>
        <button class="session-status-btn ${currentStatus === 'completed' ? 'is-current' : ''} btn-completed" onclick="ScheduleModule.changeSessionStatus('${sessionId}', 'completed')" ${currentStatus === 'completed' ? 'disabled' : ''}>
          <i class="fas fa-flag-checkered"></i>
          <span>Đã diễn ra</span>
          <small>Buổi đánh kết thúc</small>
        </button>
        <button class="session-status-btn ${currentStatus === 'cancelled' ? 'is-current' : ''} btn-cancelled" onclick="ScheduleModule.changeSessionStatus('${sessionId}', 'cancelled')" ${currentStatus === 'cancelled' ? 'disabled' : ''}>
          <i class="fas fa-times-circle"></i>
          <span>Hủy buổi</span>
          <small>Không tổ chức nữa</small>
        </button>
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
    if (!AppStorage.isAdmin()) {
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
      `${statusLabels[newStatus] || newStatus} — Buổi "<strong>${session.title}</strong>" đã được cập nhật!`,
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
  }
};

window.ScheduleModule = ScheduleModule;
