import { useEffect, useState } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import { collection, doc, getDoc, onSnapshot, query, where } from 'firebase/firestore'
import { useNavigate } from 'react-router-dom'
import { auth, db } from '../firebase'
import { speakingApi } from '../services/speakingApi'
import { subscribeCurrentTeacherAcademicRoster } from '../services/teacherCurrentAcademicRoster'
import SpeakingWorkspaceView from '../components/speaking/SpeakingWorkspaceView'

export default function SpeakingWorkspace() {
  const navigate=useNavigate(),[account,setAccount]=useState(null),[students,setStudents]=useState([]),[classes,setClasses]=useState([]),[error,setError]=useState('')
  useEffect(()=>{
    let active=true,generation=0
    const stop=onAuthStateChanged(auth,async user=>{
      const run=++generation
      if(!user){navigate('/login');return}
      try{
        const profile=(await getDoc(doc(db,'users',user.uid))).data()
        if(!profile||profile.status!=='approved'||profile.archived||profile.deleted||profile.accountType==='individual'||!['student','teacher','admin'].includes(profile.role))throw Error('An approved institution account is required.')
        if(active&&run===generation)setAccount({user,profile})
      }catch(e){if(active&&run===generation)setError(e.message)}
    })
    return()=>{active=false;stop()}
  },[navigate])
  useEffect(()=>{
    if(account?.profile.role!=='teacher')return
    const {profile,user}=account,school=profile.schoolId||'maxima'
    const stopRoster=subscribeCurrentTeacherAcademicRoster(db,school,user.uid,setStudents,status=>{if(status==='error')setError('Current student roster could not be loaded. Existing assignments will be preserved.')})
    const stopClasses=onSnapshot(query(collection(db,'classes'),where('teacherId','==',user.uid),where('schoolId','==',school)),snap=>setClasses(snap.docs.map(d=>({...d.data(),id:d.id})).filter(c=>!c.archived&&!c.deleted&&c.status!=='inactive')),()=>setError('Class shortcuts are unavailable; individual assignment is still available.'))
    return()=>{stopRoster();stopClasses()}
  },[account])
  if(!account)return <main className="min-h-screen bg-slate-50 p-8"><p role={error?'alert':'status'}>{error||'Loading Speaking workspace…'}</p></main>
  return <>{error&&<p role="alert" className="bg-amber-50 p-4 text-sm text-amber-900">{error}</p>}<SpeakingWorkspaceView key={account.user.uid} {...account} students={students} classes={classes} api={speakingApi} onBack={()=>navigate(account.profile.role==='admin'?'/admin':account.profile.role==='teacher'?'/teacher':'/student')} onMock={id=>navigate(`/do-mock/${encodeURIComponent(id)}`)}/></>
}
