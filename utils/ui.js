/** 交互反馈统一封装 */

function toast(title, icon) {
  wx.showToast({ title: String(title || ''), icon: icon || 'none', duration: 1800 })
}

function ok(title) {
  wx.showToast({ title: String(title || '完成'), icon: 'success', duration: 1500 })
}

let _loadingCount = 0
function loading(title) {
  _loadingCount++
  wx.showLoading({ title: title || '加载中', mask: true })
}
function hideLoading() {
  _loadingCount = Math.max(0, _loadingCount - 1)
  if (_loadingCount === 0) wx.hideLoading()
}
function forceHideLoading() {
  _loadingCount = 0
  wx.hideLoading()
}

function confirm(content, title) {
  return new Promise(function (resolve) {
    wx.showModal({
      title: title || '确认',
      content: String(content || ''),
      success: function (res) {
        resolve(!!res.confirm)
      },
      fail: function () {
        resolve(false)
      },
    })
  })
}

function alert(content, title) {
  return new Promise(function (resolve) {
    wx.showModal({
      title: title || '提示',
      content: String(content || ''),
      showCancel: false,
      success: function () {
        resolve()
      },
      fail: function () {
        resolve()
      },
    })
  })
}

function prompt(content, title, placeholder) {
  return new Promise(function (resolve) {
    wx.showModal({
      title: title || '输入',
      editable: true,
      placeholderText: placeholder || '',
      content: String(content || ''),
      success: function (res) {
        resolve(res.confirm ? (res.content || '') : null)
      },
      fail: function () {
        resolve(null)
      },
    })
  })
}

function copy(text, tip) {
  return new Promise(function (resolve) {
    wx.setClipboardData({
      data: String(text || ''),
      success: function () {
        wx.showToast({ title: tip || '已复制', icon: 'none' })
        resolve(true)
      },
      fail: function () {
        resolve(false)
      },
    })
  })
}

module.exports = {
  toast: toast,
  ok: ok,
  loading: loading,
  hideLoading: hideLoading,
  forceHideLoading: forceHideLoading,
  confirm: confirm,
  alert: alert,
  prompt: prompt,
  copy: copy,
}
