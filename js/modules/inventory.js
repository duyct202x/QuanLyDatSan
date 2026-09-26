// Shuttlecock Stock Inventory Module

const InventoryModule = {
  renderInventory() {
    const data = AppStorage.loadData();
    const inventory = data.inventory || [];

    const container = document.getElementById('inventory-list-container');
    if (!container) return;

    let totalTubes = 0;
    inventory.forEach(i => totalTubes += i.tubesInStock);

    const totalEl = document.getElementById('inventory-total-tubes');
    if (totalEl) totalEl.innerText = `${totalTubes} ống`;

    container.innerHTML = inventory.map(item => `
      <div class="inventory-card">
        <div class="stat-icon" style="background: rgba(16, 185, 129, 0.15); color: #10b981;">
          <i class="fas fa-feather-alt"></i>
        </div>
        <div class="font-bold" style="font-size: 1.1rem; margin-top: 0.25rem;">${item.brand}</div>
        <div class="inventory-tubes">${item.tubesInStock} <span style="font-size: 0.9rem; font-weight: 500; color: var(--text-secondary);">ống</span></div>
        <div class="text-secondary" style="font-size: 0.82rem;">
          Giá nhập: <strong>${item.pricePerTube.toLocaleString('vi-VN')} đ</strong> / ống
        </div>
        <div class="text-muted" style="font-size: 0.75rem;">
          Lần nhập gần nhất: ${item.lastRestocked}
        </div>

        <div style="display: flex; gap: 0.5rem; margin-top: 0.75rem; width: 100%;">
          <button class="btn btn-secondary btn-sm flex-1" onclick="InventoryModule.updateStock('${item.id}', -1)" title="Trừ 1 ống đã dùng">
            <i class="fas fa-minus"></i> Dùng 1 ống
          </button>
          <button class="btn btn-primary btn-sm flex-1" onclick="InventoryModule.updateStock('${item.id}', 1)" title="Nhập thêm 1 ống">
            <i class="fas fa-plus"></i> Nhập thêm
          </button>
        </div>
      </div>
    `).join('');
  },

  updateStock(itemId, delta) {
    const data = AppStorage.loadData();
    const item = (data.inventory || []).find(i => i.id === itemId);
    if (!item) return;

    const newStock = Math.max(0, item.tubesInStock + delta);
    item.tubesInStock = newStock;
    if (delta > 0) {
      item.lastRestocked = new Date().toISOString().slice(0, 10);
    }

    AppStorage.saveData(data);
    this.renderInventory();
    App.showToast(`Đã cập nhật kho cầu ${item.brand}: còn ${newStock} ống`, "info");
  }
};
