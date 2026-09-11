/* =========================================================
 * 分页引擎
 * 把源文（标题 / 正文段落 / 脚注）按给定页面几何切分为若干页。
 * 每页可排 1 栏或 2 栏：贪心顺序填充——左栏填满再填右栏，
 * 右栏也满才翻到下一页从左栏接着。
 *
 * 保证的约束：
 *  - 标题后至少跟随 KEEP_LINES 行正文（可跨短段落收集），否则标题链整体
 *    移到下一栏（keep-with-next 前瞻 + 栏尾兜底），栏底不留"标题加一行"
 *  - 段落跨栏 / 跨页时，栏（页）底与栏（页）首都至少保留 2 行
 *    （orphans / widows 控制）；行单元在与栏等宽的测量容器里自然断行，
 *    换栏只搬整条视觉行，不会把一个词切成两半
 *  - 脚注集中排在其引用所在【页】的底部，为整页两栏共用、横跨版心，
 *    同时压缩左右两栏的可用高度；引用行放不下时连同脚注一起后移
 *  - 旁注跟随被注句子所在的栏：句子在左栏注排左栏外侧，在右栏则排
 *    右栏外侧；同栏多条旁注纵向错开、互不重叠；锚点放不下时连同换栏
 *  - 表格只在行与行之间切开：放不下的行整体移到下一栏 / 下一页，
 *    续片重新渲染表头并加「续表」题注；正表与全部续片由同一次装箱产出
 *  - 内容或页面尺寸变化后整体重排，落栏、切开位置、页码全部重新计算
 * ========================================================= */
'use strict'

const A4_RATIO = 297 / 210
const FN_SEP_H = 20   // 脚注区分隔线的预留高度(px)
const KEEP_LINES = 2  // 标题后至少跟随的正文行数
const EPS = 0.5       // 高度比较容差(px)
const MN_GAP = 8      // 同栏两条旁注之间的最小垂直间距(px)
const MN_EDGE = 10    // 旁注到纸张外缘 / 版心外侧的间距(px)
const MIN_COL_W = 256 // 单栏最小宽度(px)：小于它则一栏排版

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)) }

/* 根据可用宽度计算页面几何（保持 A4 比例，宽度随窗口缩放）。
 * 两栏时左右页边对称（两栏外侧都可能挂旁注）；
 * 宽度不足以并排两个最小栏宽时退回一栏——一栏且有旁注时沿用
 * 不对称页边：内侧留给装订，外侧加宽放旁注，按物理页码奇偶分左右。 */
