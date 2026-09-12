/* ============ 应用装配：源文 → 测量 → 分页 → 渲染 / 导出 ============ */
'use strict'

const srcTpl = document.getElementById('src')
const pagesEl = document.getElementById('pages')
const previewEl = document.getElementById('preview')
const statusEl = document.getElementById('status')

let geo = null

const getSource = () => srcTpl.innerHTML
const setSource = html => { srcTpl.innerHTML = html }

/* 目录收集哪些标题（小节标题） */
const TOC_SELECTOR = 'h2'

/* ---------- 目录 ----------
 * 目录条目页码 = 标题所在正文页 + 目录自身页数，二者互相依赖：
 * 条目单行定高（高度与页码数字无关），迭代到目录页数稳定即可收敛。
 */
function buildTocUnits(texts, headPage, offset, geo) {
  const host = document.createElement('div')
  host.className = 'doc-flow measure-host'
  host.style.width = geo.contentW + 'px'
  const box = document.createElement('div')

  const title = document.createElement('h1')
  title.className = 'toc-title'
  title.textContent = '目录'
  box.appendChild(title)

  texts.forEach((text, i) => {
    const pageNo = (headPage[i] || 0) + offset + 1
    const entry = document.createElement('div')
    entry.className = 'toc-entry'
    const a = document.createElement('a')
    a.href = '#p' + pageNo
    const txt = document.createElement('span')
    txt.className = 'toc-txt'
    txt.textContent = text
    const dots = document.createElement('span')
    dots.className = 'toc-dots'
    const pg = document.createElement('span')
    pg.className = 'toc-pg'
    pg.textContent = pageNo
    a.append(txt, dots, pg)
    entry.appendChild(a)
    box.appendChild(entry)
  })

  host.appendChild(box)
  document.body.appendChild(host)
  const units = measureUnits(box) // h1 + 每个条目各为一个整体块单元
  host.remove() // 元素已脱离文档，渲染时再搬入页面
  return units
}

/* ---------- 书末索引 ----------
 * 源文里被 <span class="idx" data-term="规范名">词</span> 标记的词收进索引。
 * 每个词出现过的物理页码在最终正文分页结果里逐栏扫描得出（同页多次出现
 * 只写一个页码，升序）；按字头分组：中文按拼音首字声母（取该音节一个常用
 * 字为锚点，用 zh 排序比较归组），拉丁词按首字母归入 A–Z，其余归「其他」。
 * 索引自身一栏通栏、独占页排在正文之后，不占正文页码。
 */
const IDX_PINYIN_ANCHORS = [
  ['A', '啊'], ['B', '巴'], ['C', '擦'], ['D', '搭'], ['E', '蛾'],
  ['F', '发'], ['G', '噶'], ['H', '哈'], ['J', '击'], ['K', '喀'],
  ['L', '拉'], ['M', '妈'], ['N', '拿'], ['O', '哦'], ['P', '趴'],
  ['Q', '七'], ['R', '然'], ['S', '撒'], ['T', '他'], ['W', '挖'],
  ['X', '西'], ['Y', '压'], ['Z', '匝'],
]
const IDX_COLLATOR = new Intl.Collator('zh-CN-u-co-pinyin')
const IDX_CJK = /[一-鿿㐀-䶿]/
const IDX_LATIN = /[A-Za-z]/

function indexLetterOf(term) {
  const ch = term.trim()[0] || ''
  if (IDX_LATIN.test(ch)) return ch.toUpperCase()
  if (IDX_CJK.test(ch)) {
    let letter = 'Z'
    for (const [l, anchor] of IDX_PINYIN_ANCHORS) {
      if (IDX_COLLATOR.compare(ch, anchor) < 0) break
      letter = l
    }
    return letter
  }
  return '#'
}

