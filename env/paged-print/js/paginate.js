/* =========================================================
 * 分页引擎
 * 把源文（标题 / 正文段落 / 脚注）按给定页面几何切分为若干页。
 *
 * 保证的约束：
 *  - 标题后至少跟随 KEEP_LINES 行正文（可跨短段落收集），否则标题链整体
 *    移到下一页（keep-with-next 前瞻 + 页尾兜底），页底不留"标题加一行"
 *  - 段落跨页时，页底与页首都至少保留 2 行（orphans / widows 控制）
 *  - 脚注集中排在其引用所在页的底部；引用行放不下时连同脚注一起后移
 *  - 内容或页面尺寸变化后整体重排，页码始终对应同一段文字
 * ========================================================= */
'use strict'

const A4_RATIO = 297 / 210
const FN_SEP_H = 20   // 脚注区分隔线的预留高度(px)
const KEEP_LINES = 2  // 标题后至少跟随的正文行数
const EPS = 0.5       // 高度比较容差(px)

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)) }

/* 根据可用宽度计算页面几何（保持 A4 比例，宽度随窗口缩放） */
function pageGeometry(availWidth) {
  const W = clamp(Math.floor(availWidth), 360, 794)
  const H = Math.round(W * A4_RATIO)
  const mX = clamp(Math.round(W * 0.085), 34, 56)
  const mT = clamp(Math.round(W * 0.080), 42, 64)
  const mB = clamp(Math.round(W * 0.075), 42, 60)
  return { W, H, mX, mT, mB, contentW: W - mX * 2, contentH: H - mT - mB }
}

/* ---------- 文本位置工具 ---------- */

function collectTextNodes(root) {
  const nodes = [], starts = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let n, acc = 0
  while ((n = walker.nextNode())) {
    nodes.push(n); starts.push(acc); acc += n.nodeValue.length
  }
  return { nodes, starts, total: acc }
}

/* 全局字符下标 → (文本节点, 节点内偏移) */
function locate(t, idx) {
  if (idx >= t.total) {
    const last = t.nodes[t.nodes.length - 1]
    return { node: last, offset: last.nodeValue.length }
  }
  let lo = 0, hi = t.nodes.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (t.starts[mid] <= idx) lo = mid; else hi = mid - 1
  }
  return { node: t.nodes[lo], offset: idx - t.starts[lo] }
}

/* ---------- 段落切行 ----------
 * 用 Range 的客户端矩形判断一段字符是否落在同一视觉行，
 * 逐行二分出断点，再把每行抽离成独立的块级 <span class="ln">。
 */
function splitParagraph(p) {
  const t = collectTextNodes(p)
  if (t.total === 0) return null // 无文本（如纯图片段落）→ 调用方按整体块处理

  const cs = getComputedStyle(p)
  let lh = parseFloat(cs.lineHeight)
  if (isNaN(lh)) lh = (parseFloat(cs.fontSize) || 16) * 1.2
  const tol = Math.max(6, lh * 0.3) // 同一行内上标等引起的基线抖动容差

  const range = document.createRange()
  const rectsFor = (a, b) => {
    const s = locate(t, a), e = locate(t, b)
    range.setStart(s.node, s.offset)
    range.setEnd(e.node, e.offset)
    return Array.from(range.getClientRects())
  }
  const oneLine = (a, b) => {
    const rs = rectsFor(a, b)
    if (rs.length < 2) return true
    const b0 = rs[0].bottom
    for (const r of rs) if (Math.abs(r.bottom - b0) > tol) return false
    return true
  }

  const lines = []
  let pos = 0
  while (pos < t.total) {
    let lo = pos + 1, hi = t.total, best = pos + 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (oneLine(pos, mid)) { best = mid; lo = mid + 1 } else { hi = mid - 1 }
    }
    lines.push([pos, best])
    pos = best
  }

  /* 逆序抽离每行内容，包成行块（逆序保证前面的下标不失效） */
  const spans = []
  for (let i = lines.length - 1; i >= 0; i--) {
    const [a, b] = lines[i]
    const s = locate(t, a), e = locate(t, b)
    range.setStart(s.node, s.offset)
    range.setEnd(e.node, e.offset)
    const span = document.createElement('span')
    span.className = 'ln'
    span.appendChild(range.extractContents())
    range.insertNode(span)
    spans.unshift(span)
  }

  /* 行界恰好切开上标引用时会留下空壳（还会渲染出空的 "[]"），
   * 丢掉空壳，让脚注只跟随真正带编号的那一行 */
  for (const sp of spans) {
    for (const s of sp.querySelectorAll('.fn-ref')) {
      if (s.textContent === '') s.remove()
    }
  }

  /* 丢弃纯空白行（如段尾残留的空格行） */
  const kept = []
  for (const sp of spans) {
    if (sp.textContent.trim() === '' && !sp.querySelector('img,br')) sp.remove()
    else kept.push(sp)
  }
  return kept
}

