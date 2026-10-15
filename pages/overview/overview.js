const { guard } = require('../../utils/page.js')
const api = require('../../utils/api.js')
const fmt = require('../../utils/format.js')
const av = require('../../utils/avatar.js')
const accbar = require('../../utils/accbar.js')
const notif = require('../../utils/notif.js')

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
      accOk: null,
      /** 当前抖音账号的真实头像（dataURL，空 = 首字母占位），由 accbar.refresh 填充 */
      accAvatar: '',

      date: '',
      todaySent: false,
      recent: null,
      stats: { total: 0, max: 0, min: 0, risk: 0, warn: 0, ok: 0, stale: 0, sent: 0, pending: 0 },
      friends: [],
      session: null,
      notifCount: 0,
    },

    onShow() {
      this.syncAccounts()
      this.load()
      this.loadNotif()
    },

    onPullDownRefresh() {
      Promise.resolve(this.load()).then(function () {
        wx.stopPullDownRefresh()
      })
    },

    syncAccounts() {
      accbar.refresh(this)
    },

    onSwitchAccount() {
      const that = this
      accbar.switchAccount(function () {
        that.syncAccounts()
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

      // 账号登录态后台补一次真校验，回来后只刷新顶部账号条。
      // ⚠️ 必须走 accbar.refresh（= build + syncAvatar）：只把 build() 的结果 setData
      // 上去会把 accAvatar 清空，而 live 校验完成后 accountLiveLoaded 已置真，
      // 之后每次 load() 都会立刻清一次且不再同步 → 头像永远显示不出来。
      const self = this
      app.refreshAccountStatus().then(function () {
        self.syncAccounts()
      })

      try {
        const d = await api.get('/api/overview', { account: uid })
        const rawFriends = d.friends || []

        let max = 0
        let min = 0
        let risk = 0
        let warn = 0
        let ok = 0
        let stale = 0
        let sent = 0
        let pending = 0

        const friends = rawFriends.map(function (f) {
          const lv = fmt.sparkLevel(f.spark_days)
          const days = Number(f.spark_days || 0)
          if (days > max) max = days
          if (min === 0 || days < min) min = days
          if (lv.key === 'ok') ok++
          else if (lv.key === 'warn') warn++
          else risk++
          if (!f.fresh) stale++
          /* [20261014] 今日续了没有：已续/未续，概览里直接给提醒 */
          if (f.today_sent) sent++
          else pending++
          const nm = fmt.dispName(f)
          return {
            short_id: f.short_id,
            name: nm,
            avatar: f.avatar || '',
            __avatar: '',
            initial: fmt.initial(nm),
            days: days,
            levelText: lv.text,
            /* [20261014b] 概览里「正常」等级也是每天的常态 → 中性灰徽章，
               否则每个好友行都挂着两个绿徽章，整页太绿。
               只有「注意 / 危险 / 已断」这类异常才保留彩色（spark 明细页不变）。 */
            levelCls: lv.key === 'ok' ? '' : lv.cls,
            levelKey: lv.key,
            fresh: !!f.fresh,
            todaySent: !!f.today_sent,
          }
        })

        // 最近一次执行：单独续 / 批量续里取更新的那条
        const cands = []
        if (d.custom && d.custom.recent) cands.push(d.custom.recent)
        if (d.main && d.main.recent) cands.push(d.main.recent)
        cands.sort(function (a, b) {
          const ta = fmt.toDate(a.ts)
          const tb = fmt.toDate(b.ts)
          return (tb ? tb.getTime() : 0) - (ta ? ta.getTime() : 0)
        })
        const recent = cands[0]
          ? {
              task: cands[0].task === 'custom' ? '单独续' : '批量续',
              ts: cands[0].ts,
              tsText: fmt.fmtFull(cands[0].ts),
              success: cands[0].success !== false,
              sent: cands[0].sent,
              target: cands[0].target,
            }
          : null

        this.setData({
          loading: false,
          date: d.date || '',
          todaySent: !!(d.custom && d.custom.sent_today) || !!(d.main && d.main.sent_today),
          recent: recent,
          stats: {
            total: friends.length,
            max: max,
            min: min,
            risk: risk,
            warn: warn,
            ok: ok,
            stale: stale,
            sent: sent,
            pending: pending,
          },
          friends: friends,
        })

        // 本地头像异步转 base64 后再刷一次
        const that = this
        av.resolveList(friends, 'avatar', function () {
          that.setData({ friends: friends })
        })
      } catch (e) {
        this.setData({ loading: false, err: e.message || '加载失败' })
      }
    },

    /**
     * 通知红点 = **未读 且 异常** 的条数（跟「我的」页同一个口径）。
     * 面板的通知列表是只增不减的流水、没有「单条已读」，所以必须叠一层本地已读水位线；
     * 之前这里直接用「非 ok 的条数」算红点，没叠水位线 → 点进通知中心也永远消不掉。
     */
    async loadNotif() {
      const app = getApp()
      const uname = (app && app.globalData.session && app.globalData.session.username) || ''
      try {
        const d = await api.get('/api/notifications')
        const list = d.notifications || []
        const c = notif.counts(list, uname)
        this.setData({ notifCount: c.badge })
        // [修复20261005] 概览页是默认首页，冷启动直接落在这里。以前这里不刷 tabBar
        // 角标（只有「我的」页和通知页会刷），于是新来的异常通知在底部 tabBar 上
        // 根本不亮，用户得手动点进「我的」才看得到。
        notif.syncTabBadge(c.badge)
        if (app) app.globalData.notifBadge = c.badge
      } catch (e) {
        /* 通知失败不影响主页 */
      }
    },

    goFriend(e) {
      const sid = e.currentTarget.dataset.sid
      wx.navigateTo({ url: '/pages/friend-detail/friend-detail?sid=' + sid })
    },
    goDaily() {
      wx.navigateTo({ url: '/pages/daily/daily' })
    },
    goContacts() {
      wx.navigateTo({ url: '/pages/contacts/contacts' })
    },
    goAccounts() {
      wx.navigateTo({ url: '/pages/accounts/accounts' })
    },
    goNotif() {
      wx.navigateTo({ url: '/pages/notifications/notifications' })
    },
    goSpark() {
      wx.switchTab({ url: '/pages/spark/spark' })
    },
  })
)
