const api = require('../../utils/api.js')
const ui = require('../../utils/ui.js')

Page({
  data: {
    username: '',
    password: '',
    loading: false,
    wxLoading: false,
    wxBound: null,   // null=未知 / true=已绑定 / false=这个微信还没绑定
    err: '',
    envOk: null,
    envMsg: '',
  },

  onLoad() {
    const app = getApp()
    if (app && app.globalData.loggedIn) {
      wx.reLaunch({ url: '/pages/overview/overview' })
      return
    }
    const saved = wx.getStorageSync('last_username')
    if (saved) this.setData({ username: saved })
    this.checkEnv()
    this.autoWxLogin()
  },

  /** 静默试一次微信免密登录：绑过就直接进，没绑过只记状态不打扰 */
  async autoWxLogin() {
    try {
      const r = await api.raw('wxLogin')
      if (r && r.bound && r.session) {
        this._enter(r.session, '微信免密登录')
      } else {
        this.setData({ wxBound: false })
      }
    } catch (e) {
      // 桥没配好/面板不可用时不弹错，留着手动登录这条路
      this.setData({ wxBound: false })
    }
  },

  /** 登录成功后的统一落地（账号密码 / 微信两条路共用） */
  async _enter(session, tip) {
    const app = getApp()
    app.globalData.loggedIn = true
    app.globalData.session = session
    if (session && session.username) wx.setStorageSync('last_username', session.username)
    await app.loadAccounts({ live: false })
    app.pickDefaultAccount()
    ui.ok(tip || '登录成功')
    setTimeout(function () {
      wx.reLaunch({ url: '/pages/overview/overview' })
    }, 350)
    // 账号登录态真校验放后台跑，别卡住跳转
    app.refreshAccountStatus()
  },

  async wxLogin() {
    this.setData({ wxLoading: true, err: '' })
    try {
      const r = await api.raw('wxLogin')
      if (!r || !r.bound || !r.session) {
        this.setData({
          wxBound: false,
          err: (r && r.message) || '这个微信还没有绑定面板账号，请先用账号密码登录后在「我的 → 微信绑定」里绑定',
        })
        return
      }
      this.setData({ wxBound: true })
      await this._enter(r.session, '微信登录成功')
    } catch (e) {
      this.setData({ err: e.message || '微信登录失败' })
    } finally {
      this.setData({ wxLoading: false })
    }
  },

  onUser(e) {
    this.setData({ username: e.detail.value, err: '' })
  },

  onPass(e) {
    this.setData({ password: e.detail.value, err: '' })
  },

  async checkEnv() {
    try {
      await api.raw('ping')
      this.setData({ envOk: true, envMsg: '' })
    } catch (e) {
      this.setData({ envOk: false, envMsg: e.message || '云函数未部署' })
    }
  },

  async submit() {
    const username = String(this.data.username || '').trim()
    const password = String(this.data.password || '')
    if (!username || !password) {
      this.setData({ err: '请填写用户名和密码' })
      return
    }
    this.setData({ loading: true, err: '' })
    try {
      const r = await api.raw('login', { username: username, password: password })
      wx.setStorageSync('last_username', username)
      /* [20261017] 后端登录成功时会顺带把这个微信绑到该账号（返回 auto_bind），
         这里如实转达：绑上了就说「以后免密进」；没绑上要说明原因
         （最常见是「该微信已绑定到别的账号」），否则用户下次还得输密码、
         却完全不知道为什么。 */
      const ab = r.auto_bind
      let tip = '登录成功'
      if (ab && ab.bound) tip = '登录成功，已绑定微信，以后可直接进入'
      else if (ab && ab.error) tip = '登录成功（微信未绑定：' + ab.error + '）'
      await this._enter(r.session, tip)
    } catch (e) {
      this.setData({ err: e.message || '登录失败' })
    } finally {
      this.setData({ loading: false })
    }
  },
})
