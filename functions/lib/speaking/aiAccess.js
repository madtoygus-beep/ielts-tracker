'use strict'
// Assignment, active-account and school access are enforced by the Speaking service.
// Enabling the configured audio provider makes AI available to every eligible learner.
function speakingAiEnabledFor(studentId,env=process.env){
  return env.MAXIMA_SPEAKING_AI_ENABLED==='true' && Boolean(env.MAXIMA_SPEAKING_AUDIO_MODEL) &&
    typeof studentId==='string' && Boolean(studentId.trim())
}
module.exports={speakingAiEnabledFor}
