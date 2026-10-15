/**
 * panelApi —— 抖音火花面板 · 小程序网关云函数
 * ------------------------------------------------------------------
 * 小程序  ──callFunction──▶  本函数  ──HTTP──▶  现有 Flask 面板(PANEL_BASE)
 *
 * 为什么必须要有这一层：
 *   微信小程序的 wx.request 只能是 https + 已备案域名，而面板是
 *   http://121.36.38.180:8123（裸 IP + 非标端口），小程序根本发不出去。
 *   云函数出口不受此限，且 wx.cloud.callFunction 本身「免域名配置」，
 *   所以这一层是唯一干净的合规通道。
 *
 * 鉴权模型（小程序端不长期保存面板密码）：
 *   1) 用户在登录页输入「面板用户名 + 密码」
 *   2) 本函数代调 /api/login，拿到 X-Panel-Token
 *   3) 把 openid → {username, panelToken, expire} 存进 panel_sessions 集合
 *   4) 之后小程序只发业务请求，本函数按 openid 取 token 转发
 *   5) 面板 token 失效 → 统一返回 code=NEED_LOGIN，前端弹登录框
 *
 * 依赖：仅 wx-server-sdk（HTTP 走 Node 内置模块，避免云函数装包失败）
 *
 * 环境变量：
 *   PANEL_BASE        面板地址（默认 https://121.36.38.180）
 *   PANEL_CA_PEM      覆盖内置的自签 CA（一般不用，换证书时才需要；换行写成 \n）
 *   PANEL_INSECURE=1  **仅应急**：跳过 TLS 证书校验（会失去防中间人能力）
 *   WX_SUB_TEMPLATE_ID（订阅消息模板 ID，见下方「微信订阅消息」段）
 *
 * [20261009] 面板已启用 HTTPS（443，自签证书，SAN 含 IP）：
 *   原来走 http://121.36.38.180:8123 —— 用户的面板密码与 X-Panel-Token 全程在
 *   公网明文传输，链路中间任何人（运营商 / 机房 / 公共 WiFi）都能直接抓走，
 *   拿到 token 就等于拿到面板。现在改走 HTTPS，并把自签 CA **内置进本函数**
 *   做证书固定（pinning）：既防窃听、也防主动中间人。
 *   旧端口 8123 仍保留给人类浏览器；要回滚只需把 PANEL_BASE 改回 http 并重部署。
 *
 * 另外它还兼了一个角色：**微信服务通知的发送方（日报推送）**。
 *   面板原有的推送通道（WxPusher 等）长期卡在微信侧下发不出来，
 *   所以日报改走微信原生的订阅消息：定时触发器每天两次（09:00 / 18:00，
 *   与面板日报 cron 同一时刻）拉一次该用户在面板上可见的 `/api/daily-report`，
 *   把「今日日报摘要 + 待处理条数」用 cloud.openapi.subscribeMessage 发出去，
 *   点开直接落到小程序的日报页。不依赖任何第三方推送服务。
 *
 *   触发器 Cron：`0 0 9,18 * * * *`（云开发控制台 → 云函数 → 触发器）
 */
const cloud = require('wx-server-sdk')
const http = require('http')
const https = require('https')
const { URL } = require('url')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const SESS_COLLECTION = 'panel_sessions'

const PANEL_BASE = (process.env.PANEL_BASE || 'https://121.36.38.180').replace(/\/+$/, '')

/**
 * 面板自签 CA（证书固定 / pinning）。
 * 服务器上的对应文件是 /etc/nginx/ssl/panel-ca.crt，有效期至 2036-10-06。
 * 换证书后必须同步更新这里（或用环境变量 PANEL_CA_PEM 覆盖，换行写成 \n）。
 *
 * 为什么不干脆 rejectUnauthorized=false：那只能防「被动窃听」，
 * 挡不住「主动中间人」（攻击者自己签一张同名证书，浏览器/客户端照样接受）。
 * 固定 CA 才能同时防住两类攻击。
 */
const PANEL_CA_PEM = process.env.PANEL_CA_PEM
  ? String(process.env.PANEL_CA_PEM).replace(/\\n/g, '\n')
  : `-----BEGIN CERTIFICATE-----
MIIFfzCCA2egAwIBAgIUPa7nCsy+VplprdSiYK6x7QA8J8QwDQYJKoZIhvcNAQEL
BQAwTzELMAkGA1UEBhMCQ04xGDAWBgNVBAoMD0RvdVlpblNwYXJrRmxvdzEmMCQG
A1UEAwwdRG91WWluU3BhcmtGbG93IFBhbmVsIFJvb3QgQ0EwHhcNMjYxMDA5MTUy
MjI1WhcNMzYxMDA2MTUyMjI1WjBPMQswCQYDVQQGEwJDTjEYMBYGA1UECgwPRG91
WWluU3BhcmtGbG93MSYwJAYDVQQDDB1Eb3VZaW5TcGFya0Zsb3cgUGFuZWwgUm9v
dCBDQTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAO3n27bd1cGjPZ36
7qU8H18Z2NEDE2nsknwo2d+lOKtusRN+mjO6m7zFZgqv1s67S1EXn8CDerH4f20i
dKOql8QV9R4W8yv6ya9ELVmEq3LxmeLyC7QvluO1AAbH6vbYFoddTuk4lSoqoCyr
Y8p2YNU+LMndbwT1CV4T+Dh/JUuN/Uhppebq+wzsGFPkeBGqB+k+XjfH7MIqM+gn
bm5eSxTSaFvysSvS0VpcIErbxsxQmm9Nbx+LkcM5cGA6q310obSGNgNTbhSgmFf6
C0ssNPEXVzjpWiwI/xdN7fg5T5oeksqDLJc6J88CEhdLEw4GZGavRDdmqI3Bz6YB
jLE8IqPEGQbrwHAzDet8fZfpB3VDciGOwy4TFzqhvUGq84l31tQog+GRMBkW05qv
h+bTWPJhIBy+9UfrS9jnHXJisJmzJoov8yEyXphIcg85c7kYgCoM44G0qZTog8xN
ddQAuAi0tB+dzppA/kseCxNtvcBJ2d/wK6bMGuV6dE/D0Ddnq27gMaZikpPSDAXL
IFa1AQAyxc1YfUxWzcmaCS5/CgdJrCrX8suD8r17I6IK00+I7/rK2+XrwJMvqZWp
NyB7YOmomB1X0I6VxHrPqlmgd6VJSTchhpQtmA8KjaZhp+0ah6X97tF2hDVA8Xhf
Txhh7FnP+puEACcup/o8iEiZC0g9AgMBAAGjUzBRMB0GA1UdDgQWBBTJBx2ZZKEK
VcGlZZn4vBhBHRpExDAfBgNVHSMEGDAWgBTJBx2ZZKEKVcGlZZn4vBhBHRpExDAP
BgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4ICAQABjLMJR0XY11pv0JGD
hSP6DzfouAKqkLspX6+uqjGFP6mlacsd5V+9ooexQeDKjMWsNM9cIIJwBL73zoYr
KT6w8zhCDio6VOBNf2cTb8KgH9U9CqDfjyw4a2iYNUleBTy2D0P+FtjN/x6leh0x
CQSSrDU0leVNkzUeUhWcnFuOvs8tF3fbTXxI02PEITDpSzJNn3vkh+S5ERumDQb8
i5PS6zHc/OGqSltvmxGamH30grQWQeUz4bNYoQGGs7SWbV3TXTQl+L44/jqY8OcD
r+2abO2fy3cRRgv8uMsZ2q22/iUU5yNrEZdGd/18XzdAl3r9AE2MV6ygZFiRYWCx
hl3B4v0l1y1jYFFYOH7FhSkKW35zhdG8JcFRLPpBNHep6Wta9OjWvMnMQrib3fAD
AsRm6ld/c3pCXZ9KAUjd+WVvE0RMiABDlPoB2ZFcRRNE6s9avagIbf5GRues/whv
rCeibhnZOfBoVvCVWEnJMkOm3OnuAZPxM9HUxsT2GOLN/mYDy9NxDc+CwrMQ6Jk8
fd8c0OGdFgwcKAa4bzmfotZeRBf8uuTmO18+qd+7A0zfykutoNEC/RoQajox2LLT
uY6BrC6f36h8IunUBTbT84iOW5Hv3q5KIKcZfpmCQcpWElmlRy5KuV2GZPnKQA30
WXwG4mnlBXSXyB6u3HWoMuFZUQ==
-----END CERTIFICATE-----`

