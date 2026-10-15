const { guard } = require('../../utils/page.js')
const api = require('../../utils/api.js')
const ui = require('../../utils/ui.js')
const fmt = require('../../utils/format.js')

/** 各渠道「接收地址」那个字段在用户嘴里的叫法（列表摘要 / 弹窗占位符用） */
const ADDR_NAME = {
  wxpusher: 'UID',
  wecom: 'Webhook',
  bark: '地址',
  generic: '地址',
  clawbot: '（不用填）',
  serverchan: '（不用填）',
}

/** 列表左边圆标上的字 */
function initialOf(label) {
  const s = String(label || '?').trim()
  return s ? s.slice(0, 1).toUpperCase() : '?'
}

/** 一行摘要：把打码后的密钥展示出来，等于「查」这一步 */
function summarize(c) {
  const bits = []
  if (c.has_token) bits.push('密钥 ' + c.token_hint)
  if (c.has_webhook) bits.push((ADDR_NAME[c.channel] || '接收地址') + ' ' + c.webhook_hint)
  if (!bits.length) bits.push('还没填密钥 · 点这行填')
  return bits.join(' · ')
}

Page(
  guard({
    data: {
      loading: true,
      err: '',

      // ── 微信服务通知（小程序订阅消息 · 日报推送）──
      sub: {
        configured: false,
        templateId: '',
        enabled: false,
        grants: 0,
        needRenew: false,
        lastSent: 0,
        lastTitle: '',
        lastDetail: '',
        lastErr: '',
        lastSlot: '',
        page: '',
        slots: [9, 18],
      },
      subLastText: '',
      /** 「每天 09:00 / 18:00」这种展示文案 */
      slotsText: '每天 09:00 / 18:00',
      subBusy: false,
      subTesting: false,

      // ── 第三方通道列表 ──
      chList: [],
      chCount: 0,
      thirdSum: '',
      maxCh: 10,
      globalConfigured: false,
      username: '',
      /** 「当前推送方式」一览：明确告诉用户现在到底靠哪条通道在推 */
      nowText: '加载中…',

      // ── 增加 / 编辑弹窗 ──
      sheet: false,
      editing: false,
      editId: '',
      chOptions: [],
      optLabels: [],
      fIdx: 0,
      fChannel: '',
      fLabel: '',
      fToken: '',
      fWebhook: '',
      fEnabled: true,
      fDaily: true,
      fTokenHint: '',
      fWebhookHint: '',
      fAddrLabel: '接收地址',
      /** 编辑态：这条通道服务器上已经有密钥（「发送测试」才有意义） */
      fHasKey: false,
      /** '' | 'save' | 'test' | 'del' */
      busy: '',
    },

    onShow() {
      this.load()
      this.loadSub()
    },

    /**
     * 「当前推送方式」一览 + 卡片副标题。
     * 只列**真正开着**的通道 —— 配过但停用的不算，否则用户会以为自己还在收推送。
     */
    refreshNow() {
      const on = []
      if (this.data.sub && this.data.sub.enabled) on.push('微信服务通知')
      const nOn = this.data.chList.filter(function (c) {
        return c.enabled
      }).length
      if (nOn) on.push('第三方通道 ' + nOn + ' 条')
      const n = this.data.chList.length
      this.setData({
        nowText: on.length ? on.join(' ＋ ') : '未开启 · 现在收不到任何推送',
        chCount: n,
        thirdSum: n ? '共 ' + n + ' 条 · 启用 ' + nOn + ' 条' : '未添加 · 不需要可以不用管',
      })
    },

    async load() {
      this.setData({ loading: true, err: '' })
      try {
        const d = await api.get('/api/push-config')
        const opts = d.channels || []
        const list = (d.channel_list || []).map(function (c) {
          const label = c.channel_label || c.channel
          return Object.assign({}, c, {
            label: label,
            initial: initialOf(label),
            summary: summarize(c),
          })
        })
        this.setData({
          loading: false,
          chOptions: opts,
          optLabels: opts.map(function (c) {
            return c.label
          }),
          chList: list,
          maxCh: d.max_channels || 10,
          globalConfigured: !!d.global_configured,
          username: d.username || '',
        })
        this.refreshNow()
      } catch (e) {
        this.setData({ loading: false, err: e.message || '加载失败' })
      }
    },

    // ── 微信服务通知 ──────────────────────────────────────────────
    async loadSub() {
      try {
        const r = await api.raw('subStatus', {})
        const s = r.sub || {}
        this.setData({
          sub: s,
          slotsText: this.slotsText(s.slots),
          subLastText: s.lastSent ? fmt.fmtFull(s.lastSent) : '',
        })
        this.refreshNow()
      } catch (e) {
        /* 云函数旧版本可能还没有这个动作，静默降级 */
        this.setData({ sub: Object.assign({}, this.data.sub, { configured: false, lastErr: e.message }) })
        this.refreshNow()
      }
    },

    /** [9,18] → 「每天 09:00 / 18:00」 */
    slotsText(slots) {
      const arr = (slots && slots.length ? slots : [9, 18]).slice().sort(function (a, b) {
        return a - b
      })
      const hm = arr.map(function (h) {
        const n = Number(h) || 0
        return (n < 10 ? '0' + n : '' + n) + ':00'
      })
      return '每天 ' + hm.join(' / ')
    },

    /** 调起微信的订阅授权弹窗（必须由点击触发） */
    requestSub() {
      const tpl = this.data.sub.templateId
      return new Promise(function (resolve, reject) {
        if (!tpl) return reject(new Error('还没有配置订阅消息模板 ID'))
        if (!wx.requestSubscribeMessage) {
          return reject(new Error('当前微信版本不支持订阅消息，请升级微信'))
        }
        wx.requestSubscribeMessage({
          tmplIds: [tpl],
          success: function (res) {
            resolve(res)
          },
          fail: function (e) {
            const msg = String((e && e.errMsg) || '')
            if (msg.indexOf('20004') >= 0) {
              reject(new Error('你在微信里关闭了本小程序的订阅消息总开关，请到「微信 → 我 → 设置 → 隐私 → 授权管理」打开后重试'))
            } else {
              reject(new Error(msg || '订阅失败'))
            }
          },
        })
      })
    },

    /**
     * 开启 / 续订额度。
     * 微信的规矩：一次性订阅是**纯计数**的 —— 用户每授权一次，该模板的可下发条数 +1。
     * 弹窗出不出由微信决定：用户勾了「总是保持以上选择，不再询问」之后就不再弹窗，
     * 但**每次调用仍然 +1**（所以「点了没弹窗」不是失效，额度照样在加）。
     * 同一个点击里多次调用只有第一次生效，所以「一次点击多加」做不到，只能连点几次。
     */
    async onSubscribe() {
      if (!this.data.sub.configured) return this.showHowto()
      if (this.data.subBusy) return
      this.setData({ subBusy: true })
      try {
        const res = await this.requestSub()
        const tpl = this.data.sub.templateId
        const verdict = res && res[tpl]
        if (verdict === 'accept') {
          await api.raw('subGrant', { count: 1 })
          await this.loadSub()
          ui.toast('额度 +1 · 现共 ' + Number(this.data.sub.grants || 0) + ' 条')
        } else if (verdict === 'reject') {
          this.explainReject()
        } else if (verdict === 'ban') {
          ui.toast('该模板已被封禁，请到公众平台查看')
        } else {
          ui.toast('订阅未生效：' + verdict)
        }
      } catch (e) {
        ui.alert(e.message || '订阅失败', '订阅失败')
      } finally {
        this.setData({ subBusy: false })
      }
    },

    /**
     * 「点了没反应」最常见的成因：用户以前勾了「总是保持以上选择」但选的是**拒绝**，
     * 之后微信每次调用都静默返回 reject、弹窗再也不出现 —— 只能去设置页把开关打开。
     */
    async explainReject() {
      const go = await ui.confirm(
        '微信记着你上次的选择是「拒绝」，所以这次没有弹窗，额度也不会增加。\n\n' +
          '想重新接收：点「确定」打开设置页 → 订阅消息 → 把本小程序的开关打开，\n' +
          '再回来点一次「补充额度」即可。',
        '这次没加上额度'
      )
      if (go) this.openSetting()
    },

    /** 打开小程序设置页（订阅消息开关在这里改） */
    openSetting() {
      const that = this
      if (!wx.openSetting) {
        return ui.toast('请点右上角「…」→ 设置 → 订阅消息 手动打开')
      }
      try {
        wx.openSetting({
          success: function () {
            that.loadSub()
          },
          fail: function () {
            ui.toast('打不开设置页，请点右上角「…」→ 设置 手动打开')
          },
        })
      } catch (e) {
        ui.toast('打不开设置页，请点右上角「…」→ 设置 手动打开')
      }
    },

    async onSubOff() {
      const ok = await ui.confirm('关闭后不再通过微信服务通知推送日报。', '关闭微信服务通知')
      if (!ok) return
      try {
        await api.raw('subOff', {})
        await this.loadSub()
        ui.ok('已关闭')
      } catch (e) {
        ui.toast(e.message || '操作失败')
      }
    },

    async onSubTest() {
      if (!this.data.sub.configured) return this.showHowto()
      if (!this.data.sub.enabled) return ui.toast('请先点「开启」授权订阅')
      this.setData({ subTesting: true })
      try {
        const r = await api.raw('subTest', {})
        const v = r.vals || {}
        const left = (r.sub && r.sub.grants) || 0
        await ui.alert(
          '已提交给微信，请留意「服务通知」。\n\n' +
            '主文案：' + (v.title || '-') + '\n' +
            (v.detail ? '明细：' + v.detail + '\n' : '') +
            '时间：' + (v.time || '-') + '\n\n' +
            '剩余可接收 ' + left + ' 条。',
          '发送成功'
        )
        await this.loadSub()
      } catch (e) {
        await ui.alert(e.message || '发送失败', '发送失败')
        this.loadSub()
      } finally {
        this.setData({ subTesting: false })
      }
    },

    /** 预览下次定时推送会发什么（不消耗额度） */
    async onSubCheck() {
      this.setData({ subBusy: true })
      try {
        const r = await api.raw('subPreview', {})
        const v = r.vals || {}
        const s = r.summary || {}
        const issues = r.issues || []
        const lines = [
          '【主文案】' + (v.title || '-'),
          '【明细】' + (v.detail || '-'),
          '【时间】' + (v.time || '-'),
          '',
          '日报数据：' + (r.generated || '-') +
            '（发送 ' + (s.sent_ok || 0) + '/' + (s.sent_total || 0) +
            '，待处理 ' + (s.issues || 0) + ' 项）',
        ]
        if (issues.length) {
          lines.push('', '待处理清单（前 ' + issues.length + ' 条）：')
          issues.forEach(function (x) {
            lines.push('· ' + (x.text || ''))
          })
        }
        lines.push('', '点开后会跳到小程序的日报页（' + (r.page || '-') + '）。')
        await ui.alert(lines.join('\n'), '下次推送的内容')
      } catch (e) {
        ui.toast(e.message || '查询失败')
      } finally {
        this.setData({ subBusy: false })
      }
    },

    showHowto() {
      ui.alert(
        '微信服务通知用的是「小程序订阅消息」，需要先在微信公众平台申请一个模板：\n\n' +
          '1. 登录 mp.weixin.qq.com（这个小程序的账号）\n' +
          '2. 左侧「功能 → 订阅消息」→ 选用模板\n' +
          '3. 从公共模板库里挑「提醒」类，字段含「提醒事项 / 提醒时间」的（若同时有第二个文本字段更好，能多带一条异常明细）\n' +
          '4. 把模板 ID 发给开发者填进云函数\n\n' +
          '申请通过后回来点「开启」即可，全程免费、不用第三方。',
        '需要先申请模板'
      )
    },

    // ── 第三方通道：列表 ──────────────────────────────────────────
    openAdd() {
      if (this.data.chList.length >= this.data.maxCh) {
        return ui.toast('最多 ' + this.data.maxCh + ' 条通道')
      }
      // 默认选第一个真渠道（跳过「关闭」）
      let idx = this.data.chOptions.findIndex(function (c) {
        return c.value
      })
      if (idx < 0) idx = 0
      const opt = this.data.chOptions[idx] || { value: '', label: '关闭' }
      this.setData({
        sheet: true,
        editing: false,
        editId: '',
        fIdx: idx,
        fChannel: opt.value,
        fLabel: opt.label,
        fToken: '',
        fWebhook: '',
        fEnabled: true,
        fDaily: true,
        fTokenHint: '还没配置',
        fWebhookHint: '还没配置',
        fAddrLabel: ADDR_NAME[opt.value] || '接收地址',
        fHasKey: false,
        busy: '',
      })
    },

    openEdit(e) {
      const i = Number(e.currentTarget.dataset.i)
      const c = this.data.chList[i]
      if (!c) return
      let idx = this.data.chOptions.findIndex(function (o) {
        return o.value === c.channel
      })
      if (idx < 0) idx = 0
      this.setData({
        sheet: true,
        editing: true,
        editId: c.id,
        fIdx: idx,
        fChannel: c.channel,
        fLabel: c.label,
        fToken: '',
        fWebhook: '',
        fEnabled: !!c.enabled,
        fDaily: !!c.daily,
        // 打码回显 = 「查」；输入框留空 = 不改动服务器上已存的密钥
        fTokenHint: c.has_token ? '已配置：' + c.token_hint + '（留空不改）' : '还没配置',
        fWebhookHint: c.has_webhook ? '已配置：' + c.webhook_hint + '（留空不改）' : '还没配置',
        fAddrLabel: ADDR_NAME[c.channel] || '接收地址',
        fHasKey: !!(c.has_token || c.has_webhook),
        busy: '',
      })
    },

    closeSheet() {
      this.setData({ sheet: false, busy: '' })
    },

    noop() {},

    onFormChannel(e) {
      const idx = Number(e.detail.value)
      const opt = this.data.chOptions[idx] || { value: '', label: '关闭' }
      this.setData({
        fIdx: idx,
        fChannel: opt.value,
        fLabel: opt.label,
        fAddrLabel: ADDR_NAME[opt.value] || '接收地址',
      })
    },
    onFormToken(e) {
      this.setData({ fToken: e.detail.value })
    },
    onFormWebhook(e) {
      this.setData({ fWebhook: e.detail.value })
    },
    onFormEnabled(e) {
      this.setData({ fEnabled: e.detail.value })
    },
    onFormDaily(e) {
      this.setData({ fDaily: e.detail.value })
    },

    /** 把当前列表压成接口要的形状（不带密钥的条目 = 服务器保留原密钥） */
    packList(without) {
      return this.data.chList
        .filter(function (c) {
          return c.id !== without
        })
        .map(function (c) {
          return { id: c.id, channel: c.channel, enabled: !!c.enabled, daily: !!c.daily }
        })
    },

    async saveRow() {
      if (this.data.busy) return
      if (!this.data.fChannel) return ui.toast('先选一个推送渠道')
      this.setData({ busy: 'save' })
      try {
        const list = this.packList(this.data.editing ? this.data.editId : '')
        const ent = {
          channel: this.data.fChannel,
          enabled: !!this.data.fEnabled,
          daily: !!this.data.fDaily,
        }
        if (this.data.editing) ent.id = this.data.editId
        // 只在用户真填了才带上密钥；留空 = 服务器不修改
        if (this.data.fToken) ent.token = this.data.fToken
        if (this.data.fWebhook) ent.webhook = this.data.fWebhook
        list.push(ent)
        await api.panel('/api/push-config', 'PUT', { channel_list: list })
        ui.ok(this.data.editing ? '已保存' : '已增加')
        this.setData({ sheet: false, busy: '' })
        this.load()
      } catch (e) {
        this.setData({ busy: '' })
        ui.toast(e.message || '保存失败')
      }
    },

    async removeRow() {
      if (this.data.busy) return
      const c = this.data.chList.filter(
        function (x) {
          return x.id === this.data.editId
        }.bind(this)
      )[0]
      const ok = await ui.confirm(
        '删除' + (c ? '「' + c.label + '」' : '这条通道') + '？\n\n' +
          '· 服务器上这条通道存的密钥一并清空\n' +
          '· 其它通道、微信服务通知都不受影响',
        '删除通道'
      )
      if (!ok) return
      this.setData({ busy: 'del' })
      try {
        await api.panel('/api/push-config', 'PUT', { channel_list: this.packList(this.data.editId) })
        ui.ok('已删除')
        this.setData({ sheet: false, busy: '' })
        this.load()
      } catch (e) {
        this.setData({ busy: '' })
        ui.toast(e.message || '删除失败')
      }
    },

    /** 单条测试：只测这个渠道，不受它在列表里开关状态影响 */
    async testRow() {
      if (this.data.busy) return
      if (!this.data.editId) return ui.toast('先保存这条通道，再发送测试')
      this.setData({ busy: 'test' })
      try {
        const r = await api.panel('/api/push-config/test', 'POST', { id: this.data.editId })
        const lines = []
        if (r.delivery_text) lines.push(r.delivery_text)
        if (r.info) lines.push(String(r.info))
        await ui.alert(lines.join('\n\n') || '已提交给该渠道', '测试结果')
      } catch (e) {
        await ui.alert(e.message || '测试失败', '测试失败')
      } finally {
        this.setData({ busy: '' })
      }
    },

    copyTip() {
      ui.copy(
        'WxPusher：wxpusher.zjiecode.com 建应用拿 appToken 填 Token，扫码关注后拿 UID 填接收地址\n' +
          '企业微信机器人：群 → 添加群机器人 → 复制 Webhook\n' +
          'Server酱：SCT 开头的 token\n' +
          'Bark：https://api.day.app/你的key',
        '填写说明已复制'
      )
    },
  })
)
