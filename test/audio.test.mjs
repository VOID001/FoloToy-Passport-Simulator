import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserAudio } from '../public/audio.js';
class Source extends EventTarget {
  stopped = false;
  connect(node) { this.gain = node; }
  disconnect() {}
  start(time) { this.startTime = time; }
  stop() { this.stopped = true; this.dispatchEvent(new Event('ended')); }
}
class Context {
  currentTime = 0; state = 'running'; sources = [];
  constructor() { Context.last = this; }
  resume() {}
  createGain() { return {gain:{value:1},connect(){},disconnect(){}}; }
  createBuffer(channels, frames, sampleRate) {
    const data = Array.from({length:channels},()=>new Float32Array(frames));
    return {duration:frames/sampleRate,getChannelData:i=>data[i]};
  }
  createBufferSource() {const source=new Source(); this.sources.push(source); return source;}
}
const packet = (volume=100) => ({bits:16,channels:1,sampleRate:16000,volume,bytes:new Uint8Array(480)});
test('PCM remains contiguous across packet jitter and silence; volume belongs to each packet',async()=>{
  const original = globalThis.AudioContext; globalThis.AudioContext=Context;
  try {
    const audio=new BrowserAudio(()=>{}); await audio.enableOutput(); const context=Context.last;
    audio.play(packet(20)); context.currentTime=0.068; audio.play(packet(80));
    const [first,second]=context.sources;
    assert.equal(first.startTime,0.06);
    assert.equal(second.startTime,first.startTime+first.buffer.duration);
    assert.equal(first.gain.gain.value,0.2); assert.equal(second.gain.gain.value,0.8);
    audio.reset(); assert.ok(context.sources.every(source=>source.stopped));
    context.currentTime=2; audio.play(packet()); assert.equal(context.sources.at(-1).startTime,2.06);
  } finally {globalThis.AudioContext=original;}
});
test('queue overflow cancels old sources before rebasing playback',async()=>{
  const original=globalThis.AudioContext;globalThis.AudioContext=Context;
  try {
    const audio=new BrowserAudio(()=>{});await audio.enableOutput();
    for(let i=0;i<80;i++)audio.play(packet());
    const active=Context.last.sources.filter(source=>!source.stopped);
    assert.ok(Context.last.sources.some(source=>source.stopped));
    for(let i=1;i<active.length;i++)assert.ok(active[i].startTime>=active[i-1].startTime+active[i-1].buffer.duration-1e-9);
  } finally {globalThis.AudioContext=original;}
});
