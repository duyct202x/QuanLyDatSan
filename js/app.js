// Main Application Controller & UI Dispatcher for SMASH PRO
// Tích hợp hệ thống xác thực người dùng, phân quyền Admin/Member và đồng bộ Google Drive

const App = {
  currentTab: 'dashboard',
  theme: 'light',
  currentRegisterMethod: 'phone', // 'phone' | 'name'
  wasLoggedIn: false,
  lastActivityTouch: 0,

  init() {
    this.initTheme();
    this.initEventListeners();
    this.initActivityTracker();
    
    // Khởi tạo hệ thống lưu trữ Cloud
    AppStorage.init();

    // Khởi tạo trước ScheduleModule để dữ liệu lịch luôn hiển thị ngay từ lần đầu
    if (window.ScheduleModule) {
      ScheduleModule.init();
    }

    // Đọc URL hash nếu có (ví dụ: #schedule, #members, #dashboard)
    let initialTab = 'dashboard';
    const hash = window.location.hash.replace('#', '');
    if (hash && ['dashboard', 'schedule', 'members', 'fund', 'cashbook', 'bill-splitter', 'register-member', 'settings'].includes(hash)) {
      initialTab = hash === 'register-member' ? 'members' : hash;
    }

    // Nếu vào thẳng tab Settings mà không phải Admin -> chuyển về Dashboard
    if (initialTab === 'settings' && !AppStorage.isAdmin()) {
      initialTab = 'dashboard';
    }

    // Khởi tạo giao diện người dùng (Khách vãng lai hoặc User đã đăng nhập)
    this.renderUserHeaderAndSidebar();
    this.refreshDashboardStats();
    this.openTab(initialTab);

    // Thiết lập đồng bộ ngầm định kỳ mỗi 30 giây (chỉ khi có phiên đăng nhập)
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

  initEventListeners() {
    window.addEventListener("app-state-changed", (e) => {
      this.refreshDashboardStats();
      this.renderUserHeaderAndSidebar();
      if (window.MembersModule && typeof MembersModule.renderBenefitsAndRules === 'function') {
        MembersModule.renderBenefitsAndRules();
      }
      if (window.MembersModule && typeof MembersModule.renderMembersTab === 'function' && this.currentTab === 'members') {
        MembersModule.renderMembersTab();
      }
    });
  },

  initActivityTracker() {
    this.wasLoggedIn = AppStorage.isLoggedIn();

    const onUserActivity = () => {
      const now = Date.now();
      if (now - this.lastActivityTouch > 10000) { // Throttle 10 giây
        this.lastActivityTouch = now;
        AppStorage.touchActivity();
      }
    };

    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'].forEach(evt => {
      window.addEventListener(evt, onUserActivity, { passive: true });
    });

    // Inactivity Watchdog: Tự động kiểm tra trạng thái hết hạn mỗi 10 giây
    setInterval(() => {
      const currentlyLoggedIn = AppStorage.isLoggedIn();
      if (this.wasLoggedIn && !currentlyLoggedIn) {
        this.wasLoggedIn = false;
        this.handleSessionExpired();
      } else if (currentlyLoggedIn) {
        this.wasLoggedIn = true;
      }
    }, 10000);
  },

  handleSessionExpired() {
    this.renderUserHeaderAndSidebar();
    this.showToast("⚠️ Phiên đăng nhập đã tự động kết thúc do không hoạt động (15 phút). Bạn đang ở chế độ Khách vãng lai.", "warning");
    if (this.currentTab === 'settings') {
      this.openTab('dashboard');
    }
  },

  initTheme() {
    const currentUser = AppStorage.getCurrentUser();
    let initialTheme = 'light';
    if (currentUser) {
      initialTheme = currentUser.themePreference || localStorage.getItem(`smash_pro_theme_${currentUser.id}`) || localStorage.getItem('smash_pro_theme') || 'light';
    } else {
      initialTheme = localStorage.getItem('smash_pro_theme_guest') || localStorage.getItem('smash_pro_theme') || 'light';
    }
    this.setTheme(initialTheme, false);
  },

  setTheme(theme, persistToUser = true) {
    this.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('smash_pro_theme', theme);

    const currentUser = AppStorage.getCurrentUser();
    if (!currentUser) {
      localStorage.setItem('smash_pro_theme_guest', theme);
    } else {
      localStorage.setItem(`smash_pro_theme_${currentUser.id}`, theme);
    }

    const themeIcon = document.getElementById('theme-toggle-icon');
    const themeBtn = themeIcon ? themeIcon.closest('button') : null;
    if (themeIcon) {
      themeIcon.className = theme === 'light' ? 'fas fa-moon' : 'fas fa-sun';
    }
    if (themeBtn) {
      themeBtn.title = theme === 'light' ? 'Chuyển sang giao diện Tối (Dark Mode)' : 'Chuyển sang giao diện Sáng (Light Mode)';
    }

    // Cá nhân hóa lưu vào tài khoản & đồng bộ Cloud
    if (persistToUser && currentUser) {
      const data = AppStorage.loadData();
      let updated = false;
      if (data.users) {
        const u = data.users.find(x => x.id === currentUser.id);
        if (u) {
          u.themePreference = theme;
          updated = true;
        }
      }
      if (data.currentUser && data.currentUser.id === currentUser.id) {
        data.currentUser.themePreference = theme;
        updated = true;
      }
      if (updated) {
        AppStorage.saveData(data, true);
      }
    }
  },

  toggleTheme() {
    const nextTheme = this.theme === 'light' ? 'dark' : 'light';
    this.setTheme(nextTheme, true);
    this.showToast(
      nextTheme === 'dark' 
        ? '🌙 Đã chuyển sang giao diện Tối & lưu tùy chọn cá nhân' 
        : '☀️ Đã chuyển sang giao diện Sáng & lưu tùy chọn cá nhân',
      'info'
    );
  },

  applyUserTheme(user) {
    if (!user) {
      const guestTheme = localStorage.getItem('smash_pro_theme_guest') || localStorage.getItem('smash_pro_theme') || 'light';
      this.setTheme(guestTheme, false);
      return;
    }
    const userTheme = user.themePreference || localStorage.getItem(`smash_pro_theme_${user.id}`) || 'light';
    this.setTheme(userTheme, false);
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
      if (this.currentTab === 'members' && window.MembersModule) {
        MembersModule.renderMembersTab();
      }
      if (this.currentTab === 'fund' && window.FundModule) {
        FundModule.renderFundDashboard();
      }
      if (this.currentTab === 'cashbook' && window.CashbookModule) {
        CashbookModule.renderCashbook();
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
    const remember = document.getElementById('auth-login-remember')?.checked ?? false;

    const result = AppStorage.login(usernameInput, passwordInput, remember);
    if (result.success) {
      this.wasLoggedIn = true;
      this.applyUserTheme(result.user);
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
    const remember = document.getElementById('auth-reg-remember')?.checked ?? false;

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
      this.wasLoggedIn = true;
      if (result.user) {
        this.applyUserTheme(result.user);
      }
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
    AppStorage.logout(true);
    this.wasLoggedIn = false;
    const loginUser = document.getElementById('auth-login-username');
    const loginPwd = document.getElementById('auth-login-password');
    if (loginUser) loginUser.value = '';
    if (loginPwd) loginPwd.value = '';
    this.renderUserHeaderAndSidebar();
    if (this.currentTab === 'settings') {
      this.openTab('dashboard');
    }
    this.applyUserTheme(null);
    this.showToast("Đã đăng xuất tài khoản thành công! Bạn đang ở chế độ Khách vãng lai.", "info");
  },

  // ==========================================
  // ĐIỀU HƯỚNG TABS & PHÂN QUYỀN
  // ==========================================

  openTab(tabId) {
    const isAdmin = AppStorage.isAdmin();
    const isGuest = AppStorage.isGuest();

    // 1. Chặn các tab Quản trị nếu không phải Admin
    if ((tabId === 'settings' || tabId === 'bill-splitter') && !isAdmin) {
      this.showToast("⚠️ Chức năng này chỉ dành cho Ban quản trị CLB. Vui lòng đăng nhập Admin!", "warning");
      this.showAuthModal('login');
      return;
    }

    // 2. Chặn các tab Tài chính & Quỹ đối với Khách / Thành viên vãng lai
    if ((tabId === 'fund' || tabId === 'cashbook') && isGuest) {
      this.showToast("⚠️ Sổ thu chi và Quỹ CLB chỉ dành cho Thành viên chính thức hoặc Ban Quản trị. Khách vãng lai vui lòng xem Lịch đặt sân & Điều khoản CLB!", "info");
      this.openTab('schedule');
      return;
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
      case 'members':
        if (window.MembersModule) {
          MembersModule.init();
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
        if (window.MembersModule) {
          MembersModule.switchSubTab('register');
        } else if (window.SettingsModule) {
          SettingsModule.renderPublicMemberRoster();
        }
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

    // Thống kê quỹ tháng (Chỉ tính các thành viên cố định thực sự tồn tại trong danh sách)
    const fixedMemberIds = new Set(fixedMembers.map(m => m.id));
    const validMonthDues = dues.filter(d => d.month === currentMonth && fixedMemberIds.has(d.memberId));
    const monthDuesPaid = validMonthDues.filter(d => d.status === 'paid');
    const pendingDues = validMonthDues.filter(d => d.status === 'pending');

    // Buổi đánh tiếp theo
    const upcomingSessions = sessions.filter(s => new Date(`${s.date}T${s.endTime}`) >= new Date())
      .sort((a, b) => new Date(`${a.date}T${a.startTime}`) - new Date(`${b.date}T${b.startTime}`));
    
    const nextSession = upcomingSessions[0];

    // Cập nhật DOM
    const dashBal = document.getElementById('dash-fund-balance');
    const dashFundStatus = document.getElementById('dash-fund-status');
    if (dashBal) {
      dashBal.innerText = `${fundBalance.toLocaleString('vi-VN')} đ`;
      if (fundBalance < 0) {
        dashBal.style.color = '#ef4444';
      } else {
        dashBal.style.color = '';
      }
    }
    if (dashFundStatus) {
      if (fundBalance > 0) {
        dashFundStatus.className = 'stat-sub text-primary';
        dashFundStatus.innerHTML = '<i class="fas fa-check-circle"></i> Số dư khả dụng';
      } else if (fundBalance === 0) {
        dashFundStatus.className = 'stat-sub text-secondary';
        dashFundStatus.innerHTML = '<i class="fas fa-info-circle"></i> Quỹ cân bằng (0 đ)';
      } else {
        dashFundStatus.className = 'stat-sub text-danger';
        dashFundStatus.innerHTML = `<i class="fas fa-exclamation-triangle"></i> Quỹ đang âm (Cần bù ${Math.abs(fundBalance).toLocaleString('vi-VN')} đ)`;
      }
    }

    const dashDues = document.getElementById('dash-paid-members');
    if (dashDues) {
      const totalFixedCount = fixedMembers.length > 0 ? fixedMembers.length : members.length;
      dashDues.innerText = `${monthDuesPaid.length}/${totalFixedCount} thành viên`;
    }

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

    // Tên CLB & Banner
    const clubInfo = data.clubInfo || {};
    const clubNameEl = document.getElementById('sidebar-club-name');
    if (clubNameEl && clubInfo.name) clubNameEl.innerText = clubInfo.name;
    const clubSloganEl = document.getElementById('sidebar-club-slogan');
    if (clubSloganEl && clubInfo.slogan) clubSloganEl.innerText = clubInfo.slogan;

    // Cập nhật Hero Banner trên Dashboard
    const heroSeasonEl = document.getElementById('dash-hero-season');
    if (heroSeasonEl) {
      heroSeasonEl.innerHTML = `<i class="fas fa-fire"></i> ${clubInfo.season || 'Mùa giải 2026'}`;
    }

    const heroTitleEl = document.getElementById('dash-hero-title');
    if (heroTitleEl) {
      heroTitleEl.innerText = (clubInfo.name || 'SMASH PRO BADMINTON CLUB').toUpperCase();
    }

    const heroSubtitleEl = document.getElementById('dash-hero-subtitle');
    if (heroSubtitleEl) {
      if (clubInfo.bannerSubtitle && clubInfo.bannerSubtitle.trim()) {
        heroSubtitleEl.innerHTML = `<i class="fas fa-map-marker-alt text-primary"></i> ${clubInfo.bannerSubtitle}`;
      } else {
        const courtName = clubInfo.defaultCourt || 'Sân cầu lông Tre Xanh (Sân 3 & 4)';
        const lockHours = clubInfo.voteLockHours || 48;
        const lockDays = Math.round(lockHours / 24);
        const lockText = lockDays > 0 ? `Tự động đóng vote trước giờ đánh ${lockDays} ngày` : `Tự động đóng vote trước giờ đánh ${lockHours} giờ`;
        heroSubtitleEl.innerHTML = `<i class="fas fa-map-marker-alt text-primary"></i> ${courtName} • ${lockText}`;
      }
    }
  },

  renderUserHeaderAndSidebar() {
    const currentUser = AppStorage.getCurrentUser();
    const isAdmin = AppStorage.isAdmin();
    const isFixed = AppStorage.isFixedMember();
    const isGuest = AppStorage.isGuest();

    const userAvatarEl = document.getElementById('header-user-avatar');
    const userNameEl = document.getElementById('header-user-name');
    const userRoleBadgeEl = document.getElementById('header-user-role');
    const headerBtnWrapper = document.getElementById('header-auth-btn-wrapper');
    const sidebarBtnWrapper = document.getElementById('sidebar-auth-btn-wrapper');
    const sidebarUserCard = document.getElementById('sidebar-user-card');
    const sidebarAvatar = document.getElementById('sidebar-user-avatar');
    const sidebarName = document.getElementById('sidebar-user-name');
    const sidebarRole = document.getElementById('sidebar-user-role');
    const navMembersLabel = document.getElementById('nav-members-label');
    const mobileMembersLabel = document.getElementById('mobile-members-label');

    // Phân quyền hiển thị Menu theo vai trò
    document.querySelectorAll('.admin-only').forEach(el => {
      el.style.display = isAdmin ? '' : 'none';
    });
    document.querySelectorAll('.member-fixed-only').forEach(el => {
      el.style.display = isFixed ? '' : 'none';
    });
    document.querySelectorAll('.guest-only').forEach(el => {
      el.style.display = isGuest ? '' : 'none';
    });

    if (navMembersLabel) {
      navMembersLabel.innerText = isAdmin ? 'Quản lý thành viên' : (isGuest ? 'Nội quy & Đăng ký' : 'Danh bạ thành viên');
    }
    if (mobileMembersLabel) {
      mobileMembersLabel.innerText = isAdmin ? 'QL Thành viên' : (isGuest ? 'Nội quy & ĐK' : 'Danh bạ');
    }

    const tabMembersTitle = document.querySelector('#tab-members .tab-main-title');
    const tabMembersSubtitle = document.querySelector('#tab-members .tab-main-subtitle');
    if (tabMembersTitle) {
      tabMembersTitle.innerHTML = isAdmin ? '<i class="fas fa-users-cog text-primary"></i> Quản lý thành viên CLB' : (isGuest ? '<i class="fas fa-id-card text-primary"></i> Nội quy & Đăng ký gia nhập CLB' : '<i class="fas fa-address-book text-primary"></i> Danh bạ thành viên CLB');
    }
    if (tabMembersSubtitle) {
      tabMembersSubtitle.innerHTML = isAdmin ? '<i class="fas fa-id-badge text-primary"></i> Thêm mới, chỉnh sửa, xóa, phân quyền và quản lý tài khoản thành viên.' : (isGuest ? '<i class="fas fa-info-circle text-primary"></i> Tìm hiểu quyền lợi, nội quy sinh hoạt và gửi đơn đăng ký tham gia.' : '<i class="fas fa-user-shield text-primary"></i> Danh sách thành viên chính thức & khách giao lưu tại CLB Smash Pro.');
    }

    if (!currentUser) {
      // 1. Chế độ Khách vãng lai (Guest Mode - Chưa đăng nhập)
      if (sidebarUserCard) sidebarUserCard.style.display = 'none';

      if (userAvatarEl) userAvatarEl.src = 'https://ui-avatars.com/api/?name=Khach&background=64748b&color=fff';
      if (userNameEl) userNameEl.innerText = 'Khách vãng lai';
      if (userRoleBadgeEl) {
        userRoleBadgeEl.innerText = 'Chưa đăng nhập';
        userRoleBadgeEl.className = 'badge badge-neutral';
      }

      if (headerBtnWrapper) {
        headerBtnWrapper.innerHTML = `
          <button class="btn btn-primary btn-sm" onclick="App.showAuthModal('login')" title="Đăng nhập tài khoản" style="padding: 0.4rem 0.65rem;">
            <i class="fas fa-sign-in-alt"></i> <span class="hidden md:inline">Đăng nhập</span>
          </button>
        `;
      }

      if (sidebarBtnWrapper) {
        sidebarBtnWrapper.innerHTML = `
          <button class="btn btn-primary btn-sm w-full" style="justify-content: center;" onclick="App.showAuthModal('login')">
            <i class="fas fa-sign-in-alt"></i> Đăng nhập / Đăng ký
          </button>
        `;
      }

      const headerEditDot = document.getElementById('header-user-edit-dot');
      if (headerEditDot) headerEditDot.style.display = 'none';
      return;
    }

    // 2. Chế độ Người dùng đã đăng nhập (Admin / Thủ quỹ / Thành viên cố định / Vãng lai)
    if (userAvatarEl) userAvatarEl.src = currentUser.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(currentUser.name)}&background=10b981&color=fff`;
    if (userNameEl) userNameEl.innerText = currentUser.name;

    if (userRoleBadgeEl) {
      userRoleBadgeEl.innerText = currentUser.role === 'admin' ? '👑 Admin / Chủ CLB' : currentUser.role === 'treasurer' ? '💼 Thủ quỹ CLB' : (currentUser.type === 'fixed' ? '🏸 Thành viên cố định' : '⚡ Khách vãng lai');
      userRoleBadgeEl.className = `badge ${currentUser.role === 'admin' ? 'badge-warning' : currentUser.role === 'treasurer' ? 'badge-info' : (currentUser.type === 'fixed' ? 'badge-paid' : 'badge-neutral')}`;
    }

    if (sidebarUserCard) {
      sidebarUserCard.style.display = 'block';
      if (sidebarAvatar) sidebarAvatar.src = currentUser.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(currentUser.name)}&background=10b981&color=fff`;
      if (sidebarName) sidebarName.innerText = currentUser.name;
      if (sidebarRole) {
        sidebarRole.innerText = currentUser.role === 'admin' ? '👑 Quản trị viên' : currentUser.role === 'treasurer' ? '💼 Thủ quỹ CLB' : (currentUser.type === 'fixed' ? '🏸 Thành viên CLB' : '⚡ Khách vãng lai');
        sidebarRole.className = `badge ${currentUser.role === 'admin' ? 'badge-warning' : currentUser.role === 'treasurer' ? 'badge-info' : (currentUser.type === 'fixed' ? 'badge-paid' : 'badge-warning')}`;
      }
    }

    if (headerBtnWrapper) {
      headerBtnWrapper.innerHTML = '';
    }

    const headerEditDot = document.getElementById('header-user-edit-dot');
    if (headerEditDot) headerEditDot.style.display = 'flex';

    if (sidebarBtnWrapper) {
      sidebarBtnWrapper.innerHTML = `
        <button class="btn btn-secondary btn-sm w-full" style="justify-content: center;" onclick="App.logout()">
          <i class="fas fa-sign-out-alt"></i> Đăng xuất
        </button>
      `;
    }
  },

  renderUserRoleSelector() {
    this.renderUserHeaderAndSidebar();
  },

  // ==========================================
  // HỆ THỐNG AVATAR & CẬP NHẬT HỒ SƠ CÁ NHÂN
  // ==========================================

  // Bộ sưu tập Avatar thể thao cầu lông mẫu
  BADMINTON_AVATAR_PRESETS: [
    { url: "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80", label: "Nữ hiện đại" },
    { url: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop&q=80", label: "Nam thể thao 1" },
    { url: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&auto=format&fit=crop&q=80", label: "Nam thể thao 2" },
    { url: "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150&auto=format&fit=crop&q=80", label: "Nữ thể thao 1" },
    { url: "https://images.unsplash.com/photo-1522075469751-3a6694fb2f61?w=150&auto=format&fit=crop&q=80", label: "Nam trẻ trung" },
    { url: "https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=150&auto=format&fit=crop&q=80", label: "Nữ năng động" },
    { url: "https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=150&auto=format&fit=crop&q=80", label: "Nam phong cách" },
    { url: "https://images.unsplash.com/photo-1517841905240-472988babdf9?w=150&auto=format&fit=crop&q=80", label: "Nữ nụ cười" },
    { url: "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=150&auto=format&fit=crop&q=80", label: "Nam cá tính" },
    { url: "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=150&auto=format&fit=crop&q=80", label: "Nữ thanh lịch" },
    { url: "https://images.unsplash.com/photo-1501196354995-cbb51c65aaea?w=150&auto=format&fit=crop&q=80", label: "Nam năng động" },
    { url: "https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=150&auto=format&fit=crop&q=80", label: "Nữ thể thao 2" }
  ],

  // Kết xuất HTML bộ chọn ảnh đại diện trực quan (Avatar Picker)
  renderAvatarPickerHtml(prefix, initialAvatarUrl, initialName) {
    const defaultAvatar = initialAvatarUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(initialName || 'Member')}&background=10b981&color=fff`;
    return `
      <div class="avatar-picker-box" style="margin-bottom: 1.25rem;">
        <input type="hidden" id="${prefix}-avatar-val" value="${defaultAvatar}">
        
        <!-- Preview lớn trung tâm -->
        <div class="flex items-center gap-4" style="margin-bottom: 1rem; padding-bottom: 0.85rem; border-bottom: 1px solid var(--border-color);">
          <div style="position: relative; flex-shrink: 0;">
            <img id="${prefix}-avatar-preview" class="avatar avatar-xl" src="${defaultAvatar}" alt="Avatar Preview" style="border: 3px solid var(--primary); box-shadow: 0 4px 14px rgba(16, 185, 129, 0.25); object-fit: cover;">
            <span style="position: absolute; bottom: 0; right: 0; width: 22px; height: 22px; border-radius: 50%; background: var(--primary); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 10px; border: 2px solid var(--bg-card);"><i class="fas fa-camera"></i></span>
          </div>
          <div style="flex: 1; min-width: 0;">
            <div style="font-weight: 700; color: var(--text-main); font-size: 0.95rem;">Ảnh đại diện thành viên</div>
            <div style="font-size: 0.78rem; color: var(--text-secondary); margin-top: 0.15rem;">
              Chọn ảnh mẫu bên dưới, tải ảnh từ máy (tự động nén siêu nét) hoặc tạo theo tên.
            </div>
          </div>
        </div>

        <!-- Các tab tùy chọn -->
        <div class="segmented-control" style="margin-bottom: 0.85rem; display: flex; gap: 0.35rem; flex-wrap: wrap;">
          <button type="button" class="segmented-btn active" id="${prefix}-tab-btn-presets" onclick="App.switchAvatarSubTab('presets', '${prefix}')" style="font-size: 0.76rem; padding: 0.3rem 0.6rem;">
            <i class="fas fa-th"></i> Bộ sưu tập mẫu
          </button>
          <button type="button" class="segmented-btn" id="${prefix}-tab-btn-upload" onclick="App.switchAvatarSubTab('upload', '${prefix}')" style="font-size: 0.76rem; padding: 0.3rem 0.6rem;">
            <i class="fas fa-upload"></i> Tải ảnh từ máy
          </button>
          <button type="button" class="segmented-btn" id="${prefix}-tab-btn-initials" onclick="App.switchAvatarSubTab('initials', '${prefix}')" style="font-size: 0.76rem; padding: 0.3rem 0.6rem;">
            <i class="fas fa-font"></i> Tạo theo tên
          </button>
          <button type="button" class="segmented-btn" id="${prefix}-tab-btn-url" onclick="App.switchAvatarSubTab('url', '${prefix}')" style="font-size: 0.76rem; padding: 0.3rem 0.6rem;">
            <i class="fas fa-link"></i> Link URL
          </button>
        </div>

        <!-- 1. Bộ sưu tập mẫu -->
        <div id="${prefix}-subtab-presets" style="display: block;">
          <div class="avatar-preset-grid">
            ${this.BADMINTON_AVATAR_PRESETS.map((p) => `
              <img src="${p.url}" alt="${p.label}" title="${p.label}" class="avatar-preset-item ${p.url === defaultAvatar ? 'active' : ''}" onclick="App.selectPresetAvatar('${p.url}', '${prefix}', this)">
            `).join('')}
          </div>
        </div>

        <!-- 2. Tải ảnh lên từ máy tính/điện thoại -->
        <div id="${prefix}-subtab-upload" style="display: none; background: var(--bg-card); padding: 1rem; border-radius: var(--radius-md); border: 1px dashed var(--border-color); text-align: center;">
          <i class="fas fa-cloud-upload-alt text-primary" style="font-size: 2rem; margin-bottom: 0.5rem; display: block;"></i>
          <label class="btn btn-outline-primary btn-sm" style="cursor: pointer; display: inline-flex; align-items: center; gap: 0.4rem;">
            <i class="fas fa-folder-open"></i> <span>Chọn ảnh từ thiết bị...</span>
            <input type="file" accept="image/*" style="display: none;" onchange="App.handleAvatarFileChange(event, '${prefix}')">
          </label>
          <div style="font-size: 0.74rem; color: var(--text-muted); margin-top: 0.5rem;">Hỗ trợ JPG, PNG, WEBP. Hệ thống tự động tối ưu hoá ảnh sắc nét, nhẹ và nhanh.</div>
        </div>

        <!-- 3. Tự tạo avatar theo tên và bảng màu -->
        <div id="${prefix}-subtab-initials" style="display: none; background: var(--bg-card); padding: 0.85rem; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
          <div style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 0.5rem; font-weight: 600;">Chọn màu sắc cho Avatar chữ cái:</div>
          <div class="flex items-center gap-2 flex-wrap">
            <button type="button" class="btn btn-sm" onclick="App.generateInitialsAvatar('${prefix}', '10b981')" style="background: #10b981; color: #fff; border-radius: var(--radius-full); font-size: 0.72rem; padding: 0.25rem 0.6rem;">Xanh ngọc</button>
            <button type="button" class="btn btn-sm" onclick="App.generateInitialsAvatar('${prefix}', '3b82f6')" style="background: #3b82f6; color: #fff; border-radius: var(--radius-full); font-size: 0.72rem; padding: 0.25rem 0.6rem;">Xanh dương</button>
            <button type="button" class="btn btn-sm" onclick="App.generateInitialsAvatar('${prefix}', 'f59e0b')" style="background: #f59e0b; color: #fff; border-radius: var(--radius-full); font-size: 0.72rem; padding: 0.25rem 0.6rem;">Cam vàng</button>
            <button type="button" class="btn btn-sm" onclick="App.generateInitialsAvatar('${prefix}', '8b5cf6')" style="background: #8b5cf6; color: #fff; border-radius: var(--radius-full); font-size: 0.72rem; padding: 0.25rem 0.6rem;">Tím thể thao</button>
            <button type="button" class="btn btn-sm" onclick="App.generateInitialsAvatar('${prefix}', 'ef4444')" style="background: #ef4444; color: #fff; border-radius: var(--radius-full); font-size: 0.72rem; padding: 0.25rem 0.6rem;">Đỏ nhiệt huyết</button>
            <button type="button" class="btn btn-sm" onclick="App.generateInitialsAvatar('${prefix}', '0f172a')" style="background: #0f172a; color: #fff; border-radius: var(--radius-full); font-size: 0.72rem; padding: 0.25rem 0.6rem;">Đen huyền bí</button>
          </div>
        </div>

        <!-- 4. Nhập đường dẫn link ảnh -->
        <div id="${prefix}-subtab-url" style="display: none;">
          <div class="flex gap-2">
            <input type="url" id="${prefix}-avatar-url-input" class="form-control" placeholder="Dán đường dẫn link ảnh (https://...)" style="font-size: 0.82rem;">
            <button type="button" class="btn btn-secondary btn-sm" onclick="App.applyCustomAvatarUrl('${prefix}')" style="flex-shrink: 0;">Áp dụng</button>
          </div>
        </div>
      </div>
    `;
  },

  switchAvatarSubTab(subTab, prefix) {
    ['presets', 'upload', 'initials', 'url'].forEach(tab => {
      const btn = document.getElementById(`${prefix}-tab-btn-${tab}`);
      const panel = document.getElementById(`${prefix}-subtab-${tab}`);
      if (btn) {
        if (tab === subTab) btn.classList.add('active');
        else btn.classList.remove('active');
      }
      if (panel) {
        panel.style.display = (tab === subTab) ? 'block' : 'none';
      }
    });
  },

  selectPresetAvatar(url, prefix, clickedEl = null) {
    const preview = document.getElementById(`${prefix}-avatar-preview`);
    const valInput = document.getElementById(`${prefix}-avatar-val`);
    if (preview) preview.src = url;
    if (valInput) valInput.value = url;
    document.querySelectorAll(`#${prefix}-subtab-presets .avatar-preset-item`).forEach(el => el.classList.remove('active'));
    if (clickedEl) clickedEl.classList.add('active');
  },

  handleAvatarFileChange(e, prefix) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      this.showToast("Vui lòng chọn tệp hình ảnh hợp lệ (PNG, JPG, WEBP)!", "warning");
      return;
    }
    const reader = new FileReader();
    reader.onload = (evt) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_SIZE = 160;
        let w = img.width;
        let h = img.height;
        if (w > h) {
          if (w > MAX_SIZE) {
            h = Math.round(h * (MAX_SIZE / w));
            w = MAX_SIZE;
          }
        } else {
          if (h > MAX_SIZE) {
            w = Math.round(w * (MAX_SIZE / h));
            h = MAX_SIZE;
          }
        }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);

        const preview = document.getElementById(`${prefix}-avatar-preview`);
        const valInput = document.getElementById(`${prefix}-avatar-val`);
        if (preview) preview.src = dataUrl;
        if (valInput) valInput.value = dataUrl;
        this.showToast("Đã tải và xử lý ảnh đại diện thành công!", "success");
      };
      img.src = evt.target.result;
    };
    reader.readAsDataURL(file);
  },

  generateInitialsAvatar(prefix, colorHex) {
    let nameVal = '';
    const nameInput = document.getElementById(`${prefix}-name`) || document.getElementById('profile-name') || document.getElementById('edit-mem-name') || document.getElementById('add-mem-name');
    if (nameInput) nameVal = nameInput.value.trim();
    if (!nameVal) {
      const u = AppStorage.getCurrentUser();
      if (u) nameVal = u.name;
    }
    if (!nameVal) nameVal = 'Member';

    const avatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(nameVal)}&background=${colorHex}&color=fff&size=160&bold=true`;
    const preview = document.getElementById(`${prefix}-avatar-preview`);
    const valInput = document.getElementById(`${prefix}-avatar-val`);
    if (preview) preview.src = avatarUrl;
    if (valInput) valInput.value = avatarUrl;
  },

  applyCustomAvatarUrl(prefix) {
    const input = document.getElementById(`${prefix}-avatar-url-input`);
    const url = (input?.value || '').trim();
    if (!url) {
      this.showToast("Vui lòng dán đường dẫn link ảnh hợp lệ!", "warning");
      return;
    }
    const preview = document.getElementById(`${prefix}-avatar-preview`);
    const valInput = document.getElementById(`${prefix}-avatar-val`);
    if (preview) preview.src = url;
    if (valInput) valInput.value = url;
    this.showToast("Đã áp dụng link ảnh mới!", "success");
  },

  handleHeaderUserClick() {
    if (!AppStorage.isLoggedIn()) {
      this.showAuthModal('login');
    } else {
      this.openUserProfileModal();
    }
  },

  openUserProfileModal() {
    const user = AppStorage.getCurrentUser();
    if (!user) {
      this.showAuthModal('login');
      return;
    }

    const data = AppStorage.loadData();
    const member = (data.members || []).find(m => m.id === user.memberId || (m.username && m.username === user.username) || (m.phone && user.phone && m.phone.replace(/\D/g, '') === user.phone.replace(/\D/g, ''))) || {};

    const avatarHtml = this.renderAvatarPickerHtml('profile', user.avatar, user.name);
    const roleBadgeText = user.role === 'admin' ? '👑 Quản trị viên CLB' : user.role === 'treasurer' ? '💼 Thủ quỹ CLB' : '🏸 Thành viên CLB';

    const modalBody = `
      <form onsubmit="App.saveUserProfile(event)">
        <!-- Header Info Banner -->
        <div style="background: var(--bg-input); padding: 0.85rem 1rem; border-radius: var(--radius-md); border: 1px solid var(--border-color); margin-bottom: 1.25rem; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem;">
          <div>
            <div style="font-size: 0.78rem; color: var(--text-secondary);">Tài khoản đăng nhập:</div>
            <div class="font-mono font-bold" style="font-size: 0.95rem; color: var(--text-main);">${user.username}</div>
          </div>
          <div class="flex items-center gap-1">
            <span class="badge ${user.role === 'admin' ? 'badge-warning' : user.role === 'treasurer' ? 'badge-info' : 'badge-paid'}" style="font-size: 0.72rem; padding: 0.2rem 0.55rem;">
              ${roleBadgeText}
            </span>
          </div>
        </div>

        <!-- 1. Bộ chọn và Đổi ảnh đại diện -->
        ${avatarHtml}

        <!-- 2. Thông tin cá nhân -->
        <div class="form-group">
          <label class="form-label font-bold">Họ và tên *</label>
          <input type="text" id="profile-name" class="form-control" value="${user.name || ''}" placeholder="Nhập họ và tên đầy đủ..." required>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
          <div class="form-group">
            <label class="form-label font-bold">Số điện thoại / Zalo *</label>
            <input type="tel" id="profile-phone" class="form-control" value="${user.phone || ''}" placeholder="Ví dụ: 0912345678" required>
          </div>
          <div class="form-group">
            <label class="form-label">Email liên hệ (tùy chọn)</label>
            <input type="email" id="profile-email" class="form-control" value="${user.email || member.email || ''}" placeholder="email@domain.com">
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Giới thiệu / Trình độ / Ghi chú</label>
          <input type="text" id="profile-note" class="form-control" value="${user.note || member.note || ''}" placeholder="Ví dụ: Trình độ trung bình khá, thuận tay phải, chuyên đánh đôi...">
        </div>

        <!-- 3. Khu vực Đổi mật khẩu -->
        <div style="background: var(--bg-input); padding: 1rem; border-radius: var(--radius-md); border: 1px solid var(--border-color); margin-top: 1rem;">
          <div style="font-weight: 700; color: var(--text-main); font-size: 0.88rem; margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.4rem;">
            <i class="fas fa-shield-alt text-primary"></i> Đổi mật khẩu tài khoản
          </div>
          <div style="font-size: 0.76rem; color: var(--text-secondary); margin-bottom: 0.75rem;">
            Chỉ điền vào các ô dưới đây nếu bạn muốn thay đổi mật khẩu đăng nhập.
          </div>

          <div class="form-group" style="margin-bottom: 0.65rem;">
            <label class="form-label" style="font-size: 0.8rem;">Mật khẩu hiện tại</label>
            <input type="password" id="profile-current-pwd" class="form-control" placeholder="Nhập mật khẩu hiện tại nếu muốn đổi mật khẩu...">
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem;">
            <div class="form-group" style="margin-bottom: 0;">
              <label class="form-label" style="font-size: 0.8rem;">Mật khẩu mới (≥ 6 ký tự)</label>
              <input type="password" id="profile-new-pwd" class="form-control" placeholder="Mật khẩu mới...">
            </div>
            <div class="form-group" style="margin-bottom: 0;">
              <label class="form-label" style="font-size: 0.8rem;">Xác nhận mật khẩu mới</label>
              <input type="password" id="profile-confirm-pwd" class="form-control" placeholder="Nhập lại mật khẩu mới...">
            </div>
          </div>
        </div>

        <div class="modal-footer" style="padding: 1.25rem 0 0 0; display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; flex-wrap: wrap;">
          <button type="button" class="btn btn-outline-danger" onclick="App.closeModal(); App.logout();" title="Đăng xuất khỏi tài khoản này">
            <i class="fas fa-sign-out-alt"></i> Đăng xuất
          </button>
          <div class="flex items-center gap-2">
            <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Hủy</button>
            <button type="submit" class="btn btn-primary"><i class="fas fa-save"></i> Lưu thông tin & Avatar</button>
          </div>
        </div>
      </form>
    `;

    this.openModal("👤 Hồ sơ cá nhân & Đổi ảnh đại diện", modalBody);
  },

  saveUserProfile(e) {
    if (e && e.preventDefault) e.preventDefault();
    const user = AppStorage.getCurrentUser();
    if (!user) return;

    const name = (document.getElementById('profile-name')?.value || '').trim();
    const phone = (document.getElementById('profile-phone')?.value || '').trim();
    const email = (document.getElementById('profile-email')?.value || '').trim();
    const note = (document.getElementById('profile-note')?.value || '').trim();
    const avatar = document.getElementById('profile-avatar-val')?.value || user.avatar;

    const currentPassword = document.getElementById('profile-current-pwd')?.value || '';
    const newPassword = document.getElementById('profile-new-pwd')?.value || '';
    const confirmPassword = document.getElementById('profile-confirm-pwd')?.value || '';

    const res = AppStorage.updateUserProfile({
      userId: user.id,
      name,
      phone,
      email,
      avatar,
      note,
      currentPassword,
      newPassword,
      confirmPassword
    });

    if (!res.success) {
      this.showToast(res.message, "error");
      return;
    }

    this.closeModal();
    this.showToast(`🎉 ${res.message}`, "success");
    this.renderUserHeaderAndSidebar();
    this.refreshDashboardStats();
    if (window.MembersModule) MembersModule.renderMembersTab();
    if (window.ScheduleModule) {
      if (ScheduleModule.currentViewMode === 'calendar') ScheduleModule.renderMonthCalendar();
      else ScheduleModule.renderSessions("sessions-container", ScheduleModule.currentFilter || 'upcoming');
    }
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
