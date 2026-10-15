/**
 * 头像解析
 * ------------------------------------------------------------------
 * 面板返回的 avatar 现在**统一是面板本地路径**（data/avatars/<short_id>.jpg）。
 * 为什么不直接用抖音的 https 外链：
 *   小程序 <image> 加载网络图片走的是 downloadFile 合法域名校验，抖音的
 *   p*.douyinpic.com 不可能备案到我们这个 appid —— 开发者工具关了域名校验看着正常，
 *   **真机/体验版必然加载不出来**（这就是「抓好友没有头像」的真正原因）。
 *   所以面板侧把外链头像全部下载成本地**真 JPEG**，小程序这边只要经云函数把本地文件
 *   转成 base64 就能显示。
 * 兜底：万一还能收到 https（历史缓存/新增接口漏改），也走云函数，失败就降级成
 *   首字母占位 —— 绝不把外链直接交给 <image>，那会出现「位置在、图是空的」。
 *
 * [修复20261005] 三处改动：
 *   1) 一个头像一次云函数调用 → 改成**批量**：同一帧内提出的请求合并成一次调用
 *      （一屏十几个头像 = 1 次调用，而不是十几次），云函数侧也只查一次会话。
 *   2) 失败不再写永久缓存：以前失败也 `cache[path] = ''`，于是会话过期那一次之后，
 *      本次运行里头像永远是首字母，重新登录也救不回来，只能杀掉小程序。
 *      现在改成「失败计数 + 最多重试 5 次」，收到 NEED_LOGIN 时直接清空全部缓存。
 *   3) 保留串行/并发保护：合并后的批量请求本身有上限，不会一次打爆云函数。
 */
const api = require('./api.js')

/** 成功结果缓存：面板路径 → dataUrl */
const cache = {}
/** 失败重试计数（不写进 cache，避免把一次失败固化成永久空值） */
const failN = {}
const FAIL_MAX = 5

/** 待取队列：同一帧内的多个请求合并成一次批量调用 */
let queue = []
let timer = null
const BATCH_MAX = 24
const FLUSH_MS = 30

function isRemote(u) {
  return /^https?:\/\//i.test(String(u || ''))
}

function toPanelPath(raw) {
  let p = String(raw || '').trim()
  if (!p) return ''
  if (p.charAt(0) !== '/') p = '/' + p
  return p
}

/** 登录态失效时清空 —— 让重新登录之后头像能重新取，而不是继续用旧的空值 */
function clearAll() {
  Object.keys(cache).forEach(function (k) {
    delete cache[k]
  })
  Object.keys(failN).forEach(function (k) {
    delete failN[k]
  })
}

function flush() {
  timer = null
  const batch = queue
  queue = []
  if (!batch.length) return

  const items = batch.length > BATCH_MAX ? batch.slice(0, BATCH_MAX) : batch
  if (batch.length > BATCH_MAX) queue = batch.slice(BATCH_MAX)

  const paths = []
  items.forEach(function (j) {
    if (paths.indexOf(j.path) < 0) paths.push(j.path)
  })

  api
    .assets(paths)
    .then(function (map) {
      items.forEach(function (j) {
        const url = (map && map[j.path]) || ''
        if (url) {
          cache[j.path] = url
          delete failN[j.path]
        } else {
          failN[j.path] = (failN[j.path] || 0) + 1
        }
        j.done(url)
      })
    })
    .catch(function (e) {
      // 云函数明确说「登录态失效」→ 清空缓存，重登后可以重来
      if (e && e.code === 'NEED_LOGIN') clearAll()
      items.forEach(function (j) {
        failN[j.path] = (failN[j.path] || 0) + 1
        j.done('')
      })
    })
    .then(function () {
      if (queue.length) schedule()
    })
}

function schedule() {
  if (timer) return
  timer = setTimeout(flush, FLUSH_MS)
}

/**
 * @param {string} raw 接口里的 avatar 字段
 * @param {function} cb  回调 (可用 src)，无头像时给 ''
 */
function resolve(raw, cb) {
  const s = String(raw || '').trim()
  if (!s) {
    cb('')
    return
  }
  // [修复20261004] 外链也走云函数（不再直接交给 <image>）：成功则拿到 base64，
  // 失败则返回 '' —— 前端会退回首字母占位，而不是留一个加载不出来的空框。
  const p = isRemote(s) ? s : toPanelPath(s)
  if (cache[p] !== undefined) {
    cb(cache[p])
    return
  }
  if ((failN[p] || 0) >= FAIL_MAX) {
    cb('')
    return
  }
  queue.push({ path: p, done: cb })
  schedule()
}

/** 列表批量解析：传入数组，就地写回 __avatar 字段并回调整体 */
function resolveList(list, field, cb) {
  const arr = list || []
  let left = arr.length
  if (!left) return cb && cb()
  arr.forEach(function (item) {
    resolve(item[field || 'avatar'], function (src) {
      item.__avatar = src
      left--
      if (left === 0 && cb) cb()
    })
  })
}

module.exports = { resolve: resolve, resolveList: resolveList, isRemote: isRemote }
