// GoogleAuth - Đăng nhập / đăng ký / liên kết tài khoản bằng Google (Google Identity Services)
// - Trình duyệt chỉ lấy ID token từ Google rồi gửi lên máy chủ; máy chủ xác minh với Google và cấp phiên như đăng nhập thường.
// - Tài khoản cũ chỉ liên kết CHỦ ĐỘNG trong Hồ sơ cá nhân khi đang đăng nhập (không tự gộp theo email).
// - Chế độ chạy cục bộ (không có máy chủ) không hỗ trợ đăng nhập Google.
const GoogleAuth = {
  CLIENT_ID: '835885994516-bvdlen23vircg4tmvfj18msrssf0r43u.apps.googleusercontent.com',
  SCRIPT_URL: 'https://accounts.google.com/gsi/client',
  _mode: 'login',
  _ready: false,
  _loading: null,
  _pendingCredential: null,

  available() {
    return !!this.CLIENT_ID && !AppStorage.isLocalOnly();
  },

  _load() {
    if (window.google && google.accounts && google.accounts.id) return Promise.resolve();
    if (this._loading) return this._loading;
    this._loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = this.SCRIPT_URL;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { this._loading = null; reject(new Error('Không tải được Google Sign-In')); };
      document.head.appendChild(s);
    });
    return this._loading;
  },

  async _init() {
    await this._load();
    if (this._ready) return;
    google.accounts.id.initialize({
      client_id: this.CLIENT_ID,
      callback: (resp) => this._onCredential(resp),
      auto_select: false,
      cancel_on_tap_outside: true,
      ux_mode: 'popup'
    });
    this._ready = true;
  },

  // Vẽ nút Google vào các phần tử; mode: 'login' (đăng nhập/đăng ký) | 'link' (liên kết trong Hồ sơ)
  async renderButtons(ids, mode, text = 'continue_with') {
    const els = ids.map((id) => document.getElementById(id)).filter(Boolean);
    const wraps = els.map((el) => el.closest('[data-google-wrap]') || el);
    if (!this.available()) {
      wraps.forEach((w) => { w.style.display = 'none'; });
      return false;
    }
    try {
      await this._init();
    } catch (e) {
      els.forEach((el) => { el.innerHTML = '<span class="text-secondary" style="font-size: 0.8rem;">Không tải được nút Google (kiểm tra mạng).</span>'; });
      return false;
    }
    this._mode = mode;
    const dark = document.documentElement.getAttribute('data-theme') === 'dark' || document.body.classList.contains('dark-theme');
    els.forEach((el) => {
      el.innerHTML = '';
      google.accounts.id.renderButton(el, {
        type: 'standard', theme: dark ? 'filled_black' : 'outline', size: 'large', shape: 'pill',
        text, logo_alignment: 'center', locale: 'vi', width: 300
      });
    });
    wraps.forEach((w) => { w.style.display = ''; });
    return true;
  },

  renderAuthButtons() {
    return this.renderButtons(['google-login-btn', 'google-register-btn'], 'login', 'continue_with');
  },

  async _onCredential(resp) {
    const credential = resp && resp.credential;
    if (!credential) return;
    if (this._mode === 'link') return this._link(credential);
    const remember = document.getElementById('auth-login-remember')?.checked ?? true;
    const res = await AppStorage.googleLogin(credential, remember);
    if (res.success) return App.onLoginSuccess(res);
    if (res.notLinked) return this._offerRegister(credential, res, remember);
    App.showToast(res.message, 'error');
  },

  // Google chưa liên kết: tạo tài khoản mới, hoặc hướng dẫn liên kết với tài khoản cũ
  _offerRegister(credential, res, remember) {
    this._pendingCredential = { credential, remember };
    App.closeAuthModal();
    const body = res.emailInUse ? `
      <p style="font-size: 0.9rem;">${Safe.html(res.message)}</p>
      <ol class="text-secondary" style="font-size: 0.85rem; padding-left: 1.2rem; margin: 0.75rem 0;">
        <li>Đăng nhập bằng tên đăng nhập/SĐT và mật khẩu.</li>
        <li>Mở <b>Hồ sơ cá nhân</b> → <b>Liên kết Google</b>.</li>
      </ol>
      <div class="modal-footer" style="padding: 1rem 0 0 0; display: flex; justify-content: flex-end; gap: 0.5rem;">
        <button type="button" class="btn btn-primary" onclick="App.closeModal(); App.showAuthModal('login')"><i class="fas fa-sign-in-alt"></i> Đăng nhập bằng mật khẩu</button>
      </div>` : `
      <p style="font-size: 0.9rem; margin-bottom: 0.75rem;">Tài khoản Google <b>${Safe.html(res.email)}</b> chưa có trong CLB.</p>
      <div style="display: grid; gap: 0.75rem;">
        <div style="border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 0.85rem;">
          <div class="font-bold" style="margin-bottom: 0.4rem;"><i class="fas fa-user-plus text-primary"></i> Tạo tài khoản mới bằng Google</div>
          <select id="google-reg-type" class="form-select" style="margin-bottom: 0.5rem;">
            <option value="fixed">🏸 Xin làm thành viên cố định (Ban quản trị duyệt)</option>
            <option value="guest">⚡ Vãng lai</option>
          </select>
          <button type="button" class="btn btn-primary w-full" style="justify-content: center;" onclick="GoogleAuth.confirmRegister()"><i class="fab fa-google"></i> Tạo tài khoản</button>
        </div>
        <div class="text-secondary" style="font-size: 0.82rem;">
          <b>Đã có tài khoản CLB?</b> Đừng tạo mới — hãy <a href="#" onclick="App.closeModal(); App.showAuthModal('login'); return false;">đăng nhập bằng mật khẩu</a>
          rồi vào <b>Hồ sơ cá nhân → Liên kết Google</b>.
        </div>
      </div>`;
    App.openModal('🔐 Đăng nhập bằng Google', body);
  },

  async confirmRegister() {
    const p = this._pendingCredential;
    if (!p) return;
    const type = document.getElementById('google-reg-type')?.value || 'fixed';
    const res = await AppStorage.googleRegister(p.credential, type, p.remember);
    this._pendingCredential = null;
    if (!res.success) {
      App.showToast(res.message, 'error');
      return;
    }
    App.closeModal();
    App.onLoginSuccess(res);
  },

  async _link(credential) {
    const res = await AppStorage.googleLink(credential);
    App.showToast(res.message, res.success ? 'success' : 'error');
    if (res.success && App.openUserProfileModal) App.openUserProfileModal();
  },

  async unlink() {
    if (!(await App.confirm('Hủy liên kết Google? Sau đó bạn chỉ đăng nhập được bằng mật khẩu.'))) return;
    const res = await AppStorage.googleUnlink();
    App.showToast(res.message, res.success ? 'success' : 'error');
    if (res.success && App.openUserProfileModal) App.openUserProfileModal();
  },

  // Khung trong Hồ sơ cá nhân
  renderProfileSection(user) {
    if (!this.available() || !user) return '';
    const linked = user.googleLinked === true;
    return `
        <div style="background: var(--bg-input); padding: 1rem; border-radius: var(--radius-md); border: 1px solid var(--border-color); margin-top: 1rem;">
          <div style="font-weight: 700; font-size: 0.88rem; margin-bottom: 0.4rem; display: flex; align-items: center; gap: 0.4rem;">
            <i class="fab fa-google text-primary"></i> Đăng nhập bằng Google
          </div>
          ${linked ? `
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; flex-wrap: wrap; font-size: 0.85rem;">
            <span>✅ Đã liên kết: <b>${Safe.html(user.googleEmail || '')}</b></span>
            <button type="button" class="btn btn-secondary btn-sm" onclick="GoogleAuth.unlink()" ${user.googleOnly ? 'disabled title="Hãy đặt mật khẩu trước khi hủy liên kết"' : ''}>Hủy liên kết</button>
          </div>
          ${user.googleOnly ? '<div class="text-secondary" style="font-size: 0.76rem; margin-top: 0.35rem;">Tài khoản tạo bằng Google, chưa có mật khẩu. Có thể đặt mật khẩu ở dưới để đăng nhập cả hai cách.</div>' : ''}` : `
          <div class="text-secondary" style="font-size: 0.76rem; margin-bottom: 0.6rem;">Liên kết tài khoản Google của bạn để lần sau đăng nhập bằng một chạm (không cần nhớ mật khẩu).</div>
          <div id="google-link-btn" style="min-height: 44px;"></div>`}
        </div>`;
  }
};

window.GoogleAuth = GoogleAuth;
