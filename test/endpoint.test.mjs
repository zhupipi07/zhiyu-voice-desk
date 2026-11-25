import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalEndpoint } from '../src/endpoint.mjs';
test('local endpoint preserves pre-roll and a spelling pause, ends after silence and rearms',()=>{
  let starts=0,ends=0,frames=0;
  const endpoint=new LocalEndpoint({start(){starts++;},stop(){ends++;},audio(){frames++;}});
  const emit=(value,count)=>{const pcm=Buffer.alloc(320);for(let i=0;i<160;i++)pcm.writeInt16LE(value,2*i);
    for(let i=0;i<count;i++)endpoint.push(pcm);};
  emit(3,100);emit(1200,2);emit(4,10);
  assert.equal(starts,0);
  emit(1200,30);emit(5,48);emit(1200,20);assert.equal(starts,1);assert.equal(ends,0);
  emit(0,65);assert.equal(ends,1);assert.ok(frames>=30+48+20+65);
  emit(1000,8);emit(0,65);assert.equal(starts,2);assert.equal(ends,2);
});