/* 从正文分页结果逐栏（左栏 → 右栏）扫描索引标记：
 * 行单元可能在视觉行界被切开，标记被克隆成两个半截（各带相同 data-idx-id）；
 * 用 id 去重，每个标记只认它“起始”的那一页（扫描顺序里第一次出现的页），
 * 这样一个词被行界劈成两半时只计起始页、且用切行前固化的完整词目计名。
 * 页码为物理页码（目录 + 正文相对页）。同一页出现多次只记一次、自然升序。
 * 词条恰好起自行首又被行界切开时，切出的首条视觉行整个留在原标记元素
 * 内部（.idx 是 .ln 的祖先而非后代），只查后代会漏掉起始碎片——轻则把
 * 词条记到后半截所在的页，重则（整段只有这个词时）整条从索引里消失；
 * 与旁注一样，后代与祖先链都要查。 */
function collectIndexEntries(bodyPages, tocCount) {
  const pages = new Map() // 规范词条 → 物理页码数组
  const seenIds = new Set()
  const pushTerm = (term, physPage) => {
    if (!term) return
    let arr = pages.get(term)
    if (!arr) { arr = []; pages.set(term, arr) }
    if (!arr.includes(physPage)) arr.push(physPage)
  }
  bodyPages.forEach((pg, pi) => {
    const physPage = tocCount + pi + 1
    for (const col of pg.cols) {
      for (const u of col.items) {
        const root = u.el
        if (!root || !root.querySelectorAll) continue
        const marks = [...root.querySelectorAll('.idx')]
        const ancestor = root.closest && root.closest('.idx')
        if (ancestor && !marks.includes(ancestor)) marks.unshift(ancestor)
        for (const el of marks) {
          const id = el.dataset.idxId
          if (id) {
            if (seenIds.has(id)) continue
            seenIds.add(id)
          }
          pushTerm(el.dataset.term || el.textContent.trim(), physPage)
        }
      }
    }
  })
  return [...pages].map(([term, locs]) => ({ term, locs }))
}

/* 按字头分组排序：组序 A–Z 再「其他」；组内按拼音排序，同形以词条本身兜底 */
function groupIndexEntries(entries) {
  const groups = new Map()
  for (const e of entries) {
    const letter = indexLetterOf(e.term)
    if (!groups.has(letter)) groups.set(letter, [])
    groups.get(letter).push(e)
  }
  const rank = l => (l === '#' ? 27 : l.charCodeAt(0) - 64)
  return [...groups]
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([letter, items]) => ({
      letter,
      entries: items.sort((a, b) =>
        IDX_COLLATOR.compare(a.term, b.term) ||
        (a.term < b.term ? -1 : a.term > b.term ? 1 : 0)),
    }))
}

/* 构建索引装箱单元：h1「索引」→ 每组一个 h2 字头 + 若干条目整体块。
 * 条目内部由引擎按通栏宽自然断行，页码是 nowrap 的整块：一行放不下时
 * 整个页码连同前导逗号移到下一行（悬挂缩进），绝不会被切成看不见的半截。 */
function buildIndexUnits(entries, geo) {
  const host = document.createElement('div')
  host.className = 'doc-flow measure-host'
  host.style.width = geo.contentW + 'px'
  const box = document.createElement('div')

  const title = document.createElement('h1')
  title.className = 'index-title'
  title.textContent = '索引'
  box.appendChild(title)

  for (const g of groupIndexEntries(entries)) {
    const h = document.createElement('h2')
    h.className = 'index-group'
    h.textContent = g.letter === '#' ? '其他' : g.letter
    box.appendChild(h)

    for (const e of g.entries) {
      const d = document.createElement('p')
      d.className = 'index-entry'
      const term = document.createElement('span')
      term.className = 'index-term'
      term.textContent = e.term
      d.appendChild(term)
      e.locs.forEach((p, i) => {
        if (i > 0) d.appendChild(document.createTextNode('，'))
        const a = document.createElement('a')
        a.className = 'index-pg'
        a.href = '#p' + p
        a.textContent = String(p)
        d.appendChild(a)
      })
      box.appendChild(d)
    }
  }

  host.appendChild(box)
  document.body.appendChild(host)
  const units = measureUnits(box)
  host.remove() // 元素已脱离文档，渲染时再搬入页面
  return units
}

