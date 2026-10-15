const { guard } = require('../../utils/page.js')
const api = require('../../utils/api.js')
const fmt = require('../../utils/format.js')
const av = require('../../utils/avatar.js')
const accbar = require('../../utils/accbar.js')
const ui = require('../../utils/ui.js')

const GRAB_POLL_MS = 3000 // 抓取任务状态轮询间隔
const GRAB_MAX_SEC = 240 // 超过这么久还没结束就放开按钮，让用户自己刷新

/** 面板的 error 常带一长串括号细节（goto/reload/选择器…），界面上只留前半句 */
function brief(txt) {
  const s = String(txt || '抓取出错')
  const head = s.split(/[（(]/)[0].trim()
  return (head || s).slice(0, 30)
}

Page(
  guard({
    data: {
      loading: true,
      err: '',
      accList: [],
      accCur: null,
      accName: '',
      accInitial: '?',
      accLive: true,
      /** 当前抖音账号的真实头像（dataURL，空 = 首字母占位），由 accbar.refresh 填充 */
      accAvatar: '',

      tab: 'all',
      counts: { all: 0, risk: 0, warn: 0, ok: 0 },
      all: [],
      list: [],
      staleCount: 0,

      // 手动抓火花：grabbing 期间按钮禁点，grabSec 是已用秒数，grabTip 是副标题
      grabbing: false,
      grabSec: 0,
      grabTip: '',
    },

    onShow() {
      accbar.refresh(this)
      this.load()
    },

    onPullDownRefresh() {
      const that = this
      Promise.resolve(this.load()).then(function () {
        wx.stopPullDownRefresh()
      })
    },

    // 离开页面就停掉抓取轮询：抓取在服务器后台照跑，
    // 回来 onShow 会重新拉一次数据，别让定时器在后台空转
    onHide() {
      this.abortGrabPoll()
    },

    onUnload() {
      this.abortGrabPoll()
    },

    onSwitchAccount() {
      const that = this
      accbar.switchAccount(function () {
        accbar.refresh(that)
        that.load()
      })
    },

    async load() {
      const app = getApp()
      const uid = app.globalData.currentAccount
      this.setData({ loading: true, err: '' })
      if (!uid) {
        this.setData({ loading: false, err: '当前用户没有绑定抖音账号' })
        return
      }
      try {
        const d = await api.get('/api/friends', { account: uid })
        const counts = { all: 0, risk: 0, warn: 0, ok: 0 }
        let stale = 0
        const all = (d.friends || []).map(function (f) {
          const lv = fmt.sparkLevel(f.spark_days)
          const nm = fmt.dispName(f)
          counts.all++
          if (lv.key === 'ok') counts.ok++
          else if (lv.key === 'warn') counts.warn++
          else counts.risk++
          if (!f.fresh) stale++
          return {
            short_id: f.short_id,
            name: nm,
            douyin_id: fmt.douyinId(f),
            avatar: f.avatar || '',
            __avatar: '',
            initial: fmt.initial(nm),
            days: Number(f.spark_days || 0),
            levelText: lv.text,
            levelCls: lv.cls,
            levelKey: lv.key,
            fresh: !!f.fresh,
            todaySent: !!f.today_sent,
            // [修复20261007] 「最后一条」优先显示抓取回来的**真实会话消息**（last_message），
            // 抓不到（对方在线时抖音会话列表只显示「在线」，不渲染消息预览）才回落到
            // 我们自己的发送台账（last_content）。原来只读 last_content，
            // 于是抓多少次火花这句话都不会变 —— 用户看到的就是「抓取后历史消息不更新」。
            // 网页面板（panel/static/app.js）本来就是 last_message 优先，这里与它对齐。
            lastContent: f.last_message || f.last_content || '',
            lastTime: f.last_msg_time || '',
            status: f.status || '',
          }
        })
        all.sort(function (a, b) {
          return a.days - b.days
        })
        this.setData({
          loading: false,
          all: all,
          counts: counts,
          staleCount: stale,
        })
        this.applyTab()
        const that = this
        av.resolveList(all, 'avatar', function () {
          that.setData({ all: all })
          that.applyTab()
        })
      } catch (e) {
        this.setData({ loading: false, err: e.message || '加载失败' })
      }
    },

    applyTab() {
      const tab = this.data.tab
      const all = this.data.all
      let list = all
      if (tab === 'risk') {
        list = all.filter(function (f) {
          return f.levelKey !== 'ok' && f.levelKey !== 'warn'
        })
      } else if (tab === 'warn') {
        list = all.filter(function (f) {
          return f.levelKey === 'warn'
        })
      } else if (tab === 'ok') {
        list = all.filter(function (f) {
          return f.levelKey === 'ok'
        })
      }
      this.setData({ list: list })
    },

    onTab(e) {
      this.setData({ tab: e.currentTarget.dataset.t })
      this.applyTab()
    },

    /* ── 手动抓取火花 ───────────────────────────────────────────
       面板 /api/spark-check 是「异步任务」：POST 拿到 job_id，
       再按 job_id 轮询状态（done / error / not_found）。
       抓取期间按钮必须禁点 —— 连点会同时开出两个浏览器，
       把页面拖到 goto 超时（面板侧也加了同账号任务复用兜底）。 */
    async grabSpark() {
      const uid = getApp().globalData.currentAccount
      if (!uid) {
        ui.toast('当前用户没有绑定抖音账号')
        return
      }
      if (this.data.grabbing) return
      const go = await ui.confirm(
        '立即抓取火花数据？会占用浏览器，其他自动化任务需要排队等待，大约 20~40 秒。',
        '开始抓取'
      )
      if (go) await this.submitGrab(uid, false)
    },

    /** force=false 时命中缓存会返回 cached，此时再问一次要不要强制重抓 */
    async submitGrab(uid, force) {
      this.stopGrabPoll()
      this.setData({ grabbing: true, grabSec: 0, grabTip: '正在提交抓取任务…' })
      let r
      try {
        r = await api.post('/api/spark-check', { account: uid, force: !!force })
      } catch (e) {
        this.setData({ grabbing: false, grabTip: '' })
        ui.toast(e.message || '触发失败')
        return
      }
      if (r && r.ok === false) {
        this.setData({ grabbing: false, grabTip: '' })
        ui.toast(r.error || '触发失败')
        return
      }
      if (!r || !r.job_id) {
        this.setData({ grabbing: false, grabTip: '' })
        const again = await ui.confirm(
          (r && r.message) || '火花数据都是今天的（缓存保鲜期内），不需要重新抓取。',
          '无需重抓'
        )
        if (again) await this.submitGrab(uid, true)
        return
      }
      this.jobId = r.job_id
      this.setData({ grabTip: r.message || '正在抓取真实火花数据…' })
      this.pollGrab(uid)
    },

    pollGrab(uid) {
      const that = this
      this.stopGrabPoll()
      this._grabTimer = setInterval(function () {
        that.setData({ grabSec: that.data.grabSec + GRAB_POLL_MS / 1000 })
        that.checkGrab(uid)
      }, GRAB_POLL_MS)
      this.checkGrab(uid) // 立即探一次，不用干等第一个 3 秒
    },

    async checkGrab(uid) {
      if (!this.jobId) return
      let j
      try {
        j = await api.get('/api/spark-check/' + this.jobId)
      } catch (e) {
        return // 轮询失败静默，等下一轮
      }
      if (!j) return
      if (j.status === 'done') {
        const missed = (j.missed || []).length
        this.stopGrabPoll()
        this.setData({
          grabbing: false,
          grabSec: 0,
          grabTip: missed ? '抓取完成，' + missed + ' 位好友未更新' : '抓取完成，数据已刷新',
        })
        ui.ok(missed ? '完成，' + missed + ' 位未更新' : '抓取完成')
        await this.load()
        return
      }
      if (j.status === 'error') {
        const msg = j.need_login
          ? '该账号登录态已失效，请先重新登录'
          : brief(j.error) + '，稍后重试'
        this.stopGrabPoll()
        this.setData({ grabbing: false, grabSec: 0, grabTip: msg })
        ui.toast(msg)
        return
      }
      if (j.status === 'not_found') {
        this.stopGrabPoll()
        this.setData({ grabbing: false, grabSec: 0, grabTip: '任务已丢失（面板重启过），请重新抓取' })
        ui.toast('任务已丢失，请重新抓取')
        return
      }
      // 面板侧超时保护（see browser_lock MAX_HOLD）没生效时兜底
      if (this.data.grabSec >= GRAB_MAX_SEC) {
        this.stopGrabPoll()
        this.setData({ grabbing: false, grabSec: 0, grabTip: '抓取耗时过长，稍后下拉刷新看看' })
      }
    },

    stopGrabPoll() {
      if (this._grabTimer) {
        clearInterval(this._grabTimer)
        this._grabTimer = null
      }
    },

    abortGrabPoll() {
      this.stopGrabPoll()
      if (this.data.grabbing) this.setData({ grabbing: false, grabSec: 0, grabTip: '' })
    },

    goFriend(e) {
      const sid = e.currentTarget.dataset.sid
      wx.navigateTo({ url: '/pages/friend-detail/friend-detail?sid=' + sid })
    },
  })
)
