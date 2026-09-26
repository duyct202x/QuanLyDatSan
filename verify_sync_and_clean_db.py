import asyncio
import os
import sys
from playwright.async_api import async_playwright

async def run_test():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={'width': 1366, 'height': 768})
        page = await context.new_page()

        # Điều hướng tới trang web
        print("1. Mở trang web http://127.0.0.1:8080/index.html...")
        await page.goto("http://127.0.0.1:8080/index.html")
        await page.wait_for_timeout(2000)

        # Xóa localStorage cũ và tải CSDL sạch
        await page.evaluate("""() => {
            localStorage.clear();
            sessionStorage.clear();
            AppStorage.init();
        }""")
        await page.reload()
        await page.wait_for_timeout(2500)

        # 1. Kiểm tra trạng thái ban đầu khi chưa đăng nhập (Guest)
        guest_name = await page.inner_text("#header-user-name")
        print(f"2. Header khi chưa đăng nhập: '{guest_name}' (Mong đợi: 'Khách vãng lai')")
        assert "Khách" in guest_name, "Header guest name failed"

        # 2. Đăng nhập Admin
        print("3. Đăng nhập tài khoản Admin (admin / admin)...")
        await page.evaluate("""() => {
            AppStorage.login('admin', 'admin', true);
            App.renderUserHeaderAndSidebar();
            App.openTab('members');
        }""")
        await page.wait_for_timeout(1500)

        # 3. Kiểm tra tính đồng bộ giữa Sidebar, Header và Danh sách thành viên
        sidebar_name = await page.inner_text("#sidebar-user-name")
        header_name = await page.inner_text("#header-user-name")
        sidebar_avatar = await page.get_attribute("#sidebar-user-avatar", "src")
        header_avatar = await page.get_attribute("#header-user-avatar", "src")

        print(f"4. Sidebar Name: '{sidebar_name}', Header Name: '{header_name}'")
        print(f"   Sidebar Avatar: {sidebar_avatar[:40]}...")

        # Lấy thông tin trên thẻ thành viên Admin trong danh sách
        member_card_name = await page.inner_text(".member-roster-card h4")
        member_card_avatar = await page.get_attribute(".member-roster-card img.avatar", "src")
        print(f"   Member Card Name: '{member_card_name}'")
        print(f"   Member Card Avatar: {member_card_avatar[:40]}...")

        assert sidebar_name == member_card_name, f"Sidebar name '{sidebar_name}' != Member card name '{member_card_name}'"
        assert sidebar_avatar == member_card_avatar, "Sidebar avatar != Member card avatar"
        print("==> KẾT QUẢ ĐỒNG BỘ 1: Tài khoản đăng nhập và Thẻ thành viên khớp nhau 100%!")

        # 4. Thử cập nhật Hồ sơ cá nhân & Đổi Avatar của Admin
        print("5. Mở modal Hồ sơ cá nhân và đổi tên + avatar...")
        await page.evaluate("""() => {
            App.openUserProfileModal();
        }""")
        await page.wait_for_timeout(500)

        # Đổi tên thành "Nguyễn Văn Admin (SmashPro)"
        await page.fill("#profile-name", "Nguyễn Văn Admin (SmashPro)")
        
        # Chọn avatar thể thao thứ 3 trong bộ preset
        await page.click(".avatar-preset-item:nth-child(3)")
        await page.wait_for_timeout(300)
        
        # Lưu thay đổi
        await page.click("button[type='submit']")
        await page.wait_for_timeout(1500)

        # Kiểm tra sau khi đổi tên & avatar
        new_sidebar_name = await page.inner_text("#sidebar-user-name")
        new_header_name = await page.inner_text("#header-user-name")
        new_card_name = await page.inner_text(".member-roster-card h4")
        new_sidebar_avatar = await page.get_attribute("#sidebar-user-avatar", "src")
        new_card_avatar = await page.get_attribute(".member-roster-card img.avatar", "src")

        print(f"6. Sau khi cập nhật profile:")
        print(f"   Sidebar Name: '{new_sidebar_name}'")
        print(f"   Header Name: '{new_header_name}'")
        print(f"   Card Name: '{new_card_name}'")
        print(f"   Avatar khớp nhau: {new_sidebar_avatar == new_card_avatar}")

        assert new_sidebar_name == "Nguyễn Văn Admin (SmashPro)", "Sidebar name not updated"
        assert new_card_name == "Nguyễn Văn Admin (SmashPro)", "Card name not updated"
        assert new_sidebar_avatar == new_card_avatar, "Avatar not synced between user and card"
        print("==> KẾT QUẢ ĐỒNG BỘ 2: Cập nhật hồ sơ cá nhân đồng bộ tức thì trên toàn bộ giao diện!")

        # 5. Kiểm tra tính toàn vẹn sau khi F5 Reload
        print("7. F5 Reload trang để kiểm tra tính bền vững của dữ liệu...")
        await page.reload()
        await page.wait_for_timeout(2000)
        await page.evaluate("() => App.openTab('members')")
        await page.wait_for_timeout(1000)

        f5_sidebar_name = await page.inner_text("#sidebar-user-name")
        f5_card_name = await page.inner_text(".member-roster-card h4")
        f5_sidebar_avatar = await page.get_attribute("#sidebar-user-avatar", "src")
        f5_card_avatar = await page.get_attribute(".member-roster-card img.avatar", "src")

        assert f5_sidebar_name == "Nguyễn Văn Admin (SmashPro)", "F5 Sidebar name failed"
        assert f5_card_name == "Nguyễn Văn Admin (SmashPro)", "F5 Card name failed"
        assert f5_sidebar_avatar == f5_card_avatar, "F5 Avatar not synced"
        print("==> KẾT QUẢ ĐỒNG BỘ 3: Dữ liệu duy trì đồng bộ 100% sau khi Reload F5!")

        # Chụp ảnh bằng chứng
        os.makedirs("outputs/screenshots", exist_ok=True)
        screenshot_path = "outputs/screenshots/dong_bo_tai_khoan_va_du_lieu_thanh_cong.png"
        await page.screenshot(path=screenshot_path, full_page=False)
        print(f"8. Đã chụp ảnh màn hình kết quả tại: {screenshot_path}")

        await browser.close()
        print("\n🎉 TẤT CẢ CÁC BÀI KIỂM THỬ ĐỒNG BỘ ĐÃ THÀNH CÔNG XUẤT SẮC 100%!")

if __name__ == "__main__":
    asyncio.run(run_test())