/**
 * [20261007] 面板侧会话已改成「30 天 + 滑动续期（用一次续 30 天）」。
 * 这里必须**跟面板对齐**：原来写 20h（比面板的 24h 还短），结果是云函数比面板
 * 更早把用户判定成「登录已过期」并 dropSession —— 小程序每 20 小时就得重登一次，
 * 而面板其实还认这张票。现在两边同窗口、同滑动策略，云函数只做粗筛，
 * 真正的权威判定交给面板返回的 401。
 */
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000

/** 只允许转发这些前缀，杜绝 SSRF（云函数出口不受限，必须自己把关） */
const ALLOW_PREFIX = ['/api/', '/data/avatars/', '/shots/', '/manifest.json']

/** 允许透传的方法 */
const ALLOW_METHOD = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

// ── 微信订阅消息（小程序「服务通知」· 日报推送）────────────────────
/**
 * 这是唯一「微信自带」的推送通道：不依赖第三方服务、不用关注公众号、不用备案域名。
 * 面板原有通道（WxPusher 等）长期卡在微信侧下发不出来，所以日报改由这里发。
 *
 * 触发节奏：**每天两次，09:00 / 18:00**，与面板日报（cron 9:00 / 18:00）同一时刻。
 *          触发器在云开发控制台建：Cron `0 0 9,18 * * * *`
 * 推送内容：该用户在面板上可见的 /api/daily-report 摘要 + 待处理条数，
 *          点开直接落到小程序的日报页。
 *
 * 注意：订阅消息是「一次性」的 —— 用户授权 1 次只能下发 1 条，
 *      所以这里维护 grants（剩余可下发条数），用完提示用户再点一次授权。
 *      一天两条，额度消耗较快，推送页有「补充额度」按钮。
 */
const SUB_TEMPLATE_ID = (
  process.env.WX_SUB_TEMPLATE_ID || 'T8Kyq6S-JYrX8Atz8MZ89mzx2v3ACXG-CLITj1428go'
).trim()

/** 点开服务通知后落在哪一页（日报页，能看到完整报告） */
const SUB_PAGE = process.env.WX_SUB_PAGE || 'pages/daily/daily'

/**
 * 点开服务通知后跳到小程序的哪个版本：
 *   developer=开发版（开发者工具「预览」扫码打开的版本）
 *   trial=体验版   formal=正式版
 * 小程序尚未发布正式版时用 formal 会直接下发失败。
 *
 * ⚠️ 这个值必须和「用户实际在用的版本」一致：
 *   用户是在体验版里点的订阅 → 下发必须声明 trial，写 developer 会投递失败
 *   （报 user not visit the miniprogram 之类）。所以在体验版里使用时别用默认值。
 * 当前默认 **trial（体验版）** —— 因为体验版是长期使用方式。
 * 想切回开发版调试：控制台 → 云函数 → 配置 → 环境变量 WX_SUB_STATE=developer
 * 以后发布正式版：同样方式设为 formal。
 */
const SUB_STATE = process.env.WX_SUB_STATE || 'trial'

/** 万一 miniprogramState 与小程序实际状态不匹配，按这个顺序自上而下重试 */
const SUB_STATE_FALLBACK = ['trial', 'developer', 'formal']

/** 每天推送的时段（仅用于展示与文案，真正的触发由云开发触发器决定） */
const SUB_SLOTS = [9, 18]

/**
 * 模板字段映射。左边是我们提供的值，右边是模板里的字段名。
 *   title  —— 主文案，如「日报10-04 待处理5项」
 *   detail —— 明细，如「⛔song 无火花1个：王骞」（模板没有第二个文本字段就留空）
 *   time   —— 时间
 * 模板字段名因模板而异，按申请到的模板改；也可用环境变量 WX_SUB_FIELDS 传 JSON，
 * 例如 {"title":"thing1","detail":"thing2","time":"time3"}
 */
let SUB_FIELDS = { title: 'thing1', detail: '', time: 'thing2' }
try {
  if (process.env.WX_SUB_FIELDS) SUB_FIELDS = JSON.parse(process.env.WX_SUB_FIELDS)
} catch (e) {
  /* 写错就用默认 */
}

/**
 * 模板字段名没法程序化查询（小程序 openapi 不提供模板详情接口），但**微信的报错会点名**：
 *
 *   argument invalid!data.thing5.value is empty      ← 模板有 thing5 且必填，我们没给值
 *   argument invalid!data.thing1.value is not exist  ← 模板没有 thing1，我们多给了
 *
 * 而**失败的下发不消耗授权额度**，所以「按报错逐个补 / 删字段」就能把模板的真实字段集试出来。
 * 注意字段编号可以不连续（实测撞到过 thing5），不能按 1..N 去猜。
 */