function pageGeometry(availWidth, hasMarginNotes = false) {
  const W = clamp(Math.floor(availWidth), 360, 794)
  const H = Math.round(W * A4_RATIO)
  const mT = clamp(Math.round(W * 0.080), 42, 64)
  const mB = clamp(Math.round(W * 0.075), 42, 60)

  /* 两栏试算：对称页边 + 栏间槽宽。两栏外侧都可能挂旁注，
   * 外侧边距取“够放一条窄旁注”的最小宽度，尽量还给栏宽。 */
  const mSide2 = hasMarginNotes
    ? clamp(Math.round(W * 0.120), 80, 98)
    : clamp(Math.round(W * 0.085), 34, 56)
  const gutter2 = clamp(Math.round(W * 0.030), 18, 28)
  const colW2 = Math.floor((W - 2 * mSide2 - gutter2) / 2)

  if (colW2 >= MIN_COL_W) {
    return {
      W, H, mT, mB, cols: 2,
      mInner: mSide2, mOuter: mSide2, mSide: mSide2,
      gutter: gutter2,
      noteW: hasMarginNotes ? mSide2 - MN_EDGE * 2 : 0,
      contentW: W - 2 * mSide2,
      colW: colW2,
      contentH: H - mT - mB,
    }
  }

  /* 一栏：原有几何（有旁注时奇偶不对称） */
  let mX, mInner, mOuter
  if (hasMarginNotes) {
    mInner = clamp(Math.round(W * 0.055), 28, 48)
    mOuter = clamp(Math.round(W * 0.155), 92, 116)
    mX = mInner
  } else {
    mX = clamp(Math.round(W * 0.085), 34, 56)
    mInner = mOuter = mX
  }
  const contentW = W - mInner - mOuter
  return {
    W, H, mT, mB, cols: 1,
    mX, mInner, mOuter,
    gutter: 0,
    noteW: Math.max(0, mOuter - MN_EDGE * 2),
    contentW,
    colW: contentW,
    contentH: H - mT - mB,
  }
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
 * 测量容器宽度与栏宽严格相等，因此抽离的整行搬入任意一栏都会
 * 复现同样的行断：换栏只搬整条视觉行，词不会被栏界切开。
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

  /* 一个旁注认它被注句子的视觉行：第一条视觉行为“锚点行”，其后仍属于
   * 该句的视觉行为“续行”。句子跨栏（页）断开时——开头在左栏底、后半截
   * 在右栏顶——锚点行所在栏挂原注，续行所在栏也要挂同一条注（续注），
   * 否则读者在续栏看到半句话却找不到说明。
   * 行内元素跨行时 DOM 形态不固定：有时 .ln 被放进 .mn 里面（旁注标记
   * 在祖先上），有时 .mn 在 .ln 里面（标记在后代上），还可能留下空壳；
   * 因此祖先链与后代都查，并要求该壳“有文字”才认。
   * 整段只有一个视觉行时 .ln 在 .mn 内部，同样靠祖先链识别。 */
  const anchored = new Set() // 已拿到锚点行的旁注 id
  for (const sp of kept) {
    const noteEls = [...sp.querySelectorAll('[data-mn-id]')]
    const ancestor = sp.closest && sp.closest('[data-mn-id]')
    if (ancestor) noteEls.unshift(ancestor)
    const uniq = []
    for (const n of noteEls) if (!uniq.includes(n)) uniq.push(n)

    const anchorIds = [], contIds = []
    for (const n of uniq) {
      const id = n.dataset.mnId
      if (!id || n.textContent.trim() === '') continue // 空壳不认
      if (!anchored.has(id)) { anchored.add(id); anchorIds.push(id) }
      else if (!contIds.includes(id)) contIds.push(id)
    }
    if (anchorIds.length) sp.dataset.mnIds = [...new Set(anchorIds)].join(',')
    if (contIds.length) sp.dataset.mnContIds = [...new Set(contIds)].join(',')
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

function mnKeys(el) {
  const nodes = el.hasAttribute && el.hasAttribute('data-mn-ids')
    ? [el]
    : (el.querySelectorAll ? el.querySelectorAll('[data-mn-id]') : [])
  return [...new Set(Array.from(nodes).flatMap(n =>
    (n.dataset.mnIds || n.dataset.mnId || '').split(',').filter(Boolean)
  ))]
}

/* 旁注锚点在单元内的纵向偏移；视觉行单元本身就是锚点行。
 * 用 TreeWalker 找到最深的行内标记，避免外层元素也带属性时取偏。 */
function mnAnchorOffset(unit) {
  if (unit.kind === 'line') return 0
  let node = null
  const walker = document.createTreeWalker(unit.el, NodeFilter.SHOW_ELEMENT)
  while (walker.nextNode()) {
    if (walker.currentNode.dataset.mnId) { node = walker.currentNode; break }
  }
  if (!node) return 0
  const top = unit.el.getBoundingClientRect().top
  return Math.max(0, node.getBoundingClientRect().top - top)
}

function blockUnit(el) {
  const cs = getComputedStyle(el)
  return {
    kind: 'block',
    el,
    height: el.getBoundingClientRect().height,
    tail: parseFloat(cs.marginBottom) || 0,
    refs: fnKeys(el),
    notes: mnKeys(el),
    keepNext: /^H[1-6]$/.test(el.tagName),
  }
}

/* ---------- 跨栏 / 跨页表 ----------
 * 表格按行展开为 trow 单元，装箱时只在行间断开（栏界与页界同理）。
 * 每个表的描述信息（表头行、列宽、首片/续片额外开销）在测量阶段一次量好：
 *  - 首片开销：表顶边到首根表体行上沿（上外边距 + 题注 + 全部表头行）
 *  - 续片开销：「续表」题注（无表头的表只有它）+ 重排的全部表头行
 * 两种开销都只在“一片的第一行”计一次，片内后续行只占自身行高。
 * 一个栏（页）底部排不下的行整行进下一栏（页），续片在新栏（页）
 * 顶部重排表头、标注「续表」；切开位置只存在于当次装箱结果，重排整盘作废。
 * 列宽在测量时读出并写入 <colgroup> + table-layout:fixed，保证正表与
 * 各续表列宽完全一致，不会因各片行数不同而重新分配列宽。
 */
const TBL_CONT = '续表'

/* 把题注暂时换成续页文本，量 fn()，再恢复；无题注则插一个临时题注。
 * 几何法量取可以顺带吃到题注上下边距与边框，不必逐项相加。 */
function withContinuationCaption(tbl, cap, fn) {
  let probe = cap
  const created = !cap
  if (created) {
    probe = document.createElement('caption')
    tbl.insertBefore(probe, tbl.firstChild)
  }
  const oldText = probe.textContent
  probe.textContent = cap && cap.textContent.trim()
    ? `${TBL_CONT}　${cap.textContent.trim()}`
    : TBL_CONT
  const v = fn()
  probe.textContent = oldText
  if (created) probe.remove()
  return v
}

/* 表 → 描述信息 + trow 单元序列 */
function tableUnits(tbl) {
  tbl.classList.add('doc-table') // 测量容器与渲染栏同一样式，行高才一致
  const capEl = tbl.querySelector(':scope > caption')

  /* 自然排版后读出各列实际宽度，归一化（取整余数补给最宽列），
   * 再锁定为 fixed 布局；之后每一片都用同一份列宽渲染 */
  const widthRow = Array.from(tbl.rows).reduce((a, r) =>
    r.cells.length > a.cells.length ? r : a, tbl.rows[0])
  const raw = Array.from(widthRow.cells)
    .map(c => c.getBoundingClientRect().width)
  let cols = raw.map(w => Math.max(1, Math.round(w)))
  const sum = cols.reduce((s, w) => s + w, 0)
  let maxI = 0
  cols.forEach((w, i) => { if (w > cols[maxI]) maxI = i })
  cols[maxI] += Math.round(widthRow.getBoundingClientRect().width) - sum

  let colgroup = tbl.querySelector('colgroup')
  if (!colgroup) {
    colgroup = document.createElement('colgroup')
    tbl.insertBefore(colgroup, tbl.firstChild)
  }
  colgroup.replaceChildren()
  cols.forEach(w => {
    const col = document.createElement('col')
    col.style.width = w + 'px'
    colgroup.appendChild(col)
  })
  tbl.style.tableLayout = 'fixed'
  tbl.style.width = cols.reduce((s, w) => s + w, 0) + 'px'

  /* 表头：<thead> 优先；否则首行全为 <th> 也算表头 */
  let headRows = []
  if (tbl.tHead) {
    headRows = Array.from(tbl.tHead.rows)
  } else if (tbl.rows[0] &&
             Array.from(tbl.rows[0].cells).every(c => c.tagName === 'TH')) {
    headRows = [tbl.rows[0]]
  }
  const headSet = new Set(headRows)
  const bodyRows = Array.from(tbl.rows).filter(r => !headSet.has(r))

  const cs = getComputedStyle(tbl)
  const mt = parseFloat(cs.marginTop) || 0
  const mb = parseFloat(cs.marginBottom) || 0

  /* 首片开销 = 表顶（含上外边距）到首根表体行上沿：
   * 有表头 → 上边框 + 题注 + 全部表头行；无表头 → 上边框 + 题注。
   * 注意必须取到“首根表体行上沿”，漏掉表头行会让首片实际渲染比计费高，
   * 落到快写满的栏（页）上时片底被切掉。 */
  const tblTop = tbl.getBoundingClientRect().top
  const firstOverhead = mt + (headRows.length
    ? headRows[headRows.length - 1].getBoundingClientRect().bottom - tblTop
    : bodyRows[0].getBoundingClientRect().top - tblTop)

  /* 续片开销 = 表顶到首根续行上沿之间的高度：
   * 有表头 → 「续表」题注 + 重排的全部表头行；无表头 → 只有「续表」题注。
   * 换上续片题注文本再量，加前缀可能让题注多占一行。 */
  const contOverhead = withContinuationCaption(tbl, capEl, () => {
    const topNow = tbl.getBoundingClientRect().top
    if (headRows.length) {
      return headRows[headRows.length - 1].getBoundingClientRect().bottom - topNow
    }
    return bodyRows.length
      ? bodyRows[0].getBoundingClientRect().top - topNow
      : 0
  })

  const id = ++tableUnits._seq
  const info = {
    id, el: tbl, cols, headRows: headRows.map(r => r.cloneNode(true)),
    caption: capEl ? capEl.textContent.trim() : '',
    firstOverhead, contOverhead, marginBottom: mb,
  }

  return bodyRows.map((tr, idx) => {
    const last = idx === bodyRows.length - 1
    return {
      kind: 'trow',
      el: tr,
      tbl: info,
      first: idx === 0,
      last,
      height: tr.getBoundingClientRect().height,
      tail: last ? mb : 0,
      refs: fnKeys(tr),
      notes: mnKeys(tr),
      keepNext: false,
    }
  })
}
tableUnits._seq = 0

/* 把文章子节点展开为装箱单元：段落 → 行单元序列，表格 → 表行单元序列
 * （可在行间断开），其余 → 整体块单元。
 * 测量宽度即栏宽：两栏时段落按栏宽断行，行单元搬入任一栏都贴合。 */
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
          notes: (sp.dataset.mnIds || '').split(',').filter(Boolean),
          contNotes: (sp.dataset.mnContIds || '').split(',').filter(Boolean),
          keepNext: false,
        })
      })
    } else if (el.tagName === 'TABLE' && el.rows.length) {
      const rows = tableUnits(el)
      if (rows.length) units.push(...rows)
      else units.push(blockUnit(el)) // 只有表头、没有表体行：作为整体块保留
    } else {
      units.push(blockUnit(el))
    }
  }
  return units
}

