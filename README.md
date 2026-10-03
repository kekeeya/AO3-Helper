# AO3 Helper

[![Platform](https://img.shields.io/badge/platform-userscript-black)](#使用方法)
[![Browser](https://img.shields.io/badge/browser-Chrome%20%7C%20Firefox%20%7C%20Edge%20%7C%20Safari-blue)](#使用方法)
[![License](https://img.shields.io/badge/license-GPL--3.0-green)](LICENSE)

**自定义你的AO3屏蔽设置，定制浏览体验，生成JS脚本后通过 Tampermonkey / Userscripts 等平台装进浏览器插件即可用，全平台支持。**

   | 有效平台 | 免费方案 |
   |---|---|
   | 桌面 Win/Mac | [Tampermonkey](https://www.tampermonkey.net/)（免费） |
   | Android | Firefox for Android + Tampermonkey，或 Kiwi Browser（都免费） |
   | iOS/iPad | [Userscripts](https://apps.apple.com/us/app/userscripts/id1463298887)（by quoid，免费替代Tampermonkey） |


## 功能

| 功能 | 说明 |
|---|---|
| 关键词屏蔽 | 对于关键词AB，精准模式下只屏蔽tag/title/summary与关键词完整匹配的文章；模糊模式只要包含AB就屏蔽 |
| Work ID / Tag 屏蔽 | 在AO3页面上可以直接通过"[屏蔽此work]"/"[屏蔽此tag]"配置，也可以在配置生成器单独配置Work ID屏蔽 |
| 隐藏已读 / 已收藏记录 | 开启后，生成的脚本会在后台同步收藏（/bookmarks）和阅读历史（/readings），上限5000条，并在页面顶部提供"隐藏已读"/"隐藏已收藏"两个开关 |
| 配置备份 | 通过「下载当前配置」导出JSON备份 |

## 使用方法

1. clone到本地打开 `AO3-helper-generator.html`，或者直接访问部署好的网页 [kekeeya.github.io/AO3-Helper](https://kekeeya.github.io/AO3-Helper/)，自定义规则，点「生成脚本」生成JS；如果没有隐藏已读 / 已收藏记录的需求，也可以直接下载 `AO3-helper-basic.js` 使用。
2. 按照对应平台的流程，在对应浏览器生效第一步生成的脚本。

装好后AO3页面顶部会出现一条黄色设置条，展开 ▸ 更多设置 后自行配置。


## 声明

非官方第三方工具，与AO3、Organization for Transformative Works无关联；同步用的是你自己登录的身份直接请求AO3，不经过任何服务器；代码以 [GPL-3.0](LICENSE) 协议开源。