/** 统一取错误文案（云调用的错误对象形状不固定） */
function errMsgOf(e) {
  return String((e && e.errMsg) || (e && e.message) || e || '')
}

/** 从微信报错里抠出被点名的字段，以及是「缺值」还是「多给了」 */
function fieldHint(msg) {
  const m = String(msg || '').match(/data\.([A-Za-z0-9_]+)/i)
  if (!m) return null
  return {
    key: m[1],
    empty: /empty|为空/i.test(msg),
    gone: /not\s*exist|不存在|no\s*such|invalid\s*field/i.test(msg),
  }
}

/** 字段名去掉编号后的类型前缀，决定该塞什么格式的值 */
function fieldKind(key) {
  const k = String(key).replace(/[0-9]+$/, '').toLowerCase()
  if (k === 'time' || k === 'date') return 'time'
  if (k === 'amount' || k === 'number') return 'num'
  if (k === 'phrase') return 'phrase'
  return 'text'
}

/** 字段编号，用于排序（thing1 排在 thing10 前面） */
function fieldNo(key) {
  const m = String(key).match(/([0-9]+)$/)
  return m ? parseInt(m[1], 10) : 0
}

/**
 * 按「目前已知的字段集」统一分配值：编号小的先拿主文案，时间类字段拿时间。
 * **每一轮重试都重新分配一次** —— 所以最后成功那轮的值一定是按编号有序分好的，
 * 不会出现「先发现 thing5 就先把主文案塞给它、后来才补上 thing1」这种错位。
 */
function buildAdaptiveData(keys, vals) {
  const sorted = keys.slice().sort(function (a, b) {
    const na = fieldNo(a)
    const nb = fieldNo(b)
    if (na !== nb) return na - nb
    return a < b ? -1 : 1
  })
  const pool = [vals.title, vals.detail, vals.stat].filter(function (s) {
    return !!s
  })
  const roles = {}
  const data = {}
  let ti = 0
  sorted.forEach(function (k) {
    const kind = fieldKind(k)
    let role
    let v
    if (kind === 'time') {
      role = 'time'
      v = vals.time
    } else if (kind === 'num') {
      role = 'num'
      v = String(vals.num != null ? vals.num : 0)
    } else {
      role = ti === 0 ? 'title' : ti === 1 ? 'detail' : 'stat'
      v = pool[ti] || vals.title
      ti++
    }
    if (!v) return
    if (kind === 'phrase') v = clip(v, 5)
    else if (kind === 'text') v = clip(v, 20)
    data[k] = { value: v }
    roles[k] = role
  })
  return { data: data, roles: roles }
}

/** 把「字段名 → 角色」翻回 SUB_FIELDS 的形状，下次就能一次命中 */
function fieldsFromRoles(roles) {
  const f = { title: '', detail: '', stat: '', time: '' }
  Object.keys(roles).forEach(function (k) {
    const r = roles[k]
    if (r in f && !f[r]) f[r] = k
  })
  return f
}

/** 按报错调整字段集：缺值 → 补上；多给了 → 删掉 */
function applyHint(keys, h) {
  if (h.gone) {
    return keys.filter(function (k) {
      return k !== h.key
    })
  }
  const out = keys.slice()
  if (out.indexOf(h.key) < 0) out.push(h.key)
  return out
}

/**
 * 云函数容器的时区不保证是东八区，所有「几点」的判断都自己按 UTC+8 折算，
 * 否则触发器 09:00 跑、代码却可能算成凌晨 1 点，去重键与显示的日期都会错位。
 */
function bjParts(t) {
  const d = new Date((t || Date.now()) + 8 * 3600 * 1000)
  const p = function (n) {
    return n < 10 ? '0' + n : '' + n
  }
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    H: d.getUTCHours(),
    M: d.getUTCMinutes(),
    mmdd: p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()),
    hm: p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()),
  }
}

