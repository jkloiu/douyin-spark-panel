/** 页面通用守卫：保证启动鉴权完成 + 未登录自动跳登录页 */

/**
 * 包装 Page 配置对象。
 * 会自动在 onShow 之前完成「启动鉴权检查」，未登录则 reLaunch 到登录页，
 * 并跳过页面自己的 onShow 逻辑。
 */
function guard(pageObj) {
  const origOnShow = pageObj.onShow
  const origOnLoad = pageObj.onLoad

  pageObj.onLoad = function (q) {
    this.__guardQuery = q || {}
    if (origOnLoad) origOnLoad.call(this, q)
  }

  pageObj.onShow = async function () {
    const app = getApp()
    if (!app) return
    await app.ensureReady()
    if (!app.globalData.loggedIn) {
      app.toLogin()
      return
    }
    if (origOnShow) origOnShow.call(this)
  }

  return pageObj
}

/** 取当前账号 uid（页面里高频使用） */
function acc() {
  const app = getApp()
  return (app && app.globalData.currentAccount) || ''
}

module.exports = { guard: guard, acc: acc }
