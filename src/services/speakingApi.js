import { httpsCallable } from 'firebase/functions'
import { functions } from '../firebase'
const call = httpsCallable(functions, 'speakingWorkspace', {timeout:180000})
export async function speakingApi(op, data={}) {
  const response = await call({op,...data})
  return response.data
}
export { speakingLabels, defaultSpeakingConfig, defaultMockSpeakingConfig, validateSpeakingConfig, speakingTime } from './speakingPolicy'
