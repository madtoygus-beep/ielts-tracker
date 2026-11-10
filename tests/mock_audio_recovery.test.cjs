const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const src = fs.readFileSync('src/pages/DoMockTest.jsx','utf8')
const mod = () => import('../src/services/mockAudioRecovery.js')
function handler(name,next,context) {
 const start=src.indexOf(`  const ${name} =`)
 const end=src.indexOf(`\n  const ${next} =`,start)
 assert.ok(start>0&&end>start)
 return vm.runInNewContext(`${src.slice(start,end)}\n${name}`,context)
}
function context(time=127.5,duration=600) {
 const events=[],timers=[]
 const c={events,timers,audioRef:{current:{currentTime:0,duration,play(){events.push(['play',this.currentTime]);return Promise.resolve()},pause(){events.push(['pause'])}}},
 audioLastTimeRef:{current:time},audioPlaybackStartedRef:{current:true},audioStreamFailedRef:{current:false},
 audioSeekLockRef:{current:false},pendingAudioRestoreRef:{current:{time,shouldResume:true}},
 listeningLocked:false,audioLocked:false,audioStarted:true,audioResumePending:true,audioDuration:duration,
 window:{setTimeout:fn=>timers.push(fn)},setTimeout:fn=>timers.push(fn)}
 for(const k of ['setAudioDuration','setAudioCurrentTime','setAudioLocked','setAudioResumePending','setAudioStarted','setAudioWarning'])c[k]=v=>events.push([k,v])
 return c
}
test('temporary zero/unmounted media cannot erase heard progress',async()=>{
 const {mockAudioCheckpoint:f}=await mod()
 assert.equal(f(0,127.5),127.5);assert.equal(f(undefined,127.5,128),128)
 assert.equal(f(130,127.5),130);assert.equal(f(NaN,127.5),127.5)
})
test('resume preserves the last heard position without advancing through downtime',async()=>{
 const {savedMockAudioPosition:f}=await mod()
 assert.deepEqual(f({audioCurrentTime:127.5,audioDuration:600,updatedAt:'2000-01-01'}),{time:127.5,duration:600})
 assert.deepEqual(f({audioCurrentTime:127.5,audioDuration:60}),{time:127.5,duration:60})
 assert.deepEqual(f({audioCurrentTime:-1,audioDuration:Infinity}),{time:0,duration:0})
 assert.doesNotMatch(src,/restoredAudioTime\s*\+=\s*elapsedSinceSave/)
 assert.match(src,/saved\.listeningTimeLeft[\s\S]{0,90}-\s*elapsedSinceSave/)
})
test('new playback streams but resume downloads a complete seekable object',async()=>{
 const {shouldUseProgressiveMockAudio:f}=await mod()
 assert.equal(f(0,null),true);assert.equal(f(127,null),false)
 assert.equal(f(0,{time:0,shouldResume:false}),false)
})
test('metadata restores saved position before calling play',()=>{
 const c=context();handler('handleAudioLoadedMetadata','handleAudioError',c)()
 assert.equal(c.audioRef.current.currentTime,127.5)
 assert.equal(c.pendingAudioRestoreRef.current,null)
 assert.equal(c.events.some(x=>x[0]==='play'),false)
 c.timers.forEach(fn=>fn())
 assert.deepEqual(c.events.find(x=>x[0]==='play'),['play',127.5])
})
test('source reload without pending metadata still restores heard position',()=>{
 const c=context();c.pendingAudioRestoreRef.current=null
 handler('handleAudioLoadedMetadata','handleAudioError',c)()
 assert.equal(c.audioRef.current.currentTime,127.5)
})
test('autoplay denial keeps resume available, never restarts from zero',async()=>{
 const c=context();c.audioRef.current.play=()=>Promise.reject(new Error('NotAllowedError'))
 handler('handleAudioLoadedMetadata','handleAudioError',c)();c.timers.forEach(fn=>fn());await Promise.resolve()
 assert.equal(c.audioRef.current.currentTime,127.5)
 assert.ok(c.events.some(x=>x[0]==='setAudioWarning'&&x[1].includes('Resume Audio')))
 assert.ok(c.events.some(x=>x[0]==='setAudioResumePending'&&x[1]===true))
})
test('expired section never auto-plays restored recording',()=>{
 const c=context();c.listeningLocked=true
 handler('handleAudioLoadedMetadata','handleAudioError',c)();c.timers.forEach(fn=>fn())
 assert.equal(c.events.some(x=>x[0]==='play'),false)
})
test('failed or not-yet-restored stream is not marked finished',()=>{
 for(const pending of [false,true]) {
  const c=context();c.audioStreamFailedRef.current=!pending;c.pendingAudioRestoreRef.current=pending?{time:127}:null
  handler('handleAudioEnded','handleSubmitMock',c)()
  assert.equal(c.events.some(x=>x[0]==='setAudioLocked'),false)
 }
})
test('normal end still locks audio and prevents replay',()=>{
 const c=context();c.pendingAudioRestoreRef.current=null
 handler('handleAudioEnded','handleSubmitMock',c)()
 assert.ok(c.events.some(x=>x[0]==='setAudioLocked'&&x[1]===true))
})
test('retry preserves checkpoint and requests a new private URL only once',async()=>{
 const c=context();Object.assign(c,await mod(),{activePrivateListeningId:'ListeningA',activeListeningPart:{listeningAudioUrl:''},activeSection:{key:'listening-0'},setAudioReloadCount:fn=>c.events.push(['reload',fn(0)])})
 c.audioStreamFailedRef.current=true
 c.checkpointInterruptedAudio=handler('checkpointInterruptedAudio','retryInterruptedAudio',c)
 const retry=src.slice(src.indexOf('  const retryInterruptedAudio ='),src.indexOf('\n  useEffect(() => {\n    window.addEventListener(\'online\'',src.indexOf('  const retryInterruptedAudio =')))
 const f=vm.runInNewContext(`${retry}\nretryInterruptedAudio`,c);f();f()
 assert.equal(c.pendingAudioRestoreRef.current.time,127.5)
 assert.equal(c.pendingAudioRestoreRef.current.sourceUrl,'private:ListeningA')
 assert.equal(c.events.filter(x=>x[0]==='reload').length,1)
})
test('private reload remains scoped to original source and backend authorization',()=>{
 assert.match(src,/window.addEventListener\('online', retryInterruptedAudio\)/)
 assert.match(src,/progressive: shouldUseProgressiveMockAudio\(audioLastTimeRef.current, pendingAudioRestoreRef.current\)/)
 assert.match(src,/asset: 'audio', parallelChunks: 3/)
 assert.match(src,/listeningId: activePrivateListeningId, mockTestId: id/)
 assert.match(src,/activeListeningAudioKeyRef|activeAudioKeyRef.current === activeListeningAudioKey/)
 assert.match(src,/progressWriteAtRef.current >= 1000\) persistProgress\(\)/)
 assert.match(src,/window.addEventListener\('offline', persistProgress\)/)
})

test('progress is hydrated before any default render can overwrite saved answers or timing',()=>{
 assert.match(src,/if \(!storageKey \|\| loading \|\| !progressHydrated \|\| !mock \|\| alreadySubmitted \|\| finalResult\) return/)
 assert.match(src,/restoredRef.current = true\s+setProgressHydrated\(true\)/)
 assert.match(src,/setLoading\(true\)\s+setProgressHydrated\(false\)/)
})
