const { guard } = require('../../utils/page.js')
const api = require('../../utils/api.js')
const fmt = require('../../utils/format.js')
const ui = require('../../utils/ui.js')
const av = require('../../utils/avatar.js')
const accbar = require('../../utils/accbar.js')

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

      contacts: [],
      visible: [],
      nonMutual: 0,
      showNonMutual: false,
      savedAt: '',

      scraping: false,
      scrapeMsg: '',

      detail: null,
      friends: [],
      adding: '',
    },

    onShow() {
      accbar.refresh(this)
      this.load()
      // [修复20261005] 服务器上的抓取不会因为切页面而停，这里把「抓取中」状态接回来 ——
      // 否则用户切出去再回来会以为没在抓，又点一次，白等一轮。
      if (this._jobId && !this.data.scraping) {
        this.setData({ scraping: true, scrapeMsg: '抓取中…' })
        this.pollJob(this._jobId, 0)
      }
    },

    onHide() {
      // 故意不做任何事：隐藏时若停掉轮询，进度就丢了（原先就是这里掐断的）。
      // 真正的清理放在 onUnload。
    },

    onUnload() {
      this._alive = false
    },

    onPullDownRefresh() {
      const that = this
      Promise.resolve(this.load()).then(function () {
        wx.stopPullDownRefresh()
      })
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
      this._alive = true
      this.setData({ loading: true, err: '' })
      if (!uid) {
        this.setData({ loading: false, err: '当前用户没有绑定抖音账号' })
        return
      }
      try {
        const [d, fr] = await Promise.all([
          api.get('/api/scraped-contacts', { account: uid }),
          api.get('/api/friends', { account: uid }).catch(function () {
            return { friends: [] }
          }),
        ])
        const friends = fr.friends || []
        const sids = friends.map(function (f) {
          return String(f.short_id)
        })
        const contacts = (d.contacts || []).map(function (c) {
          const nm = c.title || c.nickname || '未知'
          const nonM = c.chat_state === 'non_mutual'
          return {
            short_id: c.short_id,
            unique_id: c.unique_id || '',
            douyin_id: c.douyin_id || c.unique_id || c.short_id || '',
            name: nm,
            avatar: c.avatar || '',
            __avatar: '',
            initial: fmt.initial(nm),
            preview: c.preview || '',
            lastTime: c.last_time || '',
            nonMutual: nonM,
            added: sids.indexOf(String(c.short_id)) >= 0,
          }
        })
        this.setData({
          loading: false,
          contacts: contacts,
          nonMutual: d.non_mutual || 0,
          savedAt: d.saved_at ? fmt.relTime(d.saved_at) : '',
          friends: friends,
        })
        this.applyFilter()
        const that = this
        av.resolveList(contacts, 'avatar', function () {
          that.setData({ contacts: contacts })
          that.applyFilter()
        })
      } catch (e) {
        this.setData({ loading: false, err: e.message || '加载失败' })
      }
    },

    applyFilter() {
      const all = this.data.contacts
      const show = this.data.showNonMutual
      this.setData({
        visible: show
          ? all
          : all.filter(function (c) {
              return !c.nonMutual
            }),
      })
    },

    toggleNonMutual(e) {
      this.setData({ showNonMutual: e.detail.value })
      this.applyFilter()
    },

    /** 触发一次抓取并轮询进度 */
    async scrape() {
      const app = getApp()
      const uid = app.globalData.currentAccount
      if (!uid) return ui.toast('没有可用账号')
      const ok = await ui.confirm(
        '将打开服务器上的抖音聊天页抓取会话列表，约 1~3 分钟，期间不要执行其他自动化任务。',
        '开始抓取'
      )
      if (!ok) return
      this.setData({ scraping: true, scrapeMsg: '正在启动…' })
      try {
        const r = await api.post('/api/scrape-contacts', { account: uid })
        const jid = r.job_id
        if (!jid) throw new Error(r.error || '启动失败')
        this._jobId = jid
        this.pollJob(jid, 0)
      } catch (e) {
        this.setData({ scraping: false, scrapeMsg: '' })
        ui.toast(e.message || '抓取失败')
      }
    },

    pollJob(jid, n) {
      const that = this
      this._jobId = jid
      if (!this._alive) {
        this._jobId = null
        this.setData({ scraping: false })
        return
      }
      if (n > 120) {
        this._jobId = null
        this.setData({ scraping: false, scrapeMsg: '' })
        ui.toast('抓取超时，请稍后重试')
        return
      }
      this.setData({ scrapeMsg: '抓取中… 已等待 ' + n * 2 + ' 秒' })
      setTimeout(function () {
        api
          .get('/api/scrape-contacts/' + jid)
          .then(function (d) {
            if (d.status === 'done') {
              that._jobId = null
              that.setData({ scraping: false, scrapeMsg: '' })
              ui.ok('抓取完成')
              that.load()
            } else if (d.status === 'error' || d.status === 'not_found') {
              that._jobId = null
              that.setData({ scraping: false, scrapeMsg: '' })
              ui.toast(d.error || '抓取失败')
            } else {
              that.pollJob(jid, n + 1)
            }
          })
          .catch(function (e) {
            // 单次查询失败（网络抖动 / 云函数超时）不该直接放弃：
            // 以前这里直接弹错并停掉，用户就再也看不到后面的进度了。
            if (e && e.code === 'NEED_LOGIN') {
              that._jobId = null
              that.setData({ scraping: false, scrapeMsg: '' })
              return
            }
            that.setData({ scrapeMsg: '状态查询失败，重试中…' })
            that.pollJob(jid, n + 1)
          })
      }, 2000)
    },

    openDetail(e) {
      const sid = e.currentTarget.dataset.sid
      const c = this.data.contacts.find(function (x) {
        return String(x.short_id) === String(sid)
      })
      if (c) this.setData({ detail: c })
    },

    closeDetail() {
      this.setData({ detail: null })
    },

    noop() {},

    copyId() {
      const c = this.data.detail
      if (c) ui.copy(c.douyin_id, '抖音号已复制')
    },

    async addContact(e) {
      const sid = e.currentTarget.dataset.sid
      const c = this.data.contacts.find(function (x) {
        return String(x.short_id) === String(sid)
      })
      if (!c) return
      if (c.added) {
        ui.toast('已经在续火花名单里了')
        return
      }
      const tip = c.nonMutual
        ? '这个会话没有聊天记录（非互关，只能发一条文字消息），加进去也续不了火花。仍然要添加吗？'
        : '把「' + c.name + '」加入当前账号的续火花名单？'
      const ok = await ui.confirm(tip, '加入名单')
      if (!ok) return

      const app = getApp()
      const uid = app.globalData.currentAccount
      this.setData({ adding: sid })
      try {
        await api.post('/api/friends', {
          unique_id: c.unique_id || c.short_id,
          account: uid,
          name: c.name,
          // 面板已把头像本地化成 data/avatars/xxx.jpg（小程序加载不了 douyinpic.com 外链），
          // 原样回传，后端存进好友库后下次直接复用，不必再下一次
          avatar: c.avatar || '',
          mode: 'uid',
          skip_resolve: true,
        })
        ui.ok('已加入名单')
        this.setData({ detail: null })
        this.load()
      } catch (err) {
        ui.toast(err.message || '添加失败')
      } finally {
        this.setData({ adding: '' })
      }
    },
  })
)
