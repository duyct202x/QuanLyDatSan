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
      this.setValue('set-monthly-fee', info.monthlyFee || info.monthlyFundFee || '');
      this.setValue('set-guest-fee', info.guestFee || '');
      this.setValue('set-lock-hours', info.voteLockHours || 48);
      const autoOpen = info.autoVoteOpen || {};
      const autoOpenToggle = document.getElementById('set-auto-vote-open');
      if (autoOpenToggle) autoOpenToggle.checked = !!autoOpen.enabled;
      this.setValue('set-auto-vote-days', autoOpen.daysBefore || 5);
      this.setValue('set-auto-vote-time', autoOpen.time || '08:00');
      this.fillMonthDayOptions();
      this.setValue('set-auto-vote-mode', autoOpen.mode || 'daysBefore');
      this.setValue('set-auto-vote-weekday', autoOpen.weekday !== undefined ? autoOpen.weekday : 1);
      this.setValue('set-auto-vote-monthday', autoOpen.monthDay || 1);
      this.onAutoVoteModeChange();
      const mail = info.emailNotify || {};
      const setCheck = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
      setCheck('set-email-enabled', mail.enabled);
      setCheck('set-email-vote-open', mail.voteOpen !== false);
      setCheck('set-email-booked', mail.booked !== false);
      setCheck('set-email-court-full', mail.courtFull !== false);
      setCheck('set-email-due', !!mail.dueReminder);
      this.setValue('set-email-due-day', mail.dueReminderDay || 10);
      this.setValue('set-email-court-per', mail.courtFullPerCourt || 6);
      setCheck('set-email-cancelled', mail.cancelled !== false);
      setCheck('set-email-fixed-request', mail.fixedRequest !== false);
      setCheck('set-email-fixed-result', mail.fixedResult !== false);
      setCheck('set-email-reminder', !!mail.reminder);
      this.setValue('set-email-reminder-hours', mail.reminderHours || 4);
      this.setValue('set-email-vote-audience', mail.voteOpenAudience || 'all');
      this.refreshEmailStatus(false);
      const pushCfg = info.pushConfig || {};
      setCheck('set-push-enabled', (info.pushNotify || {}).enabled);
      this.setValue('set-push-apikey', pushCfg.apiKey || '');
      this.setValue('set-push-projectid', pushCfg.projectId || '');
      this.setValue('set-push-senderid', pushCfg.messagingSenderId || '');
      this.setValue('set-push-appid', pushCfg.appId || '');
      this.setValue('set-push-vapid', pushCfg.vapidKey || '');
      this.refreshPushStatus();
      this.renderDeviceBackups();
      if (window.RolesModule) RolesModule.renderPanel();

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

  // Tách giá trị từ đoạn firebaseConfig dán vào (apiKey, projectId, messagingSenderId, appId) để điền các ô
  parseFirebaseConfig(text) {
    const pick = (k) => { const m = new RegExp(k + '\\s*[:=]\\s*["\']([^"\']+)["\']').exec(text || ''); return m ? m[1].trim() : ''; };
    const map = { 'set-push-apikey': 'apiKey', 'set-push-projectid': 'projectId', 'set-push-senderid': 'messagingSenderId', 'set-push-appid': 'appId' };
    Object.keys(map).forEach((id) => { const v = pick(map[id]); if (v) this.setValue(id, v); });
  },

  // Trạng thái thông báo đẩy: đã cấu hình khóa trên máy chủ chưa, bao nhiêu người/thiết bị đã đăng ký
  async refreshPushStatus() {
    const line = document.getElementById('push-status-line');
    if (!line || !AppStorage.isAdmin() || AppStorage.isLocalOnly()) return;
    line.textContent = 'Đang kiểm tra…';
    const session = AppStorage._readSession();
    const res = await AppStorage._authRequest({ action: 'pushStatus', token: session && session.token });
    if (res.status !== 'ok') { line.textContent = `⚠️ ${res.message || 'Không kiểm tra được.'}`; return; }
    const keyOk = res.configured
      ? '✅ Máy chủ đã có khóa Firebase.'
      : '⚠️ Máy chủ CHƯA có khóa Firebase (Script Properties → FCM_SERVICE_ACCOUNT) nên chưa gửi được.';
    line.textContent = `${keyOk} Đã đăng ký: ${res.subscribers || 0} người / ${res.devices || 0} thiết bị.${res.enabled ? '' : ' (CLB đang tắt thông báo đẩy)'}`;
  },

  // Trạng thái trình gửi email trên Apps Script; enable=true thì bật nếu chưa bật
  async refreshEmailStatus(enable) {
    const line = document.getElementById('email-status-line');
    const enabled = !!document.getElementById('set-email-enabled')?.checked;
    if (!line) return;
    if (!enabled && !enable) {
      line.textContent = 'Đang tắt gửi email.';
      return;
    }
    line.textContent = 'Đang kiểm tra trình gửi email...';
    const res = await AppStorage.emailAction('emailSetup', { enable: !!enable });
    if (res.status === 'ok') {
      line.textContent = res.installed
        ? `✅ Trình gửi thông báo đang hoạt động (kiểm tra 5 phút/lần). Hạn mức email còn lại hôm nay: ${res.quota}.`
        : '⚠️ Trình gửi email chưa bật. Bấm "Lưu cài đặt" để bật.';
    } else {
      line.textContent = `⚠️ ${res.message || 'Không kiểm tra được trình gửi email.'}`;
    }
  },

  BACKUP_REASONS: {
    'dinh-ky': 'Tự động hằng giờ',
    'truoc-khi-tai-toan-bo': 'Trước khi tải lại làm mất dữ liệu',
    'truoc-khi-thay-toan-bo': 'Trước khi đặt lại / nhập dữ liệu',
    'may-chu-bat-thuong': 'Khi máy chủ trả dữ liệu bất thường',
    'du-lieu-ban-cu-luc-nang-cap': 'Dữ liệu bản cũ lúc nâng cấp',
    'ban-sao-cu': 'Bản sao kiểu cũ (v1)'
  },
  BACKUP_SHOWN: 3,

  // Bản sao lưu trên thiết bị: xem, tải về, gửi lên máy chủ (hợp nhất, không xóa dữ liệu mới), xóa
  renderDeviceBackups() {
    const box = document.getElementById('device-backups-panel');
    if (!box) return;
    if (!AppStorage.isAdmin()) { box.innerHTML = ''; return; }
    const warn = AppStorage.getServerWarning();
    const list = AppStorage.listLocalBackups();
    const now = AppStorage.currentBackupCounts();
    const fmt = (ms) => ms ? new Date(ms).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' }) : 'Không rõ thời gian';
    const LABELS = [['users', 'tài khoản'], ['members', 'thành viên'], ['sessions', 'buổi'], ['transactions', 'giao dịch'], ['dues', 'phiếu quỹ']];
    const row = (b) => {
      const more = LABELS.filter(([k]) => (b.counts[k] || 0) > (now[k] || 0)).map(([k, l]) => `+${b.counts[k] - (now[k] || 0)} ${l}`);
      const counts = LABELS.filter(([k]) => b.counts[k]).map(([k, l]) => `${b.counts[k]} ${l}`).join(' • ') || 'Không có dữ liệu';
      return `
          <div class="backup-row" style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem 1rem; padding: 0.6rem 0; border-top: 1px solid var(--border-color); flex-wrap: wrap;">
            <div style="font-size: 0.82rem; min-width: 0; flex: 1 1 260px;">
              <div><b>${Safe.html(fmt(b.at))}</b> <span class="text-secondary">• ${Safe.html(this.BACKUP_REASONS[b.reason] || b.reason)}</span></div>
              <div class="text-secondary" style="overflow-wrap: anywhere;">${Safe.html(counts)}</div>
              ${more.length ? `<div style="color: var(--warning, #f59e0b); font-size: 0.78rem;"><i class="fas fa-exclamation-triangle"></i> Nhiều hơn dữ liệu hiện tại: ${Safe.html(more.join(', '))}</div>` : ''}
            </div>
            <div style="display: flex; gap: 0.4rem; flex-shrink: 0;">
              <button type="button" class="btn btn-secondary btn-sm" title="Tải tệp JSON về máy" onclick="AppStorage.downloadLocalBackup(${Safe.js(b.id)})"><i class="fas fa-download"></i> Tải về</button>
              <button type="button" class="btn btn-outline-primary btn-sm" title="Gửi lên máy chủ để hợp nhất (không xóa dữ liệu mới)" onclick="SettingsModule.restoreDeviceBackup(${Safe.js(b.id)})"><i class="fas fa-cloud-upload-alt"></i> Khôi phục</button>
              <button type="button" class="btn btn-secondary btn-sm" title="Xóa bản sao này khỏi thiết bị" onclick="SettingsModule.deleteDeviceBackup(${Safe.js(b.id)})"><i class="fas fa-trash-alt"></i></button>
            </div>
          </div>`;
    };
    const shown = list.slice(0, this.BACKUP_SHOWN), rest = list.slice(this.BACKUP_SHOWN);
    box.innerHTML = `
      <div class="card" style="padding: 1rem 1.25rem; margin-bottom: 1rem;">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.35rem;">
          <div class="font-bold"><i class="fas fa-shield-alt text-primary"></i> Bản sao lưu trên thiết bị này</div>
          <span class="badge badge-neutral" style="font-size: 0.72rem;">${list.length} bản</span>
        </div>
        ${warn ? `<div class="badge badge-warning" style="display: block; white-space: normal; margin-bottom: 0.6rem; padding: 0.5rem;">⚠️ ${Safe.html(warn.message)}</div>` : ''}
        <div class="text-secondary" style="font-size: 0.78rem; margin-bottom: 0.25rem;">
          Tự lưu khi dữ liệu thay đổi (tối đa 1 lần/giờ, giữ ${AppStorage.BACKUP_KEEP} bản khác nhau) và trước thao tác có thể làm mất dữ liệu.
          Chỉ thiết bị của Ban quản trị mới sao lưu. Máy chủ có bản sao riêng (mỗi ngày & mỗi lần cập nhật).
        </div>
        ${list.length ? shown.map(row).join('') + (rest.length ? `
        <details style="border-top: 1px solid var(--border-color); padding-top: 0.5rem;">
          <summary class="text-secondary" style="cursor: pointer; font-size: 0.82rem;">Xem ${rest.length} bản cũ hơn</summary>
          ${rest.map(row).join('')}
        </details>` : '') : '<div class="text-secondary" style="font-size: 0.82rem; padding-top: 0.5rem; border-top: 1px solid var(--border-color);">Chưa có bản sao nào trên thiết bị này.</div>'}
      </div>`;
  },

  async deleteDeviceBackup(id) {
    if (!(await App.confirm('Xóa bản sao này khỏi thiết bị? Không ảnh hưởng dữ liệu trên máy chủ.'))) return;
    if (await AppStorage.deleteLocalBackup(id)) App.showToast('🗑️ Đã xóa bản sao', 'success');
    this.renderDeviceBackups();
  },

  async restoreDeviceBackup(id) {
    if (!(await App.confirm('Gửi bản sao này lên máy chủ?\n\nMáy chủ sẽ HỢP NHẤT: chỉ lấy lại dữ liệu bị thiếu hoặc cũ hơn, không xóa dữ liệu mới, không đổi mật khẩu/vai trò.'))) return;
    const res = await AppStorage.restoreLocalBackupToServer(id);
    App.showToast(res.message, res.success ? 'success' : 'warning');
    this.renderDeviceBackups();
  },

  async sendTestEmail() {
    const res = await AppStorage.emailAction('emailTest', {});
    App.showToast(res.message || (res.status === 'ok' ? 'Đã gửi email thử.' : 'Không gửi được email thử.'), res.status === 'ok' ? 'success' : 'warning');
  },

  fillMonthDayOptions() {
    const sel = document.getElementById('set-auto-vote-monthday');
    if (!sel || sel.options.length) return;
    for (let d = 1; d <= 31; d++) {
      const opt = document.createElement('option');
      opt.value = String(d);
      opt.textContent = d >= 29 ? `Ngày ${d} (tháng thiếu ngày -> ngày cuối tháng)` : `Ngày ${d}`;
      sel.appendChild(opt);
    }
  },

  // Hiện ô phù hợp với kiểu lịch mở bình chọn đã chọn
  onAutoVoteModeChange() {
    const mode = document.getElementById('set-auto-vote-mode')?.value || 'daysBefore';
    const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
    show('set-auto-vote-days-box', mode === 'daysBefore');
    show('set-auto-vote-weekday-box', mode === 'weekday');
    show('set-auto-vote-monthday-box', mode === 'monthday');
    const desc = document.getElementById('set-auto-vote-desc');
    if (desc && window.VoteScheduler) {
      const cfg = {
        enabled: true, mode,
        daysBefore: parseInt(document.getElementById('set-auto-vote-days')?.value) || 5,
        weekday: parseInt(document.getElementById('set-auto-vote-weekday')?.value) || 0,
        monthDay: parseInt(document.getElementById('set-auto-vote-monthday')?.value) || 1,
        time: document.getElementById('set-auto-vote-time')?.value || '08:00'
      };
      desc.textContent = 'Quy tắc: ' + VoteScheduler.describeRule({ autoVoteOpen: cfg }) + '. Áp dụng làm giờ mở mặc định khi tạo buổi đánh mới.';
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
    data.clubInfo.monthlyFee = parseInt(document.getElementById('set-monthly-fee').value) || 0;
    data.clubInfo.monthlyFundFee = data.clubInfo.monthlyFee;
    data.clubInfo.guestFee = parseInt(document.getElementById('set-guest-fee').value) || 0;
    data.clubInfo.voteLockHours = parseInt(document.getElementById('set-lock-hours').value) || 48;
    if (document.getElementById('set-auto-vote-open')) {
      data.clubInfo.autoVoteOpen = {
        enabled: document.getElementById('set-auto-vote-open').checked,
        mode: ['daysBefore', 'weekday', 'monthday'].includes(document.getElementById('set-auto-vote-mode')?.value) ? document.getElementById('set-auto-vote-mode').value : 'daysBefore',
        daysBefore: parseInt(document.getElementById('set-auto-vote-days')?.value) || 5,
        weekday: Math.min(6, Math.max(0, parseInt(document.getElementById('set-auto-vote-weekday')?.value) || 0)),
        monthDay: Math.min(31, Math.max(1, parseInt(document.getElementById('set-auto-vote-monthday')?.value) || 1)),
        time: document.getElementById('set-auto-vote-time')?.value || '08:00'
      };
    }
    data.clubInfo.autoApprove = document.getElementById('set-auto-approve').checked;
    if (document.getElementById('set-email-enabled')) {
      const checked = (id) => !!document.getElementById(id)?.checked;
      data.clubInfo.emailNotify = {
        enabled: checked('set-email-enabled'),
        voteOpen: checked('set-email-vote-open'),
        booked: checked('set-email-booked'),
        courtFull: checked('set-email-court-full'),
        dueReminder: checked('set-email-due'),
        dueReminderDay: parseInt(document.getElementById('set-email-due-day')?.value) || 10,
        courtFullPerCourt: parseInt(document.getElementById('set-email-court-per')?.value) || 6,
        cancelled: checked('set-email-cancelled'),
        fixedRequest: checked('set-email-fixed-request'),
        fixedResult: checked('set-email-fixed-result'),
        reminder: checked('set-email-reminder'),
        reminderHours: parseInt(document.getElementById('set-email-reminder-hours')?.value) || 4,
        voteOpenAudience: document.getElementById('set-email-vote-audience')?.value === 'fixed' ? 'fixed' : 'all'
      };
    }

    if (document.getElementById('set-push-enabled')) {
      const pv = (id) => (document.getElementById(id)?.value || '').trim();
      const safe = (s) => (/^[A-Za-z0-9_:.\-]*$/.test(s) ? s : '');
      const cfg = { apiKey: safe(pv('set-push-apikey')), projectId: safe(pv('set-push-projectid')), messagingSenderId: safe(pv('set-push-senderid')), appId: safe(pv('set-push-appid')), vapidKey: safe(pv('set-push-vapid')) };
      const complete = Object.values(cfg).every(Boolean);
      const want = !!document.getElementById('set-push-enabled').checked;
      if (want && !complete) App.showToast('Thông báo đẩy cần đủ 5 thông tin cấu hình Firebase (chỉ gồm chữ, số, - _ : .). Đã lưu nhưng chưa bật.', 'warning');
      data.clubInfo.pushConfig = cfg;
      data.clubInfo.pushNotify = { enabled: want && complete };
    }

    data.clubInfo.bank.bankId = document.getElementById('set-bank-id').value;
    data.clubInfo.bank.accountNo = document.getElementById('set-bank-account-no').value.trim();
    data.clubInfo.bank.accountName = document.getElementById('set-bank-account-name').value.trim().toUpperCase();

    // Also update bank name display text
    const bankSelect = document.getElementById('set-bank-id');
    const selectedOption = bankSelect.options[bankSelect.selectedIndex];
    data.clubInfo.bank.bankName = selectedOption ? selectedOption.text : 'Ngân hàng';

    AppStorage.saveData(data);
    if (data.clubInfo.emailNotify && data.clubInfo.emailNotify.enabled) this.refreshEmailStatus(true);
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
          <img class="avatar avatar-sm" src="${Safe.url(m.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(m.name)}&background=10b981&color=fff`)}" alt="${Safe.html(m.name)}" style="width: 32px; height: 32px; border-radius: 50%;">
          <div>
            <div class="font-bold flex items-center gap-2" style="font-size: 0.9rem;">
              ${Safe.html(m.name)}
              <span class="badge ${m.role === 'admin' ? 'badge-warning' : m.role === 'treasurer' ? 'badge-info' : 'badge-neutral'}" style="font-size: 0.65rem;">
                ${m.role === 'admin' ? 'Admin' : m.role === 'treasurer' ? 'Thủ quỹ' : 'Thành viên'}
              </span>
              <span class="badge ${m.type === 'fixed' ? 'badge-paid' : 'badge-warning'}" style="font-size: 0.65rem;">
                ${m.type === 'fixed' ? 'Cố định' : 'Vãng lai'}
              </span>
            </div>
            <div class="text-secondary" style="font-size: 0.76rem;">
              <i class="fas fa-phone-alt"></i> ${Safe.html(m.phone)}
            </div>
          </div>
        </div>

        <div class="flex gap-2">
          <button class="btn btn-secondary btn-sm" onclick="MembersModule.openEditMemberModal(${Safe.js(m.id)})" title="Sửa thông tin">
            <i class="fas fa-edit"></i>
          </button>
          <button class="btn btn-outline-danger btn-sm" onclick="MembersModule.deleteMember(${Safe.js(m.id)})" title="Xóa thành viên">
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


  renderPublicMemberRoster() {
    if (window.MembersModule) MembersModule.renderPublicMemberRoster();
  },

  // Toggle giữa CSDL Vận hành thực tế và CSDL Dữ liệu thử nghiệm (Chỉ Admin)
  async switchDatabaseEnvironment(mode) {
    const isTest = mode === 'test';
    const confirmMsg = isTest 
      ? "Chuyển sang chế độ CSDL KIỂM THỬ (TEST DEMO) với dữ liệu mẫu 10 thành viên và các buổi đánh thử nghiệm?" 
      : "Chuyển sang chế độ CSDL VẬN HÀNH THỰC TẾ (PRODUCTION)?";

    if (!(await App.confirm(confirmMsg))) return;

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
          <input type="text" id="modal-banner-name" class="form-control" value="${Safe.html(info.name || 'SMASH PRO Badminton Club')}" required placeholder="VD: SMASH PRO BADMINTON CLUB">
        </div>

        <div class="responsive-form-row">
          <div class="form-group">
            <label class="form-label font-bold"><i class="fas fa-fire text-warning"></i> Mùa giải / Huy hiệu</label>
            <input type="text" id="modal-banner-season" class="form-control" value="${Safe.html(info.season || 'Mùa giải 2026')}" placeholder="VD: Mùa giải 2026">
          </div>
          <div class="form-group">
            <div class="flex items-center justify-between" style="margin-bottom: 0.35rem;">
              <label class="form-label font-bold" style="margin-bottom: 0;"><i class="fas fa-home text-primary"></i> Sân nhà mặc định</label>
              <button type="button" class="btn btn-ghost btn-icon btn-xs" onclick="ScheduleModule.openEditCourtLocationModal('club')" title="Admin: Sửa vị trí & bản đồ sân nhà" style="border: 1px solid var(--border-color); border-radius: var(--radius-sm);">
                <i class="fas fa-pencil-alt text-warning"></i>
              </button>
            </div>
            <input type="text" id="modal-banner-court" class="form-control" value="${Safe.html(info.defaultCourt || '')}" placeholder="VD: Sân cầu lông CLB (Sân 1 & 2)">
          </div>
        </div>

        <div class="form-group">
          <label class="form-label font-bold"><i class="fas fa-location-arrow text-primary"></i> Địa chỉ sân nhà CLB</label>
          <input type="text" id="modal-banner-address" class="form-control" value="${Safe.html(info.address || '')}" placeholder="VD: Số 123 Đường ABC, Quận XYZ, TP. Hồ Chí Minh">
        </div>

        <div class="form-group">
          <div class="flex items-center justify-between" style="margin-bottom: 0.35rem;">
            <label class="form-label font-bold" style="margin-bottom: 0;"><i class="fas fa-map-marker-alt text-primary"></i> Dòng thông tin phụ / Ghi chú Banner</label>
            <button type="button" class="btn btn-outline-primary btn-sm" onclick="document.getElementById('modal-banner-sub').value=${Safe.js(defaultSub)}" style="padding: 0.15rem 0.45rem; font-size: 0.72rem;">
              <i class="fas fa-magic"></i> Tạo tự động
            </button>
          </div>
          <textarea id="modal-banner-sub" class="form-control" rows="2" placeholder="${Safe.html(defaultSub)}">${Safe.html(info.bannerSubtitle || '')}</textarea>
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
    if (!(await App.confirm("⚠️ BẠN CÓ CHẮC CHẮN MUỐN ĐẶT LẠI CSDL SẠCH MẶC ĐỊNH?\n\nToàn bộ danh sách thành viên, ca đánh, quỹ tháng và sổ thu chi sẽ được đưa về 0 và đồng bộ làm sạch ngay trên database."))) {
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
  async handleChangeAdminPassword(e) {
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

    const result = await AppStorage.changePassword(currentUser.id, oldPwd, newPwd, confirmPwd);
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

  async handleModalChangeAdminPassword(e) {
    if (e && e.preventDefault) e.preventDefault();
    const currentUser = AppStorage.getCurrentUser();
    if (!currentUser) return;

    const oldPwd = document.getElementById('modal-admin-old-pwd')?.value || '';
    const newPwd = document.getElementById('modal-admin-new-pwd')?.value || '';
    const confirmPwd = document.getElementById('modal-admin-confirm-pwd')?.value || '';

    const result = await AppStorage.changePassword(currentUser.id, oldPwd, newPwd, confirmPwd);
    if (result.success) {
      App.closeModal();
      App.showToast(`🎉 ${result.message}`, "success");
    } else {
      App.showToast(`⚠️ ${result.message}`, "error");
    }
  }
};

window.SettingsModule = SettingsModule;
