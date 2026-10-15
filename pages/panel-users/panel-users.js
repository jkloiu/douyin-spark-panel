const { guard } = require('../../utils/page.js')
const api = require('../../utils/api.js')
const ui = require('../../utils/ui.js')

Page(
  guard({
    data: {
      loading: true,
      err: '',
      users: [],
      accounts: [],

      showForm: false,
      formMode: 'add',
      formUser: '',
      formPwd: '',
      formAccounts: [],
      /** 提交中（'' | 'form'）—— 以前直接 setData 了一个 data 里没声明的字段，
       *  按钮的 loading 态其实从来没接上过 */
      busy: '',
    },

    onShow() {
      this.load()
    },

    onPullDownRefresh() {
      const that = this
      Promise.resolve(this.load()).then(function () {
        wx.stopPullDownRefresh()
      })
    },

    async load() {
      const app = getApp()
      this.setData({ loading: true, err: '' })
      try {
        const d = await api.get('/api/panel-users')
        /* 账号列表要提前拉：面板用户没上传自有头像时，用其绑定账号的抖音头像兜底
           （否则只给 polarstar 一个人传过头像，其他用户永远只有首字母） */
        let accounts = app.globalData.accounts || []
        if (!accounts.length) {
          try {
            accounts = await app.loadAccounts({ live: false })
          } catch (e) {
            accounts = []
          }
        }
        const accAvatar = {}
        ;(accounts || []).forEach(function (a) {
          if (a && a.avatar) accAvatar[String(a.unique_id)] = '/' + a.avatar
        })
        const users = (d.users || []).map(function (u) {
          const nt = u.notify || {}
          const uids = (u.account_uids || []).map(String)
          /* [20261014] 头像两级口径：优先面板落库的自有头像
             （data/avatars/panel/xxx.jpg）；没有则回落到该用户绑定账号的
             抖音头像（data/avatars/<sid>.jpg，抓好友时本地化好的）。
             两条路径都要补 "/" 前缀，且必须走 api.assets 换成 base64
             （/data/avatars/ 要带 X-Panel-Token，<image> 加不了请求头） */
          let path = u.avatar ? '/' + u.avatar : ''
          if (!path) {
            for (let i = 0; i < uids.length; i++) {
              if (accAvatar[uids[i]]) {
                path = accAvatar[uids[i]]
                break
              }
            }
          }
          return {
            username: u.username,
            isAdmin: !!u.is_admin,
            avatarPath: path,
            avatar: '',
            initial: (u.username || '?').slice(0, 1).toUpperCase(),
            accountUids: uids,
            accountText: uids.join(' / ') || '未分配账号',
            notifyText: nt.configured
              ? nt.channel_label + (nt.enabled ? ' · 已启用' : ' · 已停用')
              : '未配置推送',
          }
        })
        const paths = users
          .map(function (u) {
            return u.avatarPath
          })
          .filter(Boolean)
        if (paths.length) {
          let avMap = {}
          try {
            avMap = await api.assets(paths)
          } catch (e) {
            avMap = {}
          }
          users.forEach(function (u) {
            u.avatar = (u.avatarPath && avMap[u.avatarPath]) || ''
          })
        }
        this.setData({ loading: false, users: users, accounts: accounts })
      } catch (e) {
        this.setData({ loading: false, err: e.message || '加载失败' })
      }
    },

    /** 把账号列表 + 已选 uid 合成为可勾选数组 */
    buildFormAccounts(selected) {
      const sel = (selected || []).map(String)
      const accounts = this.data.accounts || []
      return accounts.map(function (a) {
        const uid = String(a.unique_id)
        return {
          uid: uid,
          label: (a.username || uid) + '（' + uid + '）',
          checked: sel.indexOf(uid) >= 0,
        }
      })
    },

    openAdd() {
      this.setData({
        showForm: true,
        formMode: 'add',
        formUser: '',
        formPwd: '',
        formAccounts: this.buildFormAccounts([]),
      })
    },

    openEdit(e) {
      const name = e.currentTarget.dataset.u
      const u = this.data.users.find(function (x) {
        return x.username === name
      })
      if (!u) return
      this.setData({
        showForm: true,
        formMode: 'edit',
        formUser: u.username,
        formPwd: '',
        formAccounts: this.buildFormAccounts(u.accountUids),
      })
    },

    closeForm() {
      this.setData({ showForm: false })
    },

    noop() {},

    onUser(ev) {
      this.setData({ formUser: ev.detail.value })
    },
    onPwd(ev) {
      this.setData({ formPwd: ev.detail.value })
    },

    toggleUid(e) {
      const uid = String(e.currentTarget.dataset.uid)
      const arr = this.data.formAccounts.map(function (x) {
        return x.uid === uid ? { uid: x.uid, label: x.label, checked: !x.checked } : x
      })
      this.setData({ formAccounts: arr })
    },

    async submitForm() {
      const name = String(this.data.formUser || '').trim()
      const pwd = String(this.data.formPwd || '').trim()
      const uids = this.data.formAccounts
        .filter(function (x) {
          return x.checked
        })
        .map(function (x) {
          return x.uid
        })
      if (!name) return ui.toast('用户名必填')
      this.setData({ busy: 'form' })
      try {
        if (this.data.formMode === 'add') {
          if (!pwd) throw new Error('密码必填')
          await api.post('/api/panel-users', {
            username: name,
            password: pwd,
            account_uids: uids,
          })
          ui.ok('用户已创建')
        } else {
          const body = { account_uids: uids }
          if (pwd) body.password = pwd
          await api.panel('/api/panel-users/' + encodeURIComponent(name), 'PATCH', body)
          ui.ok('已保存')
        }
        this.setData({ showForm: false })
        this.load()
      } catch (e) {
        ui.toast(e.message || '保存失败')
      } finally {
        this.setData({ busy: '' })
      }
    },

    async del(e) {
      const name = e.currentTarget.dataset.u
      const ok = await ui.confirm('删除面板用户「' + name + '」？该用户将无法再登录。', '删除用户')
      if (!ok) return
      try {
        await api.panel('/api/panel-users/' + encodeURIComponent(name), 'DELETE')
        ui.ok('已删除')
        this.load()
      } catch (err) {
        ui.toast(err.message || '删除失败')
      }
    },
  })
)
