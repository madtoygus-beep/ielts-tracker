'use strict'
function speakingAiEnabledFor(studentId,env=process.env){
  return env.MAXIMA_SPEAKING_AI_ENABLED==='true' && Boolean(env.MAXIMA_SPEAKING_AUDIO_MODEL) &&
    typeof studentId==='string' && Boolean(studentId) &&
    (env.MAXIMA_SPEAKING_AI_STUDENT_IDS||'').split(',').map(v=>v.trim()).filter(Boolean).includes(studentId)
}
module.exports={speakingAiEnabledFor}