/* 在与页内脚注区同样式、等宽（整页版心宽，脚注两栏共用）的隐藏容器里
 * 测量每条脚注的高度 */
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

/* 在与旁注栏等宽的隐藏容器里测量每条旁注的高度 */
function measureMarginNotes(notes, noteW) {
  const host = document.createElement('div')
  host.className = 'measure-host margin-notes'
  host.style.width = noteW + 'px'
  document.body.appendChild(host)
  const map = new Map()
  for (const [id, html] of notes) {
    const aside = document.createElement('aside')
    aside.className = 'margin-note'
    aside.innerHTML = html
    host.appendChild(aside)
    map.set(id, aside.getBoundingClientRect().height)
  }
  host.remove()
  return map
}

/* ---------- 装箱 ----------
 * 贪心逐栏填充：左栏 → 右栏 → 翻页；脚注为整页共用，页底脚注区
 * 同时压缩两栏。脚注集合要等一页两栏都试排完才知道，因此每页按
 * “上一轮脚注集合预留 → 试排 → 用真实集合复核 → 不一致再试一轮”
 * 迭代到两栏都在共用脚注区之上收敛。
 * 栏尾断段做孤行 / 寡行回退；标题做 keep-with-next 前瞻；
 * 表行只在行间断行：本栏已出现过该表则片内续行无开销，
 * 否则整表首行带首片开销、续到新栏（页）的首行带续片开销。
 */
