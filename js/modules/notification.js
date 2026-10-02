// SMASH PRO - Notification Module
// Quản lý thông báo Web Push cho thành viên:
// 1. Thông báo chốt đặt sân khi Admin tạo lịch / chốt phương án poll
// 2. Nhắc trước 4 tiếng khi buổi đánh sắp diễn ra

const NotificationModule = {
  // Key lưu danh sách alarm đã nhắc (tránh nhắc lại)
  ALARM_KEY: 'SMASH_PRO_NOTIF_ALARMS_V1',
  SW_SCOPE: '/',
  swRegistration: null,
  reminderInterval: null,

  // ==========================================
  // KHỞI TẠO: Đăng ký Service Worker + Chạy bộ kiểm tra nhắc lịch
  // ==========================================
  async init() {
    if (!('Notification' in window)) {
      console.info('[NotifModule] Trình duyệt không hỗ trợ Web Notification.');
      return;
    }

    // Đăng ký Service Worker
    if ('serviceWorker' in navigator) {
      try {
        this.swRegistration = await navigator.serviceWorker.register('sw.js', { scope: this.SW_SCOPE });
        console.info('[NotifModule] Service Worker đã đăng ký thành công:', this.swRegistration.scope);
      } catch (err) {
        console.warn('[NotifModule] Không thể đăng ký Service Worker:', err.message);
      }
    }

    // Render trạng thái nút thông báo trên UI
    this.renderNotifToggleBtn();

    // Bắt đầu vòng lặp kiểm tra nhắc lịch mỗi 5 phút
    this.startReminderChecker();
  },

  // ==========================================
  // RENDER NÚT BẬT/TẮT THÔNG BÁO TRÊN SIDEBAR & HEADER
  // ==========================================
  renderNotifToggleBtn() {
    const containers = [
      document.getElementById('notif-toggle-sidebar'),
      document.getElementById('notif-toggle-header')
    ];

    const permission = Notification.permission;
    const icon = permission === 'granted' ? 'fa-bell' : (permission === 'denied' ? 'fa-bell-slash' : 'fa-bell');
    const iconColor = permission === 'granted' ? '#10b981' : (permission === 'denied' ? '#ef4444' : '#f59e0b');
    const label = permission === 'granted' ? 'Thông báo: BẬT' : (permission === 'denied' ? 'Thông báo: ĐÃ CHẶN' : 'Bật thông báo');
    const titleAttr = permission === 'denied'
      ? 'Bạn đã chặn thông báo. Vào Cài đặt trình duyệt để cấp lại quyền.'
      : permission === 'granted'
        ? 'Thông báo đang bật. Nhấp để tắt tạm thời.'
        : 'Bật thông báo lịch đặt sân & nhắc 4 tiếng trước buổi đánh';

    containers.forEach(container => {
      if (!container) return;
      container.innerHTML = `
        <button
          id="${container.id}-btn"
          class="notif-toggle-btn ${permission === 'granted' ? 'is-active' : ''} ${permission === 'denied' ? 'is-denied' : ''}"
          onclick="NotificationModule.handleToggleClick()"
          title="${titleAttr}"
          aria-label="${label}"
        >
          <i class="fas ${icon}" style="color: ${iconColor}; font-size: 1rem;"></i>
          <span class="notif-toggle-label">${label}</span>
          ${permission === 'granted' ? '<span class="notif-active-dot"></span>' : ''}
        </button>
      `;
    });
  },

  // ==========================================
  // XỬ LÝ KHI NGƯỜI DÙNG NHẤP NÚT THÔNG BÁO
  // ==========================================
  async handleToggleClick() {
    const permission = Notification.permission;

    if (permission === 'denied') {
      App.showToast('🔕 Thông báo đang bị chặn. Vào Cài đặt trình duyệt → Quyền riêng tư → Thông báo để cấp lại.', 'warning');
      return;
    }

    if (permission === 'granted') {
      // Tắt tạm: xóa flag kích hoạt trong localStorage
      const isEnabled = localStorage.getItem('SMASH_PRO_NOTIF_ENABLED') !== '0';
      if (isEnabled) {
        localStorage.setItem('SMASH_PRO_NOTIF_ENABLED', '0');
        App.showToast('🔕 Đã tắt thông báo. Bạn sẽ không nhận nhắc lịch đặt sân.', 'info');
      } else {
        localStorage.setItem('SMASH_PRO_NOTIF_ENABLED', '1');
        App.showToast('🔔 Đã bật lại thông báo lịch đặt sân!', 'success');
      }
      this.renderNotifToggleBtn();
      return;
    }

    // Chưa có quyền → xin quyền
    await this.requestPermission();
  },

  // ==========================================
  // XIN QUYỀN THÔNG BÁO (hiển thị dialog hướng dẫn trước)
  // ==========================================
  async requestPermission() {
    // Hiển thị modal giải thích trước khi xin quyền browser
    const modalBody = `
      <div style="text-align: center; margin-bottom: 1.5rem;">
        <div style="width: 72px; height: 72px; border-radius: 50%; background: linear-gradient(135deg, rgba(16,185,129,0.2) 0%, rgba(6,182,212,0.15) 100%); display: inline-flex; align-items: center; justify-content: center; font-size: 2rem; margin-bottom: 1rem;">
          🔔
        </div>
        <h3 style="font-size: 1.2rem; color: var(--text-main); margin-bottom: 0.5rem;">Bật thông báo lịch đặt sân</h3>
        <p class="text-secondary" style="font-size: 0.88rem; line-height: 1.6;">
          SMASH PRO sẽ gửi thông báo đến thiết bị của bạn trong 2 trường hợp:
        </p>
      </div>

      <div style="display: flex; flex-direction: column; gap: 0.75rem; margin-bottom: 1.5rem;">
        <div style="display: flex; align-items: flex-start; gap: 0.85rem; background: rgba(16,185,129,0.08); border-radius: var(--radius-md); padding: 0.85rem 1rem; border: 1px solid rgba(16,185,129,0.2);">
          <span style="font-size: 1.5rem; flex-shrink: 0;">📅</span>
          <div>
            <div style="font-weight: 700; color: var(--text-main); font-size: 0.92rem;">Khi Admin chốt lịch đặt sân</div>
            <div class="text-secondary" style="font-size: 0.8rem; margin-top: 0.2rem;">Nhận ngay khi Admin lưu lịch mới hoặc chốt phương án khảo sát — chứa đầy đủ thông tin sân, giờ đánh.</div>
          </div>
        </div>

        <div style="display: flex; align-items: flex-start; gap: 0.85rem; background: rgba(245,158,11,0.08); border-radius: var(--radius-md); padding: 0.85rem 1rem; border: 1px solid rgba(245,158,11,0.2);">
          <span style="font-size: 1.5rem; flex-shrink: 0;">⏰</span>
          <div>
            <div style="font-weight: 700; color: var(--text-main); font-size: 0.92rem;">Nhắc trước buổi đánh 4 tiếng</div>
            <div class="text-secondary" style="font-size: 0.8rem; margin-top: 0.2rem;">Nhắc nhở tự động trước 4 tiếng (chỉ dành cho thành viên đã bình chọn "Tham gia") — kể cả khi đóng tab.</div>
          </div>
        </div>
      </div>

      <div style="background: rgba(99,102,241,0.07); border-radius: var(--radius-sm); padding: 0.65rem 0.9rem; font-size: 0.78rem; color: var(--text-secondary); margin-bottom: 1.25rem;">
        <i class="fas fa-shield-alt text-primary"></i>
        Thông báo hoạt động ngay trên trình duyệt — không cần cài app, không thu thập dữ liệu cá nhân.
      </div>

      <div style="display: flex; gap: 0.5rem; justify-content: flex-end; flex-wrap: wrap;">
        <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Để sau</button>
        <button type="button" class="btn btn-primary" id="confirm-notif-btn" onclick="NotificationModule._doRequestPermission()">
          <i class="fas fa-bell"></i> Cho phép thông báo
        </button>
      </div>
    `;

    App.openModal('🔔 Bật thông báo lịch đặt sân', modalBody, false);
  },

  // Thực sự xin quyền browser
  async _doRequestPermission() {
    App.closeModal();
    try {
      const result = await Notification.requestPermission();
      if (result === 'granted') {
        localStorage.setItem('SMASH_PRO_NOTIF_ENABLED', '1');
        App.showToast('🔔 Đã bật thông báo! Bạn sẽ nhận nhắc lịch trước 4 tiếng và khi Admin chốt sân.', 'success');
        // Gửi thông báo demo để xác nhận
        setTimeout(() => {
          this._showNotification({
            title: '🏸 SMASH PRO - Thông báo đã bật!',
            body: 'Bạn sẽ nhận nhắc lịch đặt sân trước 4 tiếng và khi Admin chốt buổi đánh mới.',
            tag: 'smash-pro-welcome',
          });
        }, 800);
      } else if (result === 'denied') {
        App.showToast('🔕 Đã từ chối thông báo. Bạn có thể bật lại trong Cài đặt trình duyệt.', 'warning');
      }
    } catch (err) {
      console.warn('[NotifModule] Lỗi khi xin quyền thông báo:', err);
    }
    this.renderNotifToggleBtn();
  },

  // ==========================================
  // KIỂM TRA TRẠNG THÁI: Thông báo có được phép không?
  // ==========================================
  isEnabled() {
    if (!('Notification' in window)) return false;
    if (Notification.permission !== 'granted') return false;
    return localStorage.getItem('SMASH_PRO_NOTIF_ENABLED') !== '0';
  },

  // ==========================================
  // GỬI THÔNG BÁO (qua Service Worker hoặc Notification API trực tiếp)
  // ==========================================
  async _showNotification({ title, body, tag, icon }) {
    if (!this.isEnabled()) return;

    const notifIcon = icon || (window.location.origin + '/assets/favicon.png');

    // Ưu tiên dùng Service Worker để hiển thị cả khi tab bị ẩn
    if (this.swRegistration) {
      try {
        const sw = await navigator.serviceWorker.ready;
        if (sw && sw.active) {
          sw.active.postMessage({
            type: 'SHOW_NOTIFICATION',
            payload: { title, body, icon: notifIcon, tag: tag || 'smash-pro-notify' }
          });
          return;
        }
      } catch (err) {
        console.warn('[NotifModule] SW postMessage lỗi, dùng Notification API trực tiếp:', err.message);
      }
    }

    // Fallback: Notification API trực tiếp (chỉ hoạt động khi tab đang active)
    try {
      new Notification(title, {
        body,
        icon: notifIcon,
        tag: tag || 'smash-pro-notify',
        requireInteraction: false
      });
    } catch (err) {
      console.warn('[NotifModule] Notification API lỗi:', err);
    }
  },

  // ==========================================
  // [TRIGGER 1] THÔNG BÁO KHI ADMIN CHỐT / TẠO LỊCH MỚI
  // Gọi từ ScheduleModule.saveNewSession() và ScheduleModule.finalizePollOption()
  // ==========================================
  notifySessionBooked(session, isFinalized = false) {
    if (!session) return;
    if (!this.isEnabled()) return;

    const currentUser = AppStorage.getCurrentUser();
    // Nếu user đang đăng nhập là admin, chỉ notify nếu họ cũng đã vote tham gia
    // (Admin vẫn được notify nếu cũng trong danh sách going)

    const going = (session.votes || []).filter(v => v.status === 'going');
    const currentMember = currentUser
      ? AppStorage.loadData().members?.find(m =>
          m.id === currentUser.memberId ||
          m.id === currentUser.id ||
          (currentUser.username && m.username === currentUser.username)
        )
      : null;
    const currentMemberId = currentMember?.id || currentUser?.memberId || currentUser?.id;

    // Chỉ gửi cho thành viên đang đăng nhập nếu họ trong danh sách going
    const isGoing = currentMemberId && going.some(v => v.memberId === currentMemberId);

    // Nếu chưa ai vote (mới tạo) → notify cho tất cả người đang đăng nhập
    const shouldNotify = isGoing || going.length === 0;
    if (!shouldNotify) return;

    const isMultiPoll = session.voteMode === 'multi_option';
    const dateTime = `${session.date} lúc ${session.startTime}`;
    const courtInfo = isMultiPoll ? 'Khảo sát đa phương án' : `${session.courtName || 'Sân CLB'} (${session.courtNumbers || ''})`;

    const titleText = isFinalized
      ? `✅ Đã chốt lịch: ${session.title}`
      : `📅 Lịch đặt sân mới: ${session.title}`;

    const bodyText = isFinalized
      ? `Buổi đánh đã được xác nhận!\n📍 ${courtInfo}\n🕐 ${dateTime}`
      : `Admin vừa tạo lịch đặt sân mới.\n📍 ${courtInfo}\n🕐 ${dateTime}\n\nHãy vào app bình chọn tham gia ngay!`;

    this._showNotification({
      title: titleText,
      body: bodyText,
      tag: `session-booked-${session.id}`,
    });
  },

  // ==========================================
  // [TRIGGER 2] NHẮC TRƯỚC BUỔI ĐÁNH 4 TIẾNG
  // Chạy liên tục mỗi 5 phút trong vòng lặp
  // ==========================================
  startReminderChecker() {
    if (this.reminderInterval) clearInterval(this.reminderInterval);

    // Kiểm tra ngay khi init
    this._checkUpcomingReminders();

    // Lặp lại mỗi 5 phút
    this.reminderInterval = setInterval(() => {
      this._checkUpcomingReminders();
    }, 5 * 60 * 1000);
  },

  _checkUpcomingReminders() {
    if (!this.isEnabled()) return;

    const data = AppStorage.loadData();
    const sessions = data.sessions || [];
    const now = new Date();

    // Lấy danh sách alarm đã gửi
    let sentAlarms = {};
    try {
      sentAlarms = JSON.parse(localStorage.getItem(this.ALARM_KEY) || '{}');
    } catch (e) { sentAlarms = {}; }

    const currentUser = AppStorage.getCurrentUser();
    if (!currentUser) return;

    const currentMember = (data.members || []).find(m =>
      m.id === currentUser.memberId ||
      m.id === currentUser.id ||
      (currentUser.username && m.username === currentUser.username)
    );
    const currentMemberId = currentMember?.id || currentUser?.memberId || currentUser?.id;
    if (!currentMemberId) return;

    // Dọn dẹp alarm cũ hơn 2 ngày
    const twoDaysAgo = now.getTime() - (2 * 24 * 60 * 60 * 1000);
    Object.keys(sentAlarms).forEach(key => {
      if (sentAlarms[key] < twoDaysAgo) delete sentAlarms[key];
    });

    sessions.forEach(session => {
      if (session.status === 'cancelled') return;
      if (session.voteMode === 'multi_option' && !session.selectedOptionId) return;

      // Chỉ nhắc cho các session sắp tới (chưa bắt đầu)
      const sessionStart = ScheduleModule.parseSessionDateTime(session.date, session.startTime);
      const msToStart = sessionStart.getTime() - now.getTime();

      // Khoảng thời gian hợp lệ: còn 4 tiếng (±15 phút)
      const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
      const WINDOW_MS = 15 * 60 * 1000; // 15 phút tolerance

      const isInReminderWindow = msToStart >= (FOUR_HOURS_MS - WINDOW_MS) && msToStart <= (FOUR_HOURS_MS + WINDOW_MS);
      if (!isInReminderWindow) return;

      // Kiểm tra thành viên đã bình chọn "tham gia" chưa
      const going = (session.votes || []).filter(v => v.status === 'going');
      const isGoing = going.some(v => v.memberId === currentMemberId);
      if (!isGoing) return;

      // Kiểm tra đã nhắc buổi này chưa
      const alarmKey = `reminder_4h_${session.id}`;
      if (sentAlarms[alarmKey]) return;

      // Ghi nhận đã nhắc
      sentAlarms[alarmKey] = now.getTime();
      localStorage.setItem(this.ALARM_KEY, JSON.stringify(sentAlarms));

      // Gửi thông báo nhắc
      const courtInfo = session.courtName || 'Sân CLB';
      const courtNumbers = session.courtNumbers ? ` (${session.courtNumbers})` : '';
      const hoursLeft = Math.round(msToStart / (60 * 60 * 1000));

      this._showNotification({
        title: `⏰ Còn ${hoursLeft} tiếng nữa là đến giờ đánh!`,
        body: `🏸 ${session.title}\n📍 ${courtInfo}${courtNumbers}\n🕐 ${session.startTime} – ${session.endTime}, ${session.date}\n\nChuẩn bị đồ và đến đúng giờ nhé! 💪`,
        tag: alarmKey,
      });

      // Hiển thị toast in-app bổ sung
      if (typeof App !== 'undefined' && App.showToast) {
        App.showToast(
          `⏰ Nhắc nhở: Còn ${hoursLeft} tiếng nữa là đến buổi đánh "<strong>${session.title}</strong>" lúc ${session.startTime}!`,
          'info'
        );
      }
    });

    // Lưu lại sau khi dọn dẹp
    localStorage.setItem(this.ALARM_KEY, JSON.stringify(sentAlarms));
  },

  // ==========================================
  // TIỆN ÍCH: Xem lại danh sách alarm đã nhắc (Debug)
  // ==========================================
  getSentAlarms() {
    try {
      return JSON.parse(localStorage.getItem(this.ALARM_KEY) || '{}');
    } catch (e) { return {}; }
  },

  clearSentAlarms() {
    localStorage.removeItem(this.ALARM_KEY);
    console.info('[NotifModule] Đã xóa toàn bộ lịch sử alarm.');
  }
};

window.NotificationModule = NotificationModule;
