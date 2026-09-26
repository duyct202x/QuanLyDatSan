// Voting & Attendance Module with Multi-Option Poll & Standard Attendance Support

const VotingModule = {
  selectedVoteStatus: 'going',
  selectedPollOptions: [], // Array of option IDs for multi-option polls
  pollNotGoing: false,
  guestCount: 0,

  openVoteModal(sessionId) {
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    if (!session) return;

    if (session.voteMode === 'multi_option') {
      this.openMultiOptionVoteModal(sessionId);
    } else {
      this.openStandardVoteModal(sessionId);
    }
  },

  // ==========================================
  // MULTI-OPTION POLL VOTING MODAL
  // ==========================================
  openMultiOptionVoteModal(sessionId) {
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    if (!session) return;

    const voteLockHours = data.clubInfo.voteLockHours || 48;
    const lockInfo = ScheduleModule.getVoteLockStatus(session, voteLockHours);
    const currentUser = data.currentUser;
    const isAdmin = currentUser.role === 'admin' || currentUser.role === 'treasurer';
    const isGuestType = session.sessionType === 'guest';

    if (lockInfo.isLocked && !isAdmin) {
      App.showToast("Buổi khảo sát này đã bị khóa bình chọn (quá hạn trước 2 ngày). Vui lòng liên hệ ban quản trị để chốt phương án!", "warning");
      ScheduleModule.openSessionDetailsModal(sessionId);
      return;
    }

    // Find current user's existing vote
    const existingVote = (session.votes || []).find(v => v.memberId === currentUser.id);
    if (existingVote) {
      this.selectedPollOptions = existingVote.selectedOptions ? [...existingVote.selectedOptions] : [];
      this.pollNotGoing = existingVote.notGoing === true;
      this.guestCount = existingVote.guests || 0;
    } else {
      this.selectedPollOptions = session.options && session.options[0] ? [session.options[0].id] : [];
      this.pollNotGoing = false;
      this.guestCount = 0;
    }

    const optionsHtml = (session.options || []).map((opt, idx) => {
      const isChecked = this.selectedPollOptions.includes(opt.id) && !this.pollNotGoing;

      return `
        <div class="poll-option-card ${isChecked ? 'is-selected' : ''}" id="poll-vote-card-${opt.id}" onclick="VotingModule.togglePollOption('${opt.id}')">
          <div class="poll-option-header">
            <div class="flex items-center gap-3">
              <input type="checkbox" id="chk-opt-${opt.id}" ${isChecked ? 'checked' : ''} style="width: 18px; height: 18px; accent-color: var(--primary); pointer-events: none;">
              <span class="font-bold" style="font-size: 0.96rem;">Phương án ${idx + 1}: ${opt.courtName}</span>
            </div>
            <span class="text-primary font-bold font-mono" style="font-size: 0.9rem;">${Number(opt.price || 360000).toLocaleString('vi-VN')} đ</span>
          </div>
          <div class="poll-option-meta" style="margin-bottom: 0.2rem; padding-left: 1.8rem;">
            <span><i class="far fa-calendar-alt text-primary"></i> ${opt.date || session.date}</span>
            <span>•</span>
            <span><i class="far fa-clock text-primary"></i> ${opt.startTime} - ${opt.endTime}</span>
            <span>•</span>
            <span>${opt.courtNumbers}</span>
          </div>
          ${opt.note ? `<div class="text-muted" style="font-size: 0.78rem; padding-left: 1.8rem;">"${opt.note}"</div>` : ''}
        </div>
      `;
    }).join('');

    const modalBody = `
      <div style="margin-bottom: 1rem;">
        <div style="display:flex; gap:0.4rem; margin-bottom:0.3rem;">
          <span class="badge badge-poll-mode" style="font-size:0.7rem;"><i class="fas fa-poll"></i> Khảo sát chọn sân & giờ</span>
          <span class="badge ${isGuestType ? 'badge-guest-type' : 'badge-fixed-type'}" style="font-size:0.7rem;">
            ${isGuestType ? '⚡ Vãng lai theo ngày' : '🏸 Cố định (Trừ quỹ)'}
          </span>
        </div>
        <div style="font-size: 1.15rem; font-weight: 700; color: var(--text-main);">${session.title}</div>
      </div>

      <div class="vote-deadline-notice ${lockInfo.isLocked ? 'is-locked' : 'is-open'}" style="margin-bottom: 1.25rem;">
        <div>
          <i class="fas ${lockInfo.isLocked ? 'fa-lock' : 'fa-hourglass-half'}"></i>
          <span>${lockInfo.countdownText}</span>
        </div>
        <span style="font-size: 0.8rem; font-weight: 600;">Hạn: ${lockInfo.deadlineFormatted}</span>
      </div>

      <div class="form-label">Chọn phương án bạn có thể tham gia (có thể chọn nhiều):</div>
      <div class="poll-options-container" style="margin-top: 0.5rem; margin-bottom: 1rem;">
        ${optionsHtml}
      </div>

      <!-- Option Not Going / Busy -->
      <div class="poll-option-card ${this.pollNotGoing ? 'is-selected' : ''}" id="poll-vote-card-notgoing" onclick="VotingModule.togglePollNotGoing()" style="margin-bottom: 1.25rem; border-color: ${this.pollNotGoing ? 'var(--danger)' : 'var(--border-color)'}; background: ${this.pollNotGoing ? 'rgba(239, 68, 68, 0.1)' : 'var(--bg-input)'};">
        <div class="flex items-center gap-3">
          <input type="checkbox" id="chk-opt-notgoing" ${this.pollNotGoing ? 'checked' : ''} style="width: 18px; height: 18px; accent-color: var(--danger); pointer-events: none;">
          <div>
            <div class="font-bold text-danger" style="font-size: 0.95rem;">❌ Không tham gia được phương án nào</div>
            <div class="text-secondary" style="font-size: 0.78rem;">Bận / Báo vắng buổi giao lưu này</div>
          </div>
        </div>
      </div>

      <!-- Guest Counter (Only relevant if participating) -->
      <div id="guest-selector-container" class="guest-selector" style="${this.pollNotGoing ? 'opacity: 0.4; pointer-events: none;' : ''}">
        <div>
          <div style="font-weight: 600; font-size: 0.95rem;">Dẫn thêm bạn (Khách vãng lai)</div>
          <div class="text-secondary" style="font-size: 0.8rem;">Phí vãng lai: ${data.clubInfo.guestFee.toLocaleString('vi-VN')} đ / người</div>
        </div>
        <div class="counter-control">
          <button type="button" class="counter-btn" onclick="VotingModule.adjustGuests(-1)">-</button>
          <span id="guest-count-display" class="counter-val">${this.guestCount}</span>
          <button type="button" class="counter-btn" onclick="VotingModule.adjustGuests(1)">+</button>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Ghi chú thêm (nếu có):</label>
        <input type="text" id="vote-note" class="form-control" placeholder="VD: Khung giờ 19h30 thì mình đến kịp, 18h sợ kẹt xe..." value="${existingVote && existingVote.note ? existingVote.note : ''}">
      </div>

      <div class="modal-footer" style="padding: 1.25rem 0 0 0;">
        <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Đóng</button>
        <button type="button" class="btn btn-primary" onclick="VotingModule.submitMultiOptionVote('${sessionId}')">
          <i class="fas fa-save"></i> Xác nhận bình chọn
        </button>
      </div>
    `;

    App.openModal("🗳️ Bình chọn phương án sân & giờ", modalBody, true);
  },

  togglePollOption(optId) {
    this.pollNotGoing = false;
    const notGoingChk = document.getElementById('chk-opt-notgoing');
    const notGoingCard = document.getElementById('poll-vote-card-notgoing');
    if (notGoingChk) notGoingChk.checked = false;
    if (notGoingCard) {
      notGoingCard.classList.remove('is-selected');
      notGoingCard.style.borderColor = 'var(--border-color)';
      notGoingCard.style.background = 'var(--bg-input)';
    }

    const idx = this.selectedPollOptions.indexOf(optId);
    if (idx >= 0) {
      this.selectedPollOptions.splice(idx, 1);
    } else {
      this.selectedPollOptions.push(optId);
    }

    // Update UI
    const card = document.getElementById(`poll-vote-card-${optId}`);
    const chk = document.getElementById(`chk-opt-${optId}`);
    const isChecked = this.selectedPollOptions.includes(optId);
    if (card) {
      if (isChecked) card.classList.add('is-selected');
      else card.classList.remove('is-selected');
    }
    if (chk) chk.checked = isChecked;

    const guestEl = document.getElementById('guest-selector-container');
    if (guestEl) {
      guestEl.style.opacity = this.selectedPollOptions.length > 0 ? '1' : '0.4';
      guestEl.style.pointerEvents = this.selectedPollOptions.length > 0 ? 'auto' : 'none';
    }
  },

  togglePollNotGoing() {
    this.pollNotGoing = !this.pollNotGoing;
    if (this.pollNotGoing) {
      this.selectedPollOptions = [];
      // Uncheck all option cards
      document.querySelectorAll('.poll-options-container .poll-option-card').forEach(c => c.classList.remove('is-selected'));
      document.querySelectorAll('.poll-options-container input[type="checkbox"]').forEach(c => c.checked = false);
    }

    const notGoingChk = document.getElementById('chk-opt-notgoing');
    const notGoingCard = document.getElementById('poll-vote-card-notgoing');
    if (notGoingChk) notGoingChk.checked = this.pollNotGoing;
    if (notGoingCard) {
      if (this.pollNotGoing) {
        notGoingCard.classList.add('is-selected');
        notGoingCard.style.borderColor = 'var(--danger)';
        notGoingCard.style.background = 'rgba(239, 68, 68, 0.1)';
      } else {
        notGoingCard.classList.remove('is-selected');
        notGoingCard.style.borderColor = 'var(--border-color)';
        notGoingCard.style.background = 'var(--bg-input)';
      }
    }

    const guestEl = document.getElementById('guest-selector-container');
    if (guestEl) {
      guestEl.style.opacity = this.pollNotGoing ? '0.4' : '1';
      guestEl.style.pointerEvents = this.pollNotGoing ? 'none' : 'auto';
    }
  },

  submitMultiOptionVote(sessionId) {
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    if (!session) return;

    if (!this.pollNotGoing && this.selectedPollOptions.length === 0) {
      App.showToast("Vui lòng chọn ít nhất một phương án hoặc chọn Báo bận!", "warning");
      return;
    }

    if (!session.votes) session.votes = [];
    const currentUser = data.currentUser;
    const note = document.getElementById('vote-note')?.value.trim() || '';

    const index = session.votes.findIndex(v => v.memberId === currentUser.id);
    const voteRecord = {
      memberId: currentUser.id,
      selectedOptions: this.pollNotGoing ? [] : this.selectedPollOptions,
      notGoing: this.pollNotGoing,
      guests: this.pollNotGoing ? 0 : this.guestCount,
      note: note,
      votedAt: new Date().toISOString().slice(0, 16).replace('T', ' ')
    };

    if (index >= 0) {
      session.votes[index] = voteRecord;
    } else {
      session.votes.push(voteRecord);
    }

    AppStorage.saveData(data);
    App.closeModal();

    let msg = "Đã lưu kết quả bình chọn phương án của bạn!";
    if (!this.pollNotGoing) {
      msg = `🎉 Bạn đã bình chọn cho ${this.selectedPollOptions.length} phương án sân & giờ!`;
      if (window.confetti) {
        window.confetti({ particleCount: 50, spread: 60, origin: { y: 0.8 } });
      }
    }
    App.showToast(msg, "success");

    if (ScheduleModule.currentViewMode === 'calendar') {
      ScheduleModule.renderMonthCalendar();
    } else {
      ScheduleModule.renderSessions("sessions-container", ScheduleModule.currentFilter);
    }
    App.refreshDashboardStats();
  },

  // ==========================================
  // STANDARD ATTENDANCE VOTING MODAL
  // ==========================================
  openStandardVoteModal(sessionId) {
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    if (!session) return;

    const voteLockHours = data.clubInfo.voteLockHours || 48;
    const lockInfo = ScheduleModule.getVoteLockStatus(session, voteLockHours);
    const currentUser = data.currentUser;
    const isAdmin = currentUser.role === 'admin' || currentUser.role === 'treasurer';
    const isGuestType = session.sessionType === 'guest';

    if (lockInfo.isLocked && !isAdmin) {
      App.showToast("Buổi đánh này đã bị khóa bình chọn (quá hạn trước 2 ngày). Vui lòng liên hệ ban quản trị để xin thêm slot!", "warning");
      this.viewAttendees(sessionId);
      return;
    }

    const existingVote = (session.votes || []).find(v => v.memberId === currentUser.id);
    this.selectedVoteStatus = existingVote ? existingVote.status : 'going';
    this.guestCount = existingVote ? (existingVote.guests || 0) : 0;

    const modalBody = `
      <div style="margin-bottom: 1rem;">
        <div style="display:flex; gap:0.4rem; margin-bottom:0.3rem;">
          <span class="badge ${isGuestType ? 'badge-guest-type' : 'badge-fixed-type'}" style="font-size:0.7rem;">
            ${isGuestType ? '⚡ Lịch vãng lai theo ngày' : '🏸 Lịch cố định (Trừ quỹ)'}
          </span>
        </div>
        <div style="font-size: 1.1rem; font-weight: 700; color: var(--text-main);">${session.title}</div>
        <div class="text-primary font-semibold" style="font-size: 0.9rem; margin-top: 0.2rem;">
          <i class="far fa-calendar-alt"></i> ${session.date} | <i class="far fa-clock"></i> ${session.startTime} - ${session.endTime} (${session.courtNumbers})
        </div>
      </div>

      ${lockInfo.isLocked ? `
        <div class="vote-deadline-notice is-locked" style="margin-bottom: 1.25rem;">
          <i class="fas fa-exclamation-triangle"></i>
          <span>Buổi này đã qua hạn chốt trước 2 ngày. Bạn đang thao tác với quyền <strong>Quản trị viên (Admin)</strong>.</span>
        </div>
      ` : `
        <div class="vote-deadline-notice is-open" style="margin-bottom: 1.25rem;">
          <i class="fas fa-info-circle"></i>
          <span>${lockInfo.countdownText} (Hạn: ${lockInfo.deadlineFormatted})</span>
        </div>
      `}

      <div class="form-label">Chọn trạng thái tham gia của bạn:</div>
      <div class="vote-options-grid">
        <div class="vote-option-btn opt-going ${this.selectedVoteStatus === 'going' ? 'selected' : ''}" onclick="VotingModule.selectOption('going')">
          <i class="fas fa-badminton text-primary">🏸</i>
          <span class="vote-label">Tham gia</span>
          <span class="vote-sub">Chắc chắn đi</span>
        </div>

        <div class="vote-option-btn opt-not-going ${this.selectedVoteStatus === 'not_going' ? 'selected' : ''}" onclick="VotingModule.selectOption('not_going')">
          <i class="fas fa-times-circle text-danger">❌</i>
          <span class="vote-label">Không đi</span>
          <span class="vote-sub">Bận / Báo vắng</span>
        </div>

        <div class="vote-option-btn opt-maybe ${this.selectedVoteStatus === 'maybe' ? 'selected' : ''}" onclick="VotingModule.selectOption('maybe')">
          <i class="fas fa-hourglass-half text-warning">⏳</i>
          <span class="vote-label">Dự bị</span>
          <span class="vote-sub">Chưa chắc chắn</span>
        </div>
      </div>

      <!-- Guest Counter (Only relevant if going) -->
      <div id="guest-selector-container" class="guest-selector" style="${this.selectedVoteStatus === 'going' ? '' : 'opacity: 0.4; pointer-events: none;'}">
        <div>
          <div style="font-weight: 600; font-size: 0.95rem;">Dẫn thêm bạn (Khách vãng lai)</div>
          <div class="text-secondary" style="font-size: 0.8rem;">Phí vãng lai: ${data.clubInfo.guestFee.toLocaleString('vi-VN')} đ / người</div>
        </div>
        <div class="counter-control">
          <button type="button" class="counter-btn" onclick="VotingModule.adjustGuests(-1)">-</button>
          <span id="guest-count-display" class="counter-val">${this.guestCount}</span>
          <button type="button" class="counter-btn" onclick="VotingModule.adjustGuests(1)">+</button>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Ghi chú thêm (nếu có):</label>
        <input type="text" id="vote-note" class="form-control" placeholder="VD: Đến muộn 15p, xin đánh đôi nam..." value="${existingVote && existingVote.note ? existingVote.note : ''}">
      </div>

      ${isAdmin ? `
        <div style="border-top: 1px dashed var(--border-color); padding-top: 1rem; margin-top: 1rem;">
          <div class="text-secondary" style="font-size: 0.8rem; font-weight: 700; margin-bottom: 0.5rem;">
            <i class="fas fa-shield-alt"></i> Thao tác quản trị (Admin)
          </div>
          <div style="display: flex; gap: 0.5rem;">
            <button type="button" class="btn btn-secondary btn-sm" onclick="VotingModule.toggleAdminLock('${sessionId}')">
              <i class="fas ${session.status === 'locked' ? 'fa-unlock' : 'fa-lock'}"></i> ${session.status === 'locked' ? 'Mở khóa bình chọn' : 'Khóa bình chọn ngay'}
            </button>
            <button type="button" class="btn btn-secondary btn-sm" onclick="VotingModule.openManualAddModal('${sessionId}')">
              <i class="fas fa-user-plus"></i> Thêm người khác
            </button>
          </div>
        </div>
      ` : ''}

      <div class="modal-footer" style="padding: 1.25rem 0 0 0;">
        <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Đóng</button>
        <button type="button" class="btn btn-primary" onclick="VotingModule.submitVote('${sessionId}')">
          <i class="fas fa-save"></i> Xác nhận bình chọn
        </button>
      </div>
    `;

    App.openModal("🗳️ Bình chọn tham gia buổi đánh", modalBody);
  },

  selectOption(status) {
    this.selectedVoteStatus = status;
    document.querySelectorAll('.vote-option-btn').forEach(btn => btn.classList.remove('selected'));
    
    if (status === 'going') {
      document.querySelector('.opt-going')?.classList.add('selected');
      const guestEl = document.getElementById('guest-selector-container');
      if (guestEl) {
        guestEl.style.opacity = '1';
        guestEl.style.pointerEvents = 'auto';
      }
    } else if (status === 'not_going') {
      document.querySelector('.opt-not-going')?.classList.add('selected');
      const guestEl = document.getElementById('guest-selector-container');
      if (guestEl) {
        guestEl.style.opacity = '0.4';
        guestEl.style.pointerEvents = 'none';
      }
      this.guestCount = 0;
      const countEl = document.getElementById('guest-count-display');
      if (countEl) countEl.innerText = '0';
    } else if (status === 'maybe') {
      document.querySelector('.opt-maybe')?.classList.add('selected');
      const guestEl = document.getElementById('guest-selector-container');
      if (guestEl) {
        guestEl.style.opacity = '0.4';
        guestEl.style.pointerEvents = 'none';
      }
    }
  },

  adjustGuests(delta) {
    this.guestCount = Math.max(0, Math.min(5, this.guestCount + delta));
    const countEl = document.getElementById('guest-count-display');
    if (countEl) countEl.innerText = this.guestCount;
  },

  submitVote(sessionId) {
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    if (!session) return;

    if (!session.votes) session.votes = [];

    const currentUser = data.currentUser;
    const note = document.getElementById('vote-note')?.value.trim() || '';

    const index = session.votes.findIndex(v => v.memberId === currentUser.id);
    const voteRecord = {
      memberId: currentUser.id,
      status: this.selectedVoteStatus,
      guests: this.selectedVoteStatus === 'going' ? this.guestCount : 0,
      note: note,
      votedAt: new Date().toISOString().slice(0, 16).replace('T', ' ')
    };

    if (index >= 0) {
      session.votes[index] = voteRecord;
    } else {
      session.votes.push(voteRecord);
    }

    AppStorage.saveData(data);
    App.closeModal();

    let msg = "Đã cập nhật trạng thái bình chọn của bạn thành công!";
    if (this.selectedVoteStatus === 'going') {
      msg = `🎉 Bạn đã đăng ký tham gia buổi đánh${this.guestCount > 0 ? ` (+${this.guestCount} bạn)` : ''}! Hẹn gặp trên sân!`;
      if (window.confetti) {
        window.confetti({ particleCount: 50, spread: 60, origin: { y: 0.8 } });
      }
    }
    App.showToast(msg, "success");
    
    if (ScheduleModule.currentViewMode === 'calendar') {
      ScheduleModule.renderMonthCalendar();
    } else {
      ScheduleModule.renderSessions("sessions-container", ScheduleModule.currentFilter);
    }
    App.refreshDashboardStats();
  },

  viewAttendees(sessionId) {
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    if (!session) return;

    ScheduleModule.openSessionDetailsModal(sessionId);
  },

  toggleAdminLock(sessionId) {
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    if (!session) return;

    session.status = (session.status === 'locked') ? 'open' : 'locked';
    AppStorage.saveData(data);
    App.closeModal();
    App.showToast(`Đã ${session.status === 'locked' ? 'khóa' : 'mở'} bình chọn cho buổi đánh thành công!`, "info");
    
    if (ScheduleModule.currentViewMode === 'calendar') {
      ScheduleModule.renderMonthCalendar();
    } else {
      ScheduleModule.renderSessions("sessions-container", ScheduleModule.currentFilter);
    }
  },

  openManualAddModal(sessionId) {
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    if (!session) return;

    const members = data.members || [];
    const votedIds = (session.votes || []).map(v => v.memberId);
    const unvotedMembers = members.filter(m => !votedIds.includes(m.id));

    const modalBody = `
      <div class="form-group">
        <label class="form-label">Chọn thành viên cần thêm:</label>
        <select id="manual-member-id" class="form-select">
          ${unvotedMembers.map(m => `<option value="${m.id}">${m.name} (${m.phone})</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Trạng thái:</label>
        <select id="manual-status" class="form-select">
          <option value="going">Tham gia (Đi)</option>
          <option value="maybe">Dự bị</option>
          <option value="not_going">Bận / Không đi</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Khách dẫn kèm:</label>
        <input type="number" id="manual-guests" class="form-control" value="0" min="0" max="5">
      </div>
      <div class="modal-footer" style="padding: 1rem 0 0 0;">
        <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Hủy</button>
        <button type="button" class="btn btn-primary" onclick="VotingModule.saveManualAdd('${sessionId}')">Thêm vào danh sách</button>
      </div>
    `;

    App.openModal("👤 Admin thêm thành viên vào lịch", modalBody);
  },

  saveManualAdd(sessionId) {
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    if (!session) return;

    const memberId = document.getElementById("manual-member-id").value;
    const status = document.getElementById("manual-status").value;
    const guests = parseInt(document.getElementById("manual-guests").value) || 0;

    if (!session.votes) session.votes = [];
    session.votes.push({
      memberId,
      status,
      guests,
      note: "Admin thêm thủ công",
      votedAt: new Date().toISOString().slice(0, 16).replace('T', ' ')
    });

    AppStorage.saveData(data);
    App.closeModal();
    App.showToast("Đã thêm thành viên vào danh sách thành công!", "success");
    
    if (ScheduleModule.currentViewMode === 'calendar') {
      ScheduleModule.renderMonthCalendar();
    } else {
      ScheduleModule.renderSessions("sessions-container", ScheduleModule.currentFilter);
    }
  }
};
