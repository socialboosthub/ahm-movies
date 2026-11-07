(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const canvas = $("previewCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  let previewTimer = null;
  let previewTimeout = null;
  let rendering = false;
  let previewStart = 0;
  let previewScenes = [];
  let lastScene = -1;
  let previewAudio = null;
  let previewVoiceSource = null;
  let previewStopMusic = null;

  const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
  const words = value => String(value || "").toLowerCase();
  const rounded = (n) => Math.round(n * 100) / 100;

  function getScenes() {
    return Array.from(document.querySelectorAll(".sceneCard")).map((card, i) => ({
      id: i + 1,
      caption: card.querySelector("[data-caption]")?.value || "",
      action: card.querySelector(".sceneAction")?.textContent || card.querySelector("[data-caption]")?.value || "",
      prompt: card.querySelector(".prompt")?.textContent || "",
      meta: card.querySelector(".sceneMeta")?.textContent || ""
    })).filter(s => s.caption || s.action);
  }

  function getDuration(scenes) {
    const label = $("previewCaption")?.textContent || "";
    const match = label.match(/(\d+(?:\.\d+)?)\s*(?:seconds|s)\s*(?:planned|estimated)?/i);
    if (match) return clamp(Number(match[1]),30,120);
    const timing = scenes.map(s => s.meta.match(/([\d.]+)[–-]([\d.]+)s/)).filter(Boolean);
    if (timing.length) {
      const end = Math.max(...timing.map(m => Number(m[2])));
      if (end >= 30 && end <= 120) return end;
    }
    return clamp(scenes.length * 5,30,120);
  }

  function buildSubtitleTimeline(text,duration){
    const tokens=String(text||"").trim().match(/[^\s]+/g)||[];
    if(!tokens.length)return [];
    const chunks=[];let current=[];
    for(const token of tokens){
      current.push(token);
      const punctuation=/[.!?]["')\\]]?$/.test(token);
      if(current.length>=5&&(punctuation||current.length>=7)){
        chunks.push(current);current=[];
      }
    }
    if(current.length)chunks.push(current);
    const weights=chunks.map(chunk=>{
      const joined=chunk.join(" ");
      const pause=/[.!?]["')\\]]?$/.test(chunk[chunk.length-1])?0.34:/[,;:]["')\\]]?$/.test(chunk[chunk.length-1])?0.16:0;
      return chunk.reduce((sum,word)=>sum+Math.max(1,word.replace(/[^a-z]/gi,"").length*.16),0)+pause;
    });
    const total=weights.reduce((a,b)=>a+b,0)||1;
    let cursor=0;
    return chunks.map((chunk,i)=>{
      const start=cursor;
      cursor+=duration*weights[i]/total;
      return {start,end:cursor,text:chunk.join(" ")};
    });
  }

  function subtitleAt(timeline,elapsed){
    if(!timeline.length)return "";
    const t=elapsed/1000;
    let lo=0,hi=timeline.length-1;
    while(lo<hi){const mid=(lo+hi)>>1;if(timeline[mid].end<t)lo=mid+1;else hi=mid;}
    return timeline[lo].text;
  }

  function drawBackground(scene, t, w, h) {
    const a = words(scene.action + " " + scene.prompt);
    let top="#101a31", mid="#314c69", ground="#101724", glow="#e7b75f";
    if (/ocean|sea|fish|water|river|lake|boat|shore|wave/.test(a)) { top="#071c35"; mid="#12617b"; ground="#06233b"; glow="#f4c86a"; }
    else if (/forest|tree|woods|jungle/.test(a)) { top="#071d1b"; mid="#245c48"; ground="#0b251f"; glow="#d2b77b"; }
    else if (/home|house|room|kitchen|bedroom|family/.test(a)) { top="#2a1b25"; mid="#87533d"; ground="#211c26"; glow="#ffc477"; }
    else if (/street|road|car|bus|vehicle|city/.test(a)) { top="#151e38"; mid="#51546a"; ground="#171b27"; glow="#f6d38a"; }
    else if (/space|planet|moon|star/.test(a)) { top="#080d2b"; mid="#28285e"; ground="#10122b"; glow="#c7b6ff"; }
    else if (/fire|attack|fight|battle|danger|monster|volcano/.test(a)) { top="#260f1c"; mid="#853d35"; ground="#1c101a"; glow="#ffae68"; }
    else if (/desert|sand|sun/.test(a)) { top="#5c3450"; mid="#d28b5d"; ground="#583c35"; glow="#ffe19b"; }
    const sky=ctx.createLinearGradient(0,0,0,h);
    sky.addColorStop(0,top); sky.addColorStop(.64,mid); sky.addColorStop(1,ground);
    ctx.fillStyle=sky; ctx.fillRect(0,0,w,h);
    const sunX=w*(.72+Math.sin(t*.22)*.025), sunY=h*.2;
    const halo=ctx.createRadialGradient(sunX,sunY,3,sunX,sunY,w*.52);
    halo.addColorStop(0,glow+"cc"); halo.addColorStop(.16,glow+"55"); halo.addColorStop(1,"transparent");
    ctx.fillStyle=halo; ctx.fillRect(0,0,w,h);
    // Atmospheric depth and moving environment.
    for(let layer=0;layer<3;layer++){
      const y=h*(.49+layer*.12);
      ctx.beginPath(); ctx.moveTo(0,h);
      for(let x=0;x<=w+8;x+=8){
        const wave=Math.sin((x*.013)+(layer*2)+t*(.12+layer*.06))*h*(.025+layer*.01);
        ctx.lineTo(x,y+wave);
      }
      ctx.lineTo(w,h);ctx.closePath();
      ctx.fillStyle=["rgba(8,14,26,.16)","rgba(6,12,22,.38)","rgba(3,8,17,.82)"][layer];ctx.fill();
    }
    // Environment props that make the location legible.
    if(/forest|tree|woods|jungle/.test(a)){
      for(let i=0;i<7;i++){const x=(i*71+19)%w;const sway=Math.sin(t*.7+i)*5;ctx.fillStyle="#101e1d";ctx.fillRect(x-7, h*.38, 14, h*.42);ctx.fillStyle=i%2?"#143c32":"#1c4c3a";ctx.beginPath();ctx.moveTo(x-52+sway,h*.49);ctx.lineTo(x,h*.18+(i%3)*15);ctx.lineTo(x+55+sway,h*.49);ctx.closePath();ctx.fill();}
    } else if(/home|house|room|kitchen|bedroom/.test(a)){
      ctx.fillStyle="rgba(16,12,20,.62)";ctx.fillRect(w*.08,h*.28,w*.84,h*.48);
      ctx.fillStyle="#d99c60";ctx.fillRect(w*.16,h*.34,w*.18,h*.22);
      ctx.fillStyle="#2a1c22";ctx.fillRect(w*.55,h*.33,w*.2,h*.43);
      ctx.fillStyle="#f4c477";ctx.fillRect(w*.57,h*.35,w*.16,h*.18);
    } else if(/street|road|car|vehicle|city/.test(a)){
      ctx.fillStyle="#171923";ctx.beginPath();ctx.moveTo(w*.18,h);ctx.lineTo(w*.4,h*.54);ctx.lineTo(w*.62,h*.54);ctx.lineTo(w*.9,h);ctx.fill();
      ctx.strokeStyle="#e6d4a0";ctx.setLineDash([18,18]);ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(w*.51,h*.62);ctx.lineTo(w*.55,h);ctx.stroke();ctx.setLineDash([]);
    } else if(/ocean|sea|fish|water|river|lake|boat|shore/.test(a)){
      ctx.fillStyle="rgba(35,177,202,.18)";for(let i=0;i<7;i++){const y=h*(.58+i*.045);ctx.beginPath();for(let x=0;x<=w;x+=12)ctx.lineTo(x,y+Math.sin(x*.025+t*1.4+i)*5);ctx.strokeStyle="rgba(127,226,238,.25)";ctx.lineWidth=2;ctx.stroke();}
    } else if(/castle|palace|kingdom/.test(a)){
      ctx.fillStyle="#17182c";ctx.fillRect(w*.12,h*.32,w*.76,h*.43);for(let i=0;i<5;i++){ctx.fillRect(w*(.12+i*.16),h*.25, w*.08,h*.1);}
    }
    // Dust, sparks and drifting particles.
    for(let i=0;i<24;i++){
      const x=(i*83+t*(10+i%4)*((i%2)?1:-1)+w*2)%(w+1);
      const y=(i*137+Math.sin(t*.8+i)*17)%(h*.72);
      ctx.globalAlpha=.12+(i%5)*.045;ctx.fillStyle=glow;ctx.beginPath();ctx.arc(x,y,1+(i%3),0,Math.PI*2);ctx.fill();
    }ctx.globalAlpha=1;
  }

  function pathRoundRect(x,y,width,height,radius){
    const r=Math.min(radius,width/2,height/2);ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+width,y,x+width,y+height,r);ctx.arcTo(x+width,y+height,x,y+height,r);ctx.arcTo(x,y+height,x,y,r);ctx.arcTo(x,y,x+width,y,r);ctx.closePath();
  }
  function limb(x1,y1,x2,y2,width,color){
    ctx.strokeStyle=color;ctx.lineWidth=width;ctx.lineCap="round";ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();
  }
  function character(x,y,scale,t,action,variant=0){
    const a=words(action), walk=/walk|run|chase|escape|rush|approach|leave|enter|flee/.test(a);
    const run=/run|chase|escape|rush|flee/.test(a), raise=/raise|wave|signal|point|reach|grab|catch|hold|lift|throw/.test(a);
    const fall=/fall|collapse|drop|kneel|crawl/.test(a), jump=/jump|leap|spring/.test(a), fight=/fight|attack|punch|kick|battle|strike/.test(a);
    const cry=/cry|weep|sad|grief|sob/.test(a), fear=/fear|scared|terrified|shock|surprise/.test(a);
    const smile=/smile|laugh|happy|joy|relief|hug/.test(a);
    const phase=t*(run?11:walk?6:2.4)+variant*1.7;
    const stride=walk?Math.sin(phase)* (run?28:17):Math.sin(phase)*3;
    const bob=jump?Math.abs(Math.sin(t*5+variant))*35:fall?18:Math.abs(Math.sin(phase*2))*5;
    const lean=run?.22: fight?.18: fall?.75:0;
    const skin=variant%2?"#9b6247":"#d69b70", shirt=variant%2?"#a64f45":"#3e80a0", hair=variant%2?"#17131b":"#35251f";
    ctx.save();ctx.translate(x,y-bob);ctx.scale(scale,scale);ctx.rotate(lean);
    // legs with articulated knees
    const hipY=-12, legSwing=stride;
    limb(-7,hipY,-12+legSwing*.55,25,10,"#18212c");
    limb(-12+legSwing*.55,25,-17+legSwing,62,8,"#202b39");
    limb(7,hipY,12-legSwing*.55,25,10,"#18212c");
    limb(12-legSwing*.55,25,18-legSwing,62,8,"#202b39");
    // torso, shoulders and clothing
    ctx.fillStyle=shirt;pathRoundRect(-23,-91,46,83,13);ctx.fill();
    ctx.fillStyle="rgba(255,255,255,.16)";ctx.fillRect(-15,-83,7,58);
    // arms with action-specific gestures
    const armColor=skin;
    let leftA=-.45+Math.sin(phase)*.22,rightA=.45-Math.sin(phase)*.22;
    if(raise){rightA=-1.65+Math.sin(t*3)*.18;leftA=.35;}
    if(fight){rightA=-1.7+Math.sin(t*15)*.5;leftA=-1.2;}
    if(fear){leftA=-1.4;rightA=1.4;}
    if(cry){leftA=-.9;rightA=-.7;}
    if(fall){leftA=1.2;rightA=-1.2;}
    const arm=(side,ang)=>{const sx=side*18,sy=-78,ex=sx+Math.sin(ang)*34,ey=sy+Math.cos(ang)*36;limb(sx,sy,ex,ey,11,shirt);limb(ex,ey,ex+Math.sin(ang)*18,ey+Math.cos(ang)*18,8,armColor);ctx.fillStyle=armColor;ctx.beginPath();ctx.arc(ex+Math.sin(ang)*18,ey+Math.cos(ang)*18,5,0,Math.PI*2);ctx.fill();};
    arm(-1,leftA);arm(1,rightA);
    // neck and expressive face
    ctx.fillStyle=skin;ctx.fillRect(-7,-105,14,18);ctx.beginPath();ctx.arc(0,-125,27,0,Math.PI*2);ctx.fill();
    ctx.fillStyle=hair;ctx.beginPath();ctx.arc(0,-137,27,Math.PI,Math.PI*2);ctx.lineTo(26,-125);ctx.quadraticCurveTo(12,-137,-25,-122);ctx.closePath();ctx.fill();
    ctx.fillStyle="#fff";ctx.beginPath();ctx.ellipse(-9,-127,5,3.8,0,0,Math.PI*2);ctx.ellipse(9,-127,5,3.8,0,0,Math.PI*2);ctx.fill();
    ctx.fillStyle="#1a1720";ctx.beginPath();ctx.arc(-8,-127,2,0,Math.PI*2);ctx.arc(10,-127,2,0,Math.PI*2);ctx.fill();
    ctx.strokeStyle="#3b1f20";ctx.lineWidth=2.4;ctx.beginPath();
    if(cry||fear){ctx.moveTo(-8,-112);ctx.quadraticCurveTo(0,-122,8,-112);}
    else if(smile){ctx.moveTo(-8,-112);ctx.quadraticCurveTo(0,-102,8,-112);}
    else{ctx.moveTo(-6,-111);ctx.lineTo(6,-111);}ctx.stroke();
    if(cry){ctx.fillStyle="#8bd8ff";ctx.beginPath();ctx.ellipse(-10,-119,2.5,6,0,0,Math.PI*2);ctx.fill();}
    if(fear){ctx.strokeStyle=hair;ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(-16,-143);ctx.lineTo(-5,-146);ctx.moveTo(5,-146);ctx.lineTo(16,-143);ctx.stroke();}
    ctx.restore();
  }

  function drawProp(scene,t,w,h){
    const a=words(scene.action+" "+scene.prompt);
    if(/fish|golden fish/.test(a)){
      const x=w*(.68+Math.sin(t*2.6)*.09),y=h*.48+Math.sin(t*4)*18;
      ctx.save();ctx.translate(x,y);ctx.fillStyle="#ffd15d";ctx.shadowColor="#ffcc56";ctx.shadowBlur=20;
      ctx.beginPath();ctx.ellipse(0,0,38,19,-.12,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.moveTo(-30,0);ctx.lineTo(-57,-25);ctx.lineTo(-57,25);ctx.closePath();ctx.fill();ctx.shadowBlur=0;ctx.fillStyle="#14131b";ctx.beginPath();ctx.arc(22,-5,3.5,0,Math.PI*2);ctx.fill();ctx.restore();
    } else if(/phone|mobile|screen|text message/.test(a)){
      ctx.fillStyle="#151923";ctx.fillRect(w*.72,h*.42,35,65);ctx.fillStyle="#8de5f3";ctx.fillRect(w*.745,h*.44,26,54);
    } else if(/door|open|knock|entrance/.test(a)){
      ctx.fillStyle="#53352b";ctx.fillRect(w*.7,h*.35,72,h*.35);ctx.fillStyle="#d6a65e";ctx.beginPath();ctx.arc(w*.82,h*.52,4,0,Math.PI*2);ctx.fill();
    } else if(/car|vehicle|truck|bus/.test(a)){
      ctx.fillStyle="#bd5547";pathRoundRect(w*.58,h*.61,130,48,12);ctx.fill();ctx.fillStyle="#9ad2dc";ctx.fillRect(w*.62,h*.62,36,19);ctx.fillRect(w*.68,h*.62,32,19);ctx.fillStyle="#10131a";ctx.beginPath();ctx.arc(w*.63,h*.7,12,0,Math.PI*2);ctx.arc(w*.82,h*.7,12,0,Math.PI*2);ctx.fill();
    } else if(/ball|orb|stone|rock/.test(a)){
      ctx.fillStyle="#e4b65d";ctx.shadowColor="#e4b65d";ctx.shadowBlur=18;ctx.beginPath();ctx.arc(w*.72,h*.55,22+Math.sin(t*4)*2,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;
    }
  }

  function drawFrame(scenes,index,progress,elapsed,total,subtitleTimeline){
    const scene=scenes[index];if(!scene)return;
    const w=canvas.width,h=canvas.height,t=elapsed/1000;
    drawBackground(scene,t,w,h);
    const action=scene.action||scene.caption;
    const a=words(action);
    const cameraZoom=/close|zoom|reveal|shock|face/.test(words(scene.meta+" "+scene.prompt))?1.12:1;
    const shake=/impact|crash|explode|slam|attack|hit|thunder/.test(a)?Math.sin(t*45)*5:0;
    ctx.save();ctx.translate(w/2+shake,h*.58);ctx.scale(cameraZoom,cameraZoom);ctx.translate(-w/2,-h*.58);
    const movement=/run|chase|escape|rush|flee/.test(a)?Math.sin(progress*Math.PI)*95:/walk|enter|leave|approach/.test(a)?progress*50:Math.sin(t*1.8)*8;
    const fall=/fall|collapse|drop|kneel/.test(a);
    character(w*.38+movement,h*.74,1.08,t,action,0);
    if(/he|she|they|mother|father|wife|husband|friend|stranger|man|woman|boy|girl|monster|king|guard|fisherman|mara|elias/.test(a)){
      character(w*.72-movement*.5,h*.74,.86,t, /hug|embrace/.test(a)?"hug":/attack|chase|fight/.test(a)?"fight": "react",1);
    }
    drawProp(scene,t,w,h);
    ctx.restore();
    // Fast punch-in/fade transitions and strong lower-third captions.
    const fade=progress<.08?1-progress/.08:progress>.92?(progress-.92)/.08:0;
    if(fade>0){ctx.fillStyle="rgba(0,0,0,"+clamp(fade*.5,0,.5)+")";ctx.fillRect(0,0,w,h);}
    const title=$("titleInput")?.value||"AHM STORY";
    ctx.fillStyle="rgba(0,0,0,.3)";ctx.fillRect(0,0,w,62);
    ctx.fillStyle="#f4c46e";ctx.font="bold 13px system-ui";ctx.textAlign="left";ctx.fillText("AHM STUDIO",20,25);
    ctx.fillStyle="#fff";ctx.font="600 11px system-ui";ctx.fillText(title.slice(0,42),20,45);
    const subtitle=subtitleAt(subtitleTimeline,elapsed);
    ctx.font="900 25px system-ui";ctx.textAlign="center";ctx.textBaseline="middle";
    const lines=[];let line="";
    for(const word of subtitle.split(/\s+/)){const next=line?line+" "+word:word;if(ctx.measureText(next).width>w-38&&line){lines.push(line);line=word;}else line=next;}if(line)lines.push(line);
    const baseY=h*.82-(lines.length-1)*15;
    ctx.lineJoin="round";ctx.lineWidth=5;ctx.strokeStyle="#08090d";ctx.fillStyle="#fff";
    lines.slice(0,3).forEach((v,i)=>{ctx.strokeText(v,w/2,baseY+i*31,w-36);ctx.fillText(v,w/2,baseY+i*31,w-36);});
    ctx.fillStyle="rgba(255,255,255,.85)";ctx.fillRect(18,h-18,(w-36)*clamp(elapsed/(total*1000),0,1),3);
  }

  function updateStatus(p,label){$("progressBar").style.width=Math.round(p*100)+"%";$("progressText").textContent=Math.round(p*100)+"%";$("renderStatus").textContent=label;}
  function stopPreview(){
    if(previewTimer){clearInterval(previewTimer);previewTimer=null;}
    if(previewTimeout){clearTimeout(previewTimeout);previewTimeout=null;}
    if(previewStopMusic){previewStopMusic();previewStopMusic=null;}
    if(previewVoiceSource){try{previewVoiceSource.stop();}catch{}previewVoiceSource=null;}
    if(previewAudio&&previewAudio.state!=="closed"){previewAudio.close().catch(()=>{});previewAudio=null;}
  }

  async function startPreview(){
    const scenes=getScenes();if(!scenes.length){alert("Create the AI Director plan first.");return;}
    stopPreview();previewScenes=scenes;
    const narration=$("scriptInput")?.value?.trim()||scenes.map(s=>s.caption).join(" ");
    const AudioContextClass=window.AudioContext||window.webkitAudioContext;
    if(!AudioContextClass){alert("This browser does not support audio preview.");return;}
    let audio=null;
    $("previewBtn").disabled=true;$("previewBtn").textContent="Creating AI voice-over…";
    try{
      audio=new AudioContextClass();await audio.resume();
      const voiceFile=$("voiceFile")?.files?.[0];
      const voiceBlob=voiceFile||await makeVoiceover(narration,$("voiceStyle")?.value||"Kore");
      const audioBuffer=await audio.decodeAudioData(await voiceBlob.arrayBuffer());
      if(audioBuffer.duration>120)throw new Error("The generated narration is longer than AHM's two-minute limit.");
      const duration=Math.max(30,audioBuffer.duration);
      const subtitleTimeline=buildSubtitleTimeline(narration,audioBuffer.duration);
      const voiceGain=audio.createGain();voiceGain.gain.value=1;voiceGain.connect(audio.destination);
      const voiceSource=audio.createBufferSource();voiceSource.buffer=audioBuffer;voiceSource.connect(voiceGain);
      previewAudio=audio;previewVoiceSource=voiceSource;
      const musicFile=$("musicFile")?.files?.[0];
      if(musicFile){
        const musicBuffer=await audio.decodeAudioData(await musicFile.arrayBuffer());
        const musicSource=audio.createBufferSource(),musicGain=audio.createGain();
        musicSource.buffer=musicBuffer;musicSource.loop=true;musicGain.gain.value=Number($("musicVolume")?.value||12)/100;
        musicSource.connect(musicGain);musicGain.connect(audio.destination);musicSource.start();
        previewStopMusic=()=>{try{musicSource.stop();}catch{}};
      }else previewStopMusic=addSoundscape(audio,audio.destination,duration);
      $("previewBtn").textContent="Previewing animation + voice + music…";
      voiceSource.start();previewStart=performance.now();lastScene=-1;
      const totalMs=duration*1000;
      previewTimer=setInterval(()=>{
        const elapsed=Math.min(totalMs,performance.now()-previewStart);
        const sceneMs=totalMs/scenes.length;
        const index=Math.min(scenes.length-1,Math.floor(elapsed/sceneMs));
        const progress=clamp((elapsed-index*sceneMs)/sceneMs,0,1);
        drawFrame(scenes,index,progress,elapsed,duration,subtitleTimeline);
        if(index!==lastScene){lastScene=index;$("previewCaption").textContent="Scene "+(index+1)+" / "+scenes.length+" · narration + soundtrack";actionFoley(audio,audio.destination,scenes[index].action);}
      },33);
      previewTimeout=setTimeout(()=>{stopPreview();$("previewBtn").disabled=false;$("previewBtn").textContent="Preview full animation";},totalMs);
    }catch(error){
      stopPreview();if(audio&&audio.state!=="closed")await audio.close().catch(()=>{});
      $("previewBtn").disabled=false;$("previewBtn").textContent="Preview full animation";
      alert("AHM could not prepare the full preview: "+(error.message||error));
    }
  }

  async function makeVoiceover(text,voice){
    const response=await fetch("/api/free-voiceover",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text,voice,style:"Expressive, cinematic short-form narrator. Energetic hook, natural conversational pace, clear diction, emotional emphasis on suspense and reveals."})});
    const data=await response.json();
    if(!response.ok||!data.ok||!data.audioBase64)throw new Error(data.error||"Free AI voice-over could not be generated.");
    const binary=atob(data.audioBase64),bytes=new Uint8Array(binary.length);
    for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
    return new Blob([bytes],{type:data.mimeType||"audio/wav"});
  }

  function actionFoley(audio,destination,action){
    const a=words(action),now=audio.currentTime;
    const tone=(frequency,shape,volume,length,slide=0)=>{
      const osc=audio.createOscillator(),gain=audio.createGain();
      osc.type=shape;osc.frequency.setValueAtTime(frequency,now);
      if(slide)osc.frequency.exponentialRampToValueAtTime(Math.max(25,frequency+slide),now+length);
      gain.gain.setValueAtTime(volume,now);gain.gain.exponentialRampToValueAtTime(.001,now+length);
      osc.connect(gain);gain.connect(destination);gain.connect(audio.destination);
      osc.start(now);osc.stop(now+length+.02);
    };
    if(/hit|punch|kick|slam|crash|explode|fall|impact|attack/.test(a)){tone(95,'sine',.35,.32,-55);tone(42,'triangle',.22,.22,-18);}
    else if(/run|walk|step|chase|escape|rush/.test(a)){tone(125,'triangle',.09,.11,-35);}
    else if(/water|swim|fish|river|lake|sea|ocean/.test(a)){tone(620,'sine',.055,.35,380);}
    else if(/magic|glow|reveal|discover|gold|treasure/.test(a)){tone(880,'sine',.08,.6,720);tone(1320,'sine',.035,.45,420);}
    else if(/door|knock|open|close/.test(a)){tone(150,'triangle',.15,.2,-75);}
    else if(/cry|sad|grief|whisper/.test(a)){tone(220,'sine',.035,.45,-35);}
  }

  function addSoundscape(audio,destination,duration){
    const master=audio.createGain();master.gain.value=.11;master.connect(destination);if(destination!==audio.destination)master.connect(audio.destination);
    const bass=audio.createOscillator(),bassGain=audio.createGain();bass.type="sine";bass.frequency.value=55;bassGain.gain.value=.45;bass.connect(bassGain);bassGain.connect(master);bass.start();
    const pad=audio.createOscillator(),padGain=audio.createGain();pad.type="triangle";pad.frequency.value=110;padGain.gain.value=.12;pad.connect(padGain);padGain.connect(master);pad.start();
    const shimmer=audio.createOscillator(),shimmerGain=audio.createGain();shimmer.type="sine";shimmer.frequency.value=440;shimmerGain.gain.value=.018;shimmer.connect(shimmerGain);shimmerGain.connect(master);shimmer.start();
    let beat=0;const timer=setInterval(()=>{
      beat++;const notes=[110,130.81,146.83,164.81,196,164.81,146.83,130.81];
      pad.frequency.setTargetAtTime(notes[beat%notes.length],audio.currentTime,.25);
      shimmer.frequency.setTargetAtTime(notes[(beat+3)%notes.length]*2,audio.currentTime,.2);
      bass.frequency.setTargetAtTime(48+(beat%4)*5,audio.currentTime,.3);
      if(beat%2===0){const osc=audio.createOscillator(),gain=audio.createGain();osc.type="sine";osc.frequency.value=75+Math.random()*30;gain.gain.setValueAtTime(.08,audio.currentTime);gain.gain.exponentialRampToValueAtTime(.001,audio.currentTime+.24);osc.connect(gain);gain.connect(master);osc.start();osc.stop(audio.currentTime+.25);}
    },650);
    return ()=>{clearInterval(timer);[bass,pad,shimmer].forEach(o=>{try{o.stop();}catch{}});};
  }

  async function exportStory(){
    if(rendering)return;
    const scenes=getScenes();if(!scenes.length){alert("Create the AI Director plan first.");return;}
    const narration=$("scriptInput")?.value?.trim()||scenes.map(s=>s.caption).join(" ");
    if(!narration){alert("The Director plan has no narration to speak.");return;}
    if(!window.MediaRecorder||!canvas.captureStream){alert("This browser cannot export canvas video. Please update Chrome.");return;}
    rendering=true;stopPreview();$("renderBtn").disabled=true;$("previewBtn").disabled=true;$("cancelBtn").disabled=true;
    $("downloadArea").classList.add("hidden");updateStatus(0,"PREPARING VOICE + ANIMATION");
    let audio=null,stream=null,recorder=null,stopMusic=null,voiceSource=null,blobUrl=null;
    try{
      const AudioContextClass=window.AudioContext||window.webkitAudioContext;
      if(!AudioContextClass)throw new Error("This browser does not support audio mixing.");
      audio=new AudioContextClass();await audio.resume();
      const voiceFile=$("voiceFile")?.files?.[0];
      const voiceBlob=voiceFile||await makeVoiceover(narration,$("voiceStyle")?.value||"Kore");
      updateStatus(.12,"VOICE-OVER READY · BUILDING SOUNDTRACK");
      const audioBuffer=await audio.decodeAudioData(await voiceBlob.arrayBuffer());
      const destination=audio.createMediaStreamDestination();
      const voiceGain=audio.createGain();voiceGain.gain.value=1;voiceGain.connect(destination);voiceGain.connect(audio.destination);
      voiceSource=audio.createBufferSource();voiceSource.buffer=audioBuffer;voiceSource.connect(voiceGain);
      const musicFile=$("musicFile")?.files?.[0];
      if(musicFile){
        const musicBuffer=await audio.decodeAudioData(await musicFile.arrayBuffer());
        const musicSource=audio.createBufferSource(),musicGain=audio.createGain();musicSource.buffer=musicBuffer;musicSource.loop=true;musicGain.gain.value=(Number($("musicVolume")?.value||12)/100);musicSource.connect(musicGain);musicGain.connect(destination);musicGain.connect(audio.destination);musicSource.start();
        stopMusic=()=>{try{musicSource.stop();}catch{}};
      }else stopMusic=addSoundscape(audio,destination,120);
      const duration=getDuration(scenes);
      if(audioBuffer.duration>120)throw new Error("The generated narration is longer than AHM's two-minute limit. Shorten the script.");
      const finalDuration=Math.max(30,audioBuffer.duration);
      if(finalDuration>120)throw new Error("The generated narration is longer than AHM's two-minute limit. Shorten the script.");
      stream=canvas.captureStream(30);
      destination.stream.getAudioTracks().forEach(track=>stream.addTrack(track));
      if(!stream.getAudioTracks().length)throw new Error("Audio could not be attached to the video recording.");
      const types=["video/mp4;codecs=avc1.42E01E,mp4a.40.2","video/mp4","video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm"];
      const mime=types.find(type=>MediaRecorder.isTypeSupported(type))||"";
      recorder=new MediaRecorder(stream,mime?{mimeType:mime,videoBitsPerSecond:4500000,audioBitsPerSecond:160000}:undefined);
      const chunks=[];recorder.ondataavailable=e=>{if(e.data?.size)chunks.push(e.data);};
      const stopped=new Promise((resolve,reject)=>{recorder.onstop=resolve;recorder.onerror=e=>reject(e.error||new Error("Recording failed."));});
      const totalMs=Math.ceil(finalDuration*1000),start=performance.now();let frameTimer=null;
      recorder.start(1000);
      voiceSource.start();
      $("previewCaption").textContent="Rendering "+scenes.length+" animated scenes with narration and soundtrack…";
      const render=()=>{
        const elapsed=performance.now()-start;
        const sceneMs=totalMs/scenes.length;
        const index=Math.min(scenes.length-1,Math.floor(elapsed/sceneMs));
        const progress=(elapsed-index*sceneMs)/sceneMs;
        drawFrame(scenes,index,progress,elapsed,finalDuration);
        if(index!==lastScene){lastScene=index;$("previewCaption").textContent="Rendering scene "+(index+1)+" / "+scenes.length;actionFoley(audio,destination,scenes[index].action);}
        updateStatus(Math.min(.98,elapsed/totalMs),"RENDERING ANIMATED STORY + AUDIO");
      };
      render();
      frameTimer=setInterval(render,33);
      await new Promise(resolve=>setTimeout(resolve,totalMs));
      if(frameTimer)clearInterval(frameTimer);
      drawFrame(scenes,scenes.length-1,1,totalMs,finalDuration);
      await new Promise(resolve=>setTimeout(resolve,250));
      if(recorder.state!=="inactive")recorder.stop();
      await stopped;
      const actualMime=recorder.mimeType||mime||"video/webm";
      const blob=new Blob(chunks,{type:actualMime});
      if(blob.size<100000)throw new Error("The recording was too small to be a real finished video. Nothing was added to downloads.");
      blobUrl=URL.createObjectURL(blob);
      const check=document.createElement("video");check.preload="metadata";check.src=blobUrl;
      await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("Could not verify the exported video's duration. Please try again.")),15000);check.onloadedmetadata=()=>{clearTimeout(timer);resolve();};check.onerror=()=>{clearTimeout(timer);reject(new Error("The exported video file could not be opened for verification."));};});
      if(!Number.isFinite(check.duration)||check.duration<Math.min(25,finalDuration*.8))throw new Error("The exported video was shorter than expected ("+rounded(check.duration||0)+"s). The file was rejected instead of giving you another broken download.");
      const ext=actualMime.includes("mp4")?"mp4":"webm";
      const url=blobUrl;
      const area=$("downloadArea");area.innerHTML="";
      const title=document.createElement("strong");title.textContent="Finished animated story · "+rounded(check.duration)+" seconds";
      const player=document.createElement("video");player.controls=true;player.playsInline=true;player.src=url;player.style.width="100%";player.style.maxWidth="420px";player.style.borderRadius="16px";
      const link=document.createElement("a");link.href=url;link.download=(($("titleInput")?.value||"ahm-story").toLowerCase().replace(/[^a-z0-9]+/g,"-"))+"."+ext;link.className="downloadLink";link.textContent="Download verified "+ext.toUpperCase();
      const note=document.createElement("p");note.className="smallNote";note.textContent="Includes animated character actions, spoken narration, background score, sound effects and subtitles. Export verified at "+rounded(check.duration)+" seconds.";
      area.append(title,player,link,note);area.classList.remove("hidden");
      updateStatus(1,"VIDEO VERIFIED · READY");
      $("previewCaption").textContent="Verified export · "+scenes.length+" animated scenes · "+rounded(check.duration)+" seconds · voice + music + effects.";
    }catch(error){
      console.error("AHM animated export failed",error);updateStatus(0,"EXPORT FAILED");
      alert("AHM could not finish a valid video: "+(error.message||error)+"\n\nNo broken download has been created.");
    }finally{
      if(stopMusic)stopMusic();if(stream)stream.getTracks().forEach(t=>t.stop());
      if(audio&&audio.state!=="closed")await audio.close().catch(()=>{});
      rendering=false;$("renderBtn").disabled=false;$("previewBtn").disabled=false;
      $("renderBtn").textContent="Create animated story video";
    }
  }

  document.addEventListener("click",event=>{
    const preview=event.target.closest("#previewBtn");
    if(preview){event.preventDefault();event.stopImmediatePropagation();startPreview();return;}
    const render=event.target.closest("#renderBtn");
    if(render){event.preventDefault();event.stopImmediatePropagation();exportStory();}
  },true);

  const status=$("aiStoryStatus");
  if(status)status.insertAdjacentHTML("afterend",'<p class="smallNote" id="animationEngineNote">Animation engine: character acting, scene-specific environments, camera movement, generated narration and an original procedural soundtrack. Exports are checked for duration before a download is offered.</p>');
  $("previewBtn").textContent="Preview full animation";
  $("renderBtn").textContent="Create animated story video";
  $("renderBtn").disabled=true;
})();