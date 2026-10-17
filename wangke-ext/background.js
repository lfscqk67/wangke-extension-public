// 后台：系统通知、工具栏状态，以及给连播标签页“定时叫醒”
// 浏览器会大幅限制后台标签页里的定时器（可能一分钟才跑一次），
// 所以由后台每 30 秒主动通知连播标签页检查一次进度，切到别的网页时也能按时跳下一门。

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;
  if (msg.type === 'whoami') { sendResponse({ tabId }); return; }
  if (msg.type === 'notify') {
    chrome.notifications.create({
      type: 'basic', iconUrl: 'icon.png', title: '网课连播助手', message: msg.text, priority: 2,
    });
  }
  sendResponse && sendResponse(true);
});

// 定时叫醒连播标签页
const ALARM = 'lb-tick';
function syncAlarm() {
  chrome.storage.local.get(['running'], ({ running }) => {
    if (running) {
      chrome.storage.local.set({ health: {} });
      chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
      // 连播期间不让电脑睡眠（屏幕可以照常熄灭）；停止后恢复系统原来的设置
      chrome.power.requestKeepAwake('system');
    } else {
      chrome.alarms.clear(ALARM);
      chrome.power.releaseKeepAwake();
    }
  });
}
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== ALARM) return;
  chrome.storage.local.get(['running', 'controllerTab'], ({ running, controllerTab }) => {
    if (!running) { chrome.alarms.clear(ALARM); return; }
    if (controllerTab == null) return;
    chrome.tabs.sendMessage(controllerTab, { type: 'tick' }).catch(() => {});
    healthCheck(controllerTab);
  });
});

/* ---------- 卡死 / 网络故障重试 ----------
 * 每 30 秒检查一次连播标签页：
 *  - 页面没响应（网络错误页、页面卡死、扩展脚本没加载）→ 判定异常
 *  - 页面 1 分钟内一直没显示出来 → 判定异常
 *  - 视频在播放状态但 2 分钟进度不动（缓冲卡住）→ 判定异常
 * 判定异常就重新加载页面重试；连续 5 次重试都不行（约 3～5 分钟）就停止连播并提醒。 */
const SITE_HOME = 'https://gbwlxy.dtdjzx.gov.cn/content#/personalCenter';
const MAX_RETRY = 5;
async function healthCheck(tabId) {
  const { health = {} } = await chrome.storage.local.get(['health']);
  let reply = null;
  try { reply = await chrome.tabs.sendMessage(tabId, { type: 'ping' }); } catch (e) { reply = null; }

  let bad = false, why = '';
  if (!reply || !reply.ok) {
    // 页面切换的瞬间也可能收不到回应，连续两次（约 1 分钟）没回应才算异常
    health.noResp = (health.noResp || 0) + 1;
    if (health.noResp >= 2) { bad = true; why = '页面没有响应（可能是网络问题或页面卡死）'; }
  } else if (!reply.ready) {
    health.noResp = 0;
    health.notReady = (health.notReady || 0) + 1;
    if (health.notReady >= 2) { bad = true; why = '页面长时间没有显示出来'; }
  } else {
    health.notReady = 0; health.noResp = 0;
    const v = reply.video;
    if (v && !v.ended && !v.paused) {
      if (health.lastCt != null && Math.abs(v.ct - health.lastCt) < 1) health.stall = (health.stall || 0) + 1;
      else health.stall = 0;
      health.lastCt = v.ct;
      if (health.stall >= 4) { bad = true; why = '视频长时间卡住不动'; }
    } else { health.stall = 0; health.lastCt = null; }
  }

  if (!bad) {
    // 连续正常 2 分钟（4 次检查）才把重试次数清零，避免“刷新后好一会儿又卡”无限重试
    if (reply && reply.ok && reply.ready && !(health.stall > 0)) health.good = (health.good || 0) + 1;
    else health.good = 0;
    if (health.good >= 4) health.fail = 0;
    await chrome.storage.local.set({ health });
    return;
  }
  health.good = 0;

  health.fail = (health.fail || 0) + 1;
  health.notReady = 0; health.noResp = 0; health.stall = 0; health.lastCt = null;
  if (health.fail > MAX_RETRY) {
    await chrome.storage.local.set({ health: {}, running: false });
    chrome.notifications.create({
      type: 'basic', iconUrl: 'icon.png', title: '网课连播助手', priority: 2,
      message: `${why}，已重试 ${MAX_RETRY} 次仍不行，已停止连播。请检查网络后重新点“开始连播”。`,
    });
    return;
  }
  await chrome.storage.local.set({ health, syncPending: true });
  // 重试：页面还是网站页就整页刷新；变成了错误页等就重新打开个人中心（会接着读学时、开下一门）
  chrome.tabs.get(tabId, (t) => {
    if (chrome.runtime.lastError || !t) return;
    if (t.url && t.url.includes('gbwlxy.dtdjzx.gov.cn') && reply) chrome.tabs.reload(tabId);
    // 没回应（网络错误页或卡死）：重新打开网站，等于强制重新加载
    else chrome.tabs.update(tabId, { url: SITE_HOME });
  });
}

// 工具栏图标上显示状态：连播中显示绿色“播”
function updateBadge() {
  chrome.storage.local.get(['running'], ({ running }) => {
    chrome.action.setBadgeText({ text: running ? '播' : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#2e7d32' });
  });
}
chrome.storage.onChanged.addListener((c) => { if (c.running) { updateBadge(); syncAlarm(); } });
chrome.runtime.onStartup.addListener(() => { updateBadge(); syncAlarm(); });
chrome.runtime.onInstalled.addListener(() => { updateBadge(); syncAlarm(); });

// 连播标签页被关掉：停止连播
chrome.tabs.onRemoved.addListener((closedId) => {
  chrome.storage.local.get(['controllerTab'], ({ controllerTab }) => {
    if (closedId === controllerTab) chrome.storage.local.set({ running: false });
  });
});
