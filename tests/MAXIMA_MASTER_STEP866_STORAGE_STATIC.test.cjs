const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const p = require('node:path');
const source = fs.readFileSync(p.join(__dirname,'..','storage.rules'),'utf8');

test('suspended user lifecycle is consistently guarded', () => {
  assert.match(source, /function isApprovedUser\(\)[\s\S]*?status == 'approved'[\s\S]*?deleted'[\s\S]*?archived'[\s\S]*?permanentDeleteInProgress'/);
});
test('listening audio and maps are limited by school, not broad approved user', () => {
  assert.equal((source.match(/allow read: if sameSchoolListeningRead\(ownerId\);/g)||[]).length,2);
  assert.doesNotMatch(source, /allow read: if isApprovedUser\(\);/);
  assert.equal((source.match(/&& validListeningUploader\(ownerId\)/g)||[]).length,2);
});
test('student materials require current same-school unarchived recipient', () => {
  const block = source.slice(source.indexOf('match /materials/'),source.indexOf('match /school-branding/'));
  assert.match(block, /get\('recipientIds', \[\]\)\.hasAny/);
  assert.match(block, /get\('schoolId', 'maxima'\) == currentSchoolId\(\)/);
  assert.match(block, /get\('archived', false\) != true/);
  assert.match(block, /get\('storagePath', ''\)/);
});
test('public brand logos and server-only master library remain deliberate', () => {
  assert.match(source,/match \/school-branding\/[\s\S]*?allow read: if fileName\.lower\(\)\.matches/);
  assert.match(source,/match \/self-study-master\/[\s\S]*?allow read, write: if false/);
  assert.match(source,/match \/\{allPaths=\*\*\}[\s\S]*?allow read, write: if false/);
});
test('Storage cross-service access uses user and at most one uploader or material document', () => {
  assert.equal((source.match(/firestore\.get\(/g)||[]).length,3);
  assert.match(source,/function legacyMediaOwner\(ownerId\)/);
  assert.match(source,/function materialDoc\(materialId\)/);
  assert.match(source,/function userDoc\(\)/);
});
