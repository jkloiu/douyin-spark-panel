const api = require('../../utils/api.js')
const ui = require('../../utils/ui.js')

const STATUS = {
  starting: '正在打开抖音登录页…',
  waiting: '等待二维码加载…',
  scanning: '请用抖音 App 扫码登录',
  need_verify: '需要短信验证码',
  success: '登录成功',
  expired: '二维码已过期',
  error: '出错了',
}

Page({
  data: {
    uid: '',
    status: 'starting',
    statusText: '正在启动…',
    qrSrc: '',
    err: '',
    msg: '',
    jobId: '',
    starting: true,
    needVerify: false,
    code: '',
    submitting: false,
  },

  onLoad(q) {
    this._alive = true
    this._lastUrl = ''
    this.setData({ uid: (q && q.uid) || '' })
    this.start()
  },

  onUnload() {
    this._alive = false
    // 退出页面就取消服务端任务：QR 任务会一直占着浏览器锁（最长 3 分钟），
    // 不取消的话下次发起会被「有任务正在使用浏览器」挡住。
    if (this.data.jobId && this.data.status !== 'success') {
      api
        .panel('/api/accounts/qr/' + this.data.jobId + '/cancel', 'POST', {})
        .catch(function () {})
    }
  },

  async start() {
    this._lastUrl = ''
    this.setData({
      starting: true, err: '', msg: '', qrSrc: '', status: 'starting',
      statusText: '正在启动…', needVerify: false, code: '',
    })
    try {
      const r = await api.panel('/api/accounts/' + this.data.uid + '/qr', 'POST', {})
      const job = r.job || {}
      if (!job.id) throw new Error('启动失败')
      this.setData({ jobId: job.id, starting: false })
      this.poll(0)
    } catch (e) {
      this.setData({ starting: false, err: e.message || '启动失败' })
    }
  },

  poll(n) {
    const that = this
    if (!this._alive) return
    if (n > 150) {
      this.setData({ err: '等待超时，请重新发起' })
      return
    }
    api
      .get('/api/accounts/qr/' + this.data.jobId)
      .then(function (d) {
        const job = d.job || {}
        const st = job.status || 'waiting'
        const patch = {
          status: st,
          // 服务端 message 是权威文案（含「已等待」类心跳），没有才回落到本地表
          statusText: job.message || STATUS[st] || st,
          msg: job.message || '',
          err: job.error || '',
          needVerify: st === 'need_verify',
        }
        // 二维码地址变了才重新取（服务端会刷新二维码）
        if (job.qrcode_url && job.qrcode_url !== that._lastUrl) {
          that._lastUrl = job.qrcode_url
          const url = job.qrcode_url
          api
            .asset(url)
            .then(function (src) {
              if (that._alive && that._lastUrl === url) that.setData({ qrSrc: src })
            })
            .catch(function () {
              that._lastUrl = ''
              that.setData({ err: '二维码图片加载失败，请点「重新获取二维码」' })
            })
        }
        that.setData(patch)
        if (st === 'success') {
          ui.ok('登录成功')
          const app = getApp()
          app.loadAccounts({ live: true }).catch(function () {})
          setTimeout(function () {
            wx.navigateBack()
          }, 1200)
          return
        }
        if (st === 'error' || st === 'expired') return
        setTimeout(function () {
          that.poll(n + 1)
        }, 2500)
      })
      .catch(function (e) {
        that.setData({ err: e.message || '状态查询失败' })
        setTimeout(function () {
          that.poll(n + 1)
        }, 3000)
      })
  },

  onCodeInput(e) {
    this.setData({ code: (e.detail.value || '').trim() })
  },

  async submitCode() {
    if (this.data.submitting) return
    const code = (this.data.code || '').trim()
    if (!/^\d{4,8}$/.test(code)) {
      ui.toast('验证码为 4~8 位数字')
      return
    }
    this.setData({ submitting: true })
    try {
      await api.panel('/api/accounts/qr/' + this.data.jobId + '/verify-code', 'POST', { code: code })
      ui.toast('已提交，正在登录…')
      this.setData({ code: '' })
    } catch (e) {
      ui.toast(e.message || '提交失败')
    } finally {
      this.setData({ submitting: false })
    }
  },

  retry() {
    this.start()
  },
})
