// Browser implementation is replaceable only by the development preview's explicit simulator.
export const browserSpeakingRuntime={
  now:()=>Date.now(),
  available:()=>Boolean(navigator.mediaDevices?.getUserMedia&&typeof MediaRecorder!=='undefined'),
  getUserMedia:constraints=>navigator.mediaDevices.getUserMedia(constraints),
  enumerateDevices:()=>navigator.mediaDevices.enumerateDevices(),
  recorder:(stream)=>{const mime=['audio/webm;codecs=opus','audio/mp4','audio/webm'].find(t=>MediaRecorder.isTypeSupported(t));return new MediaRecorder(stream,mime?{mimeType:mime}:undefined)}
}
