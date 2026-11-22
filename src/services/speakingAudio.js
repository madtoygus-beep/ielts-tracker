// Browser-only audio conversion and a per-account recovery outbox. No cloud uploads here.
export async function wavFromBlob(blob) {
  const Offline=window.OfflineAudioContext||window.webkitOfflineAudioContext
  if(!Offline)throw Error('Audio recording is not supported in this browser.')
  // Decoding is offline too: opening/closing a live output context for every
  // answer needlessly wakes the speaker device during the next question.
  const decoder=new Offline(1,1,16000)
  const decoded=await decoder.decodeAudioData(await blob.arrayBuffer())
  const frames=Math.ceil(decoded.duration*16000)
  if(decoded.duration>130)throw Error('The recording is too long.')
  const offline=new Offline(1,frames,16000),source=offline.createBufferSource()
  source.buffer=decoded;source.connect(offline.destination);source.start()
  const pcm=(await offline.startRendering()).getChannelData(0)
  const buffer=new ArrayBuffer(44+pcm.length*2),view=new DataView(buffer)
  const str=(at,s)=>[...s].forEach((c,i)=>view.setUint8(at+i,c.charCodeAt(0)))
  str(0,'RIFF');view.setUint32(4,buffer.byteLength-8,true);str(8,'WAVE');str(12,'fmt ')
  view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true)
  view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);str(36,'data');view.setUint32(40,pcm.length*2,true)
  pcm.forEach((s,i)=>view.setInt16(44+i*2,Math.round(Math.max(-1,Math.min(1,s))*(s<0?32768:32767)),true))
  return new Blob([buffer],{type:'audio/wav'})
}
export async function blobBase64(blob) {
  return new Promise((resolve,reject)=>{const r=new FileReader();r.onerror=()=>reject(Error('Recording could not be read.'));r.onload=()=>resolve(String(r.result).split(',')[1]);r.readAsDataURL(blob)})
}
const recoveryQueues=new Map()
export function outbox(key,value){
  const previous=recoveryQueues.get(key)||Promise.resolve()
  const task=previous.catch(()=>{}).then(()=>accessOutbox(key,value))
  recoveryQueues.set(key,task)
  task.finally(()=>{if(recoveryQueues.get(key)===task)recoveryQueues.delete(key)}).catch(()=>{})
  return task
}
function accessOutbox(key, value) {
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open('maxima-speaking-recovery',1)
    req.onupgradeneeded=()=>req.result.createObjectStore('answers')
    req.onerror=()=>reject(Error('Local audio recovery storage is unavailable.'))
    req.onsuccess=()=>{
      const db=req.result,tx=db.transaction('answers',value===undefined?'readonly':'readwrite'),store=tx.objectStore('answers')
      const op=value===undefined?store.get(key):value===null?store.delete(key):store.put(value,key)
      let result;op.onsuccess=()=>{result=op.result};tx.oncomplete=()=>{db.close();resolve(result)}
      tx.onerror=()=>{db.close();reject(Error('Local audio recovery storage is unavailable.'))}
    }
  })
}

export async function wavHasSignal(blob){
  const bytes=await blob.arrayBuffer(),view=new DataView(bytes)
  if(bytes.byteLength<46)return false
  let energy=0,count=0
  for(let i=44;i+1<bytes.byteLength;i+=2){energy+=(view.getInt16(i,true)/32768)**2;count++}
  return count>0&&Math.sqrt(energy/count)>0.001
}
