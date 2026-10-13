// ScheduleModule - Biểu mẫu đặt lịch, đổi giờ, đổi trạng thái, xóa buổi (tách từ schedule.js; mở rộng ScheduleModule nên `this` dùng như cũ)
Object.assign(ScheduleModule, {
  // ==========================================
  // ADD SESSION / CREATE POLL MODAL (SECURE ADMIN ACCESS)
  // ==========================================
  // Ô "Mở bình chọn" trong form tạo buổi: mặc định theo cài đặt CLB (tự mở trước N ngày)
  initVoteOpenField() {
    const info = (AppStorage.loadData().clubInfo) || {};
    const mode = document.getElementById('session-vote-open-mode');
    if (!mode || !window.VoteScheduler) return;
    if (info.autoVoteOpen && info.autoVoteOpen.enabled) mode.value = 'scheduled';
    this.onVoteOpenModeChange();
    ['session-date', 'session-start'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => this.onVoteOpenModeChange(true));
    });
    const hint = document.getElementById('session-vote-open-rule');
    if (hint) hint.textContent = 'Quy tắc của CLB: ' + VoteScheduler.describeRule(info);
  },

  onVoteOpenModeChange(dateChanged = false) {
    const mode = document.getElementById('session-vote-open-mode');
    const input = document.getElementById('session-vote-open-at');
    if (!mode || !input) return;
    const scheduled = mode.value === 'scheduled';
    input.style.display = scheduled ? 'block' : 'none';
    input.required = scheduled;
    if (scheduled && (!input.value || dateChanged)) {
      const info = (AppStorage.loadData().clubInfo) || {};
      const dateVal = document.getElementById('session-date')?.value || '';
      const cfg = Object.assign({ mode: 'daysBefore', daysBefore: 5, time: '08:00' }, info.autoVoteOpen || {}, { enabled: true });
      const startVal = document.getElementById('session-start')?.value || '';
      input.value = VoteScheduler.defaultOpenAt(dateVal, { autoVoteOpen: cfg }, startVal) || VoteScheduler.toLocalInput(Date.now() + 60 * 60 * 1000);
    }
  },

  openAddSessionModal() {
    if (!AppStorage.can('schedule')) {
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
              <input type="text" id="session-court-name" class="form-control" placeholder="VD: Sân cầu lông CLB" value="${Safe.html(info.defaultCourt || '')}">
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
              <input type="text" id="session-court-address" class="form-control" placeholder="VD: 50/1 Tân Sơn, Phường 15, Tân Bình, TP.HCM" value="${Safe.html(info.address || '')}">
              <button type="button" class="btn btn-secondary btn-sm" onclick="ScheduleModule.testMapLocation('session-court-address', 'session-court-name')" title="Kiểm tra mở Google Maps thử nghiệm">
                <i class="fas fa-map-marked-alt"></i> Thử Maps
              </button>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label"><i class="fas fa-link text-primary"></i> Link Google Maps tùy chỉnh (tùy chọn):</label>
            <input type="url" id="session-map-url" class="form-control" placeholder="https://maps.app.goo.gl/... hoặc để trống tự sinh" value="${Safe.html(info.mapUrl || '')}">
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
                  <input type="text" class="form-control opt-court-input" value="${Safe.html(info.defaultCourt || '')}" placeholder="Tên sân 1">
                </div>
                <div class="form-group" style="margin-bottom:0.5rem;">
                  <label class="form-label" style="font-size:0.8rem;">Số sân:</label>
                  <input type="text" class="form-control opt-numbers-input" placeholder="VD: Sân 1 & 2" value="">
                </div>
              </div>
              <div class="form-group" style="margin-bottom:0.5rem;">
                <label class="form-label" style="font-size:0.8rem;"><i class="fas fa-map-marker-alt text-primary"></i> Địa chỉ sân & Link Maps (tùy chọn):</label>
                <div style="display: grid; grid-template-columns: 1.2fr 1fr; gap: 0.5rem;">
                  <input type="text" class="form-control opt-address-input" placeholder="Địa chỉ chi tiết (VD: 50/1 Tân Sơn, Tân Bình)" value="${Safe.html(info.address || '')}">
                  <input type="url" class="form-control opt-map-input" placeholder="Link Google Maps (nếu có)" value="${Safe.html(info.mapUrl || '')}">
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

        <div class="form-group" style="background: var(--bg-input); padding: 0.85rem 1rem; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
          <label class="form-label"><i class="fas fa-stopwatch text-primary"></i> Mở bình chọn</label>
          <select id="session-vote-open-mode" class="form-select" onchange="ScheduleModule.onVoteOpenModeChange()">
            <option value="now">Mở ngay khi lưu</option>
            <option value="scheduled">Hẹn giờ tự động mở</option>
          </select>
          <input type="datetime-local" id="session-vote-open-at" class="form-control" style="margin-top: 0.5rem; display: none;">
          ${window.VoteScheduler ? VoteScheduler.renderEmailCheckbox('session-email-notify', null, AppStorage.loadData().clubInfo) : ''}
          <span class="text-secondary" style="font-size: 0.75rem; margin-top: 0.35rem; display: block;">
            Đến giờ hẹn, bình chọn tự mở và thành viên nhận thông báo. <span id="session-vote-open-rule"></span>
          </span>
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
    this.initVoteOpenField();
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

  // ==========================================
  // EDIT SESSION DATE & TIME (ADMIN)
  // ==========================================
  openEditSessionTimeModal(sessionId) {
    if (!AppStorage.can('schedule')) {
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
      <form onsubmit="ScheduleModule.saveSessionTime(event, ${Safe.js(session.id)})">
        <div style="background: rgba(16, 185, 129, 0.08); border-left: 3px solid var(--primary); padding: 0.75rem 1rem; border-radius: var(--radius-sm); margin-bottom: 1.25rem;">
          <div class="font-bold text-main" style="font-size: 0.95rem;">🕒 ${Safe.html(session.title)}</div>
          <div class="text-secondary" style="font-size: 0.8rem; margin-top: 0.15rem;">
            Hiện tại: ${Safe.html(session.date)} • ${Safe.html(session.startTime)} - ${Safe.html(session.endTime)}. Danh sách bình chọn được giữ nguyên; hạn khóa vote sẽ tính lại theo giờ mới.
          </div>
        </div>

        <div class="form-group">
          <label class="form-label font-bold"><i class="far fa-calendar-alt text-primary"></i> Ngày đánh *</label>
          <input type="date" id="edit-time-date" class="form-control" value="${dateVal}" required>
        </div>

        <div class="form-group">
          <label class="form-label font-bold"><i class="far fa-clock text-primary"></i> Khung giờ *</label>
          <div style="display: flex; gap: 0.5rem; align-items: center;">
            <input type="time" id="edit-time-start" class="form-control" value="${Safe.html(session.startTime || '18:00')}" required>
            <span>-</span>
            <input type="time" id="edit-time-end" class="form-control" value="${Safe.html(session.endTime || '20:00')}" required>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Lý do thay đổi (tùy chọn)</label>
          <input type="text" id="edit-time-reason" class="form-control" placeholder="VD: Sân báo đổi giờ">
        </div>

        <div style="display: flex; gap: 0.5rem; justify-content: flex-end;">
          <button type="button" class="btn btn-secondary" onclick="ScheduleModule.openSessionDetailsModal(${Safe.js(session.id)})">Hủy</button>
          <button type="submit" class="btn btn-primary"><i class="fas fa-save"></i> Lưu giờ mới</button>
        </div>
      </form>
    `;

    App.openModal("🕒 Chỉnh sửa ngày & giờ đánh", modalBody, true);
  },

  saveSessionTime(e, sessionId) {
    if (e && e.preventDefault) e.preventDefault();
    if (!AppStorage.can('schedule')) {
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

      if (!AppStorage.can('schedule')) {
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
        status: "open",
        openedBy: (currentUser && currentUser.username) || ''
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
          const price = parseInt(row.querySelector('.opt-price-input')?.value) || 0;

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

      const emailChoice = window.VoteScheduler ? VoteScheduler.readEmailCheckbox('session-email-notify') : null;
      if (emailChoice === false) newSession.emailNotify = false;
      const openMode = document.getElementById('session-vote-open-mode')?.value || 'now';
      const openAt = document.getElementById('session-vote-open-at')?.value || '';
      if (openMode === 'scheduled' && window.VoteScheduler) {
        const openMs = VoteScheduler.parseLocal(openAt);
        const startMs = VoteScheduler.parseLocal(`${newSession.date}T${newSession.startTime || '18:00'}`);
        if (isNaN(openMs) || (!isNaN(startMs) && openMs >= startMs)) {
          App.showToast("Giờ mở bình chọn phải hợp lệ và trước giờ bắt đầu buổi đánh!", "warning");
          return;
        }
        newSession.voteOpenAt = openAt;
      } else if (window.VoteScheduler) {
        newSession.voteOpenAt = '';
        VoteScheduler.addNotice(newSession, 'vote_open');
      }

      data.sessions.unshift(newSession);
      AppStorage.saveData(data);
      App.closeModal();
      App.showToast(newSession.voteOpenAt
        ? `⏰ Đã tạo lịch, bình chọn tự mở lúc ${VoteScheduler.formatLabel(newSession.voteOpenAt)}`
        : `🎉 Đã tạo ${voteMode === 'multi_option' ? 'khảo sát chọn sân & giờ' : 'lịch đặt sân'} và thông báo mở bình chọn!`, "success");
      
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
    if (!AppStorage.can('schedule')) {
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
        <div class="font-bold text-main" style="font-size: 1.05rem; margin-bottom: 0.4rem;">${Safe.html(session.title)}</div>
        <div class="text-secondary" style="font-size: 0.85rem; line-height: 1.6;">
          <div><i class="far fa-calendar-alt text-primary" style="width: 16px;"></i> <strong>Ngày:</strong> ${Safe.html(session.date)} (${Safe.html(session.startTime)} - ${Safe.html(session.endTime)})</div>
          <div><i class="fas fa-map-marker-alt text-primary" style="width: 16px;"></i> <strong>Địa điểm:</strong> ${Safe.html(session.courtName)} (${Safe.html(session.courtNumbers)})</div>
          <div><i class="fas fa-users text-primary" style="width: 16px;"></i> <strong>Dữ liệu ảnh hưởng:</strong> ${Safe.html(voterSummary)}</div>
        </div>
      </div>

      <div style="background: rgba(239, 68, 68, 0.08); border-left: 3px solid var(--danger); padding: 0.75rem 1rem; border-radius: var(--radius-sm); margin-bottom: 1.25rem; font-size: 0.84rem; color: var(--text-main);">
        <i class="fas fa-exclamation-triangle text-danger"></i> <strong>Lưu ý:</strong> Toàn bộ lượt bình chọn của các thành viên sẽ bị xóa và đồng bộ cập nhật trên Lịch tháng, Dashboard ngay lập tức.
      </div>

      <div class="modal-footer" style="padding: 0; display: flex; gap: 0.5rem; justify-content: flex-end;">
        <button type="button" class="btn btn-secondary" onclick="App.closeModal()">
          <i class="fas fa-times"></i> Hủy bỏ
        </button>
        <button type="button" class="btn btn-danger" onclick="ScheduleModule.deleteSession(${Safe.js(session.id)})">
          <i class="fas fa-trash-alt"></i> Xác nhận xóa vĩnh viễn
        </button>
      </div>
    `;

    App.openModal("⚠️ Xác nhận xóa buổi đặt sân", modalBody, true);
  },

  deleteSession(sessionId) {
    if (!AppStorage.can('schedule')) {
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
    if (!AppStorage.can('schedule')) {
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
        <h3 style="font-size:1.1rem; color:var(--text-main); margin-bottom:0.3rem;">${Safe.html(session.title)}</h3>
        <div style="font-size:0.85rem; color:var(--text-secondary); margin-bottom:0.75rem;">${Safe.html(session.date)} • ${Safe.html(session.startTime)}–${Safe.html(session.endTime)} • ${Safe.html(session.courtName || 'Sân CLB')}</div>
        <div>Trạng thái hiện tại: <span class="badge ${cur.cls}">${cur.label}</span></div>
      </div>

      <div class="session-status-btn-row" style="grid-template-columns: 1fr 1fr; margin-bottom:1rem;">
        <button class="session-status-btn ${currentStatus === 'open' ? 'is-current' : ''}" onclick="ScheduleModule.changeSessionStatus(${Safe.js(sessionId)}, 'open')" ${currentStatus === 'open' ? 'disabled' : ''}>
          <i class="fas fa-door-open"></i>
          <span>Đang mở vote</span>
          <small>Trạng thái ban đầu</small>
        </button>
        <button class="session-status-btn ${currentStatus === 'booked' ? 'is-current' : ''}" onclick="ScheduleModule.changeSessionStatus(${Safe.js(sessionId)}, 'booked')" ${currentStatus === 'booked' ? 'disabled' : ''}>
          <i class="fas fa-calendar-check"></i>
          <span>Đã đặt sân</span>
          <small>Admin xác nhận với sân</small>
        </button>
        <button class="session-status-btn ${currentStatus === 'completed' ? 'is-current' : ''} btn-completed" onclick="ScheduleModule.changeSessionStatus(${Safe.js(sessionId)}, 'completed')" ${currentStatus === 'completed' ? 'disabled' : ''}>
          <i class="fas fa-flag-checkered"></i>
          <span>Đã diễn ra</span>
          <small>Buổi đánh kết thúc</small>
        </button>
        <button class="session-status-btn ${currentStatus === 'cancelled' ? 'is-current' : ''} btn-cancelled" onclick="ScheduleModule.changeSessionStatus(${Safe.js(sessionId)}, 'cancelled')" ${currentStatus === 'cancelled' ? 'disabled' : ''}>
          <i class="fas fa-times-circle"></i>
          <span>Hủy buổi</span>
          <small>Không tổ chức nữa</small>
        </button>
        ${window.VoteScheduler ? VoteScheduler.renderAdminButton(session) : ''}
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
    if (!AppStorage.can('schedule')) {
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
    if ((newStatus === 'booked' || newStatus === 'cancelled') && window.VoteScheduler) {
      VoteScheduler.addNotice(session, newStatus);
    }

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
      `${statusLabels[newStatus] || newStatus} — Buổi "${session.title}" đã được cập nhật!`,
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
  },
});
