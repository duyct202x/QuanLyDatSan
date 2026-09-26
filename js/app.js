// Main Application Controller & UI Dispatcher for SMASH PRO
// Tích hợp hệ thống xác thực người dùng, phân quyền Admin/Member và đồng bộ Google Drive

const App = {
  currentTab: 'dashboard',
  theme: 'light',
  currentRegisterMethod: 'phone', // 'phone' | 'name'

  init() {
    this.initTheme();
    this.initEventListeners();
    
    // Khởi tạo hệ thống lưu trữ Cloud
    AppStorage.init();

    // Khởi tạo trước ScheduleModule và Dashboard để dữ liệu luôn hiển thị ngay từ lần đầu
    if (window.ScheduleModule) {
      ScheduleModule.init();
    }

    // Đọc URL hash nếu có (ví dụ: #schedule, #dashboard)
    let initialTab = 'dashboard';
    const hash = window.location.hash.replace('#', '');
    if (hash && ['dashboard', 'schedule', 'fund', 'cashbook', 'bill-splitter', 'register-member', 'settings'].includes(hash)) {
      initialTab = hash;
    }

    // Kiểm tra trạng thái đăng nhập
    if (!AppStorage.isLoggedIn()) {
      this.renderUserHeaderAndSidebar();
      this.showAuthModal('login');
      this.renderTabContent(initialTab);
    } else {
      this.closeAuthModal();
      this.renderUserHeaderAndSidebar();
      this.refreshDashboardStats();
      this.openTab(initialTab);
    }

    // Thiết lập đồng bộ ngầm định kỳ mỗi 30 giây
    setInterval(() => {
      if (AppStorage.isLoggedIn()) {
        AppStorage.pullFromCloud(false);
      }
    }, 30000);

    // Cập nhật đồng hồ đếm ngược mỗi 60 giây
    setInterval(() => {
      if (this.currentTab === 'schedule' || this.currentTab === 'dashboard') {
        if (window.ScheduleModule) {
          ScheduleModule.renderSessions("sessions-container", "upcoming");
          ScheduleModule.renderSessions("dashboard-sessions-preview", "upcoming");
        }
      }
    }, 60000);
  },

  initTheme() {
    const savedTheme = localStorage.getItem('smash_pro_theme') || 'light';
    this.setTheme(savedTheme);
  },

  setTheme(theme) {
    this.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('smash_pro_theme', theme);
    const themeIcon = document.getElementById('theme-toggle-icon');
    if (themeIcon) {
      themeIcon.className = theme === 'light' ? 'fas fa-moon' : 'fas fa-sun';
    }
  },

  toggleTheme() {
    this.setTheme(this.theme === 'light' ? 'dark' : 'light');
  },

  initEventListeners() {
    // Navigation Tabs
    document.querySelectorAll('[data-tab]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const tabId = el.getAttribute('data-tab');
        this.openTab(tabId);
        document.getElementById('sidebar')?.classList.remove('open');
        document.getElementById('sidebar-backdrop')?.classList.remove('active');
      });
    });

    // Mobile Sidebar
    document.getElementById('mobile-menu-toggle')?.addEventListener('click', () => {
      const sidebar = document.getElementById('sidebar');
      const backdrop = document.getElementById('sidebar-backdrop');
      if (sidebar) {
        sidebar.classList.toggle('open');
        if (backdrop) backdrop.classList.toggle('active', sidebar.classList.contains('open'));
      }
    });

    // Modal Background Close
    document.getElementById('global-modal-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'global-modal-overlay') {
        this.closeModal();
      }
    });

    // Lắng nghe thay đổi trạng thái CSDL
    window.addEventListener('app-state-changed', () => {
      this.refreshDashboardStats();
      this.renderUserHeaderAndSidebar();
      if (window.ScheduleModule) {
        const sessions = AppStorage.loadData().sessions || [];
        ScheduleModule.updateScheduleOverviewStats(sessions);
        if (ScheduleModule.currentViewMode === 'calendar') {
          ScheduleModule.renderMonthCalendar();
        } else {
          ScheduleModule.renderSessions("sessions-container", ScheduleModule.currentFilter || 'upcoming');
        }
        ScheduleModule.renderSessions("schedule-upcoming-list", ScheduleModule.currentFilter || 'upcoming');
        ScheduleModule.renderSessions("dashboard-sessions-preview", "upcoming");
      }
    });
  },

  // ==========================================
  // HỆ THỐNG XÁC THỰC GIAO DIỆN (AUTH MODAL)
  // ==========================================

  showAuthModal(tab = 'login') {
    const overlay = document.getElementById('auth-modal-overlay');
    if (overlay) {
      overlay.classList.add('active');
      this.switchAuthTab(tab);
    }
  },

  closeAuthModal() {
    if (!AppStorage.isLoggedIn()) return; // Không đóng nếu chưa đăng nhập
    const overlay = document.getElementById('auth-modal-overlay');
    if (overlay) {
      overlay.classList.remove('active');
    }
  },

  switchAuthTab(tab) {
    const tabLoginBtn = document.getElementById('auth-tab-login');
    const tabRegBtn = document.getElementById('auth-tab-register');
    const formLogin = document.getElementById('auth-login-form');
    const formReg = document.getElementById('auth-register-form');

    if (tab === 'login') {
      tabLoginBtn?.classList.add('active');
      tabRegBtn?.classList.remove('active');
      if (formLogin) formLogin.style.display = 'block';
      if (formReg) formReg.style.display = 'none';
      setTimeout(() => document.getElementById('auth-login-username')?.focus(), 150);
    } else {
      tabRegBtn?.classList.add('active');
      tabLoginBtn?.classList.remove('active');
      if (formLogin) formLogin.style.display = 'none';
      if (formReg) formReg.style.display = 'block';
      setTimeout(() => document.getElementById('auth-reg-name')?.focus(), 150);
    }
  },

  setRegisterMethod(method) {
    this.currentRegisterMethod = method;
  },

  handleNameInputForUsername(name) {
  },

  validatePasswordStrength(pwd) {
    this.validatePasswordPolicy();
  },

  validatePasswordPolicy() {
    const pwd = document.getElementById('auth-reg-password')?.value || '';
    const confirm = document.getElementById('auth-reg-confirm-password')?.value || '';
    
    const lenCheck = document.getElementById('pwd-len-check');
    const spaceCheck = document.getElementById('pwd-space-check');
    const matchText = document.getElementById('auth-pwd-match-text');

    if (lenCheck) {
      if (!pwd) {
        lenCheck.className = 'pwd-indicator';
        lenCheck.innerHTML = '<i class="fas fa-circle-notch"></i> Tối thiểu từ 6 ký tự trở lên';
      } else if (pwd.length >= 6) {
        lenCheck.className = 'pwd-indicator valid';
        lenCheck.innerHTML = '<i class="fas fa-check-circle"></i> Tối thiểu từ 6 ký tự (Đạt)';
      } else {
        lenCheck.className = 'pwd-indicator invalid';
        lenCheck.innerHTML = `<i class="fas fa-times-circle"></i> Tối thiểu từ 6 ký tự (Hiện có ${pwd.length}/6)`;
      }
    }

    if (spaceCheck) {
      if (!pwd) {
        spaceCheck.className = 'pwd-indicator';
        spaceCheck.innerHTML = '<i class="fas fa-circle-notch"></i> Không chứa khoảng trắng (dấu cách)';
      } else if (!/\s/.test(pwd)) {
        spaceCheck.className = 'pwd-indicator valid';
        spaceCheck.innerHTML = '<i class="fas fa-check-circle"></i> Không chứa khoảng trắng (Đạt)';
      } else {
        spaceCheck.className = 'pwd-indicator invalid';
        spaceCheck.innerHTML = '<i class="fas fa-times-circle"></i> Không được chứa khoảng trắng!';
      }
    }

    if (matchText) {
      if (!confirm) {
        matchText.innerHTML = '';
      } else if (pwd && pwd === confirm) {
        matchText.innerHTML = '<span style="color: var(--success); font-weight: 600;"><i class="fas fa-check-circle"></i> Mật khẩu xác nhận khớp hoàn toàn</span>';
      } else {
        matchText.innerHTML = '<span style="color: var(--danger); font-weight: 600;"><i class="fas fa-times-circle"></i> Mật khẩu xác nhận chưa khớp!</span>';
      }
    }
  },

  validatePasswordMatch() {
    this.validatePasswordPolicy();
  },

  togglePasswordVisibility(inputId, btn) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    btn.innerHTML = isPassword ? '<i class="fas fa-eye-slash"></i>' : '<i class="fas fa-eye"></i>';
  },

  handleLogin(event) {
    event.preventDefault();
    const usernameInput = document.getElementById('auth-login-username')?.value;
    const passwordInput = document.getElementById('auth-login-password')?.value;
    const remember = document.getElementById('auth-login-remember')?.checked ?? true;

    const result = AppStorage.login(usernameInput, passwordInput, remember);
    if (result.success) {
      this.closeAuthModal();
      this.renderUserHeaderAndSidebar();
      this.refreshDashboardStats();
      this.openTab('dashboard');
      this.showToast(result.message, "success");
    } else {
      this.showToast(result.message, "error");
    }
  },

  handleRegister(event) {
    event.preventDefault();
    const name = document.getElementById('auth-reg-name')?.value;
    const account = (document.getElementById('auth-reg-account')?.value || "").trim();
    const password = document.getElementById('auth-reg-password')?.value;
    const confirmPassword = document.getElementById('auth-reg-confirm-password')?.value;
    const memberType = document.getElementById('auth-reg-member-type')?.value || 'fixed';
    const remember = document.getElementById('auth-reg-remember')?.checked ?? true;

    const result = AppStorage.register({
      name,
      phone: account,
      usernameInput: account,
      password,
      confirmPassword,
      memberType,
      remember
    });

    if (result.success) {
      this.closeAuthModal();
      this.renderUserHeaderAndSidebar();
      this.refreshDashboardStats();
      this.openTab('dashboard');
      this.showToast(`🎉 ${result.message}`, "success");
    } else {
      this.showToast(result.message, "error");
    }
  },

  logout() {
    AppStorage.logout();
    const loginUser = document.getElementById('auth-login-username');
    const loginPwd = document.getElementById('auth-login-password');
    if (loginUser) loginUser.value = '';
    if (loginPwd) loginPwd.value = '';
    this.renderUserHeaderAndSidebar();
    this.showAuthModal('login');
    this.showToast("Đã đăng xuất tài khoản thành công!", "info");
  },

  // ==========================================
  // ĐIỀU HƯỚNG TABS & PHÂN QUYỀN
  // ==========================================

  openTab(tabId) {
    if (!AppStorage.isLoggedIn()) {
      this.showAuthModal('login');
      return;
    }

    const currentUser = AppStorage.getCurrentUser();
    const isAdmin = currentUser && (currentUser.role === 'admin' || currentUser.role === 'treasurer');

    // Chặn truy cập các Tab quản trị nếu không phải Admin
    if ((tabId === 'bill-splitter' || tabId === 'settings') && !isAdmin) {
      this.showToast("⚠️ Tính năng này chỉ dành riêng cho Ban quản trị CLB!", "warning");
      tabId = 'dashboard';
    }

    this.currentTab = tabId;

    // Cập nhật trạng thái Active trên thanh điều hướng
    document.querySelectorAll('.nav-link, .mobile-bottom-item').forEach(el => {
      if (el.getAttribute('data-tab') === tabId) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    });

    // Hiển thị Tab Pane tương ứng
    document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
    const targetPane = document.getElementById(`tab-${tabId}`);
    if (targetPane) {
      targetPane.classList.add('active');
    }

    // Điều phối Module hiển thị
    this.renderTabContent(tabId);

    window.scrollTo({ top: 0, behavior: 'smooth' });
  },

  renderTabContent(tabId) {
    switch (tabId) {
      case 'dashboard':
        this.renderDashboard();
        break;
      case 'schedule':
        if (window.ScheduleModule) {
          ScheduleModule.init();
        }
        break;
      case 'fund':
        if (window.FundModule) FundModule.renderFundDashboard();
        break;
      case 'cashbook':
        if (window.CashbookModule) CashbookModule.renderCashbook();
        break;
      case 'bill-splitter':
        if (window.BillSplitterModule) BillSplitterModule.init();
        break;
      case 'register-member':
        if (window.SettingsModule) SettingsModule.renderPublicMemberRoster();
        break;
      case 'settings':
        if (window.SettingsModule) SettingsModule.renderSettings();
        break;
    }
  },

  renderDashboard() {
    this.refreshDashboardStats();
    if (window.ScheduleModule) {
      ScheduleModule.renderSessions("dashboard-sessions-preview", "upcoming");
    }
  },

  refreshDashboardStats() {
    const data = AppStorage.loadData();
    const sessions = data.sessions || [];
    const members = data.members || [];
    const fixedMembers = members.filter(m => m.type === 'fixed');
    const dues = data.monthlyContributions || [];
    const currentMonth = "2026-09";
    const txs = data.transactions || [];

    // Số dư quỹ
    let totalIncome = 0;
    let totalExpense = 0;
    txs.forEach(t => {
      if (t.type === 'income') totalIncome += Number(t.amount);
      if (t.type === 'expense') totalExpense += Number(t.amount);
    });
    const fundBalance = totalIncome - totalExpense;

    // Thống kê quỹ tháng
    const monthDues = dues.filter(d => d.month === currentMonth && d.status === 'paid');
    const pendingDues = dues.filter(d => d.month === currentMonth && d.status === 'pending');

    // Buổi đánh tiếp theo
    const upcomingSessions = sessions.filter(s => new Date(`${s.date}T${s.endTime}`) >= new Date())
      .sort((a, b) => new Date(`${a.date}T${a.startTime}`) - new Date(`${b.date}T${b.startTime}`));
    
    const nextSession = upcomingSessions[0];

    // Cập nhật DOM
    const dashBal = document.getElementById('dash-fund-balance');
    if (dashBal) dashBal.innerText = `${fundBalance.toLocaleString('vi-VN')} đ`;

    const dashDues = document.getElementById('dash-paid-members');
    if (dashDues) dashDues.innerText = `${monthDues.length}/${Math.max(1, fixedMembers.length)} thành viên`;

    const dashPending = document.getElementById('dash-pending-dues');
    if (dashPending) dashPending.innerText = `${pendingDues.length} chờ duyệt`;

    const dashNext = document.getElementById('dash-next-session-title');
    const dashNextTime = document.getElementById('dash-next-session-time');
    if (nextSession) {
      if (dashNext) dashNext.innerText = nextSession.title;
      if (dashNextTime) dashNextTime.innerText = `${nextSession.date} lúc ${nextSession.startTime}`;
    } else {
      if (dashNext) dashNext.innerText = "Chưa có lịch";
      if (dashNextTime) dashNextTime.innerText = "Liên hệ admin tạo lịch mới";
    }

    const dashTotalMembers = document.getElementById('dash-total-members');
    if (dashTotalMembers) dashTotalMembers.innerText = `${members.length} người`;

    // Tên CLB
    const clubNameEl = document.getElementById('sidebar-club-name');
    if (clubNameEl && data.clubInfo) clubNameEl.innerText = data.clubInfo.name;
    const clubSloganEl = document.getElementById('sidebar-club-slogan');
    if (clubSloganEl && data.clubInfo) clubSloganEl.innerText = data.clubInfo.slogan;
  },

  renderUserHeaderAndSidebar() {
    const currentUser = AppStorage.getCurrentUser();
    if (!currentUser) {
      document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'none');
      document.querySelectorAll('.member-only').forEach(el => el.style.display = 'none');
      const roleSwitcherBox = document.querySelector('.role-switcher-box');
      if (roleSwitcherBox) roleSwitcherBox.style.display = 'none';
      const userNameEl = document.getElementById('header-user-name');
      if (userNameEl) userNameEl.innerText = 'Chưa đăng nhập';
      const userRoleBadgeEl = document.getElementById('header-user-role');
      if (userRoleBadgeEl) {
        userRoleBadgeEl.innerText = 'Khách';
        userRoleBadgeEl.className = 'badge badge-neutral';
      }
      return;
    }

    const isAdmin = currentUser.role === 'admin' || currentUser.role === 'treasurer';
    const isSuperAdmin = currentUser.role === 'admin';

    // Phân quyền hiển thị Menu Admin / Member
    document.querySelectorAll('.admin-only').forEach(el => {
      el.style.display = isAdmin ? '' : 'none';
    });
    document.querySelectorAll('.member-only').forEach(el => {
      el.style.display = isAdmin ? 'none' : '';
    });

    // Cập nhật Avatar và Tên trên Header
    const userAvatarEl = document.getElementById('header-user-avatar');
    if (userAvatarEl) userAvatarEl.src = currentUser.avatar;
    
    const userNameEl = document.getElementById('header-user-name');
    if (userNameEl) userNameEl.innerText = currentUser.name;

    const userRoleBadgeEl = document.getElementById('header-user-role');
    if (userRoleBadgeEl) {
      userRoleBadgeEl.innerText = currentUser.role === 'admin' ? 'Admin / Chủ CLB' : currentUser.role === 'treasurer' ? 'Thủ quỹ CLB' : 'Thành viên';
      userRoleBadgeEl.className = `badge ${currentUser.role === 'admin' ? 'badge-warning' : currentUser.role === 'treasurer' ? 'badge-info' : 'badge-neutral'}`;
    }

    // Role Switcher ở Sidebar: CHỈ HIỂN THỊ KHI LÀ ADMIN (để admin test các vai trò khác)
    const roleSwitcherBox = document.querySelector('.role-switcher-box');
    const roleSelect = document.getElementById('user-role-select');
    
    if (roleSwitcherBox) {
      if (isSuperAdmin) {
        roleSwitcherBox.style.display = 'block';
        const data = AppStorage.loadData();
        const users = data.users || [];
        if (roleSelect) {
          roleSelect.innerHTML = users.map(u => `
            <option value="${u.id}" ${u.id === currentUser.id ? 'selected' : ''}>
              ${u.name} (${u.role === 'admin' ? '👑 Admin' : u.role === 'treasurer' ? '💼 Thủ quỹ' : '🏸 Member'})
            </option>
          `).join('');
        }
      } else {
        // Ẩn hoàn toàn role switcher với người dùng bình thường để bảo mật
        roleSwitcherBox.style.display = 'none';
      }
    }
  },

  switchUser(userId) {
    const data = AppStorage.loadData();
    const targetUser = (data.users || []).find(u => u.id === userId);
    if (!targetUser) return;

    data.currentUser = JSON.parse(JSON.stringify(targetUser));
    AppStorage.saveData(data, false);
    
    // Cập nhật session
    const sessionData = {
      id: targetUser.id,
      username: targetUser.username,
      name: targetUser.name,
      role: targetUser.role,
      memberId: targetUser.memberId,
      loginAt: new Date().toISOString()
    };
    localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(sessionData));

    this.renderUserHeaderAndSidebar();
    this.showToast(`Đã chuyển vai trò kiểm thử: ${targetUser.name}`, "info");
    this.openTab(this.currentTab);
  },

  // Modal dùng chung
  openModal(title, contentHtml, isLarge = false) {
    const overlay = document.getElementById('global-modal-overlay');
    const titleEl = document.getElementById('global-modal-title');
    const bodyEl = document.getElementById('global-modal-body');
    const dialogEl = document.getElementById('global-modal-dialog');

    if (titleEl) titleEl.innerHTML = title;
    if (bodyEl) bodyEl.innerHTML = contentHtml;
    if (dialogEl) {
      if (isLarge) dialogEl.classList.add('modal-lg');
      else dialogEl.classList.remove('modal-lg');
    }
    if (overlay) overlay.classList.add('active');
  },

  closeModal() {
    const overlay = document.getElementById('global-modal-overlay');
    if (overlay) overlay.classList.remove('active');
  },

  // Toast Notifications
  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let iconClass = 'fa-info-circle text-primary';
    if (type === 'success') iconClass = 'fa-check-circle text-primary';
    if (type === 'error') iconClass = 'fa-times-circle text-danger';
    if (type === 'warning') iconClass = 'fa-exclamation-triangle text-warning';

    toast.innerHTML = `
      <i class="fas ${iconClass}" style="font-size: 1.25rem; margin-top: 0.1rem; flex-shrink: 0;"></i>
      <div style="flex: 1; font-size: 0.92rem; font-weight: 500; color: var(--text-main); line-height: 1.45;">${message}</div>
      <button style="background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 1.15rem; padding: 0 0.25rem; line-height: 1;" onclick="this.parentElement.remove()" title="Đóng">&times;</button>
    `;

    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      setTimeout(() => toast.remove(), 300);
    }, 4500);
  }
};

// Khởi chạy ứng dụng
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});

window.App = App;