/** 订阅消息的 thing 字段限 20 字，统一截断 */
function clip(s, n) {
  const t = String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

/** 订阅消息的 time 字段要「年月日+时分」这种格式（按北京时间） */
function timeText(t) {
  const P = bjParts(t)
  return P.y + '年' + P.m + '月' + P.d + '日 ' + P.hm
}

/** 组装订阅消息 data；空值字段直接不发，否则微信会拒收整条 */
function buildSubData(vals, fields) {
  const map = fields || SUB_FIELDS
  const data = {}
  Object.keys(map).forEach(function (kind) {
    const key = map[kind]
    if (!key) return
    const v = kind === 'time' ? vals.time : clip(vals[kind] || '', 20)
    if (!v) return
    data[key] = { value: v }
  })
  return data
}

/** 微信报的错值不值得换个字段组合重试（字段名/格式问题 vs 用户没订阅） */
function isFieldError(msg) {
  return /47003|argument invalid|invalid data|data\.[a-z0-9_]+|param|参数/i.test(msg)
}

/** 微信报的错是不是「小程序版本状态」问题（换 developer/trial/formal 再试） */
function isStateError(msg) {
  return /miniprogram.?state|not online|未发布|invalid.*state/i.test(msg)
}

/** 发一次（内置版本状态降级）；字段不对会直接抛给上层，由上层去补字段 */
async function rawSend(openid, data, states) {
  let lastErr = null
  for (let si = 0; si < states.length; si++) {
    try {
      await cloud.openapi.subscribeMessage.send({
        touser: openid,
        templateId: SUB_TEMPLATE_ID,
        page: SUB_PAGE,
        lang: 'zh_CN',
        miniprogramState: states[si],
        data: data,
      })
      if (si > 0) console.log('[subMsg] 小程序版本状态纠正为 ' + states[si])
      return { state: states[si] }
    } catch (e) {
      lastErr = e
      // 只有「版本状态」问题才值得换状态；字段错 / 用户没订阅都直接抛
      if (!isStateError(errMsgOf(e))) throw e
    }
  }
  throw lastErr || new Error('订阅消息下发失败')
}

/**
 * 真正下发一条订阅消息（云调用，用的是小程序自己的身份，不需要 AppSecret）。
 *
 * 两步走：
 *   1. 先按已知字段映射发一次 —— 已经学对了的话只花一次调用；
 *   2. 失败就进入「按报错补字段」的自适应循环：微信每次点名一个字段，
 *      缺就补、多就删，**每轮重新按编号分配值**（所以不会先发现 thing5
 *      就把主文案塞给它）。失败的下发不消耗额度，这一步零成本，
 *      以后撞到新模板也能自己长出来。
 */
async function sendSubMsg(openid, vals) {
  const states = [SUB_STATE].concat(
    SUB_STATE_FALLBACK.filter(function (s) {
      return s !== SUB_STATE
    })
  )

  // 第 1 步：已知映射快路径
  const first = buildSubData(vals, SUB_FIELDS)
  let keys = Object.keys(first)
  let lastErr = null
  if (keys.length) {
    try {
      const r = await rawSend(openid, first, states)
      return { fields: SUB_FIELDS, state: r.state, guessed: false }
    } catch (e) {
      lastErr = e
      if (!isFieldError(errMsgOf(e))) throw e
      const h = fieldHint(errMsgOf(e))
      if (h) keys = applyHint(keys, h)
    }
  }

  // 第 2 步：按微信报错逐个补 / 删字段，直到发出去
  for (let i = 0; i < 12; i++) {
    const built = buildAdaptiveData(keys, vals)
    if (!Object.keys(built.data).length) break
    try {
      const r = await rawSend(openid, built.data, states)
      SUB_FIELDS = fieldsFromRoles(built.roles)
      console.log('[subMsg] 自适应字段映射 = ' + JSON.stringify(SUB_FIELDS))
      return { fields: SUB_FIELDS, state: r.state, guessed: true }
    } catch (e) {
      lastErr = e
      const msg = errMsgOf(e)
      if (!isFieldError(msg)) throw e
      const h = fieldHint(msg)
      if (!h) throw e
      const next = applyHint(keys, h)
      // 补过 / 删过还是同一个字段 → 不是「字段集不对」，别再空转
      if (next.join(',') === keys.join(',')) throw e
      keys = next
    }
  }
  throw lastErr || new Error('订阅消息下发失败')
}

/**
 * 把面板日报折成订阅消息装得下的短文案。
 * thing 字段只有 20 字，塞不下整篇日报，所以主文案是「摘要 + 待处理条数」，
 * 明细放第一条待处理项；点开后在小程序日报页看全量。
 */
function buildDailyVals(rep) {
  const s = (rep && rep.summary) || {}
  const issues = (rep && rep.issues) || []
  const n = Number(s.issues != null ? s.issues : issues.length) || 0
  const sent = Number(s.sent_ok || 0)
  const total = Number(s.sent_total || 0)

  // 日期优先取面板自己给的（已经是北京时间），拿不到才回落到本机折算
  const m = String((rep && rep.generated) || '').match(/\d{2}-\d{2}/)
  const mmdd = m ? m[0] : bjParts(Date.now()).mmdd

  const title = n > 0 ? '日报' + mmdd + ' 待处理' + n + '项' : '日报' + mmdd + ' 一切正常'

  let detail = ''
  if (n > 0) {
    for (let i = 0; i < issues.length; i++) {
      if (issues[i] && issues[i].text) {
        detail = issues[i].text
        break
      }
    }
    if (!detail) detail = '发送 ' + sent + '/' + total + '，有 ' + n + ' 项待处理'
  } else {
    detail = '发送 ' + sent + '/' + total + '，全部正常'
  }

  return {
    title: clip(title, 20),
    detail: clip(detail, 20),
    // 模板字段多于两个时，多出来的字段用这条统计兜底 —— 不能留空，空值会被整条拒收
    stat: clip('发送 ' + sent + '/' + total + '，待处理 ' + n + ' 项', 20),
    num: n,
    time: timeText(Date.now()),
  }
}

// ── 通用 HTTP 请求封装 ────────────────────────────────────────────
function request(method, path, opts) {
  opts = opts || {}
  const timeout = opts.timeout || 25000
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(PANEL_BASE + path)
    } catch (e) {
      return reject(new Error('面板地址拼接失败: ' + path))
    }
    const mod = u.protocol === 'https:' ? https : http
    const payload =
      opts.body === undefined || opts.body === null
        ? null
        : Buffer.from(JSON.stringify(opts.body), 'utf8')

    const headers = { Accept: opts.raw ? '*/*' : 'application/json' }
    if (payload) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = payload.length
    }
    if (opts.token) headers['X-Panel-Token'] = opts.token

    const isHttps = u.protocol === 'https:'
    const reqOpts = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: method,
      headers: headers,
      timeout: timeout,
    }
    if (isHttps) {
      // 证书固定：只信任内置的那张自签 CA（防中间人）。
      // PANEL_INSECURE=1 是应急逃生口，正常部署不要打开。
      if (process.env.PANEL_INSECURE === '1') {
        reqOpts.rejectUnauthorized = false
      } else if (PANEL_CA_PEM) {
        reqOpts.ca = PANEL_CA_PEM
      }
    }

    const req = mod.request(
      reqOpts,
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          if (opts.raw) {
            return resolve({ status: res.statusCode, headers: res.headers, buffer: buf })
          }
          const text = buf.toString('utf8')
          let json = null
          try {
            json = JSON.parse(text)
          } catch (e) {
            /* 非 JSON 响应（HTML 错误页等）保留文本 */
          }
          resolve({ status: res.statusCode, text: text, json: json })
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('面板响应超时（' + timeout + 'ms）')))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

// ── 会话存取（云数据库） ──────────────────────────────────────────
/**
 * 集合自举：云函数用的是管理员身份，可以自己建集合。
 * 这样部署完不用再去控制台手动新建 panel_sessions。
 * 只在第一次调用时真正尝试，结果缓存在模块级变量里（函数实例复用）。
 */
let _collState = 0 // 0=未尝试 1=就绪 2=失败
let _collErr = ''
async function ensureCollection() {
  if (_collState || typeof db.createCollection !== 'function') return
  try {
    await db.createCollection(SESS_COLLECTION)
    _collState = 1
  } catch (e) {
    const msg = String((e && e.message) || e)
    // 「已存在」等于成功
    if (/exist|已存在|-501001|ResourceUnavailable/i.test(msg)) {
      _collState = 1
    } else {
      _collState = 2
      _collErr = msg
    }
  }
}

async function getSession(openid) {
  await ensureCollection()
  try {
    const r = await db
      .collection(SESS_COLLECTION)
      .where({ _openid: openid })
      .limit(1)
      .get()
    return r.data[0] || null
  } catch (e) {
    // 集合不存在时按「无会话」处理，并在下面返回可读提示
    if (/not exist|不存在|DATABASE_COLLECTION_NOT_EXIST/i.test(String(e.message || e))) {
      const err = new Error(
        '数据库集合 panel_sessions 尚未创建' +
          (_collErr ? '（自动创建失败：' + _collErr + '）' : '')
      )
      err.code = 'NO_COLLECTION'
      throw err
    }
    throw e
  }
}