/* ---------- 单元测量 ---------- */

function fnKeys(el) {
  const keys = []
  for (const s of el.querySelectorAll('.fn-ref')) {
    if (!keys.includes(s.dataset.fn)) keys.push(s.dataset.fn)
  }
  return keys
}

function blockUnit(el) {
  const cs = getComputedStyle(el)
  return {
    kind: 'block',
    el,
    height: el.getBoundingClientRect().height,
    tail: parseFloat(cs.marginBottom) || 0,
    refs: fnKeys(el),
    keepNext: /^H[1-6]$/.test(el.tagName),
  }
}

/* 把文章子节点展开为装箱单元：段落 → 行单元序列，其余 → 整体块单元 */
function measureUnits(article) {
  const units = []
  for (const el of Array.from(article.children)) {
    if (el.classList.contains('fn-defs')) continue
    if (el.tagName === 'P' && el.textContent.trim() !== '') {
      const spans = splitParagraph(el)
      if (!spans || spans.length === 0) { units.push(blockUnit(el)); continue }
      const cs = getComputedStyle(el)
      const mb = parseFloat(cs.marginBottom) || 0
      const total = spans.length
      spans.forEach((sp, idx) => {
        units.push({
          kind: 'line',
          el: sp,
          paraEl: el,
          idx,
          total,
          height: sp.getBoundingClientRect().height,
          tail: idx === total - 1 ? mb : 0,
          refs: fnKeys(sp),
          keepNext: false,
        })
      })
    } else {
      units.push(blockUnit(el))
    }
  }
  return units
}

/* 在与页内脚注区同样式、等宽的隐藏容器里测量每条脚注的高度 */
function measureFootnotes(defs, contentW, fnNum) {
  const host = document.createElement('div')
  host.className = 'measure-host page-fns'
  host.style.width = contentW + 'px'
  document.body.appendChild(host)
  const map = new Map()
  for (const [key, html] of defs) {
    const d = document.createElement('div')
    d.className = 'fn-item'
    d.innerHTML = '<span class="fn-no"></span><span class="fn-tx"></span>'
    d.querySelector('.fn-no').textContent = (fnNum.get(key) || 0) + '.' // 用真实编号占位，宽度才一致
    d.querySelector('.fn-tx').innerHTML = html
    host.appendChild(d)
    const mb = parseFloat(getComputedStyle(d).marginBottom) || 0
    map.set(key, d.getBoundingClientRect().height + mb)
  }
  host.remove()
  return map
}

/* ---------- 装箱 ----------
 * 贪心逐页填充；脚注高度随引用行即时扣减；
 * 页尾断段时做孤行/寡行回退；标题做 keep-with-next 前瞻。
 */
