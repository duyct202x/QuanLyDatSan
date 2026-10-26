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
