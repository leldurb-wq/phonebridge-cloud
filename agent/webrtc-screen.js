'use strict';
const {spawn}=require('node:child_process');
const {RTCPeerConnection,RTCSessionDescription,MediaStream,nonstandard}=require('@roamhq/wrtc');
const {RTCVideoSource}=nonstandard;
function waitIce(pc,timeout=12000){if(pc.iceGatheringState==='complete')return Promise.resolve();return new Promise(resolve=>{const timer=setTimeout(done,timeout);function done(){clearTimeout(timer);pc.removeEventListener('icegatheringstatechange',check);resolve()}function check(){if(pc.iceGatheringState==='complete')done()}pc.addEventListener('icegatheringstatechange',check)})}
async function answerScreenOffer({offer,ffmpegPath,frameRate=20,width=1280,height=720,onError=()=>{}}){
 if(!offer||offer.type!=='offer'||typeof offer.sdp!=='string')throw new Error('Invalid WebRTC screen offer.');
 const fps=Math.max(20,Math.min(30,Math.floor(Number(frameRate)||20)));
 const pc=new RTCPeerConnection({iceServers:[{urls:['stun:stun.l.google.com:19302','stun:stun1.l.google.com:19302']}]});
 const source=new RTCVideoSource({isScreencast:true,needsDenoising:false});const track=source.createTrack();pc.addTrack(track,new MediaStream([track]));
 let child=null,buffer=Buffer.alloc(0),closed=false,lastFrameAt=Date.now();const frameBytes=width*height*3/2;let watchdog=null;
 const close=()=>{if(closed)return;closed=true;if(watchdog)clearInterval(watchdog);watchdog=null;if(child){try{child.kill()}catch{}child=null}try{track.stop()}catch{}try{pc.close()}catch{}buffer=Buffer.alloc(0)};
 pc.addEventListener('connectionstatechange',()=>{if(['failed','closed'].includes(pc.connectionState))close()});
 try{
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer=await pc.createAnswer();await pc.setLocalDescription(answer);await waitIce(pc);
  if(!pc.localDescription?.sdp)throw new Error('WebRTC did not produce a local answer.');
  child=spawn(ffmpegPath,['-hide_banner','-loglevel','error','-fflags','nobuffer','-flags','low_delay','-thread_queue_size','64','-f','gdigrab','-framerate',String(fps),'-draw_mouse','1','-i','desktop','-an','-vf',`scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=fast_bilinear,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,'-pix_fmt','yuv420p','-f','rawvideo','pipe:1'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  watchdog=setInterval(()=>{if(!closed&&Date.now()-lastFrameAt>5000){onError(new Error('WebRTC capture stalled: no complete desktop frame for 5 seconds.'));close()}},1500);watchdog.unref?.();
  child.stdout.on('data',chunk=>{if(closed)return;buffer=buffer.length?Buffer.concat([buffer,chunk]):chunk;const complete=Math.floor(buffer.length/frameBytes);if(!complete)return;if(complete>1)buffer=buffer.subarray((complete-1)*frameBytes);const frame=buffer.subarray(0,frameBytes);buffer=buffer.subarray(frameBytes);try{const exactFrame=new Uint8Array(frameBytes);exactFrame.set(frame);source.onFrame({width,height,data:exactFrame});lastFrameAt=Date.now()}catch(error){onError(error)}});
  child.stderr.on('data',chunk=>{const message=chunk.toString('utf8').trim();if(message)onError(new Error(message.slice(0,300)))});
  child.once('error',error=>{onError(error);close()});child.once('close',code=>{if(!closed&&code!==0)onError(new Error('WebRTC screen capture exited with code '+code));close()});
  return {answer:pc.localDescription,close,pc};
 }catch(error){close();throw error}
}
module.exports={answerScreenOffer};
