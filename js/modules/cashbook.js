// Cashbook & Financial Transactions Module with Charts, Edit & Delete capabilities
// Hỗ trợ Quản lý Thu - Chi, Chỉnh sửa/Xóa giao dịch (Admin), Biểu đồ tỷ lệ & Xuất CSV

const CashbookModule = {
  chartInstance: null,

  renderCashbook() {
    const data = AppStorage.loadData();
    const txs = data.transactions || [];
    const isAdmin = AppStorage.isAdmin();
    
    // Sắp xếp giao dịch mới nhất lên đầu
    const sortedTxs = [...txs].sort((a, b) => new Date(b.date) - new Date(a.date));

    // Tính toán tổng thu, tổng chi và số dư
    let totalIncome = 0;
    let totalExpense = 0;

    sortedTxs.forEach(t => {
      if (t.type === 'income') totalIncome += Number(t.amount);
      if (t.type === 'expense') totalExpense += Number(t.amount);
    });

    const currentBalance = totalIncome - totalExpense;

    // Cập nhật các thẻ thống kê tổng quan
    const balEl = document.getElementById('cashbook-balance');
    const incEl = document.getElementById('cashbook-income');
    const expEl = document.getElementById('cashbook-expense');

    if (balEl) balEl.innerText = `${currentBalance.toLocaleString('vi-VN')} đ`;
    if (incEl) incEl.innerText = `+${totalIncome.toLocaleString('vi-VN')} đ`;
    if (expEl) expEl.innerText = `-${totalExpense.toLocaleString('vi-VN')} đ`;

    // Render danh sách giao dịch
    const listContainer = document.getElementById('transaction-list-container');
    if (listContainer) {
      if (sortedTxs.length === 0) {
        listContainer.innerHTML = `
          <div class="text-center text-muted" style="padding: 2.5rem 1rem;">
            <i class="fas fa-receipt" style="font-size: 2rem; margin-bottom: 0.5rem; display: block; opacity: 0.5;"></i>
            Chưa có giao dịch thu chi nào trong sổ quỹ.
          </div>
        `;
      } else {
        listContainer.innerHTML = sortedTxs.map(t => {
          const isIncome = t.type === 'income';
          return `
            <div class="transaction-item ${isIncome ? 'income' : 'expense'}" style="display: flex; justify-content: space-between; align-items: center; padding: 0.85rem 1rem; border-bottom: 1px solid var(--border-color);">
              <div class="flex items-center gap-3">
                <div class="transaction-type-icon" style="width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: ${isIncome ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)'}; color: ${isIncome ? 'var(--primary)' : 'var(--danger)'};">
                  <i class="fas ${isIncome ? 'fa-arrow-down' : 'fa-arrow-up'}"></i>
                </div>
                <div>
                  <div class="font-bold" style="font-size: 0.95rem; color: var(--text-main);">${t.title}</div>
                  <div class="text-secondary" style="font-size: 0.78rem; margin-top: 0.15rem;">
                    <span><i class="far fa-calendar-alt"></i> ${t.date}</span> • 
                    <span class="badge badge-neutral" style="font-size: 0.7rem; padding: 0.1rem 0.35rem;">${t.category}</span> • 
                    <span>Ghi nhận bởi: <strong>${t.createdBy || 'Admin'}</strong></span>
                    ${t.updatedAt ? ` • <span class="text-muted" style="font-style: italic;">(Đã sửa)</span>` : ''}
                  </div>
                </div>
              </div>
              <div class="text-right flex flex-col items-end gap-1">
                <div class="transaction-amount ${isIncome ? 'income' : 'expense'}" style="font-weight: 700; font-size: 1rem; color: ${isIncome ? 'var(--primary)' : 'var(--danger)'};">
                  ${isIncome ? '+' : '-'}${Number(t.amount).toLocaleString('vi-VN')} đ
                </div>
                ${t.note ? `<div class="text-muted" style="font-size: 0.75rem; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">"${t.note}"</div>` : ''}
                ${isAdmin ? `
                  <div class="flex items-center gap-1" style="margin-top: 0.25rem;">
                    <button class="btn btn-secondary btn-xs" onclick="event.stopPropagation(); CashbookModule.openEditTransactionModal('${t.id}')" title="Chỉnh sửa giao dịch này" style="padding: 0.15rem 0.5rem; font-size: 0.72rem; border-radius: 4px;">
                      <i class="fas fa-edit text-primary"></i> Sửa
                    </button>
                    <button class="btn btn-outline-danger btn-xs" onclick="event.stopPropagation(); CashbookModule.deleteTransaction('${t.id}')" title="Xóa giao dịch này" style="padding: 0.15rem 0.5rem; font-size: 0.72rem; border-radius: 4px;">
                      <i class="fas fa-trash-alt"></i> Xóa
                    </button>
                  </div>
                ` : ''}
              </div>
            </div>
          `;
        }).join('');
      }
    }

    // Render or update Chart.js
    this.renderChart(totalIncome, totalExpense, currentBalance);
  },

  renderChart(income, expense, balance) {
    const canvas = document.getElementById('financial-chart');
    if (!canvas || !window.Chart) return;

    if (this.chartInstance) {
      this.chartInstance.destroy();
    }

    const isZero = income === 0 && expense === 0 && balance === 0;

    const ctx = canvas.getContext('2d');
    this.chartInstance = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: isZero ? ['Chưa có phát sinh thu chi'] : ['Tổng thu quỹ & vãng lai', 'Tổng chi sân & cầu', 'Số dư thực tế'],
        datasets: [{
          data: isZero ? [1] : [income, expense, Math.max(0, balance)],
          backgroundColor: isZero ? ['rgba(148, 163, 184, 0.15)'] : [
            'rgba(16, 185, 129, 0.85)',
            'rgba(239, 68, 68, 0.85)',
            'rgba(6, 182, 212, 0.85)'
          ],
          borderColor: isZero ? ['rgba(148, 163, 184, 0.3)'] : [
            '#10b981',
            '#ef4444',
            '#06b6d4'
          ],
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: '#94a3b8',
              font: { family: 'Plus Jakarta Sans', size: 12 }
            }
          },
          tooltip: {
            enabled: !isZero
          }
        },
        cutout: '65%'
      }
    });
  },

  openAddTransactionModal() {
    if (!AppStorage.isAdmin()) {
      App.showToast("Chỉ Ban quản trị/Thủ quỹ mới có quyền ghi chép thu chi vào sổ quỹ!", "warning");
      App.showAuthModal('login');
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const modalBody = `
      <form id="form-add-tx" onsubmit="CashbookModule.saveTransaction(event)">
        <div class="form-group">
          <label class="form-label font-bold">Loại thu chi *</label>
          <div style="display: flex; gap: 1rem;">
            <label style="display: flex; align-items: center; gap: 0.4rem; cursor: pointer;">
              <input type="radio" name="tx-type" value="income" checked> 
              <span class="text-primary font-bold"><i class="fas fa-plus-circle"></i> Khoản thu (vào quỹ)</span>
            </label>
            <label style="display: flex; align-items: center; gap: 0.4rem; cursor: pointer;">
              <input type="radio" name="tx-type" value="expense"> 
              <span class="text-danger font-bold"><i class="fas fa-minus-circle"></i> Khoản chi (chi tiền)</span>
            </label>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label font-bold">Tiêu đề giao dịch *</label>
          <input type="text" id="tx-title" class="form-control" placeholder="VD: Mua 4 ống cầu Hải Yến, Tiền thuê sân..." required>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
          <div class="form-group">
            <label class="form-label font-bold">Số tiền (VNĐ) *</label>
            <input type="number" id="tx-amount" class="form-control" placeholder="300000" step="5000" required>
          </div>
          <div class="form-group">
            <label class="form-label font-bold">Danh mục</label>
            <select id="tx-category" class="form-select">
              <option value="Quỹ tháng">Quỹ tháng</option>
              <option value="Tiền thuê sân">Tiền thuê sân</option>
              <option value="Mua cầu lông">Mua cầu lông</option>
              <option value="Khách vãng lai">Khách vãng lai</option>
              <option value="Nước uống & Tiện ích">Nước uống & Tiện ích</option>
              <option value="Khác">Khác</option>
            </select>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label font-bold">Ngày giao dịch *</label>
          <input type="date" id="tx-date" class="form-control" value="${today}" required>
        </div>

        <div class="form-group">
          <label class="form-label">Ghi chú thêm</label>
          <input type="text" id="tx-note" class="form-control" placeholder="Ghi chú chi tiết hoặc tên người liên quan">
        </div>

        <div class="modal-footer" style="padding: 1rem 0 0 0;">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Hủy</button>
          <button type="submit" class="btn btn-primary"><i class="fas fa-check"></i> Lưu giao dịch</button>
        </div>
      </form>
    `;

    App.openModal("📝 Ghi chép thu chi sổ quỹ", modalBody);
  },

  saveTransaction(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (!AppStorage.isAdmin()) {
      App.showToast("Chỉ Ban quản trị/Thủ quỹ mới có quyền ghi chép thu chi vào sổ quỹ!", "warning");
      App.showAuthModal('login');
      return;
    }

    const data = AppStorage.loadData();
    const typeEl = document.querySelector('input[name="tx-type"]:checked');
    const type = typeEl ? typeEl.value : 'income';
    const title = (document.getElementById('tx-title')?.value || '').trim();
    const amount = Number(document.getElementById('tx-amount')?.value || 0);
    const category = document.getElementById('tx-category')?.value || 'Khác';
    const date = document.getElementById('tx-date')?.value || new Date().toISOString().slice(0, 10);
    const note = (document.getElementById('tx-note')?.value || '').trim();
    const currentUser = data.currentUser || AppStorage.getCurrentUser();
    const creatorName = (currentUser && currentUser.name) || 'Ban quản trị CLB';

    if (!title || !amount || amount <= 0) {
      App.showToast("Vui lòng nhập đầy đủ tiêu đề và số tiền hợp lệ!", "warning");
      return;
    }

    if (!data.transactions) data.transactions = [];

    const newTx = {
      id: `tx_${Date.now()}`,
      date,
      type,
      category,
      title,
      amount,
      createdBy: creatorName,
      createdAt: new Date().toISOString(),
      note
    };

    data.transactions.unshift(newTx);
    AppStorage.saveData(data, true);
    App.closeModal();
    App.showToast("🎉 Đã lưu khoản thu chi vào sổ quỹ thành công!", "success");
    this.renderCashbook();
    App.refreshDashboardStats();
  },

  // ==========================================
  // CHỈNH SỬA GIAO DỊCH THU CHI (ADMIN)
  // ==========================================
  openEditTransactionModal(txId) {
    if (!AppStorage.isAdmin()) {
      App.showToast("Chỉ Ban quản trị/Thủ quỹ mới có quyền chỉnh sửa giao dịch thu chi!", "warning");
      return;
    }

    const data = AppStorage.loadData();
    const t = (data.transactions || []).find(tx => tx.id === txId);
    if (!t) {
      App.showToast("Không tìm thấy thông tin giao dịch cần chỉnh sửa!", "error");
      return;
    }

    const isIncome = t.type === 'income';
    const modalBody = `
      <form id="form-edit-tx" onsubmit="CashbookModule.saveEditTransaction(event, '${t.id}')">
        <div class="form-group">
          <label class="form-label font-bold">Loại thu chi *</label>
          <div style="display: flex; gap: 1rem;">
            <label style="display: flex; align-items: center; gap: 0.4rem; cursor: pointer;">
              <input type="radio" name="edit-tx-type" value="income" ${isIncome ? 'checked' : ''}> 
              <span class="text-primary font-bold"><i class="fas fa-plus-circle"></i> Khoản thu (vào quỹ)</span>
            </label>
            <label style="display: flex; align-items: center; gap: 0.4rem; cursor: pointer;">
              <input type="radio" name="edit-tx-type" value="expense" ${!isIncome ? 'checked' : ''}> 
              <span class="text-danger font-bold"><i class="fas fa-minus-circle"></i> Khoản chi (chi tiền)</span>
            </label>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label font-bold">Tiêu đề giao dịch *</label>
          <input type="text" id="edit-tx-title" class="form-control" value="${t.title}" placeholder="VD: Mua 4 ống cầu Hải Yến, Tiền thuê sân..." required>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
          <div class="form-group">
            <label class="form-label font-bold">Số tiền (VNĐ) *</label>
            <input type="number" id="edit-tx-amount" class="form-control" value="${t.amount}" placeholder="300000" step="5000" required>
          </div>
          <div class="form-group">
            <label class="form-label font-bold">Danh mục</label>
            <select id="edit-tx-category" class="form-select">
              <option value="Quỹ tháng" ${t.category === 'Quỹ tháng' ? 'selected' : ''}>Quỹ tháng</option>
              <option value="Tiền thuê sân" ${t.category === 'Tiền thuê sân' ? 'selected' : ''}>Tiền thuê sân</option>
              <option value="Mua cầu lông" ${t.category === 'Mua cầu lông' ? 'selected' : ''}>Mua cầu lông</option>
              <option value="Khách vãng lai" ${t.category === 'Khách vãng lai' ? 'selected' : ''}>Khách vãng lai</option>
              <option value="Nước uống & Tiện ích" ${t.category === 'Nước uống & Tiện ích' ? 'selected' : ''}>Nước uống & Tiện ích</option>
              <option value="Khác" ${t.category === 'Khác' ? 'selected' : ''}>Khác</option>
            </select>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label font-bold">Ngày giao dịch *</label>
          <input type="date" id="edit-tx-date" class="form-control" value="${t.date}" required>
        </div>

        <div class="form-group">
          <label class="form-label">Ghi chú thêm</label>
          <input type="text" id="edit-tx-note" class="form-control" value="${t.note || ''}" placeholder="Ghi chú chi tiết hoặc tên người liên quan">
        </div>

        <div class="modal-footer" style="padding: 1rem 0 0 0; display: flex; justify-content: space-between; align-items: center;">
          <button type="button" class="btn btn-outline-danger btn-sm" onclick="CashbookModule.deleteTransaction('${t.id}')">
            <i class="fas fa-trash-alt"></i> Xóa giao dịch này
          </button>
          <div class="flex gap-2">
            <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Hủy</button>
            <button type="submit" class="btn btn-primary"><i class="fas fa-save"></i> Cập nhật thay đổi</button>
          </div>
        </div>
      </form>
    `;

    App.openModal("✏️ Chỉnh sửa giao dịch thu chi", modalBody);
  },

  saveEditTransaction(e, txId) {
    if (e && e.preventDefault) e.preventDefault();
    if (!AppStorage.isAdmin()) {
      App.showToast("Chỉ Ban quản trị/Thủ quỹ mới có quyền chỉnh sửa giao dịch thu chi!", "warning");
      return;
    }

    const data = AppStorage.loadData();
    const t = (data.transactions || []).find(tx => tx.id === txId);
    if (!t) {
      App.showToast("Không tìm thấy giao dịch để cập nhật!", "error");
      return;
    }

    const typeEl = document.querySelector('input[name="edit-tx-type"]:checked');
    const type = typeEl ? typeEl.value : 'income';
    const title = (document.getElementById('edit-tx-title')?.value || '').trim();
    const amount = Number(document.getElementById('edit-tx-amount')?.value || 0);
    const category = document.getElementById('edit-tx-category')?.value || 'Khác';
    const date = document.getElementById('edit-tx-date')?.value || t.date;
    const note = (document.getElementById('edit-tx-note')?.value || '').trim();
    const currentUser = data.currentUser || AppStorage.getCurrentUser();
    const updaterName = (currentUser && currentUser.name) || 'Admin';

    if (!title || !amount || amount <= 0) {
      App.showToast("Vui lòng nhập đầy đủ tiêu đề và số tiền hợp lệ!", "warning");
      return;
    }

    t.type = type;
    t.title = title;
    t.amount = amount;
    t.category = category;
    t.date = date;
    t.note = note;
    t.updatedAt = new Date().toISOString();
    t.updatedBy = updaterName;

    AppStorage.saveData(data, true);
    App.closeModal();
    App.showToast(`🎉 Đã cập nhật giao dịch "${title}" thành công!`, "success");
    this.renderCashbook();
    App.refreshDashboardStats();
  },

  // ==========================================
  // XÓA GIAO DỊCH THU CHI (ADMIN)
  // ==========================================
  deleteTransaction(txId) {
    if (!AppStorage.isAdmin()) {
      App.showToast("Chỉ Ban quản trị/Thủ quỹ mới có quyền xóa giao dịch thu chi!", "warning");
      return;
    }

    const data = AppStorage.loadData();
    const t = (data.transactions || []).find(tx => tx.id === txId);
    if (!t) {
      App.showToast("Không tìm thấy giao dịch cần xóa!", "error");
      return;
    }

    const amountFormatted = Number(t.amount).toLocaleString('vi-VN');
    if (!confirm(`Bạn có chắc chắn muốn xóa giao dịch "${t.title}" (${t.type === 'income' ? '+' : '-'}${amountFormatted} đ) khỏi sổ quỹ không?`)) {
      return;
    }

    data.transactions = (data.transactions || []).filter(tx => tx.id !== txId);
    AppStorage.saveData(data, true);
    App.closeModal();
    App.showToast(`Đã xóa giao dịch "${t.title}" khỏi sổ quỹ thành công!`, "info");
    this.renderCashbook();
    App.refreshDashboardStats();
  },

  exportCSV() {
    const data = AppStorage.loadData();
    const txs = data.transactions || [];
    let csv = "\uFEFFNgày,Loại,Danh mục,Tiêu đề,Số tiền (VNĐ),Người ghi,Ghi chú\n";

    txs.forEach(t => {
      const typeStr = t.type === 'income' ? 'Thu' : 'Chi';
      csv += `"${t.date}","${typeStr}","${t.category}","${t.title}","${t.amount}","${t.createdBy || ''}","${t.note || ''}"\n`;
    });

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `smash_pro_so_quy_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    App.showToast("Đã xuất file báo cáo thu chi CSV thành công!", "success");
  }
};
