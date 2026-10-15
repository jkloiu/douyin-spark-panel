const { guard } = require('../../utils/page.js')
const api = require('../../utils/api.js')
const fmt = require('../../utils/format.js')
const ui = require('../../utils/ui.js')
const av = require('../../utils/avatar.js')

Page(
  guard({
    data: {
      loading: true,
      err: '',
      sid: '',
      friend: null,
      busy: '',
    },

    onLoad(q) {
      this.setData({ sid: (q && q.sid) || '' })
    },

    onShow() {
      this.load()
    },

    async load() {
      const app = getApp()
      const uid = app.globalData.currentAccount
      this.setData({ loading: true, err: '' })
      if (!uid || !this.data.sid) {
        this.setData({ loading: false, err: '缺少参数' })
        return
      }
      try {
        const d = await api.get('/api/friends', { account: uid })
        const f = (d.friends || []).find(function (x) {
          return String(x.short_id) === String(this.data.sid)
        }, this)
        if (!f) {
          this.setData({ loading: false, err: '这个好友不在当前账号的名单里' })
          return
        }
        const lv = fmt.sparkLevel(f.spark_days)
        const nm = fmt.dispName(f)
        const friend = {
          shortId: f.short_id,
          name: nm,
          remark: f.remark || f.douyin_remark || '',
          douyinId: fmt.douyinId(f),
          avatar: f.avatar || '',
          __avatar: '',
          initial: fmt.initial(nm),
          days: Number(f.spark_days || 0),
          levelText: lv.text,
          levelCls: lv.cls,
          fresh: !!f.fresh,
          freshText: f.fresh ? '今天已同步' : '数据不是今天的',
          todaySent: !!f.today_sent,
          // [修复20261007] 同 spark 页：优先抓取回来的真实会话消息，回落到我们自己的发送台账
          lastContent: f.last_message || f.last_content || '',
          lastTime: f.last_msg_time || '',
          status: f.status || '',
          addedAt: f.added_at || '',
          accounts: (f.account_uids || []).join(' / '),
          cacheText: f.cache_ts ? fmt.relTime(f.cache_ts) : '—',
        }
        this.setData({ loading: false, friend: friend })
        const that = this
        av.resolve(f.avatar, function (src) {
          friend.__avatar = src
          that.setData({ friend: friend })
        })
      } catch (e) {
        this.setData({ loading: false, err: e.message || '加载失败' })
      }
    },

    copyId() {
      if (this.data.friend) ui.copy(this.data.friend.douyinId, '抖音号已复制')
    },

    /** 立即给这个人单独续一次火花 */
    async runNow() {
      const app = getApp()
      const uid = app.globalData.currentAccount
      const f = this.data.friend
      if (!uid || !f) return
      const ok = await ui.confirm(
        '立刻用当前账号给「' + f.name + '」发一条消息？\n注意：这会占用服务器浏览器 1~2 分钟。',
        '立即续火花'
      )
      if (!ok) return
      this.setData({ busy: 'run' })
      try {
        await api.panel('/api/run?task=custom&account=' + uid, 'POST', { target: f.shortId })
        ui.ok('已开始发送')
      } catch (e) {
        ui.toast(e.message || '启动失败')
      } finally {
        this.setData({ busy: '' })
      }
    },

    async editRemark() {
      const f = this.data.friend
      if (!f) return
      const v = await ui.prompt(f.remark || f.name, '修改备注名', '留空表示清除备注')
      if (v === null) return
      this.setData({ busy: 'remark' })
      try {
        await api.panel('/api/friends/' + f.shortId, 'PATCH', { remark: String(v).trim() })
        ui.ok('已保存')
        this.load()
      } catch (e) {
        ui.toast(e.message || '保存失败')
      } finally {
        this.setData({ busy: '' })
      }
    },

    async remove() {
      const f = this.data.friend
      const app = getApp()
      const uid = app.globalData.currentAccount
      if (!f) return
      const ok = await ui.confirm(
        '把「' + f.name + '」从当前账号的续火花名单里移除？之后不会再自动给他发消息。',
        '移出名单'
      )
      if (!ok) return
      this.setData({ busy: 'del' })
      try {
        await api.panel('/api/friends/' + f.shortId + '?account=' + uid, 'DELETE')
        ui.ok('已移除')
        setTimeout(function () {
          wx.navigateBack()
        }, 800)
      } catch (e) {
        ui.toast(e.message || '移除失败')
      } finally {
        this.setData({ busy: '' })
      }
    },
  })
)
