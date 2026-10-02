// Monthly Fund & Contribution Management Module

const FundModule = {
  currentFilter: 'all',
  currentMonth: '2026-09',

  getClubFee(data) {
    if (!data) data = AppStorage.loadData();
    const info = data.clubInfo || {};
    return info.monthlyFee || info.monthlyFundFee || 20000;
  },

  renderFundDashboard() {
    const data = AppStorage.loadData();
    const members = (data.members || []).filter(m => m.type === 'fixed');
    const dues = data.monthlyContributions || [];
    const defaultMonthlyFee = this.getClubFee(data);
    const currentUser = AppStorage.getCurrentUser();
    const isAdmin = AppStorage.isAdmin();

    const fixedMemberIds = new Set(members.map(m => m.id));

    // Current month dues data (chỉ lấy của các thành viên cố định thực sự tồn tại)
    const monthDues = dues.filter(d => d.month === this.currentMonth && fixedMemberIds.has(d.memberId));
    
    // Ensure all fixed members have a dues record for this month
    members.forEach(m => {
      let existingDue = monthDues.find(d => d.memberId === m.id);
      if (!existingDue) {
        existingDue = {
          id: `due_${this.currentMonth}_${m.id}`,
          month: this.currentMonth,
          memberId: m.id,
          amount: defaultMonthlyFee,
          status: 'unpaid',
          paidAt: null,
          method: null,
          billImage: null,
          approvedBy: null,
          approvedAt: null,
          note: 'Chưa đóng'
        };
        monthDues.push(existingDue);
      }
    });

    // Counts & Totals
    const paidList = monthDues.filter(d => d.status === 'paid');
    const pendingList = monthDues.filter(d => d.status === 'pending');
    const unpaidList = monthDues.filter(d => d.status === 'unpaid');

    const totalExpected = monthDues.reduce((sum, d) => sum + (Number(d.amount) || defaultMonthlyFee), 0);
    const totalCollected = paidList.reduce((sum, d) => sum + (Number(d.amount) || defaultMonthlyFee), 0);
    const progressPercent = members.length > 0 ? Math.min(100, Math.round((paidList.length / members.length) * 100)) : 0;

    // Update Summary Header Card
    const summaryCard = document.getElementById('fund-summary-container');
    if (summaryCard) {
      summaryCard.innerHTML = `
        <div class="fund-summary-card">
          <div class="fund-highlight-box">
            <div class="fund-highlight-label">
              <i class="fas fa-coins text-warning"></i> Quỹ tiền sân cố định tháng ${this.currentMonth.slice(5)}/${this.currentMonth.slice(0, 4)}
            </div>
            <div class="fund-highlight-balance">${totalCollected.toLocaleString('vi-VN')} đ</div>
            <div class="text-secondary" style="font-size: 0.9rem;">
              Chỉ tiêu thu tháng: <strong>${totalExpected.toLocaleString('vi-VN')} đ</strong> (${members.length} thành viên cố định • Mức chuẩn: ${defaultMonthlyFee.toLocaleString('vi-VN')}đ/người)
            </div>
            <div style="margin-top: 0.75rem;">
              <div class="flex justify-between items-center" style="font-size: 0.85rem; margin-bottom: 0.35rem;">
                <span>Tiến độ thu quỹ (${paidList.length}/${members.length} người)</span>
                <strong>${progressPercent}%</strong>
              </div>
              <div class="progress-bar-bg">
                <div class="progress-bar-fill" style="width: ${progressPercent}%;"></div>
              </div>
            </div>
          </div>

          <div style="display: flex; flex-direction: column; gap: 0.85rem; background: rgba(0,0,0,0.2); padding: 1.25rem; border-radius: var(--radius-lg);">
            <div class="flex justify-between items-center">
              <span class="text-secondary"><i class="fas fa-check-circle text-primary"></i> Đã đóng:</span>
              <span class="badge badge-paid">${paidList.length} thành viên</span>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-secondary"><i class="fas fa-hourglass-half text-warning"></i> Chờ duyệt:</span>
              <span class="badge badge-pending">${pendingList.length} thành viên</span>
            </div>
            <div class="flex justify-between items-center">
              <span class="text-secondary"><i class="fas fa-times-circle text-danger"></i> Chưa đóng:</span>
              <span class="badge badge-unpaid">${unpaidList.length} thành viên</span>
            </div>

            <div style="display: flex; gap: 0.5rem; margin-top: 0.5rem; flex-wrap: wrap;">
              <button class="btn btn-primary btn-sm flex-1" onclick="FundModule.openPaymentModal('${currentUser ? currentUser.id : ''}')">
                <i class="fas fa-qrcode"></i> Đóng quỹ VietQR
              </button>
              ${isAdmin ? `
                <button class="btn btn-outline-primary btn-sm" onclick="FundModule.openSetFeeModal()" title="Cài đặt mức tiền quỹ chung">
                  <i class="fas fa-sliders"></i> Mức quỹ
                </button>
                <button class="btn btn-secondary btn-sm" onclick="FundModule.sendReminderMessage()" title="Nhắc nhở qua Zalo">
                  <i class="fas fa-bell"></i> Nhắc nhở
                </button>
              ` : ''}
            </div>
          </div>
        </div>
      `;
    }

    // Render Table
    this.renderDuesTable(monthDues, members);
  },

  renderDuesTable(monthDues, members) {
    const container = document.getElementById('dues-table-body');
    if (!container) return;

    const data = AppStorage.loadData();
    const currentUser = AppStorage.getCurrentUser();
    const isAdmin = AppStorage.isAdmin();
    const defaultMonthlyFee = this.getClubFee(data);

    let filtered = monthDues;
    if (this.currentFilter !== 'all') {
      filtered = monthDues.filter(d => d.status === this.currentFilter);
    }

    if (filtered.length === 0) {
      container.innerHTML = `
        <tr>
          <td colspan="7" class="text-center text-muted" style="padding: 2.5rem 1rem;">
            <i class="fas fa-receipt" style="font-size: 2rem; margin-bottom: 0.5rem; display: block;"></i>
            Không có dữ liệu thành viên ở danh mục này.
          </td>
        </tr>
      `;
      return;
    }

    container.innerHTML = filtered.map((due, idx) => {
      const member = members.find(m => m.id === due.memberId) || { name: 'Thành viên', phone: '', avatar: '' };
      const dueAmount = Number(due.amount) || defaultMonthlyFee;

      const isSelf = currentUser && (
        member.id === currentUser.id || 
        member.id === currentUser.memberId || 
        (currentUser.username && member.username === currentUser.username) ||
        (currentUser.phone && member.phone && currentUser.phone.replace(/\D/g, '') === member.phone.replace(/\D/g, ''))
      );
      const canViewDetails = isAdmin || isSelf;

      let statusBadge = '';
      if (canViewDetails) {
        if (due.status === 'paid') {
          statusBadge = `<span class="badge badge-paid"><i class="fas fa-check"></i> Đã đóng</span>`;
        } else if (due.status === 'pending') {
          statusBadge = `<span class="badge badge-pending"><i class="fas fa-clock"></i> Chờ duyệt</span>`;
        } else {
          statusBadge = `<span class="badge badge-unpaid"><i class="fas fa-exclamation"></i> Chưa đóng</span>`;
        }
      } else {
        statusBadge = `<span class="badge badge-neutral" style="font-size: 0.72rem;" title="Thông tin đóng quỹ chỉ hiển thị cho Ban Quản trị và chính chủ"><i class="fas fa-lock text-muted"></i> Riêng tư</span>`;
      }

      return `
        <tr>
          <td class="font-mono text-muted text-center" style="width: 40px;">${idx + 1}</td>
          <td>
            <div class="flex items-center gap-3">
              <img class="avatar" src="${member.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(member.name)}&background=10b981&color=fff`}" alt="${member.name}" onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(member.name)}&background=10b981&color=fff'">
              <div>
                <div class="font-bold flex items-center gap-2">
                  ${member.name}
                  ${isSelf ? `<span class="badge badge-neutral" style="font-size: 0.65rem;">Bạn</span>` : ''}
                </div>
                <div class="text-secondary" style="font-size: 0.78rem;">
                  <i class="fas fa-phone-alt"></i> ${member.phone ? AppStorage.maskPhone(member.phone, member.id) : 'Chưa có SĐT'}
                </div>
              </div>
            </div>
          </td>
          <td>
            <div style="display: flex; align-items: center; gap: 0.4rem;">
              <strong class="font-mono text-primary">${dueAmount.toLocaleString('vi-VN')} đ</strong>
              ${isAdmin ? `
                <button class="btn btn-ghost btn-xs text-muted hover:text-primary" onclick="FundModule.openEditMemberDueModal('${due.id || ('due_' + FundModule.currentMonth + '_' + member.id)}', '${member.id}')" title="Admin: Chỉnh sửa số tiền cần đóng của thành viên này" style="padding: 2px 6px; font-size: 0.75rem; border-radius: 4px; background: rgba(255,255,255,0.05);">
                  <i class="fas fa-pen-to-square"></i>
                </button>
              ` : ''}
            </div>
            ${due.note && due.note !== 'Chưa đóng' ? `<div class="text-muted" style="font-size: 0.72rem; margin-top: 0.15rem;">${due.note}</div>` : ''}
          </td>
          <td>
            ${statusBadge}
            ${(canViewDetails && due.approvedBy) ? `<div class="text-muted" style="font-size: 0.72rem; margin-top: 0.2rem;">(Duyệt: ${due.approvedBy})</div>` : ''}
          </td>
          <td>
            ${canViewDetails ? (due.paidAt ? `
              <div style="font-size: 0.85rem;">${due.paidAt}</div>
              <div class="text-secondary" style="font-size: 0.75rem;">${due.method || 'VietQR'}</div>
            ` : `<span class="text-muted">-</span>`) : `<span class="text-muted font-mono">-</span>`}
          </td>
          <td>
            ${canViewDetails ? (due.billImage ? `
              <button class="btn btn-secondary btn-sm" onclick="FundModule.previewBill('${due.billImage}', '${member.name}')">
                <i class="fas fa-image"></i> Xem biên lai
              </button>
            ` : `<span class="text-muted" style="font-size: 0.8rem;">Không có</span>`) : `<span class="text-muted font-mono">-</span>`}
          </td>
          <td class="text-right">
            <div class="flex justify-end gap-2">
              ${due.status === 'pending' && isAdmin ? `
                <button class="btn btn-primary btn-sm" onclick="FundModule.approveDue('${due.id || due.memberId}', true)">
                  <i class="fas fa-check"></i> Duyệt
                </button>
                <button class="btn btn-danger btn-sm" onclick="FundModule.approveDue('${due.id || due.memberId}', false)">
                  <i class="fas fa-times"></i>
                </button>
              ` : ''}

              ${due.status === 'unpaid' && (isAdmin || isSelf) ? `
                <button class="btn btn-primary btn-sm" onclick="FundModule.openPaymentModal('${member.id}')">
                  <i class="fas fa-credit-card"></i> ${isSelf ? 'Đóng quỹ' : 'Nộp quỹ'}
                </button>
                ${isAdmin ? `
                  <button class="btn btn-secondary btn-sm" onclick="FundModule.markPaidCash('${member.id}')" title="Đánh dấu đã nộp tiền mặt">
                    <i class="fas fa-money-bill"></i> Tiền mặt
                  </button>
                ` : ''}
              ` : ''}

              ${due.status === 'paid' && isAdmin ? `
                <button class="btn btn-secondary btn-sm" onclick="FundModule.resetDueStatus('${member.id}')" title="Thu hồi / Đổi trạng thái">
                  <i class="fas fa-undo"></i>
                </button>
              ` : ''}
            </div>
          </td>
        </tr>
      `;
    }).join('');
  },

  // Modal cho Admin cài đặt mức quỹ tháng chung của CLB
  openSetFeeModal() {
    if (!AppStorage.isAdmin()) {
      App.showToast("Chỉ Quản trị viên mới có quyền cài đặt số tiền quỹ tháng!", "warning");
      App.showAuthModal('login');
      return;
    }

    const data = AppStorage.loadData();
    const currentFee = this.getClubFee(data);

    const modalBody = `
      <form onsubmit="FundModule.saveClubFee(event)" style="display: flex; flex-direction: column; gap: 1rem;">
        <div class="form-group">
          <label class="form-label" style="font-weight: 600;">Mức thu quỹ tháng tiêu chuẩn của CLB (VNĐ):</label>
          <div style="position: relative;">
            <input type="number" id="set-fund-fee-input" class="form-control" min="0" step="1000" value="${currentFee}" required style="font-size: 1.15rem; font-weight: bold; padding-right: 3rem;">
            <span style="position: absolute; right: 1rem; top: 50%; transform: translateY(-50%); color: var(--text-secondary); font-weight: 600;">VNĐ</span>
          </div>
          <small class="text-secondary" style="margin-top: 0.35rem; display: block;">
            Mức này dùng làm mặc định cho tất cả thành viên cố định trong CLB.
          </small>
        </div>

        <div style="background: rgba(255, 255, 255, 0.03); padding: 0.85rem 1rem; border-radius: 8px; border: 1px solid var(--border-color);">
          <label style="display: flex; align-items: flex-start; gap: 0.6rem; cursor: pointer; margin-bottom: 0;">
            <input type="checkbox" id="set-fund-fee-apply-unpaid" checked style="margin-top: 0.2rem;">
            <span style="font-size: 0.9rem; line-height: 1.4;">
              Áp dụng mức tiền mới này cho tất cả thành viên <strong>chưa đóng</strong> của tháng ${this.currentMonth.slice(5)}/${this.currentMonth.slice(0, 4)}
            </span>
          </label>
        </div>

        <div class="flex justify-end gap-2" style="margin-top: 1rem;">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Hủy</button>
          <button type="submit" class="btn btn-primary">
            <i class="fas fa-save"></i> Lưu cài đặt mức quỹ
          </button>
        </div>
      </form>
    `;

    App.openModal("⚙️ Cài đặt mức tiền quỹ tháng CLB", modalBody);
  },

  async saveClubFee(e) {
    e.preventDefault();
    if (!AppStorage.isAdmin()) {
      App.showToast("Chỉ Quản trị viên mới có quyền cài đặt số tiền quỹ tháng!", "warning");
      return;
    }

    const input = document.getElementById('set-fund-fee-input');
    const applyUnpaidCheckbox = document.getElementById('set-fund-fee-apply-unpaid');
    if (!input) return;

    const newFee = Math.max(0, parseInt(input.value, 10) || 0);
    const applyUnpaid = applyUnpaidCheckbox ? applyUnpaidCheckbox.checked : true;

    const data = AppStorage.loadData();
    if (!data.clubInfo) data.clubInfo = {};
    data.clubInfo.monthlyFee = newFee;
    data.clubInfo.monthlyFundFee = newFee;

    if (applyUnpaid && Array.isArray(data.monthlyContributions)) {
      data.monthlyContributions.forEach(d => {
        if (d.month === this.currentMonth && d.status === 'unpaid') {
          d.amount = newFee;
        }
      });
    }

    App.showToast(`⏳ Đang lưu mức quỹ ${newFee.toLocaleString('vi-VN')}đ lên Cloud...`, "info");
    const result = await AppStorage.saveDataWithCloudAck(data);
    App.closeModal();

    if (result.success) {
      App.showToast(`✅ Đã cập nhật mức thu quỹ tháng thành ${newFee.toLocaleString('vi-VN')} VNĐ!`, "success");
    } else {
      App.showToast(`⚠️ Đã lưu trên máy, đang chờ kết nối lại Cloud.`, "warning");
    }

    this.renderFundDashboard();
    App.refreshDashboardStats();
  },

  // Modal cho Admin chỉnh sửa riêng mức đóng của 1 thành viên
  openEditMemberDueModal(dueId, memberId) {
    if (!AppStorage.isAdmin()) {
      App.showToast("Chỉ Quản trị viên mới có quyền sửa số tiền nộp của thành viên!", "warning");
      App.showAuthModal('login');
      return;
    }

    const data = AppStorage.loadData();
    const defaultMonthlyFee = this.getClubFee(data);
    const member = (data.members || []).find(m => m.id === memberId) || { name: 'Thành viên' };
    const dues = data.monthlyContributions || [];
    const due = dues.find(d => (d.id === dueId || d.memberId === memberId) && d.month === this.currentMonth) || {
      id: dueId,
      amount: defaultMonthlyFee,
      note: ''
    };

    const currentAmount = Number(due.amount) || defaultMonthlyFee;

    const modalBody = `
      <form onsubmit="FundModule.saveMemberDueAmount(event, '${due.id}', '${memberId}')" style="display: flex; flex-direction: column; gap: 1rem;">
        <div class="form-group">
          <label class="form-label">Thành viên:</label>
          <input type="text" class="form-control" value="${member.name} (${member.phone ? AppStorage.maskPhone(member.phone, member.id) : 'Cố định'})" disabled style="opacity: 0.85; font-weight: 600;">
        </div>

        <div class="form-group">
          <label class="form-label" style="font-weight: 600;">Số tiền cần đóng tháng ${this.currentMonth.slice(5)}/${this.currentMonth.slice(0, 4)} (VNĐ):</label>
          <div style="position: relative;">
            <input type="number" id="edit-member-due-amount" class="form-control" min="0" step="1000" value="${currentAmount}" required style="font-size: 1.15rem; font-weight: bold; padding-right: 3rem;">
            <span style="position: absolute; right: 1rem; top: 50%; transform: translateY(-50%); color: var(--text-secondary); font-weight: 600;">VNĐ</span>
          </div>
          <small class="text-secondary" style="margin-top: 0.35rem; display: block;">
            Mã VietQR của thành viên này sẽ tự động cập nhật đúng số tiền này.
          </small>
        </div>

        <div class="form-group">
          <label class="form-label">Ghi chú điều chỉnh (Tùy chọn - lý do giảm/tăng/miễn phí):</label>
          <input type="text" id="edit-member-due-note" class="form-control" value="${due.note && due.note !== 'Chưa đóng' ? due.note : ''}" placeholder="Ví dụ: Giảm 50% do nghỉ nửa tháng / Hỗ trợ quỹ / Miễn phí">
        </div>

        <div class="flex justify-end gap-2" style="margin-top: 1rem;">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Hủy</button>
          <button type="submit" class="btn btn-primary">
            <i class="fas fa-save"></i> Cập nhật mức đóng
          </button>
        </div>
      </form>
    `;

    App.openModal(`✏️ Chỉnh sửa mức đóng quỹ - ${member.name}`, modalBody);
  },

  async saveMemberDueAmount(e, dueId, memberId) {
    e.preventDefault();
    if (!AppStorage.isAdmin()) {
      App.showToast("Chỉ Quản trị viên mới có quyền sửa số tiền nộp của thành viên!", "warning");
      return;
    }

    const amountInput = document.getElementById('edit-member-due-amount');
    const noteInput = document.getElementById('edit-member-due-note');
    if (!amountInput) return;

    const newAmount = Math.max(0, parseInt(amountInput.value, 10) || 0);
    const newNote = noteInput ? noteInput.value.trim() : '';

    const data = AppStorage.loadData();
    if (!data.monthlyContributions) data.monthlyContributions = [];

    const member = (data.members || []).find(m => m.id === memberId) || { name: 'Thành viên' };
    let due = data.monthlyContributions.find(d => (d.id === dueId || d.memberId === memberId) && d.month === this.currentMonth);

    if (!due) {
      due = {
        id: dueId || `due_${this.currentMonth}_${memberId}`,
        month: this.currentMonth,
        memberId: memberId,
        amount: newAmount,
        status: 'unpaid',
        paidAt: null,
        method: null,
        billImage: null,
        approvedBy: null,
        approvedAt: null,
        note: newNote || 'Chưa đóng'
      };
      data.monthlyContributions.push(due);
    } else {
      due.amount = newAmount;
      if (newNote) {
        due.note = newNote;
      }
    }

    // Nếu khoản này đã được duyệt đóng (paid), cập nhật luôn số tiền tương ứng trong Sổ quỹ transactions
    if (due.status === 'paid' && Array.isArray(data.transactions)) {
      const tx = data.transactions.find(t => t.dueId === due.id);
      if (tx) {
        tx.amount = newAmount;
      }
    }

    App.showToast(`⏳ Đang lưu mức đóng ${newAmount.toLocaleString('vi-VN')}đ cho ${member.name} lên Cloud...`, "info");
    const result = await AppStorage.saveDataWithCloudAck(data);
    App.closeModal();

    if (result.success) {
      App.showToast(`✅ Đã cập nhật mức đóng quỹ của ${member.name} thành ${newAmount.toLocaleString('vi-VN')} VNĐ!`, "success");
    } else {
      App.showToast(`⚠️ Đã lưu trên máy, đang chờ kết nối lại Cloud.`, "warning");
    }

    this.renderFundDashboard();
    App.refreshDashboardStats();
  },

  setFilter(filter) {
    if (!AppStorage.isAdmin() && filter !== 'all') {
      App.showToast("Bộ lọc theo trạng thái đóng quỹ chi tiết chỉ dành cho Quản trị viên!", "info");
      return;
    }
    this.currentFilter = filter;
    document.querySelectorAll('.fund-filter-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`[data-fund-filter="${filter}"]`)?.classList.add('active');
    this.renderFundDashboard();
  },

  openPaymentModal(memberId) {
    const data = AppStorage.loadData();
    const defaultMonthlyFee = this.getClubFee(data);
    const member = (data.members || []).find(m => m.id === memberId) || data.currentUser || { name: 'Thành viên', id: memberId };
    const info = data.clubInfo || {};
    const bank = info.bank || { bankId: '970422', bankName: 'MB Bank', accountNo: '0988776655', accountName: 'NGUYEN VAN ADMIN' };
    
    // Tìm due của thành viên để lấy chính xác số tiền được Admin cài đặt
    const dues = data.monthlyContributions || [];
    const due = dues.find(d => d.memberId === member.id && d.month === this.currentMonth);
    const amount = Number(due && due.amount) || defaultMonthlyFee;
    const month = this.currentMonth;
    
    // Transfer memo standard: CLB SMASH T9 NGUYEN VAN A
    const memberSlug = (member.name || 'THANH VIEN').toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Z0-9]/g, " ");
    const memo = `CLB ${(info.shortName || 'SMASH').toUpperCase()} T${month.slice(5)} ${memberSlug.split(' ').slice(-2).join(' ')}`.trim();

    // VietQR quick URL
    const qrUrl = `https://api.vietqr.io/image/${bank.bankId}-${bank.accountNo}-compact2.jpg?amount=${amount}&addInfo=${encodeURIComponent(memo)}&accountName=${encodeURIComponent(bank.accountName)}`;

    const modalBody = `
      <div class="vietqr-card">
        <div class="vietqr-header">
          <div class="vietqr-bank-logo">${bank.bankName}</div>
          <span class="badge badge-paid">VietQR chuẩn Napas 247</span>
        </div>

        <div class="vietqr-img-wrapper">
          <img src="${qrUrl}" alt="VietQR thanh toán" onerror="this.src='https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(`STK:${bank.accountNo}|BANK:${bank.bankId}|AMOUNT:${amount}|NOTE:${memo}`)}'">
        </div>

        <div class="vietqr-details-list">
          <div class="vietqr-detail-row">
            <span class="vietqr-detail-label">Thành viên nộp:</span>
            <span class="vietqr-detail-value font-bold">${member.name}</span>
          </div>

          <div class="vietqr-detail-row">
            <span class="vietqr-detail-label">Chủ tài khoản:</span>
            <span class="vietqr-detail-value font-mono">${bank.accountName}</span>
          </div>

          <div class="vietqr-detail-row">
            <span class="vietqr-detail-label">Số tài khoản:</span>
            <span class="vietqr-detail-value font-mono">
              ${bank.accountNo}
              <button class="copy-btn" onclick="navigator.clipboard.writeText('${bank.accountNo}'); App.showToast('Đã sao chép số tài khoản!', 'success');" title="Sao chép STK">
                <i class="far fa-copy"></i>
              </button>
            </span>
          </div>

          <div class="vietqr-detail-row">
            <span class="vietqr-detail-label">Số tiền cần đóng:</span>
            <span class="vietqr-detail-value font-mono text-primary font-bold" style="font-size: 1.1rem;">
              ${amount.toLocaleString('vi-VN')} VNĐ
              <button class="copy-btn" onclick="navigator.clipboard.writeText('${amount}'); App.showToast('Đã sao chép số tiền!', 'success');" title="Sao chép số tiền">
                <i class="far fa-copy"></i>
              </button>
            </span>
          </div>

          <div class="vietqr-detail-row">
            <span class="vietqr-detail-label">Nội dung chuyển khoản:</span>
            <span class="vietqr-detail-value font-mono text-warning">
              ${memo}
              <button class="copy-btn" onclick="navigator.clipboard.writeText('${memo}'); App.showToast('Đã sao chép cú pháp chuyển khoản!', 'success');" title="Sao chép nội dung">
                <i class="far fa-copy"></i>
              </button>
            </span>
          </div>
        </div>
      </div>

      <!-- Proof of payment form -->
      <div style="margin-top: 1.5rem; background: var(--bg-card); padding: 1.25rem; border-radius: var(--radius-lg); border: 1px solid var(--border-color);">
        <h4 style="margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.5rem;">
          <i class="fas fa-check-circle text-primary"></i> Xác nhận sau khi chuyển khoản
        </h4>
        <p class="text-secondary" style="font-size: 0.85rem; margin-bottom: 1rem;">
          ${info.autoApprove ? 
            '⚡ <strong>Chế độ tự động duyệt:</strong> Trạng thái của bạn sẽ được kích hoạt "ĐÃ ĐÓNG" ngay khi bấm xác nhận.' : 
            '🛡️ <strong>Chế độ duyệt ban quản trị:</strong> Sau khi bạn xác nhận, thủ quỹ sẽ kiểm tra sao kê và duyệt trong ít phút.'}
        </p>

        <div class="form-group">
          <label class="form-label">Tải ảnh chụp màn hình biên lai (tùy chọn):</label>
          <input type="file" id="bill-file-input" class="form-control" accept="image/*" onchange="FundModule.handleBillUpload(event)">
          <div id="bill-preview-container" style="display: none; margin-top: 0.5rem; text-align: center;">
            <img id="bill-preview-img" style="max-height: 140px; border-radius: 8px; border: 1px solid var(--border-color);" src="" alt="Bill preview">
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Ghi chú xác nhận:</label>
          <input type="text" id="bill-note" class="form-control" value="Đã chuyển khoản thành công lúc ${new Date().toLocaleTimeString('vi-VN', {hour: '2-digit', minute:'2-digit'})}">
        </div>

        <button type="button" class="btn btn-primary w-full btn-lg" onclick="FundModule.submitPayment('${member.id}')">
          <i class="fas fa-paper-plane"></i> Tôi đã chuyển khoản thành công
        </button>
      </div>
    `;

    App.openModal("💳 Thanh toán quỹ tháng bằng VietQR", modalBody, true);
  },

  handleBillUpload(e) {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const previewImg = document.getElementById('bill-preview-img');
        const container = document.getElementById('bill-preview-container');
        if (previewImg && container) {
          previewImg.src = event.target.result;
          container.style.display = 'block';
        }
      };
      reader.readAsDataURL(file);
    }
  },

  async submitPayment(memberId) {
    const data = AppStorage.loadData();
    const defaultMonthlyFee = this.getClubFee(data);
    const info = data.clubInfo || {};
    const member = (data.members || []).find(m => m.id === memberId) || data.currentUser || { name: 'Thành viên', id: memberId };
    const note = document.getElementById('bill-note')?.value.trim() || 'Đã chuyển khoản';
    const previewImg = document.getElementById('bill-preview-img');
    const billImage = (previewImg && previewImg.src && previewImg.src.startsWith('data:')) ? 
      previewImg.src : 
      'https://images.unsplash.com/photo-1554224155-8d04cb21cd6c?w=400&auto=format&fit=crop&q=80';

    if (!data.monthlyContributions) data.monthlyContributions = [];

    const isAuto = info.autoApprove === true;
    const newStatus = isAuto ? 'paid' : 'pending';
    const nowStr = new Date().toISOString().slice(0, 16).replace('T', ' ');

    let dueIndex = data.monthlyContributions.findIndex(d => d.memberId === memberId && d.month === this.currentMonth);
    const dueId = dueIndex >= 0 ? data.monthlyContributions[dueIndex].id : `due_${this.currentMonth}_${memberId}`;
    const dueAmount = (dueIndex >= 0 && Number(data.monthlyContributions[dueIndex].amount)) ? Number(data.monthlyContributions[dueIndex].amount) : defaultMonthlyFee;

    const record = {
      id: dueId,
      month: this.currentMonth,
      memberId: memberId,
      amount: dueAmount,
      status: newStatus,
      paidAt: nowStr,
      method: 'Chuyển khoản VietQR',
      billImage: billImage,
      approvedBy: isAuto ? 'Tự động duyệt' : null,
      approvedAt: isAuto ? nowStr : null,
      note: note
    };

    if (dueIndex >= 0) {
      data.monthlyContributions[dueIndex] = record;
    } else {
      data.monthlyContributions.push(record);
    }

    // Nếu bật tự động duyệt -> Tạo hoặc cập nhật giao dịch thu quỹ với dueId định danh
    if (isAuto) {
      if (!data.transactions) data.transactions = [];
      const existingTxIdx = data.transactions.findIndex(t => t.dueId === dueId);
      const txRecord = {
        id: existingTxIdx >= 0 ? data.transactions[existingTxIdx].id : `tx_${Date.now()}`,
        dueId: dueId,
        date: new Date().toISOString().slice(0, 10),
        type: 'income',
        category: 'Quỹ tháng',
        title: `Thu quỹ T${this.currentMonth.slice(5)} từ ${member.name}`,
        amount: dueAmount,
        createdBy: 'Hệ thống tự động duyệt',
        note: `Đóng quỹ VietQR tự động (${member.name})`
      };
      if (existingTxIdx >= 0) {
        data.transactions[existingTxIdx] = txRecord;
      } else {
        data.transactions.unshift(txRecord);
      }
    }

    App.showToast(`⏳ Đang ghi nhận đóng quỹ của ${member.name} và đồng bộ lên Cloud...`, "info");
    const result = await AppStorage.saveDataWithCloudAck(data);
    App.closeModal();

    if (isAuto) {
      App.showToast(`🎉 Đã thanh toán và tự động duyệt thành công cho ${member.name}! CSDL Cloud đã cập nhật.`, "success");
      if (window.confetti) {
        window.confetti({ particleCount: 70, spread: 70, origin: { y: 0.6 } });
      }
    } else {
      App.showToast(`✅ Đã gửi thông tin chuyển khoản của ${member.name}! Đang chờ Ban quản trị duyệt.`, "info");
    }

    this.renderFundDashboard();
    App.refreshDashboardStats();
  },

  async approveDue(dueIdOrMemberId, isApproved) {
    if (!AppStorage.isAdmin()) {
      App.showToast("Chỉ Ban quản trị/Thủ quỹ mới có quyền duyệt đóng quỹ!", "warning");
      App.showAuthModal('login');
      return;
    }

    const data = AppStorage.loadData();
    const dues = data.monthlyContributions || [];
    const defaultMonthlyFee = this.getClubFee(data);
    const currentUser = data.currentUser || AppStorage.getCurrentUser();
    const approverName = (currentUser && currentUser.name) || 'Ban quản trị CLB';

    const due = dues.find(d => (d.id === dueIdOrMemberId || d.memberId === dueIdOrMemberId) && d.month === this.currentMonth);
    if (!due) return;

    const member = (data.members || []).find(m => m.id === due.memberId) || { name: 'Thành viên' };
    const dueAmount = Number(due.amount) || defaultMonthlyFee;

    if (isApproved) {
      due.status = 'paid';
      due.approvedBy = approverName;
      due.approvedAt = new Date().toISOString().slice(0, 16).replace('T', ' ');

      // Thêm hoặc cập nhật giao dịch thu quỹ (liên kết 1-1 với dueId để chống tạo đúp)
      if (!data.transactions) data.transactions = [];
      const existingTxIdx = data.transactions.findIndex(t => t.dueId === due.id);
      const txRecord = {
        id: existingTxIdx >= 0 ? data.transactions[existingTxIdx].id : `tx_${Date.now()}`,
        dueId: due.id,
        date: new Date().toISOString().slice(0, 10),
        type: 'income',
        category: 'Quỹ tháng',
        title: `Thu quỹ T${this.currentMonth.slice(5)} từ ${member.name}`,
        amount: dueAmount,
        createdBy: approverName,
        note: `Admin duyệt chuyển khoản (${member.name})`
      };
      if (existingTxIdx >= 0) {
        data.transactions[existingTxIdx] = txRecord;
      } else {
        data.transactions.unshift(txRecord);
      }

      App.showToast(`⏳ Đang lưu xác nhận duyệt quỹ cho ${member.name} lên Cloud...`, "info");
      const result = await AppStorage.saveDataWithCloudAck(data);
      if (result.success) {
        App.showToast(`✅ Đã duyệt quỹ thành công cho ${member.name}! Sổ quỹ đã ghi nhận và lưu Cloud vĩnh viễn.`, "success");
      } else {
        App.showToast(`⚠️ Đã duyệt trên máy, đang chờ đồng bộ lại Cloud.`, "warning");
      }
    } else {
      due.status = 'unpaid';
      due.note = 'Ban quản trị từ chối xác nhận';
      // Xóa giao dịch thu quỹ nếu có
      if (Array.isArray(data.transactions)) {
        data.transactions = data.transactions.filter(t => t.dueId !== due.id);
      }
      App.showToast(`⏳ Đang lưu từ chối giao dịch lên Cloud...`, "info");
      await AppStorage.saveDataWithCloudAck(data);
      App.showToast(`Đã từ chối xác nhận quỹ của ${member.name}.`, "warning");
    }

    this.renderFundDashboard();
    App.refreshDashboardStats();
  },

  async markPaidCash(memberId) {
    if (!AppStorage.isAdmin()) {
      App.showToast("Chỉ Ban quản trị/Thủ quỹ mới có quyền ghi nhận thu tiền mặt!", "warning");
      App.showAuthModal('login');
      return;
    }

    const data = AppStorage.loadData();
    const defaultMonthlyFee = this.getClubFee(data);
    const currentUser = data.currentUser || AppStorage.getCurrentUser();
    const approverName = (currentUser && currentUser.name) || 'Ban quản trị CLB';
    const member = (data.members || []).find(m => m.id === memberId);
    if (!member) return;

    if (!data.monthlyContributions) data.monthlyContributions = [];

    const nowStr = new Date().toISOString().slice(0, 16).replace('T', ' ');
    let dueIndex = data.monthlyContributions.findIndex(d => d.memberId === memberId && d.month === this.currentMonth);
    const dueId = dueIndex >= 0 ? data.monthlyContributions[dueIndex].id : `due_${this.currentMonth}_${memberId}`;
    const dueAmount = (dueIndex >= 0 && Number(data.monthlyContributions[dueIndex].amount)) ? Number(data.monthlyContributions[dueIndex].amount) : defaultMonthlyFee;

    const record = {
      id: dueId,
      month: this.currentMonth,
      memberId: memberId,
      amount: dueAmount,
      status: 'paid',
      paidAt: nowStr,
      method: 'Tiền mặt',
      billImage: null,
      approvedBy: approverName,
      approvedAt: nowStr,
      note: 'Đã nộp tiền mặt trực tiếp'
    };

    if (dueIndex >= 0) {
      data.monthlyContributions[dueIndex] = record;
    } else {
      data.monthlyContributions.push(record);
    }

    // Thêm hoặc cập nhật giao dịch thu tiền mặt với dueId
    if (!data.transactions) data.transactions = [];
    const existingTxIdx = data.transactions.findIndex(t => t.dueId === dueId);
    const txRecord = {
      id: existingTxIdx >= 0 ? data.transactions[existingTxIdx].id : `tx_${Date.now()}`,
      dueId: dueId,
      date: new Date().toISOString().slice(0, 10),
      type: 'income',
      category: 'Quỹ tháng',
      title: `Thu tiền mặt quỹ T${this.currentMonth.slice(5)} từ ${member.name}`,
      amount: dueAmount,
      createdBy: approverName,
      note: `Tiền mặt thu trên sân (${member.name})`
    };

    if (existingTxIdx >= 0) {
      data.transactions[existingTxIdx] = txRecord;
    } else {
      data.transactions.unshift(txRecord);
    }

    App.showToast(`⏳ Đang lưu giao dịch tiền mặt của ${member.name} lên Cloud...`, "info");
    const result = await AppStorage.saveDataWithCloudAck(data);

    if (result.success) {
      App.showToast(`✅ Đã ghi nhận nộp tiền mặt cho ${member.name} (${dueAmount.toLocaleString('vi-VN')}đ) và đồng bộ Cloud thành công!`, "success");
    } else {
      App.showToast(`⚠️ Đã ghi nhận trên máy, đang chờ kết nối lại Cloud.`, "warning");
    }

    this.renderFundDashboard();
    App.refreshDashboardStats();
  },

  async resetDueStatus(memberId) {
    if (!confirm("Bạn có chắc chắn muốn chuyển trạng thái thành viên này về Chưa đóng?\nGiao dịch thu quỹ tương ứng trong Sổ quỹ sẽ tự động được thu hồi/xóa.")) return;
    const data = AppStorage.loadData();
    let due = (data.monthlyContributions || []).find(d => d.memberId === memberId && d.month === this.currentMonth);
    if (due) {
      due.status = 'unpaid';
      due.paidAt = null;
      due.approvedBy = null;
      due.approvedAt = null;
      due.note = 'Chưa đóng';

      // Thu hồi / Xóa giao dịch thu quỹ tương ứng trong Sổ quỹ (transactions)
      if (Array.isArray(data.transactions)) {
        data.transactions = data.transactions.filter(t => t.dueId !== due.id);
      }

      App.showToast(`⏳ Đang cập nhật trạng thái và khấu trừ số dư trên Cloud...`, "info");
      const result = await AppStorage.saveDataWithCloudAck(data);
      if (result.success) {
        App.showToast("✅ Đã chuyển về trạng thái Chưa đóng và cập nhật số dư Sổ quỹ trên Cloud!", "success");
      } else {
        App.showToast("⚠️ Đã cập nhật trên máy, đang chờ đồng bộ lại Cloud.", "warning");
      }

      this.renderFundDashboard();
      App.refreshDashboardStats();
    }
  },

  previewBill(imageUrl, memberName) {
    const modalBody = `
      <div class="text-center">
        <h4 style="margin-bottom: 1rem;">Biên lai chuyển khoản của <strong>${memberName}</strong></h4>
        <img src="${imageUrl}" alt="Biên lai thanh toán" style="max-width: 100%; max-height: 480px; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.3);">
        <div style="margin-top: 1.25rem;">
          <button class="btn btn-secondary" onclick="App.closeModal()">Đóng</button>
        </div>
      </div>
    `;
    App.openModal("🧾 Ảnh biên lai chuyển khoản", modalBody);
  },

  sendReminderMessage() {
    const data = AppStorage.loadData();
    const members = (data.members || []).filter(m => m.type === 'fixed');
    const dues = data.monthlyContributions || [];
    const info = data.clubInfo || {};
    const bank = info.bank || { bankId: '970422', bankName: 'MB Bank', accountNo: '0988776655', accountName: 'NGUYEN VAN ADMIN' };
    const defaultMonthlyFee = this.getClubFee(data);

    const unpaidMembers = members.filter(m => {
      const due = dues.find(d => d.memberId === m.id && d.month === this.currentMonth);
      return !due || due.status === 'unpaid';
    });

    if (unpaidMembers.length === 0) {
      App.showToast("Tất cả thành viên đã đóng quỹ đầy đủ trong tháng này!", "success");
      return;
    }

    const unpaidNames = unpaidMembers.map((m, idx) => {
      const due = dues.find(d => d.memberId === m.id && d.month === this.currentMonth);
      const amount = Number(due && due.amount) || defaultMonthlyFee;
      return `${idx + 1}. @${m.name} (${AppStorage.maskPhone(m.phone, m.id)}) - ${amount.toLocaleString('vi-VN')}đ`;
    }).join('\n');

    const reminderMsg = `📢 [${info.shortName || 'SMASH'}] NHẮC NHỞ ĐÓNG QUỸ TIỀN SÂN THÁNG ${this.currentMonth.slice(5)}/${this.currentMonth.slice(0, 4)}

Chào cả nhà, hiện tại còn ${unpaidMembers.length} thành viên chưa đóng quỹ tháng:
${unpaidNames}

💰 Mức đóng tiêu chuẩn: ${defaultMonthlyFee.toLocaleString('vi-VN')} VNĐ / người
🏦 Ngân hàng: ${bank.bankName}
💳 Số tài khoản: ${bank.accountNo}
👤 Chủ tài khoản: ${bank.accountName}
📝 Cú pháp CK: CLB ${(info.shortName || 'SMASH').toUpperCase()} T${this.currentMonth.slice(5)} [Tên bạn]

👉 Mọi người tranh thủ chuyển khoản sớm để thủ quỹ chốt tiền sân nhé! Cảm ơn cả nhà ❤️`;

    navigator.clipboard.writeText(reminderMsg).then(() => {
      App.showToast("Đã sao chép nội dung nhắc nhở quỹ vào Clipboard! Bạn có thể dán vào nhóm Zalo/Telegram ngay.", "success");
    }).catch(() => {
      prompt("Sao chép nội dung nhắc nhở:", reminderMsg);
    });
  }
};
