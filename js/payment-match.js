// PaymentMatch - Đối chiếu chữ đọc được từ ảnh biên lai chuyển khoản với khoản phải đóng (logic thuần, không phụ thuộc OCR).
//
// Đầu vào: text (chuỗi OCR) và expected = { amount, code, bank: { accountNo, accountName }, monthStart (Date), now (Date) }.
// Kết quả state:
//   'match'      - số tiền ĐÚNG + mã chuyển khoản ĐÚNG + thấy tài khoản/tên nhận + ngày hợp lý
//   'review'     - có dấu hiệu đúng nhưng thiếu/lệch một vài yếu tố -> Ban quản trị xem ảnh rồi quyết định
//   'mismatch'   - đọc được số tiền nhưng không khớp và không thấy mã chuyển khoản
//   'unreadable' - không đọc được số tiền lẫn mã (ảnh mờ/cắt/không phải biên lai)
// LƯU Ý: đây chỉ là kiểm tra TÍNH NHẤT QUÁN của ảnh. Ảnh có thể bị chỉnh sửa; kết quả "match" KHÔNG chứng minh tiền đã
// vào tài khoản. Muốn chắc chắn tuyệt đối phải đối chiếu sao kê ngân hàng.
const PaymentMatch = {
  STATES: {
    match: { label: 'Khớp', icon: 'fa-check-double', cls: 'badge-paid' },
    review: { label: 'Cần kiểm tra', icon: 'fa-search', cls: 'badge-pending' },
    mismatch: { label: 'Không khớp', icon: 'fa-times-circle', cls: 'badge-unpaid' },
    unreadable: { label: 'Không đọc được', icon: 'fa-eye-slash', cls: 'badge-neutral' }
  },

  norm(text) {
    return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toUpperCase();
  },

  editDistance(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  },

  // Nội dung chuyển khoản chuẩn: "<TÊN NGẮN CLB> <MÃ> T<tháng>" - ngắn, không dấu, bank nào cũng giữ nguyên
  memoFor(info, code, month) {
    const raw = this.norm((info && (info.shortName || info.name)) || 'SMASH').replace(/[^A-Z0-9 ]/g, ' ').trim();
    const prefix = (raw.split(/\s+/)[0] || 'SMASH').slice(0, 8);
    const mm = String(month || '').slice(5, 7);
    return [prefix, code, mm ? 'T' + Number(mm) : ''].filter(Boolean).join(' ');
  },

  // Các số tiền xuất hiện trong ảnh (số nguyên VNĐ), kể cả dạng 100.000 / 100,000 / 100 000 / 100000
  amountCandidates(t) {
    const out = [];
    const re = /(\d{1,3}(?:[.,  ]\d{3})+|\d{4,})(?!\d)/g;
    let m;
    while ((m = re.exec(t))) {
      const value = parseInt(m[1].replace(/[^0-9]/g, ''), 10);
      if (value >= 1000 && value <= 1000000000 && out.indexOf(value) === -1) out.push(value);
    }
    return out;
  },

  findCode(t, code) {
    if (!code) return 'none';
    const squashed = t.replace(/[^A-Z0-9]/g, '');
    if (squashed.indexOf(code) !== -1) return 'exact';
    const tokens = t.split(/[^A-Z0-9]+/).filter(Boolean);
    for (const tok of tokens) {
      if (Math.abs(tok.length - code.length) <= 1 && tok.length >= code.length - 1 && this.editDistance(tok, code) <= 1) return 'fuzzy';
    }
    return 'none';
  },

  findReceiver(t, bank) {
    if (!bank) return { status: 'none' };
    const acc = String(bank.accountNo || '').replace(/\D/g, '');
    const digits = t.replace(/[^0-9]/g, '');
    if (acc.length >= 6 && digits.indexOf(acc) !== -1) return { status: 'exact' };
    if (acc.length >= 6) {
      const last4 = acc.slice(-4);
      if (new RegExp('[*X•]{2,}\\s*' + last4).test(t)) return { status: 'masked' };
    }
    const words = this.norm(bank.accountName || '').split(/[^A-Z0-9]+/).filter((w) => w.length >= 2);
    if (words.length >= 2) {
      const hit = words.filter((w) => t.indexOf(w) !== -1).length;
      if (hit / words.length >= 0.7) return { status: 'name' };
    }
    return { status: 'none' };
  },

  findDates(t) {
    const out = [];
    const push = (y, mo, d) => {
      y = Number(y); mo = Number(mo); d = Number(d);
      if (y >= 2020 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) out.push(new Date(Date.UTC(y, mo - 1, d)));
    };
    let m;
    const dmy = /(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(20\d{2})/g;
    while ((m = dmy.exec(t))) push(m[3], m[2], m[1]);
    const ymd = /(20\d{2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{1,2})/g;
    while ((m = ymd.exec(t))) push(m[1], m[2], m[3]);
    const vi = /(\d{1,2})\s*THANG\s*(\d{1,2})\s*(?:NAM)?\s*(20\d{2})/g;
    while ((m = vi.exec(t))) push(m[3], m[2], m[1]);
    return out;
  },

  findTxRef(t) {
    const m = /(?:MA\s*(?:GIAO\s*DICH|GD|THAM\s*CHIEU)|SO\s*THAM\s*CHIEU|TRANSACTION\s*(?:ID|NO)|REF(?:ERENCE)?(?:\s*NO)?)\s*[:#.\-]?\s*([A-Z0-9]{6,24})/.exec(t);
    if (m) return m[1];
    const ft = /\b(FT\d{8,16}[A-Z0-9]*)\b/.exec(t);
    return ft ? ft[1] : '';
  },

  analyze(text, expected) {
    const t = this.norm(text);
    const exp = expected || {};
    const reasons = [];
    const amounts = this.amountCandidates(t);
    const amountOk = amounts.indexOf(Number(exp.amount)) !== -1;
    const codeState = this.findCode(t, exp.code);
    const receiver = this.findReceiver(t, exp.bank);

    // Ngày: có ngày trong khoảng hợp lý (từ đầu tháng đóng trừ 15 ngày đến ngày mai)
    let dateState = 'none';
    const dates = this.findDates(t);
    if (dates.length) {
      const now = exp.now instanceof Date ? exp.now : new Date();
      const hi = now.getTime() + 36 * 3600e3;
      const lo = (exp.monthStart instanceof Date ? exp.monthStart.getTime() : now.getTime() - 45 * 86400e3) - 15 * 86400e3;
      const inWin = dates.some((d) => d.getTime() >= lo && d.getTime() <= hi);
      dateState = inWin ? 'ok' : (dates.every((d) => d.getTime() > hi) ? 'future' : 'old');
    }
    const txRef = this.findTxRef(t);

    if (amountOk) reasons.push({ ok: true, text: `Số tiền ${Number(exp.amount).toLocaleString('vi-VN')} đ` });
    else if (amounts.length) reasons.push({ ok: false, text: `Số tiền trong ảnh khác ${Number(exp.amount).toLocaleString('vi-VN')} đ (thấy: ${amounts.slice(0, 4).map((a) => a.toLocaleString('vi-VN')).join(', ')})` });
    else reasons.push({ ok: false, text: 'Không đọc được số tiền' });

    if (codeState === 'exact') reasons.push({ ok: true, text: `Có mã chuyển khoản ${exp.code}` });
    else if (codeState === 'fuzzy') reasons.push({ ok: false, text: `Mã chuyển khoản giống ${exp.code} nhưng chưa chắc chắn` });
    else reasons.push({ ok: false, text: `Không thấy mã chuyển khoản ${exp.code}` });

    if (receiver.status === 'exact') reasons.push({ ok: true, text: 'Đúng số tài khoản nhận' });
    else if (receiver.status === 'masked') reasons.push({ ok: true, text: 'Khớp 4 số cuối tài khoản nhận' });
    else if (receiver.status === 'name') reasons.push({ ok: true, text: 'Đúng tên chủ tài khoản nhận' });
    else reasons.push({ ok: false, text: 'Không thấy số/tên tài khoản nhận' });

    if (dateState === 'ok') reasons.push({ ok: true, text: 'Ngày chuyển hợp lý' });
    else if (dateState === 'old') reasons.push({ ok: false, text: 'Ngày trong ảnh quá cũ so với kỳ đóng quỹ' });
    else if (dateState === 'future') reasons.push({ ok: false, text: 'Ngày trong ảnh ở tương lai' });

    let state;
    if (amountOk && codeState === 'exact' && receiver.status !== 'none' && dateState !== 'old' && dateState !== 'future') state = 'match';
    else if (!amounts.length && codeState === 'none') state = 'unreadable';
    else if (amounts.length && !amountOk && codeState === 'none') state = 'mismatch';
    else state = 'review';

    return {
      state, amounts, amountOk, code: codeState, receiver: receiver.status, date: dateState, txRef, reasons
    };
  }
};

window.PaymentMatch = PaymentMatch;
