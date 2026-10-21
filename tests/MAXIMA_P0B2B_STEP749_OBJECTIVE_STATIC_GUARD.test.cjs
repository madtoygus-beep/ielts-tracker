// Step749 local offline guard: verify all 3 objective submission write policies.
const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const crypto=require('node:crypto')
const text=fs.readFileSync('firestore.rules','utf8')
const sha=s=>crypto.createHash('sha256').update(s).digest('hex')
test('Step749 exact reviewed Firestore Rules hash',()=>{
  assert.equal(sha(fs.readFileSync('firestore.rules')),'9f862f5cd3042336e78821bad4755c871466a425fe0c4a5099b5c86db9bfadc3')
})
for(const name of ['readingSubmissions','listeningSubmissions','vocabularySubmissions']){
  test(`Step749 ${name} is admin-only for direct browser UPDATE`,()=>{
    const marker=`match /${name}/{id} {`
    const i=text.indexOf(marker)
    assert.ok(i>=0,marker)
    const end=text.indexOf('allow delete:',i)
    assert.ok(end>i,`unable to isolate match ${name}`)
    const section=text.slice(i,end)
    assert.match(section,/allow update: if isAdmin\(\) && statsModerationFieldsUnchanged\(\);/)
    assert.doesNotMatch(section,/teacherCurrentAcademicRecord\(resource\.data\)\s*\);/)
  })
}
