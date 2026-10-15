const { guard } = require('../../utils/page.js')
const api = require('../../utils/api.js')
const ui = require('../../utils/ui.js')
const notif = require('../../utils/notif.js')
const CONFIG = require('../../config.js')

/**
 * [20261014] 微信头像：网页面板那套头像库只写 localStorage（换设备就没了），
 * 小程序走微信官方授权通道 <button open-type="chooseAvatar">。
 * 本地缓存存的是 **dataURL**：打开就出图、没网也在；面板那份是跨设备的兜底。
 */
const AV_KEY = 'avatar.self.'
/** 已同步到面板的那份路径 —— 用来判断「本地缓存是不是就是服务端最新那份」，避免每次进页面都重拉 */
const AV_PATH_KEY = 'avatar.self.synced.'

Page(
  guard({
    data: {
      session: null,
      username: '',
      initial: '?',
      isAdmin: false,
      accList: [],
      /** 头像（dataURL 或临时文件路径），空 = 退回用户名首字母 */
      avatar: '',
      /** 压缩/上传中（盖一层暗色，避免用户以为没反应） */
      avatarBusy: false,
      notifCount: 0,
      notifBad: 0,
      notifUnread: 0,
      version: CONFIG.VERSION,
      checking: false,
    },

    onShow() {
      const app = getApp()
      const s = app.globalData.session || {}
      const nm = s.username || ''
      this.setData({
        session: s,
        username: nm,
        initial: nm ? nm.slice(0, 1).toUpperCase() : '?',
        isAdmin: !!s.isAdmin,
        accList: app.globalData.accounts || [],
      })
      this.loadNotif()
      this.loadAvatar()
    },

    /**
     * 头像三个来源，优先级从高到低：
     *   ① 本机缓存 avatar.self.<用户名>（dataURL）—— 秒出、离线也在
     *   ② 面板里那份（/api/panel-users 的 avatar 字段）—— 换设备时补上
     *   ③ 都没有 → 退回用户名首字母
     * 面板那份是 /data/avatars/ 下的路径，而 <image> 没法带 X-Panel-Token 头，
     * 所以必须走 api.asset() 让云函数取回来转 base64（与抖音好友头像同一条通道）。
     */
    async loadAvatar() {
      const uname = this.data.username
      if (!uname) return
      let local = ''
      try {
        local = wx.getStorageSync(AV_KEY + uname) || ''
      } catch (e) {}
      if (local) this.setData({ avatar: local })
      let synced = ''
      try {
        synced = wx.getStorageSync(AV_PATH_KEY + uname) || ''
      } catch (e) {}
      try {
        const d = await api.get('/api/panel-users')
        const me = (d.users || []).filter(function (u) {
          return u.username === uname
        })[0]
        const rel = (me && me.avatar) || ''
        if (!rel) return
        /* 本地已经是服务端最新那份 → 不必再拉一次（省流量、也避免闪一下） */
        if (rel === synced && local) return
        try {
          wx.setStorageSync(AV_PATH_KEY + uname, rel)
        } catch (e) {}
        const dataUrl = await api.asset('/' + rel)
        if (dataUrl) {
          try {
            wx.setStorageSync(AV_KEY + uname, dataUrl)
          } catch (e) {}
          this.setData({ avatar: dataUrl })
        }
      } catch (e) {
        /* 拉不到就用本地缓存/首字母，不打扰用户 */
      }
    },

    /** 压到 256px 再上传：微信头像原图可能几百 KB，base64 后再 +33%，
     *  云函数通道和面板 2MB 上限都经不起。compressImage 在个别机型/格式上会失败，
     *  失败就退回原图 —— 面板侧有大小上限兜底，会明确报错而不是写坏数据。 */
    shrinkAvatar(src) {
      return new Promise(function (resolve) {
        if (!wx.compressImage) return resolve(src)
        wx.compressImage({
          src: src,
          quality: 78,
          compressedWidth: 256,
          success: function (r) {
            resolve((r && r.tempFilePath) || src)
          },
          fail: function () {
            resolve(src)
          },
        })
      })
    },

    /** 本地临时文件 → dataURL（readFile 读本地文件不受「合法域名」限制） */
    fileToDataUrl(path) {
      return new Promise(function (resolve, reject) {
        wx.getFileSystemManager().readFile({
          filePath: path,
          encoding: 'base64',
          success: function (r) {
            resolve('data:image/jpeg;base64,' + (r && r.data))
          },
          fail: function (e) {
            reject(new Error((e && e.errMsg) || '读取头像失败'))
          },
        })
      })
    },

    /**
     * 微信头像授权回调（<button open-type="chooseAvatar">）。
     * 顺序：先本地立即预览 → 压缩转 base64 → 落本机 → 再上传面板。
     * 上传失败**不回滚**本地：用户至少在这台手机上看到了自己的头像，
     * 只是提示「同步面板失败」，下次进页面还会用面板那份做兜底。
     */
    async onChooseAvatar(e) {
      const src = (e && e.detail && e.detail.avatarUrl) || ''
      if (!src) return
      const uname = this.data.username
      if (!uname) return ui.toast('请先登录')
      this.setData({ avatar: src, avatarBusy: true })
      let dataUrl = ''
      try {
        const small = await this.shrinkAvatar(src)
        dataUrl = await this.fileToDataUrl(small)
      } catch (err) {
        dataUrl = ''
      }
      if (!dataUrl) {
        this.setData({ avatarBusy: false })
        return ui.toast('头像读取失败，请重试')
      }
      if (dataUrl.length > 1400 * 1024) {
        this.setData({ avatarBusy: false })
        return ui.toast('头像太大，请换一张')
      }
      try {
        wx.setStorageSync(AV_KEY + uname, dataUrl)
      } catch (err) {}
      this.setData({ avatar: dataUrl, avatarBusy: false })
      try {
        const r = await api.post(
          '/api/panel-users/' + encodeURIComponent(uname) + '/avatar',
          { data: dataUrl }
        )
        if (r && r.avatar) {
          try {
            wx.setStorageSync(AV_PATH_KEY + uname, r.avatar)
          } catch (err) {}
          ui.ok('头像已更新')
        } else {
          ui.toast('已存到本机，面板同步未确认')
        }
      } catch (err) {
        ui.toast('已存到本机，同步面板失败：' + ((err && err.message) || ''))
      }
    },

    /**
     * 红点 = 未读 且 非正常 的通知数。
     * 面板那份通知列表没有「已读」概念（只有清空），所以必须叠一层本地水位线，
     * 否则点进通知中心后红点永远不消。
     */
    async loadNotif() {
      const app = getApp()
      const uname = (app.globalData.session || {}).username || ''
      try {
        const d = await api.get('/api/notifications')
        const list = d.notifications || []
        const c = notif.counts(list, uname)
        this.setData({ notifCount: c.badge, notifBad: c.bad, notifUnread: c.unread })
        notif.syncTabBadge(c.badge)
        app.globalData.notifBadge = c.badge
      } catch (e) {
        /* 忽略：红点拉不到不影响其它功能 */
      }
    },

    goDaily() {
      wx.navigateTo({ url: '/pages/daily/daily' })
    },
    goContacts() {
      wx.navigateTo({ url: '/pages/contacts/contacts' })
    },
    goAccounts() {
      wx.navigateTo({ url: '/pages/accounts/accounts' })
    },
    goPush() {
      wx.navigateTo({ url: '/pages/push/push' })
    },
    goNotif() {
      wx.navigateTo({ url: '/pages/notifications/notifications' })
    },
    goUsers() {
      wx.navigateTo({ url: '/pages/panel-users/panel-users' })
    },
    goTasks() {
      wx.switchTab({ url: '/pages/tasks/tasks' })
    },
    goSysStatus() {
      wx.navigateTo({ url: '/pages/sys-status/sys-status' })
    },

    /** 一致性检查：好友库与发送名单是否对得上 */
    async checkConsistency() {
      const app = getApp()
      const uid = app.globalData.currentAccount
      if (!uid) return ui.toast('没有可用账号')
      this.setData({ checking: true })
      try {
        const d = await api.get('/api/consistency-check', { account: uid })
        const issues = d.issues || []
        if (!issues.length) {
          await ui.alert('好友库 ' + d.friend_count + ' 人 / 发送名单 ' + d.target_count + ' 人，完全一致 ✅', '检查通过')
        } else {
          const lines = issues
            .map(function (i) {
              return '· ' + (i.desc || i.type || JSON.stringify(i))
            })
            .join('\n')
          await ui.alert('发现 ' + issues.length + ' 个问题：\n' + lines, '需要处理')
        }
      } catch (e) {
        ui.toast(e.message || '检查失败')
      } finally {
        this.setData({ checking: false })
      }
    },

    async changePassword() {
      const oldPwd = await ui.prompt('', '当前密码', '请输入当前密码')
      if (oldPwd === null) return
      const newPwd = await ui.prompt('', '新密码', '请输入新密码')
      if (newPwd === null) return
      if (!newPwd || newPwd.length < 6) return ui.toast('新密码至少 6 位')
      try {
        await api.post('/api/change-password', { old_password: oldPwd, new_password: newPwd })
        ui.ok('密码已修改')
      } catch (e) {
        ui.toast(e.message || '修改失败')
      }
    },

    async logout() {
      const ok = await ui.confirm('退出后需要重新输入用户名和密码。', '退出登录')
      if (!ok) return
      const app = getApp()
      await app.logout()
      wx.reLaunch({ url: '/pages/login/login' })
    },

    copyVersion() {
      ui.copy('v' + CONFIG.VERSION, '版本号已复制')
    },
  })
)
