/**
 * 系统状态
 *
 * 为什么需要这一页：以前面板只把「业务结果」暴露出去，环境层的异常
 * （面板服务挂了、浏览器锁被别的任务占着、某个任务卡在跑）没有任何出口，
 * 用户看到的只是「某个功能莫名报错 / 一直转圈」。这里把环境状态摆出来。
 *
 * 数据来自面板 /api/status（本轮新增 browser_lock 与 running 两段）。
 */
const { guard } = require('../../utils/page.js')
const api = require('../../utils/api.js')
const ui = require('../../utils/ui.js')

// 剩余时间少于这个值就标红：锁到点会自我保护退出，任务可能被中途掐掉
const LOW_REMAIN = 180

function hmsText(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  if (s < 60) return s + ' 秒'
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 >= 30 ? m + ' 分 ' + (s % 60) + ' 秒' : m + ' 分'
  return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分'
}

/** 锁文件内容是 "<pid> <HH:MM:SS> <标签>"，取出人能看懂的那段标签 */
function lockLabel(owner) {
  const parts = String(owner || '').trim().split(/\s+/)
  if (parts.length >= 3) return parts.slice(2).join(' ')
  return String(owner || '').trim() || '未知任务'
}

Page(
  guard({
    data: {
      loading: true,
      err: '',
      alive: false,
      now: '',
      disk: '',
      tokenSet: false,
      lock: null,
      lockText: '未知',
      lockCls: '',
      lockOwnerLabel: '',
      lockLow: false,
      maxHoldText: '15 分',
      running: [],
      anyRunning: false,
      next: null,
      crontab: '',
      isAdmin: false,
      busy: '',
      updatedAt: '',
    },

    onShow() {
      this.load()
    },

    onPullDownRefresh() {
      const that = this
      Promise.resolve(this.load()).then(function () {
        wx.stopPullDownRefresh()
        if (that.data.alive) ui.toast('已刷新')
      })
    },

    async load() {
      const app = getApp()
      this.setData({
        loading: !this.data.alive, // 已有数据时不铺骨架，避免每次 onShow 闪一下
        err: '',
        isAdmin: !!(app.globalData.session || {}).isAdmin,
      })
      try {
        const d = await api.get('/api/status')
        const lk = d.browser_lock || {}
        const remain = Number(lk.remain) || 0
        const running = []
        const rmain = (d.running || {}).main || {}
        const rcustom = (d.running || {}).custom || {}
        running.push({
          key: 'main',
          label: '批量续火花',
          sub: rmain.running
            ? '进行中' + (rmain.state && rmain.state.account ? ' · ' + rmain.state.account : '')
            : '未运行',
          running: !!rmain.running,
        })
        running.push({
          key: 'custom',
          label: '定时任务',
          sub: rcustom.running ? '进行中' : '未运行',
          running: !!rcustom.running,
        })

        this.setData({
          loading: false,
          alive: true,
          now: d.now || '',
          disk: d.disk || '',
          tokenSet: !!d.token_set,
          lock: lk,
          lockText: lk.held ? '被占用' : lk.stale ? '残留记录' : '空闲',
          lockCls: lk.held ? (remain <= LOW_REMAIN ? 'badge--danger' : 'badge--warn') : lk.stale ? 'badge--warn' : 'badge--ok',
          lockOwnerLabel: lockLabel(lk.owner),
          lockLow: remain > 0 && remain <= LOW_REMAIN,
          maxHoldText: hmsText(lk.max_hold || 900),
          running: running,
          anyRunning: !!(rmain.running || rcustom.running),
          next: d.next || null,
          crontab: d.crontab || '',
          updatedAt: d.now || '',
        })
      } catch (e) {
        this.setData({
          loading: false,
          alive: false,
          err: e.message || '拿不到面板状态',
        })
      }
    },

    /** 停止正在运行的任务：锁被卡住时这是唯一的解药（面板侧已做归属校验） */
    async stopRun(e) {
      const key = e.currentTarget.dataset.k
      const label = key === 'main' ? '批量续火花' : '定时任务'
      const ok = await ui.confirm(
        '将终止「' + label + '」的整个进程树，正在发送的那一位可能只发了一半。',
        '停止' + label
      )
      if (!ok) return
      const app = getApp()
      const acc = app.globalData.currentAccount || ''
      this.setData({ busy: key })
      try {
        const r = await api.panel(
          '/api/run/stop?task=' + key + '&account=' + encodeURIComponent(acc),
          'POST',
          {}
        )
        if (r && r.ok === false) throw new Error(r.error || '停止失败')
        ui.ok('已停止')
      } catch (err) {
        ui.toast(err.message || '停止失败')
      } finally {
        this.setData({ busy: '' })
        this.load()
      }
    },
  })
)
