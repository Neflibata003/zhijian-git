// 仅用于测试：通过 WebView2 调试端口驱动界面（生产版本不开启该端口）
export async function connect(port = 9222) {
  let list;
  for (let i = 0; i < 40; i++) { try { list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (list.some(t => t.type === 'page')) break; } catch {} await new Promise(r => setTimeout(r, 500)); }
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', m => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails)); return r.result.result.value; };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const waitFor = async (expr, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await ev(expr)) return true; } catch {} await sleep(150); } throw new Error('等待超时: ' + expr); };
  const click = (sel, text) => ev(`(()=>{const els=[...document.querySelectorAll(${JSON.stringify(sel)})];const el=${text ? `els.find(e=>e.textContent.includes(${JSON.stringify(text)}))` : 'els[0]'};if(!el)return false;el.click();return true})()`);
  const typeInto = (sel, value) => ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});const set=Object.getOwnPropertyDescriptor(el.constructor.prototype,'value').set;set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  const text = () => ev('document.body.innerText');
  return { ev, send, sleep, waitFor, click, typeInto, text, close: () => ws.close() };
}
