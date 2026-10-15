#!/usr/bin/env node
/**
 * Composer undo/redo regression harness (real Chromium).
 *
 * Why this exists: pi-app's composer is a contenteditable. Chromium's native
 * undo/redo only tracks edits the browser performs itself. If the app
 * intercepts a paste and inserts text programmatically (manual DOM mutation or
 * JS `execCommand('insertText')`), the undo stack is poisoned — the next
 * Ctrl+Z wipes the WHOLE editor content, including text typed before the
 * paste. See doc/CONTEXT.md「composer 撤销」decision record.
 *
 * This harness loads the real RichInput, attachment hook and composer DOM helpers:
 *   - `--policy=native` (default): text pastes use the browser's plain-text
 *     editing mode (undoable); file/image pastes use the real attachment hook.
 *   - `--policy=manual` (the old, broken behavior): every paste is
 *     preventDefault'ed and inserted with manual DOM mutation.
 * It then asserts the undo/redo guarantees. It is not wired into CI because it
 * needs a Playwright Chromium download; run it before/after composer input
 * changes:
 *
 *   node scripts/regression/composer-undo.mjs          # fixed policy
 *   node scripts/regression/composer-undo.mjs --policy=manual   # old policy (must FAIL)
 */
import { chromium } from 'playwright'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const policy = process.argv.includes('--policy=manual') ? 'manual' : 'native'
const root = fileURLToPath(new URL('../../', import.meta.url))
const editorBundle = await build({
  stdin: {
    contents: `
      import { createElement, useRef } from 'react'
      import { createRoot } from 'react-dom/client'
      import { flushSync } from 'react-dom'
      import { RichInput } from './src/renderer/src/features/composer/rich-input'
      import { insertTextAtCursor } from './src/renderer/src/features/composer/composer-editor-caret'
      import { insertAttachmentAtCursor, renderRichTextFromPlain, renderRichFromSegments, serializeRichInput, placeCaretAtEnd } from './src/renderer/src/features/composer/attachments'
      import { useComposerAttachments } from './src/renderer/src/features/composer/use-composer-attachments'
      Object.assign(window, {
        insertTextAtCursor, insertAttachmentAtCursor, renderRichTextFromPlain, renderRichFromSegments, serializeRichInput, placeCaretAtEnd,
        insertChipAtCursor: el => insertAttachmentAtCursor(el, { path: '/x', name: '[chip]', kind: 'file' }),
      })
      function Editor() {
        const editorRef = useRef(null)
        const dragDepth = useRef(0)
        const { handlePaste } = useComposerAttachments({
          editorRef, dragDepth, updateFromEditor: () => {}, canCompose: true, canSendMessages: true,
          currentWorkspace: '/workspace', ephemeralSandboxDraft: false, setIsDragActive: () => {},
        })
        const onPaste = ${JSON.stringify(policy)} === 'manual' ? e => {
          const plain = e.clipboardData.getData('text/plain')
          if (plain) {
            e.preventDefault()
            insertTextAtCursor(editorRef.current, plain)
          }
        } : handlePaste
        return createElement(RichInput, {
          ref: el => { editorRef.current = el; if (el) el.id = 'input' },
          placeholder: 'Message or / command',
          onKeyDown: e => { if (e.key === 'Enter' && !e.shiftKey) e.preventDefault() },
          onPaste,
        })
      }
      flushSync(() => createRoot(document.getElementById('root')).render(createElement(Editor)))
    `,
    resolveDir: root,
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  format: 'iife',
  jsx: 'automatic',
  alias: { '@renderer': `${root}src/renderer/src`, '@shared': `${root}packages/shared` },
  define: { 'process.env.NODE_ENV': '"development"' },
})

const PAGE = `<!doctype html>
<html><head><style>
  #input { position: relative; white-space: pre-wrap; word-break: break-word; min-height: 2.5rem; max-height: 112px; overflow-y: auto; font-size: 14px; line-height: 1.55; outline: none; }
  #input.is-empty::before { content: attr(data-placeholder); position: absolute; top: 0; left: 0; pointer-events: none; }
</style></head>
<body>
  <div id="root"></div>
  <script>${editorBundle.outputFiles[0].text}</script>
</body></html>`

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end(PAGE)
})
server.listen(8415)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
function check(name, actual, expected) {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got ${JSON.stringify(actual)}${ok ? '' : `, expected ${JSON.stringify(expected)}`}`)
}

async function text(page) {
  return page.evaluate(() => document.getElementById('input').innerText)
}
async function ctrlZ(page, n = 1) { for (let i = 0; i < n; i++) { await page.keyboard.press('Control+z'); await sleep(40) } }
async function ctrlY(page, n = 1) { for (let i = 0; i < n; i++) { await page.keyboard.press('Control+y'); await sleep(40) } }
async function typeSlow(page, t) { for (const ch of t) { await page.keyboard.type(ch); await sleep(120) } }
async function pasteText(page, txt, html) {
  // 真实剪贴板 + 键盘触发：原生插入只对 trusted paste 生效（合成 ClipboardEvent 会被忽略）。
  await page.evaluate(async ({ txt, html }) => {
    if (html === undefined) return navigator.clipboard.writeText(txt)
    await navigator.clipboard.write([new ClipboardItem({
      'text/plain': new Blob([txt], { type: 'text/plain' }),
      'text/html': new Blob([html], { type: 'text/html' }),
    })])
  }, { txt, html })
  await page.keyboard.press('Control+v')
  await sleep(80)
}

async function scenario(name, fn) {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH })
  const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await ctx.newPage()
  await page.goto('http://127.0.0.1:8415/')
  await page.evaluate(() => document.getElementById('input').focus())
  console.log(`\n--- ${name} [policy=${policy}] ---`)
  await fn(page)
  await ctx.close()
  await browser.close()
}

console.log(`\n== composer undo regression (policy=${policy}) ==`)
await scenario('undo after paste must not wipe text typed before it', async (page) => {
  await typeSlow(page, 'abc')
  await sleep(300)
  await pasteText(page, 'hello world')
  check('paste result', await text(page), 'abchello world')
  await ctrlZ(page)
  // 核心回归：撤销只删粘贴的部分，不得清空整个输入（旧策略会整段清空）。
  check('after Ctrl+Z (typed text must survive)', await text(page), 'abc')
  await ctrlZ(page)
  check('after Ctrl+Z x2 (typing undone)', await text(page), '')
  await ctrlY(page)
  check('after Ctrl+Y (redo restores typing)', await text(page), 'abc')
})

await scenario('paste into empty editor must be undoable', async (page) => {
  await pasteText(page, 'hello world')
  check('paste result', await text(page), 'hello world')
  await ctrlZ(page)
  check('after Ctrl+Z (paste removed)', await text(page), '')
  await ctrlY(page)
  check('after Ctrl+Y (paste restored)', await text(page), 'hello world')
})

await scenario('multi-line paste into text keeps undo granularity', async (page) => {
  await typeSlow(page, 'prefix ')
  await sleep(300)
  await pasteText(page, 'line1\nline2\nline3')
  check('paste result', await text(page), 'prefix line1\nline2\nline3')
  await ctrlZ(page)
  check('after Ctrl+Z (only paste undone)', await text(page), 'prefix ')
  await ctrlZ(page)
  check('after Ctrl+Z x2 (typing undone)', await text(page), '')
})

await scenario('GitHub log HTML must paste as plain text with native undo/redo', async (page) => {
  const log = 'build started\n  compiling sources\n\nbuild complete'
  const html = `<div class="js-check-step-line CheckStep-line d-flex">
    <div></div>
    <span class="CheckStep-line-content">
      <span>build started</span>
    </span>
  </div>
  <div><div></div><span><span>  compiling sources</span></span></div>
  <div><div></div><span><br></span></div>
  <div><div></div><span><span>build complete</span></span></div>`
  await typeSlow(page, 'prefix ')
  await sleep(300)
  await pasteText(page, log, html)
  check('visible log preserves indentation and intentional blank lines', await text(page), `prefix ${log}`)
  check('serialized log matches plain clipboard text', await page.$eval('#input', el => serializeRichInput(el).displayText), `prefix ${log}`)
  check('webpage wrappers are absent', await page.locator('#input span, #input div').count(), 0)
  check('rich editing is restored', await page.$eval('#input', el => el.contentEditable), 'true')
  await ctrlZ(page)
  check('undo preserves text typed before the HTML paste', await text(page), 'prefix ')
  await ctrlY(page)
  check('redo restores the plain log', await text(page), `prefix ${log}`)
  await page.evaluate(() => insertChipAtCursor(document.getElementById('input')))
  check('attachment insertion still works after HTML paste', await page.locator('.rich-attachment-chip').count(), 1)
  await ctrlZ(page)
  check('undo removes only the attachment', await text(page), `prefix ${log}`)
})

await scenario('HTML paste replaces a selection beside an existing attachment', async (page) => {
  await typeSlow(page, 'before ')
  await page.evaluate(() => insertChipAtCursor(document.getElementById('input')))
  await typeSlow(page, ' replace me')
  const beforePaste = await text(page)
  await page.keyboard.press('Shift+Home')
  // Select only the suffix, leaving the attachment outside the pasted range.
  await page.evaluate(() => {
    const el = document.getElementById('input')
    const suffix = el.lastChild
    const range = document.createRange()
    range.setStart(suffix, suffix.textContent.indexOf('replace me'))
    range.setEnd(suffix, suffix.textContent.length)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await pasteText(page, 'line1\nline2', '<div>line1</div>\n  <div>line2</div>')
  check('existing attachment survives the paste', await page.locator('.rich-attachment-chip').count(), 1)
  check('selection is replaced with the plain text', await text(page), beforePaste.replace('replace me', 'line1\nline2'))
  await ctrlZ(page)
  check('undo restores the selected suffix and attachment', await text(page), beforePaste)
  check('existing attachment survives undo', await page.locator('.rich-attachment-chip').count(), 1)
  await ctrlY(page)
  check('redo restores the replacement', await text(page), beforePaste.replace('replace me', 'line1\nline2'))
})

await scenario('chip insert must be undoable without wiping text', async (page) => {
  await typeSlow(page, 'before ')
  await sleep(300)
  await page.evaluate(() => {
    const el = document.getElementById('input')
    const sel = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(el); range.collapse(false)
    sel.removeAllRanges(); sel.addRange(range)
    insertChipAtCursor(el)
  })
  check('chip present', await page.evaluate(() => !!document.querySelector('.rich-attachment-chip')), true)
  await ctrlZ(page)
  check('after Ctrl+Z (chip removed, text survives)', await text(page), 'before ')
  await ctrlZ(page)
  check('after Ctrl+Z x2 (typing undone)', await text(page), '')
})

await scenario('native Shift+Enter newline stays undoable', async (page) => {
  await typeSlow(page, 'ab')
  await sleep(300)
  await page.keyboard.press('Shift+Enter')
  await sleep(200)
  await typeSlow(page, 'cd')
  check('content', await text(page), 'ab\ncd')
  // Chromium 把整段输入（含 Shift+Enter）合并为一个原生撤销记录；保证可重做即可。
  await ctrlZ(page)
  check('after Ctrl+Z (session undone)', await text(page), '')
  await ctrlY(page)
  check('after Ctrl+Y (session restored)', await text(page), 'ab\ncd')
})

async function caretAtStart(page) {
  return page.evaluate(() => {
    const el = document.getElementById('input')
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount) return false
    const r = sel.getRangeAt(0)
    const first = el.firstChild
    if (!first) return true
    if (first.nodeType !== Node.TEXT_NODE) return false
    return r.startContainer === first && r.startOffset === 0
  })
}

await scenario('arrow keys must move across every line (paste with newlines)', async (page) => {
  await typeSlow(page, 'abc')
  await sleep(300)
  await pasteText(page, 'line1\nline2\nline3')
  check('paste result', await text(page), 'abcline1\nline2\nline3')
  // 从末尾一路 ← 到底，确认原生换行文本不会让光标在行首卡住。
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('ArrowLeft')
    await sleep(40)
  }
  check('caret reaches the very start', await caretAtStart(page), true)
})

await scenario('arrow keys must move across every line (history-restore DOM)', async (page) => {
  await page.evaluate(() => {
    const el = document.getElementById('input')
    renderRichTextFromPlain(el, 'l1\nl2\nl3\nl4')
    placeCaretAtEnd(el)
  })
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('ArrowLeft')
    await sleep(40)
  }
  check('caret reaches the very start', await caretAtStart(page), true)
})

await scenario('deleting all text must not create a phantom first line', async (page) => {
  await typeSlow(page, 'a')
  await page.keyboard.press('Backspace')
  await page.waitForFunction(() => document.getElementById('input').classList.contains('is-empty'))
  check('empty editor stays one line', await page.$eval('#input', (el) => el.innerHTML), '<br>')
  for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace')
  await page.keyboard.type('next')
  check('next text starts on the first line', await text(page), 'next')
})

await scenario('Backspace removes restored leading and trailing blank lines', async (page) => {
  for (const restore of ['renderRichTextFromPlain', 'renderRichFromSegments']) {
    await page.evaluate((name) => {
      const el = document.getElementById('input')
      if (name === 'renderRichTextFromPlain') renderRichTextFromPlain(el, '\n')
      else renderRichFromSegments(el, [{ type: 'text', text: '\n' }])
      placeCaretAtEnd(el)
    }, restore)
    await page.waitForFunction(() => !document.getElementById('input').classList.contains('is-empty'))
    check(`${restore}: blank line is preserved`, await page.$eval('#input', (el) => serializeRichInput(el).displayText), '\n')
    await page.keyboard.press('Backspace')
    await page.keyboard.type('first')
    check(`${restore}: one Backspace removes the blank line`, await text(page), 'first')
  }
  await page.evaluate(() => {
    const el = document.getElementById('input')
    renderRichTextFromPlain(el, 'before\n')
    placeCaretAtEnd(el)
  })
  await page.keyboard.type('after')
  check('typing after a restored trailing newline stays on the next line', await text(page), 'before\nafter')
  await page.keyboard.press('Home')
  await page.keyboard.press('Backspace')
  check('Backspace merges the lines', await text(page), 'beforeafter')
})

server.close()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
