// PaymentVerify - Đọc ảnh biên lai chuyển khoản (OCR) và đối chiếu với khoản phải đóng.
// - OCR chạy NGAY TRÊN TRÌNH DUYỆT bằng Tesseract.js (ảnh không gửi cho dịch vụ nào khác). Thư viện (vài MB) chỉ tải khi cần, lần sau dùng bộ nhớ đệm.
// - Kết quả đối chiếu CHỈ TIN CẬY khi chạy trên máy Ban quản trị (thành viên có thể sửa mã giao diện của chính mình), nên:
//     + Admin/Thủ quỹ: tự động đối chiếu các phiếu "Chờ duyệt" có ảnh và lưu kết quả vào due.verify (thành viên không xem được).
//     + Thành viên: chỉ có nút "Kiểm tra ảnh" để tự xem ảnh đã đủ rõ chưa (không ảnh hưởng việc duyệt).
// - "Khớp" chỉ nghĩa là ảnh nhất quán (đúng tiền + đúng mã + đúng tài khoản nhận); KHÔNG chứng minh tiền đã vào tài khoản.
const PaymentVerify = {
  TESSERACT_URL: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
  // Dữ liệu tiếng Anh bản nhẹ (~3 MB; bản mặc định của thư viện nặng ~11 MB). Tổng tải lần đầu ~4,5 MB, sau đó dùng bộ nhớ đệm.
  LANG_PATH: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int',
  MIN_CONFIDENCE: 35,
  _lib: null,
  _worker: null,
  _busy: false,
  _attempted: new Set(),
  status: '', // Dòng trạng thái hiển thị trên thanh đối chiếu

  // ---------------- OCR ----------------
  loadLib() {
    if (window.Tesseract) return Promise.resolve();
    if (this._lib) return this._lib;
    this._lib = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = this.TESSERACT_URL;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { this._lib = null; reject(new Error('Không tải được thư viện đọc ảnh (kiểm tra kết nối mạng)')); };
      document.head.appendChild(s);
    });
    return this._lib;
  },

  async getWorker() {
    if (this._worker) return this._worker;
    await this.loadLib();
    this._worker = await Tesseract.createWorker('eng', 1, {
      langPath: this.LANG_PATH,
      logger: (m) => {
        if (m && m.status && typeof m.progress === 'number') this._setStatus(`Đang đọc ảnh… ${m.status} ${Math.round(m.progress * 100)}%`);
      }
    });
    return this._worker;
  },

  // Chữ trắng trên nền tối (giao diện tối của app ngân hàng) -> đảo màu; ảnh nhỏ -> phóng to; chuyển xám
  preprocess(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(2, Math.max(1, 1400 / img.width));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);
        const im = ctx.getImageData(0, 0, w, h), d = im.data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) {
          const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
          d[i] = d[i + 1] = d[i + 2] = g;
          sum += g;
        }
        if (sum / (d.length / 4) < 110) for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = 255 - d[i]; }
        ctx.putImageData(im, 0, 0);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('Không mở được ảnh'));
      img.src = dataUrl;
    });
  },

  // psm: '3' = tự phân tích bố cục (mặc định); '11' = chữ rời rạc (bắt được dòng chữ lớn như số tiền mà chế độ mặc định hay bỏ sót)
  async _recognize(prepared, psm) {
    const worker = await this.getWorker();
    await worker.setParameters({ tessedit_pageseg_mode: psm });
    const { data } = await worker.recognize(prepared);
    return { text: data.text || '', confidence: Number(data.confidence) || 0 };
  },

  async ocr(dataUrl) {
    return this._recognize(await this.preprocess(dataUrl), '3');
  },

  // ---------------- Đối chiếu ----------------
  expectedFor(due, data) {
    data = data || AppStorage.loadData();
    const members = data.members || [];
    const member = members.find((m) => m.id === due.memberId) || { id: due.memberId };
    const [y, m] = String(due.month || AppStorage.currentMonth()).split('-').map(Number);
    return {
      amount: Number(due.amount) || FundModule.getClubFee(data),
      code: TransferCode.codeOf(member, members),
      bank: (data.clubInfo && data.clubInfo.bank) || null,
      monthStart: new Date(Date.UTC(y, (m || 1) - 1, 1)),
      now: new Date()
    };
  },

  // Đọc 2 lượt: lượt 1 theo bố cục tự động; nếu chưa "khớp" thì đọc thêm lượt chữ rời rạc rồi gộp chữ của cả hai
  async check(dataUrl, expected) {
    const prepared = await this.preprocess(dataUrl);
    const first = await this._recognize(prepared, '3');
    let text = first.text, confidence = first.confidence;
    let res = PaymentMatch.analyze(text, expected);
    if (res.state !== 'match') {
      const second = await this._recognize(prepared, '11');
      text = `${first.text}
${second.text}`;
      confidence = Math.max(first.confidence, second.confidence);
      res = PaymentMatch.analyze(text, expected);
    }
    res.confidence = Math.round(confidence);
    // OCR quá kém: đừng kết luận "không khớp" (có thể do ảnh mờ) -> yêu cầu xem ảnh
    if (res.state === 'mismatch' && confidence < this.MIN_CONFIDENCE) res.state = 'unreadable';
    return res;
  },

  // Khóa nhận diện ảnh (đổi ảnh -> phải đối chiếu lại): độ dài + băm các ký tự lấy mẫu
  imgKey(dataUrl) {
    if (AppStorage.isBillMarker(dataUrl)) return String(dataUrl).slice(AppStorage.BILL_MARK.length); // máy chủ đã tính sẵn cùng khóa
    const s = String(dataUrl || '');
    let h = 2166136261;
    for (let i = 0; i < s.length; i += 97) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return `${s.length}:${h.toString(36)}`;
  },

  _setStatus(text) {
    this.status = text;
    const el = document.getElementById('fund-verify-status');
    if (el) el.textContent = text;
  },

  isStale(due) {
    return !due.verify || due.verify.img !== this.imgKey(due.billImage);
  },

  // Phiếu cần đối chiếu: đang chờ duyệt, có ảnh, chưa có kết quả cho đúng ảnh này, chưa thử trong phiên
  targets(data) {
    return (data.monthlyContributions || []).filter((d) => d.status === 'pending' && d.billImage && this.isStale(d) && !this._attempted.has(`${d.id}|${this.imgKey(d.billImage)}`));
  },

  async verifyDue(dueId, { force = false } = {}) {
    if (!AppStorage.can('finance')) return null;
    let data = AppStorage.loadData();
    let due = (data.monthlyContributions || []).find((d) => d.id === dueId);
    if (!due || !due.billImage) return null;
    const key = `${due.id}|${this.imgKey(due.billImage)}`;
    if (!force && !this.isStale(due)) return due.verify;
    this._attempted.add(key);
    const expected = this.expectedFor(due, data);
    if (!expected.bank || !expected.bank.accountNo) {
      this._setStatus('CLB chưa cấu hình tài khoản ngân hàng nên chưa đối chiếu được.');
      return null;
    }
    let res;
    try {
      const image = await AppStorage.getBill(due);
      if (!image) throw new Error('không tải được ảnh biên lai từ máy chủ');
      res = await this.check(image, expected);
    } catch (e) {
      console.warn('[PaymentVerify] Lỗi đọc ảnh:', e);
      this._setStatus(`Không đọc được ảnh: ${e.message}`);
      return null;
    }
    // Lưu kết quả (nạp lại dữ liệu mới nhất vì có thể đã đổi trong lúc OCR)
    data = AppStorage.loadData();
    due = (data.monthlyContributions || []).find((d) => d.id === dueId);
    if (!due || due.billImage == null || this.imgKey(due.billImage) !== key.split('|')[1]) return res;
    const user = AppStorage.getCurrentUser();
    due.verify = {
      state: res.state, img: key.split('|')[1], at: new Date().toISOString().slice(0, 16).replace('T', ' '),
      by: user ? user.username : '', conf: res.confidence, txRef: res.txRef || '',
      reasons: res.reasons.slice(0, 6).map((r) => ({ ok: !!r.ok, text: String(r.text).slice(0, 160) }))
    };
    AppStorage.saveData(data);
    return due.verify;
  },

  // Chạy nền cho các phiếu chờ duyệt có ảnh (chỉ Admin/Thủ quỹ). Từng phiếu một để không treo máy.
  async autoRun() {
    if (this._busy || !AppStorage.can('finance')) return;
    const list = this.targets(AppStorage.loadData());
    if (!list.length) return;
    this._busy = true;
    try {
      for (let i = 0; i < list.length; i++) {
        this._setStatus(`Đang đối chiếu biên lai ${i + 1}/${list.length}…`);
        await this.verifyDue(list[i].id);
      }
      this._setStatus('');
    } finally {
      this._busy = false;
      if (window.FundModule) FundModule.renderFundDashboard();
    }
  },

  // ---------------- Hiển thị ----------------
  badge(due, dues) {
    if (!due || !due.billImage || due.status === 'unpaid') return '';
    if (this.isStale(due)) return `<span class="badge badge-neutral" style="font-size: 0.68rem;"><i class="fas fa-hourglass-half"></i> Chưa đối chiếu</span>`;
    const v = due.verify;
    const st = PaymentMatch.STATES[v.state] || PaymentMatch.STATES.review;
    const dup = this.duplicateOf(due, dues);
    return `<button type="button" class="badge ${st.cls}" style="font-size: 0.68rem; border: 0; cursor: pointer;" onclick="PaymentVerify.openDetail(${Safe.js(due.id)})" title="Xem chi tiết đối chiếu">
        <i class="fas ${st.icon}"></i> ${Safe.html(st.label)}</button>${dup ? ` <span class="badge badge-unpaid" style="font-size: 0.68rem;" title="Mã giao dịch trùng với phiếu khác"><i class="fas fa-clone"></i> Trùng mã GD</span>` : ''}`;
  },

  // Cùng 1 mã giao dịch xuất hiện ở phiếu khác (dùng lại ảnh/biên lai cho người khác hoặc tháng khác)
  duplicateOf(due, dues) {
    const ref = due && due.verify && due.verify.txRef;
    if (!ref) return null;
    return (dues || []).find((d) => d.id !== due.id && d.verify && d.verify.txRef === ref) || null;
  },

  openDetail(dueId) {
    const data = AppStorage.loadData();
    const due = (data.monthlyContributions || []).find((d) => d.id === dueId);
    if (!due || !due.verify) return;
    const member = (data.members || []).find((m) => m.id === due.memberId) || { name: 'Thành viên' };
    const v = due.verify, st = PaymentMatch.STATES[v.state] || PaymentMatch.STATES.review;
    const dup = this.duplicateOf(due, data.monthlyContributions);
    const dupMember = dup ? (data.members || []).find((m) => m.id === dup.memberId) : null;
    const body = `
      <div style="display: flex; flex-direction: column; gap: 0.75rem;">
        <div class="flex items-center gap-2" style="flex-wrap: wrap;">
          <strong>${Safe.html(member.name)}</strong>
          <span class="badge ${st.cls}"><i class="fas ${st.icon}"></i> ${Safe.html(st.label)}</span>
          <span class="text-secondary" style="font-size: 0.78rem;">độ tin cậy đọc chữ ${Safe.html(v.conf)}% • ${Safe.html(v.at || '')}</span>
        </div>
        <ul style="list-style: none; padding: 0; margin: 0; display: grid; gap: 0.35rem; font-size: 0.88rem;">
          ${(v.reasons || []).map((r) => `<li>${r.ok ? '✅' : '⚠️'} ${Safe.html(r.text)}</li>`).join('')}
          ${v.txRef ? `<li>🔖 Mã giao dịch: <span class="font-mono">${Safe.html(v.txRef)}</span></li>` : ''}
          ${dup ? `<li>🚨 Mã giao dịch này cũng xuất hiện ở phiếu của <strong>${Safe.html(dupMember ? dupMember.name : 'thành viên khác')}</strong> (tháng ${Safe.html(dup.month)}). Có thể dùng lại một biên lai.</li>` : ''}
        </ul>
        <img id="pv-detail-img" alt="Biên lai" style="max-width: 100%; max-height: 55vh; object-fit: contain; border-radius: 8px; border: 1px solid var(--border-color); min-height: 40px;">
        <p class="text-secondary" style="font-size: 0.78rem; margin: 0;">
          Đối chiếu tự động chỉ kiểm tra ảnh có <b>nhất quán</b> với khoản phải đóng. Ảnh có thể bị chỉnh sửa, nên nếu nghi ngờ hãy kiểm tra sao kê ngân hàng trước khi duyệt.
        </p>
        <div class="flex justify-end gap-2" style="flex-wrap: wrap;">
          <button type="button" class="btn btn-secondary" onclick="PaymentVerify.recheck(${Safe.js(due.id)})"><i class="fas fa-redo"></i> Đối chiếu lại</button>
          ${due.status === 'pending' ? `
          <button type="button" class="btn btn-danger" onclick="App.closeModal(); FundModule.approveDue(${Safe.js(due.id)}, false)"><i class="fas fa-times"></i> Từ chối</button>
          <button type="button" class="btn btn-primary" onclick="App.closeModal(); FundModule.approveDue(${Safe.js(due.id)}, true)"><i class="fas fa-check"></i> Duyệt</button>` : ''}
        </div>
      </div>`;
    App.openModal('🧾 Đối chiếu biên lai', body, true);
    AppStorage.getBill(due).then((img) => {
      const el = document.getElementById('pv-detail-img');
      if (el && img) el.src = Safe.url(img);
    });
  },

  async recheck(dueId) {
    App.closeModal();
    App.showToast('⏳ Đang đối chiếu lại biên lai…', 'info');
    await this.verifyDue(dueId, { force: true });
    if (window.FundModule) FundModule.renderFundDashboard();
    this.openDetail(dueId);
  },

  // Thanh công cụ trên bảng quỹ (Admin): trạng thái chạy nền + duyệt hàng loạt các phiếu đã khớp
  renderBar() {
    const box = document.getElementById('fund-verify-bar');
    if (!box) return;
    if (!AppStorage.can('finance')) { box.innerHTML = ''; return; }
    const data = AppStorage.loadData();
    const month = AppStorage.currentMonth();
    const dues = (data.monthlyContributions || []).filter((d) => d.month === month);
    const pendingWithImg = dues.filter((d) => d.status === 'pending' && d.billImage);
    const matched = pendingWithImg.filter((d) => !this.isStale(d) && d.verify.state === 'match' && !this.duplicateOf(d, data.monthlyContributions));
    const review = pendingWithImg.filter((d) => !this.isStale(d) && d.verify.state !== 'match').length;
    if (!pendingWithImg.length && !this.status) { box.innerHTML = ''; return; }
    box.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem 1rem; flex-wrap: wrap; padding: 0.7rem 1rem; margin: 0 0 0.75rem; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: var(--bg-input);">
        <div style="font-size: 0.85rem; min-width: 0;">
          <i class="fas fa-receipt text-primary"></i>
          <b>${pendingWithImg.length}</b> biên lai chờ duyệt:
          <span class="text-primary">${matched.length} khớp</span>${review ? `, <span style="color: var(--warning, #f59e0b);">${review} cần kiểm tra</span>` : ''}
          <div id="fund-verify-status" class="text-secondary" style="font-size: 0.75rem;">${Safe.html(this.status)}</div>
        </div>
        <div class="flex" style="gap: 0.4rem; flex-wrap: wrap;">
          <button type="button" class="btn btn-secondary btn-sm" onclick="PaymentVerify.runAgain()" ${this._busy ? 'disabled' : ''}><i class="fas fa-sync-alt"></i> Đối chiếu lại</button>
          <button type="button" class="btn btn-primary btn-sm" onclick="PaymentVerify.approveMatched()" ${matched.length ? '' : 'disabled'}><i class="fas fa-check-double"></i> Duyệt ${matched.length} phiếu đã khớp</button>
        </div>
      </div>`;
  },

  async runAgain() {
    this._attempted.clear();
    const data = AppStorage.loadData();
    (data.monthlyContributions || []).forEach((d) => { if (d.status === 'pending' && d.billImage) delete d.verify; });
    AppStorage.saveData(data);
    await this.autoRun();
  },

  async approveMatched() {
    if (!AppStorage.can('finance')) return;
    const data = AppStorage.loadData();
    const month = AppStorage.currentMonth();
    const list = (data.monthlyContributions || []).filter((d) => d.month === month && d.status === 'pending' && d.billImage && !this.isStale(d) &&
      d.verify.state === 'match' && !this.duplicateOf(d, data.monthlyContributions));
    if (!list.length) return;
    const names = list.map((d) => ((data.members || []).find((m) => m.id === d.memberId) || {}).name || 'Thành viên');
    if (!(await App.confirm(`Duyệt ${list.length} phiếu đã khớp?\n\n${names.join(', ')}\n\nĐối chiếu tự động chỉ kiểm tra ảnh nhất quán, không thay thế việc xem sao kê khi nghi ngờ.`))) return;
    const user = AppStorage.getCurrentUser();
    const approver = (user && user.name) || 'Ban quản trị CLB';
    const nowStr = new Date().toISOString().slice(0, 16).replace('T', ' ');
    if (!data.transactions) data.transactions = [];
    list.forEach((due, i) => {
      const member = (data.members || []).find((m) => m.id === due.memberId) || { name: 'Thành viên' };
      due.status = 'paid';
      due.approvedBy = `${approver} (đối chiếu tự động)`;
      due.approvedAt = nowStr;
      const idx = data.transactions.findIndex((t) => t.dueId === due.id);
      const tx = {
        id: idx >= 0 ? data.transactions[idx].id : `tx_${Date.now()}_${i}`, dueId: due.id, date: new Date().toISOString().slice(0, 10),
        type: 'income', category: 'Quỹ tháng', title: `Thu quỹ T${month.slice(5)} từ ${member.name}`, amount: Number(due.amount) || FundModule.getClubFee(data),
        createdBy: approver, note: `Admin duyệt chuyển khoản (${member.name})`
      };
      if (idx >= 0) data.transactions[idx] = tx; else data.transactions.unshift(tx);
    });
    App.showToast(`⏳ Đang lưu ${list.length} phiếu đã duyệt lên Cloud…`, 'info');
    const result = await AppStorage.saveDataWithCloudAck(data);
    App.showToast(result.success ? `✅ Đã duyệt ${list.length} phiếu.` : '⚠️ Đã duyệt trên máy, đang chờ đồng bộ lại Cloud.', result.success ? 'success' : 'warning');
    FundModule.renderFundDashboard();
    App.refreshDashboardStats();
  },

  // ---------------- Thành viên: tự kiểm tra ảnh trước khi gửi ----------------
  async previewCheck(memberId) {
    const img = document.getElementById('bill-preview-img');
    const box = document.getElementById('bill-check-result');
    if (!box) return;
    if (!img || !img.src || !img.src.startsWith('data:')) { box.innerHTML = '<span class="text-secondary">Hãy chọn ảnh biên lai trước.</span>'; return; }
    box.innerHTML = '<span class="text-secondary"><i class="fas fa-spinner fa-spin"></i> Đang đọc ảnh (lần đầu cần tải thư viện đọc chữ, vài MB)…</span>';
    try {
      const data = AppStorage.loadData();
      const member = (data.members || []).find((m) => m.id === memberId) || {};
      const due = (data.monthlyContributions || []).find((d) => d.memberId === memberId && d.month === AppStorage.currentMonth()) || {};
      const expected = this.expectedFor(Object.assign({ memberId, month: AppStorage.currentMonth() }, due), data);
      const res = await this.check(img.src, expected);
      const st = PaymentMatch.STATES[res.state];
      const hint = res.state === 'match' ? 'Ảnh đủ rõ và khớp thông tin. Bạn có thể gửi.' :
        res.state === 'unreadable' ? 'Ảnh khó đọc. Hãy chụp lại toàn màn hình biên lai (rõ số tiền, nội dung, tài khoản nhận).' :
        'Ảnh chưa khớp hoàn toàn. Bạn vẫn có thể gửi, Ban quản trị sẽ kiểm tra thủ công.';
      box.innerHTML = `<div><span class="badge ${st.cls}"><i class="fas ${st.icon}"></i> ${Safe.html(st.label)}</span> <span class="text-secondary" style="font-size: 0.8rem;">${Safe.html(hint)}</span></div>
        <ul style="list-style: none; padding: 0; margin: 0.4rem 0 0; font-size: 0.82rem; display: grid; gap: 0.2rem;">${res.reasons.map((r) => `<li>${r.ok ? '✅' : '⚠️'} ${Safe.html(r.text)}</li>`).join('')}</ul>`;
    } catch (e) {
      box.innerHTML = `<span class="text-secondary">⚠️ ${Safe.html(e.message)}</span>`;
    }
  }
};

window.PaymentVerify = PaymentVerify;
