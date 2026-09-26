// Cashbook & Financial Transactions Module with Charts

const CashbookModule = {
  chartInstance: null,

  renderCashbook() {
    const data = AppStorage.loadData();
    const txs = data.transactions || [];
    
    // Sort transactions latest first
    const sortedTxs = [...txs].sort((a, b) => new Date(b.date) - new Date(a.date));

    // Calculate totals
    let totalIncome = 0;
    let totalExpense = 0;

    sortedTxs.forEach(t => {
      if (t.type === 'income') totalIncome += Number(t.amount);
      if (t.type === 'expense') totalExpense += Number(t.amount);
    });

    const currentBalance = totalIncome - totalExpense;

    // Update stat cards
    const balEl = document.getElementById('cashbook-balance');
    const incEl = document.getElementById('cashbook-income');
    const expEl = document.getElementById('cashbook-expense');

    if (balEl) balEl.innerText = `${currentBalance.toLocaleString('vi-VN')} đ`;
    if (incEl) incEl.innerText = `+${totalIncome.toLocaleString('vi-VN')} đ`;
    if (expEl) expEl.innerText = `-${totalExpense.toLocaleString('vi-VN')} đ`;

    // Render list
    const listContainer = document.getElementById('transaction-list-container');
    if (listContainer) {
      if (sortedTxs.length === 0) {
        listContainer.innerHTML = `<div class="text-center text-muted" style="padding: 2rem;">Chưa có giao dịch thu chi nào.</div>`;
      } else {
        listContainer.innerHTML = sortedTxs.map(t => {
          const isIncome = t.type === 'income';
          return `
            <div class="transaction-item ${isIncome ? 'income' : 'expense'}">
              <div class="flex items-center gap-3">
                <div class="transaction-type-icon">
                  <i class="fas ${isIncome ? 'fa-arrow-down' : 'fa-arrow-up'}"></i>
                </div>
                <div>
                  <div class="font-bold" style="font-size: 0.95rem;">${t.title}</div>
                  <div class="text-secondary" style="font-size: 0.78rem;">
                    <span><i class="far fa-calendar-alt"></i> ${t.date}</span> • 
                    <span class="badge badge-neutral" style="font-size: 0.7rem;">${t.category}</span> • 
                    <span>Ghi nhận bởi: ${t.createdBy || 'Admin'}</span>
                  </div>
                </div>
              </div>
              <div class="text-right">
                <div class="transaction-amount ${isIncome ? 'income' : 'expense'}">
                  ${isIncome ? '+' : '-'}${Number(t.amount).toLocaleString('vi-VN')} đ
                </div>
                ${t.note ? `<div class="text-muted" style="font-size: 0.75rem;">"${t.note}"</div>` : ''}
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
          <label class="form-label">Loại thu chi *</label>
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
          <label class="form-label">Tiêu đề giao dịch *</label>
          <input type="text" id="tx-title" class="form-control" placeholder="VD: Mua 4 ống cầu Hải Yến, Tiền thuê sân..." required>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
          <div class="form-group">
            <label class="form-label">Số tiền (VNĐ) *</label>
            <input type="number" id="tx-amount" class="form-control" placeholder="300000" step="5000" required>
          </div>
          <div class="form-group">
            <label class="form-label">Danh mục</label>
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
          <label class="form-label">Ngày giao dịch *</label>
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
    e.preventDefault();
    if (!AppStorage.isAdmin()) {
      App.showToast("Chỉ Ban quản trị/Thủ quỹ mới có quyền ghi chép thu chi vào sổ quỹ!", "warning");
      App.showAuthModal('login');
      return;
    }

    const data = AppStorage.loadData();
    const type = document.querySelector('input[name="tx-type"]:checked').value;
    const title = document.getElementById('tx-title').value.trim();
    const amount = Number(document.getElementById('tx-amount').value);
    const category = document.getElementById('tx-category').value;
    const date = document.getElementById('tx-date').value;
    const note = document.getElementById('tx-note').value.trim();
    const currentUser = data.currentUser || AppStorage.getCurrentUser();
    const creatorName = (currentUser && currentUser.name) || 'Ban quản trị CLB';

    if (!data.transactions) data.transactions = [];

    const newTx = {
      id: `tx_${Date.now()}`,
      date,
      type,
      category,
      title,
      amount,
      createdBy: creatorName,
      note
    };

    data.transactions.unshift(newTx);
    AppStorage.saveData(data);
    App.closeModal();
    App.showToast("Đã lưu khoản thu chi vào sổ quỹ thành công!", "success");
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

