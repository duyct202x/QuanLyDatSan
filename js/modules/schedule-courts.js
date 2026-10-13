// ScheduleModule - Địa chỉ sân & bản đồ (tách từ schedule.js; mở rộng ScheduleModule nên `this` dùng như cũ)
Object.assign(ScheduleModule, {
  // Fill default club court address into a target input element
  fillDefaultClubCourtAddress(targetInputId = 'session-court-address') {
    const data = AppStorage.loadData();
    const defaultAddr = (data.clubInfo && data.clubInfo.address) || "50/1 Tân Sơn, Phường 15, Tân Bình, TP. Hồ Chí Minh";
    const input = document.getElementById(targetInputId);
    if (input) {
      input.value = defaultAddr;
      App.showToast("📍 Đã điền địa chỉ sân nhà của CLB!", "info");
    }
  },

  // Quick test Google Maps location search in a new tab
  testMapLocation(addrInputId, nameInputId) {
    const addrInput = document.getElementById(addrInputId);
    const nameInput = document.getElementById(nameInputId);
    const query = (addrInput && addrInput.value.trim()) || (nameInput && nameInput.value.trim()) || "Sân cầu lông";
    const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
    window.open(url, '_blank');
  },

  // Copy court address to clipboard with user toast feedback
  copyAddress(address) {
    if (!address) {
      App.showToast("Không có thông tin địa chỉ để sao chép!", "warning");
      return;
    }
    navigator.clipboard.writeText(address).then(() => {
      App.showToast("📍 Đã sao chép địa chỉ sân vào bộ nhớ tạm!", "success");
    }).catch(() => {
      App.showText("Sao chép địa chỉ sân:", address);
    });
  },

  // Open Court Map Modal Popup
  openCourtMapModal(courtName, courtAddress, mapUrl) {
    const data = AppStorage.loadData();
    const resolvedAddress = courtAddress || (data.clubInfo ? data.clubInfo.address : '') || courtName || 'Sân cầu lông';
    const directMapsUrl = mapUrl || (data.clubInfo && data.clubInfo.mapUrl) || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(resolvedAddress)}`;

    const modalBody = `
      <div style="margin-bottom: 1rem;">
        <div class="font-bold text-main" style="font-size: 1.1rem; margin-bottom: 0.25rem;">
          <i class="fas fa-map-marker-alt text-primary"></i> ${Safe.html(courtName)}
        </div>
        <div class="text-secondary" style="font-size: 0.88rem; display: flex; align-items: flex-start; gap: 0.4rem;">
          <i class="fas fa-location-arrow text-primary" style="margin-top: 0.2rem; font-size: 0.75rem;"></i>
          <span>${Safe.html(resolvedAddress)}</span>
        </div>
      </div>

      <div class="court-map-embed-wrapper" style="height: 320px; margin-bottom: 1.25rem;">
        <iframe 
          width="100%" 
          height="100%" 
          style="border:0;" 
          loading="lazy" 
          allowfullscreen 
          referrerpolicy="no-referrer-when-downgrade"
          src="https://maps.google.com/maps?q=${encodeURIComponent(resolvedAddress)}&t=&z=15&ie=UTF8&iwloc=&output=embed">
        </iframe>
      </div>

      <div class="modal-footer" style="padding: 0; display: flex; justify-content: space-between; align-items: center;">
        <button type="button" class="btn btn-outline-primary btn-sm" onclick="ScheduleModule.copyAddress(${Safe.js(resolvedAddress)})">
          <i class="far fa-copy"></i> Sao chép địa chỉ
        </button>
        <div style="display: flex; gap: 0.5rem;">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Đóng</button>
          <a href="${Safe.url(directMapsUrl)}" target="_blank" class="btn btn-primary">
            <i class="fas fa-directions"></i> Mở Google Maps
          </a>
        </div>
      </div>
    `;

    App.openModal("🗺️ Vị trí sân trên Google Maps", modalBody, true);
  },

  // ==========================================
  // ==========================================
  // EDIT COURT LOCATION, PRICE & SHUTTLE (ENHANCED)
  // ==========================================
  openEditCourtLocationModal(targetId = 'club', optionId = null) {
    if (!AppStorage.can('schedule')) {
      App.showToast("Chỉ Quản trị viên (Admin) mới có quyền chỉnh sửa thông tin sân!", "warning");
      App.showAuthModal('login');
      return;
    }

    const data = AppStorage.loadData();
    let courtName = '';
    let courtNumbers = '';
    let courtPrice = 0;
    let shuttleType = 'n/a';
    let courtAddress = '';
    let mapUrl = '';
    let contextTitle = '';

    if (targetId === 'club') {
      const info = data.clubInfo || {};
      courtName = info.defaultCourt || '';
      courtNumbers = info.courtNumbers || '';
      courtAddress = info.address || '';
      courtPrice = info.defaultCourtPrice || 0;
      shuttleType = 'n/a';
      mapUrl = info.mapUrl || '';
      contextTitle = '🏸 Thông tin Sân nhà mặc định của CLB';
    } else {
      const session = (data.sessions || []).find(s => s.id === targetId);
      if (!session) {
        App.showToast("Không tìm thấy ca đặt sân tương ứng!", "error");
        return;
      }
      if (optionId && session.options) {
        const opt = session.options.find(o => o.id === optionId);
        if (!opt) {
          App.showToast("Không tìm thấy phương án khảo sát tương ứng!", "error");
          return;
        }
        courtName = opt.courtName || '';
        courtNumbers = opt.courtNumbers || '';
        courtPrice = opt.price !== undefined ? opt.price : (session.courtPrice || 0);
        shuttleType = opt.shuttleType || session.shuttleType || 'n/a';
        courtAddress = opt.courtAddress || (data.clubInfo ? data.clubInfo.address : '');
        mapUrl = opt.mapUrl || '';
        contextTitle = `🏸 Thông tin sân: Phương án khảo sát (${session.title})`;
      } else {
        courtName = session.courtName || session.court || '';
        courtNumbers = session.courtNumbers || '';
        courtPrice = session.courtPrice || 0;
        shuttleType = session.shuttleType || 'n/a';
        courtAddress = session.courtAddress || (data.clubInfo ? data.clubInfo.address : '');
        mapUrl = session.mapUrl || '';
        contextTitle = `🏸 Thông tin sân: ${session.title}`;
      }
    }

    const resolvedSearchQuery = courtAddress || courtName || 'San Cau Long';

    const modalBody = `
      <form onsubmit="ScheduleModule.saveCourtLocation(event, ${Safe.js(targetId)}, ${Safe.js(optionId || '')})">
        <div style="background: rgba(16, 185, 129, 0.08); border-left: 3px solid var(--primary); padding: 0.75rem 1rem; border-radius: var(--radius-sm); margin-bottom: 1.25rem;">
          <div class="font-bold text-main" style="font-size: 0.95rem;">${Safe.html(contextTitle)}</div>
          <div class="text-secondary" style="font-size: 0.8rem; margin-top: 0.15rem;">
            Chỉnh sửa tên sân, số sân, tiền sân dự tính, loại cầu sử dụng (mặc định n/a), địa chỉ và bản đồ Google Maps. Thay đổi sẽ tự động đồng bộ lên Database.
          </div>
        </div>

        <div class="responsive-form-row">
          <div class="form-group" style="flex: 1.4;">
            <label class="form-label font-bold"><i class="fas fa-map-marker-alt text-primary"></i> Tên sân cầu lông *</label>
            <input type="text" id="edit-loc-court-name" class="form-control" value="${Safe.html(courtName)}" required placeholder="VD: Sân cầu lông CLB">
          </div>
          <div class="form-group" style="flex: 1;">
            <label class="form-label font-bold"><i class="fas fa-th-large text-primary"></i> Số sân / Ghi chú sân</label>
            <input type="text" id="edit-loc-court-numbers" class="form-control" value="${Safe.html(courtNumbers)}" placeholder="VD: Sân 1 (1 sân)">
          </div>
        </div>

        <div class="responsive-form-row">
          <div class="form-group" style="flex: 1.2;">
            <label class="form-label font-bold"><i class="fas fa-money-bill-wave text-primary"></i> Tiền sân dự tính (VNĐ)</label>
            <input type="number" id="edit-loc-court-price" class="form-control" value="${Safe.html(courtPrice)}" placeholder="180000" step="10000">
          </div>
          <div class="form-group" style="flex: 1.2;">
            <label class="form-label font-bold"><i class="fas fa-feather-alt text-primary"></i> Loại cầu sử dụng</label>
            <input type="text" id="edit-loc-shuttle-type" class="form-control" value="${Safe.html(shuttleType)}" placeholder="n/a">
          </div>
        </div>

        <div class="form-group">
          <div class="flex items-center justify-between" style="margin-bottom: 0.35rem;">
            <label class="form-label font-bold" style="margin-bottom: 0;"><i class="fas fa-location-arrow text-primary"></i> Địa chỉ chi tiết sân *</label>
            <div class="flex gap-2">
              ${targetId !== 'club' ? `
                <button type="button" class="btn btn-outline-primary btn-xs" onclick="ScheduleModule.fillClubAddressInModal()">
                  <i class="fas fa-home"></i> Lấy địa chỉ CLB
                </button>
              ` : ''}
              <button type="button" class="btn btn-outline-secondary btn-xs" onclick="ScheduleModule.updateLiveMapPreview()">
                <i class="fas fa-sync"></i> Cập nhật bản đồ
              </button>
            </div>
          </div>
          <textarea id="edit-loc-address" class="form-control" rows="2" required placeholder="VD: 50/1 Tân Sơn, Phường 15, Quận Tân Bình, TP. Hồ Chí Minh" oninput="ScheduleModule.updateLiveMapPreview()">${Safe.html(courtAddress)}</textarea>
          <span class="text-secondary" style="font-size: 0.75rem; margin-top: 0.25rem; display: block;">
            Khung bản đồ bên dưới sẽ tự động tìm kiếm vị trí vệ tinh theo địa chỉ này.
          </span>
        </div>

        <div class="form-group">
          <div class="flex items-center justify-between" style="margin-bottom: 0.35rem;">
            <label class="form-label font-bold" style="margin-bottom: 0;"><i class="fas fa-link text-primary"></i> Link Google Maps (Tùy chọn)</label>
            <div class="flex gap-2">
              <button type="button" class="btn btn-outline-primary btn-xs" onclick="ScheduleModule.generateMapUrlInModal()">
                <i class="fas fa-magic"></i> Tạo link tự động
              </button>
              <button type="button" class="btn btn-outline-secondary btn-xs" onclick="ScheduleModule.testMapUrlFromModal()">
                <i class="fas fa-external-link-alt"></i> Mở thử Maps
              </button>
            </div>
          </div>
          <input type="url" id="edit-loc-map-url" class="form-control" value="${Safe.html(mapUrl)}" placeholder="https://maps.google.com/?q=...">
          <span class="text-secondary" style="font-size: 0.75rem; margin-top: 0.25rem; display: block;">
            Để trống hệ thống sẽ tự động tạo link mở ứng dụng Google Maps dẫn đường theo địa chỉ sân ở trên.
          </span>
        </div>

        <!-- Live Interactive Map Preview -->
        <div style="margin-top: 1rem;">
          <div class="flex justify-between items-center" style="margin-bottom: 0.35rem;">
            <label class="form-label font-bold" style="margin-bottom: 0;"><i class="fas fa-map text-primary"></i> Khung xem trước bản đồ Google Maps</label>
            <span class="badge badge-neutral" style="font-size: 0.7rem;">Live Preview</span>
          </div>
          <div class="court-map-embed-wrapper" style="height: 180px; border-radius: var(--radius-md); overflow: hidden; border: 1px solid var(--border-color);">
            <iframe 
              id="edit-loc-map-iframe"
              width="100%" 
              height="100%" 
              style="border:0;" 
              loading="lazy" 
              allowfullscreen 
              referrerpolicy="no-referrer-when-downgrade"
              src="https://maps.google.com/maps?q=${encodeURIComponent(resolvedSearchQuery)}&t=&z=15&ie=UTF8&iwloc=&output=embed">
            </iframe>
          </div>
        </div>

        <div class="modal-footer" style="padding: 1.25rem 0 0 0; margin-top: 1.25rem; border-top: 1px solid var(--border-color); display: flex; justify-content: flex-end; gap: 0.5rem;">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Hủy bỏ</button>
          <button type="submit" class="btn btn-primary">
            <i class="fas fa-save"></i> Lưu thông tin sân
          </button>
        </div>
      </form>
    `;

    App.openModal("✏️ Chỉnh sửa thông tin sân & tiền sân dự tính", modalBody, true);
  },

  updateLiveMapPreview() {
    const addrInput = document.getElementById('edit-loc-address');
    const nameInput = document.getElementById('edit-loc-court-name');
    const iframe = document.getElementById('edit-loc-map-iframe');
    if (!iframe) return;

    const query = (addrInput && addrInput.value.trim()) || (nameInput && nameInput.value.trim()) || 'San Cau Long';
    iframe.src = `https://maps.google.com/maps?q=${encodeURIComponent(query)}&t=&z=15&ie=UTF8&iwloc=&output=embed`;
  },

  fillClubAddressInModal() {
    const data = AppStorage.loadData();
    const clubAddr = (data.clubInfo && data.clubInfo.address) || "";
    const clubCourt = (data.clubInfo && data.clubInfo.defaultCourt) || "";
    const addrInput = document.getElementById('edit-loc-address');
    const nameInput = document.getElementById('edit-loc-court-name');
    if (addrInput) addrInput.value = clubAddr;
    if (nameInput && !nameInput.value.trim()) nameInput.value = clubCourt;
    this.updateLiveMapPreview();
    App.showToast("📍 Đã lấy thông tin sân nhà của CLB!", "info");
  },

  generateMapUrlInModal() {
    const addrInput = document.getElementById('edit-loc-address');
    const nameInput = document.getElementById('edit-loc-court-name');
    const mapUrlInput = document.getElementById('edit-loc-map-url');
    const query = (addrInput && addrInput.value.trim()) || (nameInput && nameInput.value.trim()) || 'San Cau Long';
    const generatedUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
    if (mapUrlInput) {
      mapUrlInput.value = generatedUrl;
      App.showToast("🧭 Đã sinh link Google Maps chuẩn!", "success");
    }
  },

  testMapUrlFromModal() {
    const mapUrlInput = document.getElementById('edit-loc-map-url');
    const addrInput = document.getElementById('edit-loc-address');
    const nameInput = document.getElementById('edit-loc-court-name');
    const url = (mapUrlInput && mapUrlInput.value.trim()) || 
      `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((addrInput && addrInput.value.trim()) || (nameInput && nameInput.value.trim()) || 'San Cau Long')}`;
    window.open(url, '_blank');
  },

  saveCourtLocation(e, targetId, optionId) {
    if (e && e.preventDefault) e.preventDefault();
    if (!AppStorage.can('schedule')) {
      App.showToast("Chỉ Quản trị viên (Admin) mới có quyền chỉnh sửa thông tin sân!", "warning");
      return;
    }

    const data = AppStorage.loadData();
    const name = (document.getElementById('edit-loc-court-name')?.value || '').trim();
    const numbers = (document.getElementById('edit-loc-court-numbers')?.value || '').trim();
    const price = parseInt(document.getElementById('edit-loc-court-price')?.value) || 0;
    const shuttle = (document.getElementById('edit-loc-shuttle-type')?.value || '').trim() || 'n/a';
    const address = (document.getElementById('edit-loc-address')?.value || '').trim();
    const mapUrlInput = (document.getElementById('edit-loc-map-url')?.value || '').trim();
    const mapUrl = mapUrlInput || (address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}` : '');

    if (!name) {
      App.showToast("Vui lòng nhập tên sân cầu lông!", "warning");
      return;
    }

    if (targetId === 'club') {
      if (!data.clubInfo) data.clubInfo = {};
      data.clubInfo.defaultCourt = name;
      data.clubInfo.address = address;
      data.clubInfo.mapUrl = mapUrl;
      data.clubInfo.defaultCourtPrice = price;
      if (numbers) data.clubInfo.courtNumbers = numbers;

      AppStorage.saveData(data, true);
      App.closeModal();

      // Cập nhật form cài đặt nếu đang mở
      const setCourt = document.getElementById('set-court-default');
      const setAddr = document.getElementById('set-court-address');
      const setMap = document.getElementById('set-court-map-url');
      if (setCourt) setCourt.value = name;
      if (setAddr) setAddr.value = address;
      if (setMap) setMap.value = mapUrl;

      if (window.App && typeof App.refreshDashboardStats === 'function') App.refreshDashboardStats();
      App.showToast("🎉 Đã cập nhật và lưu thông tin Sân nhà CLB thành công!", "success");
    } else {
      const session = (data.sessions || []).find(s => s.id === targetId);
      if (!session) {
        App.showToast("Không tìm thấy ca đặt sân để lưu!", "error");
        return;
      }

      if (optionId && session.options) {
        const opt = session.options.find(o => o.id === optionId);
        if (opt) {
          opt.courtName = name;
          opt.courtNumbers = numbers;
          opt.price = price;
          opt.shuttleType = shuttle;
          opt.courtAddress = address;
          opt.mapUrl = mapUrl;
        }
      } else {
        session.courtName = name;
        session.court = name;
        session.courtNumbers = numbers;
        session.courtPrice = price;
        session.shuttleType = shuttle;
        session.courtAddress = address;
        session.mapUrl = mapUrl;
      }

      AppStorage.saveData(data, true);
      App.closeModal();

      // Làm mới lại giao diện
      if (this.currentViewMode === 'calendar') {
        this.renderMonthCalendar();
      } else {
        this.renderSessions('sessions-container', this.currentFilter || 'upcoming');
      }
      this.renderSessions('schedule-upcoming-list', this.currentFilter || 'upcoming');
      if (window.App && typeof App.refreshDashboardStats === 'function') App.refreshDashboardStats();

      // Mở lại modal chi tiết của ca đánh vừa sửa để người dùng thấy ngay kết quả
      this.openSessionDetailsModal(targetId);
      App.showToast("🎉 Đã cập nhật thông tin sân, tiền sân và loại cầu thành công!", "success");
    }
  },
});
