const CONFIG = require('./config.js')
const api = require('./utils/api.js')

App({
  globalData: {
    ready: false, // 启动鉴权是否已完成
    loggedIn: false,
    session: null, // { username, isAdmin, accountUids, expire }
    accounts: [], // 账号列表（/api/accounts）
    accountMap: {},
    currentAccount: null, // 当前选中账号 uid
    accountLiveLoaded: false, // 是否已跑过一次真校验（?live=1）
    bootError: '',
  },

  onLaunch() {
    if (!wx.cloud) {
      this.globalData.bootError = '当前基础库过低，无法使用云开发能力，请升级微信'
      this.globalData.ready = true
      return
    }
    // 注意：DYNAMIC_CURRENT_ENV 是 wx-server-sdk（服务端）的常量，客户端拿不到。
    // 客户端要「默认环境」就把 env 整个省掉，不要传 undefined。
    const initOpts = { traceUser: true }
    if (CONFIG.CLOUD_ENV) initOpts.env = CONFIG.CLOUD_ENV
    wx.cloud.init(initOpts)

    // 面板 token 失效（云函数统一返回 NEED_LOGIN）时自动回登录页。
    // 加节流，避免一屏多个并发请求同时触发多次 reLaunch。
    const self = this
    let jumping = false
    api.onNeedLogin(function () {
      if (jumping) return
      jumping = true
      self.globalData.loggedIn = false
      self.globalData.session = null
      wx.reLaunch({
        url: '/pages/login/login',
        complete: function () {
          setTimeout(function () {
            jumping = false
          }, 1500)
        },
      })
    })

    this._readyPromise = this._boot()
  },

  /** 启动：问云函数要登录态，有则顺带拉账号列表 */
  async _boot() {
    try {
      const r = await api.raw('profile')
      if (r.loggedIn) {
        this.globalData.loggedIn = true
        this.globalData.session = r.session
        await this.loadAccounts({ live: false })
        this.pickDefaultAccount()
      }
    } catch (e) {
      this.globalData.bootError = e.message || '启动检查失败'
    } finally {
      this.globalData.ready = true
    }
    return this.globalData
  },

  /** 页面里统一 await 这个，保证启动检查已完成 */
  ensureReady() {
    if (!this._readyPromise) this._readyPromise = this._boot()
    return this._readyPromise
  },

  /** 拉账号列表。live=false 走毫秒级快路径（登录状态标「校验中」），live=true 真校验 */
  async loadAccounts(opts) {
    const live = !!(opts && opts.live)
    const r = await api.raw('call', {
      path: '/api/accounts' + (live ? '?live=1' : ''),
      method: 'GET',
      timeout: live ? 60000 : 20000,
    })
    const d = r.data || {}
    const list = d.accounts || []
    this.globalData.accounts = list
    const map = {}
    list.forEach((a) => {
      map[String(a.unique_id)] = a
    })
    this.globalData.accountMap = map
    if (live) this.globalData.accountLiveLoaded = true
    // 当前账号可能已被移除
    const cur = this.globalData.currentAccount
    if (cur && !map[String(cur)]) {
      this.globalData.currentAccount = null
      this.pickDefaultAccount()
    }
    return list
  },

  /** 后台补一次真校验，回来只刷新徽章，不打断用户操作 */
  refreshAccountStatus() {
    if (this.globalData.accountLiveLoaded) return Promise.resolve()
    return this.loadAccounts({ live: true }).catch(() => {})
  },

  pickDefaultAccount() {
    const list = this.globalData.accounts
    if (!list.length) {
      this.globalData.currentAccount = null
      return
    }
    const saved = wx.getStorageSync('current_account')
    const hit = saved && list.some((a) => String(a.unique_id) === String(saved))
    this.globalData.currentAccount = hit ? String(saved) : String(list[0].unique_id)
  },

  setCurrentAccount(uid) {
    this.globalData.currentAccount = uid ? String(uid) : null
    if (uid) wx.setStorageSync('current_account', String(uid))
  },

  /** 当前账号的 uid 数组（用于后端按账号过滤）；返回 [] 表示无可用账号 */
  allowedAccount() {
    const uid = this.globalData.currentAccount
    return uid ? String(uid) : ''
  },

  /** 退出：清云函数会话 + 本地状态 */
  async logout() {
    try {
      await api.raw('logout')
    } catch (e) {
      /* 忽略 */
    }
    this.globalData.loggedIn = false
    this.globalData.session = null
    this.globalData.accounts = []
    this.globalData.accountMap = {}
    this.globalData.currentAccount = null
    this.globalData.accountLiveLoaded = false
    wx.removeStorageSync('current_account')
  },

  /** 统一的「请先登录」处理 */
  toLogin() {
    this.globalData.loggedIn = false
    wx.reLaunch({ url: '/pages/login/login' })
  },
})
