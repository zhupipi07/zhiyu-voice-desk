// Each callback receives one 10 ms, mono, 16 kHz PCM16 frame from the WebRTC peer.
export class LocalEndpoint {
  constructor({start,audio,stop}) {
    Object.assign(this,{start,audio,stop});
    this.history=[];this.voiced=0;this.quiet=0;this.active=false;this.floor=45;this.frames=0;
  }
  push(pcm) {
    let squares=0;
    for(let i=0;i<pcm.length;i+=2)squares+=pcm.readInt16LE(i)**2;
    const rms=Math.sqrt(squares/(pcm.length/2));
    const loud=rms>Math.max(180,this.floor*3.5);
    if(!this.active) {
      this.history.push(pcm);if(this.history.length>18)this.history.shift();
      if(!loud)this.floor=this.floor*.97+Math.min(rms,220)*.03;
      this.voiced=loud?this.voiced+1:0;
      if(this.voiced<3)return;
      this.active=true;this.frames=0;this.quiet=0;this.start();
      for(const frame of this.history)this.audio(frame);
      this.history=[];
      return;
    }
    this.audio(pcm);this.frames++;
    this.quiet=loud?0:this.quiet+1;
    if(this.quiet>=65||this.frames>=3000) {
      this.stop();this.active=false;this.voiced=0;this.quiet=0;this.history=[];
    }
  }
}
