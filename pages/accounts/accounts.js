const { guard } = require('../../utils/page.js')
const api = require('../../utils/api.js')
const ui = require('../../utils/ui.js')

Page(
  guard({
    data: {
      loading: true,
      err: '',
      live: false,
      isAdmin: false,
      accounts: [],
      busy: '',

      showForm: false,
      formMode: 'add',
      formUid: '',
      formName: '',
      formId: '',

      /* [20261013] 导入 cookie 弹层（对齐网页面板 Actions.importCookies） */
      showImport: false,
      impUid: '',
      impText: '',
    },

    onShow() {
      const app = getApp()
      this.setData({
        isAdmin: !!(app && app.globalData.session && app.globalData.session.isAdmin),
      })
      this.load()
    },

    onPullDownRefresh() {
      const that = this
      Promise.resolve(this.load(true)).then(function () {
        wx.stopPullDownRefresh()
      })
    },

    async load(live) {
      const useLive = live === true
      this.setData({ loading: true, err: '' })
      try {
        const d = await api.get('/api/accounts', useLive ? { live: 1 } : {})
        const accounts = (d.accounts || []).map(function (a) {
          const c = a.cookie || {}
          let statusText = '无会话'
          let statusCls = ''
          if (c.live === false) {
            statusText = '校验中…'
            statusCls = ''
          } else if (c.has && c.parse_err) {
            statusText = '格式异常'
            statusCls = 'badge--danger'
          } else if (c.has && c.session_valid !== false && !c.expired) {
            statusText = '已登录'
            statusCls = 'badge--ok'
          } else if (c.has) {
            statusText = '会话已过期'
            statusCls = 'badge--danger'
          }
          /* [20261013] 归属面板用户：面板 /api/accounts 补了 owners/owner（聚合
             panel_users.json 的 account_uids，管理员绑的号也算）。管理员在面板上
             看得到全部账号，以前分不清哪个号是谁的 —— 这里给一行「归属 xxx」。 */
          const ow = (a.owners || []).filter(function (x) {
            return !!x
          })
          const owner = ow.length ? ow.join('、') : a.owner || ''
          return {
            unique_id: String(a.unique_id || ''),
            username: a.username || '',
            has: !!c.has,
            count: c.count || 0,
            targets: (a.targets || []).length,
            live: c.live !== false,
            statusText: statusText,
            statusCls: statusCls,
            desc: c.session_desc || c.desc || '',
            expired: !!c.expired,
            owner: owner,
            ownerText: owner ? '归属 ' + owner : '归属 未分配',
            ownerUnset: !owner,
          }
        })
        this.setData({ loading: false, accounts: accounts, live: useLive })
        // 首次进来后台补一次真校验
        if (!useLive && !this.__liveDone) {
          this.__liveDone = true
          const that = this
          setTimeout(function () {
            that.load(true)
          }, 300)
        }
      } catch (e) {
        this.setData({ loading: false, err: e.message || '加载失败' })
      }
    },

    // ── 添加 / 编辑 ─────────────────────────────────────
    openAdd() {
      this.setData({ showForm: true, formMode: 'add', formUid: '', formName: '', formId: '' })
    },

    openEdit(e) {
      const uid = e.currentTarget.dataset.uid
      const a = this.data.accounts.find(function (x) {
        return x.unique_id === String(uid)
      })
      if (!a) return
      this.setData({
        showForm: true,
        formMode: 'edit',
        formUid: a.unique_id,
        formName: a.username || '',
        formId: a.unique_id,
      })
    },

    closeForm() {
      this.setData({ showForm: false })
    },

    noop() {},

    onFormName(ev) {
      this.setData({ formName: ev.detail.value })
    },
    onFormId(ev) {
      this.setData({ formId: ev.detail.value })
    },

    async submitForm() {
      const name = String(this.data.formName || '').trim()
      const uid = String(this.data.formId || '').trim()
      if (!uid) return ui.toast('抖音号必填')
      this.setData({ busy: 'form' })
      try {
        if (this.data.formMode === 'add') {
          await api.post('/api/accounts', { username: name, unique_id: uid })
          ui.ok('账号已添加')
        } else {
          await api.panel('/api/accounts/' + this.data.formUid, 'PUT', {
            username: name,
            unique_id: uid,
          })
          ui.ok('已保存')
        }
        this.setData({ showForm: false })
        const app = getApp()
        await app.loadAccounts({ live: false })
        this.load(true)
      } catch (e) {
        ui.toast(e.message || '保存失败')
      } finally {
        this.setData({ busy: '' })
      }
    },

    // ── 操作 ────────────────────────────────────────────
    async del(e) {
      const uid = e.currentTarget.dataset.uid
      const ok = await ui.confirm(
        '删除账号 ' + uid + ' 会同时清除它的登录态、好友数据与发送名单，不可恢复。',
        '删除账号'
      )
      if (!ok) return
      this.setData({ busy: uid })
      try {
        await api.panel('/api/accounts/' + uid, 'DELETE')
        ui.ok('已删除')
        const app = getApp()
        await app.loadAccounts({ live: false })
        this.load(true)
      } catch (err) {
        ui.toast(err.message || '删除失败')
      } finally {
        this.setData({ busy: '' })
      }
    },

    async checkSession(e) {
      const uid = e.currentTarget.dataset.uid
      this.setData({ busy: uid })
      try {
        const d = await api.get('/api/accounts/' + uid + '/session-status')
        const s = d.session || d
        const okFlag = s && (s.ok === true || s.session_valid === true)
        await ui.alert(
          (okFlag ? '✅ 会话有效\n' : '❌ 会话无效\n') + (s.desc || s.session_desc || '无描述'),
          '会话检测'
        )
        this.load(true)
      } catch (err) {
        ui.toast(err.message || '检测失败')
      } finally {
        this.setData({ busy: '' })
      }
    },

    async clearSession(e) {
      const uid = e.currentTarget.dataset.uid
      const ok = await ui.confirm('清除后该账号需要重新登录抖音。', '清除登录态')
      if (!ok) return
      this.setData({ busy: uid })
      try {
        await api.panel('/api/accounts/' + uid + '/session', 'DELETE')
        ui.ok('已清除')
        this.load(true)
      } catch (err) {
        ui.toast(err.message || '清除失败')
      } finally {
        this.setData({ busy: '' })
      }
    },

    goQr(e) {
      const uid = e.currentTarget.dataset.uid
      wx.navigateTo({ url: '/pages/qr-login/qr-login?uid=' + uid })
    },

    goHead(e) {
      const uid = e.currentTarget.dataset.uid
      wx.navigateTo({ url: '/pages/head-login/head-login?uid=' + uid })
    },

    addAccount() {
      this.openAdd()
    },

    /**
     * [20261013] 导入 cookie —— 对齐网页面板账号页的「导入 cookie」。
     *
     * 实用场景：账号 cookie 过期时**不用重新扫码**，把新导出的 cookie 粘回来就行
     * （面板侧 POST /api/accounts/<uid>/cookies 直接覆盖写入）。手机上粘贴虽然麻烦，
     * 但比举着另一台设备扫码登录省事。
     */
    openImport(e) {
      const uid = String(e.currentTarget.dataset.uid || '')
      if (!uid) return
      this.setData({ showImport: true, impUid: uid, impText: '' })
    },

    closeImport() {
      this.setData({ showImport: false })
    },

    onImpText(ev) {
      this.setData({ impText: ev.detail.value })
    },

    async submitImport() {
      const uid = this.data.impUid
      const raw = String(this.data.impText || '').trim()
      if (!uid) return
      if (!raw) return ui.toast('请先粘贴 cookie JSON')
      let arr
      try {
        arr = JSON.parse(raw)
      } catch (e) {
        return ui.alert('JSON 解析失败：' + (e.message || '格式不对'), '格式不对')
      }
      if (!Array.isArray(arr)) {
        return ui.alert('应为 JSON 数组（抖音导出的 cookie 列表）', '格式不对')
      }
      this.setData({ busy: 'import' })
      try {
        const r = await api.post('/api/accounts/' + uid + '/cookies', { cookies: arr })
        ui.ok('已导入 ' + ((r && r.cookie_count) || arr.length) + ' 条 cookie')
        this.setData({ showImport: false })
        this.load(true)
      } catch (err) {
        ui.toast(err.message || '导入失败')
      } finally {
        this.setData({ busy: '' })
      }
    },
  })
)
