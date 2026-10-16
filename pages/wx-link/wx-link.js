const api = require('../../utils/api.js')
const ui = require('../../utils/ui.js')

/**
 * [20261016] 微信绑定 / 网页登录确认
 * [20261017] **绑定界面已移除** —— v1.9.5 起「账号密码登录成功即自动绑定」，
 *   不再需要手动输入绑定码；面板用户页的「生成绑定码」入口也一并撤了。
 *   本页现在只剩一件事：确认网页端那次扫码登录（电脑出 6 位码 → 这里输 → 网页登录）。
 *
 * 为什么保留这一页：openid 只在微信侧产生，而网页那边拿不到 openid，
 * 绑定码/登录票据这类「一次性凭据」总得有个从手机送过去的通道。
 *
 * 本页**刻意不加登录守卫**：确认网页登录只需要 openid（云函数侧给的），
 * 不依赖本地会话 —— 免得「小程序会话过期了反而没法确认网页登录」。
 */
Page({
    data: {
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
      // [20261017] 绑定 tab 已移除，本页只剩「确认网页登录」，不再需要切换
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
        this.setData({ loading: true, err: '', msg: '' })
        try {
            const r = await api.raw('wxQrConfirm', { code: code })
            ui.ok('网页已登录')
            this.setData({ code: '', msg: '已确认登录（' + (r.username || '') + '），回到电脑上看看' })
        } catch (e) {
            this.setData({ err: (e && e.message) || '确认失败' })
        } finally {
            this.setData({ loading: false })
        }
    },

    goPanelUsers() {
      wx.navigateTo({ url: '/pages/panel-users/panel-users' })
    },
})
