const { guard } = require('../../utils/page.js')
const api = require('../../utils/api.js')
const ui = require('../../utils/ui.js')
const fmt = require('../../utils/format.js')

Page(
  guard({
    data: {
      id: '',
      isEdit: false,
      loading: true,
      err: '',
      saving: false,

      typeIdx: 1,
      type: 'custom',
      typeLabels: ['批量续（给名单里所有人发）', '单独续（只给一个人发）'],

      friends: [],
      friendLabels: [],
      friendIdx: -1,
      target: '',
      targetName: '',

      time: '09:00',
      enabled: true,

      msgModeIdx: 0,
      msgMode: 'template',
      msgModeLabels: ['火花模板（今日火花 + 每日一言）', '自定义文案'],
      msg: '',

      delay: '',
      description: '',
    },

    onLoad(q) {
      this.setData({ id: (q && q.id) || '', isEdit: !!(q && q.id) })
    },

    onShow() {
      this.load()
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
        const friends = (d.friends || []).map(function (f) {
          const nm = fmt.dispName(f)
          return { short_id: f.short_id, name: nm, label: nm + '（' + fmt.douyinId(f) + '）' }
        })

        let patch = {
          friends: friends,
          friendLabels: friends.map(function (f) {
            return f.label
          }),
        }

        if (this.data.isEdit) {
          const s = await api.get('/api/schedule', { account: uid })
          const t = ((s.schedule && s.schedule.tasks) || []).find(function (x) {
            return x.id === this.data.id
          }, this)
          if (!t) throw new Error('任务不存在或已被删除')
          const idx = friends.findIndex(function (f) {
            return String(f.short_id) === String(t.target)
          })
          patch = Object.assign(patch, {
            typeIdx: t.type === 'main' ? 0 : 1,
            type: t.type,
            friendIdx: idx,
            target: t.target || '',
            targetName: t.target_name || '',
            time: fmt.pad(t.hour || 0) + ':' + fmt.pad(t.minute || 0),
            enabled: !!t.enabled,
            msgModeIdx: t.msg_mode === 'custom' ? 1 : 0,
            msgMode: t.msg_mode || 'template',
            msg: t.msg || '',
            delay: t.random_delay_max ? String(t.random_delay_max) : '',
            description: t.description || '',
          })
        } else {
          patch = Object.assign(patch, {
            typeIdx: 1,
            type: 'custom',
            friendIdx: friends.length ? 0 : -1,
            target: friends.length ? friends[0].short_id : '',
            time: '09:00',
            enabled: true,
            msgModeIdx: 0,
            msgMode: 'template',
            msg: '',
            delay: '',
            description: '',
          })
        }
        this.setData(Object.assign({ loading: false }, patch))
      } catch (e) {
        this.setData({ loading: false, err: e.message || '加载失败' })
      }
    },

    onType(e) {
      const idx = Number(e.detail.value)
      const type = idx === 0 ? 'main' : 'custom'
      this.setData({ typeIdx: idx, type: type })
    },

    onFriend(e) {
      const idx = Number(e.detail.value)
      const f = this.data.friends[idx]
      this.setData({
        friendIdx: idx,
        target: f ? f.short_id : '',
        targetName: f ? f.name : '',
      })
    },

    onTime(e) {
      this.setData({ time: e.detail.value })
    },

    onEnabled(e) {
      this.setData({ enabled: e.detail.value })
    },

    onMsgMode(e) {
      const idx = Number(e.detail.value)
      this.setData({ msgModeIdx: idx, msgMode: idx === 1 ? 'custom' : 'template' })
    },

    onMsg(e) {
      this.setData({ msg: e.detail.value })
    },

    onDelay(e) {
      this.setData({ delay: e.detail.value })
    },

    onDesc(e) {
      this.setData({ description: e.detail.value })
    },

    async submit() {
      const app = getApp()
      const uid = app.globalData.currentAccount
      if (!uid) return ui.toast('没有可用账号')
      if (this.data.type === 'custom' && !this.data.target) {
        return ui.toast('请选择要单独续的好友')
      }
      if (this.data.msgMode === 'custom' && !String(this.data.msg || '').trim()) {
        return ui.toast('自定义文案不能为空')
      }

      const parts = String(this.data.time || '09:00').split(':')
      const friend = this.data.friends[this.data.friendIdx]
      const body = {
        account_uid: uid,
        type: this.data.type,
        target: this.data.type === 'custom' ? this.data.target : '',
        hour: Number(parts[0] || 0),
        minute: Number(parts[1] || 0),
        enabled: this.data.enabled,
        msg_mode: this.data.msgMode,
        msg: this.data.msgMode === 'custom' ? String(this.data.msg).trim() : '',
        random_delay_max: Number(this.data.delay) || 0,
        description:
          String(this.data.description || '').trim() ||
          (this.data.type === 'custom'
            ? '单独续(' + ((friend && friend.name) || this.data.targetName || this.data.target) + ')'
            : '批量续'),
      }

      this.setData({ saving: true })
      try {
        if (this.data.isEdit) {
          await api.panel('/api/schedule/tasks/' + this.data.id, 'PUT', body)
          ui.ok('已保存')
        } else {
          await api.post('/api/schedule/tasks', body)
          ui.ok('任务已创建')
        }
        setTimeout(function () {
          wx.navigateBack()
        }, 800)
      } catch (e) {
        ui.toast(e.message || '保存失败')
      } finally {
        this.setData({ saving: false })
      }
    },
  })
)
