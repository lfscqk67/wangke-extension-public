// 工具栏按钮弹窗：开始 / 停止连播
const SITE = 'gbwlxy.dtdjzx.gov.cn';
const START_URL = 'https://gbwlxy.dtdjzx.gov.cn/content#/personalCenter';
const $ = (id) => document.getElementById(id);

function render() {
  chrome.storage.local.get(['running', 'hours', 'target', 'lastSyncAt', 'current', 'health'], (s) => {
    const hours = s.hours ?? 0, target = s.target ?? 50;
    const pct = Math.min(100, Math.round((hours / target) * 100));
    $('hours').textContent = hours;
    $('target').textContent = target;
    $('bar').style.width = pct + '%';
    $('pct').textContent = pct + '%';
    $('sync').textContent = s.lastSyncAt
      ? '更新于 ' + new Date(s.lastSyncAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      : '尚未读取';
    $('pill').textContent = s.running ? '连播中' : '已停止';
    $('pill').className = 'pill' + (s.running ? ' on' : '');
    const retry = s.health && s.health.fail ? s.health.fail : 0;
    $('now').textContent = retry ? `页面加载异常，正在重试（第 ${retry} 次，最多 5 次）` : (s.current ? '正在播放：' + s.current.title : '');
    $('now').className = 'now' + (s.running && (s.current || retry) ? ' show' : '');
    $('btn').textContent = s.running ? '停止' : '开始连播';
    $('btn').className = s.running ? 'stop' : '';
  });
}

$('btn').onclick = async () => {
  const { running } = await chrome.storage.local.get(['running']);
  if (running) {
    await chrome.storage.local.set({ running: false });
    render();
    return;
  }
  // 在当前标签页连播；当前页不是网课网站就在当前标签页打开它
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // 没看完的课清掉“尝试次数”，只保留已看完的记录，避免中途停止过的课被永久跳过
  const { attempts = {} } = await chrome.storage.local.get(['attempts']);
  const kept = {}; for (const k in attempts) if (attempts[k] >= 99) kept[k] = 99;
  await chrome.storage.local.set({
    running: true, controllerTab: tab.id, listTabId: tab.id,
    current: null, beat: 0, syncPending: true, phase: 'noTest', attempts: kept,
  });
  if (!tab.url || !tab.url.includes(SITE)) {
    await chrome.tabs.update(tab.id, { url: START_URL });
  } else {
    chrome.tabs.sendMessage(tab.id, { type: 'next' }).catch(() => {});
  }
  window.close();
};

render();
chrome.storage.onChanged.addListener(render);
