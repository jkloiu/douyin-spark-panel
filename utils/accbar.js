/** 顶部账号切换条的公共逻辑 */
const ui = require('./ui.js')
const av = require('./avatar.js')

/** 生成账号条所需数据 */
function build() {
  const app = getApp()
  const cur = app && app.globalData.currentAccount
  const map = (app && app.globalData.accountMap) || {}
  const acc = map[cur] || null
  const name = acc ? acc.username || String(acc.unique_id) : ''
  const cookie = (acc && acc.cookie) || {}
  return {
    accList: (app && app.globalData.accounts) || [],
    accCur: acc,
    accName: name,
    accInitial: name ? name.slice(0, 1).toUpperCase() : '?',
    accLive: cookie.live !== false,
    accOk: cookie.live === false ? null : !!cookie.session_valid,
    /** [20261014] 当前抖音账号的真实头像：/api/accounts 的 avatar 字段
     *  （面板抓好友时按 sid 本地化的文件，形如 data/avatars/<sid>.jpg） */
    accAvatarPath: (acc && acc.avatar) || '',
    /** 经云函数转好的 dataURL，由 refresh() 异步填充；空 = 只显示首字母占位 */
    accAvatar: '',
  }
}

/**
 * [20261014] 刷新账号条，并同步当前抖音账号的真实头像。
 * 头像来源与网页面板右上角切换器同源：/api/accounts 返回的 a.avatar。
 * 小程序 <image> 带不了 X-Panel-Token 头，所以走云函数 assets 转 base64
 * （与好友列表同一条通道，自带批量合并 / 失败重试 / 缓存），拿到后覆盖在
 * 首字母占位上；取不到就只显示首字母，不会留一个裂图框。
 * @param {object} page  页面实例
 * @param {object} [extra] 额外合并进 setData 的字段（如 records 复位 scope）
 */
function refresh(page, extra) {
  const d = build()
  if (extra) Object.assign(d, extra)
  page.setData(d)
  syncAvatar(page)
}

/** 异步解析当前账号头像并写回页面；解析期间用户又切了账号就丢弃过期结果，避免串图 */
function syncAvatar(page) {
  const app = getApp()
  const cur = app && app.globalData.currentAccount
  const acc = (app && app.globalData.accountMap || {})[String(cur)] || null
  const raw = (acc && acc.avatar) || ''
  if (!raw) {
    page.setData({ accAvatar: '' })
    return
  }
  av.resolve(raw, function (src) {
    if (String(app.globalData.currentAccount) !== String(cur)) return
    page.setData({ accAvatar: src || '' })
  })
}

/**
 * 弹出账号切换面板
 * @param {function} done 切换成功后回调（页面里通常重新 load）
 */
function switchAccount(done) {
  const app = getApp()
  const list = (app && app.globalData.accounts) || []
  if (!list.length) {
    ui.toast('当前用户没有绑定抖音账号')
    return
  }
  if (list.length === 1) {
    ui.toast('只有一个账号')
    return
  }
  wx.showActionSheet({
    itemList: list.map(function (a) {
      return a.username || String(a.unique_id)
    }),
    success: function (res) {
      const a = list[res.tapIndex]
      if (!a) return
      app.setCurrentAccount(a.unique_id)
      if (done) done()
    },
    fail: function () {},
  })
}

module.exports = { build: build, refresh: refresh, syncAvatar: syncAvatar, switchAccount: switchAccount }
