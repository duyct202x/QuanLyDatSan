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
