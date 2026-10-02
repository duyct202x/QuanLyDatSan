// Bill Splitter Module for Post-Match Expenses & VietQR Links
// Tính tiền theo danh sách người tham gia (cố định / vãng lai / khách đi kèm),
// lưu cấu hình chia tiền vào buổi đánh (session.billSplit) và ghi vào sổ thu chi.

const BillSplitterModule = {
  currentSessionId: null,
  lastCalc: null,

  init() {
    this.populateSessionSelect();
    if (this.currentSessionId) {
      const select = document.getElementById('splitter-session-select');
      if (select) select.value = this.currentSessionId;
    }
    this.calculateBill();
  },

  esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },

  fmt(n) {
    return Number(n || 0).toLocaleString('vi-VN');
  },

  populateSessionSelect() {
    const select = document.getElementById('splitter-session-select');
    if (!select) return;

    const data = AppStorage.loadData();
    const sessions = [...(data.sessions || [])].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

    select.innerHTML = `
      <option value="">-- Chọn buổi đánh để tính tiền --</option>
      ${sessions.map(s => {
        const typeBadge = s.sessionType === 'guest' ? '[⚡ Vãng lai]' : '[🏸 Cố định]';
        const pollBadge = s.voteMode === 'multi_option' ? '[🗳️ Khảo sát]' : '';
        const savedBadge = s.billSplit && s.billSplit.savedAt ? '[✅ Đã chia]' : '';
        return `<option value="${s.id}">${typeBadge} ${pollBadge} ${savedBadge} ${this.esc(s.title)} (${s.date} - ${this.esc(s.courtNumbers || 'Nhiều sân')})</option>`;
      }).join('')}
    `;
  },

  setInput(id, value) {
    const el = document.getElementById(id);
    if (el) el.value = value;
  },

  num(id, fallback = 0) {
    const el = document.getElementById(id);
    if (!el || el.value === '') return fallback;
    const n = Number(el.value);
    return isNaN(n) || n < 0 ? fallback : n;
  },

  loadSessionForBill(sessionId) {
    this.currentSessionId = sessionId || null;
    const select = document.getElementById('splitter-session-select');
    if (select) select.value = sessionId || '';

    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    const saved = session && session.billSplit;

    if (saved) {
      this.setInput('bill-split-mode', saved.mode || 'guests_only');
      this.setInput('bill-court-fee', saved.courtFee ?? 0);
      this.setInput('bill-shuttle-tubes', saved.shuttleTubes ?? 0);
      this.setInput('bill-shuttle-price', saved.shuttlePrice ?? 230000);
      this.setInput('bill-drink-fee', saved.drinkFee ?? 0);
      this.setInput('bill-other-fee', saved.otherFee ?? 0);
      this.setInput('bill-guest-fee', saved.guestFee ?? (Number(data.clubInfo?.guestFee) || 0));
      this.setInput('bill-player-count', saved.extraGuests ?? 0);
    } else {
      this.setInput('bill-split-mode', session && session.sessionType === 'guest' ? 'all' : 'guests_only');
      this.setInput('bill-court-fee', session ? (session.courtPrice || 0) : 0);
      this.setInput('bill-guest-fee', Number(data.clubInfo?.guestFee) || 0);
      this.setInput('bill-player-count', 0);
    }

    this.calculateBill();
  },

  // Danh sách người tham gia từ phiếu bình chọn của buổi đánh
  getParticipants(session, data) {
    if (!session) return [];
    const members = data.members || [];
    const users = data.users || [];
    let votes = session.votes || [];

    if (session.voteMode === 'multi_option') {
      votes = votes.filter(v => !v.notGoing && (session.selectedOptionId
        ? (v.selectedOptions || []).includes(session.selectedOptionId)
        : (v.selectedOptions || []).length > 0));
    } else {
      votes = votes.filter(v => v.status === 'going');
    }

    const list = [];
    votes.forEach(v => {
      const member = members.find(m => m.id === v.memberId || (m.username && m.username === v.memberId)) ||
                     users.find(u => u.id === v.memberId || u.memberId === v.memberId);
      const name = (member && member.name) || 'Thành viên';
      const isFixed = !!member && (member.type || 'fixed') === 'fixed';
      list.push({ key: `m:${v.memberId}`, name, kind: isFixed ? 'fixed' : 'guest' });
      const guests = Number(v.guests) || 0;
      for (let i = 1; i <= guests; i++) {
        list.push({ key: `g:${v.memberId}:${i}`, name: `Khách ${i} của ${name}`, kind: 'guest' });
      }
    });
    return list;
  },

  computeBill() {
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === this.currentSessionId) || null;
    const saved = (session && session.billSplit) || {};

    const courtFee = this.num('bill-court-fee');
    const shuttleTubes = this.num('bill-shuttle-tubes');
    const shuttlePrice = this.num('bill-shuttle-price', 230000);
    const drinkFee = this.num('bill-drink-fee');
    const otherFee = this.num('bill-other-fee');
    const guestFee = this.num('bill-guest-fee', Number(data.clubInfo?.guestFee) || 0);
    const extraGuests = Math.floor(this.num('bill-player-count'));
    const mode = document.getElementById('bill-split-mode')?.value || 'guests_only'; // all | guests_only

    const excluded = new Set(saved.excluded || []);
    const payments = saved.payments || {};

    const people = this.getParticipants(session, data);
    for (let i = 1; i <= extraGuests; i++) {
      people.push({ key: `x:${i}`, name: `Khách thêm ${i}`, kind: 'guest' });
    }
    people.forEach(p => { p.attending = !excluded.has(p.key); });

    const attending = people.filter(p => p.attending);
    const totalShuttle = shuttleTubes * shuttlePrice;
    const totalCost = courtFee + totalShuttle + drinkFee + otherFee;
    const fixedCount = attending.filter(p => p.kind === 'fixed').length;
    const guestCount = attending.length - fixedCount;
    const perPersonAll = attending.length > 0 ? Math.ceil(totalCost / attending.length / 1000) * 1000 : 0;

    people.forEach(p => {
      if (!p.attending) p.amount = 0;
      else if (mode === 'all') p.amount = perPersonAll;
      else p.amount = p.kind === 'fixed' ? 0 : guestFee;
      p.paid = p.amount > 0 && !!(payments[p.key] && payments[p.key].paid);
    });

    const totalDue = people.reduce((acc, p) => acc + p.amount, 0);
    const totalPaid = people.filter(p => p.paid).reduce((acc, p) => acc + p.amount, 0);
    // Dương: quỹ CLB phải bù; âm: quỹ dư thêm
    const fundCovers = totalCost - totalDue;

    return {
      data, session, mode,
      courtFee, shuttleTubes, shuttlePrice, totalShuttle, drinkFee, otherFee, guestFee, extraGuests,
      totalCost, people, attendingCount: attending.length, fixedCount, guestCount, perPersonAll,
      totalDue, totalPaid, fundCovers
    };
  },

  calculateBill() {
    const resultBox = document.getElementById('bill-calculation-result');
    if (!resultBox) return;

    const c = this.computeBill();
    this.lastCalc = c;
    const { data, session } = c;
    const bank = (data.clubInfo && data.clubInfo.bank) || {};
    const bankName = bank.bankName || bank.bankId || '';
    const kindLabel = { fixed: '🏸 Cố định', guest: '⚡ Vãng lai / Khách' };
    const recorded = !!(session && session.billSplit && session.billSplit.savedAt);

    const rows = c.people.map(p => `
      <tr style="${p.attending ? '' : 'opacity: 0.45;'}">
        <td style="padding: 0.4rem;">
          <input type="checkbox" ${p.attending ? 'checked' : ''} ${session ? '' : 'disabled'}
            onchange="BillSplitterModule.toggleAttendance('${this.esc(p.key)}', this.checked)" title="Có tham gia">
        </td>
        <td style="padding: 0.4rem;">${this.esc(p.name)}</td>
        <td style="padding: 0.4rem; font-size: 0.8rem;">${kindLabel[p.kind]}</td>
        <td style="padding: 0.4rem; text-align: right;" class="font-mono">${p.amount > 0 ? this.fmt(p.amount) + ' đ' : (p.attending && c.mode !== 'all' && p.kind === 'fixed' ? 'Trừ quỹ' : '-')}</td>
        <td style="padding: 0.4rem; text-align: center;">
          ${p.amount > 0 ? `
            <button type="button" class="btn btn-xs ${p.paid ? 'btn-primary' : 'btn-secondary'}" ${session ? '' : 'disabled'}
              onclick="BillSplitterModule.togglePaid('${this.esc(p.key)}')">
              ${p.paid ? '<i class="fas fa-check"></i> Đã trả' : 'Chưa trả'}
            </button>` : ''}
        </td>
      </tr>
    `).join('');

    const payLines = c.people.filter(p => p.amount > 0)
      .map(p => `- ${p.name}: ${this.fmt(p.amount)}đ${p.paid ? ' ✅' : ''}`).join('\n');

    const shareText = `🏸 [${data.clubInfo?.shortName || 'CLB'}] TỔNG KẾT TIỀN SÂN ${session ? `(${session.title} - ${session.date})` : 'HÔM NAY'}:
- Hình thức: ${c.mode === 'all' ? 'Chia đều cho tất cả người tham gia' : 'Cố định trừ quỹ - Thu vãng lai'}
- Tiền sân: ${this.fmt(c.courtFee)}đ
- Tiền cầu (${c.shuttleTubes} ống): ${this.fmt(c.totalShuttle)}đ
- Nước uống / Khác: ${this.fmt(c.drinkFee + c.otherFee)}đ
👉 Tổng cộng: ${this.fmt(c.totalCost)}đ (${c.attendingCount} người: ${c.fixedCount} cố định, ${c.guestCount} vãng lai/khách)

💰 CẦN ĐÓNG:
${payLines || '- Không ai cần đóng thêm (trừ quỹ toàn bộ)'}
${c.mode !== 'all' ? `- Thành viên cố định: Đã trừ vào quỹ tháng.\n` : ''}
🏦 STK: ${bank.accountNo || ''} (${bankName})
👤 Chủ TK: ${bank.accountName || ''}
📝 Cú pháp: TIEN SAN [Tên bạn]`;

    resultBox.innerHTML = `
      <div class="split-result-box">
        <div class="flex justify-between items-center" style="border-bottom: 1px solid var(--border-color); padding-bottom: 0.75rem; margin-bottom: 1rem; flex-wrap: wrap; gap: 0.5rem;">
          <div>
            <div class="text-secondary" style="font-size: 0.85rem;">Tổng chi phí buổi đánh</div>
            <div class="split-amount-highlight">${this.fmt(c.totalCost)} đ</div>
          </div>
          <div class="text-right">
            <div class="text-secondary" style="font-size: 0.85rem;">Người tham gia:</div>
            <div class="font-bold font-mono" style="font-size: 1.3rem;">${c.attendingCount} người</div>
            <div class="text-muted" style="font-size: 0.75rem;">${c.fixedCount} cố định • ${c.guestCount} vãng lai/khách</div>
          </div>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 0.75rem; margin-bottom: 1rem;">
          <div class="card" style="padding: 0.85rem; background: var(--bg-card);">
            <div class="text-secondary" style="font-size: 0.8rem;">Mỗi người ${c.mode === 'all' ? '(chia đều)' : 'vãng lai'}</div>
            <div class="font-bold text-warning" style="font-size: 1.1rem;">${this.fmt(c.mode === 'all' ? c.perPersonAll : c.guestFee)} đ</div>
          </div>
          <div class="card" style="padding: 0.85rem; background: var(--bg-card);">
            <div class="text-secondary" style="font-size: 0.8rem;">Tổng phải thu</div>
            <div class="font-bold text-primary" style="font-size: 1.1rem;">${this.fmt(c.totalDue)} đ</div>
            <div class="text-muted" style="font-size: 0.75rem;">Đã thu: ${this.fmt(c.totalPaid)} đ</div>
          </div>
          <div class="card" style="padding: 0.85rem; background: var(--bg-card);">
            <div class="text-secondary" style="font-size: 0.8rem;">${c.fundCovers >= 0 ? 'Quỹ CLB bù' : 'Quỹ CLB dư thêm'}</div>
            <div class="font-bold ${c.fundCovers >= 0 ? 'text-danger' : 'text-primary'}" style="font-size: 1.1rem;">${this.fmt(Math.abs(c.fundCovers))} đ</div>
          </div>
        </div>

        <div style="background: var(--bg-card); padding: 0.75rem; border-radius: var(--radius-md); border: 1px solid var(--border-color); margin-bottom: 1rem; overflow-x: auto;">
          <strong style="font-size: 0.9rem;"><i class="fas fa-users text-primary"></i> Danh sách từng người</strong>
          ${c.people.length === 0 ? `
            <div class="text-muted" style="font-size: 0.85rem; margin-top: 0.5rem;">
              ${session ? 'Buổi này chưa có ai đăng ký tham gia. Nhập số "Khách thêm ngoài danh sách vote" để tính.' : 'Chọn buổi đánh để lấy danh sách người tham gia.'}
            </div>
          ` : `
            <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem; margin-top: 0.5rem;">
              <thead>
                <tr class="text-secondary" style="text-align: left; border-bottom: 1px solid var(--border-color);">
                  <th style="padding: 0.4rem;">Đi</th><th style="padding: 0.4rem;">Tên</th><th style="padding: 0.4rem;">Loại</th>
                  <th style="padding: 0.4rem; text-align: right;">Số tiền</th><th style="padding: 0.4rem; text-align: center;">Trạng thái</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          `}
          ${!session ? '' : `
            <div class="text-muted" style="font-size: 0.75rem; margin-top: 0.5rem;">
              Bấm "Chưa trả" → "Đã trả" sẽ tự ghi một khoản thu vào sổ quỹ; bấm lại để hủy khoản thu đó.
            </div>
          `}
        </div>

        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1rem;">
          <button type="button" class="btn btn-primary btn-sm" onclick="BillSplitterModule.saveBill()" ${session ? '' : 'disabled title="Chọn buổi đánh trước"'}>
            <i class="fas fa-save"></i> ${recorded ? 'Cập nhật & ghi sổ quỹ' : 'Lưu & ghi sổ quỹ'}
          </button>
          ${recorded ? `<span class="badge badge-paid" style="align-self: center;"><i class="fas fa-check"></i> Đã ghi sổ lúc ${new Date(session.billSplit.savedAt).toLocaleString('vi-VN')}</span>` : ''}
        </div>

        <div style="background: var(--bg-card); padding: 1rem; border-radius: var(--radius-md); border: 1px solid var(--border-color); font-size: 0.85rem;">
          <div class="flex justify-between items-center" style="margin-bottom: 0.5rem;">
            <strong><i class="fas fa-file-invoice-dollar text-primary"></i> Nội dung tổng kết gửi nhóm Zalo:</strong>
            <button class="btn btn-secondary btn-sm" onclick="BillSplitterModule.copyBillText()">
              <i class="far fa-copy"></i> Sao chép
            </button>
          </div>
          <pre id="bill-share-text" style="white-space: pre-wrap; font-family: inherit; color: var(--text-secondary); line-height: 1.4;">${this.esc(shareText)}</pre>
        </div>
      </div>
    `;
  },

  // Lấy (và tạo nếu chưa có) cấu hình chia tiền của buổi đánh
  ensureBillSplit(session) {
    if (!session.billSplit) session.billSplit = { excluded: [], payments: {} };
    if (!Array.isArray(session.billSplit.excluded)) session.billSplit.excluded = [];
    if (!session.billSplit.payments) session.billSplit.payments = {};
    return session.billSplit;
  },

  incomeTxId(sessionId, key) {
    return `tx_bill_inc_${sessionId}_${key.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  },

  toggleAttendance(key, attending) {
    if (!AppStorage.isAdmin() || !this.currentSessionId) return;
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === this.currentSessionId);
    if (!session) return;

    const bill = this.ensureBillSplit(session);
    bill.excluded = bill.excluded.filter(k => k !== key);
    if (!attending) {
      bill.excluded.push(key);
      // Người không đi thì hủy khoản thu đã ghi (nếu có)
      if (bill.payments[key] && bill.payments[key].paid) {
        delete bill.payments[key];
        const txId = this.incomeTxId(session.id, key);
        data.transactions = (data.transactions || []).filter(t => t.id !== txId);
      }
    }
    AppStorage.saveData(data);
    this.calculateBill();
  },

  async togglePaid(key) {
    if (!AppStorage.isAdmin()) {
      App.showToast("Chỉ Ban quản trị/Thủ quỹ mới có quyền xác nhận thu tiền!", "warning");
      return;
    }
    const c = this.computeBill();
    const person = c.people.find(p => p.key === key);
    if (!c.session || !person || person.amount <= 0) return;

    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === c.session.id);
    if (!session) return;
    const bill = this.ensureBillSplit(session);
    const txId = this.incomeTxId(session.id, key);
    if (!data.transactions) data.transactions = [];

    if (person.paid) {
      delete bill.payments[key];
      data.transactions = data.transactions.filter(t => t.id !== txId);
    } else {
      const currentUser = data.currentUser || AppStorage.getCurrentUser();
      bill.payments[key] = { paid: true, amount: person.amount, paidAt: new Date().toISOString() };
      data.transactions = data.transactions.filter(t => t.id !== txId);
      data.transactions.unshift({
        id: txId,
        date: new Date().toISOString().slice(0, 10),
        type: 'income',
        category: 'Khách vãng lai',
        title: `Thu tiền sân - ${person.name} (${session.title} ${session.date})`,
        amount: person.amount,
        createdBy: (currentUser && currentUser.name) || 'Ban quản trị CLB',
        createdAt: new Date().toISOString(),
        note: 'Tạo tự động từ Chia tiền sân',
        billSessionId: session.id
      });
    }

    const result = await AppStorage.saveDataWithCloudAck(data);
    if (!result.success) {
      App.showToast("⚠️ Đã lưu trên thiết bị, sẽ tự đồng bộ lên Cloud khi có kết nối.", "warning");
    }
    this.calculateBill();
  },

  // Lưu cấu hình chia tiền vào buổi đánh + ghi khoản chi vào sổ quỹ
  async saveBill() {
    if (!AppStorage.isAdmin()) {
      App.showToast("Chỉ Ban quản trị/Thủ quỹ mới có quyền ghi sổ quỹ!", "warning");
      return;
    }
    const c = this.computeBill();
    if (!c.session) {
      App.showToast("Vui lòng chọn buổi đánh trước khi lưu!", "warning");
      return;
    }

    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === c.session.id);
    if (!session) return;
    const bill = this.ensureBillSplit(session);
    const currentUser = data.currentUser || AppStorage.getCurrentUser();
    const creator = (currentUser && currentUser.name) || 'Ban quản trị CLB';
    const now = new Date().toISOString();

    Object.assign(bill, {
      mode: c.mode,
      courtFee: c.courtFee,
      shuttleTubes: c.shuttleTubes,
      shuttlePrice: c.shuttlePrice,
      drinkFee: c.drinkFee,
      otherFee: c.otherFee,
      guestFee: c.guestFee,
      extraGuests: c.extraGuests,
      totalCost: c.totalCost,
      totalDue: c.totalDue,
      savedAt: Date.now(),
      savedBy: creator
    });

    if (!data.transactions) data.transactions = [];
    const expTxId = `tx_bill_exp_${session.id}`;
    data.transactions = data.transactions.filter(t => t.id !== expTxId);
    if (c.totalCost > 0) {
      data.transactions.unshift({
        id: expTxId,
        date: session.date || now.slice(0, 10),
        type: 'expense',
        category: 'Tiền thuê sân',
        title: `Chi phí buổi ${session.title} (${session.date})`,
        amount: c.totalCost,
        createdBy: creator,
        createdAt: now,
        note: `Sân ${this.fmt(c.courtFee)}đ • Cầu ${c.shuttleTubes} ống ${this.fmt(c.totalShuttle)}đ • Nước ${this.fmt(c.drinkFee)}đ • Khác ${this.fmt(c.otherFee)}đ`,
        billSessionId: session.id
      });
    }

    // Đồng bộ số tiền các khoản đã thu theo mức phí hiện tại; bỏ khoản thu của người không còn phải trả
    c.people.forEach(p => {
      const txId = this.incomeTxId(session.id, p.key);
      if (!bill.payments[p.key] || !bill.payments[p.key].paid) return;
      if (p.amount <= 0) {
        delete bill.payments[p.key];
        data.transactions = data.transactions.filter(t => t.id !== txId);
        return;
      }
      bill.payments[p.key].amount = p.amount;
      const tx = data.transactions.find(t => t.id === txId);
      if (tx) tx.amount = p.amount;
    });

    const result = await AppStorage.saveDataWithCloudAck(data);
    if (result.success) {
      App.showToast(`✅ Đã lưu chia tiền và ghi khoản chi ${this.fmt(c.totalCost)}đ vào sổ quỹ!`, "success");
    } else {
      App.showToast("⚠️ Đã lưu trên thiết bị, sẽ tự đồng bộ lên Cloud khi có kết nối.", "warning");
    }
    this.populateSessionSelect();
    const select = document.getElementById('splitter-session-select');
    if (select) select.value = session.id;
    this.calculateBill();
    if (window.App && typeof App.refreshDashboardStats === 'function') App.refreshDashboardStats();
  },

  copyBillText() {
    const textEl = document.getElementById('bill-share-text');
    if (!textEl) return;
    navigator.clipboard.writeText(textEl.innerText).then(() => {
      App.showToast("Đã sao chép nội dung chia tiền sân vào Clipboard!", "success");
    });
  }
};
