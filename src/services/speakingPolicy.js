export const speakingLabels = {
  fluencyAndCoherence:'Fluency & Coherence',lexicalResource:'Lexical Resource',
  grammaticalRangeAndAccuracy:'Grammatical Range & Accuracy',pronunciation:'Pronunciation'
}
export const defaultSpeakingConfig = () => ({enabled:false,questions:[
  {part:1,text:'What do you enjoy about the place where you live?',seconds:40},
  {part:1,text:'How has your neighbourhood changed in recent years?',seconds:40},
  {part:2,text:'Describe a useful skill you learned. You should say:\n• what the skill is\n• when and how you learned it\n• why you wanted to learn it\nand explain how it has helped you.',seconds:120},
  {part:3,text:'Why is it important for people to keep learning throughout their lives?',seconds:60},
  {part:3,text:'How might technology change the way people learn practical skills?',seconds:60}
]})
export function validateSpeakingConfig(config, full=false) {
  if(!config?.enabled)return ''
  const qs=config.questions
  if(!Array.isArray(qs)||!qs.length||qs.length>20)return 'Add 1–20 questions.'
  if(qs.some((q,i)=>![1,2,3].includes(q.part)||!q.text?.trim()||q.text.length>3000||(i>0&&q.part<qs[i-1].part)))return 'Enter question text and keep the order Part 1 → Part 2 → Part 3.'
  if(qs.some(q=>q.part!==2&&(!Number.isFinite(Number(q.seconds))||Number(q.seconds)<20||Number(q.seconds)>90)))return 'Use 20–90 seconds for Part 1 and Part 3 questions.'
  if(full&&(![1,2,3].every(p=>qs.some(q=>q.part===p))||qs.filter(q=>q.part===2).length!==1))return 'Mock Speaking needs all three parts and exactly one Part 2 cue card.'
  return ''
}
export const speakingTime = n => `${String(Math.floor(Math.max(0,n)/60)).padStart(2,'0')}:${String(Math.max(0,n)%60).padStart(2,'0')}`

export function defaultMockSpeakingConfig() {
  return {enabled:false,questions:[
    ...[
      'Are you working or studying at the moment?',
      'What do you enjoy most about your work or studies?',
      'Is there anything you would like to change about your daily routine?',
      'What do you like about the area where you live?',
      'Would you like to live somewhere different in the future?',
      'How do you usually spend your weekends?',
      'Do you prefer to make plans or decide what to do on the day?',
      'What is a new activity you would like to try?'
    ].map(text=>({part:1,text,seconds:25})),
    {part:2,text:'Describe a useful skill you learned. You should say:\n• what the skill is\n• when and how you learned it\n• why you wanted to learn it\nand explain how it has helped you.',seconds:120},
    ...[
      'Why should people continue learning after they leave school?',
      'What practical skills should schools teach young people?',
      'How has technology changed the way adults learn?',
      'Is learning from experience more valuable than learning from books?',
      'Who should be responsible for helping workers learn new skills?'
    ].map(text=>({part:3,text,seconds:45}))
  ]}
}

export function speakingPracticeKind(config) {
  const parts=[...new Set((config?.questions||[]).map(q=>q.part))]
  return parts.length===1&&[1,2,3].includes(parts[0])?`part${parts[0]}`:'mixed'
}
export function speakingPracticePreset(config,kind) {
  if(!['part1','part2','part3','mixed'].includes(kind))throw Error('Invalid Speaking practice type.')
  const defaults=defaultSpeakingConfig().questions,current=config?.questions||[]
  if(kind==='mixed'){
    const parts=new Set(current.map(q=>q.part))
    return {...config,enabled:true,questions:[...current,...defaults.filter(q=>!parts.has(q.part))].sort((a,b)=>a.part-b.part)}
  }
  const part=Number(kind.slice(-1)),existing=current.filter(q=>q.part===part)
  return {...config,enabled:true,questions:existing.length?existing:defaults.filter(q=>q.part===part)}
}
export const speakingPracticeLabel = config => ({part1:'Part 1 only',part2:'Part 2 only',part3:'Part 3 only',mixed:'Mixed parts'})[speakingPracticeKind(config)]
