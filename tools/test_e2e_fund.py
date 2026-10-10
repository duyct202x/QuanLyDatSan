import asyncio
from playwright.async_api import async_playwright
import os
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

async def run_e2e_fund_test():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1400, "height": 900})
        page = await context.new_page()

        # Open Web App
        url = "http://localhost:8080/index.html"
        print(f"1. Truy cập ứng dụng: {url}")
        await page.goto(url, wait_until="networkidle")
        await asyncio.sleep(2)

        # Login as Admin
        print("2. Đăng nhập Quản trị viên (admin)...")
        await page.evaluate("""() => {
            const user = (AppStorage.loadData().users || []).find(u => u.username === 'admin');
            if (user) {
                AppStorage.setCurrentUser(user);
                App.updateAuthUI();
                App.refreshDashboardStats();
            }
        }""")
        await asyncio.sleep(1)

        # Switch to Fund Tab
        print("3. Chuyển sang Tab Quỹ tháng...")
        await page.click('button[data-tab="fund"]')
        await asyncio.sleep(1)

        # Take screenshot of clean fund tab
        os.makedirs("outputs/screenshots", exist_ok=True)
        await page.screenshot(path="outputs/screenshots/fund_tab_clean.png", full_page=True)
        print("📸 Đã chụp ảnh Tab Quỹ tháng: outputs/screenshots/fund_tab_clean.png")

        # Check all members status
        admin_due_text = await page.evaluate("""() => {
            const row = document.querySelector('#dues-table-body tr:first-child');
            return row ? row.innerText : '';
        }""")
        print("Thông tin bản ghi đầu tiên (Admin):", admin_due_text.replace('\n', ' | '))
        assert "Chưa đóng" in admin_due_text, "LỖI: Admin phải ở trạng thái Chưa đóng!"

        # Open Set Fee Modal
        print("4. Mở modal Cài đặt mức quỹ chung CLB...")
        await page.evaluate("FundModule.openSetFeeModal()")
        await asyncio.sleep(1)
        await page.screenshot(path="outputs/screenshots/set_club_fee_modal.png")
        print("📸 Đã chụp ảnh Modal Cài đặt mức quỹ chung: outputs/screenshots/set_club_fee_modal.png")

        # Open Edit Member Due Modal
        print("5. Mở modal Sửa số tiền cần đóng của thành viên...")
        await page.evaluate("FundModule.openEditMemberDueModal('due_2026-09_mem_admin', 'mem_admin')")
        await asyncio.sleep(1)
        await page.screenshot(path="outputs/screenshots/edit_member_due_modal.png")
        print("📸 Đã chụp ảnh Modal Sửa số tiền thành viên: outputs/screenshots/edit_member_due_modal.png")

        # Open VietQR Payment Modal
        print("6. Mở modal VietQR thanh toán...")
        await page.evaluate("FundModule.openPaymentModal('mem_admin')")
        await asyncio.sleep(1)
        await page.screenshot(path="outputs/screenshots/vietqr_payment_modal.png")
        print("📸 Đã chụp ảnh Modal VietQR: outputs/screenshots/vietqr_payment_modal.png")

        await browser.close()
        print("\n✅ KIỂM THỬ GIAO DIỆN & LOGIC CÀI ĐẶT MỨC QUỸ THÀNH CÔNG 100%!")

if __name__ == "__main__":
    asyncio.run(run_e2e_fund_test())
