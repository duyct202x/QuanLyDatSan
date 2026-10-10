// MembershipModule - Kiểm soát thành viên cố định (cần Ban quản trị duyệt)
// user.fixedRequest: 'pending' (chờ duyệt) | 'approved' | 'rejected' | 'cancelled'
// user.fixedRequestAt: thời điểm gửi yêu cầu; user.fixedDecidedAt / fixedDecidedBy: lúc & người duyệt.
// Máy chủ chỉ cho thành viên tự gửi/hủy yêu cầu; đổi loại thành "cố định" chỉ Ban quản trị làm được.
const MembershipModule = {
  _debounce: null,

  init() {
    window.addEventListener('app-state-changed', () => {
      clearTimeout(this._debounce);
      this._debounce = setTimeout(() => {
        this.renderPanel();
        this.checkNotifications();
      }, 400);
    });
    setTimeout(() => { this.renderPanel(); this.checkNotifications(); }, 1500);
  },

  _toast(msg, type) {
    if (window.App && App.showToast) App.showToast(msg, type);
  },

  pendingUsers(data) {
    return (data.users || []).filter((u) => u && u.fixedRequest === 'pending' && u.type !== 'fixed');
  },

  // Thành viên (theo memberId) đang chờ duyệt cố định
  isPendingMember(member, data) {
    if (!member) return false;
    return (data.users || []).some((u) => u.fixedRequest === 'pending' && u.type !== 'fixed' &&
      (u.memberId === member.id || (member.username && u.username === member.username)));
  },

  // ---------------- Bảng điều khiển ở tab Thành viên ----------------
  renderPanel() {
    const box = document.getElementById('fixed-requests-panel');
    if (!box) return;
    const user = AppStorage.getCurrentUser();
    if (!user) {
      box.innerHTML = '';
      return;
    }
    const data = AppStorage.loadData();
    let html = '';

    if (AppStorage.isAdmin()) {
      const pending = this.pendingUsers(data);
      if (pending.length) {
        html += `
          <div class="card" style="padding: 1rem 1.25rem; margin-bottom: 1rem; border-left: 4px solid var(--warning, #f59e0b);">
            <div class="font-bold" style="margin-bottom: 0.6rem;"><i class="fas fa-user-clock text-warning"></i> Yêu cầu thành viên cố định chờ duyệt (${pending.length})</div>
            ${pending.map((u) => `
              <div class="flex items-center justify-between" style="gap: 0.75rem; padding: 0.5rem 0; border-top: 1px solid var(--border-color); flex-wrap: wrap;">
                <div>
                  <div class="font-bold">${Safe.html(u.name)}</div>
                  <div class="text-secondary" style="font-size: 0.78rem;">${Safe.html(u.username)}${u.phone ? ' • ' + Safe.html(u.phone) : ''}${u.fixedRequestAt ? ' • gửi lúc ' + Safe.html(String(u.fixedRequestAt).slice(0, 16).replace('T', ' ')) : ''}</div>
                </div>
                <div class="flex" style="gap: 0.4rem;">
                  <button class="btn btn-primary btn-sm" onclick="MembershipModule.decide(${Safe.js(u.username)}, true)"><i class="fas fa-check"></i> Duyệt</button>
                  <button class="btn btn-secondary btn-sm" onclick="MembershipModule.decide(${Safe.js(u.username)}, false)"><i class="fas fa-times"></i> Từ chối</button>
                </div>
              </div>`).join('')}
          </div>`;
      }
    } else if (user.type !== 'fixed') {
      const st = user.fixedRequest;
      html += `
        <div class="card" style="padding: 1rem 1.25rem; margin-bottom: 1rem;">
          <div class="flex items-center justify-between" style="gap: 0.75rem; flex-wrap: wrap;">
            <div>
              <div class="font-bold"><i class="fas fa-id-card text-primary"></i> ${st === 'pending' ? 'Yêu cầu thành viên cố định đang chờ duyệt' : 'Bạn đang là khách vãng lai'}</div>
              <div class="text-secondary" style="font-size: 0.8rem;">${st === 'pending'
                ? 'Ban quản trị sẽ xem xét và thông báo cho bạn.'
                : st === 'rejected' ? 'Yêu cầu trước chưa được duyệt. Bạn có thể gửi lại.' : 'Thành viên cố định góp quỹ tháng và xem được sổ quỹ CLB. Cần Ban quản trị duyệt.'}</div>
            </div>
            ${st === 'pending'
              ? `<button class="btn btn-secondary btn-sm" onclick="MembershipModule.setRequest(false)"><i class="fas fa-undo"></i> Hủy yêu cầu</button>`
              : `<button class="btn btn-primary btn-sm" onclick="MembershipModule.setRequest(true)"><i class="fas fa-paper-plane"></i> Đăng ký thành viên cố định</button>`}
          </div>
        </div>`;
    }
    box.innerHTML = html;
  },

  // Thành viên gửi / hủy yêu cầu
  setRequest(want) {
    const data = AppStorage.loadData();
    const cur = AppStorage.getCurrentUser();
    const user = cur && (data.users || []).find((u) => u.username === cur.username);
    if (!user) {
      this._toast('Vui lòng đăng nhập!', 'warning');
      return;
    }
    if (want) {
      if (user.type === 'fixed') return;
      user.fixedRequest = 'pending';
      user.fixedRequestAt = new Date().toISOString();
    } else {
      user.fixedRequest = 'cancelled';
    }
    AppStorage.saveData(data);
    this._toast(want ? '📨 Đã gửi yêu cầu làm thành viên cố định, vui lòng chờ Ban quản trị duyệt.' : 'Đã hủy yêu cầu thành viên cố định.', 'success');
    this.renderPanel();
  },

  // Ban quản trị duyệt / từ chối
  async decide(username, approve) {
    if (!AppStorage.isAdmin()) {
      this._toast('Chỉ Ban quản trị mới được duyệt thành viên cố định!', 'warning');
      return;
    }
    const data = AppStorage.loadData();
    const user = (data.users || []).find((u) => u.username === username);
    if (!user) return;
    const admin = AppStorage.getCurrentUser();
    user.fixedRequest = approve ? 'approved' : 'rejected';
    user.fixedDecidedAt = Date.now();
    user.fixedDecidedBy = admin ? admin.username : '';
    if (approve) {
      user.type = 'fixed';
      const member = (data.members || []).find((m) => m.id === user.memberId || (m.username && m.username === user.username));
      if (member) member.type = 'fixed';
    }
    const result = await AppStorage.saveDataWithCloudAck(data);
    this._toast(approve ? `✅ Đã duyệt ${user.name} làm thành viên cố định.` : `Đã từ chối yêu cầu của ${user.name}.`, result.success ? 'success' : 'warning');
    this.renderPanel();
    if (window.MembersModule && typeof MembersModule.renderMembersTab === 'function') MembersModule.renderMembersTab();
  },

  // ---------------- Thông báo trên thiết bị ----------------
  _seenKey(username) {
    return `${(AppStorage._ns && AppStorage._ns()) || ''}SMASH_PRO_SEEN_MEMBERSHIP_${username}`;
  },

  collectNew(data, user, now = Date.now()) {
    if (!user || !user.username) return [];
    const key = this._seenKey(user.username);
    let seen = {};
    try { seen = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (e) {}
    const out = [];
    const isStaff = user.role === 'admin' || user.role === 'treasurer';
    if (isStaff) {
      this.pendingUsers(data).forEach((u) => {
        const k = `req:${u.username}:${u.fixedRequestAt || ''}`;
        if (seen[k]) return;
        seen[k] = now;
        out.push({ type: 'request', title: `🪪 Yêu cầu thành viên cố định: ${u.name}`, body: 'Vào mục Thành viên để duyệt.', toast: 'info' });
      });
    }
    const me = (data.users || []).find((u) => u.username === user.username);
    if (me && (me.fixedRequest === 'approved' || me.fixedRequest === 'rejected') && me.fixedDecidedAt) {
      const k = `res:${me.fixedDecidedAt}`;
      if (!seen[k]) {
        seen[k] = now;
        const ok = me.fixedRequest === 'approved';
        out.push({
          type: ok ? 'approved' : 'rejected',
          title: ok ? '🎉 Bạn đã là thành viên cố định!' : 'Yêu cầu thành viên cố định chưa được duyệt',
          body: ok ? 'Ban quản trị đã duyệt yêu cầu của bạn.' : 'Liên hệ Ban quản trị để biết thêm chi tiết.',
          toast: ok ? 'success' : 'warning'
        });
      }
    }
    try { localStorage.setItem(key, JSON.stringify(seen)); } catch (e) {}
    return out;
  },

  checkNotifications() {
    try {
      const user = AppStorage.getCurrentUser();
      if (!user) return;
      this.collectNew(AppStorage.loadData(), user).slice(0, 5).forEach((n) => {
        if (window.App && App.showToast) App.showToast(`${n.title} — ${n.body}`, n.toast);
        if (window.NotificationModule && NotificationModule._showNotification) {
          NotificationModule._showNotification({ title: n.title, body: n.body, tag: `membership-${n.type}` });
        }
      });
    } catch (e) {
      console.warn('[Membership] Lỗi kiểm tra thông báo:', e);
    }
  }
};

window.MembershipModule = MembershipModule;
