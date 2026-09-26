// Settings & Club Administration Module

const SettingsModule = {
  renderSettings() {
    if (!AppStorage.isAdmin()) {
      App.showToast("Trang Cài đặt & Quản trị chỉ dành riêng cho Ban quản trị CLB!", "warning");
      App.showAuthModal('login');
      return;
    }

    const data = AppStorage.loadData();
    const info = data.clubInfo;
    const bank = info.bank;

    // Fill general inputs
    this.setValue('set-club-name', info.name);
    this.setValue('set-club-short', info.shortName);
    this.setValue('set-club-slogan', info.slogan);
    this.setValue('set-court-default', info.defaultCourt);
    this.setValue('set-court-address', info.address);
    this.setValue('set-court-map-url', info.mapUrl || '');
    this.setValue('set-monthly-fee', info.monthlyFee);
    this.setValue('set-guest-fee', info.guestFee);
    this.setValue('set-lock-hours', info.voteLockHours || 48);

    const autoApproveToggle = document.getElementById('set-auto-approve');
    if (autoApproveToggle) {
      autoApproveToggle.checked = info.autoApprove === true;
    }

    // Fill Bank info
    this.setValue('set-bank-id', bank.bankId);
    this.setValue('set-bank-account-no', bank.accountNo);
    this.setValue('set-bank-account-name', bank.accountName);

    // Render Members Admin List
    this.renderMembersAdmin();
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
    data.clubInfo.slogan = document.getElementById('set-club-slogan').value.trim();
    data.clubInfo.defaultCourt = document.getElementById('set-court-default').value.trim();
    data.clubInfo.address = document.getElementById('set-court-address').value.trim();
    const mapUrlInput = document.getElementById('set-court-map-url')?.value.trim();
    data.clubInfo.mapUrl = mapUrlInput || (data.clubInfo.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(data.clubInfo.address)}` : '');
    data.clubInfo.monthlyFee = parseInt(document.getElementById('set-monthly-fee').value) || 300000;
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
        <div style="text-align: center; padding: 2.5rem 1rem; color: var(--text-muted); background: var(--bg-input); border-radius: var(--radius-md); border: 1px dashed var(--border-color);">
          <div style="width: 52px; height: 52px; border-radius: 50%; background: rgba(16, 185, 129, 0.1); color: var(--primary); display: inline-flex; align-items: center; justify-content: center; font-size: 1.5rem; margin-bottom: 0.75rem;">
            <i class="fas fa-user-plus"></i>
          </div>
          <div style="font-weight: 700; color: var(--text-main); font-size: 1rem; margin-bottom: 0.35rem;">Chưa có thành viên nào trong danh sách</div>
          <p style="font-size: 0.85rem; margin-bottom: 1rem; max-width: 380px; margin-left: auto; margin-right: auto;">
            CLB đang sẵn sàng nhận đăng ký. Bạn có thể bấm <strong>"+ Thêm mới"</strong> hoặc hướng dẫn thành viên bấm <strong>"Đăng ký thành viên mới"</strong> trên thanh menu.
          </p>
          <button class="btn btn-primary btn-sm" onclick="SettingsModule.openAddMemberModal()">
            <i class="fas fa-user-plus"></i> Thêm thành viên đầu tiên
          </button>
        </div>
      `;
      return;
    }

    container.innerHTML = members.map((m, idx) => `
      <div class="card" style="padding: 0.85rem 1rem; margin-bottom: 0.6rem; display: flex; align-items: center; justify-content: space-between; background: var(--bg-input);">
        <div class="flex items-center gap-3">
          <img class="avatar" src="${m.avatar}" alt="${m.name}">
          <div>
            <div class="font-bold flex items-center gap-2">
              ${m.name}
              <span class="badge ${m.role === 'admin' ? 'badge-warning' : m.role === 'treasurer' ? 'badge-info' : 'badge-neutral'}" style="font-size: 0.65rem;">
                ${m.role === 'admin' ? 'Admin' : m.role === 'treasurer' ? 'Thủ quỹ' : 'Thành viên'}
              </span>
              <span class="badge ${m.type === 'fixed' ? 'badge-paid' : 'badge-warning'}" style="font-size: 0.65rem;">
                ${m.type === 'fixed' ? 'Cố định' : 'Vãng lai'}
              </span>
            </div>
            <div class="text-secondary" style="font-size: 0.78rem;">
              <i class="fas fa-phone-alt"></i> ${m.phone}
            </div>
          </div>
        </div>

        <div class="flex gap-2">
          <button class="btn btn-secondary btn-sm" onclick="SettingsModule.openEditMemberModal('${m.id}')" title="Sửa thông tin">
            <i class="fas fa-edit"></i>
          </button>
          <button class="btn btn-outline-danger btn-sm" onclick="SettingsModule.deleteMember('${m.id}')" title="Xóa thành viên">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>
    `).join('');
  },

  openAddMemberModal() {
    const modalBody = `
      <form onsubmit="SettingsModule.saveNewMember(event)">
        <div class="form-group">
          <label class="form-label">Họ và tên *</label>
          <input type="text" id="new-mem-name" class="form-control" placeholder="VD: Nguyễn Văn B" required>
        </div>

        <div class="form-group">
          <label class="form-label">Số điện thoại (Zalo) *</label>
          <input type="tel" id="new-mem-phone" class="form-control" placeholder="0912345678" required>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
          <div class="form-group">
            <label class="form-label">Loại thành viên</label>
            <select id="new-mem-type" class="form-select">
              <option value="fixed">Cố định (Góp quỹ tháng)</option>
              <option value="guest">Vãng lai (Thu theo buổi)</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Vai trò trong CLB</label>
            <select id="new-mem-role" class="form-select">
              <option value="member">Thành viên</option>
              <option value="treasurer">Thủ quỹ</option>
              <option value="admin">Quản trị viên</option>
            </select>
          </div>
        </div>

        <div class="modal-footer" style="padding: 1rem 0 0 0;">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Hủy</button>
          <button type="submit" class="btn btn-primary"><i class="fas fa-user-plus"></i> Thêm thành viên</button>
        </div>
      </form>
    `;

    App.openModal("👤 Thêm thành viên mới vào CLB", modalBody);
  },

  saveNewMember(e) {
    e.preventDefault();
    const data = AppStorage.loadData();
    const name = document.getElementById('new-mem-name').value.trim();
    const phone = document.getElementById('new-mem-phone').value.trim();
    const type = document.getElementById('new-mem-type').value;
    const role = document.getElementById('new-mem-role').value;
    const cleanPhone = phone.replace(/\D/g, '');

    const newMemId = "mem_" + Date.now();
    const newUserId = "user_" + Date.now();
    const username = (cleanPhone && cleanPhone.length >= 9) ? cleanPhone : (name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, '') + Math.floor(100 + Math.random() * 900));

    const newMem = {
      id: newMemId,
      username,
      name,
      phone,
      type,
      role,
      avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=10b981&color=fff`,
      joinDate: new Date().toISOString().slice(0, 10)
    };

    const newUser = {
      id: newUserId,
      username,
      password: (cleanPhone && cleanPhone.length >= 6) ? cleanPhone : '123456',
      name,
      phone,
      role,
      memberId: newMemId,
      type,
      avatar: newMem.avatar,
      createdAt: new Date().toISOString()
    };

    if (!data.members) data.members = [];
    if (!data.users) data.users = [];

    data.members.push(newMem);
    const existUserIdx = data.users.findIndex(u => u.username === username || (cleanPhone && u.phone && u.phone.replace(/\D/g, '') === cleanPhone));
    if (existUserIdx >= 0) {
      data.users[existUserIdx] = { ...data.users[existUserIdx], ...newUser };
    } else {
      data.users.push(newUser);
    }

    if (type === 'fixed') {
      const currentMonth = "2026-09";
      if (!data.monthlyContributions) data.monthlyContributions = [];
      if (!data.monthlyContributions.some(d => d.memberId === newMemId && d.month === currentMonth)) {
        data.monthlyContributions.push({
          id: `due_${currentMonth}_${newMemId}`,
          month: currentMonth,
          memberId: newMemId,
          amount: data.clubInfo.monthlyFee || 300000,
          status: 'unpaid',
          paidAt: null,
          method: null,
          billImage: null,
          approvedBy: null,
          approvedAt: null,
          note: 'Thành viên mới'
        });
      }
    }

    AppStorage.saveData(data, true);
    App.closeModal();
    App.showToast(`Đã thêm thành viên "${name}" thành công! (Tài khoản: ${username} | MK: ${newUser.password})`, "success");
    this.renderMembersAdmin();
    App.renderUserRoleSelector();
    App.renderUserHeaderAndSidebar();
    if (window.App && typeof App.refreshDashboardStats === 'function') App.refreshDashboardStats();
    if (window.FundModule && typeof FundModule.renderFundDashboard === 'function') FundModule.renderFundDashboard();
  },

  openEditMemberModal(memberId) {
    const data = AppStorage.loadData();
    const m = (data.members || []).find(mem => mem.id === memberId);
    if (!m) return;

    const modalBody = `
      <form onsubmit="SettingsModule.saveEditMember(event, '${m.id}')">
        <div class="form-group">
          <label class="form-label">Họ và tên</label>
          <input type="text" id="edit-mem-name" class="form-control" value="${m.name}" required>
        </div>

        <div class="form-group">
          <label class="form-label">Số điện thoại</label>
          <input type="tel" id="edit-mem-phone" class="form-control" value="${m.phone}" required>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
          <div class="form-group">
            <label class="form-label">Loại thành viên</label>
            <select id="edit-mem-type" class="form-select">
              <option value="fixed" ${m.type === 'fixed' ? 'selected' : ''}>Cố định</option>
              <option value="guest" ${m.type === 'guest' ? 'selected' : ''}>Vãng lai</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Vai trò</label>
            <select id="edit-mem-role" class="form-select">
              <option value="member" ${m.role === 'member' ? 'selected' : ''}>Thành viên</option>
              <option value="treasurer" ${m.role === 'treasurer' ? 'selected' : ''}>Thủ quỹ</option>
              <option value="admin" ${m.role === 'admin' ? 'selected' : ''}>Quản trị viên</option>
            </select>
          </div>
        </div>

        <div class="modal-footer" style="padding: 1rem 0 0 0;">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Hủy</button>
          <button type="submit" class="btn btn-primary">Lưu thay đổi</button>
        </div>
      </form>
    `;

    App.openModal("✏️ Chỉnh sửa thông tin thành viên", modalBody);
  },

  saveEditMember(e, memberId) {
    e.preventDefault();
    const data = AppStorage.loadData();
    const m = (data.members || []).find(mem => mem.id === memberId);
    if (!m) return;

    m.name = document.getElementById('edit-mem-name').value.trim();
    m.phone = document.getElementById('edit-mem-phone').value.trim();
    m.type = document.getElementById('edit-mem-type').value;
    m.role = document.getElementById('edit-mem-role').value;

    // Update corresponding user record if exists
    const user = (data.users || []).find(u => u.memberId === memberId || (u.phone && m.phone && u.phone.replace(/\D/g, '') === m.phone.replace(/\D/g, '')));
    if (user) {
      user.name = m.name;
      user.phone = m.phone;
      user.role = m.role;
      user.type = m.type;
    }

    AppStorage.saveData(data, true);
    App.closeModal();
    App.showToast("Đã cập nhật thông tin thành viên thành công!", "success");
    this.renderMembersAdmin();
    App.renderUserRoleSelector();
    App.renderUserHeaderAndSidebar();
    if (window.App && typeof App.refreshDashboardStats === 'function') App.refreshDashboardStats();
    if (window.FundModule && typeof FundModule.renderFundDashboard === 'function') FundModule.renderFundDashboard();
  },

  deleteMember(memberId) {
    if (!confirm("Bạn có chắc chắn muốn xóa thành viên này khỏi CLB?")) return;
    const data = AppStorage.loadData();
    data.members = (data.members || []).filter(m => m.id !== memberId);
    data.users = (data.users || []).filter(u => u.memberId !== memberId && u.username !== 'admin');
    if (data.monthlyContributions) {
      data.monthlyContributions = data.monthlyContributions.filter(d => d.memberId !== memberId);
    }
    AppStorage.saveData(data, true);
    this.renderMembersAdmin();
    App.renderUserRoleSelector();
    App.renderUserHeaderAndSidebar();
    if (window.App && typeof App.refreshDashboardStats === 'function') App.refreshDashboardStats();
    if (window.FundModule && typeof FundModule.renderFundDashboard === 'function') FundModule.renderFundDashboard();
    App.showToast("Đã xóa thành viên khỏi danh sách CLB!", "info");
  },

  // Public User-Facing Member Registration
  handlePublicMemberRegistration(e) {
    e.preventDefault();
    const data = AppStorage.loadData();
    const name = document.getElementById('reg-name').value.trim();
    const phone = document.getElementById('reg-phone').value.trim();
    const type = document.getElementById('reg-type').value;
    const note = document.getElementById('reg-note')?.value.trim() || '';
    const cleanPhone = phone.replace(/\D/g, '');

    // Check duplicate phone
    if ((data.members || []).some(m => m.phone && m.phone.replace(/\D/g, '') === cleanPhone)) {
      App.showToast("Số điện thoại này đã được đăng ký thành viên trước đó!", "warning");
      return;
    }

    const newMemberId = "mem_" + Date.now();
    const newUserId = "user_" + Date.now();
    const username = (cleanPhone && cleanPhone.length >= 9) ? cleanPhone : (name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, '') + Math.floor(100 + Math.random() * 900));

    const newMember = {
      id: newMemberId,
      username,
      name,
      phone,
      type,
      role: "member",
      avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=10b981&color=fff`,
      joinDate: new Date().toISOString().slice(0, 10),
      note
    };

    const newUser = {
      id: newUserId,
      username,
      password: (cleanPhone && cleanPhone.length >= 6) ? cleanPhone : '123456',
      name,
      phone,
      role: "member",
      memberId: newMemberId,
      type,
      avatar: newMember.avatar,
      createdAt: new Date().toISOString()
    };

    if (!data.members) data.members = [];
    if (!data.users) data.users = [];
    data.members.push(newMember);
    data.users.push(newUser);

    // If type is fixed, create unpaid record for current month
    if (type === 'fixed') {
      const currentMonth = "2026-09";
      if (!data.monthlyContributions) data.monthlyContributions = [];
      data.monthlyContributions.push({
        id: `due_${currentMonth}_${newMember.id}`,
        month: currentMonth,
        memberId: newMember.id,
        amount: data.clubInfo.monthlyFee || 300000,
        status: 'unpaid',
        paidAt: null,
        method: null,
        billImage: null,
        approvedBy: null,
        approvedAt: null,
        note: 'Thành viên mới đăng ký'
      });
    }

    // Tự động đăng nhập luôn tài khoản thành viên mới
    data.currentUser = newUser;
    AppStorage.saveData(data, true);

    const now = Date.now();
    const sessionData = {
      id: newUser.id,
      username: newUser.username,
      name: newUser.name,
      role: newUser.role,
      memberId: newUser.memberId,
      loginAt: new Date().toISOString(),
      lastActivity: now,
      remember: true,
      expiresAt: now + (30 * 24 * 60 * 60 * 1000)
    };
    localStorage.removeItem('SMASH_PRO_LOGGED_OUT');
    localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(sessionData));

    // Reset form
    e.target.reset();

    if (window.confetti) {
      window.confetti({ particleCount: 90, spread: 80, origin: { y: 0.6 } });
    }

    App.showToast(`🎉 Chúc mừng ${name}! Bạn đã gia nhập CLB và đăng nhập thành công!`, "success");
    this.renderPublicMemberRoster();
    App.renderUserRoleSelector();
    App.renderUserHeaderAndSidebar();
    App.refreshDashboardStats();
    if (window.FundModule && typeof FundModule.renderFundDashboard === 'function') FundModule.renderFundDashboard();
  },

  renderPublicMemberRoster() {
    const data = AppStorage.loadData();
    const members = data.members || [];
    const container = document.getElementById('public-member-roster');
    const badge = document.getElementById('reg-member-count-badge');

    if (badge) badge.innerText = `${members.length} thành viên`;
    if (!container) return;

    if (members.length === 0) {
      container.innerHTML = `<span class="text-muted" style="font-size: 0.85rem; font-style: italic;">Chưa có thành viên nào. Hãy là người đầu tiên đăng ký gia nhập CLB!</span>`;
      return;
    }

    container.innerHTML = members.map(m => `
      <div class="badge badge-neutral" style="padding: 0.35rem 0.6rem; display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.8rem;">
        <img class="avatar avatar-sm" src="${m.avatar}" alt="${m.name}" style="width: 20px; height: 20px;">
        <span>${m.name}</span>
        <span class="badge ${m.type === 'fixed' ? 'badge-paid' : 'badge-warning'}" style="font-size: 0.65rem; padding: 0.05rem 0.3rem;">
          ${m.type === 'fixed' ? 'Cố định' : 'Vãng lai'}
        </span>
      </div>
    `).join('');
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
  }
};