function paginateUnits(units, contentH, fnH) {
  const pages = []
  const placedFn = new Set()   // 已落在之前页的脚注
  let items = [], fns = [], i = 0
  let space = contentH

  const fnHeightOf = k => fnH.get(k) || 0
  const refsH = keys => keys.reduce((s, k) => s + fnHeightOf(k), 0)
  const fresh = (u, extra) =>
    u.refs.filter(k => !placedFn.has(k) && !fns.includes(k) && !(extra && extra.includes(k)))

  function rebuild() { // 回退行之后，按剩余单元重算脚注与可用高度
    fns = []
    for (const u of items) for (const k of u.refs) if (!fns.includes(k)) fns.push(k)
    const used = items.reduce((s, u) => s + u.height + u.tail, 0)
    space = contentH - used - (fns.length ? FN_SEP_H + refsH(fns) : 0)
  }

  /* 页尾兜底：若一页以“标题链 + 不足 n 行正文（n < KEEP_LINES）”收尾，
   * 把标题链连同那点正文一起弹到下一页（其上的脚注随 rebuild 一并带走）。
   * 标题链就在页首时退无可退，保留现状。 */
  function fixPageTail() {
    const end = items.length
    let k = end - 1
    let bodyLines = 0
    while (k >= 0 && items[k].kind === 'line') { bodyLines++; k-- }
    if (bodyLines >= KEEP_LINES) return
    let h = k
    while (h >= 0 && items[h].kind === 'block' && items[h].keepNext) h--
    if (h === k || h < 0) return // 页尾不是标题链，或标题链已在页首
    const popCount = end - (h + 1)
    items.length = h + 1
    i -= popCount
    rebuild()
  }

  function closePage() {
    if (items.length) {
      pages.push({ items, fns: fns.slice() })
      for (const k of fns) placedFn.add(k)
    }
    items = []; fns = []; space = contentH
  }

  for (;;) {
  while (i < units.length) {
    const u = units[i]
    const nrefs = fresh(u)
    const need = u.height + u.tail + refsH(nrefs) + (nrefs.length && fns.length === 0 ? FN_SEP_H : 0)

    /* keep-with-next：标题（及其后连续标题）+ 下一段至少 KEEP_LINES 行必须同页 */
    if (u.keepNext && items.length) {
      let look = need
      const sepCounted = nrefs.length > 0 && fns.length === 0 // need 里已含分隔线高度
      const seen = nrefs.slice()
      let j = i + 1
      while (j < units.length && units[j].kind === 'block' && units[j].keepNext) {
        const w = units[j]
        const wr = fresh(w, seen); seen.push(...wr)
        look += w.height + w.tail + refsH(wr)
        j++
      }
      /* 再向后收集 KEEP_LINES 行正文（可跨短段落）；遇到整体块则要求块本身同页 */
      let gathered = 0
      while (j < units.length && gathered < KEEP_LINES) {
        const w = units[j]
        const wr = fresh(w, seen); seen.push(...wr)
        look += w.height + w.tail + refsH(wr)
        if (w.kind === 'line') { gathered++; j++ } else break
      }
      if (seen.length && fns.length === 0 && !sepCounted) look += FN_SEP_H
      if (look > space + EPS) { fixPageTail(); closePage(); continue }
    }

    if (need <= space + EPS || items.length === 0) {
      items.push(u)
      fns.push(...nrefs)
      space -= need
      i++
    } else {
      /* 段落被页界截断时的孤行/寡行回退 */
      if (u.kind === 'line' && u.idx > 0) {
        const total = u.total, k = u.idx // 本页已放 k 行
        let pop = 0
        if (total <= 3) pop = k                 // 短段不拆，整体后移
        else if (k === 1) pop = 1               // 页底不留单行
        else if (total - k === 1) pop = 1       // 页首不留单行
        let popped = 0
        while (popped < pop && items.length) {
          const last = items[items.length - 1]
          if (last.kind !== 'line' || last.paraEl !== u.paraEl) break
          items.pop(); popped++
        }
        if (popped) { i -= popped; rebuild() }
      }
      fixPageTail() // 页尾不能只剩标题（链）或标题加一行正文
      closePage()
    }
  }
    /* 文档自然结束也要做页尾检查；弹回去的标题链继续装到下一页 */
    const before = i
    fixPageTail()
    closePage()
    if (i >= units.length || i >= before) break
  }
  return pages
}

/* ---------- 渲染 ---------- */

