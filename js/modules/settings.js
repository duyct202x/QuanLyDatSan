// Settings & Club Administration Module

const SettingsModule = {
  renderSettings() {
    if (!AppStorage.isAdmin()) {
      App.showToast("Trang Cài đặt & Quản trị chỉ dành riêng cho Ban quản trị CLB!", "warning");
      App.showAuthModal('login');
      return;
    }

    try {
      const data = AppStorage.loadData();
      const info = data.clubInfo || {};
      const bank = info.bank || {};

      // Fill general inputs
      this.setValue('set-club-name', info.name || '');
      this.setValue('set-club-short', info.shortName || '');
      this.setValue('set-club-season', info.season || 'Mùa giải 2026');
      this.setValue('set-club-slogan', info.slogan || '');
      this.setValue('set-court-default', info.defaultCourt || '');
      this.setValue('set-court-address', info.address || '');
      this.setValue('set-club-banner-subtitle', info.bannerSubtitle || '');
      this.setValue('set-court-map-url', info.mapUrl || '');
      this.setValue('set-monthly-fee', info.monthlyFee || info.monthlyFundFee || 20000);
      this.setValue('set-guest-fee', info.guestFee || 60000);
      this.setValue('set-lock-hours', info.voteLockHours || 48);

      const autoApproveToggle = document.getElementById('set-auto-approve');
      if (autoApproveToggle) {
        autoApproveToggle.checked = info.autoApprove === true;
      }

      // Fill Bank info
      this.setValue('set-bank-id', bank.bankId || 'MB');
      this.setValue('set-bank-account-no', bank.accountNo || '');
      this.setValue('set-bank-account-name', bank.accountName || '');

      // Render Members Admin List
      this.renderMembersAdmin();
    } catch (err) {
      console.error("Lỗi khi render trang Cài đặt:", err);
    }
  },

  setValue(id, val) {
    const el = document.getElementById(id);
    if (el && val !== undefined) el.value = val;
  },

  saveClubSettings(e) {
    e.preventDefault();
    if (!AppStorage.isAdmin()) {
      App.showToast("Chỉ Ban quản trị mới có quyền lưu cấu hình CLB!", "warning");
      App.showAuthModal('login');
      return;
    }
    const data = AppStorage.loadData();

    data.clubInfo.name = document.getElementById('set-club-name').value.trim();
    data.clubInfo.shortName = document.getElementById('set-club-short').value.trim();
    data.clubInfo.season = document.getElementById('set-club-season')?.value.trim() || 'Mùa giải 2026';
    data.clubInfo.slogan = document.getElementById('set-club-slogan').value.trim();
    data.clubInfo.defaultCourt = document.getElementById('set-court-default').value.trim();
    data.clubInfo.address = document.getElementById('set-court-address').value.trim();
    data.clubInfo.bannerSubtitle = document.getElementById('set-club-banner-subtitle')?.value.trim() || '';
    const mapUrlInput = document.getElementById('set-court-map-url')?.value.trim();
    data.clubInfo.mapUrl = mapUrlInput || (data.clubInfo.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(data.clubInfo.address)}` : '');
    data.clubInfo.monthlyFee = parseInt(document.getElementById('set-monthly-fee').value) || 20000;
    data.clubInfo.monthlyFundFee = data.clubInfo.monthlyFee;
    data.clubInfo.guestFee = parseInt(document.getElementById('set-guest-fee').value) || 60000;
    data.clubInfo.voteLockHours = parseInt(document.getElementById('set-lock-hours').value) || 48;
    data.clubInfo.autoApprove = document.getElementById('set-auto-approve').checked;

    data.clubInfo.bank.bankId = document.getElementById('set-bank-id').value;
    data.clubInfo.bank.accountNo = document.getElementById('set-bank-account-no').value.trim();
    data.clubInfo.bank.accountName = document.getElementById('set-bank-account-name').value.trim().toUpperCase();

    // Also update bank name display text
    const bankSelect = document.getElementById('set-bank-id');
    const selectedOption = bankSelect.options[bankSelect.selectedIndex];
    data.clubInfo.bank.bankName = selectedOption ? selectedOption.text : 'Ngân hàng';

    AppStorage.saveData(data);
    App.showToast("Đã lưu các cài đặt CLB & quy tắc đóng vote thành công!", "success");
    App.refreshDashboardStats();
  },

  renderMembersAdmin() {
    const data = AppStorage.loadData();
    const members = data.members || [];
    const container = document.getElementById('members-admin-list');
    if (!container) return;

    if (members.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 2.25rem 1rem; color: var(--text-muted); background: var(--bg-input); border-radius: var(--radius-md); border: 1px dashed var(--border-color);">
          <div style="width: 52px; height: 52px; border-radius: 50%; background: rgba(16, 185, 129, 0.1); color: var(--primary); display: inline-flex; align-items: center; justify-content: center; font-size: 1.5rem; margin-bottom: 0.75rem;">
            <i class="fas fa-user-plus"></i>
          </div>
          <div style="font-weight: 700; color: var(--text-main); font-size: 1rem; margin-bottom: 0.35rem;">Chưa có thành viên nào trong danh sách</div>
          <p style="font-size: 0.85rem; margin-bottom: 1rem; max-width: 380px; margin-left: auto; margin-right: auto;">
            CLB đang sẵn sàng nhận đăng ký. Bạn có thể bấm <strong>"+ Thêm mới"</strong> hoặc quản lý toàn diện trong tab <strong>"Thành viên CLB"</strong>.
          </p>
          <div class="flex gap-2 justify-center flex-wrap">
            <button class="btn btn-primary btn-sm" onclick="MembersModule.openAddMemberModal()">
              <i class="fas fa-user-plus"></i> Thêm thành viên
            </button>
            <button class="btn btn-secondary btn-sm" onclick="App.openTab('members')">
              <i class="fas fa-users"></i> Xem trang Quản lý thành viên
            </button>
          </div>
        </div>
      `;
      return;
    }

    container.innerHTML = members.map((m) => `
      <div class="card" style="padding: 0.75rem 1rem; margin-bottom: 0.5rem; display: flex; align-items: center; justify-content: space-between; background: var(--bg-input);">
        <div class="flex items-center gap-3">
          <img class="avatar avatar-sm" src="${m.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(m.name)}&background=10b981&color=fff`}" alt="${m.name}" style="width: 32px; height: 32px; border-radius: 50%;">
          <div>
            <div class="font-bold flex items-center gap-2" style="font-size: 0.9rem;">
              ${m.name}
              <span class="badge ${m.role === 'admin' ? 'badge-warning' : m.role === 'treasurer' ? 'badge-info' : 'badge-neutral'}" style="font-size: 0.65rem;">
                ${m.role === 'admin' ? 'Admin' : m.role === 'treasurer' ? 'Thủ quỹ' : 'Thành viên'}
              </span>
              <span class="badge ${m.type === 'fixed' ? 'badge-paid' : 'badge-warning'}" style="font-size: 0.65rem;">
                ${m.type === 'fixed' ? 'Cố định' : 'Vãng lai'}
              </span>
            </div>
            <div class="text-secondary" style="font-size: 0.76rem;">
              <i class="fas fa-phone-alt"></i> ${m.phone}
            </div>
          </div>
        </div>

        <div class="flex gap-2">
          <button class="btn btn-secondary btn-sm" onclick="MembersModule.openEditMemberModal('${m.id}')" title="Sửa thông tin">
            <i class="fas fa-edit"></i>
          </button>
          <button class="btn btn-outline-danger btn-sm" onclick="MembersModule.deleteMember('${m.id}')" title="Xóa thành viên">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>
    `).join('');
  },

  openAddMemberModal() {
    if (window.MembersModule) MembersModule.openAddMemberModal();
  },

  saveNewMember(e) {
    if (window.MembersModule) MembersModule.saveNewMember(e);
  },

  openEditMemberModal(memberId) {
    if (window.MembersModule) MembersModule.openEditMemberModal(memberId);
  },

  saveEditMember(e, memberId) {
    if (window.MembersModule) MembersModule.saveEditMember(e, memberId);
  },

  deleteMember(memberId) {
    if (window.MembersModule) MembersModule.deleteMember(memberId);
  },

  handlePublicMemberRegistration(e) {
    if (window.MembersModule) MembersModule.handlePublicMemberRegistration(e);
  },

  renderPublicMemberRoster() {
    if (window.MembersModule) MembersModule.renderPublicMemberRoster();
  },

  // Toggle giữa CSDL Vận hành thực tế và CSDL Dữ liệu thử nghiệm (Chỉ Admin)
  switchDatabaseEnvironment(mode) {
    const isTest = mode === 'test';
    const confirmMsg = isTest 
      ? "Chuyển sang chế độ CSDL KIỂM THỬ (TEST DEMO) với dữ liệu mẫu 10 thành viên và các buổi đánh thử nghiệm?" 
      : "Chuyển sang chế độ CSDL VẬN HÀNH THỰC TẾ (PRODUCTION)?";

    if (!confirm(confirmMsg)) return;

    const updated = AppStorage.switchDatabaseMode(mode);
    App.showToast(`Đã chuyển sang môi trường: ${isTest ? 'CSDL Kiểm thử (Test Demo)' : 'CSDL Vận hành thực tế (Production)'}`, "success");
    App.renderUserHeaderAndSidebar();
    App.refreshDashboardStats();
    App.openTab('dashboard');
  },

  // Modal chỉnh sửa nhanh thông tin Banner trang chủ (Dành cho Admin)
  openEditHeroBannerModal() {
    if (!AppStorage.isAdmin()) {
      App.showToast("Chỉ Quản trị viên mới có quyền chỉnh sửa thông tin Banner!", "warning");
      App.showAuthModal('login');
      return;
    }

    const data = AppStorage.loadData();
    const info = data.clubInfo || {};
    const lockHours = info.voteLockHours || 48;
    const lockDays = Math.round(lockHours / 24);
    const lockText = lockDays > 0 ? `Tự động đóng vote trước giờ đánh ${lockDays} ngày` : `Tự động đóng vote trước giờ đánh ${lockHours} giờ`;
    const defaultSub = `${info.defaultCourt ? info.defaultCourt + ' • ' : ''}${lockText}`;

    const html = `
      <form onsubmit="SettingsModule.saveHeroBannerFromModal(event)">
        <div style="margin-bottom: 1rem; color: var(--text-muted); font-size: 0.88rem;">
          Tùy chỉnh tiêu đề, mùa giải và dòng thông tin hiển thị trên <strong>Banner trang chủ (Dashboard)</strong>:
        </div>

        <div class="form-group">
          <label class="form-label font-bold"><i class="fas fa-heading text-primary"></i> Tên Câu Lạc Bộ (Tiêu đề Banner) *</label>
          <input type="text" id="modal-banner-name" class="form-control" value="${info.name || 'SMASH PRO Badminton Club'}" required placeholder="VD: SMASH PRO BADMINTON CLUB">
        </div>

        <div class="responsive-form-row">
          <div class="form-group">
            <label class="form-label font-bold"><i class="fas fa-fire text-warning"></i> Mùa giải / Huy hiệu</label>
            <input type="text" id="modal-banner-season" class="form-control" value="${info.season || 'Mùa giải 2026'}" placeholder="VD: Mùa giải 2026">
          </div>
          <div class="form-group">
            <div class="flex items-center justify-between" style="margin-bottom: 0.35rem;">
              <label class="form-label font-bold" style="margin-bottom: 0;"><i class="fas fa-home text-primary"></i> Sân nhà mặc định</label>
              <button type="button" class="btn btn-ghost btn-icon btn-xs" onclick="ScheduleModule.openEditCourtLocationModal('club')" title="Admin: Sửa vị trí & bản đồ sân nhà" style="border: 1px solid var(--border-color); border-radius: var(--radius-sm);">
                <i class="fas fa-pencil-alt text-warning"></i>
              </button>
            </div>
            <input type="text" id="modal-banner-court" class="form-control" value="${info.defaultCourt || ''}" placeholder="VD: Sân cầu lông CLB (Sân 1 & 2)">
          </div>
        </div>

        <div class="form-group">
          <label class="form-label font-bold"><i class="fas fa-location-arrow text-primary"></i> Địa chỉ sân nhà CLB</label>
          <input type="text" id="modal-banner-address" class="form-control" value="${info.address || ''}" placeholder="VD: Số 123 Đường ABC, Quận XYZ, TP. Hồ Chí Minh">
        </div>

        <div class="form-group">
          <div class="flex items-center justify-between" style="margin-bottom: 0.35rem;">
            <label class="form-label font-bold" style="margin-bottom: 0;"><i class="fas fa-map-marker-alt text-primary"></i> Dòng thông tin phụ / Ghi chú Banner</label>
            <button type="button" class="btn btn-outline-primary btn-sm" onclick="document.getElementById('modal-banner-sub').value='${defaultSub}'" style="padding: 0.15rem 0.45rem; font-size: 0.72rem;">
              <i class="fas fa-magic"></i> Tạo tự động
            </button>
          </div>
          <textarea id="modal-banner-sub" class="form-control" rows="2" placeholder="${defaultSub}">${info.bannerSubtitle || ''}</textarea>
          <span class="text-secondary" style="font-size: 0.75rem; margin-top: 0.25rem; display: block;">
            Dòng này hiển thị trực tiếp với biểu tượng 📍 trên banner. Để trống sẽ tự động hiển thị: <em>[Sân nhà] • Tự động đóng vote trước giờ đánh [X] ngày</em>.
          </span>
        </div>

        <div class="flex gap-2 justify-end" style="margin-top: 1.5rem; border-top: 1px solid var(--border-color); padding-top: 1rem;">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Hủy bỏ</button>
          <button type="submit" class="btn btn-primary">
            <i class="fas fa-save"></i> Lưu thông tin banner
          </button>
        </div>
      </form>
    `;

    App.openModal('<i class="fas fa-edit text-primary"></i> Chỉnh sửa thông tin Banner Trang chủ', html);
  },

  saveHeroBannerFromModal(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (!AppStorage.isAdmin()) {
      App.showToast("Chỉ Quản trị viên mới có quyền chỉnh sửa thông tin Banner!", "warning");
      return;
    }

    const data = AppStorage.loadData();
    if (!data.clubInfo) data.clubInfo = {};

    const name = document.getElementById('modal-banner-name')?.value.trim();
    const season = document.getElementById('modal-banner-season')?.value.trim() || 'Mùa giải 2026';
    const court = document.getElementById('modal-banner-court')?.value.trim();
    const address = document.getElementById('modal-banner-address')?.value.trim();
    const bannerSub = document.getElementById('modal-banner-sub')?.value.trim();

    if (name) data.clubInfo.name = name;
    data.clubInfo.season = season;
    if (court) data.clubInfo.defaultCourt = court;
    if (address) {
      data.clubInfo.address = address;
      if (!data.clubInfo.mapUrl) {
        data.clubInfo.mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
      }
    }
    data.clubInfo.bannerSubtitle = bannerSub;

    AppStorage.saveData(data, true);
    App.closeModal();
    App.refreshDashboardStats();
    App.showToast("🎉 Đã cập nhật và lưu thông tin Banner trang chủ thành công!", "success");
  },

  async confirmResetDatabase() {
    if (!AppStorage.isAdmin()) {
      App.showToast("Chỉ Ban quản trị mới có quyền Reset CSDL!", "warning");
      App.showAuthModal('login');
      return;
    }
    if (!confirm("⚠️ BẠN CÓ CHẮC CHẮN MUỐN ĐẶT LẠI CSDL SẠCH MẶC ĐỊNH?\n\nToàn bộ danh sách thành viên, ca đánh, quỹ tháng và sổ thu chi sẽ được đưa về 0 và đồng bộ làm sạch ngay trên database.")) {
      return;
    }
    await AppStorage.resetData(true);
    App.refreshDashboardStats();
    App.renderUserHeaderAndSidebar();
    App.openTab('dashboard');
  },

  // ==========================================
  // BẢO MẬT & ĐỔI MẬT KHẨU QUẢN TRỊ VIÊN
  // ==========================================
  handleChangeAdminPassword(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (!AppStorage.isAdmin()) {
      App.showToast("Yêu cầu quyền Quản trị viên để đổi mật khẩu!", "warning");
      return;
    }

    const currentUser = AppStorage.getCurrentUser();
    if (!currentUser) {
      App.showToast("Vui lòng đăng nhập tài khoản Quản trị viên!", "warning");
      return;
    }

    const oldPwd = document.getElementById('set-admin-old-pwd')?.value || '';
    const newPwd = document.getElementById('set-admin-new-pwd')?.value || '';
    const confirmPwd = document.getElementById('set-admin-confirm-pwd')?.value || '';

    const result = AppStorage.changePassword(currentUser.id, oldPwd, newPwd, confirmPwd);
    if (result.success) {
      const form = document.getElementById('form-change-admin-password');
      if (form) form.reset();
      App.showToast(`🎉 ${result.message}`, "success");
    } else {
      App.showToast(`⚠️ ${result.message}`, "error");
    }
  },

  openChangeAdminPasswordModal() {
    if (!AppStorage.isAdmin()) {
      App.showToast("Chỉ Quản trị viên mới có quyền đổi mật khẩu!", "warning");
      return;
    }

    const modalBody = `
      <form id="modal-form-change-admin-pwd" onsubmit="SettingsModule.handleModalChangeAdminPassword(event)">
        <div style="text-align: center; margin-bottom: 1.25rem;">
          <div style="width: 52px; height: 52px; border-radius: 50%; background: rgba(16, 185, 129, 0.12); color: var(--primary); display: inline-flex; align-items: center; justify-content: center; font-size: 1.5rem; margin-bottom: 0.5rem;">
            <i class="fas fa-key"></i>
          </div>
          <h3 style="font-size: 1.15rem; color: var(--text-main); margin-bottom: 0.25rem;">Đổi mật khẩu Quản trị viên</h3>
          <p class="text-secondary" style="font-size: 0.82rem;">Thiết lập mật khẩu bảo mật mới cho tài khoản Admin</p>
        </div>

        <div class="form-group">
          <label class="form-label font-bold">Mật khẩu hiện tại *</label>
          <input type="password" id="modal-admin-old-pwd" class="form-control" required placeholder="Nhập mật khẩu hiện tại...">
        </div>

        <div class="form-group">
          <label class="form-label font-bold">Mật khẩu mới *</label>
          <input type="password" id="modal-admin-new-pwd" class="form-control" required placeholder="Tối thiểu 6 ký tự, không dấu cách...">
        </div>

        <div class="form-group">
          <label class="form-label font-bold">Nhập lại mật khẩu mới *</label>
          <input type="password" id="modal-admin-confirm-pwd" class="form-control" required placeholder="Xác nhận lại mật khẩu mới...">
        </div>

        <div class="modal-footer" style="padding: 1rem 0 0 0; display: flex; justify-content: flex-end; gap: 0.5rem;">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Hủy</button>
          <button type="submit" class="btn btn-primary"><i class="fas fa-check-circle"></i> Cập nhật mật khẩu</button>
        </div>
      </form>
    `;

    App.openModal("🔐 Đổi mật khẩu Quản trị viên", modalBody);
    setTimeout(() => document.getElementById('modal-admin-old-pwd')?.focus(), 200);
  },

  handleModalChangeAdminPassword(e) {
    if (e && e.preventDefault) e.preventDefault();
    const currentUser = AppStorage.getCurrentUser();
    if (!currentUser) return;

    const oldPwd = document.getElementById('modal-admin-old-pwd')?.value || '';
    const newPwd = document.getElementById('modal-admin-new-pwd')?.value || '';
    const confirmPwd = document.getElementById('modal-admin-confirm-pwd')?.value || '';

    const result = AppStorage.changePassword(currentUser.id, oldPwd, newPwd, confirmPwd);
    if (result.success) {
      App.closeModal();
      App.showToast(`🎉 ${result.message}`, "success");
    } else {
      App.showToast(`⚠️ ${result.message}`, "error");
    }
  }
};


