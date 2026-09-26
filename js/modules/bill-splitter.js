// Bill Splitter Module for Post-Match Expenses & VietQR Links

const BillSplitterModule = {
  currentSessionId: null,

  init() {
    this.populateSessionSelect();
  },

  populateSessionSelect() {
    const select = document.getElementById('splitter-session-select');
    if (!select) return;

    const data = AppStorage.loadData();
    const sessions = data.sessions || [];

    select.innerHTML = `
      <option value="">-- Chọn buổi đánh để tính tiền --</option>
      ${sessions.map(s => {
        const typeBadge = s.sessionType === 'guest' ? '[⚡ Vãng lai]' : '[🏸 Cố định]';
        const pollBadge = s.voteMode === 'multi_option' ? '[🗳️ Khảo sát]' : '';
        return `<option value="${s.id}">${typeBadge} ${pollBadge} ${s.title} (${s.date} - ${s.courtNumbers || 'Nhiều sân'})</option>`;
      }).join('')}
    `;
  },

  loadSessionForBill(sessionId) {
    const data = AppStorage.loadData();
    const session = (data.sessions || []).find(s => s.id === sessionId);
    if (!session) return;

    this.currentSessionId = sessionId;
    const select = document.getElementById('splitter-session-select');
    if (select) select.value = sessionId;

    // Prefill court fee
    const courtInput = document.getElementById('bill-court-fee');
    if (courtInput) courtInput.value = session.courtPrice || 360000;

    // Count attendees
    let totalCount = 0;
    if (session.voteMode === 'multi_option') {
      const pollStats = ScheduleModule.calculatePollStats(session);
      totalCount = pollStats.totalVoters;
    } else {
      const going = (session.votes || []).filter(v => v.status === 'going');
      totalCount = going.reduce((acc, v) => acc + 1 + (v.guests || 0), 0);
    }

    const countInput = document.getElementById('bill-player-count');
    if (countInput) countInput.value = totalCount > 0 ? totalCount : 8;

    // Set split mode default based on sessionType
    const modeSelect = document.getElementById('bill-split-mode');
    if (modeSelect) {
      if (session.sessionType === 'guest') {
        modeSelect.value = 'all'; // Default to split equally for guest / ad-hoc sessions
      } else {
        modeSelect.value = 'guests_only'; // Default to guests only for regular fixed sessions
      }
    }

    this.calculateBill();
  },

  calculateBill() {
    const courtFee = Number(document.getElementById('bill-court-fee')?.value || 0);
    const shuttleCount = Number(document.getElementById('bill-shuttle-tubes')?.value || 0);
    const shuttlePrice = Number(document.getElementById('bill-shuttle-price')?.value || 230000);
    const drinkFee = Number(document.getElementById('bill-drink-fee')?.value || 0);
    const otherFee = Number(document.getElementById('bill-other-fee')?.value || 0);
    const playerCount = Math.max(1, Number(document.getElementById('bill-player-count')?.value || 1));
    const mode = document.getElementById('bill-split-mode')?.value || 'guests_only'; // all | guests_only

    const totalShuttle = shuttleCount * shuttlePrice;
    const totalCost = courtFee + totalShuttle + drinkFee + otherFee;

    const perPersonAll = Math.ceil(totalCost / playerCount / 1000) * 1000; // round up 1k

    const data = AppStorage.loadData();
    const bank = data.clubInfo.bank;
    const guestFeeFixed = data.clubInfo.guestFee || 60000;
    const session = (data.sessions || []).find(s => s.id === this.currentSessionId);
    const isGuestSession = session ? session.sessionType === 'guest' : (mode === 'all');

    const resultBox = document.getElementById('bill-calculation-result');
    if (!resultBox) return;

    resultBox.innerHTML = `
      <div class="split-result-box">
        <div class="flex justify-between items-center" style="border-bottom: 1px solid var(--border-color); padding-bottom: 0.75rem; margin-bottom: 1rem;">
          <div>
            <div class="text-secondary" style="font-size: 0.85rem;">Tổng chi phí buổi đánh</div>
            <div class="split-amount-highlight">${totalCost.toLocaleString('vi-VN')} đ</div>
          </div>
          <div class="text-right">
            <div class="text-secondary" style="font-size: 0.85rem;">Số người tham gia:</div>
            <div class="font-bold font-mono" style="font-size: 1.3rem;">${playerCount} người</div>
          </div>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 1rem;">
          <div class="card" style="padding: 1rem; background: var(--bg-card);">
            <div class="text-secondary" style="font-size: 0.8rem;">Thành viên cố định (đã đóng quỹ tháng):</div>
            <div class="font-bold text-primary" style="font-size: 1.1rem; margin-top: 0.2rem;">
              ${isGuestSession ? `${perPersonAll.toLocaleString('vi-VN')} VNĐ` : '0 VNĐ'}
            </div>
            <div class="text-muted" style="font-size: 0.75rem;">
              ${isGuestSession ? '(Lịch vãng lai chia đều cho tất cả)' : '(Đã trích từ tiền quỹ tháng)'}
            </div>
          </div>

          <div class="card" style="padding: 1rem; background: var(--bg-card);">
            <div class="text-secondary" style="font-size: 0.8rem;">Khách vãng lai / Người tham gia:</div>
            <div class="font-bold text-warning" style="font-size: 1.1rem; margin-top: 0.2rem;">
              ${mode === 'all' || isGuestSession ? perPersonAll.toLocaleString('vi-VN') : guestFeeFixed.toLocaleString('vi-VN')} VNĐ / người
            </div>
            <div class="text-muted" style="font-size: 0.75rem;">${mode === 'all' || isGuestSession ? '(Chia đều toàn bộ)' : '(Theo mức phí vãng lai quy định)'}</div>
          </div>
        </div>

        <!-- Copyable Share Summary for Chat Groups -->
        <div style="background: var(--bg-card); padding: 1rem; border-radius: var(--radius-md); border: 1px solid var(--border-color); font-size: 0.85rem;">
          <div class="flex justify-between items-center" style="margin-bottom: 0.5rem;">
            <strong><i class="fas fa-file-invoice-dollar text-primary"></i> Nội dung tổng kết gửi nhóm Zalo:</strong>
            <button class="btn btn-secondary btn-sm" onclick="BillSplitterModule.copyBillText()">
              <i class="far fa-copy"></i> Sao chép
            </button>
          </div>
          <pre id="bill-share-text" style="white-space: pre-wrap; font-family: inherit; color: var(--text-secondary); line-height: 1.4;">🏸 [${data.clubInfo.shortName}] TỔNG KẾT TIỀN SÂN ${session ? `(${session.title})` : 'HÔM NAY'}:
- Hình thức: ${isGuestSession ? '⚡ Vãng lai (chia đều theo buổi)' : '🏸 Cố định (trích quỹ tháng)'}
- Tiền sân: ${courtFee.toLocaleString('vi-VN')}đ
- Tiền cầu (${shuttleCount} ống): ${totalShuttle.toLocaleString('vi-VN')}đ
- Nước uống / Tiện ích: ${(drinkFee + otherFee).toLocaleString('vi-VN')}đ
👉 Tổng cộng: ${totalCost.toLocaleString('vi-VN')} VNĐ (${playerCount} người)

💰 CÁCH THỨC ĐÓNG:
${isGuestSession ? `- Tất cả người tham gia: ${perPersonAll.toLocaleString('vi-VN')}đ / người (chia đều ${playerCount} người)` : `- Thành viên cố định: Đã trừ vào quỹ tháng.\n- Khách vãng lai: ${guestFeeFixed.toLocaleString('vi-VN')}đ / người`}

🏦 STK: ${bank.accountNo} (${bank.bankName})
👤 Chủ TK: ${bank.accountName}
📝 Cú pháp: TIEN SAN [Tên bạn]</pre>
        </div>
      </div>
    `;
  },

  copyBillText() {
    const textEl = document.getElementById('bill-share-text');
    if (!textEl) return;
    navigator.clipboard.writeText(textEl.innerText).then(() => {
      App.showToast("Đã sao chép nội dung chia tiền sân vào Clipboard!", "success");
    });
  }
};

