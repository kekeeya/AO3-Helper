// ==UserScript==
// @name         AO3 Helper - Content Filter
// @namespace    ao3-helper
// @version      0.1.0
// @description  Hide AO3 search/listing results by tag/title/summary keyword rules, blocked work IDs, and read/bookmarked status
// @author       keya
// @homepageURL  https://github.com/kekeeya/AO3-Helper
// @match        https://archiveofourown.org/*
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // --- 由 AO3-helper-generator.html 生成，可以直接在这里手动改，也可以回配置页重新生成 ---
  const FILTER_RULES = [];
  const BLOCKED_WORK_IDS = [];
  const AO3_USERNAME = '';
  const AUTO_SYNC = false;
  // -----------------------------------------------------------------------------

  const FETCH_DELAY_MS = 1000;
  const SAVE_EVERY_N_PAGES = 5;
  const PAGES_PER_BATCH = 10;
  const BATCH_COOLDOWN_MS = 7000;
  const MAX_STORED_IDS = 5000;
  const NET_ERROR_STREAK_THRESHOLD = 5; // 连续几次网络失败才当成真的被拦截了，容忍偶发中断

  function getWorkId(workEl) {
    const link = workEl.querySelector('h4.heading a[href*="/works/"]');
    if (link) {
      const m = link.getAttribute('href').match(/\/works\/(\d+)/);
      if (m) return m[1];
    }
    const m2 = workEl.className.match(/work-(\d+)/);
    return m2 ? m2[1] : null;
  }

  // 只用来做"这条是不是明确早于水位线"的粗略判断，不追求精确到时分秒
  function getWorkDate(workEl, kind) {
    let text = '';
    if (kind === 'bookmarks') {
      const el = workEl.querySelector('.own.user.module.group .datetime');
      if (el) text = el.textContent.trim();
    } else {
      const heading = workEl.querySelector('h4.viewed.heading');
      if (heading) {
        const m = heading.textContent.match(/Last visited:\s*(\d{1,2}\s+\w+\s+\d{4})/);
        if (m) text = m[1];
      }
    }
    if (!text) return 0;
    const ts = Date.parse(text);
    return isNaN(ts) ? 0 : ts;
  }

  function getTagTexts(workEl) {
    return Array.from(workEl.querySelectorAll('a.tag')).map((a) => a.textContent.trim());
  }

  function getTitleText(workEl) {
    const heading = workEl.querySelector('h4.heading');
    if (!heading) return '';
    const titleLink = heading.querySelector('a[href*="/works/"]');
    return titleLink ? titleLink.textContent.trim() : '';
  }

  function getSummaryText(workEl) {
    const el = workEl.querySelector('blockquote.summary, blockquote.userstuff.summary');
    return el ? el.textContent.trim() : '';
  }

  function textMatches(text, keyword, mode) {
    if (!text) return false;
    const t = text.toLowerCase();
    const k = keyword.trim().toLowerCase();
    if (!k) return false;
    return mode === 'exact' ? t === k : t.includes(k);
  }

  function ruleMatchesWork(rule, texts) {
    const { keyword, scopes, mode } = rule;
    if (scopes.tag && texts.tag.some((t) => textMatches(t, keyword, mode))) return true;
    if (scopes.title && textMatches(texts.title, keyword, mode)) return true;
    if (scopes.summary && textMatches(texts.summary, keyword, mode)) return true;
    return false;
  }

  function getAllWorkEls() {
    return document.querySelectorAll('li.work.blurb, li.blurb.work');
  }

  // --- 手动屏蔽（在AO3页面上直接点，跟网页配置器里那份写死的名单各自独立） ---
  let manualBlockedList = []; // [{id, note}]，note记录点的时候抓到的标题，方便以后自己认
  let manualBlockedIdSet = new Set(); // 从上面派生，加快过滤时的查找

  function rebuildManualBlockedIdSet() {
    manualBlockedIdSet = new Set(manualBlockedList.map((e) => e.id));
  }

  async function removeManualBlock(workId) {
    manualBlockedIdSet.delete(workId);
    manualBlockedList = manualBlockedList.filter((entry) => entry.id !== workId);
    await GM.setValue('ao3Helper_manualBlockedIds', manualBlockedList);
  }

  // 跟removeManualBlock的区别：这个还要把页面上已经隐藏的work恢复显示，用于用户主动撤销
  async function undoManualWorkBlock(workId) {
    await removeManualBlock(workId);
    const placeholder = document.querySelector('.ao3-helper-manual-blocked-placeholder[data-workid="' + workId + '"]');
    if (placeholder) placeholder.remove();
    const workEl = Array.from(getAllWorkEls()).find((el) => getWorkId(el) === workId);
    if (workEl) {
      workEl.style.display = '';
      delete workEl.dataset.ao3HelperPlaceholderAdded;
      delete workEl.dataset.ao3HelperHardHidden;
      delete workEl.dataset.ao3HelperChecked;
    }
  }

  // 运行时可读写的屏蔽规则（点"[屏蔽此tag]"/"添加屏蔽词"都存这里），跟FILTER_RULES同一套匹配逻辑
  let manualBlockedTagRules = []; // [{keyword, scopes:{tag,title,summary}, mode:'exact'|'fuzzy'}]

  // 判断两条规则是不是"完全一样"（关键词忽略首尾空格+大小写，范围和模式都得一致），用于按具体规则删除
  function ruleKey(r) {
    return r.keyword.trim().toLowerCase() + '|' + r.mode + '|' + (r.scopes.tag ? 1 : 0) + (r.scopes.title ? 1 : 0) + (r.scopes.summary ? 1 : 0);
  }

  // 只比关键词文字（忽略首尾空格+大小写），同一个关键词不管范围/模式只允许存在一条规则
  function keywordTextKey(keyword) {
    return keyword.trim().toLowerCase();
  }

  function applyNewRuleToVisibleWorks(rule) {
    // 已处理过的元素会被跳过，所以新规则要在这里主动应用一次
    getAllWorkEls().forEach((workEl) => {
      if (workEl.dataset.ao3HelperHardHidden === '1') return;
      const texts = { tag: getTagTexts(workEl), title: getTitleText(workEl), summary: getSummaryText(workEl) };
      if (ruleMatchesWork(rule, texts)) {
        workEl.style.display = 'none';
        workEl.dataset.ao3HelperHardHidden = '1';
      }
    });
  }

  // 横幅"添加屏蔽词"弹窗提交、"[屏蔽此tag]"都走这里：关键词文字重复（不管范围/模式）就拒绝
  async function addManualKeywordRule(rule) {
    const newTextKey = keywordTextKey(rule.keyword);
    const isDuplicate = FILTER_RULES.some((r) => keywordTextKey(r.keyword) === newTextKey)
      || manualBlockedTagRules.some((r) => keywordTextKey(r.keyword) === newTextKey);
    if (isDuplicate) return 'duplicate';
    manualBlockedTagRules.push(rule);
    await GM.setValue('ao3Helper_manualBlockedTagRules', manualBlockedTagRules);
    applyNewRuleToVisibleWorks(rule);
    return 'added';
  }

  async function addManualTagRule(tagName) {
    return await addManualKeywordRule({ keyword: tagName, scopes: { tag: true, title: false, summary: false }, mode: 'exact' });
  }

  // 按规则key删除一条手动关键词规则：[屏蔽此tag]的撤销、屏蔽配置弹窗里的删除都走这里
  async function removeManualRuleByKey(targetKey) {
    manualBlockedTagRules = manualBlockedTagRules.filter((r) => ruleKey(r) !== targetKey);
    await GM.setValue('ao3Helper_manualBlockedTagRules', manualBlockedTagRules);
    // 重新检查已隐藏的作品，没有规则命中了就恢复显示
    getAllWorkEls().forEach((workEl) => {
      if (workEl.dataset.ao3HelperHardHidden !== '1') return;
      const workId = getWorkId(workEl);
      if (workId && manualBlockedIdSet.has(workId)) return; // 单独手动屏蔽的，不受这次影响
      if (workId && BLOCKED_WORK_IDS.includes(workId)) return; // 静态ID名单命中的，不受影响
      const texts = { tag: getTagTexts(workEl), title: getTitleText(workEl), summary: getSummaryText(workEl) };
      const stillMatches = FILTER_RULES.some((r) => ruleMatchesWork(r, texts))
        || manualBlockedTagRules.some((r) => ruleMatchesWork(r, texts));
      if (stillMatches) return; // 还有别的规则命中，继续隐藏
      workEl.style.display = '';
      delete workEl.dataset.ao3HelperHardHidden;
      delete workEl.dataset.ao3HelperChecked; // 让它有机会重新走一遍正常判断（含重新长出[屏蔽]链接）
    });
  }

  async function removeManualTagRule(tagName) {
    const targetTextKey = keywordTextKey(tagName);
    const match = manualBlockedTagRules.find((r) => keywordTextKey(r.keyword) === targetTextKey);
    if (!match) return;
    await removeManualRuleByKey(ruleKey(match));
  }

  function extractTagNameFromHeading(heading) {
    const link = heading.querySelector('a.tag') || heading.querySelector('a[href*="/tags/"]');
    if (link && link.textContent.trim()) return link.textContent.trim();
    const text = (heading.textContent || '').trim();
    // 退而求其次，从纯文本里按"Works in "切一刀（万一AO3哪天不用链接了）
    const m = text.match(/Works? in (.+)$/i);
    if (m) return m[1].trim();
    // 非common的tag，标题直接就是纯文本的tag名，没有链接也没有"Works in"这种前缀
    // （比如：<h2 class="heading">沈见青</h2>），这种情况整个标题文字本身就是tag名
    return text || null;
  }

  function renderTagBlockControl(heading, tagName) {
    const old = heading.querySelector('.ao3-helper-tagblock-wrap');
    if (old) old.remove();

    const wrap = document.createElement('span');
    wrap.className = 'ao3-helper-tagblock-wrap';
    wrap.style.cssText = 'margin-left:8px;font-size:13px;';

    if (manualBlockedTagRules.some((r) => keywordTextKey(r.keyword) === keywordTextKey(tagName))) {
      wrap.appendChild(document.createTextNode('（已屏蔽此tag）'));
      const undo = document.createElement('span');
      undo.className = 'ao3-helper-tagblock-undo-link';
      undo.dataset.tagname = tagName;
      undo.style.cssText = 'cursor:pointer;text-decoration:underline;color:#0a66c2;margin-left:4px;';
      undo.textContent = '[撤销]';
      wrap.appendChild(undo);
    } else {
      const link = document.createElement('span');
      link.className = 'ao3-helper-tagblock-link';
      link.dataset.tagname = tagName;
      link.style.cssText = 'cursor:pointer;color:#c0392b;';
      link.textContent = '[屏蔽此tag]';
      wrap.appendChild(link);
    }
    heading.appendChild(wrap);
  }

  function injectTagBlockControl() {
    if (!/^\/tags\//.test(location.pathname)) return; // 只在tag作品列表页生效
    const heading = document.querySelector('h2.heading');
    if (!heading || heading.dataset.ao3HelperTagControlAdded === '1') return;
    heading.dataset.ao3HelperTagControlAdded = '1';
    const tagName = extractTagNameFromHeading(heading);
    if (!tagName) return;
    if (FILTER_RULES.some((r) => keywordTextKey(r.keyword) === keywordTextKey(tagName))) {
      return; // 已经在脚本里永久屏蔽了（网页配置器里配置过，不管范围/模式），不需要任何交互提示
    }
    renderTagBlockControl(heading, tagName);
  }

  // 横幅"添加屏蔽词"弹窗，选项跟网页配置器里的"添加关键词"一致
  function showAddKeywordRuleDialog() {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);z-index:999998;display:flex;align-items:center;justify-content:center;font-family:sans-serif;';

    const modal = document.createElement('div');
    modal.style.cssText = 'background:#fff;color:#1d1d1f;padding:20px;border-radius:8px;width:320px;max-width:90vw;font-size:14px;box-shadow:0 4px 20px rgba(0,0,0,0.25);';

    const title = document.createElement('div');
    title.textContent = '添加屏蔽关键词';
    title.style.cssText = 'font-weight:600;font-size:16px;margin-bottom:14px;';
    modal.appendChild(title);

    const kwLabel = document.createElement('label');
    kwLabel.textContent = '关键词';
    kwLabel.style.cssText = 'display:block;font-size:13px;color:#6e6e73;margin-bottom:4px;';
    modal.appendChild(kwLabel);
    const kwInput = document.createElement('input');
    kwInput.type = 'text';
    kwInput.placeholder = '例如：角色名/配对/其他';
    kwInput.style.cssText = 'width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:6px;font-size:13px;box-sizing:border-box;margin-bottom:12px;';
    modal.appendChild(kwInput);

    const scopeLabel = document.createElement('div');
    scopeLabel.textContent = '扫描范围';
    scopeLabel.style.cssText = 'font-size:13px;color:#6e6e73;margin-bottom:4px;';
    modal.appendChild(scopeLabel);
    const scopeRow = document.createElement('div');
    scopeRow.style.cssText = 'display:flex;gap:14px;margin-bottom:12px;';
    const scopeCbs = {};
    [['tag', 'Tag', true], ['title', '标题', false], ['summary', '简介', false]].forEach(function (entry) {
      const key = entry[0];
      const label = entry[1];
      const def = entry[2];
      const wrap = document.createElement('label');
      wrap.style.cssText = 'display:flex;align-items:center;gap:4px;cursor:pointer;font-size:13px;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = def;
      scopeCbs[key] = cb;
      wrap.appendChild(cb);
      wrap.appendChild(document.createTextNode(label));
      scopeRow.appendChild(wrap);
    });
    modal.appendChild(scopeRow);

    const modeLabel = document.createElement('div');
    modeLabel.textContent = '匹配模式';
    modeLabel.style.cssText = 'font-size:13px;color:#6e6e73;margin-bottom:4px;';
    modal.appendChild(modeLabel);
    const modeSelect = document.createElement('select');
    modeSelect.style.cssText = 'width:100%;padding:6px 8px;border:1px solid #ddd;border-radius:6px;font-size:13px;box-sizing:border-box;margin-bottom:8px;';
    const fuzzyOpt = document.createElement('option');
    fuzzyOpt.value = 'fuzzy';
    fuzzyOpt.textContent = '模糊（包含）';
    const exactOpt = document.createElement('option');
    exactOpt.value = 'exact';
    exactOpt.textContent = '精准（完全匹配）';
    modeSelect.appendChild(fuzzyOpt);
    modeSelect.appendChild(exactOpt);
    modal.appendChild(modeSelect);

    const modeHint = document.createElement('div');
    modeHint.style.cssText = 'font-size:12px;color:#6e6e73;margin-bottom:10px;line-height:1.4;';
    modeHint.textContent = '例：对于关键词AB, 精准模式下只屏蔽AB, 即tag/title/summary完整文字与关键词一模一样才会屏蔽; 模糊模式会屏蔽AB, ABA, BAB, 即只要包含AB就屏蔽。';
    modal.appendChild(modeHint);

    const errorMsg = document.createElement('div');
    errorMsg.style.cssText = 'color:#c0392b;font-size:12px;min-height:16px;margin-bottom:4px;';
    modal.appendChild(errorMsg);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:8px;';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = '取消';
    cancelBtn.style.cssText = 'font-size:13px;padding:6px 14px;cursor:pointer;border:1px solid #ddd;border-radius:6px;background:#fff;color:#1d1d1f;';
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.textContent = '确定';
    confirmBtn.style.cssText = 'font-size:13px;padding:6px 14px;cursor:pointer;border:none;border-radius:6px;background:#0a66c2;color:#fff;';
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(confirmBtn);
    modal.appendChild(btnRow);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    kwInput.focus();

    function close() {
      overlay.remove();
      document.removeEventListener('keydown', onKeydown);
    }
    function onKeydown(e) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKeydown);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });
    cancelBtn.addEventListener('click', close);
    confirmBtn.addEventListener('click', async function () {
      const keyword = kwInput.value.trim();
      const scopes = { tag: scopeCbs.tag.checked, title: scopeCbs.title.checked, summary: scopeCbs.summary.checked };
      const mode = modeSelect.value === 'exact' ? 'exact' : 'fuzzy';
      if (!keyword || (!scopes.tag && !scopes.title && !scopes.summary)) {
        errorMsg.textContent = '请填写关键词，并至少勾选一个扫描范围';
        return;
      }
      const result = await addManualKeywordRule({ keyword: keyword, scopes: scopes, mode: mode });
      if (result === 'duplicate') {
        errorMsg.textContent = '和已有规则重复！';
        return;
      }
      close();
      refreshUI();
    });
  }

  function scopesLabel(scopes) {
    const parts = [];
    if (scopes.tag) parts.push('Tag');
    if (scopes.title) parts.push('标题');
    if (scopes.summary) parts.push('简介');
    return parts.join('+') || '-';
  }

  // 脚本写死的规则删不掉（装好的脚本文件没法自己改自己），只给缓存来源的条目加删除按钮
  function showBlockConfigDialog() {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);z-index:999998;display:flex;align-items:center;justify-content:center;font-family:sans-serif;';

    const modal = document.createElement('div');
    modal.style.cssText = 'background:#fff;color:#1d1d1f;padding:20px;border-radius:8px;width:560px;max-width:92vw;max-height:80vh;overflow:auto;font-size:14px;box-shadow:0 4px 20px rgba(0,0,0,0.25);';

    const title = document.createElement('div');
    title.textContent = '当前屏蔽设置';
    title.style.cssText = 'font-weight:600;font-size:16px;margin-bottom:6px;';
    modal.appendChild(title);

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:12px;color:#6e6e73;margin-bottom:14px;line-height:1.4;';
    hint.textContent = '"脚本内置"是生成脚本时写死的规则，这里删不掉，要删请回配置生成器重新生成。';
    modal.appendChild(hint);

    function buildTable(headers, rows) {
      const table = document.createElement('table');
      table.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px;margin-bottom:6px;';
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      headers.forEach((h) => {
        const th = document.createElement('th');
        th.textContent = h;
        th.style.cssText = 'text-align:left;border-bottom:1px solid #ddd;padding:4px 6px;color:#6e6e73;';
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      if (rows.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = headers.length;
        td.textContent = '（空）';
        td.style.cssText = 'padding:8px 6px;color:#999;';
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
      rows.forEach((cells) => {
        const tr = document.createElement('tr');
        cells.forEach((cell) => {
          const td = document.createElement('td');
          td.style.cssText = 'padding:4px 6px;border-bottom:1px solid #f0f0f0;word-break:break-all;';
          if (cell instanceof Node) td.appendChild(cell);
          else td.textContent = cell;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      return table;
    }

    function buildDeleteBtn(onClick) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '删除';
      btn.style.cssText = 'font-size:12px;padding:2px 10px;cursor:pointer;border:1px solid #f5c2c7;border-radius:4px;background:#f8d7da;color:#842029;';
      btn.addEventListener('click', onClick);
      return btn;
    }

    const kwTitle = document.createElement('div');
    kwTitle.textContent = '关键词屏蔽';
    kwTitle.style.cssText = 'font-size:14px;font-weight:600;margin:10px 0 6px;';
    modal.appendChild(kwTitle);

    const kwRows = FILTER_RULES.map((r) => [r.keyword, scopesLabel(r.scopes), r.mode === 'exact' ? '精准' : '模糊', '脚本内置', ''])
      .concat(manualBlockedTagRules.map((r) => {
        const delBtn = buildDeleteBtn(async function () {
          await removeManualRuleByKey(ruleKey(r));
          const heading = document.querySelector('h2.heading');
          if (heading) {
            const tagName = extractTagNameFromHeading(heading);
            if (tagName) renderTagBlockControl(heading, tagName);
          }
          refreshUI();
          close();
          showBlockConfigDialog();
        });
        return [r.keyword, scopesLabel(r.scopes), r.mode === 'exact' ? '精准' : '模糊', '本机缓存', delBtn];
      }));
    modal.appendChild(buildTable(['关键词', '扫描范围', '匹配模式', '来源', ''], kwRows));

    const idTitle = document.createElement('div');
    idTitle.textContent = 'Work ID 屏蔽';
    idTitle.style.cssText = 'font-size:14px;font-weight:600;margin:14px 0 6px;';
    modal.appendChild(idTitle);

    const idRows = BLOCKED_WORK_IDS.map((id) => [id, '', '脚本内置', ''])
      .concat(manualBlockedList.map((entry) => {
        const delBtn = buildDeleteBtn(async function () {
          await undoManualWorkBlock(entry.id);
          refreshUI();
          close();
          showBlockConfigDialog();
        });
        return [entry.id, entry.note || '', '本机缓存', delBtn];
      }));
    modal.appendChild(buildTable(['Work ID', '备注', '来源', ''], idRows));

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;justify-content:flex-end;margin-top:14px;';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '关闭';
    closeBtn.style.cssText = 'font-size:13px;padding:6px 14px;cursor:pointer;border:1px solid #ddd;border-radius:6px;background:#fff;color:#1d1d1f;';
    closeBtn.addEventListener('click', function () { close(); });
    btnRow.appendChild(closeBtn);
    modal.appendChild(btnRow);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function close() {
      overlay.remove();
      document.removeEventListener('keydown', onKeydown);
    }
    function onKeydown(e) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKeydown);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });
  }

  function injectBlockLink(workEl, workId, title) {
    const heading = workEl.querySelector('h4.heading');
    if (!heading || heading.dataset.ao3HelperBlockLinkAdded === '1') return;
    heading.dataset.ao3HelperBlockLinkAdded = '1';
    const link = document.createElement('span');
    link.className = 'ao3-helper-block-link';
    link.dataset.workid = workId;
    link.dataset.title = title || '';
    link.style.cssText = 'cursor:pointer;color:#c0392b;font-size:12px;margin-left:8px;';
    link.textContent = '[屏蔽此work]';
    heading.appendChild(link);
  }

  function hideWithManualBlockPlaceholder(workEl, workId) {
    workEl.style.display = 'none';
    workEl.dataset.ao3HelperHardHidden = '1';
    if (workEl.dataset.ao3HelperPlaceholderAdded === '1') return; // 避免重复触发时插入多份占位符
    workEl.dataset.ao3HelperPlaceholderAdded = '1';
    const title = getTitleText(workEl) || ('Work ' + workId);
    const placeholder = document.createElement('li');
    placeholder.className = 'ao3-helper-manual-blocked-placeholder';
    placeholder.dataset.workid = workId;
    placeholder.style.cssText = 'padding:8px 12px;background:#f8d7da;color:#842029;font-size:13px;border-radius:6px;margin:6px 0;list-style:none;';
    placeholder.appendChild(document.createTextNode('已手动屏蔽：' + title + ' '));
    const undo = document.createElement('span');
    undo.className = 'ao3-helper-undo-link';
    undo.dataset.workid = workId;
    undo.style.cssText = 'cursor:pointer;text-decoration:underline;color:#0a66c2;';
    undo.textContent = '[撤销]';
    placeholder.appendChild(undo);
    workEl.parentNode.insertBefore(placeholder, workEl);
  }

  // 动态插入的元素用事件委托统一处理点击，不用逐个绑定监听器
  document.addEventListener('click', async function (e) {
    const blockLink = e.target.closest && e.target.closest('.ao3-helper-block-link');
    if (blockLink) {
      e.preventDefault();
      const workId = blockLink.dataset.workid;
      if (!workId || manualBlockedIdSet.has(workId)) return;
      manualBlockedIdSet.add(workId);
      manualBlockedList.push({ id: workId, note: blockLink.dataset.title || '' });
      await GM.setValue('ao3Helper_manualBlockedIds', manualBlockedList);
      // 已处理过的元素不会被refreshUI重新扫到，这里要直接处理
      const workEl = blockLink.closest('li.work.blurb, li.blurb.work');
      if (workEl) hideWithManualBlockPlaceholder(workEl, workId);
      refreshUI();
      return;
    }
    const undoLink = e.target.closest && e.target.closest('.ao3-helper-undo-link');
    if (undoLink) {
      e.preventDefault();
      const workId = undoLink.dataset.workid;
      if (!workId) return;
      await undoManualWorkBlock(workId);
      refreshUI();
      return;
    }
    const tagBlockLink = e.target.closest && e.target.closest('.ao3-helper-tagblock-link');
    if (tagBlockLink) {
      e.preventDefault();
      const tagName = tagBlockLink.dataset.tagname;
      if (!tagName) return;
      const result = await addManualTagRule(tagName);
      if (result === 'duplicate') alert('和已有规则重复！');
      const heading = document.querySelector('h2.heading');
      if (heading) renderTagBlockControl(heading, tagName);
      refreshUI();
      return;
    }
    const tagUndoLink = e.target.closest && e.target.closest('.ao3-helper-tagblock-undo-link');
    if (tagUndoLink) {
      e.preventDefault();
      const tagName = tagUndoLink.dataset.tagname;
      if (!tagName) return;
      await removeManualTagRule(tagName);
      const heading = document.querySelector('h2.heading');
      if (heading) renderTagBlockControl(heading, tagName);
      refreshUI();
    }
  });

  function applyHardFilters() {
    getAllWorkEls().forEach((workEl) => {
      if (workEl.dataset.ao3HelperChecked === '1') return;
      workEl.dataset.ao3HelperChecked = '1';

      const workId = getWorkId(workEl);
      const texts = {
        tag: getTagTexts(workEl),
        title: getTitleText(workEl),
        summary: getSummaryText(workEl),
      };
      const matchesStaticConfig = (workId && BLOCKED_WORK_IDS.includes(workId))
        || FILTER_RULES.some((rule) => ruleMatchesWork(rule, texts))
        || manualBlockedTagRules.some((rule) => ruleMatchesWork(rule, texts));

      if (workId && manualBlockedIdSet.has(workId)) {
        if (matchesStaticConfig) {
          // 已经被脚本自带规则覆盖了，手动屏蔽缓存里这条是多余的，直接清掉
          removeManualBlock(workId);
          workEl.style.display = 'none';
          workEl.dataset.ao3HelperHardHidden = '1';
          return;
        }
        hideWithManualBlockPlaceholder(workEl, workId);
        return;
      }

      if (matchesStaticConfig) {
        workEl.style.display = 'none';
        workEl.dataset.ao3HelperHardHidden = '1';
        return;
      }

      if (workId) {
        injectBlockLink(workEl, workId, texts.title);
      }
    });
  }

  // --- 已读/已收藏 状态 ---
  let hideRead = false;
  let hideBookmarked = false;
  let readIds = new Set();
  let bookmarkedIds = new Set();
  let bannerExpanded = false; // 横幅第二行（各种开关/按钮）默认收起，减少置顶的信息量
  let bannerSticky = false; // 横幅是否"吸顶"，滚动页面时始终固定在视口最上方

  async function loadPersistentState() {
    hideRead = await GM.getValue('ao3Helper_hideRead', false);
    hideBookmarked = await GM.getValue('ao3Helper_hideBookmarked', false);
    // 过滤集合=已确认的+这一轮同步中还没收尾的，同步进行中也能立刻生效
    const readingsStable = await GM.getValue('ao3Helper_readingsIds', []);
    const readingsPending = await GM.getValue('ao3Helper_readingsPendingIds', []);
    readIds = new Set(readingsStable.concat(readingsPending));
    const bookmarksStable = await GM.getValue('ao3Helper_bookmarksIds', []);
    const bookmarksPending = await GM.getValue('ao3Helper_bookmarksPendingIds', []);
    bookmarkedIds = new Set(bookmarksStable.concat(bookmarksPending));
    // 以js为准清掉缓存里的多余条目，不然删了也没用，还以为删除没生效
    manualBlockedList = await GM.getValue('ao3Helper_manualBlockedIds', []);
    const dedupedBlockedList = manualBlockedList.filter((entry) => !BLOCKED_WORK_IDS.includes(entry.id));
    if (dedupedBlockedList.length !== manualBlockedList.length) {
      manualBlockedList = dedupedBlockedList;
      await GM.setValue('ao3Helper_manualBlockedIds', manualBlockedList);
    }
    rebuildManualBlockedIdSet();

    manualBlockedTagRules = await GM.getValue('ao3Helper_manualBlockedTagRules', []);
    const staticRuleTextKeys = new Set(FILTER_RULES.map((r) => keywordTextKey(r.keyword)));
    const dedupedTagRules = manualBlockedTagRules.filter((r) => !staticRuleTextKeys.has(keywordTextKey(r.keyword)));
    if (dedupedTagRules.length !== manualBlockedTagRules.length) {
      manualBlockedTagRules = dedupedTagRules;
      await GM.setValue('ao3Helper_manualBlockedTagRules', manualBlockedTagRules);
    }
    bannerExpanded = await GM.getValue('ao3Helper_bannerExpanded', false);
    bannerSticky = await GM.getValue('ao3Helper_bannerSticky', false);
  }

  function applyReadBookmarkFilter() {
    if (!AO3_USERNAME) return; // 没配用户名就不该生效，哪怕缓存里还留着旧数据
    getAllWorkEls().forEach((workEl) => {
      if (workEl.dataset.ao3HelperHardHidden === '1') return;
      const workId = getWorkId(workEl);
      if (!workId) return;
      const shouldHide = (hideRead && readIds.has(workId)) || (hideBookmarked && bookmarkedIds.has(workId));
      workEl.style.display = shouldHide ? 'none' : '';
    });
  }

  async function fetchDoc(url) {
    let res;
    try {
      res = await fetch(url, { credentials: 'same-origin' });
    } catch (e) {
      // fetch抛错≠被拦截，更可能是切后台/锁屏打断了请求，给几次重试机会
      const err = new Error('fetch failed: ' + (e && e.message));
      err.isNetworkError = true;
      throw err;
    }
    if (!res.ok) {
      // 服务器明确返回的错误状态（含Cloudflare 5xx），按拦截处理进冷却
      const err = new Error('non-ok status ' + res.status);
      err.isBlocked = true;
      throw err;
    }
    const html = await res.text();
    return new DOMParser().parseFromString(html, 'text/html');
  }

  function extractWorkEntries(doc, entrySelector, kind) {
    return Array.from(doc.querySelectorAll(entrySelector))
      .map((el) => ({ id: getWorkId(el), date: getWorkDate(el, kind) }))
      .filter((entry) => entry.id);
  }

  function looksBlocked(doc) {
    const title = (doc.title || '').toLowerCase();
    if (title.indexOf('just a moment') !== -1) return true;
    if (title.indexOf('attention required') !== -1) return true;
    if (title.indexOf('retry later') !== -1) return true;
    const body = doc.querySelector('body');
    if (!body) return true;
    const bodyText = (body.textContent || '').toLowerCase();
    if (bodyText.indexOf('retry later') !== -1) return true;
    return false;
  }

  const syncProgress = { bookmarks: null, readings: null };
  const LOCK_STALE_MS = 30000; // 收藏/历史各用各的锁，只防止同一个kind被多页面同时跑

  function makeRunId() {
    return Date.now() + '-' + Math.random().toString(36).slice(2);
  }

  async function acquireLock(kind, runId) {
    const existing = await GM.getValue('ao3Helper_' + kind + 'Lock', null);
    if (existing && (Date.now() - existing.ts) < LOCK_STALE_MS) {
      return false;
    }
    await GM.setValue('ao3Helper_' + kind + 'Lock', { runId: runId, ts: Date.now() });
    return true;
  }

  async function stillOwnLock(kind, runId) {
    const existing = await GM.getValue('ao3Helper_' + kind + 'Lock', null);
    return !!existing && existing.runId === runId;
  }

  async function refreshLock(kind, runId) {
    // 续期前必须确认锁还是自己的，不能无条件覆盖——避免锁被别的页面合法抢走后又被抢回来
    const existing = await GM.getValue('ao3Helper_' + kind + 'Lock', null);
    if (existing && existing.runId === runId) {
      await GM.setValue('ao3Helper_' + kind + 'Lock', { runId: runId, ts: Date.now() });
    }
  }

  async function releaseLock(kind, runId) {
    const existing = await GM.getValue('ao3Helper_' + kind + 'Lock', null);
    if (existing && existing.runId === runId) {
      await GM.deleteValue('ao3Helper_' + kind + 'Lock');
    }
  }

  async function setProgress(kind, page, count, cooling) {
    syncProgress[kind] = { page, count, cooling };
    await GM.setValue('ao3Helper_' + kind + 'Progress', { page, count, cooling });
    refreshUI();
  }

  // 抽屉B：这一轮同步中新找到、还没收尾确认的ID，定期落盘，不影响"抽屉A"
  async function savePending(kind, pendingIds, pendingNewestDate) {
    await GM.setValue('ao3Helper_' + kind + 'PendingIds', Array.from(pendingIds));
    await GM.setValue('ao3Helper_' + kind + 'PendingNewestDate', pendingNewestDate);
    await GM.setValue('ao3Helper_' + kind + 'ProgressSavedAt', Date.now());
  }

  // 真正收尾：把抽屉B合并进抽屉A（唯一会修改"已确认"数据的地方），清空抽屉B，
  // 超过上限就从最旧的开始淘汰，同时把水位线更新成这一轮见过的最新日期
  async function commitCycle(kind, stableIds, pendingIds, pendingNewestDate, targetSet, seenExistingIds) {
    // 把这一轮重新出现的老ID挪到Set末尾，刷新"最近活跃"时间，避免常翻看的老文章被FIFO误淘汰
    // 下面都倒序遍历合并：扫描顺序是"越新越先见到"，但裁剪假设Set里"越旧越靠前"，顺序相反，不倒序会裁掉最新内容
    if (seenExistingIds) {
      Array.from(seenExistingIds).reverse().forEach((id) => {
        if (stableIds.has(id)) {
          stableIds.delete(id);
          stableIds.add(id);
        }
      });
    }
    Array.from(pendingIds).reverse().forEach((id) => stableIds.add(id));
    let idsArray = Array.from(stableIds);
    if (idsArray.length > MAX_STORED_IDS) {
      idsArray = idsArray.slice(idsArray.length - MAX_STORED_IDS);
    }
    // 内存里用于过滤的targetSet跟着落盘结果对齐，避免淘汰掉的旧ID一直留在内存里不释放
    targetSet.clear();
    idsArray.forEach((id) => targetSet.add(id));
    await GM.setValue('ao3Helper_' + kind + 'Ids', idsArray);
    await GM.setValue('ao3Helper_' + kind + 'PendingIds', []);
    await GM.setValue('ao3Helper_' + kind + 'PendingNewestDate', 0);
    await GM.setValue('ao3Helper_' + kind + 'Page', 1);
    if (pendingNewestDate > 0) {
      const prevNewestDate = await GM.getValue('ao3Helper_' + kind + 'NewestDate', 0);
      await GM.setValue('ao3Helper_' + kind + 'NewestDate', Math.max(prevNewestDate, pendingNewestDate));
    }
    await GM.setValue('ao3Helper_' + kind + 'SyncedAt', Date.now());
    await GM.setValue('ao3Helper_' + kind + 'Syncing', false);
  }

  async function syncList(kind, urlBase, entrySelector, targetSet) {
    if (syncProgress[kind]) return;

    const runId = makeRunId();
    if (!(await acquireLock(kind, runId))) {
      return; // 别的页面正在跑，别抢
    }

    const alreadySyncedOnce = !!(await GM.getValue('ao3Helper_' + kind + 'SyncedAt', 0));
    // 抽屉A：已确认的基线，整轮同步期间绝不修改，只有收尾时才更新（commitCycle里）
    const stableIds = new Set(await GM.getValue('ao3Helper_' + kind + 'Ids', []));
    // 抽屉B：这一轮（可能跨越多次中断/恢复）已经找到、还没收尾的
    const pendingIds = new Set(await GM.getValue('ao3Helper_' + kind + 'PendingIds', []));
    // 日期水位线：上次收尾时最新的日期，逐条判断是否严格早于它，兜住上限淘汰后被误判成新的情况
    const committedNewestDate = await GM.getValue('ao3Helper_' + kind + 'NewestDate', 0);
    let pendingNewestDate = await GM.getValue('ao3Helper_' + kind + 'PendingNewestDate', 0);
    let page = await GM.getValue('ao3Helper_' + kind + 'Page', 1); // 断点跳页恢复
    let pagesThisRun = 0;
    let pagesSinceCooldown = 0;
    let dirty = false;
    // 这一轮扫描中遇到的、已经在抽屉A里的ID，收尾时用来刷新"最近活跃"位置（不跨中断持久化，可接受的简化）
    const seenExistingIds = new Set();

    await setProgress(kind, page, targetSet.size, false);

    try {
      while (true) {
        const stillWanted = await GM.getValue('ao3Helper_' + kind + 'Syncing', false);
        if (!stillWanted) break; // 用户取消了（可能是在别的页面点的）
        if (!(await stillOwnLock(kind, runId))) break; // 锁被别的页面抢走了
        if (pendingIds.size >= MAX_STORED_IDS) {
          // 达到上限必须在这里收尾，不能只break不提交，否则下次触发会在这里卡死
          if (await stillOwnLock(kind, runId)) {
            await commitCycle(kind, stableIds, pendingIds, pendingNewestDate, targetSet, seenExistingIds);
          }
          dirty = false;
          break;
        }

        let doc;
        try {
          doc = await fetchDoc(urlBase + '?page=' + page);
          await GM.setValue('ao3Helper_' + kind + 'NetErrorStreak', 0); // 成功了，连续失败计数清零
        } catch (e) {
          if (e.isBlocked) {
            await GM.setValue('ao3Helper_' + kind + 'Blocked', true);
            await GM.setValue('ao3Helper_' + kind + 'BlockedAt', Date.now());
          } else if (e.isNetworkError) {
            // 单次网络失败不算拦截，连续失败多次才升级（避免手机切后台误判）
            const streak = (await GM.getValue('ao3Helper_' + kind + 'NetErrorStreak', 0)) + 1;
            await GM.setValue('ao3Helper_' + kind + 'NetErrorStreak', streak);
            if (streak >= NET_ERROR_STREAK_THRESHOLD) {
              await GM.setValue('ao3Helper_' + kind + 'Blocked', true);
              await GM.setValue('ao3Helper_' + kind + 'BlockedAt', Date.now());
            }
          }
          break;
        }

        if (looksBlocked(doc)) {
          await GM.setValue('ao3Helper_' + kind + 'Blocked', true);
          await GM.setValue('ao3Helper_' + kind + 'BlockedAt', Date.now());
          break;
        }

        const entries = extractWorkEntries(doc, entrySelector, kind);
        const pageIds = entries.map((e) => e.id);

        if (pageIds.length === 0) {
          // 真正翻到底了，落盘前重新确认锁还是不是自己的
          if (await stillOwnLock(kind, runId)) {
            await commitCycle(kind, stableIds, pendingIds, pendingNewestDate, targetSet, seenExistingIds);
          }
          dirty = false;
          break;
        }

        // 这一页抓到的新内容先存进抽屉B。只有真正首次全量初始化（抽屉A还是空的）
        // 才需要在页内按上限截住，否则插入顺序=翻页顺序，溢出裁剪会砍错最新内容；
        // 稳定期抽屉A已满，不能套用同一限制，否则增量同步会永远塞不进新内容
        const newIds = pageIds.filter((id) => !stableIds.has(id) && !pendingIds.has(id));
        let hitCapMidPage = false;
        if (alreadySyncedOnce) {
          newIds.forEach((id) => { pendingIds.add(id); targetSet.add(id); });
        } else {
          for (const id of newIds) {
            if (stableIds.size + pendingIds.size >= MAX_STORED_IDS) { hitCapMidPage = true; break; }
            pendingIds.add(id);
            targetSet.add(id);
          }
        }
        pageIds.forEach((id) => { if (stableIds.has(id)) seenExistingIds.add(id); });
        entries.forEach((e) => { if (e.date > pendingNewestDate) pendingNewestDate = e.date; });

        if (hitCapMidPage) {
          if (await stillOwnLock(kind, runId)) {
            await commitCycle(kind, stableIds, pendingIds, pendingNewestDate, targetSet, seenExistingIds);
          }
          dirty = false;
          break;
        }

        // 停不停翻页：整页相对抽屉A全是旧的，或出现一条严格早于水位线的日期
        const allOldRelativeToStable = pageIds.every((id) => stableIds.has(id));
        const hitDateWatermark = committedNewestDate > 0
          && entries.some((e) => e.date > 0 && e.date < committedNewestDate);

        if (alreadySyncedOnce && (allOldRelativeToStable || hitDateWatermark)) {
          // 增量刷新：真正追上了
          if (await stillOwnLock(kind, runId)) {
            await commitCycle(kind, stableIds, pendingIds, pendingNewestDate, targetSet, seenExistingIds);
          }
          dirty = false;
          break;
        }

        page += 1;
        pagesThisRun += 1;
        pagesSinceCooldown += 1;
        dirty = true;
        await setProgress(kind, page, stableIds.size + pendingIds.size, false);

        if (pendingIds.size >= MAX_STORED_IDS) {
          // 同上：达到上限必须直接收尾，不能只break不提交
          if (await stillOwnLock(kind, runId)) {
            await commitCycle(kind, stableIds, pendingIds, pendingNewestDate, targetSet, seenExistingIds);
          }
          dirty = false;
          break;
        }

        // 定期落盘前也要确认锁还是自己的，网络请求耗时不定，锁可能已被别的页面合法抢走
        if (pagesThisRun % SAVE_EVERY_N_PAGES === 0) {
          if (!(await stillOwnLock(kind, runId))) { dirty = false; break; }
          await savePending(kind, pendingIds, pendingNewestDate);
          await GM.setValue('ao3Helper_' + kind + 'Page', page);
          dirty = false;
        }

        await refreshLock(kind, runId);

        if (pagesSinceCooldown >= PAGES_PER_BATCH) {
          if (!(await stillOwnLock(kind, runId))) { dirty = false; break; }
          await savePending(kind, pendingIds, pendingNewestDate);
          await GM.setValue('ao3Helper_' + kind + 'Page', page);
          dirty = false;
          pagesSinceCooldown = 0;
          await setProgress(kind, page, stableIds.size + pendingIds.size, true);
          await new Promise((resolve) => setTimeout(resolve, BATCH_COOLDOWN_MS));
          await refreshLock(kind, runId);
          await setProgress(kind, page, stableIds.size + pendingIds.size, false);
        }

        await new Promise((resolve) => setTimeout(resolve, FETCH_DELAY_MS));
      }

      if (dirty && (await stillOwnLock(kind, runId))) {
        await savePending(kind, pendingIds, pendingNewestDate);
        await GM.setValue('ao3Helper_' + kind + 'Page', page);
      }
    } finally {
      // 只有还是自己的锁时才清掉进度显示，避免误删新主人正在写的进度
      const stillOwn = await stillOwnLock(kind, runId);
      await releaseLock(kind, runId);
      if (stillOwn) {
        await GM.deleteValue('ao3Helper_' + kind + 'Progress');
      }
      syncProgress[kind] = null;
      refreshUI();
    }
  }

  const BLOCK_COOLDOWN_MS = 6 * 60 * 60 * 1000;
  const AUTO_SYNC_STALE_MS = 2 * 60 * 60 * 1000;

  async function shouldSkipDueToBlock(kind) {
    const blocked = await GM.getValue('ao3Helper_' + kind + 'Blocked', false);
    if (!blocked) return false;
    const blockedAt = await GM.getValue('ao3Helper_' + kind + 'BlockedAt', 0);
    if (Date.now() - blockedAt > BLOCK_COOLDOWN_MS) {
      await GM.setValue('ao3Helper_' + kind + 'Blocked', false);
      return false;
    }
    return true;
  }

  async function triggerSync(kind) {
    if (!AO3_USERNAME) return 'no-username';
    if (syncProgress[kind]) return 'already-running-here';
    if (await shouldSkipDueToBlock(kind)) {
      refreshUI();
      return 'blocked'; // 冷却期内不重试，避免继续触发AO3的限制
    }
    await GM.setValue('ao3Helper_' + kind + 'Syncing', true);
    const urlBase = kind === 'bookmarks'
      ? 'https://archiveofourown.org/users/' + AO3_USERNAME + '/bookmarks'
      : 'https://archiveofourown.org/users/' + AO3_USERNAME + '/readings';
    const entrySelector = kind === 'bookmarks' ? 'li.bookmark.blurb' : 'li.reading.blurb';
    const targetSet = kind === 'bookmarks' ? bookmarkedIds : readIds;
    syncList(kind, urlBase, entrySelector, targetSet);
    return 'started';
  }

  async function cancelSync(kind) {
    await GM.setValue('ao3Helper_' + kind + 'Syncing', false);
    refreshUI();
  }

  async function clearAllCache() {
    const keys = [
      'ao3Helper_hideRead', 'ao3Helper_hideBookmarked',
      'ao3Helper_readingsIds', 'ao3Helper_bookmarksIds',
      'ao3Helper_readingsPage', 'ao3Helper_bookmarksPage',
      'ao3Helper_readingsSyncedAt', 'ao3Helper_bookmarksSyncedAt',
      'ao3Helper_readingsBlocked', 'ao3Helper_readingsBlockedAt',
      'ao3Helper_bookmarksBlocked', 'ao3Helper_bookmarksBlockedAt',
      'ao3Helper_readingsSyncing', 'ao3Helper_bookmarksSyncing',
      'ao3Helper_readingsLock', 'ao3Helper_bookmarksLock',
      'ao3Helper_readingsProgress', 'ao3Helper_bookmarksProgress',
      'ao3Helper_readingsProgressSavedAt', 'ao3Helper_bookmarksProgressSavedAt',
      'ao3Helper_readingsPendingIds', 'ao3Helper_bookmarksPendingIds',
      'ao3Helper_readingsNewestDate', 'ao3Helper_bookmarksNewestDate',
      'ao3Helper_readingsPendingNewestDate', 'ao3Helper_bookmarksPendingNewestDate',
      'ao3Helper_readingsNetErrorStreak', 'ao3Helper_bookmarksNetErrorStreak',
      'ao3Helper_manualBlockedIds', 'ao3Helper_manualBlockedTagRules',
      'ao3Helper_bannerExpanded', 'ao3Helper_bannerSticky',
    ];
    for (const k of keys) {
      await GM.deleteValue(k);
    }
    location.reload();
  }
  // -----------------------------

  // --- UI ---
  function formatSyncedAt(ts) {
    if (!ts) return '未同步';
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return mins + '分钟前';
    const hours = Math.round(mins / 60);
    return hours + '小时前';
  }

  function applyBannerStickyStyle(banner) {
    const base = 'background:#fff3cd;color:#664d03;padding:6px 12px;font-size:13px;text-align:center;border-bottom:1px solid #ffe69c;font-family:sans-serif;display:flex;flex-direction:column;gap:6px;';
    // 用fixed而不是sticky：sticky只要有可滚动祖先设了overflow就会静默失效
    banner.style.cssText = bannerSticky ? base + 'position:fixed;top:0;left:0;right:0;z-index:999990;' : base;
    // fixed脱离文档流，用body顶部留白补偿横幅高度，避免盖住AO3内容
    document.body.style.paddingTop = bannerSticky ? banner.offsetHeight + 'px' : '';
  }

  function getBanner() {
    let banner = document.getElementById('ao3-helper-banner');
    if (banner) return banner;

    banner = document.createElement('div');
    banner.id = 'ao3-helper-banner';
    applyBannerStickyStyle(banner);
    document.body.insertBefore(banner, document.body.firstChild);

    // 第一行常驻：过滤计数+展开按钮；第二行默认收起，状态会记住
    const row1 = document.createElement('div');
    // gap写成"行间距 列间距"：手机端换行时统一用6px，避免跟横幅自身6px不一致
    row1.style.cssText = 'display:flex;gap:6px 16px;align-items:center;justify-content:center;flex-wrap:wrap;';
    banner.appendChild(row1);

    const row2 = document.createElement('div');
    row2.id = 'ao3-helper-banner-row2';
    row2.style.cssText = 'display:' + (bannerExpanded ? 'flex' : 'none') + ';flex-direction:column;gap:6px;align-items:center;';
    banner.appendChild(row2);

    const countSpan = document.createElement('span');
    countSpan.id = 'ao3-helper-banner-count';
    row1.appendChild(countSpan);

    // 用span做成轻量的下划线链接样式，不用按钮框，视觉上更淡一点
    const toggleBtn = document.createElement('span');
    toggleBtn.style.cssText = 'cursor:pointer;text-decoration:underline;font-size:13px;';
    toggleBtn.textContent = (bannerExpanded ? '▾' : '▸') + ' 更多设置';
    toggleBtn.addEventListener('click', async function () {
      bannerExpanded = !bannerExpanded;
      await GM.setValue('ao3Helper_bannerExpanded', bannerExpanded);
      toggleBtn.textContent = (bannerExpanded ? '▾' : '▸') + ' 更多设置';
      row2.style.display = bannerExpanded ? 'flex' : 'none';
      // 展开/收起会改变横幅高度，吸顶时body的留白得跟着重新量一次
      applyBannerStickyStyle(banner);
    });
    row1.appendChild(toggleBtn);

    // 每种(已读/已收藏)各自一行：勾选框+同步按钮+状态文字放在一起
    function buildSyncRow(kind, checkboxLabel, getHideFlag, setHideFlag, hideStorageKey) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px 8px;align-items:center;flex-wrap:wrap;';

      const label = document.createElement('label');
      label.style.cssText = 'cursor:pointer;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = getHideFlag();
      cb.addEventListener('change', function () {
        setHideFlag(cb.checked);
        GM.setValue(hideStorageKey, cb.checked);
        refreshUI();
      });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' ' + checkboxLabel));
      row.appendChild(label);

      const btn = document.createElement('button');
      btn.id = 'ao3-helper-sync-' + kind + '-btn';
      btn.type = 'button';
      btn.textContent = '同步'; // 占位文字，updateSyncStatusText()马上会刷新成准确状态
      btn.style.cssText = 'font-size:12px;padding:2px 8px;cursor:pointer;background:#f0f0f0;color:#444;border:1px solid #ccc;border-radius:4px;';
      btn.addEventListener('click', async function () {
        // 优先检查是不是被拦截了，Syncing标记在拦截时不会被关掉
        if (await shouldSkipDueToBlock(kind)) {
          await GM.setValue('ao3Helper_' + kind + 'Blocked', false);
          await GM.deleteValue('ao3Helper_' + kind + 'BlockedAt');
          triggerSync(kind);
          return;
        }
        const syncing = await GM.getValue('ao3Helper_' + kind + 'Syncing', false);
        if (syncing) { cancelSync(kind); return; }
        triggerSync(kind);
      });

      const statusSpan = document.createElement('span');
      statusSpan.id = 'ao3-helper-sync-status-' + kind;
      statusSpan.style.cssText = 'color:#8a6d3b;font-size:12px;';
      row.appendChild(statusSpan);
      row.appendChild(btn);

      return row;
    }

    if (AO3_USERNAME) {
      // 已读/收藏这两行优先同一行显示，宽度不够再各自换行
      const syncRowsWrap = document.createElement('div');
      syncRowsWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center;justify-content:center;';
      row2.appendChild(syncRowsWrap);

      syncRowsWrap.appendChild(buildSyncRow(
        'readings', '隐藏已读',
        function () { return hideRead; },
        function (v) { hideRead = v; },
        'ao3Helper_hideRead'
      ));
      syncRowsWrap.appendChild(buildSyncRow(
        'bookmarks', '隐藏已收藏',
        function () { return hideBookmarked; },
        function (v) { hideBookmarked = v; },
        'ao3Helper_hideBookmarked'
      ));
    }

    // 这些工具按钮不依赖同步用户名，纯关键词/tag/work屏蔽用户也用得上
    const toolsRow = document.createElement('div');
    toolsRow.style.cssText = 'display:flex;gap:6px 16px;align-items:center;flex-wrap:wrap;justify-content:center;';
    row2.appendChild(toolsRow);

    const stickyLabel = document.createElement('label');
    stickyLabel.style.cssText = 'cursor:pointer;font-size:12px;display:flex;align-items:center;gap:4px;';
    const stickyCb = document.createElement('input');
    stickyCb.type = 'checkbox';
    stickyCb.checked = bannerSticky;
    stickyCb.addEventListener('change', async function () {
      bannerSticky = stickyCb.checked;
      await GM.setValue('ao3Helper_bannerSticky', bannerSticky);
      applyBannerStickyStyle(banner);
    });
    stickyLabel.appendChild(stickyCb);
    stickyLabel.appendChild(document.createTextNode(' 始终吸顶'));

    const addKeywordBtn = document.createElement('button');
    addKeywordBtn.type = 'button';
    addKeywordBtn.textContent = '添加屏蔽词';
    addKeywordBtn.style.cssText = 'font-size:12px;padding:2px 8px;cursor:pointer;background:#f0f0f0;color:#444;border:1px solid #ccc;border-radius:4px;';
    addKeywordBtn.addEventListener('click', function () { showAddKeywordRuleDialog(); });

    const configBtn = document.createElement('button');
    configBtn.type = 'button';
    configBtn.textContent = '屏蔽设置';
    configBtn.style.cssText = 'font-size:12px;padding:2px 8px;cursor:pointer;background:#f0f0f0;color:#444;border:1px solid #ccc;border-radius:4px;';
    configBtn.addEventListener('click', function () { showBlockConfigDialog(); });

    // 吸顶开关/添加屏蔽词/屏蔽配置包成一组，避免toolsRow换行时把它们拆散到两行
    const stickyToolsGroup = document.createElement('div');
    stickyToolsGroup.style.cssText = 'display:flex;gap:16px;align-items:center;';
    stickyToolsGroup.appendChild(stickyLabel);
    stickyToolsGroup.appendChild(addKeywordBtn);
    stickyToolsGroup.appendChild(configBtn);
    toolsRow.appendChild(stickyToolsGroup);

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.textContent = '下载当前配置';
    exportBtn.style.cssText = 'font-size:12px;padding:2px 8px;cursor:pointer;background:#f0f0f0;color:#444;border:1px solid #ccc;border-radius:4px;';
    exportBtn.addEventListener('click', function () {
      const exportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        autoSync: AUTO_SYNC,
        rules: FILTER_RULES.concat(manualBlockedTagRules),
        blockedIds: BLOCKED_WORK_IDS.map((id) => ({ id: id, note: '' })).concat(manualBlockedList),
      };
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'ao3-helper-config.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.textContent = '清空所有缓存';
    clearBtn.style.cssText = 'font-size:12px;padding:2px 8px;cursor:pointer;background:#f8d7da;color:#842029;border:1px solid #f5c2c7;border-radius:4px;';
    clearBtn.addEventListener('click', function () {
      const confirmed = confirm('警告!!\n将清空AO3助手所有缓存数据，\n包括所有阅读/收藏记录，以及缓存的所有屏蔽设置!\n是否继续？');
      if (confirmed) clearAllCache();
    });

    // 用span而不是<a>：AO3站点自己的链接样式会叠加成双下划线
    const githubLink = document.createElement('span');
    githubLink.textContent = 'GitHub';
    githubLink.style.cssText = 'cursor:pointer;text-decoration:underline;font-size:13px;color:#8a6d3b;';
    githubLink.addEventListener('click', function () {
      window.open('https://github.com/kekeeya/AO3-Helper', '_blank', 'noopener,noreferrer');
    });

    // 下载配置/清空缓存/GitHub包成一组，避免toolsRow换行时把它们拆散到两行
    const githubSeparator = document.createElement('span');
    githubSeparator.textContent = '|';
    githubSeparator.style.cssText = 'color:#8a6d3b;';

    // 负margin把分隔符往左拉，抵消外层16px的gap，让"|"两侧都是9px
    const githubGroup = document.createElement('span');
    githubGroup.style.cssText = 'display:flex;gap:9px;align-items:center;margin-left:-7px;';
    githubGroup.appendChild(githubSeparator);
    githubGroup.appendChild(githubLink);

    const exportClearGroup = document.createElement('div');
    exportClearGroup.style.cssText = 'display:flex;gap:16px;align-items:center;';
    exportClearGroup.appendChild(exportBtn);
    exportClearGroup.appendChild(clearBtn);
    exportClearGroup.appendChild(githubGroup);
    toolsRow.appendChild(exportClearGroup);

    // 内容全部加完后再重新量一次高度，把留白设对
    applyBannerStickyStyle(banner);

    return banner;
  }

  // 按钮文字和状态文字一一对应：拦截→重试同步/网络异常；同步中→暂停同步；有数据→同步/X前；无数据→初始化
  function syncStatusFor(label, syncedAtValue, syncingFlag, liveProgress, progressSavedAt, idCount, pendingCount, blocked) {
    const totalCount = idCount + pendingCount; // 已收尾的+这一轮还没收尾的，两种情况下都是正确的总数
    if (blocked) {
      return label + '网络异常,请稍后重试同步(' + totalCount + '条)';
    }
    if (syncingFlag) {
      if (liveProgress) {
        const verb = liveProgress.cooling ? '冷却中' : '同步中';
        return label + verb + '...已同步' + liveProgress.page + '页(' + liveProgress.count + '条)';
      }
      return label + '同步中...(' + totalCount + '条)'; // 没有实时进度时不显示页数，但仍算"同步中"
    }
    if (syncedAtValue || progressSavedAt) {
      return label + formatSyncedAt(syncedAtValue || progressSavedAt) + '(' + totalCount + '条)';
    }
    return label + '无数据';
  }

  function setSyncButtonState(btn, syncing, blocked, hasData) {
    if (!btn) return;
    btn.disabled = false;
    // 被拦截优先于Syncing判断文字——Syncing在真正被拦截时不会被关掉，
    // 按钮文字得如实反映"点一下会发生什么"，不能一直显示"暂停同步"
    btn.textContent = blocked ? '重试同步' : (syncing ? '暂停同步' : (hasData ? '同步' : '初始化'));
    btn.style.cssText = 'font-size:12px;padding:2px 8px;cursor:pointer;background:#f0f0f0;color:#444;border:1px solid #ccc;border-radius:4px;';
  }

  async function updateSyncStatusText() {
    if (!AO3_USERNAME) return;
    const bookmarksEl = document.getElementById('ao3-helper-sync-status-bookmarks');
    const readingsEl = document.getElementById('ao3-helper-sync-status-readings');
    const bookmarksBtn = document.getElementById('ao3-helper-sync-bookmarks-btn');
    const readingsBtn = document.getElementById('ao3-helper-sync-readings-btn');
    const bookmarksSyncedAt = await GM.getValue('ao3Helper_bookmarksSyncedAt', 0);
    const readingsSyncedAt = await GM.getValue('ao3Helper_readingsSyncedAt', 0);
    const bookmarksBlocked = await GM.getValue('ao3Helper_bookmarksBlocked', false);
    const readingsBlocked = await GM.getValue('ao3Helper_readingsBlocked', false);
    const bookmarksSyncing = await GM.getValue('ao3Helper_bookmarksSyncing', false);
    const readingsSyncing = await GM.getValue('ao3Helper_readingsSyncing', false);
    const bookmarksProgress = await GM.getValue('ao3Helper_bookmarksProgress', null);
    const readingsProgress = await GM.getValue('ao3Helper_readingsProgress', null);
    const bookmarksProgressSavedAt = await GM.getValue('ao3Helper_bookmarksProgressSavedAt', 0);
    const readingsProgressSavedAt = await GM.getValue('ao3Helper_readingsProgressSavedAt', 0);
    const bookmarksIdsNow = await GM.getValue('ao3Helper_bookmarksIds', []);
    const readingsIdsNow = await GM.getValue('ao3Helper_readingsIds', []);
    const bookmarksPendingIdsNow = await GM.getValue('ao3Helper_bookmarksPendingIds', []);
    const readingsPendingIdsNow = await GM.getValue('ao3Helper_readingsPendingIds', []);

    if (bookmarksEl) {
      bookmarksEl.textContent = syncStatusFor('收藏记录:', bookmarksSyncedAt, bookmarksSyncing, bookmarksProgress, bookmarksProgressSavedAt, bookmarksIdsNow.length, bookmarksPendingIdsNow.length, bookmarksBlocked);
    }
    if (readingsEl) {
      readingsEl.textContent = syncStatusFor('已读记录:', readingsSyncedAt, readingsSyncing, readingsProgress, readingsProgressSavedAt, readingsIdsNow.length, readingsPendingIdsNow.length, readingsBlocked);
    }
    setSyncButtonState(bookmarksBtn, bookmarksSyncing, bookmarksBlocked, !!(bookmarksSyncedAt || bookmarksProgressSavedAt));
    setSyncButtonState(readingsBtn, readingsSyncing, readingsBlocked, !!(readingsSyncedAt || readingsProgressSavedAt));
  }

  function refreshUI() {
    applyHardFilters();
    applyReadBookmarkFilter();
    injectTagBlockControl();

    getBanner();
    const hiddenCount = Array.from(getAllWorkEls()).filter((el) => el.style.display === 'none').length;
    const countEl = document.getElementById('ao3-helper-banner-count');
    if (countEl) countEl.textContent = '[AO3_Helper] Filtered ' + hiddenCount + ' works.';

    updateSyncStatusText();
  }

  // 首次同步必须手动触发，之后距上次同步超过2小时才自动增量刷新
  async function maybeAutoStart(kind) {
    if (!AUTO_SYNC) return;
    const syncing = await GM.getValue('ao3Helper_' + kind + 'Syncing', false);
    if (syncing) return;
    const syncedAt = await GM.getValue('ao3Helper_' + kind + 'SyncedAt', 0);
    if (!syncedAt) return; // 还没手动做过首次同步，不自动开始
    if (Date.now() - syncedAt > AUTO_SYNC_STALE_MS) {
      triggerSync(kind);
    }
  }

  // Syncing为true但这个页面没在跑时尝试接手；acquireLock是幂等的，锁没过期就只会白跑一次
  async function resumeAbandonedSyncs() {
    for (const kind of ['bookmarks', 'readings']) {
      if (syncProgress[kind]) continue;
      const syncing = await GM.getValue('ao3Helper_' + kind + 'Syncing', false);
      if (!syncing) continue;
      triggerSync(kind);
    }
  }

  (async function init() {
    await loadPersistentState();
    refreshUI();

    if (AO3_USERNAME) {
      const bookmarksSyncing = await GM.getValue('ao3Helper_bookmarksSyncing', false);
      if (bookmarksSyncing) triggerSync('bookmarks');
      const readingsSyncing = await GM.getValue('ao3Helper_readingsSyncing', false);
      if (readingsSyncing) triggerSync('readings');

      await maybeAutoStart('bookmarks');
      await maybeAutoStart('readings');

      // 旁观页面也能看到实时进度，顺带检查有没有无人接手的中断同步
      setInterval(function () {
        updateSyncStatusText();
        resumeAbandonedSyncs();
      }, 3000);
    }
  })();

  let refreshScheduled = false;
  function scheduleRefresh() {
    if (refreshScheduled) return;
    refreshScheduled = true;
    setTimeout(function () {
      refreshScheduled = false;
      refreshUI();
    }, 250);
  }

  const observer = new MutationObserver(function () { scheduleRefresh(); });
  observer.observe(document.body, { childList: true, subtree: true });
})();
