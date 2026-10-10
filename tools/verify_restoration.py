import asyncio
import json
import subprocess
import os
import time
import urllib.request
import websockets
import base64
import sys

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

edge_path = r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if not os.path.exists(edge_path):
    edge_path = r'C:\Program Files\Microsoft\Edge\Application\msedge.exe'

user_data_dir = r'c:\Users\Dcatrus\Documents\Projects\QuanLyDatSan\scratch\cdp_restore_test'

proc = subprocess.Popen([
    edge_path,
    '--headless',
    '--remote-debugging-port=9222',
    f'--user-data-dir={user_data_dir}',
    '--window-size=1280,960',
    'about:blank'
])
time.sleep(2.0)

async def test_and_screenshot():
    req = urllib.request.urlopen('http://127.0.0.1:9222/json')
    tabs = [t for t in json.loads(req.read().decode('utf-8')) if t.get('type') == 'page']
    ws_url = tabs[0]['webSocketDebuggerUrl']
    
    msg_id = 0
    async def send_cmd(ws, method, params=None):
        nonlocal msg_id
        msg_id += 1
        payload = {'id': msg_id, 'method': method}
        if params: payload['params'] = params
        await ws.send(json.dumps(payload))
        while True:
            resp = json.loads(await ws.recv())
            if resp.get('id') == msg_id: return resp

    def get_val(resp):
        res = resp.get('result', {}).get('result', {})
        return res.get('value', res.get('description', res))

    async with websockets.connect(ws_url) as ws:
        await send_cmd(ws, 'Page.enable')
        await send_cmd(ws, 'Runtime.enable')
        await ws.send(json.dumps({'id': 999, 'method': 'Page.navigate', 'params': {'url': 'http://localhost:8080/index.html'}}))
        while True:
            msg = json.loads(await ws.recv())
            if msg.get('method') == 'Page.loadEventFired': break
        await asyncio.sleep(2.0)

        # Pull from cloud and re-render
        await send_cmd(ws, 'Runtime.evaluate', {
            'expression': """(async () => {
                await AppStorage.pullFromCloud(false);
                if (window.App) {
                    App.renderUserHeaderAndSidebar();
                    App.renderAll();
                }
            })()""",
            'awaitPromise': True
        })
        await asyncio.sleep(1.0)

        # Capture dashboard screenshot
        shot_resp = await send_cmd(ws, 'Page.captureScreenshot', {'format': 'png'})
        img_data = shot_resp.get('result', {}).get('data', '')
        if img_data:
            out_path = r'c:\Users\Dcatrus\Documents\Projects\QuanLyDatSan\scratch\restored_dashboard.png'
            with open(out_path, 'wb') as f:
                f.write(base64.b64decode(img_data))
            print(f"Dashboard screenshot saved to {out_path}")

        # Check members and sessions in state
        res = await send_cmd(ws, 'Runtime.evaluate', {
            'expression': """(() => {
                const data = AppStorage.loadData();
                return {
                    clubName: data.clubInfo?.name,
                    membersCount: data.members?.length,
                    membersList: (data.members || []).map(m => m.name),
                    sessionsCount: data.sessions?.length,
                    sessionsList: (data.sessions || []).map(s => `${s.date}: ${s.title}`)
                };
            })()""",
            'returnByValue': True
        })
        print("DOM State Result:", json.dumps(get_val(res), ensure_ascii=False, indent=2))

try:
    asyncio.run(test_and_screenshot())
finally:
    proc.terminate()
