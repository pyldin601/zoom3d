// Spike client: mic capture + one RTCPeerConnection via the 2-peer relay.
import { createSpatial } from './audio.js';
import { createPad } from './pad.js';

const $ = (id) => document.getElementById(id);
const log = (...parts) => { $('log').textContent += parts.join(' ') + '\n'; };
const setStatus = (s) => { $('status').textContent = s; log('status:', s); };

let ws, pc, localStream, ctx;
let queue = Promise.resolve();
const remoteListeners = [];

export function onRemoteStream(cb) { remoteListeners.push(cb); }

// ?fake: a beeping tone instead of the mic, for automated checks and solo listening tests.
function fakeToneStream() {
  const osc = new OscillatorNode(ctx, { frequency: 440 });
  const gate = new GainNode(ctx, { gain: 0 });
  for (let t = 0; t < 3600; t += 1) {
    gate.gain.setValueAtTime(0.3, ctx.currentTime + t);
    gate.gain.setValueAtTime(0, ctx.currentTime + t + 0.3);
  }
  const dest = ctx.createMediaStreamDestination();
  osc.connect(gate).connect(dest);
  osc.start();
  return dest.stream;
}

const send = (obj) => ws.send(JSON.stringify(obj));

function newPeerConnection() {
  pc?.close();
  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
  pc.onicecandidate = (e) => { if (e.candidate) send({ kind: 'ice', candidate: e.candidate }); };
  window.spike = { pc };
  pc.onconnectionstatechange = () => setStatus(pc.connectionState);
  pc.ontrack = (e) => {
    const stream = e.streams[0] ?? new MediaStream([e.track]);
    for (const cb of remoteListeners) cb(stream);
  };
}

async function handle(m) {
  if (m.type === 'role') {
    newPeerConnection();
    if (m.role === 'offer') {
      await pc.setLocalDescription();
      send({ kind: 'sdp', sdp: pc.localDescription });
      setStatus('offer sent');
    } else {
      setStatus('waiting for peer');
    }
  } else if (m.type === 'peer-joined') {
    newPeerConnection();
    setStatus('peer joined, awaiting offer');
  } else if (m.type === 'peer-left') {
    newPeerConnection();
    setStatus('peer left, waiting for peer');
  } else if (m.kind === 'sdp') {
    await pc.setRemoteDescription(m.sdp);
    if (m.sdp.type === 'offer') {
      await pc.setLocalDescription();
      send({ kind: 'sdp', sdp: pc.localDescription });
    }
  } else if (m.kind === 'ice') {
    await pc.addIceCandidate(m.candidate).catch((err) => log('ice error', err.message));
  }
}

$('start').onclick = async () => {
  $('start').disabled = true;
  // Created and resumed inside the click so autoplay policy allows output.
  ctx = new AudioContext();
  await ctx.resume();
  try {
    localStream = new URLSearchParams(location.search).has('fake')
      ? fakeToneStream()
      : await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
  } catch (err) {
    setStatus('mic error: ' + err.message);
    $('start').disabled = false;
    return;
  }
  log('mic settings', JSON.stringify(localStream.getAudioTracks()[0].getSettings()));
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); queue = queue.then(() => handle(m)); };
  ws.onclose = (e) => setStatus(`socket closed ${e.code} ${e.reason}`);
};

// Output modes: 'element' plays the stream directly (baseline); 'webaudio' and
// 'webaudio-element' play through the spatial graph.
let spatial = null;
let remoteStream = null;
const checked = (name) => document.querySelector(`input[name=${name}]:checked`).value;

const pad = createPad($('pad'), (dx, dy) => spatial?.setPosition(dx, dy));

function applyMode() {
  if (!spatial) return;
  const mode = checked('mode');
  const remote = $('remote');
  const spatialEl = $('spatial');
  // Chrome only feeds WebRTC audio into Web Audio while the stream plays in a media element,
  // so #remote keeps playing in every mode and is merely muted for the Web Audio modes.
  remote.muted = mode !== 'element';
  const out = spatial.connectTo(mode === 'element' ? 'none' : mode);
  if (out) {
    spatialEl.srcObject = out;
    spatialEl.play().catch((err) => log('play error', err.message));
  } else {
    spatialEl.pause();
    spatialEl.srcObject = null;
  }
  log('mode:', mode);
}

onRemoteStream((stream) => {
  remoteStream = stream;
  const remote = $('remote');
  remote.srcObject = remoteStream;
  remote.play().catch((err) => log('play error', err.message));
  spatial?.dispose();
  spatial = createSpatial(ctx, remoteStream);
  const { dx, dy } = pad.get();
  spatial.setPosition(dx, dy);
  spatial.setOccluded($('occluded').checked);
  spatial.setPanningModel(checked('panning'));
  applyMode();
  Object.assign(window.spike, { ctx, remoteStream, spatial });
});

for (const el of document.querySelectorAll('input[name=mode]')) el.onchange = applyMode;
for (const el of document.querySelectorAll('input[name=panning]')) {
  el.onchange = () => spatial?.setPanningModel(checked('panning'));
}
$('occluded').onchange = () => spatial?.setOccluded($('occluded').checked);