async function saveSession(openid, info) {
  const cur = await getSession(openid)
  const doc = Object.assign({}, info, { updatedAt: Date.now() })
  if (cur) {
    await db.collection(SESS_COLLECTION).doc(cur._id).update({ data: doc })
  } else {
    // 云函数内写入需手动补 _openid（小程序端写入才会自动带）
    await db.collection(SESS_COLLECTION).add({ data: Object.assign({ _openid: openid }, doc) })
  }
}

async function dropSession(openid) {
  const cur = await getSession(openid)
  if (cur) await db.collection(SESS_COLLECTION).doc(cur._id).remove()
}

/** 按文档 id 局部更新（update 只改传进去的字段，其余保留） */
async function patchDoc(id, patch) {
  await db
    .collection(SESS_COLLECTION)
    .doc(id)
    .update({ data: Object.assign({}, patch, { updatedAt: Date.now() }) })
}

async function patchSession(openid, patch) {
  const cur = await getSession(openid)
  if (!cur) return false
  await patchDoc(cur._id, patch)
  return true
}

/**
 * [20261007] 滑动续期：与面板侧同策略 —— 剩余有效期不足一半时才往后推满额。
 * 因为只在「用得到」的时候才写库，常态请求不会多打一次数据库；
 * 又因为每次成功使用都会续，实际效果是「只要还在用，就永远不用重新登录」。
 * 同时把内存里的 sess.expire 一起改掉，好让 publicSession() 返回正确的到期时间。
 * 续期失败（数据库抖动）不影响本次请求。
 */
async function maybeRenew(openid, sess) {
  try {
    const exp = Number(sess && sess.expire) || 0
    if (exp && exp - Date.now() > SESSION_TTL / 2) return exp
    const next = Date.now() + SESSION_TTL
    await patchSession(openid, { expire: next })
    if (sess) sess.expire = next
    return next
  } catch (e) {
    return Number(sess && sess.expire) || 0
  }
}

// ── 结果封装 ─────────────────────────────────────────────────────
function ok(data) {
  return Object.assign({ ok: true }, data || {})
}
function err(code, message, extra) {
  return Object.assign({ ok: false, code: code, error: message }, extra || {})
}
function publicSession(s) {
  return {
    username: s.username,
    isAdmin: !!s.isAdmin,
    accountUids: s.accountUids || [],
    expire: s.expire || 0,
  }
}

