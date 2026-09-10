/* ============ 应用装配：源文 → 测量 → 分页 → 渲染 / 导出 ============ */
'use strict'

const srcTpl = document.getElementById('src')
const pagesEl = document.getElementById('pages')
const previewEl = document.getElementById('preview')
const statusEl = document.getElementById('status')

let geo = null

const getSource = () => srcTpl.innerHTML
const setSource = html => { srcTpl.innerHTML = html }

/* ---------- 重新分页（唯一的重排入口） ---------- */
function repaginate() {
  geo = pageGeometry(previewEl.clientWidth - 32)

  // 1. 在与页内正文区等宽的隐藏容器里克隆源文
  const host = document.createElement('div')
  host.className = 'doc-flow measure-host'
  host.style.width = geo.contentW + 'px'
  const article = document.createElement('article')
  article.innerHTML = getSource()
  host.appendChild(article)
  document.body.appendChild(host)

  // 2. 提取脚注定义，并从正文中移除
  const defs = new Map()
  const defSec = article.querySelector('.fn-defs')
  if (defSec) {
    defSec.querySelectorAll('[data-fn]').forEach(li => defs.set(li.dataset.fn, li.innerHTML))
    defSec.remove()
  }

  // 3. 按文档顺序为脚注引用编号
  const fnNum = new Map()
  let n = 0
  article.querySelectorAll('.fn-ref').forEach(s => {
    const k = s.dataset.fn
    if (!fnNum.has(k)) fnNum.set(k, ++n)
    s.textContent = fnNum.get(k)
  })

  // 4. 测量 → 装箱 → 渲染
  const fnH = measureFootnotes(defs, geo.contentW, fnNum)
  const units = measureUnits(article)
  const pages = paginateUnits(units, geo.contentH, fnH)
  const h1 = article.querySelector('h1')
  const frag = renderPages(pages, geo, {
    title: h1 ? h1.textContent : '未命名文档',
    subtitle: '自动分页 · 页码实时重排',
    defs,
    fnNum,
  })
  pagesEl.replaceChildren(frag)
  host.remove()

  statusEl.textContent = `共 ${pages.length} 页 · 版面宽 ${geo.W}px · 缩放窗口或修改内容后自动重排`
}

/* ---------- 窗口缩放 → 重新分页（防抖，仅宽度变化时触发） ---------- */
let resizeTimer = 0
let lastWidth = 0
new ResizeObserver(() => {
  const w = previewEl.clientWidth
  if (w === lastWidth) return // 重排自身引起的高度变化，忽略
  lastWidth = w
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(repaginate, 150)
}).observe(previewEl)

if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => repaginate()) // 字体加载后行高可能变化，重排一次
}

/* ---------- 内容增删（模拟正文变高变矮） ---------- */
const SAMPLES = [
  '排版的细节往往藏在不被注意的地方：段与段之间的距离、行与行之间的呼吸、页与页之间的节奏。当这些变量都被纳入统一的度量体系，长文即使跨页切分，读者也不会感到断裂。',
  '试排是印刷流程中古老的一环：先印出样张，校对字句与版面，确认无误后再正式开印。数字时代的预览界面承担了同样的角色，只是校样从纸张搬回了屏幕。',
  '好的分页应当像一位沉默的装订工：标题不会孤悬页尾，脚注守在引用身旁，页码永远指向正确的文字。读者察觉不到它的存在，恰恰说明它完成了自己的工作。',
]

document.getElementById('btn-insert').addEventListener('click', () => {
  const p = document.createElement('p')
  p.textContent = SAMPLES[Math.floor(Math.random() * SAMPLES.length)]
  const defs = srcTpl.content.querySelector('.fn-defs')
  srcTpl.content.insertBefore(p, defs || null)
  repaginate()
})

document.getElementById('btn-remove').addEventListener('click', () => {
  const ps = srcTpl.content.querySelectorAll('p')
  if (ps.length > 1) { ps[ps.length - 1].remove(); repaginate() }
})

/* ---------- 源文编辑 ---------- */
const modal = document.getElementById('modal')
const editor = document.getElementById('src-editor')

document.getElementById('btn-edit').addEventListener('click', () => {
  editor.value = getSource().trim()
  modal.hidden = false
})
document.getElementById('btn-cancel').addEventListener('click', () => { modal.hidden = true })
document.getElementById('btn-apply').addEventListener('click', () => {
  if (editor.value.trim()) setSource(editor.value)
  modal.hidden = true
  repaginate()
})

/* ---------- 导出打印预览 ---------- */
let cssCache = null
async function loadCSS() {
  if (cssCache !== null) return cssCache
  try {
    cssCache = await (await fetch('css/style.css')).text()
  } catch (e) {
    cssCache = ''
  }
  return cssCache
}

async function buildPrintDocument() {
  const css = await loadCSS()
  const extra = [
    `@page{size:${geo.W}px ${geo.H}px;margin:0}`,
    'html,body{margin:0;padding:0;background:#fff}',
    '#pages{display:block}',
    '.page{box-shadow:none;margin:0 auto;break-after:page}',
    '.page:last-child{break-after:auto}',
  ].join('\n')
  const title = (document.querySelector('#pages .page-header span') || {}).textContent || '打印预览'
  return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
    `<title>${title} - 打印预览</title>\n<style>\n${css}\n${extra}\n</style>\n</head>\n<body>\n` +
    pagesEl.outerHTML +
    '\n</body>\n</html>'
}

document.getElementById('btn-export').addEventListener('click', async () => {
  const html = await buildPrintDocument()
  const win = window.open('', '_blank')
  if (!win) { // 弹窗被拦截 → 退化为下载独立 HTML 文件
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'print-preview.html'
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    return
  }
  win.document.open()
  win.document.write(html)
  win.document.close()
  let printed = false
  const doPrint = () => {
    if (printed) return
    printed = true
    win.focus()
    win.print()
  }
  win.addEventListener('load', () => setTimeout(doPrint, 50))
  setTimeout(doPrint, 1500) // 兜底：load 未触发也能调出打印
})

/* ---------- 首次渲染 ---------- */
repaginate()
