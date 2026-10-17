// 网课连播助手（内容脚本）
// 列表页：挑选未学习课程并打开；播放页：自动播放、1.5 倍速、播完回列表开下一门；
// 个人中心：读取平台已获学时。只在点了“开始连播”的那个标签页里工作。
// 本扩展不读取、不保存任何账号密码或个人信息，只记录课程名和学时数字。
(function () {
  'use strict';
  const isTop = window.top === window.self;
  const log = (...a) => console.log('[连播助手]', ...a);
  const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const textOf = (el) => (el.innerText || el.textContent || '').trim();
  const store = {
    get: (keys) => new Promise((r) => chrome.storage.local.get(keys, r)),
    set: (obj) => new Promise((r) => chrome.storage.local.set(obj, r)),
  };
  const send = (msg) => { try { chrome.runtime.sendMessage(msg); } catch (e) {} };

  const PC_URL = 'https://gbwlxy.dtdjzx.gov.cn/content#/personalCenter';
  const LIST_URL = 'https://gbwlxy.dtdjzx.gov.cn/content#/commendIndex';
  const onExamPage = () => location.hash.startsWith('#/examManage') || !!document.querySelector('.exitBtn');
  // 页面跳转：优先点网站自己的顶部菜单（单页应用正常切换）；
  // 测试页会挡住跳转，从测试页离开时改地址后整页刷新；菜单不可用时退回改地址
  // 目标页面是否已真正显示出来
  function pageReady(hash) {
    if (hash.startsWith('#/commendIndex')) return !!document.querySelector('.video-warp-start, .left-warp-classify0');
    if (hash.startsWith('#/personalCenter')) return /已完成[：:]/.test(textOf(document.body));
    if (hash.includes('coursedetail')) return !!document.querySelector('video');
    return true;
  }
  function go(url) {
    const target = '#' + url.split('#')[1];
    if (onExamPage()) { location.href = url; setTimeout(() => location.reload(), 500); return; }
    // 不点网站顶部菜单：它在部分页面会新开标签页。直接改地址，3 秒后不对就整页刷新
    location.href = url;
    // 3 秒后检查：地址没到或页面没切过来，就直接按目标地址整页刷新
    setTimeout(() => {
      if (!location.hash.startsWith(target)) { location.href = url; setTimeout(() => location.reload(), 300); }
      else if (!pageReady(target)) location.reload();
    }, 3000);
  }

  // 看门狗：地址到了但页面内容没切过来（单页应用偶发），超时就整页刷新
  let stuckKey = '', stuckSince = 0;
  function watchdog() {
    const h = location.hash;
    if (pageReady(h)) { stuckKey = ''; return false; }
    if (stuckKey !== h) { stuckKey = h; stuckSince = Date.now(); return false; }
    if (Date.now() - stuckSince > 12000) { log('页面没有正常显示，刷新'); stuckKey = ''; location.reload(); return true; }
    return false;
  }

  const CFG = {
    TODO_STATES: ['未学习', '学习中'],
    NEXT_TEXTS: ['下一节', '下一集', '下一章', '下一讲'],
    DIALOG_SEL: '.el-dialog__wrapper, .el-message-box__wrapper, [role="dialog"]',
    QUIZ_WORDS: ['答题', '题目', '作答', '单选', '多选', '判断', '您还在', '继续学习'],
    SCAN_MS: 3000,
    MAX_ATTEMPTS: 2,
  };

  // 只有点了“开始连播”的标签页执行连播
  let myTab = null;
  try { chrome.runtime.sendMessage({ type: 'whoami' }, (r) => { myTab = r && r.tabId; }); } catch (e) {}
  async function isActive() {
    const { running, controllerTab } = await store.get(['running', 'controllerTab']);
    return !!running && myTab != null && controllerTab === myTab;
  }

  /* ---------- 提醒：响铃 + 系统通知 + 标题闪烁 ---------- */
  let flashTimer = null;
  function alertCaregiver(text) {
    send({ type: 'notify', text });
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.4, 0.8].forEach((t) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 880; g.gain.value = 0.2; o.connect(g); g.connect(ctx.destination);
        o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.25);
      });
    } catch (e) {}
    if (isTop && !flashTimer) {
      const orig = document.title; let on = false;
      flashTimer = setInterval(() => (document.title = (on = !on) ? '【请协助】' + text : orig), 800);
      setTimeout(() => { clearInterval(flashTimer); flashTimer = null; document.title = orig; }, 60000);
    }
  }

  /* ---------- 弹窗处理 ---------- */
  // 平台的“最高 1.5 倍速”告知：仅为告知，自动点“我知道了”
  function dismissNotices() {
    document.querySelectorAll('.el-message-box__wrapper').forEach((w) => {
      if (!visible(w) || getComputedStyle(w).display === 'none') return;
      const t = textOf(w);
      if (t.includes('播放速度') && t.includes('1.5')) {
        const b = [...w.querySelectorAll('button')].find((x) => textOf(x) === '我知道了');
        if (b) { b.click(); log('已关闭倍速告知提示'); }
      }
    });
  }
  // 播放中出现答题/确认弹窗：只提醒，由陪护人员处理
  // 平台的“安全提示”（检测到异常脚本或插件，课程已停止）：扩展立即停止连播并提醒，不点掉、不绕过
  async function checkSecurityStop() {
    const w = [...document.querySelectorAll('.el-message-box__wrapper, .el-dialog__wrapper')].find((el) =>
      visible(el) && getComputedStyle(el).display !== 'none' && /异常脚本/.test(textOf(el)) && !textOf(el).includes('播放速度'));
    if (!w) return false;
    // 按平台提示的做法“刷新页面重新学习”；但 30 分钟内反复出现 3 次就停下来交给人处理
    const { secRefreshes = [] } = await store.get(['secRefreshes']);
    const recent = secRefreshes.filter((t) => Date.now() - t < 30 * 60 * 1000);
    if (recent.length >= 3) {
      await store.set({ running: false });
      log('安全提示反复出现，已停止连播');
      alertCaregiver('平台反复提示检测到插件，已停止连播，请人工查看');
      return true;
    }
    await store.set({ secRefreshes: [...recent, Date.now()] });
    log('平台弹出安全提示，按提示刷新页面重新学习');
    location.reload();
    return true;
  }

  let quizShown = false;
  function checkQuiz() {
    dismissNotices();
    const d = [...document.querySelectorAll(CFG.DIALOG_SEL)].find((el) => {
      if (!visible(el) || getComputedStyle(el).display === 'none') return false;
      const t = textOf(el);
      if (!t || t.includes('播放速度') || t.length > 4000) return false;
      return CFG.QUIZ_WORDS.some((w) => t.includes(w));
    });
    if (d && !quizShown) { quizShown = true; log('出现答题/确认弹窗'); alertCaregiver('出现答题/确认弹窗，请协助处理'); }
    if (!d && quizShown) quizShown = false;
    return !!d;
  }

  /* ---------- 播放页 ---------- */
  const handled = new WeakSet();
  let pausedSince = 0, endedHandled = false, endedAt = 0;
  const RATE = 1.5; // 平台上限 1.5 倍，超过会判定学时无效

  function setupVideo(v) {
    if (handled.has(v)) return;
    handled.add(v);
    endedHandled = false;
    let selfSet = false, rateLocked = false;
    const applyRate = () => {
      if (rateLocked || v.playbackRate === RATE) return;
      selfSet = true; v.playbackRate = RATE; setTimeout(() => (selfSet = false), 300);
    };
    v.addEventListener('ratechange', () => {
      if (!selfSet && v.playbackRate !== RATE) { rateLocked = true; log('平台限定倍速为', v.playbackRate); }
    });
    v.addEventListener('loadedmetadata', applyRate);
    v.addEventListener('playing', applyRate);
    // 有测试的课播完平台会自己跳到测试页，视频元素随之消失，所以结束事件也要兜底处理
    v.addEventListener('ended', () => setTimeout(onEnded, 3000));
    applyRate();
    if (v.paused && !v.ended) {
      v.play().catch(() => { v.muted = true; v.play().catch(() => {}); log('有声自动播放被拦截，已静音播放'); });
    }
    log('视频已接管，倍速', RATE);
  }

  function clickByText(texts) {
    for (const el of document.querySelectorAll('a,button,span,div,li')) {
      if (el.children.length > 2 || !visible(el)) continue;
      if (texts.includes(textOf(el))) { el.click(); return true; }
    }
    return false;
  }

  async function onEnded() {
    if (endedHandled) return;
    endedHandled = true;
    if (!(await isActive())) { endedHandled = false; return; }
    if (clickByText(CFG.NEXT_TEXTS)) { log('进入下一节'); endedHandled = false; return; }
    const { current, attempts = {} } = await store.get(['current', 'attempts']);
    if (current) {
      attempts[current.title] = 99; // 已看完，不再选它
      log('看完：', current.title);
    }
    // 看完一门就去个人中心刷新平台学时，然后回列表开下一门（本标签页直接跳转，不依赖后台）
    await store.set({ current: null, attempts, syncPending: true });
    go(PC_URL);
  }

  // 课程详情页上的“随堂测试： 是/否”
  function readTestFlag() {
    const m = textOf(document.body).match(/随堂测试[：:]\s*(是|否)/);
    return m ? m[1] === '是' : null;
  }

  async function playerTick() {
    const v = [...document.querySelectorAll('video')].find(visible);
    if (!v) return false;
    const running = await isActive();

    // 优先播放没有随堂测试的课程：新开的“未学习”课程若带测试，先跳过，等无测试的课都看完再回来看
    if (running && !handled.has(v)) {
      const { current, phase = 'noTest', testFlags = {} } = await store.get(['current', 'phase', 'testFlags']);
      if (current && current.state === '未学习' && phase === 'noTest') {
        const hasTest = readTestFlag();
        if (hasTest === null) return true; // 课程信息还没加载出来，先不播
        testFlags[current.title] = hasTest;
        await store.set({ testFlags });
        if (hasTest) {
          const { attempts = {} } = await store.get(['attempts']);
          attempts[current.title] = Math.max(0, (attempts[current.title] || 1) - 1);
          await store.set({ current: null, attempts });
          log('有随堂测试，先跳过：', current.title);
          go(LIST_URL);
          return true;
        }
      }
    }

    setupVideo(v);
    if (running) store.set({ beat: Date.now() }); // 心跳：告诉列表逻辑“这门课正在播”
    const quiz = checkQuiz();
    const inFront = document.visibilityState === 'visible' && document.hasFocus();
    // 平台规定课程窗口不在前台会暂停；扩展不对抗这一规则，只在窗口回到前台时自动继续
    if (running && !quiz && v.paused && !v.ended && !(v.duration > 0 && v.currentTime >= v.duration - 1) && document.visibilityState === 'visible') {
      v.play().catch(() => { v.muted = true; v.play().catch(() => {}); });
    }
    const finished = v.ended || (v.duration > 0 && v.paused && v.currentTime >= v.duration - 1);
    if (finished) { if (!endedAt) endedAt = Date.now(); if (v.ended || Date.now() - endedAt > 4000) onEnded(); return true; }
    endedAt = 0;
    if (v.paused && !quiz) {
      if (!pausedSince) pausedSince = Date.now();
      else if (Date.now() - pausedSince > 20000) {
        alertCaregiver(inFront ? '视频已暂停，请看看是否需要协助' : '课程窗口不在前台，平台已暂停播放，请切回课程窗口');
        pausedSince = Date.now() + 60000;
      }
    } else pausedSince = 0;
    return true;
  }

  /* ---------- 列表页 ---------- */
  function toMins(s) { // "6:48" → 6.8 分钟
    const p = String(s).split(':').map(Number);
    if (p.some(isNaN)) return 0;
    return p.length === 3 ? p[0] * 60 + p[1] + p[2] / 60 : p[0] + (p[1] || 0) / 60;
  }

  // 两种列表结构：课程推荐页 .video-warp-start；首页 li + .xx-button
  function readCards() {
    const out = [];
    document.querySelectorAll('.video-warp-start').forEach((card) => {
      const st = card.querySelector('.title-warp span, [class^="state-"]');
      const t = card.querySelector('p.title[title], [title]');
      const h = card.querySelector('.study-time');
      const d = card.querySelector('.study-min');
      if (st && t) out.push({ card, title: t.getAttribute('title'), state: textOf(st), hours: h ? parseFloat(textOf(h)) || 0 : 0, mins: d ? toMins(textOf(d)) : 0 });
    });
    document.querySelectorAll('.xx-button').forEach((b) => {
      const card = b.closest('li');
      if (!card) return;
      const t = card.querySelector('span[title]');
      const m = textOf(card).match(/学时[：:]\s*([\d.]+)/);
      const d = textOf(card).match(/时长[：:]\s*([\d:]+)/);
      if (t) out.push({ card, title: t.getAttribute('title'), state: textOf(b), hours: m ? parseFloat(m[1]) : 0, mins: d ? toMins(d[1]) : 0 });
    });
    return out;
  }

  async function findTodoCourses() {
    const { attempts = {}, phase = 'noTest', testFlags = {} } = await store.get(['attempts', 'phase', 'testFlags']);
    const ratio = (c) => (c.mins > 0 ? c.hours / c.mins : 0); // 每分钟学时，越高越先播
    return readCards()
      .filter((c) => visible(c.card) && CFG.TODO_STATES.includes(c.state))
      .filter((c) => (attempts[c.title] || 0) < CFG.MAX_ATTEMPTS)
      // 第一轮只播无随堂测试的（已知有测试的跳过）；“学习中”的不受限制，先接着看完
      .filter((c) => phase !== 'noTest' || c.state === '学习中' || testFlags[c.title] !== true)
      .sort((a, b) => {
        const s = (b.state === '学习中') - (a.state === '学习中');
        if (s) return s;
        // 已知无测试的排前面，未知的其次
        const ta = testFlags[a.title] === false ? 1 : 0, tb = testFlags[b.title] === false ? 1 : 0;
        return (tb - ta) || ratio(b) - ratio(a);
      });
  }

  let opening = false, emptyTicks = 0, lastFirst = null;
  async function openNext() {
    if (opening) return;
    if (!(await isActive())) return;
    if (location.hash.includes('coursedetail')) return;
    const s = await store.get(['hours', 'target', 'attempts', 'current', 'beat', 'phase']);
    if (s.current && (Date.now() - (s.beat || 0) < 45000 || Date.now() - (s.current.openedAt || 0) < 60000)) return;
    // 首页课程会在新标签页打开：统一转到“课程推荐”页（课程在同一标签页打开）
    if (location.pathname.startsWith('/index') || location.pathname === '/') {
      go(LIST_URL);
      return;
    }
    if (!location.hash.startsWith('#/commendIndex')) { go(LIST_URL); return; }
    if ((s.hours || 0) >= (s.target || 50)) {
      await store.set({ running: false });
      alertCaregiver(`已获 ${s.hours} 学时，达到年度目标，已停止`);
      return;
    }
    const list = await findTodoCourses();
    if (!list.length) {
      if (!readCards().length) { emptyTicks = 0; return; } // 列表还没渲染出来
      if (++emptyTicks < 2) return;
      emptyTicks = 0;
      const nextBtn = document.querySelector('.el-pagination .btn-next:not([disabled])');
      if (nextBtn) { log('本页没有可播课程，翻到下一页'); nextBtn.click(); return; }
      if ((s.phase || 'noTest') === 'noTest') {
        // 无测试的课都看完了，开始播有测试的
        log('无随堂测试的课程已播完，开始播放有测试的课程');
        await store.set({ phase: 'all' });
        go(LIST_URL);
        return;
      }
      await store.set({ running: false });
      alertCaregiver('课程推荐里已没有未学习的课程，已停止');
      return;
    }
    emptyTicks = 0;
    // 列表刚渲染时可能再刷新一次：同一个卡片元素连续两次扫描都在才点
    if (list[0].card !== lastFirst || !list[0].card.isConnected) { lastFirst = list[0].card; return; }
    opening = true;
    const c = list[0];
    const attempts = s.attempts || {};
    attempts[c.title] = (attempts[c.title] || 0) + 1;
    await store.set({ attempts, current: { title: c.title, hours: c.hours, state: c.state, openedAt: Date.now() }, beat: 0 });
    send({ type: 'registerList', url: LIST_URL });
    log('打开课程：', c.title, c.hours + '学时');
    (c.card.querySelector('img') || c.card.querySelector('[title]') || c.card).click();
    // 进了课程页但播放器没显示出来：直接刷新这一页
    setTimeout(() => { if (location.hash.includes('coursedetail') && !pageReady(location.hash)) location.reload(); }, 4000);
    setTimeout(async () => {
      // 8 秒后还在列表页：点击没生效，撤销本次记录，下一轮重试
      if (!location.hash.includes('coursedetail')) {
        const st = await store.get(['attempts', 'current']);
        if (st.current && st.current.title === c.title) {
          const at = st.attempts || {}; at[c.title] = Math.max(0, (at[c.title] || 1) - 1);
          await store.set({ current: null, attempts: at });
        }
        lastFirst = null;
      }
      opening = false;
    }, 8000);
  }

  /* ---------- 个人中心：读取平台已获学时 ---------- */
  async function syncFromPersonalCenter() {
    if (!location.hash.startsWith('#/personalCenter')) return false;
    const body = textOf(document.body);
    const done = body.match(/已完成[：:]\s*([\d.]+)\s*学时/);
    if (!done) return false;
    const total = body.match(/总学时[：:]\s*([\d.]+)\s*学时/);
    const upd = { hours: parseFloat(done[1]), lastSyncAt: Date.now() };
    if (total) upd.target = parseFloat(total[1]);
    await store.set(upd);
    return true;
  }

  async function handleSync() {
    const { syncPending } = await store.get(['syncPending']);
    if (!syncPending) return false;
    if (!location.hash.startsWith('#/personalCenter')) {
      const pv = document.querySelector('video');
      if (location.hash.includes('coursedetail') && pv && !(pv.ended || (pv.duration > 0 && pv.currentTime >= pv.duration - 1))) return false;
      go(PC_URL);
      return true;
    }
    if (await syncFromPersonalCenter()) {
      const { hours, target } = await store.get(['hours', 'target']);
      log('平台已获学时：', hours, '/', target);
      await store.set({ syncPending: false });
      go(LIST_URL);
    }
    return true;
  }

  async function topTick() {
    await syncFromPersonalCenter(); // 任何时候打开个人中心都顺便刷新学时
    if (!(await isActive())) return;
    dismissNotices();
    if (await checkSecurityStop()) return;
    if (watchdog()) return;
    if (location.hash.startsWith('#/examManage')) {
      // 播完后平台自动打开了随堂测试：先离开，测试留给陪护人员在“个人中心-我的课程”里集中做
      const { current, attempts = {} } = await store.get(['current', 'attempts']);
      if (current) attempts[current.title] = 99;
      await store.set({ current: null, attempts, syncPending: true });
      log('离开随堂测试页，继续下一门');
      go(PC_URL);
      return;
    }
    if (await handleSync()) return;
    if (await playerTick()) return;
    openNext();
  }

  // 点“停止”（或扩展自动停止）时，连播标签页里的视频也立即暂停
  chrome.storage.onChanged.addListener(async (changes) => {
    if (!changes.running || changes.running.newValue !== false) return;
    const { controllerTab } = await store.get(['controllerTab']);
    if (myTab == null || controllerTab !== myTab) return;
    document.querySelectorAll('video').forEach((v) => { if (!v.paused) v.pause(); });
    log('已停止连播，视频已暂停');
  });

  window.addEventListener('hashchange', () => { endedHandled = false; endedAt = 0; pausedSince = 0; });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // 后台健康检查：报告页面是否正常显示、视频是否在走
    if (msg.type === 'ping' && isTop) {
      const v = [...document.querySelectorAll('video')].find(visible);
      sendResponse({
        ok: true,
        hash: location.hash.split('?')[0],
        ready: pageReady(location.hash),
        video: v ? { ct: v.currentTime, paused: v.paused, ended: v.ended || (v.duration > 0 && v.currentTime >= v.duration - 1) } : null,
      });
      return;
    }
    if (msg.type === 'next' && isTop) { opening = false; lastFirst = null; setTimeout(topTick, 500); }
    if (msg.type === 'tick' && isTop) topTick(); // 后台定时叫醒（标签页在后台时页面定时器会被浏览器限速）
  });

  if (isTop) setInterval(topTick, CFG.SCAN_MS);
  else setInterval(async () => { if (await isActive()) playerTick(); }, CFG.SCAN_MS);
})();
