// PushClient - Đăng ký thiết bị nhận thông báo đẩy (Web Push qua Firebase Cloud Messaging).
// Luồng: thành viên bật -> trình duyệt cấp quyền + mã thiết bị (FCM token) -> máy chủ lưu mã vào hồ sơ (bí mật, không trả lại).
// Khi có sự kiện (mở vote, đặt/hủy sân, nhắc giờ...) máy chủ gửi tới mã đó; Service Worker (sw.js) hiện thông báo kể cả khi đã đóng ứng dụng.
// Cấu hình web Firebase do Ban quản trị điền ở Cài đặt CLB (clubInfo.pushConfig); khóa gửi nằm trên máy chủ (không bao giờ ở đây).
const PushClient = {
  FIREBASE_VERSION: '10.12.2',
  LS_KEY: 'SMASH_PRO_PUSH_V1', // { token, user } của thiết bị này
  _loading: null,
  _messaging: null,
  _debounce: null,
  busy: false,

  // ---------------- Trạng thái ----------------
  config() {
    const c = (AppStorage.loadData().clubInfo || {}).pushConfig;
    return c && c.apiKey && c.projectId && c.messagingSenderId && c.appId && c.vapidKey ? c : null;
  },

  clubEnabled() {
    const p = (AppStorage.loadData().clubInfo || {}).pushNotify;
    return !!(p && p.enabled);
  },

  isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  },

  isStandalone() {
    return !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  },

  permission() {
    return 'Notification' in window ? Notification.permission : 'unsupported';
  },

  // Thiết bị/trình duyệt này có dùng được thông báo đẩy không (kèm lý do nếu không)
  support() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      return { ok: false, reason: this.isIOS() && !this.isStandalone()
        ? 'Trên iPhone/iPad, hãy thêm ứng dụng vào Màn hình chính (nút Chia sẻ → Thêm vào MH chính) rồi mở từ biểu tượng đó.'
        : 'Trình duyệt này không hỗ trợ thông báo đẩy.' };
    }
    if (this.isIOS() && !this.isStandalone()) {
      return { ok: false, reason: 'Trên iPhone/iPad, hãy thêm ứng dụng vào Màn hình chính (nút Chia sẻ → Thêm vào MH chính) rồi mở từ biểu tượng đó.' };
    }
    return { ok: true, reason: '' };
  },

  stored() {
    try { return JSON.parse(localStorage.getItem(this.LS_KEY) || 'null'); } catch (e) { return null; }
  },

  setStored(v) {
    try { if (v) localStorage.setItem(this.LS_KEY, JSON.stringify(v)); else localStorage.removeItem(this.LS_KEY); } catch (e) {}
  },

  // Thiết bị này đang nhận đẩy cho tài khoản hiện tại?
  isOn() {
    const u = AppStorage.getCurrentUser();
    const s = this.stored();
    return !!(u && s && s.token && s.user === u.username && this.permission() === 'granted');
  },

  // ---------------- Firebase ----------------
  FIREBASE_SRI: {
    '10.12.2': {
      'firebase-app-compat.js': 'sha384-AQ3POAMqIhwS81FrUH95ekxqBZHeP5tG2JfEL3+7GuTtfRLWnrRh32UxwzM+//A9',
      'firebase-messaging-compat.js': 'sha384-XtSlZdmg0Ad5zf0AX4W9TGdm+dGjaNK4KG3lNFjfgbnxkCEuT9ugWXkLExgQTJ+6'
    }
  },

  _script(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      const sri = (this.FIREBASE_SRI[this.FIREBASE_VERSION] || {})[src.split('/').pop()];
      if (sri) { el.integrity = sri; el.crossOrigin = 'anonymous'; }
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error('Không tải được thư viện thông báo (kiểm tra kết nối mạng)'));
      document.head.appendChild(el);
    });
  },

  async loadFirebase() {
    if (window.firebase && window.firebase.messaging) return;
    if (!this._loading) {
      const base = `https://www.gstatic.com/firebasejs/${this.FIREBASE_VERSION}`;
      this._loading = this._script(`${base}/firebase-app-compat.js`)
        .then(() => this._script(`${base}/firebase-messaging-compat.js`))
        .catch((e) => { this._loading = null; throw e; });
    }
    await this._loading;
  },

  async _getToken() {
    const cfg = this.config();
    if (!cfg) throw new Error('Ban quản trị chưa cấu hình thông báo đẩy.');
    await this.loadFirebase();
    if (!(await navigator.serviceWorker.getRegistration())) await navigator.serviceWorker.register('sw.js');
    const reg = await navigator.serviceWorker.ready;
    if (!this._messaging) {
      if (!firebase.apps.length) {
        firebase.initializeApp({ apiKey: cfg.apiKey, authDomain: cfg.authDomain || `${cfg.projectId}.firebaseapp.com`, projectId: cfg.projectId, messagingSenderId: cfg.messagingSenderId, appId: cfg.appId });
      }
      this._messaging = firebase.messaging();
    }
    const token = await this._messaging.getToken({ vapidKey: cfg.vapidKey, serviceWorkerRegistration: reg });
    if (!token) throw new Error('Không lấy được mã thiết bị.');
    return token;
  },

  // ---------------- Bật / tắt ----------------
  async enable() {
    if (this.busy) return { success: false, message: 'Đang xử lý…' };
    const user = AppStorage.getCurrentUser();
    if (!user) return { success: false, message: 'Hãy đăng nhập trước khi bật thông báo đẩy.' };
    if (AppStorage.isLocalOnly()) return { success: false, message: 'Chế độ chạy cục bộ không hỗ trợ thông báo đẩy.' };
    const sup = this.support();
    if (!sup.ok) return { success: false, message: sup.reason };
    if (!this.config()) return { success: false, message: 'Ban quản trị chưa cấu hình thông báo đẩy cho CLB.' };
    this.busy = true;
    try {
      let perm = this.permission();
      if (perm === 'default') perm = await Notification.requestPermission();
      if (perm !== 'granted') return { success: false, message: perm === 'denied' ? 'Bạn đã chặn thông báo. Vào cài đặt trình duyệt/trang web để cấp lại quyền.' : 'Chưa được cấp quyền thông báo.' };
      const deviceToken = await this._getToken();
      const session = AppStorage._readSession();
      const res = await AppStorage._authRequest({ action: 'pushRegister', token: session && session.token, deviceToken, ua: this._uaLabel() });
      if (res.status !== 'ok') return { success: false, message: res.message || 'Máy chủ không đăng ký được thiết bị.' };
      this.setStored({ token: deviceToken, user: user.username });
      try { localStorage.setItem('SMASH_PRO_NOTIF_ENABLED', '1'); } catch (e) {}
      return { success: true, message: res.configured ? 'Đã bật thông báo đẩy trên thiết bị này.' : 'Đã đăng ký thiết bị, nhưng máy chủ chưa có khóa gửi Firebase nên chưa nhận được thông báo.' };
    } catch (e) {
      console.warn('[PushClient] Lỗi bật thông báo đẩy:', e);
      return { success: false, message: e.message || 'Không bật được thông báo đẩy.' };
    } finally {
      this.busy = false;
    }
  },

  async disable() {
    const s = this.stored();
    const session = AppStorage._readSession();
    this.setStored(null);
    if (s && s.token && session && session.token) {
      try { await AppStorage._authRequest({ action: 'pushUnregister', token: session.token, deviceToken: s.token }); } catch (e) {}
    }
    try { if (this._messaging) await this._messaging.deleteToken(); } catch (e) {}
    return { success: true, message: 'Đã tắt thông báo đẩy trên thiết bị này.' };
  },

  // Gọi trước khi đăng xuất: thiết bị này không nhận thông báo của tài khoản vừa thoát nữa
  onBeforeLogout(session) {
    const s = this.stored();
    if (!s || !s.token) return;
    this.setStored(null);
    if (session && session.token && !AppStorage.isLocalOnly()) {
      AppStorage._authRequest({ action: 'pushUnregister', token: session.token, deviceToken: s.token }).catch(() => {});
    }
  },

  // Mã thiết bị có thể đổi: nếu người dùng đã bật trước đó thì cập nhật âm thầm (không hỏi lại quyền)
  async refresh() {
    const u = AppStorage.getCurrentUser();
    const s = this.stored();
    if (!u || !s || s.user !== u.username || this.permission() !== 'granted' || !this.config() || AppStorage.isLocalOnly() || this.busy) return;
    try {
      const token = await this._getToken();
      if (token !== s.token) {
        const session = AppStorage._readSession();
        const res = await AppStorage._authRequest({ action: 'pushRegister', token: session && session.token, deviceToken: token, ua: this._uaLabel() });
        if (res.status === 'ok') {
          this.setStored({ token, user: u.username });
          // Gỡ mã cũ của chính thiết bị này để không nhận thông báo trùng
          await AppStorage._authRequest({ action: 'pushUnregister', token: session && session.token, deviceToken: s.token });
        }
      }
    } catch (e) {
      console.info('[PushClient] Chưa làm mới được mã thiết bị:', e.message);
    }
  },

  _uaLabel() {
    const ua = navigator.userAgent;
    const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
    const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
    return `${br} ${os}`.trim();
  },

  init() {
    // Thông báo từ Service Worker khi có tin đẩy: đồng bộ ngay để dữ liệu mới hiện lên liền
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'PUSH_RECEIVED' && AppStorage.requestSync) AppStorage.requestSync(0);
      });
    }
    window.addEventListener('app-state-changed', () => {
      clearTimeout(this._debounce);
      this._debounce = setTimeout(() => this.refresh(), 3000);
    });
    setTimeout(() => this.refresh(), 4000);
  },

  // ---------------- Giao diện ----------------
  // Khung trong Hồ sơ cá nhân
  renderProfileSection(user) {
    if (!user || AppStorage.isLocalOnly()) return '';
    const sup = this.support();
    let state, action = '';
    if (!this.clubEnabled() || !this.config()) {
      state = '<span class="text-secondary">Ban quản trị chưa bật thông báo đẩy cho CLB.</span>';
    } else if (!sup.ok) {
      state = `<span class="text-secondary">${Safe.html(sup.reason)}</span>`;
    } else if (this.permission() === 'denied') {
      state = '<span class="text-secondary">⚠️ Bạn đã chặn thông báo. Hãy cấp lại quyền trong cài đặt trình duyệt.</span>';
    } else if (this.isOn()) {
      state = '✅ Thiết bị này <b>đang nhận</b> thông báo đẩy (mở vote, đặt/hủy sân, nhắc giờ…).';
      action = `<button type="button" class="btn btn-secondary btn-sm" onclick="PushClient.toggleFromUI(false)">Tắt trên thiết bị này</button>
                <button type="button" class="btn btn-secondary btn-sm" onclick="PushClient.sendTest()"><i class="fas fa-paper-plane"></i> Gửi thử</button>`;
    } else {
      state = 'Nhận thông báo ngay trên điện thoại/máy tính, kể cả khi đã đóng ứng dụng.';
      action = `<button type="button" class="btn btn-primary btn-sm" onclick="PushClient.toggleFromUI(true)"><i class="fas fa-bell"></i> Bật thông báo đẩy</button>`;
    }
    return `
        <div style="background: var(--bg-input); padding: 1rem; border-radius: var(--radius-md); border: 1px solid var(--border-color); margin-top: 1rem;">
          <div style="font-weight: 700; font-size: 0.88rem; margin-bottom: 0.4rem; display: flex; align-items: center; gap: 0.4rem;">
            <i class="fas fa-bell text-primary"></i> Thông báo đẩy
          </div>
          <div id="push-profile-state" style="font-size: 0.82rem; margin-bottom: ${action ? '0.6rem' : '0'};">${state}</div>
          ${action ? `<div class="flex" style="gap: 0.4rem; flex-wrap: wrap;">${action}</div>` : ''}
        </div>`;
  },

  async toggleFromUI(on) {
    const el = document.getElementById('push-profile-state');
    if (el) el.textContent = 'Đang xử lý…';
    const res = on ? await this.enable() : await this.disable();
    App.showToast(res.message, res.success ? 'success' : 'warning');
    if (window.NotificationModule) NotificationModule.renderNotifToggleBtn();
    if (App.openUserProfileModal && document.getElementById('push-profile-state')) App.openUserProfileModal();
  },

  async sendTest() {
    const session = AppStorage._readSession();
    const res = await AppStorage._authRequest({ action: 'pushTest', token: session && session.token });
    App.showToast(res.status === 'ok' ? `📨 Đã gửi thử tới ${res.sent} thiết bị. Thông báo sẽ hiện trong vài giây.` : (res.message || 'Không gửi thử được.'), res.status === 'ok' ? 'success' : 'warning');
  }
};

window.PushClient = PushClient;
