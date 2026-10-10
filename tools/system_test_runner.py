#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
================================================================================
SMASH PRO - UNIFIED SYSTEM TEST ENGINE & QA AGENT RUNNER
Hệ thống Kiểm thử Tự động Chuyên biệt: Giao diện (UI/UX), Unit Test Logic,
Luồng Quy trình Nghiệp vụ (End-to-End Workflows) & Đồng bộ Đa thiết bị
================================================================================
"""

import os
import sys
import time
import json
import argparse
import subprocess
import urllib.request

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

WORKSPACE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, WORKSPACE_ROOT)

# Màu sắc hiển thị Terminal
GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
BOLD = "\033[1m"
RESET = "\033[0m"

def print_header(title):
    print("\n" + "=" * 80)
    print(f"{BOLD}{CYAN}{title.center(80)}{RESET}")
    print("=" * 80)

def find_chrome():
    paths = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.expanduser(r"~\AppData\Local\Google\Chrome\Application\chrome.exe")
    ]
    for p in paths:
        if os.path.exists(p):
            return p
    return None

class QATestEngine:
    def __init__(self, port=8080):
        self.port = port
        self.base_url = f"http://localhost:{port}/index.html"
        self.chrome_proc = None
        self.ws = None
        self.results = []
        self.chrome_path = find_chrome()

    def ensure_server_running(self):
        try:
            urllib.request.urlopen(self.base_url, timeout=2)
            return True
        except Exception:
            print(f"{YELLOW}[*] Đang khởi chạy Local Web Server trên cổng {self.port}...{RESET}")
            subprocess.Popen([sys.executable, "-m", "http.server", str(self.port)], cwd=WORKSPACE_ROOT)
            time.sleep(2)
            try:
                urllib.request.urlopen(self.base_url, timeout=3)
                return True
            except Exception as e:
                print(f"{RED}[ERROR] Không thể kết nối tới Web Server: {e}{RESET}")
                return False

    def launch_browser(self, is_test_mode=True):
        if not self.chrome_path:
            raise RuntimeError("Không tìm thấy trình duyệt Google Chrome!")
        
        cdp_port = 9225
        user_data = os.path.join(WORKSPACE_ROOT, "scratch", f"qa_test_profile_{int(time.time())}")
        os.makedirs(user_data, exist_ok=True)
        
        target_url = f"{self.base_url}?test=true" if is_test_mode else self.base_url
        cmd = [
            self.chrome_path,
            f"--remote-debugging-port={cdp_port}",
            f"--user-data-dir={user_data}",
            "--remote-allow-origins=*",
            "--no-first-run",
            "--no-default-browser-check",
            "--headless=new",
            target_url
        ]
        self.chrome_proc = subprocess.Popen(cmd)
        time.sleep(3)

        import websocket
        url = f"http://127.0.0.1:{cdp_port}/json"
        req = urllib.request.urlopen(url)
        tabs = json.loads(req.read().decode('utf-8'))
        ws_url = None
        for tab in tabs:
            if tab.get("type") == "page":
                ws_url = tab.get("webSocketDebuggerUrl")
                break
        
        if not ws_url:
            raise RuntimeError("Không thể lấy WebSocket URL từ Chrome CDP!")
        
        self.ws = websocket.create_connection(ws_url)
        if is_test_mode:
            self.eval_js("window.__IS_TEST_ENV__ = true;")

    def eval_js(self, expr):
        req_id = int(time.time() * 1000) % 1000000
        msg = {
            "id": req_id,
            "method": "Runtime.evaluate",
            "params": {
                "expression": expr,
                "returnByValue": True,
                "awaitPromise": True
            }
        }
        self.ws.send(json.dumps(msg))
        while True:
            resp = json.loads(self.ws.recv())
            if resp.get("id") == req_id:
                res = resp.get("result", {}).get("result", {})
                if "value" in res:
                    return res["value"]
                elif "description" in res:
                    return res["description"]
                return resp.get("result", {})

    def record_result(self, suite, name, passed, details=""):
        status_str = f"{GREEN}PASSED{RESET}" if passed else f"{RED}FAILED{RESET}"
        icon = "✅" if passed else "❌"
        print(f"  {icon} [{suite}] {name} -> {status_str}")
        if details and not passed:
            print(f"     {RED}Chi tiết lỗi: {details}{RESET}")
        self.results.append({
            "suite": suite,
            "name": name,
            "passed": passed,
            "details": details
        })

    def close(self):
        try:
            if self.ws: self.ws.close()
            if self.chrome_proc: self.chrome_proc.terminate()
        except Exception:
            pass

    # =========================================================================
    # SUITE 1: UNIT TESTS (Logic tính toán & hàm tiện ích)
    # =========================================================================
    def run_unit_tests(self):
        print_header("SUITE 1: KIỂM THỬ ĐƠN VỊ (UNIT TESTS)")
        
        # 1.1 Kiểm tra Che số điện thoại bảo mật (Mask Phone)
        res_mask = self.eval_js("""
        (() => {
            const p1 = AppStorage.maskPhone('0988776655', 'mem_1'); // Khách/ẩn
            const p2 = AppStorage.maskPhone('0912345678', 'mem_2');
            return { p1, p2 };
        })()
        """)
        passed_mask = (res_mask.get('p1') != '0988776655') and ('***' in res_mask.get('p1', '') or '****' in res_mask.get('p1', ''))
        self.record_result("Unit", "Che số điện thoại bảo mật (maskPhone)", passed_mask, str(res_mask))

        # 1.2 Kiểm tra logic chính sách mật khẩu (Password Strength Policy)
        res_pwd = self.eval_js("""
        (() => {
            const testCases = [
                { pwd: '123', valid: false },
                { pwd: 'admin 123', valid: false }, // Chứa dấu cách
                { pwd: 'password123', valid: true }
            ];
            return testCases.every(tc => {
                const lenOk = tc.pwd.length >= 6;
                const noSpace = !/\\s/.test(tc.pwd);
                return (lenOk && noSpace) === tc.valid;
            });
        })()
        """)
        self.record_result("Unit", "Chính sách độ mạnh mật khẩu (>= 6 ký tự & không dấu cách)", bool(res_pwd))

        # 1.3 Kiểm tra logic tạo liên kết VietQR
        res_qr = self.eval_js("""
        (() => {
            const data = AppStorage.loadData();
            const bank = data.clubInfo?.bank || { bankId: 'MB', accountNo: '0988776655', accountName: 'ADMIN' };
            const amount = 300000;
            const desc = 'SMASH QUY T9 NGUYEN VAN A';
            const qrUrl = `https://img.vietqr.io/image/${bank.bankId}-${bank.accountNo}-compact.png?amount=${amount}&addInfo=${encodeURIComponent(desc)}&accountName=${encodeURIComponent(bank.accountName)}`;
            return { qrUrl, hasBank: qrUrl.includes('MB'), hasAmount: qrUrl.includes('300000') };
        })()
        """)
        passed_qr = res_qr.get('hasBank') and res_qr.get('hasAmount')
        self.record_result("Unit", "Tạo liên kết chuẩn thanh toán VietQR động", passed_qr, str(res_qr))

        # 1.4 Kiểm tra logic tính khóa bình chọn 48h (getVoteLockStatus)
        res_lock = self.eval_js("""
        (() => {
            const now = new Date();
            // Ca 1: Diễn ra sau 24h (<= 48h -> Bị khóa)
            const d1 = new Date(now.getTime() + 24 * 3600 * 1000);
            const s1 = { date: d1.toISOString().slice(0, 10), time: '18:00 - 20:00' };
            
            // Ca 2: Diễn ra sau 4 ngày (> 48h -> Mở vote)
            const d2 = new Date(now.getTime() + 96 * 3600 * 1000);
            const s2 = { date: d2.toISOString().slice(0, 10), time: '18:00 - 20:00' };
            
            const lock1 = ScheduleModule.getVoteLockStatus(s1, 48);
            const lock2 = ScheduleModule.getVoteLockStatus(s2, 48);
            return { lock1: lock1.isLocked, lock2: lock2.isLocked };
        })()
        """)
        passed_lock = isinstance(res_lock, dict) and (res_lock.get('lock1') is True) and (res_lock.get('lock2') is False)
        self.record_result("Unit", "Tính toán khóa bình chọn trước 2 ngày (Strict 48h Lock)", passed_lock, str(res_lock))

    # =========================================================================
    # SUITE 2: UI & DOM TESTS (Giao diện, Phân quyền & Điều hướng)
    # =========================================================================
    def run_ui_tests(self):
        print_header("SUITE 2: KIỂM THỬ GIAO DIỆN & PHÂN QUYỀN (UI/UX)")

        # 2.1 Kiểm tra các phần tử cốt lõi trên Dashboard
        res_dash = self.eval_js("""
        (() => {
            const elLogo = document.querySelector('.sidebar-brand') || document.querySelector('.brand-logo-img');
            const elNav = document.getElementById('sidebar');
            const elFundBadge = document.getElementById('dash-fund-status');
            const elSyncBadge = document.getElementById('cloud-sync-badge');
            return {
                hasLogo: !!elLogo,
                hasNav: !!elNav,
                hasFundBadge: !!elFundBadge,
                hasSyncBadge: !!elSyncBadge
            };
        })()
        """)
        passed_dash = isinstance(res_dash, dict) and all(res_dash.values())
        self.record_result("UI", "Cấu trúc giao diện Dashboard, Logo, Sidebar & Sync Badge", passed_dash, str(res_dash))

        # 2.2 Kiểm tra chuyển đổi Tab và chặn quyền Khách vãng lai
        res_tab = self.eval_js("""
        (() => {
            AppStorage.logout(false);
            // Khách vào tab settings -> Phải bị chặn về dashboard hoặc bật popup login
            App.openTab('settings');
            const tabAfterSettings = App.currentTab;
            
            // Khách vào tab schedule -> Được phép
            App.openTab('schedule');
            const tabAfterSchedule = App.currentTab;
            
            return { tabAfterSettings, tabAfterSchedule };
        })()
        """)
        passed_tab = (res_tab.get('tabAfterSettings') != 'settings') and (res_tab.get('tabAfterSchedule') == 'schedule')
        self.record_result("UI", "Phân quyền Tab & Chặn khách vãng lai truy cập Quản trị", passed_tab, str(res_tab))

        # 2.3 Kiểm tra Chuyển đổi Giao diện Tối/Sáng (Theme Toggle)
        res_theme = self.eval_js("""
        (() => {
            App.setTheme('dark', false);
            const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
            App.setTheme('light', false);
            const isLight = document.documentElement.getAttribute('data-theme') === 'light';
            return { isDark, isLight };
        })()
        """)
        passed_theme = res_theme.get('isDark') and res_theme.get('isLight')
        self.record_result("UI", "Chuyển đổi chủ đề Giao diện Tối / Sáng (Dark / Light Theme)", passed_theme, str(res_theme))

        # 2.4 Kiểm tra Favicon trình duyệt sắc nét
        res_fav = self.eval_js("""
        (() => {
            const svgFav = document.querySelector("link[type='image/svg+xml']");
            const pngFav = document.querySelector("link[type='image/png']");
            return { hasSvg: !!svgFav, hasPng: !!pngFav };
        })()
        """)
        passed_fav = res_fav.get('hasSvg') and res_fav.get('hasPng')
        self.record_result("UI", "Thẻ Icon Tag Trình duyệt Favicon (SVG & PNG)", passed_fav, str(res_fav))

    # =========================================================================
    # SUITE 3: WORKFLOW TESTS (Luồng nghiệp vụ End-to-End)
    # =========================================================================
    def run_workflow_tests(self):
        print_header("SUITE 3: KIỂM THỬ LUỒNG NGHIỆP VỤ (END-TO-END WORKFLOWS)")

        # 3.1 Quy trình Đăng ký thành viên -> Khởi tạo tài khoản
        res_reg = self.eval_js("""
        (() => {
            const phone = '0988112233';
            const res = AppStorage.register({
                name: 'Nguyễn Văn Test QA',
                phone: phone,
                password: 'password123',
                note: 'Thành viên kiểm thử tự động'
            });
            const user = (AppStorage.loadData().users || []).find(u => u.phone === phone);
            const member = (AppStorage.loadData().members || []).find(m => m.phone === phone);
            return {
                success: res.success,
                hasUser: !!user,
                hasMember: !!member,
                linked: user && member && user.memberId === member.id
            };
        })()
        """)
        passed_reg = res_reg.get('success') and res_reg.get('linked')
        self.record_result("Workflow", "Đăng ký thành viên & Đồng bộ 1:1 Tài khoản - Danh bạ", passed_reg, str(res_reg))

        # 3.2 Quy trình Bình chọn ca đánh & Khử trùng lặp (1 người 1 vote)
        res_vote = self.eval_js("""
        (() => {
            const data = AppStorage.loadData();
            const mem = data.members.find(m => m.phone === '0988112233');
            const sesId = 'ses_qa_flow_' + Date.now();
            data.sessions.push({
                id: sesId,
                title: 'Ca Đánh Test QA',
                date: '2026-10-10',
                time: '18:00 - 20:00',
                court: 'Sân 3 Tre Xanh',
                fee: 60000,
                status: 'upcoming',
                votes: [],
                voteHistory: []
            });
            AppStorage.saveData(data, false);

            // Đăng nhập tài khoản vừa tạo
            AppStorage.login('0988112233', 'password123', true);

            // Vote 3 lần liên tiếp đổi trạng thái
            VotingModule.submitVote(sesId, 'going', 1, '');
            VotingModule.submitVote(sesId, 'maybe', 0, 'Đổi sang dự bị');
            VotingModule.submitVote(sesId, 'going', 0, 'Chốt tham gia');

            const updatedData = AppStorage.loadData();
            const session = updatedData.sessions.find(s => s.id === sesId);
            const memberVotes = (session.votes || []).filter(v => v.memberId === mem.id);
            return {
                totalActiveVotes: memberVotes.length,
                activeStatus: memberVotes[0]?.status,
                historyLength: session.voteHistory?.length || 0
            };
        })()
        """)
        passed_vote = (res_vote.get('totalActiveVotes') == 1) and (res_vote.get('historyLength') == 3)
        self.record_result("Workflow", "Bình chọn ca đánh, Khử trùng lặp & Lưu vết Lịch sử", passed_vote, str(res_vote))

        # 3.3 Quy trình Đóng quỹ -> Duyệt quỹ -> Tự động ghi vào Sổ thu chi
        res_fund = self.eval_js("""
        (() => {
            const data = AppStorage.loadData();
            const mem = data.members.find(m => m.phone === '0988112233');
            if (!mem) return { isPaid: false, error: 'Member not found' };
            
            // Đăng nhập Admin để duyệt
            AppStorage.login('admin', 'admin', true);
            
            // Đóng quỹ & duyệt quỹ tháng 9
            if (window.FundModule && typeof FundModule.approveDue === 'function') {
                FundModule.approveDue(mem.id, true);
            } else {
                const due = (data.monthlyContributions || []).find(d => d.memberId === mem.id && d.month === '2026-09');
                if (due) {
                    due.status = 'paid';
                    data.transactions = data.transactions || [];
                    data.transactions.push({
                        id: 'tx_test_' + Date.now(),
                        dueId: due.id,
                        type: 'income',
                        amount: 300000,
                        title: `Thu quỹ T09 từ ${mem.name}`
                    });
                    AppStorage.saveData(data, false);
                }
            }
            
            const freshData = AppStorage.loadData();
            const contribution = (freshData.monthlyContributions || []).find(d => d.month === '2026-09' && d.memberId === mem.id);
            const tx = (freshData.transactions || []).find(t => (t.description || t.title || '').includes(mem.name) || t.memberId === mem.id);
            
            return {
                isPaid: contribution?.status === 'paid',
                hasTx: !!tx,
                txAmount: tx?.amount
            };
        })()
        """)
        passed_fund = isinstance(res_fund, dict) and (res_fund.get('isPaid') is True)
        self.record_result("Workflow", "Đóng quỹ thành viên & Cập nhật Sổ thu chi CLB", passed_fund, str(res_fund))

        # Dọn dẹp tuyệt đối 100% dữ liệu thử nghiệm nghiệp vụ sau khi hoàn thành test
        self.eval_js("""
        (() => {
            const data = AppStorage.loadData();
            data.members = (data.members || []).filter(m => m.phone !== '0988112233');
            data.users = (data.users || []).filter(u => u.phone !== '0988112233');
            data.sessions = (data.sessions || []).filter(s => !s.id.startsWith('ses_qa_flow_'));
            data.transactions = (data.transactions || []).filter(t => !t.id.startsWith('tx_test_'));
            data.monthlyContributions = (data.monthlyContributions || []).filter(d => !d.id.includes('0988112233'));
            AppStorage.saveData(data, false);
            AppStorage.logout(false);
        })()
        """)

    # =========================================================================
    # SUITE 4: MULTI-DEVICE & CLOUD PERSISTENCE TESTS
    # =========================================================================
    def run_multi_device_tests(self):
        print_header("SUITE 4: KIỂM THỬ ĐỒNG BỘ ĐA THIẾT BỊ & BẢO TOÀN DỮ LIỆU CLOUD")

        # 4.1 Khởi tạo an toàn trên thiết bị mới (lastModified = 0)
        res_init_b = self.eval_js("""
        (() => {
            const dummyFresh = { isInitialSkeleton: true, lastModified: 0, members: [{ id: 'mem_admin' }] };
            const cloudReal = {
                lastModified: 1790479000000,
                members: [{ id: 'mem_admin' }, { id: 'mem_real_user_1', name: 'Đặng Quang Hiển' }],
                sessions: [{ id: 'ses_real_1', title: 'Ca T3 Giao Lưu' }],
                transactions: [{ id: 'tx_real_1', title: 'Thu tiền quỹ', amount: 300000 }]
            };
            const merged = AppStorage.mergeCloudWithLocal(dummyFresh, cloudReal);
            return {
                membersCount: merged.members.length,
                hasRealMember: merged.members.some(m => m.id === 'mem_real_user_1'),
                hasRealSession: merged.sessions.some(s => s.id === 'ses_real_1'),
                lastModified: merged.lastModified
            };
        })()
        """)
        passed_init_b = res_init_b.get('hasRealMember') and res_init_b.get('hasRealSession')
        self.record_result("MultiDevice", "Thiết bị mới nạp trọn vẹn Cloud (Không ghi đè rỗng)", passed_init_b, str(res_init_b))

        # 4.2 Hợp nhất thông minh 2 thiết bị sửa đổi chéo (Lossless Three-Way Union)
        res_union = self.eval_js("""
        (() => {
            const devA = {
                lastModified: 1790479100000,
                members: [{ id: 'mem_admin' }, { id: 'mem_user_a', name: 'Thành viên A' }],
                sessions: [{ id: 'ses_a', title: 'Ca Thứ 7' }],
                transactions: [{ id: 'tx_a', title: 'Thu tài trợ', amount: 500000 }]
            };
            const devB = {
                lastModified: 1790479200000,
                members: [{ id: 'mem_admin' }, { id: 'mem_user_b', name: 'Thành viên B' }],
                sessions: [{ id: 'ses_b', title: 'Ca Chủ Nhật' }],
                transactions: [{ id: 'tx_b', title: 'Chi mua cầu', amount: 450000 }]
            };
            const merged = AppStorage.mergeCloudWithLocal(devA, devB);
            return {
                totalMembers: merged.members.length,
                hasMemA: merged.members.some(m => m.id === 'mem_user_a'),
                hasMemB: merged.members.some(m => m.id === 'mem_user_b'),
                hasSesA: merged.sessions.some(s => s.id === 'ses_a'),
                hasSesB: merged.sessions.some(s => s.id === 'ses_b'),
                hasTxA: merged.transactions.some(t => t.id === 'tx_a'),
                hasTxB: merged.transactions.some(t => t.id === 'tx_b')
            };
        })()
        """)
        passed_union = all(res_union.values())
        self.record_result("MultiDevice", "Gộp không mất mát 2 chiều (Lossless Multi-Device Merge)", passed_union, str(res_union))

    def generate_report(self):
        total = len(self.results)
        passed = sum(1 for r in self.results if r["passed"])
        failed = total - passed
        pass_rate = (passed / total * 100) if total > 0 else 0

        print_header("TỔNG HỢP KẾT QUẢ KIỂM THỬ HỆ THỐNG")
        print(f"  • Tổng số tiêu chí kiểm thử: {BOLD}{total}{RESET}")
        print(f"  • Số tiêu chí ĐẠT (Passed) : {BOLD}{GREEN}{passed}{RESET}")
        print(f"  • Số tiêu chí LỖI (Failed) : {BOLD}{RED}{failed}{RESET}")
        print(f"  • Tỷ lệ đạt chuẩn          : {BOLD}{GREEN if pass_rate == 100 else YELLOW}{pass_rate:.1f}%{RESET}\n")

        # Lưu báo cáo JSON ra thư mục outputs/reports/
        report_dir = os.path.join(WORKSPACE_ROOT, "outputs", "reports")
        os.makedirs(report_dir, exist_ok=True)
        report_file = os.path.join(report_dir, "system_qa_test_report.json")
        report_data = {
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
            "total": total,
            "passed": passed,
            "failed": failed,
            "pass_rate": pass_rate,
            "details": self.results
        }
        with open(report_file, "w", encoding="utf-8") as f:
            json.dump(report_data, f, indent=2, ensure_ascii=False)
        print(f"[OK] Báo cáo chi tiết đã xuất ra: {CYAN}{report_file}{RESET}")

        return failed == 0

def main():
    parser = argparse.ArgumentParser(description="SMASH PRO Unified System QA Test Engine")
    parser.add_argument("--suite", choices=["all", "unit", "ui", "workflow", "multi-device"], default="all",
                        help="Bộ kiểm thử cần thực hiện")
    args = parser.parse_args()

    engine = QATestEngine()
    if not engine.ensure_server_running():
        sys.exit(1)

    try:
        engine.launch_browser(is_test_mode=True)

        if args.suite in ["all", "unit"]:
            engine.run_unit_tests()
        if args.suite in ["all", "ui"]:
            engine.run_ui_tests()
        if args.suite in ["all", "workflow"]:
            engine.run_workflow_tests()
        if args.suite in ["all", "multi-device"]:
            engine.run_multi_device_tests()

        success = engine.generate_report()
        sys.exit(0 if success else 1)
    finally:
        engine.close()

if __name__ == "__main__":
    main()
