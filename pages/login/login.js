const api = require('../../utils/api.js')
const ui = require('../../utils/ui.js')

Page({
  data: {
    username: '',
    password: '',
    loading: false,
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
      const app = getApp()
      app.globalData.loggedIn = true
      app.globalData.session = r.session
      wx.setStorageSync('last_username', username)
      await app.loadAccounts({ live: false })
      app.pickDefaultAccount()
      ui.ok('登录成功')
      setTimeout(function () {
        wx.reLaunch({ url: '/pages/overview/overview' })
      }, 350)
      // 账号登录态真校验放后台跑，别卡住跳转
      app.refreshAccountStatus()
    } catch (e) {
      this.setData({ err: e.message || '登录失败' })
    } finally {
      this.setData({ loading: false })
    }
  },
})
