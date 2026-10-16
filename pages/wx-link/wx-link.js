const api = require('../../utils/api.js')
const ui = require('../../utils/ui.js')

/**
 * [20261016] 微信绑定 / 网页登录确认
 *
 * 两种用途共用一个页面（都只需要一个 6 位数字码）：
 *   ① 绑定微信：管理员在网页面板「面板用户 → 生成绑定码」拿到 6 位码，
 *      在这里输入 → 这个微信就绑到那个面板账号，以后可以一键免密登录。
 *   ② 网页登录确认：网页端点了「微信登录」会显示 6 位登录码，
 *      在这里输入（或扫码）→ 网页那个浏览器就登录成你。
 *
 * 二维码/条码都只是「把 6 位码塞进去」的载体，所以 wx.scanCode 扫出来的
 * 字符串一律用正则抽出 6 位数字，别指望格式固定。
 *
 * 本页**刻意不加登录守卫**：确认网页登录只需要 openid（云函数侧给的），
 * 不依赖本地会话 —— 免得「小程序会话过期了反而没法确认网页登录」。
 */
Page({
    data: {
      mode: 'bind', // bind | confirm
      code: '',
      loading: false,
      status: null, // { wxBound, bridgeOk, username }
      isAdmin: false,
      err: '',
      msg: '',
    },

    onLoad(query) {
      const app = getApp()
      const sess = (app && app.globalData && app.globalData.session) || {}
      this.setData({ isAdmin: !!sess.isAdmin })
      // 带 ?mode=confirm 进来就直接落在「网页登录确认」（网页提示用户点进来时用）
      if (query && query.mode === 'confirm') this.setData({ mode: 'confirm' })
      this.loadStatus()
    },

    onShow() {
      this.loadStatus()
    },

    async loadStatus() {
      try {
        const r = await api.raw('wxStatus')
        this.setData({ status: r })
      } catch (e) {
        this.setData({ status: { wxBound: false, bridgeOk: false, username: '' } })
      }
    },

    switchMode(e) {
      const m = e.currentTarget.dataset.m
      if (m === this.data.mode) return
      this.setData({ mode: m, code: '', err: '', msg: '' })
    },

    onCode(e) {
      this.setData({ code: e.detail.value, err: '', msg: '' })
    },

    /** 从剪贴板粘贴（网页上长按复制过来的码） */
    async paste() {
      try {
        const r = await wx.getClipboardData()
        const m = String((r && r.data) || '').match(/(\d{6})/)
        if (!m) return ui.toast('剪贴板里没有 6 位数字')
        this.setData({ code: m[1], err: '', msg: '' })
      } catch (e) {
        ui.toast('读取剪贴板失败')
      }
    },

    /** 扫码：网页上显示二维码时用（内容里含 6 位码） */
    scan() {
      const self = this
      wx.scanCode({
        scanType: ['qrCode', 'barCode'],
        success(res) {
          const m = String((res && res.result) || '').match(/(\d{6})/)
          if (!m) return ui.toast('这个码里没有 6 位登录码')
          self.setData({ code: m[1], err: '', msg: '' })
        },
        fail() {
          /* 用户取消，不提示 */
        },
      })
    },

    async submit() {
      const code = String(this.data.code || '').trim()
      if (!/^\d{6}$/.test(code)) {
        this.setData({ err: '请输入 6 位数字' })
        return
      }
      const isBind = this.data.mode === 'bind'
      this.setData({ loading: true, err: '', msg: '' })
      try {
        if (isBind) {
          const r = await api.raw('wxBind', { code: code })
          const app = getApp()
          app.globalData.loggedIn = true
          app.globalData.session = r.session
          if (r.session && r.session.username) {
            wx.setStorageSync('last_username', r.session.username)
          }
          await app.loadAccounts({ live: false })
          app.pickDefaultAccount()
          ui.ok('绑定成功')
          this.setData({
            code: '',
            msg: '已绑定到面板账号「' + (r.username || '') + '」，下次打开小程序可直接进，不用再输密码',
          })
          this.loadStatus()
        } else {
          const r = await api.raw('wxQrConfirm', { code: code })
          ui.ok('网页已登录')
          this.setData({ code: '', msg: '已确认登录（' + (r.username || '') + '），回到电脑上看看' })
        }
      } catch (e) {
        this.setData({ err: (e && e.message) || '操作失败' })
      } finally {
        this.setData({ loading: false })
      }
    },

    goPanelUsers() {
      wx.navigateTo({ url: '/pages/panel-users/panel-users' })
    },
})
