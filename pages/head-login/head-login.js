const api = require('../../utils/api.js')
const ui = require('../../utils/ui.js')

/** 子进程上报的 stage → 用户可读文案。
 *
 * [20261007] 线上实测：浏览器启动 + 打开抖音登录页要 130 秒以上，这期间服务器
 * 还没填手机号、更没请求验证码。旧版页面在发起成功的第 0 秒就写死
 * 「验证码已发送，请查看手机短信」——用户等不到短信，提前把验证码输进去，
 * 会被面板判为「该任务不是短信登录模式」（实测 t+2.5s 提交即 400），
 * 从用户视角就是「浏览器登录坏了」。现在严格按 stage 显示真实进度。
 */
const STAGE_TEXT = {
  browser_launch: '正在启动服务器浏览器…',
  login_modal_open: '正在打开抖音登录页…',
  sms_sending: '正在自动填写手机号…',
  sms_sent: '验证码已发送，请查看手机短信',
  sms_captcha: '已提交手机号，但出现人机验证',
  sms_error: '手机号提交失败',
  sms_submitting: '验证码已提交，正在登录…',
}

/** 只有到这些阶段，验证码才是真的可以提交（sms_submitting 允许纠错重提） */
const CODE_READY = { sms_sent: 1, sms_captcha: 1, sms_submitting: 1 }

Page({
  data: {
    uid: '',
    phone: '',
    started: false,
    jobId: '',
    status: 'starting',
    stage: '',
    statusText: '正在启动…',
    message: '',
    err: '',
    code: '',
    canInputCode: false,
    submitting: false,
    busy: false,
  },

  onLoad(q) {
    this._alive = true
    this._stopped = false
    this.setData({ uid: (q && q.uid) || '' })
  },

  onUnload() {
    this._alive = false
  },

  onPhone(e) {
    this.setData({ phone: e.detail.value })
  },

  onCode(e) {
    this.setData({ code: e.detail.value })
  },

  /** 发起短信登录：服务器自动填号并点「获取验证码」 */
  async sendCode() {
    const phone = String(this.data.phone || '').trim()
    if (!/^1\d{10}$/.test(phone)) return ui.toast('请输入 11 位手机号')
    this.setData({ busy: true, err: '' })
    try {
      const r = await api.panel('/api/accounts/' + this.data.uid + '/head-login', 'POST', {
        phone: phone,
      })
      const job = r.job || {}
      if (!job.id) throw new Error(r.error || '启动失败')
      this._stopped = false
      const stage = job.stage || 'browser_launch'
      this.setData({
        started: true,
        jobId: job.id,
        status: job.status || 'waiting',
        stage: stage,
        statusText: STAGE_TEXT[stage] || '正在启动服务器浏览器…',
        message: '服务器正在打开抖音登录页，就绪后这里会提示你可以输入验证码。',
        canInputCode: false,
      })
      this.poll(0)
    } catch (e) {
      this.setData({ err: e.message || '启动失败' })
    } finally {
      this.setData({ busy: false })
    }
  },

  poll(n) {
    const that = this
    if (!this._alive || this._stopped) return
    if (n > 400) {
      this.setData({ status: 'timeout', statusText: '等待超时', err: '登录会话已超时，请重新发起' })
      return
    }
    api
      .get('/api/accounts/head-login/' + this.data.jobId)
      .then(function (d) {
        const job = d.job || {}
        const st = job.status || 'waiting'
        const stage = job.stage || ''
        const done = st === 'success' || st === 'error' || st === 'timeout' || st === 'cancelled'
        let text = STAGE_TEXT[stage] || '等待中…'
        if (st === 'success') text = '登录成功'
        else if (st === 'error') text = job.error || '出错了'
        else if (st === 'timeout') text = job.error || '登录超时'
        else if (st === 'cancelled') text = '已取消'
        that.setData({
          status: st,
          stage: stage,
          statusText: text,
          message: job.message || '',
          err: st === 'error' ? job.error || '' : '',
          canInputCode: !done && !!CODE_READY[stage],
        })
        if (st === 'success') {
          ui.ok('登录成功')
          const app = getApp()
          app.loadAccounts({ live: true }).catch(function () {})
          setTimeout(function () {
            wx.navigateBack()
          }, 1200)
          return
        }
        if (done) return
        setTimeout(function () {
          that.poll(n + 1)
        }, 3000)
      })
      .catch(function (e) {
        that.setData({ err: e.message || '状态查询失败' })
        setTimeout(function () {
          that.poll(n + 1)
        }, 3000)
      })
  },

  async submitCode() {
    if (!this.data.canInputCode) return ui.toast('服务器还没准备好，请等提示出现再输入')
    const code = String(this.data.code || '').trim()
    if (!/^\d{4,8}$/.test(code)) return ui.toast('请输入 4~8 位数字验证码')
    this.setData({ submitting: true, err: '' })
    try {
      await api.panel('/api/accounts/head-login/' + this.data.jobId + '/sms-code', 'POST', { code: code })
      ui.ok('已提交，等待登录')
      // 不重开轮询链：现有那条还在跑（非终态不会自行结束），避免两条链叠加
      this.setData({ code: '' })
    } catch (e) {
      this.setData({ err: e.message || '提交失败' })
      ui.toast(e.message || '提交失败')
    } finally {
      this.setData({ submitting: false })
    }
  },

  /** 取消会话：会话会独占服务器屏幕直到 600 秒超时，误触发后必须能停下来 */
  async cancelLogin() {
    if (!this.data.jobId) return
    const ok = await ui.confirm('取消后需要重新发起登录，已收到的验证码也会作废。', '取消登录')
    if (!ok) return
    this._stopped = true
    try {
      await api.panel('/api/accounts/head-login/' + this.data.jobId + '/cancel', 'POST', {})
      ui.toast('已取消')
    } catch (e) {
      ui.toast(e.message || '取消失败')
    }
    this.setData({
      status: 'cancelled',
      stage: '',
      statusText: '已取消',
      message: '',
      canInputCode: false,
    })
  },

  restart() {
    this._stopped = false
    this.setData({
      started: false,
      jobId: '',
      code: '',
      status: 'starting',
      stage: '',
      statusText: '',
      message: '',
      err: '',
      canInputCode: false,
    })
  },
})