function pathAllowed(path) {
  if (typeof path !== 'string' || !path) return false
  if (/^https?:\/\//i.test(path)) return false // 禁止绝对地址
  // [修复20261005] 只做前缀白名单挡不住「/api/../xxx」——URL 规范化后仍会通过前缀校验，
  // 拼到面板上就是一个任意路径读。这里直接拒掉 .. 和换行/空字节。
  if (path.indexOf('..') >= 0) return false
  if (/[\u0000\r\n]/.test(path)) return false
  return ALLOW_PREFIX.some((p) => path.indexOf(p) === 0)
}

// ── 业务动作 ─────────────────────────────────────────────────────
async function doLogin(openid, event) {
  const username = String(event.username || '').trim()
  const password = String(event.password || '')
  if (!username || !password) return err('BAD_PARAM', '请填写用户名和密码')

  const r = await request('POST', '/api/login', { body: { username: username, password: password } })
  if (!r.json || r.json.ok !== true || !r.json.token) {
    const msg =
      (r.json && (r.json.error || r.json.message)) ||
      (r.status === 401 ? '用户名或密码错误' : '面板返回异常（HTTP ' + r.status + '）')
    return err('LOGIN_FAIL', msg)
  }

  const info = {
    username: r.json.username || username,
    panelToken: r.json.token,
    isAdmin: !!r.json.is_admin,
    accountUids: r.json.account_uids || [],
    noAccount: !!r.json.no_account,
    expire: Date.now() + SESSION_TTL,
  }
  await saveSession(openid, info)
  return ok({ session: publicSession(info) })
}

async function doLogout(openid) {
  const sess = await getSession(openid)
  if (sess && sess.panelToken) {
    try {
      await request('POST', '/api/logout', { token: sess.panelToken })
    } catch (e) {
      /* 面板侧登出失败不影响本地清会话 */
    }
  }
  await dropSession(openid)
  return ok({ loggedOut: true })
}

/**
 * 统一转发入口。
 * 小程序调用形如：
 *   wx.cloud.callFunction({ name:'panelApi', data:{
 *     action:'call', path:'/api/overview?account=51453612443', method:'GET'
 *   }})
 */
async function doCall(openid, event) {
  const path = event.path
  const method = String(event.method || 'GET').toUpperCase()
  if (!pathAllowed(path)) return err('FORBIDDEN_PATH', '不允许访问的路径')
  if (ALLOW_METHOD.indexOf(method) < 0) return err('FORBIDDEN_METHOD', '不支持的请求方法')

  const sess = await getSession(openid)
  if (!sess || !sess.panelToken) return err('NEED_LOGIN', '请先登录')
  if (sess.expire && Date.now() > sess.expire) {
    await dropSession(openid)
    return err('NEED_LOGIN', '登录已过期，请重新登录')
  }

  // [20261007] 会话仍在被使用 → 滑动续期。放在请求前是为了覆盖本函数的全部分支；
  // 若这张票面板其实已不认，下面的 401 分支会 dropSession，续期自然作废，不会造成脏状态。
  await maybeRenew(openid, sess)

  const r = await request(method, path, {
    body: event.body,
    token: sess.panelToken,
    timeout: event.timeout || 25000,
  })

  // 面板判定未登录/令牌失效 → 统一收敛成 NEED_LOGIN
  if (r.status === 401) {
    await dropSession(openid)
    return err('NEED_LOGIN', '登录已过期，请重新登录')
  }
  if (r.json && r.json.ok === false) {
    const m = String(r.json.error || r.json.message || '')
    if (/未登录|未授权|unauthorized|token.*(失效|过期)|请重新登录/i.test(m)) {
      await dropSession(openid)
      return err('NEED_LOGIN', '登录已过期，请重新登录')
    }
    // [修复20261005] 以前这里不返回、直接落到下面的 ok:true —— 于是「无权操作该账号(403)」
    // 「该好友已在名单中(409)」「参数错误(400)」「面板 502」全被当成成功：
    // 读接口显示成「0 条数据」，写接口还会弹「已保存/已加入名单」。现在如实上报，
    // 小程序 api.js 收到 ok:false 就抛错，页面 catch 后把面板原文案显示给用户。
    return err('PANEL_ERR', m || '面板返回 HTTP ' + r.status, {
      status: r.status,
      data: r.json,
    })
  }
  // 非 JSON 响应（HTML 错误页、网关 502/504 页）也不能当成功，否则前端拿到的
  // 是一个字符串，`d.friends || []` 全是空 —— 同样是静默失败。
  if (r.json === null && r.status >= 400) {
    const plain = String(r.text || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
    return err('PANEL_HTTP', '面板返回 HTTP ' + r.status + (plain ? '：' + plain : ''), {
      status: r.status,
    })
  }

  return ok({
    status: r.status,
    data: r.json !== null ? r.json : r.text,
  })
}

/**
 * 取面板上的静态资源（本地头像、截图），以 base64 返回。
 * 只在面板头像不是 https CDN 地址时使用（小程序 <image> 无法直接加载 http 资源）。
 *
 * [修复20261005] 两处改动：
 *   1) 面板返回 401（会话过期）时以前给的是 ASSET_FAIL —— 小程序只会静默降级成
 *      首字母头像，永远不提示重新登录，重登后也恢复不了。现在统一走 NEED_LOGIN。
 *   2) 头像是一个一个取的（每张还要查一次云数据库会话）——一屏十几个头像就是十几次
 *      云函数调用。现在加了进程内缓存 + 批量接口（见 doAssets）。
 */
const ASSET_CACHE = new Map()
const ASSET_CACHE_MAX = 200

/** 取一张图并编码成 dataUrl；返回值里 err 字段表示失败原因 */
async function fetchAsset(path, token) {
  if (ASSET_CACHE.has(path)) return ASSET_CACHE.get(path)
  let out
  try {
    const r = await request('GET', path, { token: token, raw: true, timeout: 15000 })
    if (r.status === 401) {
      out = { err: 'NEED_LOGIN' }
    } else if (r.status !== 200) {
      out = { err: 'ASSET_FAIL', msg: '资源不存在（HTTP ' + r.status + '）' }
    } else if (r.buffer.length > 700 * 1024) {
      out = { err: 'ASSET_TOO_BIG', msg: '资源过大' }
    } else {
      const ct = (r.headers && r.headers['content-type']) || 'image/jpeg'
      out = {
        dataUrl: 'data:' + ct + ';base64,' + r.buffer.toString('base64'),
        size: r.buffer.length,
      }
    }
  } catch (e) {
    out = { err: 'ASSET_FAIL', msg: String((e && e.message) || e) }
  }
  // 只缓存成功结果 —— 失败（尤其是 401）缓存下来会让重登后的头像永远出不来
  if (out.dataUrl) {
    if (ASSET_CACHE.size >= ASSET_CACHE_MAX) {
      const oldest = ASSET_CACHE.keys().next().value
      ASSET_CACHE.delete(oldest)
    }
    ASSET_CACHE.set(path, out)
  }
  return out
}

async function doAsset(openid, event) {
  const path = event.path
  if (!pathAllowed(path)) return err('FORBIDDEN_PATH', '不允许访问的路径')

  const sess = await getSession(openid)
  if (!sess || !sess.panelToken) return err('NEED_LOGIN', '请先登录')

  await maybeRenew(openid, sess)   // [20261007] 取头像也算「在用」，顺手续期
  const r = await fetchAsset(path, sess.panelToken)
  if (r.err === 'NEED_LOGIN') {
    await dropSession(openid)
    return err('NEED_LOGIN', '登录已过期，请重新登录')
  }
  if (r.err) return err(r.err, r.msg || '资源获取失败')
  return ok({ dataUrl: r.dataUrl, size: r.size })
}

/**
 * 批量取图（头像列表专用）：一次调用拿回多张，只查一次会话。
 * 并发发起（头像都很小，几张到几十张没有压力），整包体积兜底 2MB
 * —— 云函数返回值不能无限大，超了就只返回前面的几张，剩下的下次再取。
 */
async function doAssets(openid, event) {
  const raw = Array.isArray(event.paths) ? event.paths : []
  const paths = []
  raw.forEach(function (p) {
    if (typeof p === 'string' && p && paths.indexOf(p) < 0) paths.push(p)
  })
  if (!paths.length) return ok({ items: {} })
  if (paths.length > 30) paths.length = 30
  for (let i = 0; i < paths.length; i++) {
    if (!pathAllowed(paths[i])) return err('FORBIDDEN_PATH', '不允许访问的路径')
  }

  const sess = await getSession(openid)
  if (!sess || !sess.panelToken) return err('NEED_LOGIN', '请先登录')

  await maybeRenew(openid, sess)   // [20261007] 批量取头像同样顺手续期
  const token = sess.panelToken
  const results = await Promise.all(
    paths.map(function (p) {
      return fetchAsset(p, token)
    })
  )

  let needLogin = false
  const items = {}
  let total = 0
  for (let i = 0; i < paths.length; i++) {
    const r = results[i]
    if (r && r.err === 'NEED_LOGIN') {
      needLogin = true
      break
    }
    if (!r || !r.dataUrl) continue
    if (total + r.dataUrl.length > 2 * 1024 * 1024) break
    total += r.dataUrl.length
    items[paths[i]] = r.dataUrl
  }
  if (needLogin) {
    await dropSession(openid)
    return err('NEED_LOGIN', '登录已过期，请重新登录')
  }
  return ok({ items: items, size: total })
}

/** 当前登录态（小程序启动时调用，决定是否直接进主页） */
async function doProfile(openid) {
  const sess = await getSession(openid)
  if (!sess || !sess.panelToken) return ok({ loggedIn: false })
  if (sess.expire && Date.now() > sess.expire) {
    await dropSession(openid)
    return ok({ loggedIn: false })
  }
  // [20261007] 冷启动恢复登录态时顺手续期 —— 小程序「不用反复登录」的关键就是这条
  await maybeRenew(openid, sess)
  return ok({ loggedIn: true, session: publicSession(sess) })
}

// ── 微信订阅消息业务 ──────────────────────────────────────────────
function subPublic(sess) {
  const sub = (sess && sess.wxSub) || {}
  return {
    configured: !!SUB_TEMPLATE_ID,
    templateId: SUB_TEMPLATE_ID,
    enabled: !!sub.enabled,
    grants: Number(sub.grants || 0),
    needRenew: !!sub.needRenew,
    lastSent: Number(sub.lastSentTs || 0),
    lastTitle: sub.lastTitle || '',
    lastDetail: sub.lastDetail || '',
    lastErr: sub.lastErr || '',
    /** 上一次成功推送命中的时段键 YYYY-MM-DD#HH；用于判断「今天这趟发过没」 */
    lastSlot: sub.lastDailySlot || '',
    page: SUB_PAGE,
    /** 每天推送时段（小时，24 制）——前端据此显示「每天 09:00 / 18:00」 */
    slots: SUB_SLOTS,
    /** 当前下发的小程序版本状态（developer/trial/formal） */
    state: SUB_STATE,
    /** 模板字段映射（诊断用，便于核对微信后台的模板字段名） */
    fields: SUB_FIELDS,
  }
}

async function doSubStatus(openid) {
  const sess = await getSession(openid)
  return ok({ sub: subPublic(sess) })
}

/** 用户在弹窗里点了「允许」→ 额度 +1（一次授权可下发 1 条） */
async function doSubGrant(openid, event) {
  const n = Math.max(1, Math.min(10, Number(event.count) || 1))
  const sess = await getSession(openid)
  if (!sess || !sess.panelToken) return err('NEED_LOGIN', '请先登录')
  const sub = Object.assign({}, sess.wxSub || {})
  sub.enabled = true
  sub.grants = Number(sub.grants || 0) + n
  sub.needRenew = false
  sub.lastErr = ''
  sub.grantedAt = Date.now()
  await patchDoc(sess._id, { wxSub: sub })
  return ok({ sub: subPublic(Object.assign({}, sess, { wxSub: sub })) })
}

async function doSubOff(openid) {
  const sess = await getSession(openid)
  if (!sess || !sess.panelToken) return err('NEED_LOGIN', '请先登录')
  const sub = Object.assign({}, sess.wxSub || {}, { enabled: false })
  await patchDoc(sess._id, { wxSub: sub })
  return ok({ sub: subPublic(Object.assign({}, sess, { wxSub: sub })) })
}

/**
 * 取该会话在面板上能看到的日报（结构化）。
 * sessions=0 跳过逐账号登录态校验（那一步最慢，冷缓存要十几秒），
 * 日报摘要和待处理清单都不依赖它。
 */
async function fetchDailyReport(token) {
  try {
    const r = await request('GET', '/api/daily-report?days=2&sessions=0', {
      token: token,
      timeout: 20000,
    })
    if (!r.json || r.json.ok === false) return null
    return r.json
  } catch (e) {
    return null
  }
}

/** 发送失败后的统一善后：识别「用户没订阅」这类硬失败 */
function absorbSendError(sub, e) {
  const msg = String((e && e.errMsg) || (e && e.message) || e)
  sub.lastErr = '推送失败：' + clip(msg, 120)
  if (/43101|refuse|not subscribed|user has not/i.test(msg)) {
    sub.grants = 0
    sub.needRenew = true
    sub.enabled = false
  }
  return msg
}

/** 发测试消息：用「当前真实日报」的内容格式发一条，带【测试】前缀便于区分 */
async function doSubTest(openid) {
  if (!SUB_TEMPLATE_ID) return err('SUB_NO_TPL', '还没有配置订阅消息模板 ID')
  const sess = await getSession(openid)
  if (!sess || !sess.panelToken) return err('NEED_LOGIN', '请先登录')
  const sub = Object.assign({}, sess.wxSub || {})
  if (!sub.enabled) return err('SUB_OFF', '请先点「开启」授权订阅')
  if (Number(sub.grants || 0) <= 0) return err('SUB_NO_QUOTA', '额度已用完，请先点「补充额度」')

  const rep = await fetchDailyReport(sess.panelToken)
  const vals = rep
    ? buildDailyVals(rep)
    : {
        title: '测试：日报通道已就绪',
        detail: '',
        stat: '测试发送',
        num: 0,
        time: timeText(Date.now()),
      }
  vals.title = clip('【测试】' + vals.title, 20)

  try {
    await sendSubMsg(openid, vals)
  } catch (e) {
    const msg = absorbSendError(sub, e)
    await patchDoc(sess._id, { wxSub: sub })
    return err('SUB_SEND_FAIL', msg)
  }
  sub.grants = Number(sub.grants || 0) - 1
  sub.needRenew = sub.grants <= 0
  sub.lastSentTs = Date.now()
  sub.lastTitle = vals.title
  sub.lastDetail = vals.detail
  sub.lastErr = ''
  await patchDoc(sess._id, { wxSub: sub })
  return ok({
    sub: subPublic(Object.assign({}, sess, { wxSub: sub })),
    vals: vals,
    fields: SUB_FIELDS,
  })
}

/** 预览「下一次定时推送会发出什么」，不消耗额度、不发送 */
async function doSubPreview(openid) {
  const sess = await getSession(openid)
  if (!sess || !sess.panelToken) return err('NEED_LOGIN', '请先登录')
  const sub = sess.wxSub || {}
  const rep = await fetchDailyReport(sess.panelToken)
  if (rep === null) return err('PANEL_FAIL', '读取面板日报失败')
  const vals = buildDailyVals(rep)
  return ok({
    vals: vals,
    issues: (rep.issues || []).slice(0, 10),
    summary: rep.summary || {},
    generated: rep.generated || '',
    page: SUB_PAGE,
    slots: SUB_SLOTS,
    grants: Number(sub.grants || 0),
  })
}

/**
 * 定时任务：**每天两次，09:00 / 18:00**（触发器 Cron `0 0 9,18 * * * *`），
 * 与面板日报 cron 同一时刻。逐个开了订阅的会话拉一次它可见的日报，
 * 发一条微信服务通知（日报摘要 + 待处理条数），并扣 1 条额度。
 *
 * 去重：同一天同一小时只发一次（触发器可能被重试/重复触发）。
 * 由定时触发器调用时没有 openid，event = { Type:'Timer', TriggerName, Time }。
 */
async function doNotifyTick(ev) {
  const diag = { at: Date.now(), tpl: !!SUB_TEMPLATE_ID, slot: '', scanned: 0, sent: 0, skipped: 0, failed: 0, notes: [] }
  if (!SUB_TEMPLATE_ID) {
    diag.notes.push('未配置订阅消息模板 ID，跳过')
    return ok(diag)
  }

  // 时段键按北京时间算：YYY-MM-DD#HH
  const tm = ev && ev.Time ? Date.parse(ev.Time) : NaN
  const P = bjParts(isNaN(tm) ? Date.now() : tm)
  const p2 = function (n) {
    return n < 10 ? '0' + n : '' + n
  }
  const slot = P.y + '-' + p2(P.m) + '-' + p2(P.d) + '#' + p2(P.H)
  diag.slot = slot

  await ensureCollection()
  let docs = []
  try {
    // [修复20261005] 原来只 limit(200) —— 会话超过 200 条之后，排在后面的人永远收不到
    // 推送，而且没有任何提示。云函数端单次上限是 1000，直接取全（会话量远到不了这个数）。
    const r = await db.collection(SESS_COLLECTION).limit(1000).get()
    docs = r.data || []
  } catch (e) {
    diag.notes.push('读取会话失败：' + String((e && e.message) || e))
    return ok(diag)
  }
  if (docs.length >= 1000) {
    diag.notes.push('会话数已达 1000 上限，本轮可能未覆盖全部用户')
  }

  /**
   * 时间预算：每个会话要「拉一次面板日报 + 发一条订阅消息」，串行下来一个人 1~2 秒。
   * 云函数最多跑 60 秒，所以到 45 秒就收手并记录剩余数量 —— 宁可少发几个，
   * 也不能整个函数被强杀（那样连日志都没有）。
   */
  const startedAt = Date.now()
  const BUDGET_MS = 45 * 1000
  let stopped = false

  for (let i = 0; i < docs.length; i++) {
    if (Date.now() - startedAt > BUDGET_MS) {
      stopped = true
      diag.notes.push('已达时间预算，本轮提前结束，剩余 ' + (docs.length - i) + ' 个会话未处理')
      break
    }
    const sess = docs[i]
    diag.scanned++
    const sub = Object.assign({}, sess.wxSub || {})
    if (!sub.enabled) {
      diag.skipped++
      continue
    }
    // 订阅消息的 touser 必须是 openid，老文档没存 _openid 就跳过
    if (!sess._openid || !sess.panelToken) {
      diag.skipped++
      continue
    }
    // 这个时段已经发过了（触发器重试 / 手动补跑）→ 不重复发、不重复扣额度
    if (sub.lastDailySlot === slot) {
      diag.skipped++
      continue
    }
    if (Number(sub.grants || 0) <= 0) {
      if (!sub.needRenew) {
        sub.needRenew = true
        await patchDoc(sess._id, { wxSub: sub }).catch(function () {})
      }
      diag.skipped++
      continue
    }

    try {
      const rep = await fetchDailyReport(sess.panelToken)
      if (rep === null) {
        diag.skipped++
        diag.notes.push((sess.username || sess._openid) + '：读日报失败')
        continue
      }

      const vals = buildDailyVals(rep)
      await sendSubMsg(sess._openid, vals)

      sub.grants = Number(sub.grants || 0) - 1
      sub.needRenew = sub.grants <= 0
      sub.lastDailySlot = slot
      sub.lastSentTs = Date.now()
      sub.lastTitle = vals.title
      sub.lastDetail = vals.detail
      sub.lastErr = ''
      await patchDoc(sess._id, { wxSub: sub })
      diag.sent++
    } catch (e) {
      const msg = absorbSendError(sub, e)
      await patchDoc(sess._id, { wxSub: sub }).catch(function () {})
      diag.failed++
      diag.notes.push(clip(msg, 120))
    }
  }
  diag.total = docs.length
  diag.stopped = stopped
  return ok(diag)
}

/** 手动触发定时任务（仅管理员，便于调试） */
async function isAdmin(openid) {
  const s = await getSession(openid)
  return !!(s && s.isAdmin)
}

// ── 入口 ─────────────────────────────────────────────────────────
// 仅供本地联调 / 回归测试直接验证 HTTP 层（TLS 证书固定等）。云函数运行时不会用到。
exports._request = request

exports.main = async (event, context) => {
  const ev = event || {}

  let wxContext = {}
  try {
    wxContext = cloud.getWXContext() || {}
  } catch (e) {
    wxContext = {}
  }

  // 定时触发器调用时没有用户身份：event = { Type:'Timer'|'timer', TriggerName, Time }
  // 每天两次（Cron `0 0 9,18 * * * *`），与面板日报同时刻。
  // ⚠️ 判错的代价是「每天静默不发」，所以三重兜底：Type 大小写 / 调用来源 / TriggerName。
  const evType = String(ev.Type || ev.type || '').toLowerCase()
  const evSource = String(wxContext.SOURCE || '')
  if (evType === 'timer' || evSource === 'wx_trigger' || (!ev.action && !!ev.TriggerName)) {
    try {
      const diag = await doNotifyTick(ev)
      console.log('[notifyTick] ' + JSON.stringify(diag))
      return diag
    } catch (e) {
      return err('INTERNAL', String((e && e.message) || e))
    }
  }

  const openid = wxContext.OPENID
  const action = ev.action || 'ping'

  if (!openid) return err('NO_OPENID', '无法识别用户身份')

  try {
    switch (action) {
      case 'ping':
        // 顺手把集合建好（首次调用时真正执行，之后是空转）
        await ensureCollection()
        return ok({
          pong: true,
          collectionReady: _collState === 1,
          panelBase: PANEL_BASE,
          subTemplate: SUB_TEMPLATE_ID ? SUB_TEMPLATE_ID.slice(0, 8) + '…' : '',
          serverTime: Date.now(),
        })
      case 'login':
        return await doLogin(openid, ev)
      case 'logout':
        return await doLogout(openid)
      case 'profile':
        return await doProfile(openid)
      case 'call':
        return await doCall(openid, ev)
      case 'asset':
        return await doAsset(openid, ev)
      case 'assets':
        return await doAssets(openid, ev)
      // ── 微信服务通知 ──
      case 'subStatus':
        return await doSubStatus(openid)
      case 'subGrant':
        return await doSubGrant(openid, ev)
      case 'subOff':
        return await doSubOff(openid)
      case 'subTest':
        return await doSubTest(openid)
      case 'subPreview':
        return await doSubPreview(openid)
      case 'notifyTick':
        if (!(await isAdmin(openid))) return err('FORBIDDEN', '仅管理员可手动触发')
        return await doNotifyTick()
      default:
        return err('UNKNOWN_ACTION', '未知操作：' + action)
    }
  } catch (e) {
    if (e && e.code === 'NO_COLLECTION') {
      return err('NO_COLLECTION', '云数据库集合 panel_sessions 未创建，请在控制台新建后重试')
    }
    return err('INTERNAL', String((e && e.message) || e))
  }
}
