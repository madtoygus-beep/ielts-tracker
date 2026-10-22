// Demo-project only. Real Firestore+Storage Emulator rules, no live data.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {initializeTestEnvironment, assertFails, assertSucceeds} from '@firebase/rules-unit-testing';
import {doc,setDoc} from 'firebase/firestore';
import {ref, uploadBytes, getMetadata} from 'firebase/storage';

const projectId='demo-maxima-storage-step866';
const owner='teacher-maxima', another='teacher-other';
const audio=`listening-audios/${owner}/clip.mp3`;
const map=`listening-map-images/${owner}/map.png`;
const material=`materials/${owner}/mat-a/material.pdf`;
const logo='school-branding/maxima/logo.png';
const user=(role, schoolId='maxima', flags={})=>({role,schoolId,status:'approved',deleted:false,archived:false,permanentDeleteInProgress:false,...flags});
const content={size:4,type:'audio/mpeg'};
const asset=(context,path)=>ref(context.storage(),path);
const check=(env,uid,path)=>getMetadata(asset(env.authenticatedContext(uid),path));

test('storage rules E2E: identity, tenants, materials, branding', async t=>{
  const env=await initializeTestEnvironment({
    projectId,
    firestore:{rules:fs.readFileSync('firestore.rules','utf8')},
    storage:{rules:fs.readFileSync('storage.rules','utf8')}
  });
  try {
    await env.clearFirestore();
    await env.clearStorage();
    await env.withSecurityRulesDisabled(async context=>{
      const db=context.firestore();
      for(const [uid,record] of Object.entries({
        'teacher-maxima':user('teacher'),
        'teacher-other':user('teacher','other'),
        'student-maxima':user('student'),
        'student-other':user('student','other'),
        'student-archived':user('student','maxima',{archived:true}),
        'student-deleting':user('student','maxima',{permanentDeleteInProgress:true}),
        'teacher-archived':user('teacher','maxima',{archived:true}),
        'admin':user('admin')
      })) await setDoc(doc(db,'users',uid),record);
      await setDoc(doc(db,'materials','mat-a'),{
        ownerId:owner,teacherId:owner,schoolId:'maxima',recipientIds:['student-maxima','student-other','student-archived'],
        archived:false,deleted:false,storagePath:material
      });
      await uploadBytes(asset(context,audio),new Uint8Array([1,2,3,4]),{
        contentType:'audio/mpeg',customMetadata:{createdBy:owner,schoolId:'maxima'}
      });
      await uploadBytes(asset(context,map),new Uint8Array([137,80,78,71]),{
        contentType:'image/png',customMetadata:{createdBy:owner,schoolId:'maxima'}
      });
      await uploadBytes(asset(context,material),new Uint8Array([37,80,68,70]),{contentType:'application/pdf'});
      await uploadBytes(asset(context,logo),new Uint8Array([137,80,78,71]),{contentType:'image/png'});
    });
    await t.test('approved in-school student can access listening assets',async()=>{
      await assertSucceeds(check(env,'student-maxima',audio));
      await assertSucceeds(check(env,'student-maxima',map));
    });
    await t.test('cross-school student cannot read teacher listening assets',async()=>{
      await assertFails(check(env,'student-other',audio));
      await assertFails(check(env,'student-other',map));
    });
    await t.test('archived and deleting profiles cannot read audio',async()=>{
      await assertFails(check(env,'student-archived',audio));
      await assertFails(check(env,'student-deleting',audio));
    });
    await t.test('archived teacher cannot read audio or material',async()=>{
      await assertFails(check(env,'teacher-archived',audio));
      await assertFails(check(env,'teacher-archived',material));
    });
    await t.test('assigned same-school student can open material',async()=>{
      await assertSucceeds(check(env,'student-maxima',material));
    });
    await t.test('assigned student at another school cannot open material',async()=>{
      await assertFails(check(env,'student-other',material));
    });
    await t.test('archived material is no longer readable by recipient',async()=>{
      await env.withSecurityRulesDisabled(async ctx=>{
        await setDoc(doc(ctx.firestore(),'materials','mat-a'),{archived:true},{merge:true});
      });
      await assertFails(check(env,'student-maxima',material));
    });
    await t.test('school logos remain readable before login',async()=>{
      await assertSucceeds(getMetadata(asset(env.unauthenticatedContext(),logo)));
    });
    await t.test('master library objects always deny direct client access',async()=>{
      await assertFails(getMetadata(asset(env.authenticatedContext('admin'),'self-study-master/x/assets/file.pdf')));
    });
    await t.test('future owner audio upload must use canonical school metadata',async()=>{
      const teacherCtx=env.authenticatedContext(owner);
      await assertSucceeds(uploadBytes(asset(teacherCtx,`listening-audios/${owner}/valid.mp3`),new Uint8Array([1]),{
        contentType:'audio/mpeg',customMetadata:{createdBy:owner,schoolId:'maxima'}
      }));
      await assertFails(uploadBytes(asset(teacherCtx,`listening-audios/${owner}/forged.mp3`),new Uint8Array([1]),{
        contentType:'audio/mpeg',customMetadata:{createdBy:owner,schoolId:'other'}
      }));
      await assertFails(uploadBytes(asset(env.authenticatedContext('teacher-archived'),`listening-audios/teacher-archived/archived.mp3`),new Uint8Array([1]),{
        contentType:'audio/mpeg',customMetadata:{createdBy:'teacher-archived',schoolId:'maxima'}
      }));
    });
    console.log('STEP866_STORAGE_RULES_E2E=PASS');
  }finally{await env.cleanup();}
});
