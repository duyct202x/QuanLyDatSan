// RolesModule - Vai trò tùy chỉnh & phân quyền (chỉ Admin)
// - Vai trò lưu ở clubInfo.roles: [{ id, name, perms: ['schedule'|'members'|'finance'] }]
// - Gán cho người dùng bằng users[].roleId (hộp thoại sửa thành viên). Máy chủ kiểm quyền thật; giao diện chỉ ẩn/hiện nút.
// - Admin/Thủ quỹ hệ thống luôn có đủ quyền; vai trò tùy chỉnh không bao giờ cấp quyền Cài đặt, sao lưu hay đặt lại mật khẩu.
const RolesModule = {
  MAX_ROLES: 20,
  NAME_MAX: 40,
  DESCRIPTIONS: {
    schedule: 'Tạo/sửa/xóa buổi đánh, đổi trạng thái, lịch bình chọn tự động',
    members: 'Thêm/sửa/xóa thành viên thường (không cấp tài khoản, không đổi vai trò)',
    finance: 'Thu quỹ, duyệt đóng quỹ, sổ thu chi, chia tiền sân'
  },

  roles() {
    const list = (AppStorage.loadData().clubInfo || {}).roles;
    return Array.isArray(list) ? list.filter((r) => r && r.id && r.name) : [];
  },

  holders(roleId, data) {
    return (data.users || []).filter((u) => u.roleId === roleId);
  },

  renderPanel() {
    const box = document.getElementById('roles-panel');
    if (!box) return;
    if (!AppStorage.isSuperAdmin()) { box.innerHTML = ''; return; }
    const data = AppStorage.loadData();
    const rows = this.roles().map((r) => {
      const n = this.holders(r.id, data).length;
      const perms = (r.perms || []).map((p) => `<span class="badge badge-info" style="font-size: 0.68rem;">${Safe.html(AppStorage.PERM_LABELS[p] || p)}</span>`).join(' ') || '<span class="text-secondary" style="font-size: 0.78rem;">Chưa có quyền nào</span>';
      return `
        <div class="flex items-center justify-between" style="gap: 0.75rem; padding: 0.6rem 0; border-top: 1px solid var(--border-color); flex-wrap: wrap;">
          <div style="min-width: 0; flex: 1;">
            <div class="font-bold">🎖️ ${Safe.html(r.name)} <span class="text-secondary" style="font-size: 0.78rem; font-weight: 400;">• ${n} người</span></div>
            <div style="display: flex; gap: 0.3rem; flex-wrap: wrap; margin-top: 0.25rem;">${perms}</div>
          </div>
          <div class="flex" style="gap: 0.4rem;">
            <button class="btn btn-secondary btn-sm" onclick="RolesModule.openEditor(${Safe.js(r.id)})" title="Sửa"><i class="fas fa-pen"></i></button>
            <button class="btn btn-outline-danger btn-sm" onclick="RolesModule.remove(${Safe.js(r.id)})" title="Xóa vai trò"><i class="fas fa-trash-alt"></i></button>
          </div>
        </div>`;
    }).join('');
    box.innerHTML = `
      <div class="card" style="padding: 1rem 1.25rem; margin-bottom: 1rem;">
        <div class="flex items-center justify-between" style="gap: 0.75rem; flex-wrap: wrap;">
          <div class="font-bold"><i class="fas fa-user-shield text-primary"></i> Vai trò & quyền (${this.roles().length})</div>
          <button class="btn btn-primary btn-sm" onclick="RolesModule.openEditor()"><i class="fas fa-plus"></i> Thêm vai trò</button>
        </div>
        <div class="text-secondary" style="font-size: 0.8rem; margin-top: 0.35rem;">Tự đặt tên vai trò (VD: "Thư ký", "Kế toán") và chọn quyền được giao, rồi gán cho thành viên trong hộp thoại sửa thành viên. Các quyền Cài đặt, sao lưu, đặt lại mật khẩu luôn chỉ thuộc Admin.</div>
        ${rows || '<div class="text-secondary" style="font-size: 0.82rem; margin-top: 0.5rem;">Chưa có vai trò tùy chỉnh.</div>'}
        <div style="border-top: 1px solid var(--border-color); margin-top: 0.75rem; padding-top: 0.75rem;">
          <button class="btn btn-secondary btn-sm" onclick="RolesModule.openAudit()"><i class="fas fa-clipboard-list"></i> Nhật ký thao tác</button>
          <span class="text-secondary" style="font-size: 0.78rem; margin-left: 0.4rem;">Ai đã sửa gì (chỉ Ban quản trị và người được giao quyền; không lưu nội dung).</span>
        </div>
      </div>`;
  },

  async openAudit() {
    if (!AppStorage.isSuperAdmin() || AppStorage.isLocalOnly()) { App.showToast('Nhật ký chỉ có khi kết nối máy chủ.', 'info'); return; }
    App.openModal('📋 Nhật ký thao tác', '<div class="text-secondary">Đang tải…</div>', true);
    const session = AppStorage._readSession();
    const res = await AppStorage._authRequest({ action: 'auditList', token: session && session.token });
    const body = document.getElementById('global-modal-body');
    if (!body) return;
    if (res.status !== 'ok') { body.innerHTML = `<div class="text-secondary">⚠️ ${Safe.html(res.message || 'Không tải được nhật ký.')}</div>`; return; }
    const names = { sessions: 'Buổi đánh', members: 'Thành viên', users: 'Tài khoản', transactions: 'Sổ quỹ', monthlyContributions: 'Quỹ tháng', club: 'Cài đặt CLB' };
    const ops = { put: 'Thêm/ghi đè', patch: 'Sửa', del: 'Xóa', reset: 'Đặt lại' };
    body.innerHTML = (res.entries || []).length ? `
      <div style="overflow-x: auto;"><table class="table" style="width: 100%; font-size: 0.8rem;">
        <thead><tr><th>Thời gian</th><th>Người làm</th><th>Thao tác</th><th>Đối tượng</th><th>Trường</th></tr></thead>
        <tbody>${res.entries.map((e) => `<tr><td>${Safe.html(e.at)}</td><td>${Safe.html(e.user)}<br><span class="text-secondary">${Safe.html(e.role)}</span></td><td>${Safe.html(ops[e.op] || e.op)}</td><td>${Safe.html(names[e.col] || e.col)}<br><span class="text-secondary">${Safe.html(e.key)}</span></td><td>${Safe.html(e.fields)}</td></tr>`).join('')}</tbody>
      </table></div>` : '<div class="text-secondary">Chưa có thao tác nào được ghi.</div>';
  },

  openEditor(roleId = null) {
    if (!AppStorage.isSuperAdmin()) return;
    const role = roleId ? this.roles().find((r) => r.id === roleId) : null;
    if (roleId && !role) return;
    const has = (p) => !!(role && (role.perms || []).includes(p));
    const body = `
      <form onsubmit="RolesModule.save(event, ${Safe.js(roleId || '')})">
        <div class="form-group">
          <label class="form-label font-bold" for="role-name">Tên vai trò *</label>
          <input type="text" id="role-name" class="form-control" maxlength="${this.NAME_MAX}" value="${Safe.html(role ? role.name : '')}" placeholder="VD: Thư ký, Kế toán, Phụ trách lịch" required>
        </div>
        <div class="form-group">
          <label class="form-label font-bold">Quyền được giao</label>
          ${AppStorage.PERMS.map((p) => `
            <label style="display: flex; align-items: flex-start; gap: 0.5rem; font-size: 0.85rem; cursor: pointer; margin-bottom: 0.5rem;">
              <input type="checkbox" class="role-perm" value="${p}" ${has(p) ? 'checked' : ''} style="margin-top: 0.2rem;">
              <span><b>${Safe.html(AppStorage.PERM_LABELS[p])}</b><br><span class="text-secondary" style="font-size: 0.78rem;">${Safe.html(this.DESCRIPTIONS[p])}</span></span>
            </label>`).join('')}
        </div>
        <div class="flex gap-2" style="justify-content: flex-end;">
          <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Hủy</button>
          <button type="submit" class="btn btn-primary"><i class="fas fa-save"></i> Lưu vai trò</button>
        </div>
      </form>`;
    App.openModal(role ? '🎖️ Sửa vai trò' : '🎖️ Thêm vai trò', body);
  },

  save(e, roleId) {
    if (e && e.preventDefault) e.preventDefault();
    if (!AppStorage.isSuperAdmin()) return;
    const name = (document.getElementById('role-name')?.value || '').trim().slice(0, this.NAME_MAX);
    if (!name) { App.showToast('Vui lòng nhập tên vai trò.', 'warning'); return; }
    const perms = Array.from(document.querySelectorAll('.role-perm:checked')).map((el) => el.value).filter((p) => AppStorage.PERMS.includes(p));
    const data = AppStorage.loadData();
    data.clubInfo = data.clubInfo || {};
    const list = this.roles();
    const lower = name.toLowerCase();
    if (list.some((r) => r.id !== roleId && r.name.trim().toLowerCase() === lower)) { App.showToast('Đã có vai trò trùng tên.', 'warning'); return; }
    if (!roleId && list.length >= this.MAX_ROLES) { App.showToast(`Tối đa ${this.MAX_ROLES} vai trò.`, 'warning'); return; }
    const id = roleId || `role_${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    const next = { id, name, perms };
    const idx = list.findIndex((r) => r.id === id);
    if (idx === -1) list.push(next); else list[idx] = next;
    data.clubInfo.roles = list;
    AppStorage.saveData(data);
    App.closeModal();
    App.showToast(`🎖️ Đã lưu vai trò "${name}".`, 'success');
    this.renderPanel();
    if (window.App && App.renderUserHeaderAndSidebar) App.renderUserHeaderAndSidebar();
  },

  async remove(roleId) {
    if (!AppStorage.isSuperAdmin()) return;
    const data = AppStorage.loadData();
    const role = this.roles().find((r) => r.id === roleId);
    if (!role) return;
    const holders = this.holders(roleId, data);
    if (!(await App.confirm(`Xóa vai trò "${role.name}"?` + (holders.length ? `\n${holders.length} người đang giữ vai trò này sẽ mất các quyền được giao.` : '')))) return;
    holders.forEach((u) => { delete u.roleId; });
    data.clubInfo.roles = this.roles().filter((r) => r.id !== roleId);
    AppStorage.saveData(data);
    App.showToast('🗑️ Đã xóa vai trò.', 'success');
    this.renderPanel();
  }
};

window.RolesModule = RolesModule;
