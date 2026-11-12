const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
async function fixture(enabled=true) {
 const {watchReadingHighlightSelection}=await import('../src/services/readingHighlightSelection.js')
 const listeners=new Map();let selection={rangeCount:1,isCollapsed:false,text:'selected word'},captures=0,toolbarFocused=false
 const doc={activeElement:{},getSelection:()=>selection,addEventListener:(e,f)=>listeners.set(e,f),removeEventListener:(e,f)=>{if(listeners.get(e)===f)listeners.delete(e)}}
 const watcher=watchReadingHighlightSelection({document:doc,capture:()=>captures++,toolbar:()=>({contains:()=>toolbarFocused}),enabled})
 return {watcher,listeners,emit:e=>listeners.get(e)?.(),get captures(){return captures},collapse:()=>selection={rangeCount:0,isCollapsed:true},focusToolbar:()=>toolbarFocused=true,select:()=>selection={rangeCount:1,isCollapsed:false}}
}
test('delayed native selection enables capture without a touchend or mouseup',async()=>{
 const f=await fixture();f.emit('selectionchange');assert.equal(f.captures,1);f.watcher.dispose()
})
test('moving native selection handles refreshes the current range',async()=>{
 const f=await fixture();for(let i=0;i<4;i++)f.emit('selectionchange');assert.equal(f.captures,4);f.watcher.dispose()
})
test('touch toolbar activation retains the pending range when browser collapses selection',async()=>{
 const f=await fixture();f.emit('selectionchange');f.watcher.beginAction({pointerType:'touch',preventDefault(){throw Error('Touch must stay native')}});f.collapse();f.emit('selectionchange');assert.equal(f.captures,1)
 f.watcher.finishAction();f.emit('selectionchange');assert.equal(f.captures,2);f.watcher.dispose()
})
test('mouse toolbar press preserves selection without stealing focus',async()=>{
 const f=await fixture();let prevented=false;f.watcher.beginAction({pointerType:'mouse',preventDefault(){prevented=true}});assert.equal(prevented,true);f.watcher.dispose()
})
test('keyboard focus in toolbar retains a collapsed passage range',async()=>{
 const f=await fixture();f.focusToolbar();f.collapse();f.emit('selectionchange');assert.equal(f.captures,0);f.watcher.dispose()
})
test('a new noncollapsed selection is still captured while toolbar has focus',async()=>{
 const f=await fixture();f.focusToolbar();f.emit('selectionchange');assert.equal(f.captures,1);f.watcher.dispose()
})
test('unrelated collapsed selections still clear the pending passage selection',async()=>{
 const f=await fixture();f.collapse();f.emit('selectionchange');assert.equal(f.captures,1);f.watcher.dispose()
})
test('pointer cancellation ends the toolbar guard',async()=>{
 const f=await fixture();f.watcher.beginAction({pointerType:'touch'});f.collapse();f.emit('pointercancel');f.emit('selectionchange');assert.equal(f.captures,1);f.watcher.dispose()
})
test('submitted work installs no mutable selection listeners',async()=>{
 const f=await fixture(false);assert.equal(f.listeners.size,0);f.watcher.beginAction();f.watcher.dispose()
})
test('unmount disposes all handlers and queued gesture cleanup',async()=>{
 const f=await fixture();f.emit('pointerup');f.watcher.dispose();assert.equal(f.listeners.size,0);f.emit('selectionchange');assert.equal(f.captures,0)
})
test('Reading scopes watcher to current passage and editable attempt, retaining native text selection',()=>{
 const s=fs.readFileSync('src/pages/DoReading.jsx','utf8')
 assert.match(s,/enabled: Boolean\(reading\) && !submitted/)
 assert.match(s,/\}, \[reading, submitted\]\)/)
 assert.match(s,/ref=\{highlightToolbarRef\}/)
 assert.match(s,/onPointerDown=\{event => highlightSelectionWatcherRef.current\?\.beginAction\(event\)\}/)
 assert.match(s,/WebkitUserSelect: 'text'/)
 assert.match(s,/startBlock !== endBlock/)
})
