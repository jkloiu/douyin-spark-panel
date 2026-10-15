const { guard } = require('../../utils/page.js')
const api = require('../../utils/api.js')
const fmt = require('../../utils/format.js')
const ui = require('../../utils/ui.js')
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

      tasks: [],
      busyId: '',
      runState: null,
      timer: null,
    },

    onShow() {
      accbar.refresh(this)
      this.load()
    },

    onHide() {
      this.stopPoll()
    },

    onUnload() {
      this.stopPoll()
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
      this.setData({ loading: true, err: '' })
      if (!uid) {
        this.setData({ loading: false, err: '当前用户没有绑定抖音账号' })
        return
      }
      try {
        const d = await api.get('/api/schedule', { account: uid })
        const raw = (d.schedule && d.schedule.tasks) || []
        const tasks = raw.map(function (t) {
          const lr = t.last_run || null
          const hh = fmt.pad(t.hour || 0)
          const mm = fmt.pad(t.minute || 0)
          return {
            id: t.id,
            type: t.type,
            typeText: t.type === 'custom' ? '单独续' : '批量续',
            description: t.description || '',
            target: t.target || '',
            targetName: t.target_name || '',
            enabled: !!t.enabled,
            canEdit: t.can_edit !== false,
            timeText: hh + ':' + mm,
            nextRun: t.next_run || '',
            running: !!t.running,
            msgMode: t.msg_mode || 'template',
            msg: t.msg || '',
            delay: t.random_delay_max || 0,
            lastText: lr
              ? fmt.fmtFull(lr.ts) + (lr.success === false ? ' · 失败' : lr.sent ? ' · 发送 ' + lr.sent + ' 条' : ' · 成功')
              : '从未运行',
            lastOk: lr ? lr.success !== false : null,
          }
        })
        this.setData({ loading: false, tasks: tasks })
        this.poll()
      } catch (e) {
        this.setData({ loading: false, err: e.message || '加载失败' })
      }
    },

    /** 有任务在跑时 3 秒轮询一次状态 */
    poll() {
      const that = this
      this.stopPoll()
      const anyRunning = this.data.tasks.some(function (t) {
        return t.running
      })
      if (!anyRunning) {
        this.setData({ runState: null })
        return
      }
      const tick = async function () {
        const app = getApp()
        const uid = app.globalData.currentAccount
        try {
          const d = await api.get('/api/run/status', { task: 'custom', account: uid })
          that.setData({ runState: d && d.running ? d.state || { running: true } : null })
          if (!d || !d.running) {
            that.stopPoll()
            that.load()
          }
        } catch (e) {
          /* 轮询失败静默 */
        }
      }
      tick()
      this.setData({ timer: setInterval(tick, 3000) })
    },

    stopPoll() {
      if (this.data.timer) {
        clearInterval(this.data.timer)
        this.setData({ timer: null })
      }
    },

    async toggle(e) {
      const id = e.currentTarget.dataset.id
      const on = e.currentTarget.dataset.on
      const t = this.data.tasks.find(function (x) {
        return x.id === id
      })
      if (!t) return
      if (!t.canEdit) {
        ui.toast('这个任务你没有编辑权限')
        return
      }
      this.setData({ busyId: id })
      try {
        await api.panel('/api/schedule/tasks/' + id, 'PUT', { enabled: !on })
        ui.ok(on ? '已停用' : '已启用')
        await this.load()
      } catch (err) {
        ui.toast(err.message || '操作失败')
      } finally {
        this.setData({ busyId: '' })
      }
    },

    async runNow(e) {
      const id = e.currentTarget.dataset.id
      const ok = await ui.confirm('立即执行这个任务？会占用浏览器，其他自动化任务需要排队等待。', '立即运行')
      if (!ok) return
      this.setData({ busyId: id })
      try {
        await api.panel('/api/schedule/tasks/' + id + '/run', 'POST', {})
        ui.ok('已开始执行')
        setTimeout(this.load.bind(this), 1200)
      } catch (err) {
        ui.toast(err.message || '启动失败')
      } finally {
        this.setData({ busyId: '' })
      }
    },

    async remove(e) {
      const id = e.currentTarget.dataset.id
      const t = this.data.tasks.find(function (x) {
        return x.id === id
      })
      if (!t) return
      const ok = await ui.confirm('确定删除任务「' + (t.description || t.typeText) + '」？删除后不会再有定时发送。', '删除任务')
      if (!ok) return
      this.setData({ busyId: id })
      try {
        await api.panel('/api/schedule/tasks/' + id, 'DELETE')
        ui.ok('已删除')
        await this.load()
      } catch (err) {
        ui.toast(err.message || '删除失败')
      } finally {
        this.setData({ busyId: '' })
      }
    },

    addTask() {
      wx.navigateTo({ url: '/pages/task-form/task-form' })
    },

    editTask(e) {
      const id = e.currentTarget.dataset.id
      wx.navigateTo({ url: '/pages/task-form/task-form?id=' + id })
    },
  })
)
