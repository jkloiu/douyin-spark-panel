/** 格式化与业务口径工具 */

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

/** 统一把各种时间表示转成 Date（面板有秒级时间戳和 '2026-10-04 09:01:10' 两种） */
function toDate(v) {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') {
    // 秒级时间戳（面板 spark ts 是浮点秒）
    return new Date(v < 1e11 ? v * 1000 : v)
  }
  const s = String(v)
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    return new Date(n < 1e11 ? n * 1000 : n)
  }
  const d = new Date(s.replace(/-/g, '/'))
  return isNaN(d.getTime()) ? null : d
}

/** 'MM-DD HH:mm' */
function fmtTime(v) {
  const d = toDate(v)
  if (!d) return '—'
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/** 'YYYY-MM-DD HH:mm:ss' */
function fmtFull(v) {
  const d = toDate(v)
  if (!d) return '—'
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    ' ' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes()) +
    ':' +
    pad(d.getSeconds())
  )
}

/** 相对时间：刚刚 / 12分钟前 / 3小时前 / 2天前 */
function relTime(v) {
  const d = toDate(v)
  if (!d) return '—'
  const diff = Date.now() - d.getTime()
  if (diff < 0) return fmtTime(d)
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return min + '分钟前'
  const hour = Math.floor(min / 60)
  if (hour < 24) return hour + '小时前'
  const day = Math.floor(hour / 24)
  if (day < 30) return day + '天前'
  return fmtTime(d)
}

/** 今天 0 点的时间戳（秒）—— 与面板 spark_api._fresh() 的口径保持一致 */
function todayStartSec() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return Math.floor(d.getTime() / 1000)
}

/** 火花数据是否「今天抓过」。面板 _fresh() 就是这么判的 */
function isFresh(ts) {
  const d = toDate(ts)
  if (!d) return false
  return Math.floor(d.getTime() / 1000) >= todayStartSec()
}

/**
 * 火花等级 —— 口径对齐面板日报：
 *   无火花(0/null) → danger(⛔)   ≤1天 → danger(💔已断)
 *   <7天 → warn(⚠️)              其它 → ok(✅)
 */
function sparkLevel(days) {
  if (days === null || days === undefined || days === '' || isNaN(Number(days))) {
    return { key: 'none', text: '无火花', cls: 'badge--danger' }
  }
  const d = Number(days)
  if (d <= 0) return { key: 'none', text: '无火花', cls: 'badge--danger' }
  if (d <= 1) return { key: 'broken', text: d + '天 · 已断', cls: 'badge--danger' }
  if (d < 7) return { key: 'warn', text: d + '天', cls: 'badge--warn' }
  return { key: 'ok', text: d + '天', cls: 'badge--ok' }
}

/** 展示名统一口径：备注名 → 昵称 → 抖音号，绝不显示内部 short_id 数字串 */
function dispName(obj) {
  if (!obj) return '—'
  const cands = [obj.remark, obj.douyin_remark, obj.name, obj.nickname, obj.douyin_nickname, obj.title]
  for (let i = 0; i < cands.length; i++) {
    const s = String(cands[i] || '').replace(/[\uFFFC\uFFF4\u200b-\u200f]/g, '').trim()
    if (s) return s
  }
  return obj.douyin_id || obj.unique_id || obj.short_id || '—'
}

/** 抖音号：有自定义号用自定义号，否则就是那串数字（抖音资料页也这么标） */
function douyinId(obj) {
  if (!obj) return ''
  return String(obj.douyin_id || obj.unique_id || obj.short_id || '')
}

/** 首字母（头像兜底用） */
function initial(name) {
  const s = String(name || '').trim()
  return s ? s.slice(0, 1).toUpperCase() : '?'
}

/** 'YYYY-MM-DD' → 'MM-DD 周四'（今天/昨天额外标注）——记录页日期筛选芯片的文案 */
function dayParts(day) {
  const s = String(day || '')
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return { md: s, wk: '', tag: '' }
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const wk = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()] || ''
  const n = new Date()
  const t0 = new Date(n.getFullYear(), n.getMonth(), n.getDate())
  const diff = Math.round((t0 - d) / 86400000)
  return { md: m[2] + '-' + m[3], wk: wk, tag: diff === 0 ? '今天' : (diff === 1 ? '昨天' : '') }
}

function dayLabel(day) {
  const p = dayParts(day)
  return p.wk ? p.md + ' ' + p.wk + (p.tag ? ' · ' + p.tag : '') : p.md
}

module.exports = {
  pad: pad,
  dayLabel: dayLabel,
  dayParts: dayParts,
  toDate: toDate,
  fmtTime: fmtTime,
  fmtFull: fmtFull,
  relTime: relTime,
  isFresh: isFresh,
  sparkLevel: sparkLevel,
  dispName: dispName,
  douyinId: douyinId,
  initial: initial,
}
