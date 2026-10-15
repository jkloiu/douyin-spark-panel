const { guard } = require('../../utils/page.js')
const api = require('../../utils/api.js')
const fmt = require('../../utils/format.js')

const BADGE_MAP = {
  ok: { text: '正常', cls: 'badge--ok' },
  warn: { text: '注意', cls: 'badge--warn' },
  err: { text: '异常', cls: 'badge--danger' },
  danger: { text: '异常', cls: 'badge--danger' },
  bad: { text: '异常', cls: 'badge--danger' },
}

/* [20261013] 面板存档只留「早 09:00 / 晚 18:00」两份，快照的 trigger 字段长这样。
   直接显示 `cron 18:00` 太机器化，这里给个中文短标签。 */
const TRIG_LABEL = {
  'cron 09:00': '早 09:00',
  'cron 18:00': '晚 18:00',
}

function trigLabel(t) {
  const s = String(t || '')
  return TRIG_LABEL[s] || s || '快照'
}

/** 今天 YYYY-MM-DD */
function todayStr() {
  const d = new Date()
  return d.getFullYear() + '-' + fmt.pad(d.getMonth() + 1) + '-' + fmt.pad(d.getDate())
}

/** unique_id 去尾点（面板里带点/不带点两种形态混用，比对前先归一） */
function normUid(x) {
  return String(x || '').replace(/\.+$/, '')
}

/**
 * 日期清单 = 「今天（实时）」+ 近 7 天存档 + 更早的归档包。
 *
 * 为什么必须带上归档：面板的 daily_store.rotate() 会把超过 7 天的日报打包成
 * daily_YYYY-MM-DD.tar.gz 并从 daily_reports/ 删掉原文件，所以只看 dates
 * 就永远选不到 7 天前的日期（老版本就是这样，用户会觉得「日期切不动」）。
 * /api/daily-report/dates 已经把 archived 一起返回了，这里合并成一份列表。
 */
function buildDateList(r) {
  const today = todayStr()
  const out = [{ date: today, live: true, archived: false, count: 0, label: '今天（实时）' }]
  const seen = {}
  ;(r && r.dates ? r.dates : []).forEach(function (x) {
    if (!x || !x.date || seen[x.date]) return
    seen[x.date] = 1
    const n = Number(x.count || 0)
    out.push({
      date: x.date,
      live: false,
      archived: false,
      count: n,
      label: x.date + '（' + (x.date === today ? '今日存档 ' : '存档 ') + n + ' 份）',
    })
  })
  ;(r && r.archived ? r.archived : []).forEach(function (x) {
    if (!x || !x.date || seen[x.date]) return
    seen[x.date] = 1
    out.push({ date: x.date, live: false, archived: true, count: 0, label: x.date + '（归档）' })
  })
  // 今天的实时排在第一位，其余按日期倒序（新 → 旧）
  const head = out[0]
  const rest = out.slice(1).sort(function (a, b) {
    return a.date < b.date ? 1 : a.date > b.date ? -1 : 0
  })
  return [head].concat(rest)
}