function renderPages(pages, geo, meta) {
  const frag = document.createDocumentFragment()
  const total = pages.length

  pages.forEach((pg, pi) => {
    const page = document.createElement('section')
    page.className = 'page'
    page.id = 'p' + (pi + 1) // 目录条目的锚点目标
    page.style.width = geo.W + 'px'
    page.style.height = geo.H + 'px'
    page.style.padding = `${geo.mT}px ${geo.mX}px ${geo.mB}px`

    /* 对开页眉：目录页只写「目录」；正文偶数页（左页）左外侧写书名、右侧留空，
       奇数页（右页）左侧留空、右外侧写本页所属小节名。
       归属小节由调用方从同一次分页结果逐页算好（meta.sectionHeads），
       左右两侧同源一次渲染，落页变化时不会一边已换新节、一边还挂旧节。 */
    const header = document.createElement('header')
    header.style.left = geo.mX + 'px'
    header.style.right = geo.mX + 'px'
    if (pi < meta.tocCount) {
      header.className = 'page-header ph-toc'
      const hCenter = document.createElement('span')
      hCenter.className = 'ph-center'
      hCenter.textContent = '目录'
      header.appendChild(hCenter)
    } else {
      const even = (pi + 1) % 2 === 0 // 以连续的物理页码定左右开
      header.className = 'page-header ' + (even ? 'ph-even' : 'ph-odd')
      const hLeft = document.createElement('span')
      hLeft.className = 'ph-left'
      const hRight = document.createElement('span')
      hRight.className = 'ph-right'
      if (even) {
        hLeft.textContent = meta.title
        hLeft.classList.add('ph-book')
      } else {
        hRight.textContent = meta.sectionHeads[pi - meta.tocCount] || ''
        hRight.classList.add('ph-sec')
      }
      header.append(hLeft, hRight)
    }

    const body = document.createElement('div')
    body.className = 'page-body doc-flow'
    body.style.height = geo.contentH + 'px'

    const footer = document.createElement('footer')
    footer.className = 'page-footer'
    footer.style.left = geo.mX + 'px'
    footer.style.right = geo.mX + 'px'
    const num = document.createElement('span')
    num.className = 'pf-num'
    num.textContent = `第 ${pi + 1} 页 / 共 ${total} 页`
    footer.appendChild(num)

    /* 正文：块直接搬入；行单元按段落重新包一层 <p> */
    let wrap = null, wrapPara = null
    for (const u of pg.items) {
      if (u.kind === 'block') {
        body.appendChild(u.el)
        wrap = null; wrapPara = null
      } else {
        if (wrapPara !== u.paraEl) {
          wrap = u.paraEl.cloneNode(false) // 复制标签与 class，不带子节点
          wrap.removeAttribute('id')
          wrap.style.marginBottom = '0'
          body.appendChild(wrap)
          wrapPara = u.paraEl
        }
        wrap.appendChild(u.el)
        if (u.idx === u.total - 1) wrap.style.marginBottom = '' // 段末恢复段距
      }
    }

    /* 脚注区：锚定在页底边距上方 */
    if (pg.fns.length) {
      const fnsEl = document.createElement('div')
      fnsEl.className = 'page-fns'
      fnsEl.style.left = geo.mX + 'px'
      fnsEl.style.right = geo.mX + 'px'
      fnsEl.style.bottom = geo.mB + 'px'
      const sep = document.createElement('div')
      sep.className = 'fn-sep'
      fnsEl.appendChild(sep)
      for (const k of pg.fns) {
        const d = document.createElement('div')
        d.className = 'fn-item'
        const no = document.createElement('span')
        no.className = 'fn-no'
        no.textContent = meta.fnNum.get(k) + '.'
        const tx = document.createElement('span')
        tx.className = 'fn-tx'
        tx.innerHTML = meta.defs.get(k) || ''
        d.append(no, tx)
        fnsEl.appendChild(d)
      }
      page.append(header, body, fnsEl, footer)
    } else {
      page.append(header, body, footer)
    }

    frag.appendChild(page)
  })
  return frag
}