/* 测量前给每个索引标记编号并固化规范名：
 *  - 编号让“一个词在视觉行界被切成两个半截克隆”时仍能认出是同一次出现，
 *    页码只认它起始的那一页（第一次出现的页），不会跨页重复计数；
 *  - 规范名在切行前固化，半截克隆也带着完整词条，不会拿“雕版”当词目。 */
function tagIndexMarkers(article) {
  let seq = 0
  article.querySelectorAll('span.idx').forEach(el => {
    if (!el.dataset.term) el.dataset.term = el.textContent.trim()
    el.dataset.idxId = 'ix' + (++seq)
  })
}

/* ---------- 源文克隆：提取脚注、旁注、编号、目录目标 ---------- */
function extractMarginNotes(article) {
  const notes = new Map()
  let seq = 0
  article.querySelectorAll('span.mn[data-note]').forEach(el => {
    const html = el.getAttribute('data-note') || ''
    if (!html.trim()) {
      el.removeAttribute('data-note')
      return
    }
    const id = 'mn' + (++seq)
    el.dataset.mnId = id
    el.removeAttribute('data-note')
    notes.set(id, html)
  })
  return notes
}

function createMeasureArticle(geo) {
  const host = document.createElement('div')
  host.className = 'doc-flow measure-host'
  host.style.width = geo.colW + 'px' // 两栏时按栏宽测量，行断与真实栏一致
  const article = document.createElement('article')
  article.innerHTML = getSource()
  host.appendChild(article)
  document.body.appendChild(host)

  const notes = extractMarginNotes(article)

  const defs = new Map()
  const defSec = article.querySelector('.fn-defs')
  if (defSec) {
    defSec.querySelectorAll('[data-fn]').forEach(li => defs.set(li.dataset.fn, li.innerHTML))
    defSec.remove()
  }

  const fnNum = new Map()
  let n = 0
  article.querySelectorAll('.fn-ref').forEach(s => {
    const k = s.dataset.fn
    if (!fnNum.has(k)) fnNum.set(k, ++n)
    s.textContent = fnNum.get(k)
  })

  tagIndexMarkers(article) // 在切行之前给索引标记编号、固化规范名

  const tocTexts = []
  const targetIds = new Set()
  article.querySelectorAll(TOC_SELECTOR).forEach(h => {
    const text = h.textContent.trim()
    if (!text) return
    h.dataset.toc = tocTexts.length
    tocTexts.push(text)
    if (h.id) targetIds.add(h.id)
  })

  return { host, article, defs, notes, fnNum, tocTexts, targetIds }
}

/* ---------- 文内互见 ----------
 * 锚点文本里用 # 占位页码。页码 span 不允许断行、等宽数字，
 * 因此它对版面的影响只取决于位数（1 / 10 / …）。
 */
function fillCrossReferences(article, labels, targetIds) {
  const refs = Array.from(article.querySelectorAll('a.xref[data-target]'))
  refs.forEach((a, i) => {
    const target = a.dataset.target
    const label = labels[i] || '1'
    const ok = targetIds.has(target) && /^\d+$/.test(label)

    const pg = document.createElement('span')
    pg.className = 'xref-pg'
    pg.textContent = ok ? label : '?'

    let textNode = null
    const walker = document.createTreeWalker(a, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      if (walker.currentNode.nodeValue.includes('#')) { textNode = walker.currentNode; break }
    }
    if (textNode) {
      const value = textNode.nodeValue
      const idx = value.indexOf('#')
      const includePre = idx > 0 && value[idx - 1] === '第'
      const includePost = idx + 1 < value.length && value[idx + 1] === '页'
      const start = includePre ? idx - 1 : idx
      const end = includePost ? idx + 2 : idx + 1
      const after = document.createTextNode(value.slice(end))
      textNode.nodeValue = value.slice(0, start)
      pg.textContent = includePre ? `第${label}页` : label
      textNode.after(pg, after)
    } else {
      pg.textContent = ok ? `（第 ${label} 页）` : '（页码待定）'
      a.appendChild(pg)
    }

    if (ok) {
      a.href = '#p' + label
      a.dataset.page = label
      a.removeAttribute('aria-disabled')
      a.removeAttribute('title')
    } else {
      a.removeAttribute('href')
      a.removeAttribute('data-page')
      a.setAttribute('aria-disabled', 'true')
      a.title = `未找到互见目标：${target}`
      console.warn('文内互见缺少对应小节（h2[id]）：', target)
    }
  })
  return refs
}

