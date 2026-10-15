const { guard } = require('../../utils/page.js')
const api = require('../../utils/api.js')
const fmt = require('../../utils/format.js')
const accbar = require('../../utils/accbar.js')

/** 历史记录里 target 可能是 '82123079303, 消息: 睡了吗？[暗中观察]' 这种拼接串，取前半段 */
function cleanTarget(r) {
  const t = String(r.target || '')
  const i = t.indexOf(', 消息:')
  return i > 0 ? t.slice(0, i) : t
}

/**
 * 一条台账记录 → 列表项。
 * 批量 / 单独 的判定口径：**有没有一个具体的目标好友**。
 *   target 是具体好友 → 单独（发给某个人）
 *   target 是 all        → 批量（一次发给全部好友）
 * 仅在 target 缺失时才回落到 task 字段（历史脏数据兜底）。
 * 以前直接用 task 猜，且把 'all' 当好友名渲染，才会出现「单独续 · all」这种鬼话。
 */
function toItem(r) {
  const tgt = cleanTarget(r).trim()
  const hasTarget = !!tgt && tgt !== 'all'
  const isBatch = !hasTarget && r.task !== 'custom'
  const sent = r.sent === null || r.sent === undefined ? null : Number(r.sent)
  const name = String(r.target_name || '').trim()
  let targetName
  if (isBatch) targetName = sent ? '全部好友 · 发出 ' + sent + ' 条' : '全部好友'
  else if (hasTarget) targetName = name || '未知好友'
  else targetName = '未知好友'
  const day = String(r.date || '').trim() || fmt.fmtTime(r.ts).slice(0, 5)
  return {
    ts: r.ts || '',
    day: day,
    time: fmt.fmtFull(r.ts).slice(11, 16),
    /* 详情弹窗里要完整时间（到秒），列表里只显示到分 */
    tsText: fmt.fmtFull(r.ts),
    isBatch: isBatch,
    kind: isBatch ? '批量' : '单独',
    account: String(r.account || '').trim() || '未知账号',
    targetName: targetName,
    ok: r.success !== false,
    /* [20261008] 当时失败、后来同一目标发成功了（面板按「日期+账号+类型+目标」判定），
       界面上标成「♻️ 已重试成功」而不是干巴巴一个「失败」，免得以为没发出去 */
    retried: r.retried_ok ? fmt.fmtFull(r.retried_ok).slice(11, 16) : '',
    /* 日志里的换行是字面量 \n（两个字符），统一压成空格，避免列表被撑开 */
    content: String(r.content || '')
      .replace(/\\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  }
}

Page(
  guard({
    data: {
      loading: true,
      err: '',
      tab: 'records',
      accList: [],
      accCur: null,
      accName: '',
      accInitial: '?',
      accLive: true,
      /** 当前抖音账号的真实头像（dataURL，空 = 首字母占位），由 accbar.refresh 填充 */
      accAvatar: '',

      /** 查看范围：cur=只看当前账号（默认） / all=合并查看名下全部账号 */
      scope: 'cur',
      /** 类型筛选：'' | 'batch' | 'single' */
      typeFilter: '',
      /** 日期筛选：'' = 全部日期；否则 'YYYY-MM-DD'（纯前端，不重新请求） */
      dateFilter: '',
      /** 已取到记录里出现过的日期（去重 + 倒序）：日历用来给「有记录的日期」打橙点 */
      days: [],
      /** 日期选择器（日历弹层）：开合 / 当前翻到的月份 / 当月光格 */
      calOpen: false,
      calYm: '',
      calYmText: '',
      calCells: [],
      /** 触发按钮上的文案：全部日期 / 10-15 周四 · 今天 */
      dateLabel: '全部日期',
      /** 日历表头（周日开头） */
      wk: ['日', '一', '二', '三', '四', '五', '六'],

      groups: [],
      total: 0,
      shown: 0,
      nBatch: 0,
      nSingle: 0,
      logText: '',
      logLines: 0,
      logLoading: false,
      /**
       * 滚动锚点：日志加载完指向末尾那个空节点，scroll-view 就会自动停在最新一行。
       * 每次都要先清空再设回 —— 值没变的话 scroll-into-view 不会重新触发。
       */
      logEnd: '',
      /**
       * 日志框高度（px）。
       * 以前日志是一段 max-height + overflow:hidden 的死文本 —— 超出部分被裁掉，
       * 页面又因为内容已被压扁而滚不动，等于「日志没法滑」。
       * 现在换成 scroll-view，高度按屏幕算，日志自己滚，页面也照常滚。
       */
      logH: 420,

      /** 一次读多少条台账（面板读的是「最后 N 条」，所以调大就等于往前翻） */
      pageLimit: 200,
      /** 上一次返回的条数是否顶到了上限 —— 顶到就说明还可能更早的记录 */
      hasMore: false,
      loadingMore: false,

      /** [20261014] 点一条记录弹出的详情（null = 关着） */
      detail: null,
    },

    onLoad() {
      let h = 0
      try {
        const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
        h = (info && info.windowHeight) || 0
      } catch (e) {
        h = 0
      }
      if (h) this.setData({ logH: Math.max(260, Math.round(h * 0.58)) })
    },

    onShow() {
      accbar.refresh(this)
      if (this.data.tab === 'logs') this.loadLogs()
      else this.load()
    },

    onPullDownRefresh() {
      const p = this.data.tab === 'logs' ? this.loadLogs() : this.load()
      Promise.resolve(p).then(function () {
        wx.stopPullDownRefresh()
      })
    },

    onSwitchAccount() {
      const that = this
      accbar.switchAccount(function () {
        accbar.refresh(that, { scope: 'cur' })
        if (that.data.tab === 'logs') that.loadLogs()
        else that.load()
      })
    },

    /** 切换「只看当前账号 / 全部账号」 */
    onScope(e) {
      const s = e.currentTarget.dataset.s
      if (!s || s === this.data.scope) return
      // 换范围时把翻页深度归零，否则会带着上一个人的 limit 去请求
      this.setData({ scope: s, pageLimit: 200 })
      this.load()
    },

    /** 批量 / 单独 筛选（纯前端，不重新请求） */
    onType(e) {
      const t = e.currentTarget.dataset.t || ''
      if (t === this.data.typeFilter) return
      this.setData({ typeFilter: t })
      this.applyFilter()
    },

    /** 日期筛选（纯前端，和网页端「火花守护」App 完全同一套交互/文案） */
    onDate(e) {
      const d = e.currentTarget.dataset.d || ''
      if (d === this.data.dateFilter) return
      this.setData({ dateFilter: d })
      this.applyFilter()
    },

    /** 日期选择器（日历弹层）：开/合。打开时停在「已选日期所在月」或「最新记录所在月」 */
    onCalToggle() {
      const open = !this.data.calOpen
      let calYm = this.data.calYm
      let calCells = []
      if (open) {
        calYm = this.data.dateFilter ? this.data.dateFilter.slice(0, 7) : this._calDefaultMonth()
        calCells = this._calCells(calYm)
      }
      this.setData({
        calOpen: open,
        calYm: calYm,
        calYmText: this._calYmText(calYm),
        calCells: calCells,
      })
    },

    /** 上/下月翻页 */
    onCalNav(e) {
      const d = Number(e.currentTarget.dataset.m) || 0
      if (!d) return
      const m = /^(\d{4})-(\d{2})$/.exec(this.data.calYm || '')
      let y = m ? Number(m[1]) : new Date().getFullYear()
      let mo = m ? Number(m[2]) - 1 : new Date().getMonth()
      mo += d
      if (mo < 0) { mo = 11; y-- } else if (mo > 11) { mo = 0; y++ }
      const ym = y + '-' + this._p2(mo + 1)
      this.setData({ calYm: ym, calYmText: this._calYmText(ym), calCells: this._calCells(ym) })
    },

    /** 选中某天（底部按钮 v='' 全部日期 / '__today' 今天；光格 data-d=YYYY-MM-DD），选完即收起 */
    onCalPick(e) {
      const ds = e.currentTarget.dataset
      let d
      if (ds.v !== undefined) {
        d = ds.v
      } else {
        d = ds.d || ''
        if (!d) return  // 上月/下月占位格，点了不理
      }
      if (d === '__today') {
        const n = new Date()
        d = n.getFullYear() + '-' + this._p2(n.getMonth() + 1) + '-' + this._p2(n.getDate())
      }
      this.setData({ dateFilter: d, calOpen: false, calCells: [] })
      this.applyFilter()
    },

    /** 补零（不依赖 padStart，老基础库也稳） */
    _p2(n) {
      return n < 10 ? '0' + n : '' + n
    },

    /** 日历默认月份：最新一条记录在哪个月就停哪个月，没有记录停本月 */
    _calDefaultMonth() {
      const items = this._items || []
      if (items.length && items[0].day) return items[0].day.slice(0, 7)
      const n = new Date()
      return n.getFullYear() + '-' + this._p2(n.getMonth() + 1)
    },

    /** YYYY-MM → 「2026 年 10 月」 */
    _calYmText(ym) {
      const m = /^(\d{4})-(\d{2})$/.exec(ym || '')
      return m ? m[1] + ' 年 ' + Number(m[2]) + ' 月' : ''
    },

    /** 生成一个月的光格：前置占位 + 当月天数；has=那天有记录，today=今天 */
    _calCells(ym) {
      const m = /^(\d{4})-(\d{2})$/.exec(ym || '')
      const n = new Date()
      const y = m ? Number(m[1]) : n.getFullYear()
      const mo = m ? Number(m[2]) - 1 : n.getMonth()
      const lead = new Date(y, mo, 1).getDay()
      const days = new Date(y, mo + 1, 0).getDate()
      const tdy = n.getFullYear() + '-' + this._p2(n.getMonth() + 1) + '-' + this._p2(n.getDate())
      const daysSet = this.data.days || []
      const cells = []
      for (let i = 0; i < lead; i++) cells.push({ empty: true, d: '', n: 0, has: false, today: false })
      for (let d = 1; d <= days; d++) {
        const ds = y + '-' + this._p2(mo + 1) + '-' + this._p2(d)
        cells.push({ empty: false, d: ds, n: d, has: daysSet.indexOf(ds) >= 0, today: ds === tdy })
      }
      return cells
    },

    onTab(e) {
      const t = e.currentTarget.dataset.t
      this.setData({ tab: t })
      if (t === 'logs') this.loadLogs()
      else this.load()
    },

    /**
     * 往前翻更早的记录。
     * 面板 /api/records 读的是「最后 N 条」，所以把 N 调大天然等于往前翻页，不需要 offset。
     * 以前写死 200 条，超出的历史记录在手机上完全看不到。
     */
    async loadMore() {
      if (this.data.loadingMore || this.data.loading || !this.data.hasMore) return
      this.setData({ loadingMore: true, pageLimit: this.data.pageLimit + 200 })
      await this.load(true)
      this.setData({ loadingMore: false })
    },

    async load(silent) {
      const app = getApp()
      const uid = app.globalData.currentAccount
      const scope = this.data.scope
      // silent=true 用于「加载更多」：不铺骨架屏，免得整页列表闪一下
      this.setData({ loading: !silent, err: '' })
      if (scope === 'cur' && !uid) {
        this._items = []
        this.setData({ loading: false, err: '当前用户没有绑定抖音账号', groups: [], total: 0, shown: 0, nBatch: 0, nSingle: 0, hasMore: false })
        return
      }
      try {
        // 不带 account → 面板返回「名下全部账号」的台账（非管理员依旧只回自己的）
        const params = scope === 'cur' ? { account: uid } : {}
        params.limit = this.data.pageLimit
        const d = await api.get('/api/records', params)
        const raw = d.records || []
        const recs = raw.slice().reverse() // 接口是旧→新，界面要新→旧
        this._items = recs.map(toItem)
        // 条数顶到 limit 说明面板那边还可能截掉了更早的记录
        this.setData({ loading: false, err: '', hasMore: raw.length >= this.data.pageLimit })
        this.applyFilter()
      } catch (e) {
        this.setData({ loading: false, err: e.message || '加载失败' })
      }
    },

    /** 在已取到的记录上做筛选 + 按天分组（切换筛选不发请求） */
    applyFilter() {
      const items = this._items || []
      const f = this.data.typeFilter
      const df = this.data.dateFilter
      // 日期芯片：由已取到的记录里出现过的 day 去重倒序生成（不走后端 date 参数）
      const days = []
      items.forEach(function (x) {
        if (x.day && days.indexOf(x.day) < 0) days.push(x.day)
      })
      days.sort().reverse()
      // ⚠️ 以前这里有句「选了已取到记录里不存在的 day 就回落成全部日期」。
      // 日期条时代看不出问题（芯片本来就只有有记录的日期），换成日历弹层后
      // 就成了「选哪个日期都被弹回全部」——用户反馈「不能筛选日期」的根因。
      // 现在不回落：选到没记录的日期就明确显示「这一天没有记录」。
      const dateFilter = df || ''
      let list = items
      if (f) {
        list = list.filter(function (x) {
          return f === 'batch' ? x.isBatch : !x.isBatch
        })
      }
      if (dateFilter) {
        list = list.filter(function (x) {
          return x.day === dateFilter
        })
      }
      const groups = []
      let cur = null
      list.forEach(function (x) {
        if (!cur || cur.date !== x.day) {
          cur = { date: x.day, key: x.day, items: [], batch: 0, single: 0 }
          groups.push(cur)
        }
        cur.items.push(x)
        if (x.isBatch) cur.batch++
        else cur.single++
      })
      let nb = 0
      items.forEach(function (x) {
        if (x.isBatch) nb++
      })
      this.setData({
        groups: groups,
        total: items.length,
        shown: list.length,
        nBatch: nb,
        nSingle: items.length - nb,
        days: days,
        dateFilter: dateFilter,
        // 触发按钮文案 + 日历弹层的当月光格（只有开着才算，省得每次筛选都白算）
        dateLabel: dateFilter ? fmt.dayLabel(dateFilter) : '全部日期',
        calYm: this.data.calYm || this._calDefaultMonth(),
        calYmText: this._calYmText(this.data.calYm || this._calDefaultMonth()),
        calCells: this.data.calOpen ? this._calCells(this.data.calYm || this._calDefaultMonth()) : [],
      })
    },

    async loadLogs() {
      const app = getApp()
      const uid = app.globalData.currentAccount
      if (!uid) {
        this.setData({ logText: '', err: '当前用户没有绑定抖音账号' })
        return
      }
      this.setData({ logLoading: true })
      try {
        const d = await api.get('/api/logs', { account: uid })
        const txt = d.log || ''
        this.setData({
          logText: txt,
          logLines: txt ? txt.split('\n').length : 0,
          logLoading: false,
          err: '',
          logEnd: '',
        })
        // 日志要「打开就在最新一行」。等这一帧渲染完再设锚点，
        // 早设的话内容还没撑开，会停在中间。
        const that = this
        const jump = function () {
          that.setData({ logEnd: 'logend' })
        }
        if (wx.nextTick) wx.nextTick(jump)
        else setTimeout(jump, 50)
      } catch (e) {
        this.setData({ logLoading: false, err: e.message || '日志加载失败' })
      }
    },

    copyLog() {
      if (!this.data.logText) return
      wx.setClipboardData({
        data: this.data.logText,
        success: function () {
          wx.showToast({ title: '日志已复制', icon: 'none' })
        },
      })
    },

    /**
     * [20261014] 点一条发送记录 → 弹详情。
     * 列表是「按天分组」的两层 wx:for，所以用 (gi, ri) 两个下标回查原始 item，
     * 不依赖 data-* 传整条记录（记录里带换行/引号，塞 dataset 容易被截断）。
     */
    onRec(e) {
      const ds = e.currentTarget.dataset || {}
      const g = (this.data.groups || [])[Number(ds.gi)]
      const it = g && (g.items || [])[Number(ds.ri)]
      if (!it) return
      this.setData({ detail: it })
    },

    closeDetail() {
      this.setData({ detail: null })
    },

    /** 弹窗内容区 catchtap 占位：点内容不关弹窗，点蒙层才关 */
    noop() {},
  })
)