function paginateUnits(units, contentH, fnH, mnH = new Map(), colsN = 1) {
  const pages = []
  const placedFn = new Set()   // 已落在之前页的脚注
  let i = 0

  const fnHeightOf = k => fnH.get(k) || 0
  const sumH = keys => keys.reduce((s, k) => s + fnHeightOf(k), 0)
  const mnHeightOf = k => mnH.get(k) || 0

  /* 试排一页：从 i0 起顺序装 colsN 栏。
   * hint 为上一轮已确定会出现在本页的脚注键，两栏从一开始就为它们
   * 预留页底高度；返回各栏结果、结束下标与本页真实脚注集合。 */
  function packPage(i0, hint) {
    const cols = []
    let cursor = i0
    const pageFn = [] // 本页脚注（跨栏去重，按文档顺序）
    for (const k of hint) if (!pageFn.includes(k)) pageFn.push(k)

    /* 表行落在一栏中的额外高度，只在“一片的第一行”计一次：
     * 该表本栏第一行是整表首行 → 首片开销（题注 + 表头 + 表顶）；
     * 是从上栏 / 上页续过来的首行 → 续片开销（「续表」+ 重排表头）；
     * 本栏已有同表的行（同一片继续）→ 0，行只占自身高度。 */
    const rowOverhead = (u, list) => {
      if (u.kind !== 'trow') return 0
      const onCol = list.some(x => x.kind === 'trow' && x.tbl === u.tbl)
      if (onCol) return 0
      return u.first ? u.tbl.firstOverhead : u.tbl.contOverhead
    }
    const freshOf = u =>
      u.refs.filter(k => !placedFn.has(k) && !pageFn.includes(k))
    /* 页底脚注区高度：本栏已见脚注 + 候选新脚注，隔线只占一次 */
    const fnAreaFor = extraKeys => {
      const all = pageFn.slice()
      for (const k of extraKeys) if (!all.includes(k)) all.push(k)
      return all.length ? FN_SEP_H + sumH(all) : 0
    }

    /* 计算一栏（可带候选单元）的正文占用与旁注纵向落位。
     * 旁注脱离正文流、不增加行高，但锚点注必须与首句同栏，且同栏多条旁注
     * 之间要相互错开；capText 为扣除整页共用脚注区后的栏正文可用高。
     * side 为本栏在页上的位置（左 / 右），旁注挂该栏外侧。
     *
     * 两类旁注：
     *  - 锚点注（cont=false）：句子第一条视觉行所在栏，放不下要连同句子换栏；
     *  - 续注（cont=true）：句子跨栏断开后，续行所在栏也显示同一条注。
     *    同栏内同一 id 既是锚点又有续行时只留锚点；续注不驱动换栏，只贴在
     *    续行旁，参与同栏碰撞消除（必要时让位于锚点注）。 */
    function columnLayout(items, side, extras, capText) {
      const all = items.concat(extras)
      let used = 0
      const countedTables = new Set()
      const wanted = []
      const pushWanted = (id, cont, y) => {
        const ex = wanted.find(n => n.id === id)
        if (ex) { if (!cont) ex.cont = false } // 锚点优先于续注
        else wanted.push({ id, cont, y })
      }
      for (let idx = 0; idx < all.length; idx++) {
        const u = all[idx]
        const overhead = rowOverhead(u, all.slice(0, idx))
        if (u.kind === 'trow' && !countedTables.has(u.tbl.id)) {
          countedTables.add(u.tbl.id)
          used += overhead
        }
        for (const id of u.notes || []) {
          pushWanted(id, false, used + overhead + mnAnchorOffset(u))
        }
        for (const id of u.contNotes || []) {
          pushWanted(id, true, used + overhead + mnAnchorOffset(u))
        }
        used += u.height + u.tail
      }

      const place = w => {
        const h = mnHeightOf(w.id)
        return { id: w.id, cont: w.cont, h, side,
                 y: clamp(w.y, 0, Math.max(0, capText - h)) }
      }

      /* 锚点注：先按锚点落下，再从上往下顺推；最后一条超出栏底时整簇上移。
       * 双向错开：相邻底+缝 ≤ 下一条顶，避免后加的注塞进更早两条之间。
       * 整簇比一栏还高时 optimal=false，调用方让锚点行换到新栏。 */
      const anchors = wanted.filter(w => !w.cont).map(place)
      anchors.sort((a, b) => a.y - b.y ||
        wanted.findIndex(w => w.id === a.id) - wanted.findIndex(w => w.id === b.id))
      for (let k = 1; k < anchors.length; k++) {
        const minY = anchors[k - 1].y + anchors[k - 1].h + MN_GAP
        if (anchors[k].y < minY - EPS) anchors[k].y = minY
      }
      let optimal = true
      if (anchors.length) {
        const overflow = anchors[anchors.length - 1].y + anchors[anchors.length - 1].h - capText
        if (overflow > EPS) for (const n of anchors) n.y -= overflow
        if (anchors[0].y < -EPS) {
          optimal = false
          const lift = -anchors[0].y
          for (const n of anchors) n.y += lift
        }
      }

      /* 续注：贴各自的续行落下，只在锚点注（位置固定不动）与其它续注之间
       * 避让；续注不参与 optimal。做法：按 y 顺序把每条续注压到“其上方
       * 最近的遮挡物（锚点注或已落位续注）底 + 缝”之下；若最末条越过栏底，
       * 只把续注簇整体上移（不牵动锚点注）。极端密度下续注可能与锚点贴紧，
       * 但同一条说明在续栏始终可见。 */
      const conts = wanted.filter(w => w.cont).map(place)
      conts.sort((a, b) => a.y - b.y)
      for (const nt of conts) {
        let minY = 0
        for (const fx of anchors) {
          if (fx.y <= nt.y + EPS) minY = Math.max(minY, fx.y + fx.h + MN_GAP)
        }
        for (const other of conts) {
          if (other === nt) break // 已按 y 排序，前面的都是上方续注
          minY = Math.max(minY, other.y + other.h + MN_GAP)
        }
        if (nt.y < minY - EPS) nt.y = minY
      }
      if (conts.length) {
        const overflow = conts[conts.length - 1].y + conts[conts.length - 1].h - capText
        if (overflow > EPS) {
          for (const nt of conts) nt.y = Math.max(0, nt.y - overflow)
          // 上移后重新对锚点注与彼此让位一次，避免压到固定锚点
          for (const nt of conts) {
            let minY = 0
            for (const fx of anchors) {
              if (fx.y <= nt.y + EPS) minY = Math.max(minY, fx.y + fx.h + MN_GAP)
            }
            for (const other of conts) { if (other === nt) break; minY = Math.max(minY, other.y + other.h + MN_GAP) }
            if (nt.y < minY - EPS) nt.y = minY
          }
        }
      }
      const layouts = anchors.concat(conts)
      return { used, layouts, optimal }
    }

    for (let c = 0; c < colsN; c++) {
      const side = c === 0 ? 'left' : 'right'
      const items = []
      let closed = false

      while (cursor < units.length && !closed) {
        const u = units[cursor]
        const nrefs = freshOf(u)
        const cap = contentH - fnAreaFor(nrefs)
        const trial = columnLayout(items, side, [u], cap)

        /* keep-with-next：标题（及其后连续标题）+ 下一段至少 KEEP_LINES 行
         * 必须同栏。前瞻若首次把某张表带入本栏，要把该表首片开销一起算；
         * 标题与跟随文字所带的旁注也一并试排，不能只让正文同栏。 */
        let keepFail = false
        if (u.keepNext && items.length) {
          const seen = nrefs.slice()
          const ahead = []
          const aheadNotes = (u.notes || []).slice()
          const addLook = w => {
            for (const k of freshOf(w)) if (!seen.includes(k)) seen.push(k)
            for (const id of w.notes || []) if (!aheadNotes.includes(id)) aheadNotes.push(id)
            ahead.push(w)
          }
          let j = cursor + 1
          while (j < units.length && units[j].kind === 'block' && units[j].keepNext) {
            addLook(units[j]); j++
          }
          /* 再向后收集 KEEP_LINES 行正文（可跨短段落）；遇到整体块或表行
           * 则要求该块 / 该行所在表片本身同栏（表首行自带首片开销） */
          let gathered = 0
          while (j < units.length && gathered < KEEP_LINES) {
            const w = units[j]
            addLook(w)
            if (w.kind === 'line') { gathered++; j++ } else break
          }
          const kcap = contentH - fnAreaFor(seen)
          const keepLayout = columnLayout(items, side, [u, ...ahead], kcap)
          if (keepLayout.used > kcap + EPS || !keepLayout.optimal) keepFail = true
        }

        const fits = trial.used <= cap + EPS && trial.optimal
        if ((fits || items.length === 0) && !(keepFail && items.length > 0)) {
          items.push(u)
          for (const k of nrefs) if (!pageFn.includes(k)) pageFn.push(k)
          cursor++
        } else {
          /* 段落被栏界截断时的孤行/寡行回退。表行不在此处回退——它只能
           * 在行间断，本栏已有的行留下，新行整片去续片。 */
          if (u.kind === 'line' && u.idx > 0) {
            const total = u.total, k = u.idx // 本栏已放 k 行
            let pop = 0
            if (total <= 3) pop = k             // 短段不拆，整体后移
            else if (k === 1) pop = 1           // 栏底不留单行
            else if (total - k === 1) pop = 1   // 栏首不留单行
            let popped = 0
            while (popped < pop && items.length) {
              const last = items[items.length - 1]
              if (last.kind !== 'line' || last.paraEl !== u.paraEl) break
              items.pop(); popped++
            }
            if (popped) cursor -= popped
          }
          closed = true
        }
      }

      /* 栏尾兜底：若一栏以“标题链 + 不足 n 行正文（n < KEEP_LINES）”收尾，
       * 把标题链连同那点正文一起弹回，下一栏（页）从它们接着排。
       * 标题链就在栏首时退无可退，保留现状。 */
      const end = items.length
      let k = end - 1
      let bodyLines = 0
      while (k >= 0 && items[k].kind === 'line') { bodyLines++; k-- }
      if (bodyLines < KEEP_LINES) {
        let h = k
        while (h >= 0 && items[h].kind === 'block' && items[h].keepNext) h--
        if (!(h === k || h < 0)) {
          const popCount = end - (h + 1)
          items.length = h + 1
          cursor -= popCount
        }
      }

      /* 脚注区以最终落栏单元为准重算一次，给出本栏真实占用与旁注落位。
       * pageFn 可能含被兜底弹走、将落到后栏的脚注键——它们仍属本页，
       * 页底共用区照占高度，下一轮不动点会按最终集合收紧。 */
      const fin = columnLayout(items, side, [], contentH - fnAreaFor([]))
      cols.push({ items: items.slice(), used: fin.used, notes: fin.layouts })
    }

    /* 本页脚注：按文档顺序跨栏合并去重，并排除已落在之前页的脚注
     * （同一脚注被后文再次引用时不重复排印） */
    const allFns = []
    for (const col of cols) {
      for (const u of col.items) {
        for (const key of u.refs) {
          if (!placedFn.has(key) && !allFns.includes(key)) allFns.push(key)
        }
      }
    }
    return { cols, end: cursor, allFns }
  }

  for (;;) {
    if (i >= units.length) break
    let hint = new Set()
    let res = null
    let safe = null
    for (let pass = 0; pass < 8; pass++) {
      res = packPage(i, hint)
      const fnArea = res.allFns.length ? FN_SEP_H + sumH(res.allFns) : 0
      const ok = res.cols.every(c => c.used + fnArea <= contentH + EPS)
      const real = new Set(res.allFns)
      if (ok) {
        /* 多轮之间脚注集合理论上可能来回变化：留下“装得下且本页装得最多
         * （结束下标最小）”的一轮作为兜底 */
        if (!safe || res.end < safe.end) safe = res
        let same = real.size === hint.size
        if (same) for (const key of hint) if (!real.has(key)) { same = false; break }
        if (same) break
      }
      hint = real // 用本页真实脚注集合重新预留两栏高度，再试一轮
    }
    const chosen = safe || res
    pages.push({ cols: chosen.cols, fns: chosen.allFns.slice(), colsN })
    for (const key of chosen.allFns) placedFn.add(key)
    if (chosen.end <= i) break // 防御：理论上首栏强制落位保证总有进展
    i = chosen.end
  }
  return pages
}

