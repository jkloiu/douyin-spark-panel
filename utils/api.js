const CONFIG = require('../config.js')

/** 需要重新登录时的回调（由 app.js 或页面注册） */
let _needLogin = null
function onNeedLogin(fn) {
  _needLogin = fn
}

function makeError(code, message) {
  const e = new Error(message || code)
  e.code = code
  return e
}

/**
 * 调云函数（底层，不解析业务数据）
 * @param {string} action  'profile' | 'login' | 'logout' | 'call' | 'asset' | 'ping'
 */
function raw(action, payload) {
  return new Promise((resolve, reject) => {
    const data = Object.assign({ action: action }, payload || {})
    wx.cloud.callFunction({
      name: CONFIG.CLOUD_FUNCTION,
      data: data,
      success(res) {
        const r = (res && res.result) || {}
        if (r.ok) return resolve(r)
        if (r.code === 'NEED_LOGIN') {
          const app = getApp()
          if (app) app.globalData.loggedIn = false
          if (_needLogin) _needLogin()
        }
        reject(makeError(r.code || 'UNKNOWN', r.error || '请求失败'))
      },
      fail(err) {
        const msg = (err && err.errMsg) || '云函数调用失败'
        reject(makeError('CALL_FAIL', msg))
      },
    })
  })
}

/**
 * 调面板接口（业务层）
 *
 * [修复20261005] 以前这里只 return r.data —— 而面板的业务错误（403 无权操作该账号、
 * 409 该好友已在名单中、400 参数错、502 面板异常）当时被云函数当成成功原样透传，
 * 于是页面拿到 {ok:false,error:...} 之后：读接口 `d.friends || []` 显示成「没有数据」，
 * 写接口还会接着弹「已保存 / 已加入名单」。
 * 现在云函数会明确上报这类错误，这里必须**抛出去**，让各页面的 try/catch 如实提示。
 */
async function panel(path, method, body) {
  const r = await raw('call', { path: path, method: method || 'GET', body: body })
  const d = r.data
  if (d && typeof d === 'object' && d.ok === false) {
    const e = makeError('PANEL_ERR', String(d.error || d.message || '面板返回错误'))
    e.status = r.status
    e.data = d
    throw e
  }
  return d
}

/** 面板 GET，自动带当前账号 */
async function get(path, params) {
  let q = ''
  if (params) {
    const parts = []
    Object.keys(params).forEach((k) => {
      const v = params[k]
      if (v !== undefined && v !== null && v !== '') {
        parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v))
      }
    })
    if (parts.length) q = (path.indexOf('?') >= 0 ? '&' : '?') + parts.join('&')
  }
  return panel(path + q, 'GET')
}

/** 面板 POST */
async function post(path, body) {
  return panel(path, 'POST', body)
}

/** 取面板本地静态资源（头像/截图）的 base64 */
async function asset(path) {
  const r = await raw('asset', { path: path })
  return r.dataUrl
}

/** 批量取（头像列表用）：一次调用拿回多张，返回 { 面板路径: dataUrl } */
async function assets(paths) {
  const r = await raw('assets', { paths: paths })
  return (r && r.items) || {}
}

module.exports = {
  raw: raw,
  panel: panel,
  get: get,
  post: post,
  asset: asset,
  assets: assets,
  onNeedLogin: onNeedLogin,
}
