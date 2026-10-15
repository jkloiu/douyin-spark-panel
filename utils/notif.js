/**
 * 通知「已读水位线」
 * ------------------------------------------------------------------
 * 背景：面板的 /api/notifications 是一条只增不减的流水（只有「清空」，
 * 没有「单条已读」），所以红点**不能**直接拿列表长度算 —— 那样子点进去
 * 也永远消不掉（这就是之前「红点点掉不取消」的原因）。
 *
 * 做法：在小程序本地按「面板登录用户名」存一个已读水位线（时间戳），
 *       红点 = 晚于水位线 且 不是 ok 的通知条数。
 *       水位线取「已加载列表里的最大 t」，而不是本机 Date.now()——
 *       手机时钟和服务器有偏差时，用本机时间会把新通知误判成已读。
 *
 * 面板 t 字段是**浮点秒**（例：1790958785.457），这里统一折算成毫秒。
 */

const KEY = 'notif_read_ts'

function _key(username) {
  return KEY + '.' + String(username || 'anon')
}

/** 面板浮点秒 → 毫秒 */
function normTs(v) {
  const n = Number(v)
  if (!n || isNaN(n)) return 0
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n)
}

function readTs(username) {
  try {
    return Number(wx.getStorageSync(_key(username)) || 0) || 0
  } catch (e) {
    return 0
  }
}

/** ts 省略时用当前时间；显式传 0 视为不写入（避免把水位线清零） */
function markRead(username, ts) {
  const v = ts === undefined || ts === null || Number(ts) === 0 ? Date.now() : normTs(ts)
  try {
    wx.setStorageSync(_key(username), v)
  } catch (e) {
    /* 存不下也不影响主流程 */
  }
}

function resetRead(username) {
  try {
    wx.removeStorageSync(_key(username))
  } catch (e) {
    /* ignore */
  }
}

/** 给列表每条打上 isNew（晚于水位线） */
function decorate(list, username) {
  const ts = readTs(username)
  return (list || []).map(function (n) {
    return Object.assign({}, n, { isNew: normTs(n && n.t) > ts })
  })
}

/** 面板里「需要关注」的类型：不是 ok 就算异常 */
function isBad(n) {
  return !!(n && n.type && n.type !== 'ok')
}

/** 统计：未读总数 / 异常总数 / 角标数（未读且异常） */
function counts(list, username) {
  const ts = readTs(username)
  let unread = 0
  let bad = 0
  let badge = 0
  ;(list || []).forEach(function (n) {
    const fresh = normTs(n && n.t) > ts
    if (fresh) unread++
    if (isBad(n)) {
      bad++
      if (fresh) badge++
    }
  })
  return { unread: unread, bad: bad, badge: badge }
}

/** 取列表里最大的 t（用作水位线：不会因手机时钟偏差误判） */
function maxTs(list) {
  let mx = 0
  ;(list || []).forEach(function (n) {
    const v = normTs(n && n.t)
    if (v > mx) mx = v
  })
  return mx
}

/** 「我的」页签角标（tabBar index 4 = 我的） */
function syncTabBadge(count) {
  const idx = 4
  const n = Number(count) || 0
  try {
    if (n > 0) {
      wx.setTabBarBadge({
        index: idx,
        text: n > 99 ? '99+' : String(n),
        fail: function () {},
      })
    } else {
      wx.removeTabBarBadge({ index: idx, fail: function () {} })
    }
  } catch (e) {
    /* 非 tabBar 页调用会抛错，忽略 */
  }
}

module.exports = {
  normTs: normTs,
  readTs: readTs,
  markRead: markRead,
  resetRead: resetRead,
  decorate: decorate,
  isBad: isBad,
  counts: counts,
  maxTs: maxTs,
  syncTabBadge: syncTabBadge,
}