/* ---------- 渲染 ---------- */

function renderPages(pages, geo, meta) {
  const frag = document.createDocumentFragment()
  const total = pages.length

  pages.forEach((pg, pi) => {
    const page = document.createElement('section')
    const even = (pi + 1) % 2 === 0 // 以连续的物理页码定左右开
    const two = pg.colsN === 2
    /* 两栏：左右页边对称（两栏外侧都要挂旁注）；
     * 一栏：按物理页码奇偶把 mOuter 分到左 / 右。 */
    const padL = two ? geo.mSide : (even ? geo.mOuter : geo.mInner)
    const padR = two ? geo.mSide : (even ? geo.mInner : geo.mOuter)
    page.className = 'page ' + (two ? 'cols-2' : 'cols-1')
    if (geo.noteW > 0) page.classList.add('has-mn', even ? 'even-page' : 'odd-page')
    page.id = 'p' + (pi + 1) // 目录条目的锚点目标
    page.style.width = geo.W + 'px'
    page.style.height = geo.H + 'px'
    page.style.padding = `${geo.mT}px ${padR}px ${geo.mB}px ${padL}px`

    /* 对开页眉：目录页只写「目录」；正文偶数页（左页）左外侧写书名、右侧留空，
       奇数页（右页）左侧留空、右外侧写本页所属小节名。
       归属小节由调用方从同一次分页结果逐页算好（meta.sectionHeads），
       左右两侧同源一次渲染，落页变化时不会一边已换新节、一边还挂旧节。 */
    const header = document.createElement('header')
    header.style.left = padL + 'px'
    header.style.right = padR + 'px'
    if (pi < meta.tocCount) {
      header.className = 'page-header ph-toc'
      const hCenter = document.createElement('span')
      hCenter.className = 'ph-center'
      hCenter.textContent = '目录'
      header.appendChild(hCenter)
    } else {
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

    /* 正文栏容器：两栏并排放置，栏宽与测量容器严格相等；
     * 一栏时只有一个栏，宽度即整页版心宽。 */
    const body = document.createElement('div')
    body.className = 'page-body'
    body.style.height = geo.contentH + 'px'
    if (two) body.style.gap = geo.gutter + 'px'

    const footer = document.createElement('footer')
    footer.className = 'page-footer'
    footer.style.left = padL + 'px'
    footer.style.right = padR + 'px'
    const num = document.createElement('span')
    num.className = 'pf-num'
    num.textContent = `第 ${pi + 1} 页 / 共 ${total} 页`
    footer.appendChild(num)

    /* 把一栏的装箱单元搬入栏元素：
     * 块直接搬入；行单元按段落重新包一层 <p>；
     * 表行按表片重组为 <table>——续片重排列宽 colgroup、表头与「续表」题注。
     * 所有表片都在这一次渲染里按装箱结果同步产出，重排时整盘替换，
     * 不会出现正表已按新切分翻栏 / 翻页、续表还停在旧切开位置的情况。 */
    const notesLayer = document.createElement('div')
    notesLayer.className = 'page-margin-notes'

    const fillColumn = (colEl, col, colIdx) => {
      let wrap = null, wrapPara = null
      let tblFrag = null
      const finishTable = () => {
        if (tblFrag && tblFrag.lastRow.last) tblFrag.el.style.marginBottom = '' // 末片恢复源表下外边距
        tblFrag = null
      }
      for (const u of col.items) {
        if (u.kind === 'trow') {
          if (!tblFrag || tblFrag.info !== u.tbl) {
            finishTable()
            const info = u.tbl
            const el = document.createElement('table')
            el.className = 'doc-table'
            el.style.width = info.cols.reduce((s, w) => s + w, 0) + 'px'
            el.style.marginBottom = '0' // 表未结束前，中间片不占段距
            const cg = document.createElement('colgroup')
            info.cols.forEach(w => {
              const colNode = document.createElement('col')
              colNode.style.width = w + 'px'
              cg.appendChild(colNode)
            })
            el.appendChild(cg)

            /* 题注：首片用原题注；续片改标「续表」。无表头的表靠这行题注
             * 标明续片身份；有表头的表也同步标注。 */
            const startedElsewhere = !u.first
            if (startedElsewhere) el.classList.add('continued')
            if (info.caption || startedElsewhere) {
              const cap = document.createElement('caption')
              cap.textContent = startedElsewhere
                ? (info.caption ? `${TBL_CONT}　${info.caption}` : TBL_CONT)
                : info.caption
              el.appendChild(cap)
            }
            if (info.headRows.length) {
              const thead = document.createElement('thead')
              info.headRows.forEach(r => thead.appendChild(r.cloneNode(true)))
              el.appendChild(thead)
            }
            const tbody = document.createElement('tbody')
            el.appendChild(tbody)
            colEl.appendChild(el)
            tblFrag = { info, el, tbody, lastRow: u }
          }
          tblFrag.tbody.appendChild(u.el) // tr 从测量容器移入，不复制
          tblFrag.lastRow = u
          wrap = null; wrapPara = null
          continue
        }

        finishTable()
        if (u.kind === 'block') {
          colEl.appendChild(u.el)
          wrap = null; wrapPara = null
        } else {
          if (wrapPara !== u.paraEl) {
            wrap = u.paraEl.cloneNode(false) // 复制标签与 class，不带子节点
            wrap.removeAttribute('id')
            wrap.style.marginBottom = '0'
            colEl.appendChild(wrap)
            wrapPara = u.paraEl
          }
          wrap.appendChild(u.el)
          if (u.idx === u.total - 1) wrap.style.marginBottom = '' // 段末恢复段距
        }
      }
      finishTable()

      /* 旁注：两栏时跟着被注句子走——句子（或其续行）在左栏，注排左栏
       * 外侧；在右栏则排右栏外侧；句子从左栏底续到右栏顶时，同一条注在
       * 两栏外侧各显示一次（右栏为弱化的续注 .mn-cont）。一栏退化为按
       * 物理页码奇偶排外侧，跨页续注同理。注与所属行同行坐标。 */
      for (const n of col.notes || []) {
        if (!meta.notes || !meta.notes.has(n.id)) continue
        const side = two ? (colIdx === 0 ? 'left' : 'right') : (even ? 'left' : 'right')
        const aside = document.createElement('aside')
        aside.className = 'margin-note ' + (side === 'left' ? 'mn-left' : 'mn-right') +
          (n.cont ? ' mn-cont' : '')
        aside.style.top = (geo.mT + n.y) + 'px'
        aside.style.width = geo.noteW + 'px'
        if (side === 'left') aside.style.left = MN_EDGE + 'px'
        else aside.style.right = MN_EDGE + 'px'
        aside.innerHTML = meta.notes.get(n.id) || ''
        notesLayer.appendChild(aside)
      }
    }

    for (let c = 0; c < pg.colsN; c++) {
      const colEl = document.createElement('div')
      colEl.className = 'page-col doc-flow'
      colEl.style.width = (two ? geo.colW : geo.contentW) + 'px'
      colEl.style.height = geo.contentH + 'px' // 固定栏高：溢出即说明装箱越界
      const col = pg.cols[c] || { items: [], notes: [] }
      fillColumn(colEl, col, c)
      body.appendChild(colEl)
    }

    /* 脚注区：锚定在页底边距上方，整页两栏共用、横跨整个版心 */
    if (pg.fns.length) {
      const fnsEl = document.createElement('div')
      fnsEl.className = 'page-fns'
      fnsEl.style.left = padL + 'px'
      fnsEl.style.right = padR + 'px'
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
      page.append(header, body, notesLayer, fnsEl, footer)
    } else {
      page.append(header, body, notesLayer, footer)
    }

    frag.appendChild(page)
  })
  return frag
}
