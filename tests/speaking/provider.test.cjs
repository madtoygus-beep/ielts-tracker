'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict')
const {gradeSpeaking}=require('../../functions/lib/speaking/provider')
const {CRITERIA}=require('../../functions/lib/speaking/policy')
const raw={assessable:true,summary:'Illustrative evidence only',criteria:Object.fromEntries(CRITERIA.map((k,i)=>[k,{band:[4,5,4,6][i],explanation:'Evidence from the supplied recording',evidence:{questionId:'q1',quote:'I enjoy learning skills.'}}])),answers:[{questionId:'q1',transcript:'I enjoy learning skills.',feedback:'Add a reason.',corrections:[]},{questionId:'q2',transcript:'',feedback:'No speech was submitted.',corrections:[]}],priorities:['Add an example.']}
const recordings=[{question:{id:'q1',part:1,text:'What do you enjoy learning?'},bytes:Buffer.from('synthetic fixture')},{question:{id:'q2',part:2,text:'Describe a skill.'},bytes:null}]
const settings={apiKey:'sk-local-test-placeholder',model:'gpt-audio-1.5'}
const response=(value,finish='stop')=>new Response(JSON.stringify({choices:[{finish_reason:finish,message:{content:typeof value==='string'?value:JSON.stringify(value)}}]}))
test('audio request uses actual bytes and all question IDs, no storage, no text-only pronunciation proxy',async()=>{
 let calls=0;const result=await gradeSpeaking(recordings,{...settings,fetchImpl:async(url,options)=>{calls++;assert.equal(url,'https://api.openai.com/v1/chat/completions');const body=JSON.parse(options.body);assert.equal(body.store,false);assert.deepEqual(body.modalities,['text']);const audio=body.messages[1].content.filter(c=>c.type==='input_audio');assert.equal(audio.length,1);assert.equal(audio[0].input_audio.data,recordings[0].bytes.toString('base64'));assert(body.messages[1].content.some(c=>c.text?.includes('"questionId":"q2"')));return response(raw)}})
 assert.equal(calls,1);assert.equal(result.estimatedBand,5);assert.equal(result.answers.length,2)
})
test('provider failure and incomplete output do not trigger another paid request',async()=>{let calls=0;await assert.rejects(gradeSpeaking(recordings,{...settings,fetchImpl:async()=>{calls++;return response(raw,'length')}}));assert.equal(calls,1)})
test('malformed JSON, mismatched answers and invented quotes fail closed',async()=>{for(const value of ['bad json',{...raw,answers:[]},{...raw,answers:[{...raw.answers[0],corrections:[{original:'never spoken',suggestion:'replacement',reason:'error'}]},raw.answers[1]]}])await assert.rejects(gradeSpeaking(recordings,{...settings,fetchImpl:async()=>response(value)}))})
test('model and key must be configured explicitly before network access',async()=>{let called=false;await assert.rejects(gradeSpeaking(recordings,{apiKey:'',model:'gpt-audio-1.5',fetchImpl:async()=>{called=true}}));assert.equal(called,false)})
test('Writing AI result can be shown while Speaking awaits review, but full Overall remains unavailable',async()=>{
 const {savedMockWritingScoreReady,dashboardMockOverall,mockAiGateDecision}=await import('../../src/services/mockAiResultGatePolicy.js')
 const result={listening:{band:6},reading:{band:7},writing:{enabled:true,effectiveBand:5,effectiveBandSource:'ai',aiEstimatedBand:5},speaking:{enabled:true,band:null},overall:null}
 assert.equal(savedMockWritingScoreReady(result),true);assert.equal(mockAiGateDecision({status:'completed',report:{estimatedBand:5}},result),'ready');assert.equal(dashboardMockOverall({result}),null)
 const reviewed={...result,speaking:{enabled:true,band:8},overall:6.5}
 assert.equal(savedMockWritingScoreReady(reviewed),true);assert.equal(dashboardMockOverall({result:reviewed}),6.5)
 assert.equal(savedMockWritingScoreReady({...reviewed,overall:6}),false)
})
test('microphone check rejects a silent PCM recording but accepts a measurable signal',async()=>{
 const {wavHasSignal}=await import('../../src/services/speakingAudio.js')
 const bytes=new ArrayBuffer(32044),view=new DataView(bytes)
 assert.equal(await wavHasSignal(new Blob([bytes])),false)
 for(let i=44;i<32044;i+=2)view.setInt16(i,Math.round(Math.sin(i)*2000),true)
 assert.equal(await wavHasSignal(new Blob([bytes])),true)
 assert.equal(await wavHasSignal(new Blob([new Uint8Array(20)])),false)
})
test('single-part practice presets support Parts 1, 2 and 3 without weakening full-Mock validation',async()=>{
 const {defaultSpeakingConfig,speakingPracticePreset,speakingPracticeKind,validateSpeakingConfig}=await import('../../src/services/speakingPolicy.js')
 const {config}=require('../../functions/lib/speaking/policy')
 const original={...defaultSpeakingConfig(),enabled:true};original.questions[0].text='Teacher custom question'
 for(const part of [1,2,3]){
   const preset=speakingPracticePreset(original,`part${part}`)
   assert(preset.questions.length>0);assert(preset.questions.every(q=>q.part===part));assert.equal(speakingPracticeKind(preset),`part${part}`)
   assert.equal(validateSpeakingConfig(preset),'');assert.doesNotThrow(()=>config(preset));assert.throws(()=>config(preset,true));assert.notEqual(validateSpeakingConfig(preset,true),'')
 }
 assert.equal(speakingPracticePreset(original,'part1').questions[0].text,'Teacher custom question')
 const p2=speakingPracticePreset(speakingPracticePreset(original,'part1'),'part2');assert.equal(p2.questions[0].part,2)
 const mixed=speakingPracticePreset(p2,'mixed');assert.equal(speakingPracticeKind(mixed),'mixed');assert.equal(validateSpeakingConfig(mixed,true),'')
 assert.equal(original.questions.length,5)
})

test('criterion evidence must come from the identified recorded answer', async () => {
  for (const evidence of [null, {questionId:'q1', quote:'unspoken words'}, {questionId:'q2', quote:'I enjoy learning skills.'}]) {
    const value = structuredClone(raw)
    value.criteria.pronunciation.evidence = evidence
    value.answers[1].transcript = value.answers[0].transcript
    const result = await gradeSpeaking(recordings, {...settings, fetchImpl:async () => response(value)})
    assert.equal(result.estimatedBand, null)
    assert.equal(result.criteria.pronunciation.band, null)
    assert.equal(result.criteria.pronunciation.status, 'unverified')
    assert.ok(result.criteria.pronunciation.explanation)
    for (const key of CRITERIA.filter(k => k !== 'pronunciation')) {
      assert.deepEqual(result.criteria[key], raw.criteria[key])
    }
  }
})

test('case differences preserve the original transcript spelling and punctuation stays literal', async () => {
  const value = structuredClone(raw)
  value.criteria.fluencyAndCoherence.evidence.quote = 'i enjoy learning skills.'
  value.criteria.pronunciation.evidence.quote = 'I enjoy learning skill..'
  const result = await gradeSpeaking(recordings, {...settings,fetchImpl:async () => response(value)})
  assert.equal(result.criteria.fluencyAndCoherence.evidence.quote, 'I enjoy learning skills.')
  assert.equal(result.criteria.pronunciation.status, 'unverified')
})