/* ---------- 重新分页（唯一的重排入口） ---------- */
function repaginate() {
  const hasNotes = srcTpl.content.querySelectorAll('span.mn[data-note]').length > 0
  geo = pageGeometry(previewEl.clientWidth - 32, hasNotes)

  // 1. 目录条目恒为单行定高，目录占几页只取决于条目数，与正文页码无关，先量一次。
  //    目录本身始终一栏通栏排版（条目按整页版心宽测量）。
  const probe = createMeasureArticle(geo)
  const { tocTexts, targetIds } = probe
  let tocPageCount = 0
  if (tocTexts.length) {
    tocPageCount = paginateUnits(
      buildTocUnits(tocTexts, tocTexts.map(() => 0), 0, geo),
      geo.contentH,
      new Map()
    ).length
  }
  probe.host.remove()

  // 2. 互见页码不动点迭代：
  //    用旧页码排版 → 读出每个标题的真实落页 → 用新页码重排，直到两者一致。
  //    初值一律放最小的一位数“1”：页码只会 1 → 10 变宽，页数单调不减，
  //    每次改动都只可能把目标标题继续向后推，因此迭代必收敛，不会新旧页来回跳。
  let labels = []
  let laid = null
  for (let iter = 0; iter < 20; iter++) {
    const built = createMeasureArticle(geo)
    if (iter === 0) {
      labels = Array.from(built.article.querySelectorAll('a.xref[data-target]')).map(
        a => built.targetIds.has(a.dataset.target) ? '1' : '?'
      )
    }
    const xrefs = fillCrossReferences(built.article, labels, built.targetIds)

    const fnH = measureFootnotes(built.defs, geo.contentW, built.fnNum)
    const mnH = geo.noteW > 0
      ? measureMarginNotes(built.notes, geo.noteW)
      : new Map()
    const units = measureUnits(built.article)
    const bodyPages = paginateUnits(units, geo.contentH, fnH, mnH, geo.cols)

    /* 落页扫描：按文档顺序逐栏扫（左栏 → 右栏），标题只认第一次出现 */
    const headPage = built.tocTexts.map(() => 0)
    const pageById = new Map()
    bodyPages.forEach((pg, pi) => {
      for (const col of pg.cols) {
        for (const u of col.items) {
          if (u.kind === 'block' && u.el.dataset && u.el.dataset.toc !== undefined) {
            const ti = +u.el.dataset.toc
            headPage[ti] = pi
            if (u.el.id) pageById.set(u.el.id, pi + tocPageCount + 1)
          }
        }
      }
    })

    const nextLabels = xrefs.map(a =>
      built.targetIds.has(a.dataset.target) ? String(pageById.get(a.dataset.target)) : '?'
    )

    if (laid) laid.host.remove()
    laid = { ...built, bodyPages, headPage, labels: nextLabels }
    if (nextLabels.every((v, i) => v === labels[i])) break
    labels = nextLabels
  }

  const { host, article, defs, notes, fnNum, bodyPages, headPage } = laid

  // 3. 目录条目填入最终页码后再装箱（条目高度与页码位数无关，页数仍等于 tocPageCount）
  let tocPages = []
  if (tocTexts.length) {
    tocPages = paginateUnits(
      buildTocUnits(tocTexts, headPage, tocPageCount, geo),
      geo.contentH,
      new Map()
    )
  }

  /* 逐页推导正文页眉的小节名：按装箱顺序逐栏扫每页单元（左栏 → 右栏），
     取这一页上最后出现的 h2——即只要新小节已在本页（任一栏）起头，
     本页就算新小节；h2 之前的引言页没有归属小节（右侧留空）。
     增删段落 / 改变宽度后整盘重排，这里随之重算，页眉不会残留上一节。 */
  const h1 = article.querySelector('h1')
  const bookTitle = h1 ? h1.textContent : '未命名文档'
  const sectionHeads = []
  let currentSection = ''
  for (const pg of bodyPages) {
    for (const col of pg.cols) {
      for (const u of col.items) {
        if (u.kind === 'block' && u.el.dataset && u.el.dataset.toc !== undefined) {
          currentSection = u.el.textContent.trim()
        }
      }
    }
    sectionHeads.push(currentSection)
  }

  // 4. 书末索引：词条与页码全部取自上面这份最终正文分页，与文内互见同源。
  //    索引排在正文之后、自身占页，不改变正文落页，因此正文页码无需回推；
  //    任何内容 / 尺寸变化都会让正文整盘重排，索引词条组成与页码随之重算，
  //    最终与目录、正文在同一次 replaceChildren 中原子替换，不会新旧页码混排。
  const indexEntries = collectIndexEntries(bodyPages, tocPages.length)
  let indexPages = []
  if (indexEntries.length) {
    indexPages = paginateUnits(
      buildIndexUnits(indexEntries, geo),
      geo.contentH,
      new Map()
    )
  }

  // 5. 渲染：目录页在前、正文居中、索引页压卷，页码连续编号
  const allPages = [...tocPages, ...bodyPages, ...indexPages]
  const frag = renderPages(allPages, geo, {
    title: bookTitle,
    tocCount: tocPages.length,
    indexCount: indexPages.length,
    sectionHeads,
    defs,
    notes,
    fnNum,
  })
  pagesEl.replaceChildren(frag)
  host.remove()

  const parts = [
    `共 ${allPages.length} 页（目录 ${tocPages.length} 页`,
    indexPages.length ? `、索引 ${indexPages.length} 页` : '',
    `）· ${geo.cols === 2 ? '每页两栏' : '每页一栏'} · 版面宽 ${geo.W}px · 缩放窗口或修改内容后自动重排`,
  ]
  statusEl.textContent = parts.join('')
}

