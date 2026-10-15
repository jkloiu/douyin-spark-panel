const { guard } = require('../../utils/page.js')
const api = require('../../utils/api.js')
const fmt = require('../../utils/format.js')
const ui = require('../../utils/ui.js')
const notif = require('../../utils/notif.js')

const TYPE_MAP = {
  ok: { cls: 'badge--ok', label: '正常' },
  info: { cls: 'badge--primary', label: '信息' },
  warn: { cls: 'badge--warn', label: '警告' },
  error: { cls: 'badge--danger', label: '异常' },
  err: { cls: 'badge--danger', label: '异常' },
  fail: { cls: 'badge--danger', label: '失败' },
}

Page(
  guard({
    data: {
      loading: true,
      err: '',
      list: [],
      visible: [],
      filter: 'all',
      newCount: 0,
      badCount: 0,
      detail: null,
    },

    onShow() {
      this.load()
    },

    /**
     * 离开页面 = 已读。
     * 水位线取「已加载列表的最大 t」，不取 Date.now()：
     * 手机时钟快/慢都不会把新通知误判成已读。
     */
    onHide() {
      this.markAllRead(true)
    },
    onUnload() {
      this.markAllRead(true)
    },

    username() {
      const app = getApp()
      return (app && app.globalData.session && app.globalData.session.username) || ''
    },

    onPullDownRefresh() {
      Promise.resolve(this.load()).then(function () {
        wx.stopPullDownRefresh()
      })
    },

    async load() {
      this.setData({ loading: true, err: '' })
      const uname = this.username()
      try {
        const d = await api.get('/api/notifications')
        const raw = (d.notifications || []).slice().reverse() // 面板是旧→新，倒过来最新在上
        const decorated = notif.decorate(raw, uname)
        const list = decorated.map(function (n, i) {
          const t = TYPE_MAP[n.type] || { cls: '', label: n.type || '通知' }
          return {
            idx: i,
            title: n.title || '通知',
            msg: n.msg || '',
            ts: n.t,
            timeText: fmt.relTime(n.t),
            fullTime: fmt.fmtFull(n.t),
            cls: t.cls,
            label: t.label,
            account: n.account_uid || '',
            isNew: !!n.isNew,
          }
        })
        this.__raw = raw
        const c = notif.counts(raw, uname)
        this.setData({
          loading: false,
          list: list,
          newCount: c.unread,
          badCount: c.bad,
        })
        this.applyFilter()
        // 进页面即已读：水位线取「已加载列表的最大 t」。
        // 不能只靠 onHide/onUnload —— 返回上一页时 onUnload(本页) 与 onShow(上一页)
        // 的先后顺序不保证，会让上一页的红点多残留一次（用户感受就是「消不掉」）。
        const mx = notif.maxTs(raw)
        if (mx) notif.markRead(uname, mx)
        notif.syncTabBadge(0)
        const app = getApp()
        if (app) app.globalData.notifBadge = 0
      } catch (e) {
        this.setData({ loading: false, err: e.message || '加载失败' })
      }
    },

    /** 手动「全部已读」；silent=true 时用于离开页面，不做提示 */
    markAllRead(silent) {
      const uname = this.username()
      const mx = notif.maxTs(this.__raw || [])
      if (!mx) {
        notif.syncTabBadge(0)
        return
      }
      notif.markRead(uname, mx)
      notif.syncTabBadge(0)
      const app = getApp()
      if (app) app.globalData.notifBadge = 0
      if (!silent) {
        this.setData({ newCount: 0 })
        const list = this.data.list.map(function (x) {
          return Object.assign({}, x, { isNew: false })
        })
        this.__raw = []
        this.setData({ list: list })
        this.applyFilter()
        ui.ok('已全部标为已读')
      }
    },

    onMarkRead() {
      if (!this.data.newCount) return ui.toast('没有未读通知')
      this.markAllRead(false)
    },

    applyFilter() {
      const f = this.data.filter
      const all = this.data.list
      this.setData({
        visible:
          f === 'all'
            ? all
            : f === 'new'
            ? all.filter(function (x) {
                return x.isNew
              })
            : all.filter(function (x) {
                return f === 'bad' ? x.cls !== 'badge--ok' : x.cls === 'badge--ok'
              }),
      })
    },

    onFilter(e) {
      this.setData({ filter: e.currentTarget.dataset.f })
      this.applyFilter()
    },

    async clearAll() {
      const ok = await ui.confirm('清空服务器上的所有通知记录？此操作不可撤销。', '清空通知')
      if (!ok) return
      try {
        await api.panel('/api/notifications/clear', 'POST', {})
        this.__raw = []
        notif.syncTabBadge(0)
        ui.ok('已清空')
        this.load()
      } catch (e) {
        ui.toast(e.message || '清空失败')
      }
    },

    /* [20261008] 点击通知 = 弹详情浮层看全文（列表里长正文被 max-height 截断，
       老实现只有「复制」，用户根本没法在页面上读完一条通知） */
    openDetail(e) {
      const i = e.currentTarget.dataset.i
      const n = this.data.visible[i]
      if (!n) return
      this.setData({ detail: n })
    },

    closeDetail() {
      this.setData({ detail: null })
    },

    /** 浮层内点空白不关闭（只有 ✕ / 关闭按钮 / 点遮罩才关） */
    noop() {},

    copyDetail() {
      const d = this.data.detail
      if (!d) return
      ui.copy(d.title + '\n' + (d.fullTime || '') + '\n' + (d.msg || ''), '通知已复制')
    },
  })
)
