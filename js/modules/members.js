// Members Management Module for SMASH PRO Badminton Management System
// Hỗ trợ Danh sách thành viên, Tìm kiếm, Lọc theo loại hình/vai trò, Thêm/Sửa/Xóa và Đăng ký gia nhập

const MembersModule = {
  currentFilter: 'all', // 'all' | 'fixed' | 'guest' | 'admin'
  searchQuery: '',
  currentSubTab: 'list', // 'list' | 'register'

  init() {
    if (AppStorage.isGuest()) {
      this.switchSubTab('register');
    }
    this.renderMembersTab();
    this.renderBenefitsAndRules();
  },

  renderMembersTab() {
    const data = AppStorage.loadData();
    const members = data.members || [];
    const dues = data.monthlyContributions || [];
    const currentMonth = AppStorage.currentMonth();
    const isAdmin = AppStorage.can('members');

    // 1. Tính toán số liệu thống kê (KPIs)
    const fixedMembers = members.filter(m => m.type === 'fixed');
    const guestMembers = members.filter(m => m.type === 'guest');
    const adminMembers = members.filter(m => m.role === 'admin' || m.role === 'treasurer');

    // Cập nhật các thẻ KPI trên tab Thành viên
    const countTotal = document.getElementById('members-kpi-total');
    const countFixed = document.getElementById('members-kpi-fixed');
    const countGuest = document.getElementById('members-kpi-guest');
    const countAdmin = document.getElementById('members-kpi-admin');

    if (countTotal) countTotal.innerText = `${members.length} người`;
    if (countFixed) countFixed.innerText = `${fixedMembers.length} người`;
    if (countGuest) countGuest.innerText = `${guestMembers.length} người`;
    if (countAdmin) countAdmin.innerText = `${adminMembers.length} người`;

    // Cập nhật số lượng trên các nút lọc
    const filterAllCount = document.getElementById('filter-count-all');
    const filterFixedCount = document.getElementById('filter-count-fixed');
    const filterGuestCount = document.getElementById('filter-count-guest');
    const filterAdminCount = document.getElementById('filter-count-admin');

    if (filterAllCount) filterAllCount.innerText = members.length;
    if (filterFixedCount) filterFixedCount.innerText = fixedMembers.length;
    if (filterGuestCount) filterGuestCount.innerText = guestMembers.length;
    if (filterAdminCount) filterAdminCount.innerText = adminMembers.length;

    // 2. Lọc và Tìm kiếm danh sách thành viên
    let filtered = [...members];

    if (this.currentFilter === 'fixed') {
      filtered = filtered.filter(m => m.type === 'fixed');
    } else if (this.currentFilter === 'guest') {
      filtered = filtered.filter(m => m.type === 'guest');
    } else if (this.currentFilter === 'admin') {
      filtered = filtered.filter(m => m.role === 'admin' || m.role === 'treasurer');
    }

    if (this.searchQuery) {
      const q = this.searchQuery.toLowerCase();
      filtered = filtered.filter(m => 
        (m.name && m.name.toLowerCase().includes(q)) || 
        (isAdmin && m.phone && m.phone.includes(q)) ||
        (m.username && m.username.toLowerCase().includes(q))
      );
    }

    // 3. Kết xuất danh sách thành viên ra giao diện
    const container = document.getElementById('members-grid-container');
    if (!container) return;

    if (members.length === 0) {
      // Trạng thái CLB chưa có thành viên nào
      container.innerHTML = `
        <div class="card" style="grid-column: 1 / -1; text-align: center; padding: 3rem 1.5rem; background: var(--bg-card); border: 1px dashed var(--border-color);">
          <div style="width: 64px; height: 64px; border-radius: 50%; background: rgba(16, 185, 129, 0.12); color: var(--primary); display: inline-flex; align-items: center; justify-content: center; font-size: 1.8rem; margin-bottom: 1rem;">
            <i class="fas fa-users-slash"></i>
          </div>
          <h3 style="font-size: 1.2rem; font-weight: 700; color: var(--text-main); margin-bottom: 0.5rem;">Chưa có thành viên nào trong CLB</h3>
          <p style="font-size: 0.9rem; color: var(--text-secondary); max-width: 480px; margin: 0 auto 1.5rem; line-height: 1.6;">
            Hệ thống đang ở trạng thái CSDL sạch. Bạn có thể thêm thành viên mới hoặc gửi link cho các tay vợt tự đăng ký gia nhập CLB!
          </p>
          <div class="flex gap-3 justify-center flex-wrap">
            <button class="btn btn-primary admin-only" onclick="MembersModule.openAddMemberModal()">
              <i class="fas fa-user-plus"></i> Thêm thành viên đầu tiên
            </button>
            <button class="btn btn-secondary" onclick="MembersModule.switchSubTab('register')">
              <i class="fas fa-id-card"></i> Mở phiếu đăng ký gia nhập
            </button>
          </div>
        </div>
      `;
      return;
    }

    if (filtered.length === 0) {
      // Trạng thái tìm kiếm không có kết quả
      container.innerHTML = `
        <div class="card" style="grid-column: 1 / -1; text-align: center; padding: 2.5rem 1.5rem; background: var(--bg-card);">
          <div style="font-size: 2rem; color: var(--text-muted); margin-bottom: 0.75rem;">
            <i class="fas fa-search"></i>
          </div>
          <h4 style="font-size: 1.05rem; font-weight: 700; color: var(--text-main); margin-bottom: 0.35rem;">Không tìm thấy thành viên phù hợp</h4>
          <p style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 1rem;">
            Không có kết quả nào khớp với từ khóa "<strong>${Safe.html(this.searchQuery)}</strong>" trong nhóm đang lọc.
          </p>
          <button class="btn btn-secondary btn-sm" onclick="MembersModule.clearSearch()">
            <i class="fas fa-times"></i> Xóa bộ lọc tìm kiếm
          </button>
        </div>
      `;
      return;
    }

    // Kết xuất danh sách thẻ thành viên với bảo mật quyền riêng tư nghiêm ngặt
    container.innerHTML = filtered.map(m => {
      const isFixed = m.type === 'fixed';
      const isAdminRole = m.role === 'admin';
      const cardUser = (data.users || []).find(u => u.memberId === m.id || (m.username && u.username === m.username));
      const customRole = cardUser ? AppStorage.getRole(cardUser.roleId) : null;
      const isTreasurerRole = m.role === 'treasurer';
      const cleanPhone = (m.phone || '').replace(/\D/g, '');
      const memberDue = isFixed ? dues.find(d => d.memberId === m.id && d.month === currentMonth) : null;
      const isPaidDue = memberDue && memberDue.status === 'paid';
      const isPendingDue = memberDue && memberDue.status === 'pending';

      const canViewContact = AppStorage.canViewMemberContact(m.id, m.phone);
      const isSelf = canViewContact && !isAdmin;
      const maskedPhone = AppStorage.maskPhone(m.phone, m.id);

      return `
        <div class="card card-interactive member-roster-card" style="padding: 1.25rem; display: flex; flex-direction: column; justify-content: space-between; gap: 1rem; border-left: 4px solid ${isAdminRole ? 'var(--warning)' : isTreasurerRole ? 'var(--secondary)' : 'var(--primary)'};">
          <div>
            <!-- Header: Avatar, Name, Badges -->
            <div class="flex items-start justify-between gap-3" style="margin-bottom: 0.75rem;">
              <div class="flex items-center gap-3">
                <div style="position: relative; cursor: pointer;" onclick="MembersModule.handleAvatarClick(${Safe.js(m.id)})" title="${isAdmin ? 'Bấm để đổi Avatar & Sửa thông tin thành viên' : (isSelf ? 'Bấm để đổi Avatar & Sửa hồ sơ của tôi' : `Thành viên ${Safe.html(m.name)}`)}">
                  <img class="avatar avatar-md" src="${Safe.url(m.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(m.name)}&background=10b981&color=fff`)}" alt="${Safe.html(m.name)}" style="width: 48px; height: 48px; border-radius: 50%; object-fit: cover; border: 2px solid var(--border-color);">
                  <span style="position: absolute; bottom: 0; right: 0; width: 12px; height: 12px; border-radius: 50%; background: ${isFixed ? '#10b981' : '#f59e0b'}; border: 2px solid var(--bg-card);" title="${isFixed ? 'Thành viên cố định' : 'Khách vãng lai'}"></span>
                </div>
                <div>
                  <h4 style="font-size: 1rem; font-weight: 700; color: var(--text-main); margin: 0; line-height: 1.3;">${Safe.html(m.name)}</h4>
                  <div style="font-size: 0.76rem; color: var(--text-secondary); margin-top: 0.15rem;">
                    <i class="far fa-calendar-alt"></i> Gia nhập: ${Safe.html(m.joinDate || '2026-09-01')}
                  </div>
                </div>
              </div>

              <!-- Role & Type Badges -->
              <div class="flex flex-col items-end gap-1">
                <span class="badge ${isAdminRole ? 'badge-warning' : isTreasurerRole ? 'badge-info' : 'badge-neutral'}" style="font-size: 0.68rem; font-weight: 700; padding: 0.15rem 0.45rem;">
                  <i class="fas ${isAdminRole ? 'fa-crown' : isTreasurerRole ? 'fa-wallet' : 'fa-user'}"></i>
                  ${isAdminRole ? 'Admin CLB' : isTreasurerRole ? 'Thủ quỹ' : customRole ? Safe.html(customRole.name) : 'Thành viên'}
                </span>
                <span class="badge ${isFixed ? 'badge-paid' : 'badge-warning'}" style="font-size: 0.65rem; padding: 0.1rem 0.4rem;">
                  ${isFixed ? '🏸 Cố định' : '⚡ Vãng lai'}
                </span>
                ${!isFixed && window.MembershipModule && MembershipModule.isPendingMember(m, data) ? `<span class="badge badge-info" style="font-size: 0.62rem; padding: 0.1rem 0.4rem;">⏳ Chờ duyệt cố định</span>` : ''}
                ${isAdmin && !(data.users || []).some(u => u.memberId === m.id || (m.username && u.username === m.username)) ? `<span class="badge badge-neutral" style="font-size: 0.62rem; padding: 0.1rem 0.4rem;" title="Chỉ được ghi tên, chưa có tài khoản đăng nhập"><i class="fas fa-user-slash"></i> Chưa có tài khoản</span>` : ''}
              </div>
            </div>

            <!-- Details: Phone, Zalo, Dues Status (Bảo mật quyền riêng tư) -->
            <div style="background: var(--bg-input); padding: 0.65rem 0.85rem; border-radius: var(--radius-md); font-size: 0.82rem; display: flex; flex-direction: column; gap: 0.4rem; border: 1px solid var(--border-color);">
              <div class="flex items-center justify-between">
                <span class="text-secondary"><i class="fas fa-phone-alt text-primary"></i> SĐT / Zalo:</span>
                <div class="flex items-center gap-2">
                  ${canViewContact && !m.phone ? `<span class="text-muted" style="font-size: 0.78rem;">Chưa có SĐT</span>` : canViewContact ? `
                    <a href="tel:${Safe.html(m.phone)}" class="font-mono font-bold" style="color: var(--text-main); text-decoration: none;" title="Bấm để gọi">${Safe.html(m.phone)}</a>
                    ${cleanPhone ? `<a href="https://zalo.me/${cleanPhone}" target="_blank" rel="noopener" class="badge badge-info" style="font-size: 0.65rem; padding: 0.1rem 0.35rem;" title="Mở Zalo"><i class="fas fa-comment-dots"></i> Zalo</a>` : ''}
                  ` : `
                    <span class="font-mono text-muted font-bold" title="Thông tin được ẩn để bảo vệ quyền riêng tư">${Safe.html(maskedPhone)}</span>
                    <span class="badge badge-neutral" style="font-size: 0.62rem; padding: 0.1rem 0.3rem;" title="Bảo mật"><i class="fas fa-lock text-muted"></i> Riêng tư</span>
                  `}
                </div>
              </div>

              ${isFixed && (isAdmin || isSelf) ? `
                <div class="flex items-center justify-between" style="border-top: 1px dashed var(--border-color); padding-top: 0.35rem; margin-top: 0.1rem;">
                  <span class="text-secondary"><i class="fas fa-hashtag text-primary"></i> Mã chuyển khoản:</span>
                  <span class="font-mono font-bold" style="letter-spacing: 0.08em;">${Safe.html(window.TransferCode ? TransferCode.codeOf(m, members) : '')}</span>
                </div>
              ` : ''}

              ${isFixed ? `
                <div class="flex items-center justify-between" style="border-top: 1px dashed var(--border-color); padding-top: 0.35rem; margin-top: 0.1rem;">
                  <span class="text-secondary"><i class="fas fa-coins text-warning"></i> Quỹ tháng ${Number(currentMonth.slice(5))}:</span>
                  ${(isAdmin || isSelf) ? `
                    <span class="badge ${isPaidDue ? 'badge-paid' : isPendingDue ? 'badge-info' : 'badge-danger'}" style="font-size: 0.68rem;">
                      ${isPaidDue ? '<i class="fas fa-check-circle"></i> Đã đóng quỹ' : isPendingDue ? '<i class="fas fa-clock"></i> Chờ duyệt' : '<i class="fas fa-exclamation-circle"></i> Chưa đóng quỹ'}
                    </span>
                  ` : `
                    <span class="badge badge-neutral" style="font-size: 0.65rem;" title="Thông tin đóng quỹ chỉ hiển thị cho Ban Quản trị và chính chủ"><i class="fas fa-lock text-muted"></i> Riêng tư</span>
                  `}
                </div>
              ` : `
                <div class="flex items-center justify-between" style="border-top: 1px dashed var(--border-color); padding-top: 0.35rem; margin-top: 0.1rem;">
                  <span class="text-secondary"><i class="fas fa-bolt text-secondary"></i> Hình thức:</span>
                  <span class="text-muted" style="font-size: 0.75rem;">Thu phí theo từng buổi đánh</span>
                </div>
              `}

              ${m.note ? `
                <div style="font-size: 0.75rem; color: var(--text-muted); font-style: italic; border-top: 1px dashed var(--border-color); padding-top: 0.3rem;">
                  "${Safe.html(m.note)}"
                </div>
              ` : ''}
            </div>
          </div>

          <!-- Actions Footer: Phân quyền bảo mật (Admin có toàn quyền, Member chỉ sửa hồ sơ của mình) -->
          <div class="flex items-center justify-between" style="border-top: 1px solid var(--border-color); padding-top: 0.75rem; margin-top: 0.25rem;">
            <div class="flex gap-1">
              ${isAdmin ? `
                ${cleanPhone ? `
                  <a href="https://zalo.me/${cleanPhone}" target="_blank" rel="noopener" class="btn btn-secondary btn-sm" style="padding: 0.25rem 0.55rem; font-size: 0.75rem;" title="Nhắn tin Zalo">
                    <i class="fas fa-comment-dots text-primary"></i> <span>Zalo</span>
                  </a>
                ` : ''}
                ${m.phone ? `<a href="tel:${Safe.html(m.phone)}" class="btn btn-secondary btn-sm" style="padding: 0.25rem 0.55rem; font-size: 0.75rem;" title="Gọi điện thoại">
                  <i class="fas fa-phone-alt"></i>
                </a>` : ''}
              ` : `
                <span class="text-muted" style="font-size: 0.75rem; display: inline-flex; align-items: center; gap: 0.35rem;">
                  <i class="fas fa-user-shield text-primary"></i> <span>Bảo mật riêng tư</span>
                </span>
              `}
            </div>

            <div class="flex gap-1">
              ${isAdmin ? `
                <button class="btn btn-secondary btn-sm" onclick="MembersModule.openEditMemberModal(${Safe.js(m.id)})" title="Chỉnh sửa thông tin thành viên" style="padding: 0.25rem 0.55rem; font-size: 0.75rem;">
                  <i class="fas fa-edit"></i> <span>Sửa</span>
                </button>
                <button class="btn btn-outline-danger btn-sm" onclick="MembersModule.deleteMember(${Safe.js(m.id)})" title="Xóa thành viên khỏi CLB" style="padding: 0.25rem 0.55rem; font-size: 0.75rem;">
                  <i class="fas fa-trash"></i>
                </button>
              ` : (isSelf ? `
                <button class="btn btn-primary btn-sm" onclick="App.openUserProfileModal()" title="Chỉnh sửa thông tin cá nhân & đổi Avatar của tôi" style="padding: 0.25rem 0.6rem; font-size: 0.75rem;">
                  <i class="fas fa-user-edit"></i> <span>Hồ sơ của tôi</span>
                </button>
              ` : '')}
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Đồng bộ danh sách rút gọn trong form đăng ký
    this.renderPublicMemberRoster();
  },

  handleAvatarClick(memberId) {
    const data = AppStorage.loadData();
    const m = (data.members || []).find(mem => mem.id === memberId);
    if (!m) return;
    if (AppStorage.can('members')) {
      this.openEditMemberModal(memberId);
    } else if (AppStorage.canViewMemberContact(m.id, m.phone)) {
      App.openUserProfileModal();
    } else {
      App.showToast(`🏸 Thành viên "${m.name}" (${m.type === 'fixed' ? 'Hội viên Cố định' : 'Khách vãng lai'})`, "info");
    }
  },

  setFilter(filter, btnEl = null) {
    this.currentFilter = filter;
    document.querySelectorAll('#members-filter-bar .segmented-btn, #members-filter-bar .filter-tab').forEach(b => b.classList.remove('active'));
    if (btnEl) {
      btnEl.classList.add('active');
    } else {
      const match = document.querySelector(`#members-filter-bar [data-filter="${filter}"]`);
      if (match) match.classList.add('active');
    }
    this.renderMembersTab();
  },

  handleSearch(query) {
    this.searchQuery = (query || '').trim();
    this.renderMembersTab();
  },

  clearSearch() {
    this.searchQuery = '';
    const input = document.getElementById('members-search-input');
    if (input) input.value = '';
    this.currentFilter = 'all';
    this.setFilter('all');
  },

  switchSubTab(tab) {
    if (tab === 'list' && AppStorage.isGuest()) {
      App.showToast("⚠️ Danh sách thành viên nội bộ chỉ dành cho Hội viên chính thức. Vui lòng đăng ký gia nhập CLB hoặc đăng nhập!", "info");
      return;
    }

    this.currentSubTab = tab;
    const btnList = document.getElementById('subtab-btn-members-list');
    const btnReg = document.getElementById('subtab-btn-members-reg');
    const panelList = document.getElementById('subtab-panel-members-list');
    const panelReg = document.getElementById('subtab-panel-members-reg');

    if (tab === 'list') {
      btnList?.classList.add('active');
      btnReg?.classList.remove('active');
      if (panelList) panelList.style.display = 'block';
      if (panelReg) panelReg.style.display = 'none';
      this.renderMembersTab();
    } else {
      btnReg?.classList.add('active');
      btnList?.classList.remove('active');
      if (panelList) panelList.style.display = 'none';
      if (panelReg) panelReg.style.display = 'block';
      this.renderBenefitsAndRules();
      this.renderJoinCard();
      this.renderPublicMemberRoster();
      setTimeout(() => document.getElementById('quick-mem-name')?.focus(), 100);
    }
  },

  openAddMemberModal() {
    if (!AppStorage.can('members')) {
      App.showToast("Chức năng thêm thành viên trực tiếp chỉ dành cho Ban Quản trị CLB. Vui lòng đăng nhập!", "warning");
      App.showAuthModal('login');
      return;
    }

    const avatarHtml = App.renderAvatarPickerHtml('add-mem', '', 'Hội viên mới');

    const modalBody = `
      <form onsubmit="MembersModule.saveNewMember(event)">
        <!-- Bộ chọn Avatar -->
        ${avatarHtml}

        <div class="form-group">
          <label class="form-label font-bold">Họ và tên thành viên *</label>
          <input type="text" id="new-mem-name" class="form-control" placeholder="VD: Nguyễn Văn Anh" required>
        </div>

        <div style="grid-template-columns: 1fr 1fr; gap: 1rem; display: grid;">
          <div class="form-group">
            <label class="form-label font-bold">Số điện thoại (Zalo)</label>
            <input type="tel" id="new-mem-phone" class="form-control" placeholder="0912345678">
          </div>
          <div class="form-group">
            <label class="form-label">Email liên hệ (tùy chọn)</label>
            <input type="email" id="new-mem-email" class="form-control" placeholder="email@domain.com">
          </div>
        </div>

        <div style="grid-template-columns: 1fr 1fr; gap: 1rem; display: grid;">
          <div class="form-group">
            <label class="form-label font-bold">Hình thức tham gia</label>
            <select id="new-mem-type" class="form-select">
              <option value="fixed" selected>🏸 Cố định (Góp quỹ tháng)</option>
              <option value="guest">⚡ Vãng lai (Thu theo buổi)</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label font-bold">Vai trò trong CLB</label>
            <select id="new-mem-role" class="form-select">
              <option value="member" selected>Thành viên</option>
              <option value="treasurer">Thủ quỹ</option>
              <option value="admin">Quản trị viên</option>
            </select>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Ghi chú / Trình độ đánh cầu</label>
          <input type="text" id="new-mem-note" class="form-control" placeholder="VD: Trình độ khá, thuận tay trái...">
        </div>

        <div class="form-group" style="background: var(--bg-input); padding: 0.85rem; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
          <label class="flex items-center gap-2" style="font-size: 0.85rem; font-weight: 600; cursor: pointer;">
            <input type="checkbox" id="new-mem-account" onchange="document.getElementById('new-mem-pwd-wrap').style.display = this.checked ? 'block' : 'none'" style="accent-color: var(--primary);">
            <span><i class="fas fa-key text-primary"></i> Tạo luôn tài khoản đăng nhập</span>
          </label>
          <div id="new-mem-pwd-wrap" style="display: none; margin-top: 0.5rem;">
            <input type="password" id="new-mem-password" class="form-control" autocomplete="new-password" placeholder="Mật khẩu ban đầu (tối thiểu 6 ký tự, không đoán được)">
            <span class="text-secondary" style="font-size: 0.75rem; display: block; margin-top: 0.25rem;">Gửi mật khẩu này cho thành viên; họ nên đổi ngay sau khi đăng nhập. Không đặt trùng SĐT hay 123456.</span>
          </div>
          <span class="text-secondary" style="font-size: 0.75rem; display: block; margin-top: 0.35rem;">Không tích: chỉ ghi tên (không có tài khoản).</span>
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
    if (e && e.preventDefault) e.preventDefault();
    const v = (id) => (document.getElementById(id)?.value || '').trim();
    const name = v('new-mem-name');
    const res = this.createMember({
      name, phone: v('new-mem-phone'), email: v('new-mem-email'), note: v('new-mem-note'),
      type: v('new-mem-type') || 'fixed', role: v('new-mem-role') || 'member',
      avatar: document.getElementById('add-mem-avatar-val')?.value || '',
      createAccount: !!document.getElementById('new-mem-account')?.checked, password: v('new-mem-password')
    });
    if (!res.success) {
      App.showToast(res.message, 'warning');
      return;
    }
    App.closeModal();
    App.showToast(`🎉 Đã thêm thành viên "${name}"${res.username ? ` (tên đăng nhập: ${res.username})` : ' (chưa có tài khoản)'}!`, 'success');
    this.afterMemberChange();
  },

  openEditMemberModal(memberId) {
    if (!AppStorage.can('members')) {
      App.showToast("Chức năng chỉnh sửa thành viên chỉ dành cho Ban Quản trị CLB!", "warning");
      return;
    }

    const data = AppStorage.loadData();
    const m = (data.members || []).find(mem => mem.id === memberId);
    if (!m) return;

    const user = (data.users || []).find(u => u.memberId === memberId || (u.phone && m.phone && u.phone.replace(/\D/g, '') === m.phone.replace(/\D/g, ''))) || {};
    const avatarHtml = App.renderAvatarPickerHtml('edit-mem', m.avatar, m.name);

    const modalBody = `
      <form onsubmit="MembersModule.saveEditMember(event, ${Safe.js(m.id)})">
        <!-- Bộ chọn và Đổi ảnh đại diện -->
        ${avatarHtml}

        <div class="form-group">
          <label class="form-label font-bold">Họ và tên *</label>
          <input type="text" id="edit-mem-name" class="form-control" value="${Safe.html(m.name)}" required>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
          <div class="form-group">
            <label class="form-label font-bold">Số điện thoại *</label>
            <input type="tel" id="edit-mem-phone" class="form-control" value="${Safe.html(m.phone)}" required>
          </div>
          <div class="form-group">
            <label class="form-label">Email liên hệ (tùy chọn)</label>
            <input type="email" id="edit-mem-email" class="form-control" value="${Safe.html(m.email || user.email || '')}" placeholder="email@domain.com">
          </div>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
          <div class="form-group">
            <label class="form-label font-bold">Loại thành viên</label>
            <select id="edit-mem-type" class="form-select">
              <option value="fixed" ${m.type === 'fixed' ? 'selected' : ''}>🏸 Cố định (Góp quỹ tháng)</option>
              <option value="guest" ${m.type === 'guest' ? 'selected' : ''}>⚡ Vãng lai (Thu theo buổi)</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label font-bold">Vai trò</label>
            <select id="edit-mem-role" class="form-select" ${AppStorage.isSuperAdmin() ? '' : 'disabled title="Chỉ Quản trị viên được đổi vai trò hệ thống"'}>
              <option value="member" ${m.role === 'member' ? 'selected' : ''}>Thành viên</option>
              <option value="treasurer" ${m.role === 'treasurer' ? 'selected' : ''}>Thủ quỹ</option>
              <option value="admin" ${m.role === 'admin' ? 'selected' : ''}>Quản trị viên</option>
            </select>
          </div>
        </div>

        ${AppStorage.isSuperAdmin() && user.username && AppStorage.getRoles().length ? `
        <div class="form-group">
          <label class="form-label font-bold"><i class="fas fa-user-shield text-primary"></i> Vai trò tùy chỉnh (quyền được giao)</label>
          <select id="edit-mem-role-id" class="form-select">
            <option value="">— Không có —</option>
            ${AppStorage.getRoles().map(r => `<option value="${Safe.html(r.id)}" ${user.roleId === r.id ? 'selected' : ''}>${Safe.html(r.name)} (${(r.perms || []).map(p => Safe.html(AppStorage.PERM_LABELS[p] || p)).join(', ') || 'chưa có quyền'})</option>`).join('')}
          </select>
          <span class="text-secondary" style="font-size: 0.78rem;">Quản lý vai trò tại Cài đặt → Vai trò & quyền. Chỉ áp dụng cho thành viên thường.</span>
        </div>` : ''}

        ${AppStorage.isSuperAdmin() && user.username ? `
        <label class="form-group" style="display: flex; align-items: flex-start; gap: 0.5rem; font-size: 0.85rem; cursor: pointer;">
          <input type="checkbox" id="edit-mem-can-schedule" ${user.canScheduleVotes === true ? 'checked' : ''} style="margin-top: 0.2rem;">
          <span><b><i class="fas fa-calendar-plus text-primary"></i> Được lên lịch bình chọn tự động</b><br>
          <span class="text-secondary" style="font-size: 0.78rem;">Tạo/sửa lịch bình chọn lặp lại, hẹn giờ mở vote. Không có quyền quản trị khác (Admin/Thủ quỹ luôn có quyền này).</span></span>
        </label>` : ''}

        <div class="form-group">
          <label class="form-label">Ghi chú / Trình độ</label>
          <input type="text" id="edit-mem-note" class="form-control" value="${Safe.html(m.note || user.note || '')}" placeholder="VD: Trình độ trung bình khá...">
        </div>

        <div class="form-group" style="background: var(--bg-input); padding: 0.85rem; border-radius: var(--radius-md); border: 1px solid var(--border-color); margin-top: 0.5rem;">
          <label class="form-label" style="font-weight: 600; margin-bottom: 0.25rem;">
            <i class="fas fa-key text-primary"></i> ${user.username ? 'Đặt lại mật khẩu thành viên:' : 'Cấp tài khoản đăng nhập (đặt mật khẩu):'}
          </label>
          <input type="password" id="edit-mem-password" class="form-control" placeholder="Nhập mật khẩu mới nếu muốn thay đổi (tối thiểu 6 ký tự)...">
          <span class="text-secondary" style="font-size: 0.75rem; margin-top: 0.25rem; display: block;">
            ${user.username ? 'Để trống nếu muốn giữ nguyên mật khẩu hiện tại của thành viên này.' : 'Thành viên này chưa có tài khoản. Nhập mật khẩu (cần có SĐT làm tên đăng nhập) để cấp tài khoản; để trống nếu không cần.'}
          </span>
        </div>

        <div class="modal-footer" style="padding: 1rem 0 0 0;">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Hủy</button>
          <button type="submit" class="btn btn-primary"><i class="fas fa-save"></i> Lưu thay đổi</button>
        </div>
      </form>
    `;

    App.openModal("✏️ Chỉnh sửa thông tin & Avatar thành viên", modalBody);
  },

  saveEditMember(e, memberId) {
    if (e && e.preventDefault) e.preventDefault();
    const data = AppStorage.loadData();
    const m = (data.members || []).find(mem => mem.id === memberId);
    if (!m) return;

    m.name = (document.getElementById('edit-mem-name')?.value || '').trim();
    m.phone = (document.getElementById('edit-mem-phone')?.value || '').trim();
    m.email = (document.getElementById('edit-mem-email')?.value || '').trim();
    m.note = (document.getElementById('edit-mem-note')?.value || '').trim();
    m.type = document.getElementById('edit-mem-type')?.value || 'fixed';
    m.role = document.getElementById('edit-mem-role')?.value || 'member';
    const avatar = document.getElementById('edit-mem-avatar-val')?.value || m.avatar;
    if (avatar) m.avatar = avatar;

    const newPwd = (document.getElementById('edit-mem-password')?.value || '').trim();

    // Cập nhật User tương ứng (tìm theo memberId, username, phone hoặc role admin)
    const user = (data.users || []).find(u => 
      u.memberId === memberId || 
      (m.username && u.username === m.username) || 
      (u.phone && m.phone && u.phone.replace(/\D/g, '') === m.phone.replace(/\D/g, '')) ||
      (m.id === 'mem_admin' && u.username === 'admin')
    );

    if (!user && newPwd) {
      // Thành viên mới chỉ được ghi tên: cấp tài khoản đăng nhập khi Admin đặt mật khẩu
      const policy = AppStorage._passwordPolicyError(newPwd);
      const uname = ((m.phone || '').replace(/\D/g, '').length >= 9) ? (m.phone || '').replace(/\D/g, '') : (m.username || '');
      if (policy || !uname) {
        App.showToast(policy || 'Thành viên chưa có SĐT để làm tên đăng nhập. Hãy nhập SĐT trước.', 'error');
        return;
      }
      if (AuthCore.isWeakPassword(newPwd, { username: uname, phone: m.phone })) {
        App.showToast('Mật khẩu quá dễ đoán (trùng SĐT/tên đăng nhập hoặc mật khẩu phổ biến). Hãy đặt mật khẩu khác.', 'error');
        return;
      }
      if ((data.users || []).some(u => (u.username || '').toLowerCase() === uname.toLowerCase())) {
        App.showToast(`Tên đăng nhập "${uname}" đã tồn tại.`, 'error');
        return;
      }
      m.username = uname;
      if (!data.users) data.users = [];
      data.users.push({
        id: 'user_' + Date.now(), username: uname, password: AppStorage.hashPassword(newPwd), name: m.name, phone: m.phone,
        email: m.email, note: m.note, role: m.role, memberId: m.id, type: m.type, avatar: m.avatar || avatar, createdAt: new Date().toISOString()
      });
      App.showToast(`Đã cấp tài khoản đăng nhập "${uname}" cho ${m.name}.`, 'success');
    }

    if (user) {
      user.name = m.name;
      user.phone = m.phone;
      user.email = m.email;
      user.note = m.note;
      user.role = m.role;
      user.type = m.type;
      if (avatar) user.avatar = avatar;
      const roleSel = document.getElementById('edit-mem-role-id');
      if (roleSel && AppStorage.isSuperAdmin()) {
        if (roleSel.value && m.role === 'member') user.roleId = roleSel.value;
        else delete user.roleId;
      }
      const canSchedule = document.getElementById('edit-mem-can-schedule');
      if (canSchedule && AppStorage.isSuperAdmin()) {
        if (canSchedule.checked) user.canScheduleVotes = true;
        else delete user.canScheduleVotes;
      }
      if (newPwd) {
        if (newPwd.length < 6) {
          App.showToast("Mật khẩu mới phải có tối thiểu 6 ký tự trở lên!", "error");
          return;
        }
        if (/\s/.test(newPwd)) {
          App.showToast("Mật khẩu không được chứa khoảng trắng!", "error");
          return;
        }
        user.password = AppStorage.hashPassword(newPwd);
        user.updatedAt = new Date().toISOString();
      }
    }

    // Nếu đang chỉnh sửa chính tài khoản đang đăng nhập
    const currentUser = AppStorage.getCurrentUser();
    if (currentUser && (currentUser.id === user?.id || currentUser.memberId === memberId || (user && currentUser.username === user.username))) {
      data.currentUser = user || currentUser;
      try {
        const rawSession = sessionStorage.getItem("SMASH_PRO_AUTH_SESSION_V2") || localStorage.getItem("SMASH_PRO_AUTH_SESSION_V2");
        if (rawSession) {
          const sess = JSON.parse(rawSession);
          sess.name = m.name;
          if (sessionStorage.getItem("SMASH_PRO_AUTH_SESSION_V2")) sessionStorage.setItem("SMASH_PRO_AUTH_SESSION_V2", JSON.stringify(sess));
          if (localStorage.getItem("SMASH_PRO_AUTH_SESSION_V2")) localStorage.setItem("SMASH_PRO_AUTH_SESSION_V2", JSON.stringify(sess));
        }
      } catch (e) {}
    }

    AppStorage.reconcileUsersAndMembers(data);
    AppStorage.saveData(data, true);
    App.closeModal();
    App.showToast(`🎉 Đã cập nhật thông tin và ảnh đại diện của "${m.name}" thành công!`, "success");

    this.renderMembersTab();
    if (window.SettingsModule) SettingsModule.renderMembersAdmin();
    App.renderUserRoleSelector();
    App.renderUserHeaderAndSidebar();
    if (window.App && typeof App.refreshDashboardStats === 'function') App.refreshDashboardStats();
    if (window.FundModule && typeof FundModule.renderFundDashboard === 'function') FundModule.renderFundDashboard();
  },

  async deleteMember(memberId) {
    if (!AppStorage.can('members')) {
      App.showToast("Chức năng xóa thành viên chỉ dành cho Ban Quản trị CLB!", "warning");
      return;
    }

    const data = AppStorage.loadData();
    const member = (data.members || []).find(m => m.id === memberId);
    const memberName = member ? member.name : "thành viên";

    if (!(await App.confirm(`Bạn có chắc chắn muốn xóa "${memberName}" khỏi danh sách CLB?\n(Lưu ý: Tài khoản và dữ liệu đóng quỹ tương ứng sẽ được dọn sạch)`))) {
      return;
    }

    // Ghi nhận Tombstones để chống hồi sinh từ Cloud Sync
    if (!Array.isArray(data.deletedMemberIds)) data.deletedMemberIds = [];
    if (!Array.isArray(data.deletedUserIds)) data.deletedUserIds = [];

    data.deletedMemberIds.push(memberId);
    if (member && member.username && member.username !== 'admin') {
      data.deletedUserIds.push(member.username);
    }
    const matchingUsers = (data.users || []).filter(u => u.username !== 'admin' && (u.memberId === memberId || (member && u.username === member.username)));
    matchingUsers.forEach(u => {
      data.deletedUserIds.push(u.id);
      if (u.username) data.deletedUserIds.push(u.username);
    });

    data.members = (data.members || []).filter(m => m.id !== memberId);
    data.users = (data.users || []).filter(u => u.username === 'admin' || (u.memberId !== memberId && (!member || u.username !== member.username)));
    if (data.monthlyContributions) {
      data.monthlyContributions = data.monthlyContributions.filter(d => d.memberId !== memberId);
    }

    AppStorage.saveData(data, true);
    this.renderMembersTab();
    if (window.SettingsModule) SettingsModule.renderMembersAdmin();
    App.renderUserRoleSelector();
    App.renderUserHeaderAndSidebar();
    if (window.App && typeof App.refreshDashboardStats === 'function') App.refreshDashboardStats();
    if (window.FundModule && typeof FundModule.renderFundDashboard === 'function') FundModule.renderFundDashboard();
    App.showToast(`Đã xóa thành viên "${memberName}" khỏi danh sách CLB!`, "info");
  },

  // ---------------- Thẻ "Tham gia CLB" ở tab Điều khoản ----------------
  // Admin/Thủ quỹ: form thêm nhanh thành viên (có thể KHÔNG tạo tài khoản đăng nhập, dành cho khách/người chưa dùng app).
  // Người khác: hướng dẫn tạo tài khoản (đăng ký dùng chung một luồng ở hộp thoại Đăng nhập/Đăng ký).
  renderJoinCard() {
    const body = document.getElementById('join-card-body');
    if (!body) return;
    const isAdmin = AppStorage.can('members');
    const title = document.getElementById('join-card-title');
    const tabBtn = document.getElementById('subtab-btn-members-reg');
    if (tabBtn) tabBtn.innerHTML = isAdmin ? '<i class="fas fa-user-plus"></i> Thêm thành viên' : '<i class="fas fa-id-card"></i> Điều khoản & Đăng ký';
    if (title) title.innerHTML = isAdmin ? '<i class="fas fa-user-plus text-primary"></i> Thêm thành viên' : '<i class="fas fa-id-card text-primary"></i> Tham gia CLB';

    if (isAdmin) {
      body.innerHTML = `
        <form onsubmit="MembersModule.addMemberQuick(event)">
          <p class="text-secondary" style="font-size: 0.82rem; margin: 0 0 0.9rem;">
            Ghi tên khách hoặc thành viên <b>chưa có tài khoản</b> để tính quỹ, chia tiền, điểm danh. Mỗi người được cấp một <b>mã chuyển khoản riêng</b>.
          </p>
          <div class="form-group">
            <label class="form-label font-bold" for="quick-mem-name">Họ và tên *</label>
            <input type="text" id="quick-mem-name" class="form-control" placeholder="VD: Trần Hoàng Nam" maxlength="100" required>
          </div>
          <div class="form-group">
            <label class="form-label" for="quick-mem-phone">Số điện thoại / Zalo (tùy chọn)</label>
            <input type="tel" id="quick-mem-phone" class="form-control" placeholder="0988xxxxxx">
          </div>
          <div class="form-group">
            <label class="form-label font-bold" for="quick-mem-type">Hình thức tham gia</label>
            <select id="quick-mem-type" class="form-select">
              <option value="guest" selected>⚡ Khách vãng lai (thu theo buổi)</option>
              <option value="fixed">🏸 Thành viên cố định (góp quỹ tháng)</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="quick-mem-note">Ghi chú / Trình độ</label>
            <input type="text" id="quick-mem-note" class="form-control" maxlength="300" placeholder="VD: Tay trái, trình độ khá...">
          </div>
          <label class="flex items-center gap-2" style="font-size: 0.85rem; cursor: pointer; margin: 0.25rem 0 0.5rem;">
            <input type="checkbox" id="quick-mem-account" onchange="document.getElementById('quick-mem-pwd-wrap').style.display = this.checked ? 'block' : 'none'" style="accent-color: var(--primary);">
            <span>Tạo luôn tài khoản đăng nhập cho người này</span>
          </label>
          <div id="quick-mem-pwd-wrap" class="form-group" style="display: none;">
            <label class="form-label" for="quick-mem-password">Mật khẩu ban đầu * (tối thiểu 6 ký tự, không đoán được)</label>
            <input type="password" id="quick-mem-password" class="form-control" autocomplete="new-password" placeholder="Gửi mật khẩu này cho thành viên, họ sẽ tự đổi sau">
          </div>
          <button type="submit" class="btn btn-primary w-full btn-lg" style="margin-top: 0.75rem;">
            <i class="fas fa-user-plus"></i> Thêm thành viên
          </button>
        </form>`;
      return;
    }

    const user = AppStorage.getCurrentUser();
    body.innerHTML = user ? `
      <p class="text-secondary" style="font-size: 0.9rem; line-height: 1.6; margin: 0;">
        Bạn đang đăng nhập với tài khoản <b>${Safe.html(user.name || user.username)}</b>.
        ${user.type === 'fixed' ? 'Bạn là thành viên cố định của CLB.' : 'Muốn trở thành thành viên cố định, hãy gửi yêu cầu trong <b>Hồ sơ cá nhân</b>; Ban quản trị sẽ duyệt.'}
      </p>` : `
      <p class="text-secondary" style="font-size: 0.9rem; line-height: 1.6; margin: 0 0 1rem;">
        Tạo tài khoản để bình chọn các buổi đánh, đóng quỹ và nhận thông báo. Bạn có thể đăng ký bằng số điện thoại hoặc tài khoản Google.
        Muốn làm thành viên cố định, chọn "cố định" khi đăng ký và chờ Ban quản trị duyệt.
      </p>
      <button type="button" class="btn btn-primary w-full btn-lg" onclick="App.showAuthModal('register')">
        <i class="fas fa-user-plus"></i> Tạo tài khoản
      </button>`;
  },

  // Tạo thành viên (dùng chung cho form nhanh và hộp thoại "Thêm thành viên").
  // createAccount=false -> chỉ ghi tên (không có tài khoản/mật khẩu); true -> bắt buộc mật khẩu hợp lệ do Admin đặt.
  createMember({ name, phone, email = '', note = '', type = 'guest', role = 'member', avatar = '', createAccount = false, password = '' }) {
    if (!AppStorage.can('members')) return { success: false, message: 'Chỉ Ban quản trị mới được thêm thành viên.' };
    name = String(name || '').trim();
    phone = String(phone || '').trim();
    const cleanPhone = phone.replace(/\D/g, '');
    if (name.length < 2) return { success: false, message: 'Vui lòng nhập họ và tên (tối thiểu 2 ký tự)!' };
    if (phone && cleanPhone.length < 9) return { success: false, message: 'Số điện thoại chưa hợp lệ (tối thiểu 9 chữ số).' };
    if (role === 'admin' && !AppStorage.isSuperAdmin()) return { success: false, message: 'Chỉ Quản trị viên mới được cấp vai trò Quản trị viên.' };

    const data = AppStorage.loadData();
    if (!data.members) data.members = [];
    if (!data.users) data.users = [];
    if (cleanPhone && (data.members.some((m) => m.phone && m.phone.replace(/\D/g, '') === cleanPhone) ||
      data.users.some((u) => u.phone && u.phone.replace(/\D/g, '') === cleanPhone))) {
      return { success: false, message: 'Số điện thoại này đã tồn tại trong danh sách thành viên!' };
    }

    const stamp = Date.now();
    const memId = 'mem_' + stamp;
    const username = cleanPhone.length >= 9 ? cleanPhone : name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) + Math.floor(100 + Math.random() * 900);
    const pwd = String(password || '').trim();
    if (createAccount) {
      const policy = AppStorage._passwordPolicyError(pwd);
      if (policy) return { success: false, message: policy };
      if (AuthCore.isWeakPassword(pwd, { username, phone })) return { success: false, message: 'Mật khẩu quá dễ đoán (trùng SĐT/tên đăng nhập hoặc mật khẩu phổ biến). Hãy đặt mật khẩu khác.' };
      if (data.users.some((u) => (u.username || '').toLowerCase() === username.toLowerCase())) return { success: false, message: `Tên đăng nhập "${username}" đã tồn tại.` };
    }
    const finalAvatar = avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=10b981&color=fff`;
    const member = { id: memId, name, phone, email, note, type, role, avatar: finalAvatar, joinDate: new Date().toISOString().slice(0, 10) };
    // Mã chuyển khoản riêng (máy chủ cũng tự cấp/kiểm tra trùng khi đồng bộ)
    if (window.TransferCode) member.transferCode = TransferCode.plan(data.members.concat([{ id: memId }]))[memId];
    if (createAccount) member.username = username;
    data.members.push(member);

    if (createAccount) {
      data.users.push({
        id: 'user_' + stamp, username, password: AppStorage.hashPassword(pwd), name, phone, email, note, role,
        memberId: memId, type, avatar: finalAvatar, createdAt: new Date().toISOString()
      });
    }

    // Thành viên cố định -> tạo phiếu thu quỹ tháng hiện tại
    const fee = Number((data.clubInfo || {}).monthlyFee || (data.clubInfo || {}).monthlyFundFee) || 0;
    if (type === 'fixed' && fee > 0) {
      const month = AppStorage.currentMonth();
      if (!data.monthlyContributions) data.monthlyContributions = [];
      if (!data.monthlyContributions.some((d) => d.memberId === memId && d.month === month)) {
        data.monthlyContributions.push({
          id: `due_${month}_${memId}`, month, memberId: memId, amount: fee, status: 'unpaid', paidAt: null, method: null,
          billImage: null, approvedBy: null, approvedAt: null, note: 'Thành viên mới'
        });
      }
    }
    AppStorage.saveData(data, true);
    return { success: true, member, username: createAccount ? username : '' };
  },

  addMemberQuick(e) {
    if (e && e.preventDefault) e.preventDefault();
    const v = (id) => (document.getElementById(id)?.value || '').trim();
    const createAccount = !!document.getElementById('quick-mem-account')?.checked;
    const res = this.createMember({
      name: v('quick-mem-name'), phone: v('quick-mem-phone'), note: v('quick-mem-note'),
      type: v('quick-mem-type') || 'guest', createAccount, password: v('quick-mem-password')
    });
    if (!res.success) {
      App.showToast(res.message, 'warning');
      return;
    }
    if (e && e.target && e.target.reset) e.target.reset();
    const wrap = document.getElementById('quick-mem-pwd-wrap');
    if (wrap) wrap.style.display = 'none';
    App.showToast(`✅ Đã thêm "${res.member.name}"${res.username ? ` (tên đăng nhập: ${res.username})` : ' (chưa có tài khoản)'}. Mã chuyển khoản: ${res.member.transferCode || 'đang cấp'}`, 'success');
    this.afterMemberChange();
    document.getElementById('quick-mem-name')?.focus();
  },

  afterMemberChange() {
    this.renderMembersTab();
    this.renderPublicMemberRoster();
    if (window.SettingsModule) SettingsModule.renderMembersAdmin();
    App.renderUserRoleSelector();
    App.renderUserHeaderAndSidebar();
    if (window.App && typeof App.refreshDashboardStats === 'function') App.refreshDashboardStats();
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
        <img class="avatar avatar-sm" src="${Safe.url(m.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(m.name)}&background=10b981&color=fff`)}" alt="${Safe.html(m.name)}" style="width: 20px; height: 20px; border-radius: 50%;">
        <span>${Safe.html(m.name)}</span>
        <span class="badge ${m.type === 'fixed' ? 'badge-paid' : 'badge-warning'}" style="font-size: 0.65rem; padding: 0.05rem 0.3rem;">
          ${m.type === 'fixed' ? 'Cố định' : 'Vãng lai'}
        </span>
      </div>
    `).join('');
  },

  copyMemberList() {
    if (!AppStorage.can('members')) {
      App.showToast("Chức năng sao chép danh sách liên hệ thành viên chỉ dành cho Ban Quản trị!", "warning");
      return;
    }
    const data = AppStorage.loadData();
    const members = data.members || [];
    if (members.length === 0) {
      App.showToast("CLB chưa có thành viên nào để sao chép!", "info");
      return;
    }

    let text = `🏸 DANH SÁCH THÀNH VIÊN CLB SMASH PRO (${members.length} thành viên)\n`;
    text += `-------------------------------------------\n`;
    members.forEach((m, idx) => {
      text += `${idx + 1}. ${m.name} - ${m.phone} (${m.type === 'fixed' ? 'Cố định' : 'Vãng lai'}${m.role === 'admin' ? ' - Admin' : m.role === 'treasurer' ? ' - Thủ quỹ' : ''})\n`;
    });

    navigator.clipboard.writeText(text).then(() => {
      App.showToast("📋 Đã sao chép danh sách thành viên vào bộ nhớ tạm!", "success");
    }).catch(() => {
      App.showToast("Không thể sao chép tự động, vui lòng thử lại!", "error");
    });
  },

  // ==========================================
  // QUẢN LÝ & CHỈNH SỬA QUYỀN LỢI & QUY ĐỊNH CLB
  // ==========================================

  escapeHtml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  },

  renderBenefitsAndRules() {
    const data = AppStorage.loadData();
    const container = document.getElementById('club-benefits-rules-list');
    if (!container) return;

    const defaultRules = [
      { id: "rule_1", title: "Quyền lợi thành viên cố định", content: "Tham gia mọi buổi đánh định kỳ và hưởng quyền lợi thành viên trọn gói." },
      { id: "rule_2", title: "Tự động đóng vote 2 ngày", content: "Đảm bảo chốt sân đúng số lượng, không bị thiếu hoặc quá tải sân." },
      { id: "rule_3", title: "Quỹ sân minh bạch", content: "Thu quỹ qua VietQR tự động, sao kê rõ ràng công khai." },
      { id: "rule_4", title: "Cầu sử dụng", content: "n/a" }
    ];

    const rules = (data.clubInfo && Array.isArray(data.clubInfo.benefitsAndRules) && data.clubInfo.benefitsAndRules.length > 0)
      ? data.clubInfo.benefitsAndRules
      : defaultRules;

    container.innerHTML = rules.map(r => `
      <div class="flex items-start gap-3">
        <i class="fas fa-check-circle text-primary" style="margin-top: 0.2rem; flex-shrink: 0;"></i>
        <div><strong>${this.escapeHtml(r.title || '')}:</strong> ${this.escapeHtml(r.content || '')}</div>
      </div>
    `).join('');
  },

  openEditBenefitsAndRulesModal() {
    if (!AppStorage.can('members')) {
      App.showToast("Chức năng chỉnh sửa Quyền lợi & Quy định CLB chỉ dành cho Ban Quản trị!", "warning");
      return;
    }

    const data = AppStorage.loadData();
    const defaultRules = [
      { id: "rule_1", title: "Quyền lợi thành viên cố định", content: "Tham gia mọi buổi đánh định kỳ và hưởng quyền lợi thành viên trọn gói." },
      { id: "rule_2", title: "Tự động đóng vote 2 ngày", content: "Đảm bảo chốt sân đúng số lượng, không bị thiếu hoặc quá tải sân." },
      { id: "rule_3", title: "Quỹ sân minh bạch", content: "Thu quỹ qua VietQR tự động, sao kê rõ ràng công khai." },
      { id: "rule_4", title: "Cầu sử dụng", content: "n/a" }
    ];

    const rules = (data.clubInfo && Array.isArray(data.clubInfo.benefitsAndRules) && data.clubInfo.benefitsAndRules.length > 0)
      ? data.clubInfo.benefitsAndRules
      : defaultRules;

    let rowsHtml = '';
    rules.forEach((r, idx) => {
      rowsHtml += this.generateRuleRowHtml(idx + 1, r.title, r.content);
    });

    const modalBody = `
      <form onsubmit="MembersModule.saveBenefitsAndRules(event)">
        <div style="margin-bottom: 1rem; color: var(--text-secondary); font-size: 0.85rem; line-height: 1.45; background: var(--bg-input); padding: 0.75rem; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
          <i class="fas fa-info-circle text-primary"></i> Nội dung này sẽ hiển thị trên <strong>Phiếu đăng ký gia nhập</strong> và <strong>Quyền lợi & Quy định CLB</strong> để các thành viên mới nắm rõ điều lệ hoạt động.
        </div>

        <div id="rules-editor-container" style="display: flex; flex-direction: column; gap: 0.85rem; max-height: 52vh; overflow-y: auto; padding-right: 0.25rem;">
          ${rowsHtml}
        </div>

        <div class="flex justify-between items-center flex-wrap gap-2" style="margin-top: 1rem; border-top: 1px dashed var(--border-color); padding-top: 0.75rem;">
          <button type="button" class="btn btn-secondary btn-sm" onclick="MembersModule.addRuleRowInModal()">
            <i class="fas fa-plus-circle text-primary"></i> <span>Thêm điều khoản mới</span>
          </button>
          <button type="button" class="btn btn-outline-danger btn-sm" onclick="MembersModule.resetDefaultRulesInModal()" title="Khôi phục 4 quy định mẫu chuẩn">
            <i class="fas fa-undo"></i> <span>Mặc định</span>
          </button>
        </div>

        <div class="modal-footer" style="padding: 1rem 0 0 0; margin-top: 0.5rem;">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Hủy</button>
          <button type="submit" class="btn btn-primary"><i class="fas fa-save"></i> Lưu quy định & quyền lợi</button>
        </div>
      </form>
    `;

    App.openModal("✏️ Chỉnh sửa Quyền lợi & Quy định CLB", modalBody, true);
  },

  generateRuleRowHtml(index, title = '', content = '') {
    return `
      <div class="rule-edit-item" style="background: var(--bg-input); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 0.85rem;">
        <div class="flex justify-between items-center" style="margin-bottom: 0.5rem;">
          <strong style="font-size: 0.85rem; color: var(--primary);">
            <i class="fas fa-check-circle"></i> Điều khoản #<span class="rule-index">${index}</span>
          </strong>
          <button type="button" class="btn btn-outline-danger btn-sm" onclick="MembersModule.deleteRuleRowInModal(this)" title="Xóa điều khoản này" style="padding: 0.15rem 0.45rem; font-size: 0.72rem;">
            <i class="fas fa-trash"></i> Xóa
          </button>
        </div>
        <div class="form-group" style="margin-bottom: 0.5rem;">
          <label class="form-label font-bold" style="font-size: 0.82rem; margin-bottom: 0.2rem;">Tiêu đề quy định *</label>
          <input type="text" class="form-control rule-input-title" value="${this.escapeHtml(title)}" placeholder="VD: Lịch đánh cố định, Quỹ sân..." required>
        </div>
        <div class="form-group" style="margin-bottom: 0;">
          <label class="form-label font-bold" style="font-size: 0.82rem; margin-bottom: 0.2rem;">Nội dung chi tiết *</label>
          <textarea class="form-control rule-input-content" rows="2" placeholder="VD: Thứ 7 (18h-20h) và Thứ 3 (19h30-21h30)..." required>${this.escapeHtml(content)}</textarea>
        </div>
      </div>
    `;
  },

  addRuleRowInModal() {
    const container = document.getElementById('rules-editor-container');
    if (!container) return;
    const currentCount = container.querySelectorAll('.rule-edit-item').length;
    const newDiv = document.createElement('div');
    newDiv.innerHTML = this.generateRuleRowHtml(currentCount + 1, '', '');
    container.appendChild(newDiv.firstElementChild);
    this.reindexRuleRowsInModal();
    container.scrollTop = container.scrollHeight;
  },

  deleteRuleRowInModal(btn) {
    const row = btn.closest('.rule-edit-item');
    const container = document.getElementById('rules-editor-container');
    if (row && container) {
      if (container.querySelectorAll('.rule-edit-item').length <= 1) {
        App.showToast("Cần giữ lại ít nhất 1 điều khoản quy định!", "warning");
        return;
      }
      row.remove();
      this.reindexRuleRowsInModal();
    }
  },

  reindexRuleRowsInModal() {
    const container = document.getElementById('rules-editor-container');
    if (!container) return;
    const items = container.querySelectorAll('.rule-edit-item');
    items.forEach((item, idx) => {
      const span = item.querySelector('.rule-index');
      if (span) span.innerText = idx + 1;
    });
  },

  resetDefaultRulesInModal() {
    const container = document.getElementById('rules-editor-container');
    if (!container) return;
    const defaultRules = [
      { title: "Quyền lợi thành viên cố định", content: "Tham gia mọi buổi đánh định kỳ và hưởng quyền lợi thành viên trọn gói." },
      { title: "Tự động đóng vote 2 ngày", content: "Đảm bảo chốt sân đúng số lượng, không bị thiếu hoặc quá tải sân." },
      { title: "Quỹ sân minh bạch", content: "Thu quỹ qua VietQR tự động, sao kê rõ ràng công khai." },
      { title: "Cầu sử dụng", content: "n/a" }
    ];

    container.innerHTML = defaultRules.map((r, idx) => this.generateRuleRowHtml(idx + 1, r.title, r.content)).join('');
    App.showToast("Đã khôi phục mẫu 4 quy định chuẩn!", "info");
  },

  saveBenefitsAndRules(e) {
    if (e && e.preventDefault) e.preventDefault();
    const container = document.getElementById('rules-editor-container');
    if (!container) return;

    const items = container.querySelectorAll('.rule-edit-item');
    const newRules = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const title = (item.querySelector('.rule-input-title')?.value || '').trim();
      const content = (item.querySelector('.rule-input-content')?.value || '').trim();
      if (!title || !content) {
        App.showToast(`Vui lòng điền đầy đủ tiêu đề và nội dung cho Điều khoản #${i + 1}!`, "warning");
        return;
      }
      newRules.push({
        id: `rule_${Date.now()}_${i + 1}`,
        title,
        content
      });
    }

    if (newRules.length === 0) {
      App.showToast("CLB cần có ít nhất 1 điều khoản quy định!", "warning");
      return;
    }

    const data = AppStorage.loadData();
    if (!data.clubInfo) data.clubInfo = {};
    data.clubInfo.benefitsAndRules = newRules;

    AppStorage.saveData(data, true);
    App.closeModal();
    this.renderBenefitsAndRules();
    App.showToast("🎉 Đã lưu cập nhật Quyền lợi & Quy định CLB thành công!", "success");
  }
};

window.MembersModule = MembersModule;