Page(
  guard({
    data: {
      loading: true,
      err: '',
      dates: [],
      dateLabels: [],
      dateIdx: 0,
      date: '',
      live: true,
      curLabel: '今天（实时）',
      meta: '',
      snaps: [],
      snapIdx: -1,
      empty: false,
      emptyTitle: '',
      note: '',
      pickDates: [],
      accounts: [],
      pushing: false,
      /* [20261013] 「范围」= 只看当前抖音号 / 名下全部账号，对齐网页面板日报页的 drScope。
         名义上只有 1 个抖音号时 accCount 保持 0，前端不渲染这个切换器（否则是噪音）。 */
      scope: 'all',
      accCount: 0,
    },

    onLoad(q) {
      this.__wantDate = (q && q.date) || ''
    },

    onShow() {
      if (!this.data.dates.length) this.init()
      else this.loadReport()
    },

    onPullDownRefresh() {
      Promise.resolve(this.loadReport()).then(function () {
        wx.stopPullDownRefresh()
      })
    },

    async init() {
      this.setData({ loading: true, err: '' })
      /* 顺便问一下名下有几个抖音号：>1 才需要「范围」切换。
         失败不影响主流程（当作只有一个号，不显示切换器）。 */
      api
        .get('/api/accounts')
        .then((r) => {
          const n = ((r && r.accounts) || []).length
          if (n > 1) this.setData({ accCount: n })
        })
        .catch(() => {})
      try {
        const r = await api.get('/api/daily-report/dates')
        const list = buildDateList(r)
        let idx = 0
        const want = this.__wantDate
        if (want) {
          for (let i = 0; i < list.length; i++) {
            if (!list[i].live && list[i].date === want) {
              idx = i
              break
            }
          }
        }
        this.setData({
          dates: list,
          dateLabels: list.map(function (x) {
            return x.label
          }),
        })
        await this.pick(idx)
      } catch (e) {
        this.setData({ loading: false, err: e.message || '加载失败' })
      }
    },

    /** 切到「dates 里的第 idx 项」（0 = 今天实时） */
    async pick(idx) {
      const list = this.data.dates
      if (idx < 0) idx = 0
      if (idx >= list.length) idx = list.length - 1
      const item = list[idx]
      if (!item) return
      this.setData({
        dateIdx: idx,
        date: item.date,
        live: !!item.live,
        curLabel: item.label,
        snaps: [],
        snapIdx: -1,
      })
      return this.loadReport()
    },

    /** picker 选日期 */
    onDate(e) {
      this.pick(Number(e.detail.value))
    },

    /** ‹ 更早 / 更新 › —— 在「有数据的日期」之间跳，不是自然日加减 */
    stepDay(e) {
      const dir = String(e.currentTarget.dataset.dir) === '-1' ? -1 : 1
      const list = this.data.dates
      let idx = this.data.dateIdx + (dir < 0 ? 1 : -1)
      if (idx < 0) idx = 0
      if (idx > list.length - 1) {
        if (dir > 0) idx = 0 /* 已是最新 → 回到今天实时 */
        else return wx.showToast({ title: '没有更早的存档了', icon: 'none' })
      }
      this.pick(idx)
    },

    /** 回到今天实时 */
    onToday() {
      this.pick(0)
    },

    /** 空状态里点某个「有数据的日期」 */
    onPickDate(e) {
      this.pick(Number(e.currentTarget.dataset.i))
    },

    /** 切当天的某一份快照（早 09:00 / 晚 18:00） */
    onSnap(e) {
      this.setData({ snapIdx: Number(e.currentTarget.dataset.i) })
      this.loadReport()
    },

    /** [20261013] 范围切换：全部账号 / 只看当前抖音号（对齐面板日报页的「范围」） */
    onScope(e) {
      const s = String(e.currentTarget.dataset.s || 'all') === 'cur' ? 'cur' : 'all'
      if (s === this.data.scope) return
      this.setData({ scope: s })
      this.loadReport()
    },

    /**
     * [20261013] 把当前范围的日报立即推给自己（对齐面板 Actions.pushDailyReport）。
     *
     * 面板侧会**按当前登录用户**重新生成一份（days=2、带登录态）走他自己的推送通道，
     * 推的不是页面当前选中的那份历史存档 —— 文案要写清楚「当前范围的最新日报」。
     */
    pushDaily() {
      if (this.data.pushing) return
      const self = this
      wx.showModal({
        title: '立即推送日报',
        content: '把当前范围的最新日报推送到你在「推送设置」里配置的通道？',
        confirmText: '推送',
        success(res) {
          if (res.confirm) self.__doPush()
        },
      })
    },

    async __doPush() {
      this.setData({ pushing: true })
      try {
        const r = await api.post('/api/daily-report/push', {})
        if (r && r.ok) {
          wx.showToast({ title: '已推送', icon: 'success' })
        } else {
          wx.showModal({
            title: '推送失败',
            content: (r && (r.error || r.info)) || '未知原因',
            showCancel: false,
          })
        }
      } catch (e) {
        /* 面板没配通道时返回 400 {ok:false,error:"还没有配置推送通道…"}，
           api.panel 会把它抛成 PANEL_ERR —— 直接把原话展示给用户，别吞掉。 */
        wx.showModal({
          title: '推送失败',
          content: e.message || '网络异常',
          showCancel: false,
        })
      } finally {
        this.setData({ pushing: false })
      }
    },

    /**
     * [20261013] 点「登录态」强制重新校验该账号（对齐面板 Actions.drForceSession）。
     *
     * 日报页首屏不等登录态（面板侧 10 分钟缓存，避免每 5 秒轮询都去拉抖音），
     * 所以看到的状态可能是缓存的；这个入口就是「我现在就要最新的」。
     */
    async forceSession(e) {
      const i = Number(e.currentTarget.dataset.i)
      const acc = this.data.accounts[i]
      if (!acc || this.__sessBusy) return
      this.__sessBusy = true
      this.setData({ ['accounts[' + i + '].sessBusy']: true })
      try {
        const r = await api.get('/api/session-status', { force: 1 })
        const sess = (r && r.sessions) || {}
        /* 面板 /api/session-status 的 key 取的是 unique_id，日报里给的 uid 可能带尾点，
           两种形态都试一次（面板自己也是这么兜的）。 */
        let s = sess[acc.uid] || null
        if (!s) {
          const want = normUid(acc.uid)
          Object.keys(sess).forEach(function (k) {
            if (!s && normUid(k) === want) s = sess[k]
          })
        }
        if (!s) {
          wx.showToast({ title: '没取到该账号的登录态', icon: 'none' })
        } else {
          this.setData({
            ['accounts[' + i + '].sessionOk']: !!s.ok,
            ['accounts[' + i + '].sessionDesc']: s.desc || '未知',
          })
          wx.showToast({
            title: s.ok ? '登录态正常' : s.desc || '登录态异常',
            icon: s.ok ? 'success' : 'none',
          })
        }
      } catch (err) {
        wx.showToast({ title: err.message || '校验失败', icon: 'none' })
      } finally {
        this.setData({ ['accounts[' + i + '].sessBusy']: false })
        this.__sessBusy = false
      }
    },

    async loadReport() {
      const st = this.data
      if (!st.date) return
      this.setData({ loading: true, err: '', empty: false })
      try {
        const params = {}
        if (!st.live) {
          params.date = st.date
          /* ⚠️ 面板的 snap 参数是**快照下标**（int(request.args.get("snap", "-1"))）。
             老版本这里传的是 trigger 字符串（'cron 18:00'），int() 直接抛异常 →
             永远回落到最后一份，表现就是「早/晚快照切了没反应」。 */
          if (st.snapIdx >= 0) params.snap = st.snapIdx
        }
        /* [20261013] 范围=「当前账号」时带 account；面板 _report_uids() 按它收敛可见账号。
           没有当前账号就传 __none__ —— 面板侧会退化成「看不到任何数据」，与网页面板一致。 */
        if (st.scope === 'cur') {
          const app = getApp()
          params.account = (app && app.globalData.currentAccount) || '__none__'
        }
        const d = await api.get('/api/daily-report', params)

        if (d && d.empty) {
          const list = st.dates
          const pick = []
          for (let i = 0; i < list.length && pick.length < 12; i++) {
            if (list[i].live || list[i].date === st.date) continue
            pick.push({ i: i, text: list[i].date.slice(5) + (list[i].archived ? ' 归档' : '') })
          }
          const title = d.date ? d.date + ' 没有日报存档' : d.scope || '没有可展示的日报'
          const note =
            d.note ||
            (d.date
              ? '面板保留最近 7 天的日报，更早的已打包归档（保留 180 天）。请从下面选一个有数据的日期，或回到今天看实时日报。'
              : '当前账号没有可展示的日报数据：可能还没绑定抖音号，或名下账号还没有产生记录。')
          this.setData({
            loading: false,
            empty: true,
            emptyTitle: title,
            note: note,
            pickDates: pick,
            accounts: [],
            snaps: [],
            snapIdx: -1,
            meta: d.date ? d.date + ' · 没有存档' : '无数据',
          })
          return
        }

        const snaps = ((d && d.snapshots) || []).map(function (s) {
          return { i: s.i, label: trigLabel(s.trigger), at: s.at || '' }
        })
        let snapIdx = -1
        snaps.forEach(function (s) {
          if (s.i === d.snapshot_index) snapIdx = s.i
        })

        const scope = d.is_all ? '全部账号' : d.scope || ''
        let meta
        if (d.archived) {
          meta =
            (d.from_archive ? '归档包 ' : '存档 ') +
            (d.snapshot_at || d.date || '') +
            (d.snapshot_trigger ? ' · ' + trigLabel(d.snapshot_trigger) : '') +
            (scope ? ' · ' + scope : '')
        } else {
          meta = '生成 ' + (d.generated || '') + (scope ? ' · ' + scope : '')
        }

        this.setData({
          loading: false,
          accounts: this.mapAccounts(d.accounts || []),
          snaps: snaps,
          snapIdx: snapIdx,
          empty: false,
          meta: meta,
        })
      } catch (e) {
        this.setData({ loading: false, err: e.message || '加载失败' })
      }
    },

    mapAccounts(raw) {
      return (raw || []).map(function (a) {
        const bg = BADGE_MAP[a.badge] || { text: a.badge || '未知', cls: '' }
        const spark = a.spark || {}
        const send = a.send || []
        const totalOk = send.reduce(function (s, x) {
          return s + (x.ok || 0)
        }, 0)
        const totalAll = send.reduce(function (s, x) {
          return s + (x.total || 0)
        }, 0)
        return {
          uid: a.uid,
          uname: a.uname,
          badgeText: bg.text,
          badgeCls: bg.cls,
          sessionOk: !!(a.session && a.session.ok),
          sessionDesc: (a.session && a.session.desc) || '未知',
          /* 点「登录态」强制重校验时的行内忙态（面板是直接把单元格改成「校验中…」） */
          sessBusy: false,
          sendText: totalAll ? totalOk + '/' + totalAll : '无发送',
          sendKinds: send.map(function (x) {
            return x.kind + ' ' + x.ok + '/' + x.total
          }),
          spark: spark,
          sparkText: spark.total
            ? '共 ' + spark.total + ' 人 · 最高 ' + (spark.max_days || 0) + ' 天'
            : '没有好友数据',
          sparkWhen: spark.when || '',
          friends: (a.friends || []).map(function (f) {
            const lv = fmt.sparkLevel(f.days)
            return { name: f.name, hours: '', levelText: lv.text, levelCls: lv.cls }
          }),
          /* [20261008] 面板给的是对象数组，直接渲染会变成 [object Object]，这里先拍平 */
          fails: (a.fails || []).map(function (x) {
            return x.ts + ' ' + x.kind + ' → ' + x.target
          }),
          /* [20261008] 当时失败、随后重试成功 —— 提醒一下，但不算「待处理」 */
          retries: (a.retries || []).map(function (x) {
            return x.ts + ' ' + x.kind + ' → ' + x.target
          }),
        }
      })
    },
  })
)
