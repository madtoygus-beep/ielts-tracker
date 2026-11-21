'use strict'
const CRITERIA = ['fluencyAndCoherence','lexicalResource','grammaticalRangeAndAccuracy','pronunciation']
const MAX_AUDIO_BYTES = 6 * 1024 * 1024
const MAX_QUESTIONS = 20
const half = n => Math.round((n + Number.EPSILON) * 2) / 2
function config(raw, full = false) {
  if (!raw || raw.enabled !== true) return { enabled:false, questions:[] }
  if (!Array.isArray(raw.questions) || !raw.questions.length || raw.questions.length > MAX_QUESTIONS) throw Error('Use 1–20 Speaking questions.')
  const questions = raw.questions.map((q,i) => {
    if (![1,2,3].includes(q.part) || typeof q.text !== 'string' || !q.text.trim() || q.text.length > 3000) throw Error('Every question needs a part and question text.')
    return { id:`q${i+1}`, part:q.part, text:q.text.trim(),
      seconds:q.part === 2 ? 120 : Math.max(20,Math.min(90,Math.round(Number(q.seconds)||40))),
      preparationSeconds:q.part === 2 ? 60 : 0 }
  })
  if (full && (![1,2,3].every(p=>questions.some(q=>q.part===p)) || questions.filter(q=>q.part===2).length!==1)) throw Error('Mock Speaking needs Parts 1 and 3 and exactly one Part 2 cue card.')
  if (questions.some((q,i)=>i && q.part<questions[i-1].part)) throw Error('Questions must follow Part 1 → Part 2 → Part 3.')
  return { enabled:true, questions }
}
function validateWav(base64) {
  if (typeof base64 !== 'string' || base64.length > Math.ceil(MAX_AUDIO_BYTES*4/3)+8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw Error('Invalid audio upload.')
  const b=Buffer.from(base64,'base64')
  if (b.toString('base64')!==base64 || b.length<46 || b.length>MAX_AUDIO_BYTES || b.toString('ascii',0,4)!=='RIFF' || b.toString('ascii',8,12)!=='WAVE' || b.toString('ascii',12,16)!=='fmt ' || b.readUInt32LE(16)!==16 || b.readUInt16LE(20)!==1 || b.readUInt16LE(22)!==1 || b.readUInt32LE(24)!==16000 || b.readUInt32LE(28)!==32000 || b.readUInt16LE(32)!==2 || b.readUInt16LE(34)!==16 || b.toString('ascii',36,40)!=='data' || b.readUInt32LE(40)!==b.length-44 || b.readUInt32LE(4)!==b.length-8 || (b.length-44)%2) throw Error('Audio must be mono 16 kHz PCM WAV.')
  const duration=(b.length-44)/32000
  if(duration<0.25 || duration>130) throw Error('Recording length is outside the permitted range.')
  let energy=0
  for(let i=44;i<b.length;i+=2) energy+=(b.readInt16LE(i)/32768)**2
  return { bytes:b, duration, audible:Math.sqrt(energy/((b.length-44)/2))>0.001 }
}
function validateCriterion(criterion, answers, recordedQuestionIds) {
  const unavailable = reason => ({band:null, explanation:reason, status:'unverified'})
  if (!criterion || !Number.isFinite(criterion.band) || criterion.band < 1 || criterion.band > 9 || !Number.isInteger(criterion.band * 2)) {
    return unavailable('The assessment did not provide a valid band for this criterion.')
  }
  const explanation = criterion.explanation
  if (typeof explanation !== 'string' || !explanation.trim() || explanation.length > 3000) {
    return unavailable('The assessment did not provide a usable explanation for this band.')
  }
  const questionId = criterion.evidence?.questionId
  const quote = criterion.evidence?.quote
  if (typeof quote !== 'string' || !quote.trim() || quote.length > 600 || /\[inaudible\]/i.test(quote)) {
    return unavailable('The assessment did not supply a usable excerpt for this criterion.')
  }
  const answer = answers.find(a => a.questionId === questionId)
  if (!answer || !recordedQuestionIds.includes(questionId)) {
    return unavailable('The excerpt could not be linked to a recorded answer.')
  }
  const literal = quote.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = answer.transcript.match(new RegExp(literal, 'iu'))
  if (!match) {
    return unavailable('The quoted words could not be matched to the transcript of the cited answer.')
  }
  return {band:criterion.band, explanation:explanation.trim(), evidence:{questionId, quote:match[0]}}
}
function report(raw, questionIds, recordedQuestionIds) {
  if (!raw || typeof raw!=='object' || !Array.isArray(raw.answers) || raw.answers.length!==questionIds.length) throw Error('Incomplete AI report.')
  const bounded=(s,max=3000)=>{if(typeof s!=='string'||s.length>max)throw Error('Invalid report text.');return s.trim()}
  const answers=raw.answers.map((a,i)=>{
    if(a.questionId!==questionIds[i])throw Error('AI report question mismatch.')
    return {questionId:a.questionId,transcript:bounded(a.transcript,18000),feedback:bounded(a.feedback),
      corrections:(Array.isArray(a.corrections)?a.corrections:[]).slice(0,6).map(c=>{
        const original=bounded(c.original)
        if(!original || !a.transcript.toLowerCase().includes(original.toLowerCase()))throw Error('Unverified correction quote.')
        return {original,suggestion:bounded(c.suggestion),reason:bounded(c.reason)}
      })}
  })
  if(raw.assessable===false)return {criteria:null,estimatedBand:null,answers,summary:bounded(raw.summary),priorities:[],isAiEstimate:true,insufficientEvidence:true}
  const criteria = Object.fromEntries(CRITERIA.map(key => [key, validateCriterion(raw.criteria?.[key], answers, recordedQuestionIds)]))
  const bands = Object.values(criteria).map(criterion => criterion.band)
  const estimatedBand = bands.includes(null) ? null : half(bands.reduce((sum, band) => sum + band, 0) / bands.length)
  return {criteria, estimatedBand, answers,
    summary:bounded(raw.summary),priorities:(Array.isArray(raw.priorities)?raw.priorities:[]).slice(0,4).map(s=>bounded(s)),isAiEstimate:true}
}
function mockOverall(result) {
  const enabled=name=>result[name]?.enabled!==false
  const values=[]
  for(const name of ['listening','reading','writing','speaking']) {
    if(!enabled(name) || !result[name])continue
    const band=name==='writing'?(result[name].band??result[name].effectiveBand):result[name].band
    if(typeof band!=='number'||!Number.isFinite(band)||band<0||band>9)return null
    values.push(band)
  }
  return values.length?half(values.reduce((a,b)=>a+b,0)/values.length):null
}
module.exports={CRITERIA,MAX_AUDIO_BYTES,MAX_QUESTIONS,config,validateWav,report,mockOverall}
