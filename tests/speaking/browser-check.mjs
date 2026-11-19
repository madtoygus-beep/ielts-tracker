// Local development smoke check. Uses an isolated Chrome CDP endpoint and synthetic audio only.
import fs from 'node:fs/promises'
const origin='http://127.0.0.1:5180'
const tabs=await(await fetch('http://127.0.0.1:9227/json')).json()
const ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl)
await new Promise(r=>ws.addEventListener('open',r,{once:true}))
let seq=0;const pending=new Map(),errors=[]
ws.addEventListener('message',e=>{const v=JSON.parse(e.data);if(v.id){const p=pending.get(v.id);pending.delete(v.id);if(v.error)p.reject(Error(v.error.message));else p.resolve(v.result)}else if(v.method==='Runtime.exceptionThrown')errors.push(v.params.exceptionDetails.exception?.description||v.params.exceptionDetails.text)})
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))})
const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
const wait=async expression=>{const end=Date.now()+45000;while(Date.now()<end){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,150))}throw Error(`Timed out: ${expression}`)}
const click=label=>evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)throw Error('Button unavailable: '+${JSON.stringify(label)});b.click()})()`)
const has=text=>`document.body.textContent.includes(${JSON.stringify(text)})`
await send('Runtime.enable');await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride',{width:1365,height:950,deviceScaleFactor:1,mobile:false})
await send('Page.navigate',{url:origin+'/speaking-preview'})
await wait(has('Öğretmen · Mock ayarı'))
await evaluate(`document.querySelector('input[type=checkbox]').click()`)
await wait(`document.querySelectorAll('textarea').length===14`)
await fs.mkdir('artifacts/speaking',{recursive:true})
let png=await send('Page.captureScreenshot',{format:'png'});await fs.writeFile('artifacts/speaking/editor.png',Buffer.from(png.data,'base64'))
await click('Öğrenci · pratik');await wait(has('Test microphone'));await click('Test microphone');await wait(`!!document.querySelector('audio')`);await click('Continue to questions');await wait(has('Ready to record'));await click('Sonraki kayıtta bağlantı hatası dene')
for(let i=0;i<3;i++){
  await click('● Start recording');await wait(has('Recording…'));await new Promise(r=>setTimeout(r,400));await click('■ Stop recording');await wait(has('Save answer & continue'));await click('Save answer & continue');if(i===0){await wait(has('Simulated connection failure'));await click('Retry saving / resume')}await wait(has(i===2?'Speaking submitted':'Ready to record'))
}
console.log('PASS: manual practice recording, failed-save recovery, saving and submission (synthetic audio)')
await click('Otomatik Mock');await wait(has('Test microphone'));await click('Test microphone');await wait(`!!document.querySelector('audio')`);await click('Start / resume Mock Speaking');await wait(has('Preparation time'));await wait(has('Speaking submitted'))
console.log('PASS: automatic Mock Part 1 → preparation → Part 2 → Part 3 → submission')
await click('Rapor / öğretmen notu');await wait(has('AI practice estimate'));await click('Listen to recording (00:01)');await wait(`!!document.querySelector('audio')`)
await evaluate(`document.querySelectorAll('input[type=number]').forEach((e,i)=>{const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(e,[6,6,5,5][i]);e.dispatchEvent(new Event('input',{bubbles:true}))})`)
await click('Save teacher evaluation');await wait(has('5.5'))
png=await send('Page.captureScreenshot',{format:'png'});await fs.writeFile('artifacts/speaking/report-desktop.png',Buffer.from(png.data,'base64'))
await send('Emulation.setDeviceMetricsOverride',{width:768,height:1024,deviceScaleFactor:1,mobile:true})
png=await send('Page.captureScreenshot',{format:'png'});await fs.writeFile('artifacts/speaking/report-tablet.png',Buffer.from(png.data,'base64'))
if(await evaluate('document.documentElement.scrollWidth>window.innerWidth+1'))throw Error('Tablet horizontal overflow')
console.log('PASS: private audio playback UI, four-criterion teacher form, tablet layout')
console.log(JSON.stringify({runtimeErrors:errors}))
if(errors.length)process.exitCode=1
ws.close()