/* ---------- 目录 / 互见点击 → 翻到目标页（导出的打印文档里则走原生锚点） ---------- */
pagesEl.addEventListener('click', e => {
  const a = e.target.closest('.toc-entry a[href^="#p"], a.xref[href^="#p"], a.index-pg[href^="#p"]')
  if (!a) return
  e.preventDefault()
  const target = document.getElementById(a.getAttribute('href').slice(1))
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
})

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

/* ---------- 表行增删（模拟表格变高变矮，切开位置应整体重算） ---------- */
const TABLE_ROWS = [
  ['21 世纪初', '可重排电子书', 'EPUB / Kindle 等标准', '版面随字号、栏宽实时重排，跨页表在设备上变为连续滚动、打印时重新分页。'],
  ['当代', '浏览器分页脚本', '各类出版与报表系统', '用“测量—装箱—渲染”补齐脚注同页、跨页表等原生能力，每次变化整盘重排。'],
  ['展望', '可变字体与响应式版面', '字体厂商与规范组织', '字宽、字重连续可调，表格与正文在同一套度量下自适应纸张与屏幕。'],
]
let tableRowCycle = 0

document.getElementById('btn-add-row').addEventListener('click', () => {
  const tbody = srcTpl.content.querySelector('table tbody')
  if (!tbody) return
  const [a, b, c, d] = TABLE_ROWS[tableRowCycle++ % TABLE_ROWS.length]
  const tr = document.createElement('tr')
  ;[a, b, c, d].forEach(text => {
    const td = document.createElement('td')
    td.textContent = text
    tr.appendChild(td)
  })
  tbody.appendChild(tr)
  repaginate()
})

document.getElementById('btn-del-row').addEventListener('click', () => {
  const tbody = srcTpl.content.querySelector('table tbody')
  if (tbody && tbody.rows.length > 1) {
    tbody.deleteRow(-1)
    repaginate()
  }
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
  const title =
    (document.querySelector('#pages .page-header .ph-book') || {}).textContent ||
    (document.querySelector('#pages .page-header .ph-right:not(:empty)') || {}).textContent ||
    '打印预览'
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
